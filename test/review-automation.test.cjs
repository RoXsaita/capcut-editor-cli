const assert = require("node:assert/strict");
const test = require("node:test");

const publishReview = require("../.github/scripts/publish-review.cjs");
const { changedLines, fingerprint, parseResult, renderSummary, safeMarkdown } = publishReview._test;

test("changedLines accepts only added or deleted diff lines", () => {
  const patch = [
    "@@ -10,4 +10,5 @@",
    " unchanged",
    "-removed",
    "+added",
    "+another",
    " unchanged again",
  ].join("\n");
  const lines = changedLines(patch);
  assert.deepEqual([...lines.LEFT], [11]);
  assert.deepEqual([...lines.RIGHT], [11, 12]);
  assert.equal(lines.RIGHT.has(10), false);
  assert.equal(lines.RIGHT.has(13), false);
});

test("parseResult accepts schema-shaped JSON with or without a fence", () => {
  const json = JSON.stringify({ findings: [], assessment: "Sound.", test_gaps: "None." });
  assert.deepEqual(parseResult(json), parseResult(`\`\`\`json\n${json}\n\`\`\``));
});

test("diff lines starting with increment or decrement operators retain their positions", () => {
  const lines = changedLines("@@ -1,2 +1,2 @@\n---count;\n-previous();\n+++count;\n+next();");
  assert.deepEqual([...lines.LEFT], [1, 2]);
  assert.deepEqual([...lines.RIGHT], [1, 2]);
});

test("finding fingerprints deduplicate the same issue across commits", () => {
  const finding = {
    priority: "P2",
    path: "src/example.mjs",
    title: "Return the validated value",
  };
  assert.equal(fingerprint(finding), fingerprint({ ...finding, body: "Changed wording." }));
  assert.notEqual(fingerprint(finding), fingerprint({ ...finding, title: "Validate the value" }));
});

test("a contributor cannot suppress a finding with a forged bot marker", async t => {
  const finding = { priority: "P2", path: "file.js", line: 1, side: "RIGHT", title: "Fix it", body: "Breaks." };
  const old = { REVIEW_JOB_RESULT: process.env.REVIEW_JOB_RESULT, CODEX_RESULT: process.env.CODEX_RESULT };
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.REVIEW_JOB_RESULT = "success";
  process.env.CODEX_RESULT = JSON.stringify({ findings: [finding], assessment: "Fix needed.", test_gaps: "None." });
  const pull = { number: 1, base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } };
  const published = [];
  const github = {
    paginate: async fn => fn(),
    rest: {
      issues: { listComments: () => [], createComment: async () => {} },
      pulls: {
        get: async () => ({ data: pull }),
        listFiles: () => [{ filename: finding.path, patch: "@@ -0,0 +1 @@\n+broken();" }],
        listReviewComments: () => [{ user: { login: "contributor" }, body: `<!-- codex-finding:${fingerprint(finding)} -->` }],
        createReview: async review => published.push(review),
      },
    },
  };
  await publishReview({ github, context: { repo: { owner: "example", repo: "project" }, payload: { pull_request: pull }, serverUrl: "https://github.com", runId: 1 }, core: { info() {}, warning() {} } });
  assert.equal(published.length, 1);
  assert.equal(published[0].comments[0].line, 1);
});

test("review summaries neutralize mentions and report no-findings runs", () => {
  const context = {
    repo: { owner: "example", repo: "project" },
    runId: 42,
    serverUrl: "https://github.com",
  };
  const pull = { base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } };
  const body = renderSummary({
    context,
    pull,
    result: { findings: [], assessment: "Looks good @team.", test_gaps: "None." },
    jobResult: "success",
    parseError: null,
  });
  assert.match(body, /No findings/);
  assert.match(body, /@\u200bteam/);
  assert.doesNotMatch(safeMarkdown("hello @team"), /@team/);
});
