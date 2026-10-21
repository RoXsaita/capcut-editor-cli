import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnchor, resolveAnchors } from '../src/anchors.mjs';

// One principal clip: source 10.0–14.0 plays at timeline 2.0–6.0. Source before 10.0 was cut.
const mapper = t => (t >= 10 && t < 14 ? Math.round((2 + (t - 10)) * 1000) / 1000 : null);

test('a word Whisper starts just before the in-point resolves to the clip start, snapped', () => {
  const hit = resolveAnchor({ say: 'claude' }, [{ text: 'claude', start: 9.96, end: 10.4 }], mapper);
  assert.ok(hit);
  assert.ok(Math.abs(hit.at - 2) < 0.025, `at ${hit.at}`);
  assert.equal(hit.snapped, true);
  assert.equal(hit.sourceAt, 9.96);
});

test('the snapped occurrence is counted before the occurrence check', () => {
  const words = [
    { text: 'claude', start: 4.0, end: 4.4 },     // inside the cut-out region
    { text: 'claude', start: 9.96, end: 10.4 },   // just before the in-point
    { text: 'claude', start: 12.0, end: 12.4 },
  ];
  const first = resolveAnchor({ say: 'claude', occurrence: 1 }, words, mapper);
  assert.equal(first.sourceAt, 9.96);
  const second = resolveAnchor({ say: 'claude', occurrence: 2 }, words, mapper);
  assert.equal(second.sourceAt, 12);
  assert.equal(second.snapped, undefined);
});

test('a dropped word that ends before the in-point still orphans; a word fully cut stays null', () => {
  assert.equal(resolveAnchor({ say: 'gone' }, [{ text: 'gone', start: 9.0, end: 9.95 }], mapper), null);
  assert.equal(resolveAnchor({ say: 'gone' }, [{ text: 'gone', start: 5.0, end: 5.5 }], mapper), null);
  // Only 0.04s of the word survives after the in-point: not enough to be heard.
  assert.equal(resolveAnchor({ say: 'tail' }, [{ text: 'tail', start: 9.9, end: 10.04 }], mapper), null);
  const doc = { tracks: [{ type: 'video', segments: [{ id: 's', material_id: 'm',
    source_timerange: { start: 10_000_000, duration: 4_000_000 }, target_timerange: { start: 0, duration: 4_000_000 } }] }],
  materials: { videos: [{ id: 'm', type: 'video', path: '/x/face.mp4' }] } };
  assert.throws(() => resolveAnchors([{ id: 'x', say: 'gone' }], { doc, words: [{ text: 'gone', start: 9.0, end: 9.95 }] }),
    err => err.code === 'ANCHOR_ORPHANED');
  const ok = resolveAnchors([{ id: 'y', say: 'claude' }], { doc, words: [{ text: 'claude', start: 9.96, end: 10.4 }] });
  assert.equal(ok[0].anchor.snapped, true);
  assert.ok(Math.abs(ok[0].at) < 0.025, 'the doc plays source 10s at timeline 0');
});
