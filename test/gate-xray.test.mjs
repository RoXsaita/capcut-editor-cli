import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldXray } from '../src/gate.mjs';

const baseReport = () => ({ verdict: 'PASS', failed: [], warned: [], checks: [
  { id: 'hook', level: 'FAIL', ok: true, message: 'first visual event at 0.4s', value: null, target: null },
], scope: 'Draft structure only.' });

function xrayDir(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-xray-'));
  fs.writeFileSync(path.join(dir, 'xray.json'), JSON.stringify(doc));
  return dir;
}

test('an X-ray FAIL blocks the gate, an UNKNOWN warns, NOT CHECKED is listed and never passed', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-project-'));
  const draft = path.join(project, 'draft_info.json');
  fs.writeFileSync(draft, '{}');
  const older = BigInt(Math.floor(fs.statSync(draft).mtimeMs * 1e6)) + 10n ** 9n;
  const dir = xrayDir({
    export: { path: '/x/export.mp4', sha256: 'ab', mtime_ns: Number(older) },
    draft: { project, draft_path: draft },
    verdicts: [
      { property: 'audio.true_peak', verdict: 'FAIL', detail: '0.0 dBTP' },
      { property: 'video.stutter', verdict: 'UNKNOWN', detail: '2 events' },
      { property: 'audio.loudness', verdict: 'PASS', detail: '-14 LUFS' },
      { property: 'sync.lip', verdict: 'NOT CHECKED', detail: 'no estimator' },
    ],
  });
  const report = foldXray(baseReport(), dir, project);
  assert.equal(report.verdict, 'FAIL');
  assert.deepEqual(report.failed, ['xray:audio.true_peak']);
  assert.deepEqual(report.warned, ['xray:video.stutter']);
  assert.deepEqual(report.xray.notChecked, ['sync.lip']);
  assert.match(report.scope, /Not checked: sync\.lip/);
});

test('an X-ray of another project fails the gate rather than lending it evidence', () => {
  const dir = xrayDir({ export: {}, draft: { project: '/somewhere/else', draft_path: '/nope' }, verdicts: [] });
  const report = foldXray(baseReport(), dir, '/my/project');
  assert.equal(report.verdict, 'FAIL');
  assert.deepEqual(report.failed, ['xray-draft']);
});

test('an unreadable X-ray folder fails by name', () => {
  const report = foldXray(baseReport(), '/definitely/not/here', '/my/project');
  assert.equal(report.verdict, 'FAIL');
  assert.deepEqual(report.failed, ['xray']);
});
