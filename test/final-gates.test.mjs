import assert from 'node:assert/strict';
import test from 'node:test';

import { captionLayers, endingCard, exportGates } from '../src/gate.mjs';

const seg = (start, dur, extra = {}) => ({ id: `S${start}`, material_id: 'M', target_timerange: { start, duration: dur }, ...extra });
const docWith = tracks => ({ materials: { videos: [{ id: 'M', path: '/x/clip.mp4' }, { id: 'E', path: '/x/renders__suheilai-follow-ender.mov' }], texts: [] }, tracks });
const profile = { canvas: { width: 1080, height: 1920, fps: 30 },
  final: { captionsRequired: true, firstWordBy: 0.5, maxSpeechGap: 0.7, lastWordTail: 0.08, maxLoudnessJump: 6, lengthWarnAbove: 90 } };

test('captions: one layer counts, two layers are double captions, an empty track is none', () => {
  const one = docWith([{ type: 'text', name: 'captions:x', segments: [seg(0, 400_000)] }, { type: 'text', name: 'captions:empty', segments: [] }]);
  assert.equal(captionLayers(one).length, 1);
  const two = docWith([{ type: 'text', name: 'captions:x', segments: [seg(0, 400_000)] }, { type: 'text', name: 'captions:y', segments: [seg(0, 400_000)] }]);
  assert.equal(captionLayers(two).length, 2);
  assert.equal(captionLayers(docWith([])).length, 0);
});

test('ending: a follow-ender clip or sig:endcard on the last frame passes; one that stops early, or a render, does not', () => {
  const end = 10;
  assert.ok(endingCard(docWith([{ type: 'video', segments: [seg(8_000_000, 2_000_000, { desc: 'repost:shared-visual-follow-ender' })] }]), end));
  assert.ok(endingCard(docWith([{ type: 'text', segments: [seg(7_500_000, 2_500_000, { desc: 'sig:endcard' })] }]), end));
  assert.ok(endingCard(docWith([{ type: 'video', segments: [seg(8_000_000, 2_000_000, { material_id: 'E' })] }]), end), 'by file name');
  assert.equal(endingCard(docWith([{ type: 'video', segments: [seg(5_000_000, 2_000_000, { desc: 'sig:endcard' })] }]), end), null);
  assert.equal(endingCard(docWith([{ type: 'video', segments: [seg(8_000_000, 2_000_000, { desc: 'mograph:render' })] }]), end), null);
  assert.equal(endingCard(docWith([{ type: 'audio', segments: [seg(8_000_000, 2_000_000, { desc: 'sig:sfx:endcard' })] }]), end), null);
});

const xray = (over = {}) => ({
  info: { video: { width: 1080, height: 1920, avg_frame_rate: '30/1' }, format: { duration: '20.0' } },
  audio: { present: true, findings: [], loudness: { momentary: Array.from({ length: 200 }, (_, i) => [i / 10, -20, -18]) } },
  ...over,
});
const words = (...spans) => ({ words: spans.map(([start, end], i) => ({ word: `w${i}`, start, end })) });
const byId = checks => Object.fromEntries(checks.map(c => [c.id, c]));

test('export gates pass a clean export and hold every check at FAIL level', () => {
  const checks = exportGates(xray(), words([0.2, 1], [1.2, 5], [5.3, 17.8]), { profile, enderAt: 18 });
  assert.ok(checks.every(c => c.ok && c.level === 'FAIL'), JSON.stringify(checks.filter(c => !c.ok)));
});

test('slow start, a long gap, and a clipped last word fail; a declared pause is allowed', () => {
  const c = byId(exportGates(xray(), words([0.8, 1], [2, 5], [5.1, 17.97]), { profile, enderAt: 18 }));
  assert.equal(c['first-word'].ok, false);
  assert.equal(c['speech-gaps'].ok, false);
  assert.match(c['speech-gaps'].message, /1s \(1s\)/);
  assert.equal(c['last-word'].ok, false);
  const paused = byId(exportGates(xray(), words([0.1, 1], [2, 5], [5.1, 17]), { profile, enderAt: 18, pauses: [1.5] }));
  assert.equal(paused['speech-gaps'].ok, true);
});
