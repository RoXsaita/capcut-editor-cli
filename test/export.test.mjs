import './helpers/neutral-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoTailPastContent, checkExport, finalGates, tailPastContent, waitForStagedExport } from '../src/export.mjs';
import { applySpec, contentEndUs, loadWorkingDoc, readJson, stableJson } from '../src/core.mjs';
import { reviewContentRange } from '../src/review.mjs';
import { planEnding } from '../src/ending.mjs';
import { gateReport } from '../src/gate.mjs';
import { buildProject } from './helpers/polish-project.mjs';
import { capcutResave } from './helpers/capcut-resave.mjs';

test('native export rejects partial, wrong-duration and non-video files', () => {
  const probe = { format: { duration: '46.234' }, streams: [{ codec_type: 'video' }] };
  assert.equal(checkExport(probe, 46.233), 46.234);
  assert.throws(() => checkExport(probe, 50), /EXPORT_DURATION_MISMATCH/);
  assert.throws(() => checkExport({ format: { duration: '46.233' }, streams: [] }, 46.233));
  assert.throws(() => checkExport({ format: { duration: 'NaN' }, streams: [{ codec_type: 'video' }] }, 46.233));
});


test('every export is X-rayed with its transcript and gated; Gemini only reviews an export that passes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-final-'));
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  const calls = [];
  const xray = (video, projectDir, outDir, options) => {
    calls.push(options);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'xray.json'), JSON.stringify({ export: {}, draft: null, verdicts: [],
      info: { video: { width: 1080, height: 1920, avg_frame_rate: '30/1' }, format: { duration: '5' } }, audio: { present: false } }));
    return { dir: outDir };
  };
  let reviewed = false;
  const doc = { materials: { videos: [] }, tracks: [] };
  const result = await finalGates({ video: path.join(dir, 'final.mp4') }, { projectDir: project, doc, args: {}, xray,
    review: async () => { reviewed = true; } });
  assert.deepEqual(calls, [{ speech: true }]);
  assert.equal(result.gate.verdict, 'FAIL');
  assert.ok(result.gate.failed.includes('captions') && result.gate.failed.includes('ending') && result.gate.failed.includes('speech'));
  assert.equal(reviewed, false, 'a failing export is not sent to Gemini');
  assert.ok(fs.existsSync(path.join(project, '.capcutctl', 'gate.json')));
});

test('a passing export goes to Gemini, the review folds into gate.json, and an accepted blocker fails the export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-final-'));
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  const reviewFile = path.join(dir, 'review.json');
  fs.writeFileSync(reviewFile, JSON.stringify({ round: 1, model: 'Auto + High', status: 'decided', issues: [
    { id: 'G1', kind: 'caption', blocker: true, decision: 'accepted', reason: 'covers the mouth', issue: 'caption over face' }] }));
  const passing = () => ({ verdict: 'PASS', failed: [], warned: [], checks: [{ id: 'hook', level: 'FAIL', ok: true, message: 'ok' }] });
  let asked = null;
  const result = await finalGates({ video: path.join(dir, 'final.mp4') }, { projectDir: project, doc: {}, args: { script: 'script.txt' },
    xray: () => ({}), gate: passing,
    review: async options => { asked = options; return { file: reviewFile, round: 1, model: 'Auto + High', status: 'decided', issues: [] }; } });
  assert.equal(asked.speech, path.join(dir, 'final.xray', 'speech.json'));
  assert.equal(path.basename(asked.script), 'script.txt');
  assert.equal(result.gate.verdict, 'FAIL');
  assert.deepEqual(result.gate.failed, ['review']);
  const recorded = JSON.parse(fs.readFileSync(path.join(project, '.capcutctl', 'gate.json'), 'utf8'));
  assert.equal(recorded.review.file, reviewFile);
  const broken = await finalGates({ video: path.join(dir, 'final.mp4') }, { projectDir: project, doc: {}, args: {}, xray: () => ({}), gate: passing,
    review: async () => { throw Object.assign(new Error('Gemini shows a sign-in wall'), { code: 'REVIEW_LOGIN' }); } });
  assert.equal(broken.gate.verdict, 'FAIL');
  assert.match(broken.review.error, /REVIEW_LOGIN/);
});

/** A fake clock and file: `sizes` is what each poll reads, `probes` what each probe does. */
function harness({ sizes = () => 1000, probes }) {
  let t = 0, polls = 0, probed = 0;
  return {
    opts: {
      now: () => t, sleep: async ms => { t += ms; }, timeoutMs: 20_000,
      size: () => sizes(polls++),
      probe: () => { const p = probes(probed++); if (p instanceof Error) throw p; return p; },
    },
    polls: () => polls, probed: () => probed,
  };
}
const video = seconds => ({ format: { duration: String(seconds) }, streams: [{ codec_type: 'video' }] });

test('a stable export of the wrong length refuses at once, naming both lengths, instead of waiting out the timeout', async () => {
  const h = harness({ probes: () => video(76) });
  await assert.rejects(waitForStagedExport('/stage/x.mp4', 46, h.opts), error => {
    assert.equal(error.code, 'EXPORT_DURATION_MISMATCH');
    assert.match(error.message, /76s, the edit is 46s/);
    assert.match(error.message, /parked or overhanging/);
    assert.match(error.message, /\/stage\/x\.mp4/);
    assert.deepEqual([error.details.expected, error.details.actual], [46, 76]);
    return true;
  });
  assert.equal(h.polls(), 4, 'three equal sizes after the first, then one probe');
  assert.equal(h.probed(), 1);
});

test('a probe that cannot read the file yet keeps waiting; one that never reads times out', async () => {
  const flaky = harness({ probes: i => (i < 2 ? new Error('moov atom not found') : video(46.05)) });
  assert.equal((await waitForStagedExport('/stage/x.mp4', 46, flaky.opts)).format.duration, '46.05');
  assert.equal(flaky.probed(), 3);
  const never = harness({ probes: () => new Error('Invalid data') });
  await assert.rejects(waitForStagedExport('/stage/x.mp4', 46, never.opts), error => error.code === 'EXPORT_TIMEOUT');
  const growing = harness({ sizes: i => i * 100, probes: () => video(46) });
  await assert.rejects(waitForStagedExport('/stage/x.mp4', 46, growing.opts), error => error.code === 'EXPORT_TIMEOUT');
  assert.equal(growing.probed(), 0, 'a file still growing is never probed');
});

const working = dir => readJson(path.join(dir, 'draft_info.json'));
function writeDoc(dir, doc) {
  for (const base of [dir, path.join(dir, 'Timelines', doc.id)]) {
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) fs.writeFileSync(path.join(base, name), stableJson(doc));
  }
}
function withEnder() {
  const dir = buildProject();
  fs.mkdirSync(path.join(dir, 'mograph'));
  const file = path.join(dir, 'mograph', 'ending.mov');
  fs.writeFileSync(file, 'prores-bytes');
  applySpec(dir, { version: 1, name: 'ending', operations: [planEnding(working(dir), dir, 'fingerprint', file)] }, { forceRunning: true });
  return dir;
}

test('the export expects the follow ender even after a CapCut save stripped its identity', () => {
  const dir = withEnder();
  assert.equal(reviewContentRange(working(dir), dir).end, 11);
  writeDoc(dir, capcutResave(working(dir)));
  assert.equal(reviewContentRange(working(dir), dir).end, 8, 'the raw draft loses the 3s ender');
  const { doc } = loadWorkingDoc(dir);
  assert.equal(reviewContentRange(doc, dir).end, 11, 'the ledger-restored copy keeps it');
});

test('an ender CapCut moved by a frame-grid rounding (10000µs) is still the end of the edit', () => {
  const dir = withEnder();
  const doc = working(dir);
  const ender = doc.tracks.flatMap(t => t.segments || []).find(s => s.desc === 'mograph:follow-ender');
  ender.target_timerange.start += 10_000;
  assert.equal(contentEndUs(doc, dir), 11_010_000);
  ender.target_timerange.start += 30_000;
  assert.equal(contentEndUs(doc, dir), 8_000_000, 'past half a frame it is detached');
});

test('a parked clip 30s past the edit refuses the export and warns in the gate', () => {
  const dir = buildProject();
  const doc = working(dir);
  doc.duration = 8_000_000;
  assert.equal(tailPastContent(doc, 8).past, false);
  assert.ok(gateReport(doc, { projectDir: dir }).checks.find(c => c.id === 'parked-tail').ok);
  const content = doc.tracks.find(t => t.name === 'content');
  doc.tracks.push({ id: 'PARKED', type: 'video', flag: 0, attribute: 0, name: 'parked', segments: [
    { ...structuredClone(content.segments[0]), id: 'LEFTOVER', target_timerange: { start: 38_000_000, duration: 2_000_000 } }] });
  doc.duration = 40_000_000;
  const tail = tailPastContent(doc, 8);
  assert.equal(tail.past, true);
  assert.deepEqual(tail.segments.map(s => s.id), ['LEFTOVER']);
  assert.throws(() => assertNoTailPastContent(doc, 8), error => {
    assert.equal(error.code, 'EXPORT_TAIL_PAST_CONTENT');
    assert.match(error.message, /LEFTOVER on parked \(38–40s\)/);
    assert.match(error.message, /track\.remove.*timeline\.set/);
    return true;
  });
  const row = gateReport(doc, { projectDir: dir }).checks.find(c => c.id === 'parked-tail');
  assert.equal(row.level, 'WARN');
  assert.equal(row.ok, false);
  assert.match(row.message, /runs to 40s, past the edit's end at 8s/);
});

const passing = () => ({ verdict: 'PASS', failed: [], warned: [], checks: [{ id: 'hook', level: 'FAIL', ok: true, message: 'ok' }] });
function finalProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-final-'));
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  return { dir, project, video: path.join(dir, 'final.mp4') };
}
const skip = (code, lastFile) => async () => { throw Object.assign(new Error(`${code} message`), { code, lastFile }); };

test('out of review rounds, or a second discarded review, warns and names the last review; a sign-in wall still fails', async () => {
  const { dir, project, video } = finalProject();
  const last = path.join(dir, 'review.json');
  fs.writeFileSync(last, JSON.stringify({ round: 2, status: 'decided', issues: [
    { id: 'G3', blocker: true, decision: 'accepted', issue: 'caption covers the logo' },
    { id: 'G4', blocker: true, decision: 'rejected', issue: 'music too loud' }] }));
  const exhausted = await finalGates({ video }, { projectDir: project, doc: {}, args: {}, xray: () => ({}), gate: passing,
    review: skip('REVIEW_ROUNDS_EXHAUSTED', last) });
  assert.equal(exhausted.gate.verdict, 'WARN');
  assert.deepEqual(exhausted.gate.warned, ['review']);
  assert.match(exhausted.gate.checks[0], /REVIEW_ROUNDS_EXHAUSTED.*review\.json.*G3 caption covers the logo/);
  assert.doesNotMatch(exhausted.gate.checks[0], /G4/);
  assert.equal(exhausted.review.lastFile, last);
  const recorded = JSON.parse(fs.readFileSync(path.join(project, '.capcutctl', 'gate.json'), 'utf8'));
  assert.equal(recorded.checks.find(c => c.id === 'review').level, 'WARN');

  const discarded = await finalGates({ video }, { projectDir: project, doc: {}, args: {}, xray: () => ({}), gate: passing,
    review: skip('REVIEW_DISCARDED_AGAIN', null) });
  assert.equal(discarded.gate.verdict, 'WARN', 'not a FAIL: the video is not at fault');
  assert.match(discarded.gate.checks[0], /REVIEW_DISCARDED_AGAIN.*last counted review none/);

  const login = await finalGates({ video }, { projectDir: project, doc: {}, args: {}, xray: () => ({}), gate: passing,
    review: skip('REVIEW_LOGIN', null) });
  assert.equal(login.gate.verdict, 'FAIL');
});

test('the final gate judges with the profile file and style the build recorded; a missing file warns', async () => {
  const { dir, project, video } = finalProject();
  const profile = path.join(dir, 'profile.json');
  fs.writeFileSync(profile, JSON.stringify({ version: 1, styles: { tutorial: { pace: { graphicEvery: [4, 7] } } } }));
  fs.mkdirSync(path.join(project, '.capcutctl'));
  fs.writeFileSync(path.join(project, '.capcutctl', 'build.json'), JSON.stringify({ version: 1, profile, style: 'tutorial' }));
  let seen = null;
  const spy = options => { seen = options.profile; return passing(); };
  const result = await finalGates({ video }, { projectDir: project, doc: {}, args: { noReview: true }, xray: () => ({}), gate: spy });
  assert.equal(seen.activeStyle, 'tutorial');
  assert.deepEqual(seen.density.graphicEvery, [4, 7]);
  assert.equal(result.gate.verdict, 'PASS');
  const recorded = JSON.parse(fs.readFileSync(path.join(project, '.capcutctl', 'gate.json'), 'utf8'));
  assert.deepEqual([recorded.profile.file, recorded.profile.style], [profile, 'tutorial']);

  fs.rmSync(profile);
  const fallback = await finalGates({ video }, { projectDir: project, doc: {}, args: { noReview: true }, xray: () => ({}), gate: spy });
  assert.equal(seen.activeStyle, undefined, 'the default profile');
  assert.equal(fallback.gate.verdict, 'WARN');
  assert.match(fallback.gate.checks.join('\n'), /gate-profile: PROFILE_MISSING/);
});
