const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 384 * 1024;
const MAX_HEAD_CONTENT_BYTES = 3 * 1024 * 1024;

module.exports = async function prepareReview({ github, context, core }) {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error("This workflow requires a pull_request_target event.");

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = pull.number;

  const diffResponse = await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
    headers: { accept: "application/vnd.github.v3.diff" },
  });
  const diff = typeof diffResponse.data === "string"
    ? diffResponse.data
    : String(diffResponse.data ?? "");
  const diffBytes = Buffer.byteLength(diff);
  if (diffBytes > MAX_DIFF_BYTES) {
    throw new Error(
      `Pull request diff is ${diffBytes} bytes; the automated review limit is ${MAX_DIFF_BYTES}. ` +
      "Split the change so the reviewer can inspect the complete diff.",
    );
  }

  const changed = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  let bundledBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files = [];

  for (const file of changed) {
    const entry = {
      path: file.filename,
      previous_path: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      head_content: null,
      content_omitted_reason: null,
    };

    if (file.status === "removed") {
      entry.content_omitted_reason = "removed file; inspect the base tree and diff";
    } else if (!file.sha) {
      entry.content_omitted_reason = "GitHub did not provide a head blob SHA";
    } else if (bundledBytes >= MAX_HEAD_CONTENT_BYTES) {
      entry.content_omitted_reason = "review bundle content budget reached";
    } else {
      try {
        const blob = await github.rest.git.getBlob({ owner, repo, file_sha: file.sha });
        const bytes = Buffer.from(blob.data.content, "base64");
        if (bytes.length > MAX_FILE_BYTES) {
          entry.content_omitted_reason = `head file exceeds ${MAX_FILE_BYTES} bytes`;
        } else if (bundledBytes + bytes.length > MAX_HEAD_CONTENT_BYTES) {
          entry.content_omitted_reason = "review bundle content budget reached";
        } else if (bytes.includes(0)) {
          entry.content_omitted_reason = "binary content";
        } else {
          entry.head_content = decoder.decode(bytes);
          bundledBytes += bytes.length;
        }
      } catch (error) {
        entry.content_omitted_reason = `head content unavailable: ${error.message}`;
      }
    }

    files.push(entry);
  }

  const directory = path.join(process.cwd(), ".codex-review");
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "pull-request.diff"), diff);
  fs.writeFileSync(
    path.join(directory, "metadata.json"),
    `${JSON.stringify({
      pull_request: pullNumber,
      base_sha: pull.base.sha,
      head_sha: pull.head.sha,
      changed_files: changed.length,
      diff_bytes: diffBytes,
      bundled_head_content_bytes: bundledBytes,
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "changed-files.json"),
    `${JSON.stringify(files, null, 2)}\n`,
  );

  const omitted = files.filter((file) => file.content_omitted_reason).length;
  core.info(
    `Prepared PR #${pullNumber}: ${changed.length} files, ${diffBytes} diff bytes, ` +
    `${bundledBytes} head-content bytes, ${omitted} omitted head files.`,
  );
};
