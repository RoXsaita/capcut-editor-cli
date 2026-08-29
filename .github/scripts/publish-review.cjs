const crypto = require("node:crypto");

const SUMMARY_MARKER = "<!-- codex-auto-review -->";
const FINDING_MARKER = "codex-finding:";
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function parseResult(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error("Codex returned an empty result.");
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const result = JSON.parse(unfenced);
  if (!Array.isArray(result.findings)) throw new Error("Codex result has no findings array.");
  return result;
}

function safeMarkdown(value) {
  return String(value ?? "")
    .replaceAll("<!--", "&lt;!--")
    .replaceAll("@", "@\u200b");
}

function inlineCode(value) {
  return `\`${safeMarkdown(value).replaceAll("`", "\\`")}\``;
}

function fingerprint(finding) {
  return crypto
    .createHash("sha256")
    .update(`${finding.priority}\n${finding.path}\n${finding.title}`)
    .digest("hex")
    .slice(0, 20);
}

function fileUrl(context, pull, finding) {
  const sha = finding.side === "LEFT" ? pull.base.sha : pull.head.sha;
  const encodedPath = String(finding.path).split("/").map(encodeURIComponent).join("/");
  return `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/blob/${sha}/${encodedPath}` +
    `#L${finding.line}`;
}

function changedLines(patch) {
  const right = new Set();
  const left = new Set();
  if (!patch) return { RIGHT: right, LEFT: left };

  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      right.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      left.add(oldLine);
      oldLine += 1;
    } else if (!line.startsWith("\\")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { RIGHT: right, LEFT: left };
}

function renderSummary({ context, pull, result, jobResult, parseError }) {
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const sha = pull.head.sha.slice(0, 12);
  const lines = [SUMMARY_MARKER, "## Codex automated review", ""];

  if (jobResult !== "success" || parseError) {
    lines.push(
      "⚠️ The automated review did not complete.",
      "",
      safeMarkdown(parseError?.message || `Review job ended with status: ${jobResult}.`),
      "",
      `[Inspect the workflow run](${runUrl}).`,
    );
    return lines.join("\n");
  }

  const findings = [...result.findings].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99),
  );
  lines.push(
    `Reviewed commit ${inlineCode(sha)} with ${inlineCode("gpt-5.6-luna / max")}.`,
    "",
  );

  if (findings.length === 0) {
    lines.push("**No findings.**", "");
  } else {
    lines.push("### Findings", "");
    findings.forEach((finding, index) => {
      const location = `${finding.path}:${finding.line}`;
      lines.push(
        `${index + 1}. **[${safeMarkdown(finding.priority)}] ${safeMarkdown(finding.title)}** — ` +
          `[${inlineCode(location)}](${fileUrl(context, pull, finding)})`,
        "",
        `   ${safeMarkdown(finding.body)}`,
        "",
      );
    });
  }

  lines.push(
    "### Overall assessment",
    "",
    safeMarkdown(result.assessment),
    "",
    "### Test gaps and residual risk",
    "",
    safeMarkdown(result.test_gaps),
    "",
    `<sub>Advisory review. Deterministic CI remains the merge gate. [Workflow run](${runUrl}).</sub>`,
  );

  const body = lines.join("\n");
  return body.length <= 60_000 ? body : `${body.slice(0, 59_000)}\n\n_Review summary truncated._`;
}

async function upsertSummary({ github, context, body }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: context.payload.pull_request.number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.includes(SUMMARY_MARKER),
  );
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: context.payload.pull_request.number,
      body,
    });
  }
}

async function publishInlineFindings({ github, context, core, pull, findings }) {
  if (findings.length === 0) return;

  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo,
    pull_number: pull.number,
    per_page: 100,
  });
  const valid = new Map(files.map((file) => [file.filename, changedLines(file.patch)]));

  const priorComments = await github.paginate(github.rest.pulls.listReviewComments, {
    ...context.repo,
    pull_number: pull.number,
    per_page: 100,
  });
  const seen = new Set();
  for (const comment of priorComments) {
    const match = comment.body?.match(/<!-- codex-finding:([a-f0-9]+) -->/);
    if (match) seen.add(match[1]);
  }

  const comments = [];
  for (const finding of findings) {
    const id = fingerprint(finding);
    const lineSet = valid.get(finding.path)?.[finding.side];
    if (seen.has(id)) continue;
    if (!lineSet?.has(finding.line)) {
      core.warning(
        `Finding ${id} points to ${finding.path}:${finding.line} ${finding.side}, ` +
        "which is not an available changed line; it remains in the summary only.",
      );
      continue;
    }
    comments.push({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: `**[${finding.priority}] ${safeMarkdown(finding.title)}**\n\n` +
        `${safeMarkdown(finding.body)}\n\n<!-- ${FINDING_MARKER}${id} -->`,
    });
  }

  if (comments.length === 0) return;
  try {
    await github.rest.pulls.createReview({
      ...context.repo,
      pull_number: pull.number,
      commit_id: pull.head.sha,
      event: "COMMENT",
      body: `Automated Codex review for ${pull.head.sha.slice(0, 12)}.`,
      comments,
    });
  } catch (error) {
    core.warning(`Batch review creation failed; retrying comments individually: ${error.message}`);
    for (const comment of comments) {
      try {
        await github.rest.pulls.createReviewComment({
          ...context.repo,
          pull_number: pull.number,
          commit_id: pull.head.sha,
          ...comment,
        });
      } catch (commentError) {
        core.warning(
          `Could not publish ${comment.path}:${comment.line}: ${commentError.message}`,
        );
      }
    }
  }
}

async function publishReview({ github, context, core }) {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error("This workflow requires a pull_request_target event.");

  const current = await github.rest.pulls.get({ ...context.repo, pull_number: pull.number });
  if (current.data.head.sha !== pull.head.sha) {
    core.info(
      `Skipping stale review for ${pull.head.sha}; current head is ${current.data.head.sha}.`,
    );
    return;
  }

  const jobResult = process.env.REVIEW_JOB_RESULT || "unknown";
  let result = { findings: [], assessment: "", test_gaps: "" };
  let parseError = null;
  if (jobResult === "success") {
    try {
      result = parseResult(process.env.CODEX_RESULT);
    } catch (error) {
      parseError = error;
      core.warning(`Could not parse Codex output: ${error.message}`);
    }
  }

  const body = renderSummary({ context, pull, result, jobResult, parseError });
  await upsertSummary({ github, context, body });

  if (jobResult === "success" && !parseError) {
    await publishInlineFindings({
      github,
      context,
      core,
      pull,
      findings: result.findings,
    });
  }

  if (jobResult !== "success" || parseError) {
    core.setFailed(parseError?.message || `Review job ended with status: ${jobResult}.`);
  }
}

publishReview._test = { changedLines, fingerprint, parseResult, renderSummary, safeMarkdown };
module.exports = publishReview;
