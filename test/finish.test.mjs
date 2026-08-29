import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { pictureChanges, planPolish, cutPoints } from '../src/polish.mjs';
import { renderTimeline } from '../src/timeline.mjs';
import { beatOffset, musicPrompt, detectBeats, opMusic } from '../src/music.mjs';
import { finishScorecard } from '../src/finish.mjs';

const US = s => Math.round(s * 1e6);
const seg = (start, dur, extra = {}) => ({
  id: extra.id || `s${start}`,
  material_id: extra.material_id || 'M',
  target_timerange: { start: US(start), duration: US(dur) },
  source_timerange: { start: US(extra.src || 0), duration: US(dur) },
  extra_material_refs: extra.refs || [],
  clip: { scale: { x: 1, y: 1 } },
  desc: extra.desc || '',
  volume: extra.volume ?? 1,
});
const track = (type, segments, extra = {}) => ({ type, segments, id: extra.id || 't', flag: extra.flag ?? 2, name: extra.name || '' });

function grokLike() {
  // 30s: b-roll files list 10-20 is THREE slices of the same desc (the grok-build bug)
  return {
    name: 'fixture',
    duration: US(30),
    materials: {
      videos: [
        { id: 'M', type: 'video', path: '/cam.mp4' },
        { id: 'B', type: 'video', path: '/screen.mp4' },
        { id: 'PLATE', type: 'photo', path: '/bar.png' },
      ],
      audios: [],
      transitions: [{ id: 'TR1', name: 'Flash' }],
      common_mask: [{ id: 'MASK', type: 'mask' }],
    },
    tracks: [
      { ...track('video', [], { flag: 0 }), flag: 0 },
      track('video', [
        seg(0, 6, { material_id: 'B', desc: 'broll: hook game', id: 'b0' }),
        seg(6, 4, { material_id: 'B', desc: 'broll: GROK BUILD tab', id: 'b1' }),
        seg(10, 3, { material_id: 'B', desc: 'broll: files', id: 'b2' }),
        seg(13, 4, { material_id: 'B', desc: 'broll: files', id: 'b3' }),
        seg(17, 3, { material_id: 'B', desc: 'broll: files', id: 'b4' }),
        seg(24, 6, { material_id: 'B', desc: 'broll: agent', id: 'b5' }),
      ]),
      track('video', [
        seg(0, 6, { refs: ['MASK'], id: 'f0' }),
        seg(6, 4, { refs: ['MASK'], id: 'f1' }),
        seg(10, 10, { refs: ['MASK'], id: 'f2' }),
        seg(20, 4, { id: 'f3' }),            // full-face hole
        seg(24, 6, { refs: ['MASK'], id: 'f4' }),
      ]),
      track('video', [
        seg(0, 20, { material_id: 'PLATE', desc: 'layout:seam-bar' }),
        seg(24, 6, { material_id: 'PLATE', desc: 'layout:seam-bar' }),
      ]),
    ],
  };
}

test('pictureChanges ignores A-roll splices over the same B-roll desc', () => {
  const d = grokLike();
  const hits = pictureChanges(d, { minGap: 0.5 });
  const times = hits.map(h => h.t);
  assert.ok(times.includes(6), `tab change: ${times}`);
  assert.ok(times.includes(10), `files start: ${times}`);
  assert.ok(times.includes(20) || times.includes(24), `layout/agent: ${times}`);
  assert.equal(times.includes(13), false, 'same files list at 13 must not be a picture change');
  assert.equal(times.includes(17), false, 'same files list at 17 must not be a picture change');
});

test('motivated polish plans fewer seams than every-cut polish', () => {
  const d = grokLike();
  const all = planPolish(d, { motivated: false });
  const mot = planPolish(d, { motivated: true, minGap: 0.5 });
  assert.ok(mot.length < all.length, `motivated ${mot.length} vs all ${all.length}`);
  assert.ok(mot.length >= 3, `still keeps real picture changes (${mot.length})`);
});

test('timeline ASCII shows stacked tracks and a gap in B-roll', () => {
  const view = renderTimeline(grokLike(), { width: 40 });
  assert.match(view.text, /▓/);
  assert.match(view.text, /█/);
  assert.match(view.text, /─/);
  assert.ok(view.text.split('\n').some(l => l.includes('·')), 'gap shown as ·');
});

test('finish scorecard flags same-screen cuts', () => {
  const score = finishScorecard(grokLike());
  assert.ok(score.sameScreenCuts.length >= 1, score.sameScreenCuts);
  assert.ok(score.musicPrompt.includes('Instrumental'));
  assert.ok(score.timeline.includes('▓'));
});

test('beatOffset picks a clamped median shift and never recuts hits', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5];
  const hits = [1.08, 2.04];
  const a = beatOffset(beats, hits, { clamp: 0.4 });
  assert.ok(Math.abs(a.offset) <= 0.4);
  assert.equal(hits[0], 1.08);                  // picture times unchanged
  assert.equal(a.pairs.length, 2);
});

test('beatOffset with empty inputs is zero', () => {
  assert.equal(beatOffset([], [1]).offset, 0);
  assert.equal(beatOffset([1], []).offset, 0);
});

test('detectBeats finds periodic pulses in a synthetic wav', { skip: !commandExists('ffmpeg') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beats-'));
  const wav = path.join(dir, 'clicks.wav');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=800:duration=2',
    '-af', 'volume=eval=frame:volume=\'gt(mod(t\\,0.5)\\,0.45)*20-20\'',
    wav,
  ], { stdio: 'pipe' });
  const beats = detectBeats(wav, { minGap: 0.3 });
  assert.ok(beats.length >= 2, `got ${beats.length} beats: ${beats}`);
});

test('opMusic places a local file on finish-music and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
  const mp3 = path.join(dir, 'bed.mp3');
  // tiny silent mp3-like file is enough if we pass duration; skip probe
  fs.writeFileSync(mp3, Buffer.alloc(64));
  const d = grokLike();
  d.materials.audios = [];
  const r1 = opMusic(d, { file: mp3, duration: 8, volume: 0.16, fadeIn: 0.4, fadeOut: 0.8, __seed: 'SEED' });
  assert.equal(r1.changed, 1);
  const lane = d.tracks.find(t => t.name === 'finish-music');
  assert.ok(lane);
  assert.equal(lane.segments.length, 1);
  assert.equal(lane.segments[0].volume, 0.16);
  opMusic(d, { file: mp3, duration: 8, volume: 0.16, __seed: 'SEED' });
  assert.equal(lane.segments.length, 1, 're-run replaces rather than stacks');
});

test('cutPoints still sees every splice so the all-cuts plan remains available', () => {
  const n = cutPoints(grokLike()).length;
  assert.ok(n >= 5, n);
});

function commandExists(name) {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}
