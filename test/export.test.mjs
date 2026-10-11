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
