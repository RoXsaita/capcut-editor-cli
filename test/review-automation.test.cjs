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

test("finding fingerprints deduplicate the same issue across commits", () => {
  const finding = {
    priority: "P2",
    path: "src/example.mjs",
    title: "Return the validated value",
  };
  assert.equal(fingerprint(finding), fingerprint({ ...finding, body: "Changed wording." }));
  assert.notEqual(fingerprint(finding), fingerprint({ ...finding, title: "Validate the value" }));
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
