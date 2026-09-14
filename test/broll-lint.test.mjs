import test from 'node:test';
import assert from 'node:assert/strict';
import { lintBroll, lintProjectBroll, BROLL_TOO_SHORT } from '../src/broll-lint.mjs';

const clip = (id, extra = {}) => ({
  id,
  srcIn: extra.srcIn ?? 0,
  timelineOut: extra.timelineOut ?? 2,
  onScreen: extra.onScreen ?? 2,
  moments: extra.moments,
});

test('BROLL_IN_MOTION fires when the source in-point sits in a change peak ≥ 0.5', () => {
  const moments = [{ start: 10, end: 10.4, peak: 0.72 }];
  const hit = lintBroll([clip('b0', { srcIn: 10.1, onScreen: 2 })], { moments, words: [] });
  assert.equal(hit.skipped.length, 0);
  assert.equal(hit.findings.some(f => f.code === 'BROLL_IN_MOTION' && f.id === 'b0'), true, hit.findings);
  const miss = lintBroll([clip('b1', { srcIn: 12, onScreen: 2 })], { moments, words: [] });
  assert.equal(miss.findings.some(f => f.code === 'BROLL_IN_MOTION'), false, miss.findings);
});

test('BROLL_OUT_MIDWORD fires when the timeline out-point falls inside an A-roll word', () => {
  const words = [{ start: 4.0, end: 4.4, word: 'Publish' }];
  const hit = lintBroll([clip('b0', { timelineOut: 4.2, onScreen: 2 })], { moments: [], words });
  assert.equal(hit.findings.some(f => f.code === 'BROLL_OUT_MIDWORD' && f.word === 'Publish'), true, hit.findings);
  const boundary = lintBroll([clip('b1', { timelineOut: 4.0, onScreen: 2 })], { moments: [], words });
  assert.equal(boundary.findings.some(f => f.code === 'BROLL_OUT_MIDWORD'), false,
    'a seam exactly on a word start is not inside the word');
});

test('BROLL_TOO_SHORT fires under 0.8s on screen after pace', () => {
  const hit = lintBroll([clip('b0', { onScreen: 0.5 })], { moments: [], words: [] });
  assert.equal(hit.findings.some(f => f.code === 'BROLL_TOO_SHORT' && f.onScreen === 0.5), true, hit.findings);
  const ok = lintBroll([clip('b1', { onScreen: BROLL_TOO_SHORT })], { moments: [], words: [] });
  assert.equal(ok.findings.some(f => f.code === 'BROLL_TOO_SHORT'), false, ok.findings);
});

test('missing change sidecar or transcript skips those codes and says so', () => {
  const result = lintBroll([clip('b0', { onScreen: 2 })]);
  assert.deepEqual(result.skipped.map(s => s.code).sort(), ['BROLL_IN_MOTION', 'BROLL_OUT_MIDWORD']);
  assert.match(result.skipped.find(s => s.code === 'BROLL_IN_MOTION').reason, /no change sidecar/);
  assert.match(result.skipped.find(s => s.code === 'BROLL_OUT_MIDWORD').reason, /no transcript/);
  assert.equal(result.findings.some(f => f.code === 'BROLL_IN_MOTION' || f.code === 'BROLL_OUT_MIDWORD'), false);
});

test('lintProjectBroll on a draft without sidecars skips motion and midword', () => {
  const US = s => Math.round(s * 1e6);
  const doc = {
    materials: { videos: [{ id: 'B', type: 'video', path: '/screen.mp4' }] },
    tracks: [{
      type: 'video', flag: 2, segments: [{
        id: 'b0', material_id: 'B', desc: 'broll: files',
        target_timerange: { start: 0, duration: US(2) },
        source_timerange: { start: US(10), duration: US(2) },
      }],
    }],
  };
  const result = lintProjectBroll(doc);
  assert.ok(result.skipped.some(s => s.code === 'BROLL_IN_MOTION'));
  assert.ok(result.skipped.some(s => s.code === 'BROLL_OUT_MIDWORD'));
  assert.ok(result.issues.some(i => /skipped BROLL_IN_MOTION/.test(i.message)));
});
