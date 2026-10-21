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
  audio: { present: true, findings: [], loudness: { integrated_lufs: -15.8, momentary: Array.from({ length: 200 }, (_, i) => [i / 10, -20, -18]) } },
  ...over,
});
const words = (...spans) => ({ words: spans.map(([start, end], i) => ({ word: `w${i}`, start, end })) });
/** A voice-band envelope: -15 dB inside the voiced spans, -65 dB (room tone) elsewhere, 10 ms steps. */
const envelope = (seconds, ...voiced) => ({ step: 0.01, db: Array.from({ length: seconds * 100 },
  (_, i) => (voiced.some(([a, b]) => i / 100 >= a && i / 100 < b) ? -15 : -65)) });
const byId = checks => Object.fromEntries(checks.map(c => [c.id, c]));

test('export gates pass a clean export and hold every check at FAIL level', () => {
  const checks = exportGates(xray(), words([0, 1], [1, 5], [5, 17.8]), { profile, enderAt: 18,
    envelope: envelope(20, [0.2, 1], [1.2, 5], [5.3, 17.6]) });
  assert.ok(checks.every(c => c.ok && c.level === 'FAIL'), JSON.stringify(checks.filter(c => !c.ok)));
});

test('slow start, a long gap, and a clipped last word fail from the audio, though Whisper stretches over them', () => {
  // Whisper's words are contiguous from 0s (as on real exports); only the envelope knows better.
  const stretched = words([0, 2], [2, 5], [5, 18]);
  const c = byId(exportGates(xray(), stretched, { profile, enderAt: 18, envelope: envelope(20, [0.8, 1], [2, 5], [5.1, 18]) }));
  assert.equal(c['first-word'].ok, false);
  assert.match(c['first-word'].message, /starts at 0\.8s/);
  assert.equal(c['speech-gaps'].ok, false);
  assert.match(c['speech-gaps'].message, /at 1s \(1s\)/);
  assert.equal(c['last-word'].ok, false);
  const paused = byId(exportGates(xray(), stretched, { profile, enderAt: 18, pauses: [1.5], envelope: envelope(20, [0.1, 1], [2, 5], [5.1, 17.5]) }));
  assert.equal(paused['speech-gaps'].ok, true);
  assert.equal(paused['last-word'].ok, true);
  assert.equal(byId(exportGates(xray(), stretched, { profile, enderAt: 18 })).speech.ok, false, 'no envelope is a FAIL, not a pass');
});

test('wrong format, no audio, and no transcript fail by name rather than pass', () => {
  const c = byId(exportGates(xray({ info: { video: { width: 720, height: 1280, avg_frame_rate: '60/1' }, format: { duration: '20' } }, audio: { present: false } }), null, { profile }));
  assert.equal(c['export-format'].ok, false);
  assert.equal(c['export-audio'].ok, false);
  assert.equal(c.speech.ok, false);
});

test('a dropout before the ender fails; silence running into the ender, and a step in level, are told apart', () => {
  const drop = xray();
  drop.audio.findings = [{ kind: 'silence', t: 9, dur_s: 0.4, where: 'inside' }, { kind: 'silence', t: 17.9, dur_s: 0.5, where: 'inside' }];
  const c = byId(exportGates(drop, words([0, 17]), { profile, enderAt: 18, envelope: envelope(20, [0, 17]) }));
  assert.equal(c['export-audio'].ok, false);
  assert.match(c['export-audio'].message, /9s \(0\.4s\)/);
  assert.doesNotMatch(c['export-audio'].message, /17\.9/);
  const jump = xray();
  jump.audio.loudness.momentary = jump.audio.loudness.momentary.map(([t, m, s]) => [t, m, t >= 10 ? s + 9 : s]);
  const j = byId(exportGates(jump, words([0, 17]), { profile, enderAt: 18 }));
  assert.equal(j['loudness-jumps'].ok, false);
  assert.match(j['loudness-jumps'].message, /at 10s \(\+9 LU\)/);
});

test('integrated loudness blocks only outside -14 ±2.5 LU', () => {
  const at = il => { const x = xray(); x.audio.loudness.integrated_lufs = il;
    return byId(exportGates(x, words([0, 17]), { profile: { ...profile, sound: { loudnessTarget: -14 }, final: { ...profile.final, loudnessTolerance: 2.5 } }, enderAt: 18, envelope: envelope(20, [0, 17]) }))['export-loudness']; };
  assert.equal(at(-16.3).ok, true);
  assert.equal(at(-17).ok, false);
  assert.equal(at(-11).ok, false);
  assert.equal(at(null).ok, false, 'unmeasured is not a pass');
});

test('a low-fps proxy notes the format instead of failing it; a full-rate wrong format still fails', () => {
  const proxy = byId(exportGates(xray({ info: { video: { width: 360, height: 640, avg_frame_rate: '6/1' }, format: { duration: '20' } } }), null, { profile }));
  assert.equal(proxy['export-format'].ok, false);
  assert.equal(proxy['export-format'].level, 'NOTE');
  assert.match(proxy['export-format'].message, /proxy-only, verify on the full-rate export/);
  const wrong = byId(exportGates(xray({ info: { video: { width: 720, height: 1280, avg_frame_rate: '25/1' }, format: { duration: '20' } } }), null, { profile }));
  assert.equal(wrong['export-format'].level, 'FAIL');
});

test('first-word is the first sustained voice: an opening whoosh or a music bed is not the first word', () => {
  const said = words([0, 1], [1, 5], [5, 17.8]);
  const whoosh = byId(exportGates(xray(), said, { profile, enderAt: 18, envelope: envelope(20, [0.05, 0.15], [1.2, 5], [5.3, 17.6]) }));
  assert.equal(whoosh['first-word'].ok, false);
  assert.match(whoosh['first-word'].message, /starts at 1\.2s/);
  const bed = envelope(20, [1.2, 5], [5.3, 17.6]);
  bed.db = bed.db.map(v => (v === -65 ? -30 : v));          // a -30 dB music bed under the room tone
  const music = byId(exportGates(xray(), said, { profile, enderAt: 18, envelope: bed }));
  assert.equal(music['first-word'].ok, false);
  assert.match(music['first-word'].message, /starts at 1\.2s/);
});
