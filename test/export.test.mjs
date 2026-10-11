import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExport } from '../src/export.mjs';
test('native export rejects partial, wrong-duration and non-video files', () => {
  const probe = { format: { duration: '46.234' }, streams: [{ codec_type: 'video' }] };
  assert.equal(checkExport(probe, 46.233), 46.234);
  assert.throws(() => checkExport(probe, 50), /EXPORT_DURATION_MISMATCH/);
  assert.throws(() => checkExport({ format: { duration: '46.233' }, streams: [] }, 46.233));
  assert.throws(() => checkExport({ format: { duration: 'NaN' }, streams: [{ codec_type: 'video' }] }, 46.233));
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalGates } from '../src/export.mjs';

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
