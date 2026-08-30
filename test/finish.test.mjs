import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { pictureChanges, planPolish, cutPoints } from '../src/polish.mjs';
import { renderTimeline } from '../src/timeline.mjs';
import { beatOffset, musicPrompt, detectBeats, opMusic } from '../src/music.mjs';
import { assertFirstPictureProof, finishScorecard, finishText } from '../src/finish.mjs';
import { parseArgs } from '../src/cli.mjs';

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

test('a reframed clip of the SAME file and desc is a new shot', () => {
  // grok-build regression: three consecutive slices of one screen recording shared a
  // desc, so `path|desc` read them as one continuous shot and --motivated dropped the
  // seams. Reframing is what the viewer actually sees change.
  const d = grokLike();
  const punched = { scale: { x: 5, y: 5 }, transform: { x: -1.02, y: 0.28 } };
  d.tracks[1].segments[3].clip = punched;   // 13-17 reframed ...
  d.tracks[1].segments[4].clip = punched;   // ... and 17-20 holds that same framing
  const times = pictureChanges(d, { minGap: 0.5 }).map(h => h.t);
  assert.ok(times.includes(13), `reframe at 13 is a picture change: ${times}`);
  assert.equal(times.includes(17), false, 'un-reframed slice at 17 still is not');
});

test('a sweep means the layout class changed, not that the seam bar was re-cut', () => {
  // The seam bar is re-cut at every split-screen B-roll boundary. Testing for a
  // `layout:seam-bar` segment START made every such cut claim to be a layout change and
  // take a Horizontal Triptych — 8 of 13 seams (62%) against a ~45% ceiling.
  const d = grokLike();
  d.tracks[3].segments = [
    seg(0, 6, { material_id: 'PLATE', desc: 'layout:seam-bar' }),
    seg(6, 4, { material_id: 'PLATE', desc: 'layout:seam-bar' }),
    seg(10, 10, { material_id: 'PLATE', desc: 'layout:seam-bar' }),
    seg(24, 6, { material_id: 'PLATE', desc: 'layout:seam-bar' }),
  ];
  const plan = planPolish(d, { motivated: true, minGap: 0.5 });
  const sweeps = plan.filter(p => p.pair === 'sweep' || p.pair === 'sweepL');
  assert.ok(sweeps.length < plan.length,
    `not every seam is a sweep: ${plan.map(p => `${p.t}:${p.pair}`)}`);
  for (const s of sweeps) {
    assert.ok(s.t === 20 || s.t === 24,
      `sweep at ${s.t} is a real layout change (full-face hole is 20-24)`);
  }
});

test('pictureChanges treats Split → Circle as a layout-class change', () => {
  const d = grokLike();
  d.materials.common_mask = [
    { id: 'MASK', name: 'Split', resource_type: 'line', type: 'mask' },
    { id: 'CIR', name: 'Circle', resource_type: 'circle', type: 'mask' },
  ];
  d.tracks[2].segments = [
    seg(0, 6, { refs: ['MASK'], id: 'f0' }),
    seg(6, 4, { refs: ['MASK'], id: 'f1' }),
    seg(10, 3, { refs: ['MASK'], id: 'f2' }),
    seg(13, 7, { refs: ['CIR'], id: 'f3' }),
    seg(20, 4, { id: 'f4' }),
    seg(24, 6, { refs: ['MASK'], id: 'f5' }),
  ];
  const hits = pictureChanges(d, { minGap: 0.5 });
  const at13 = hits.find(h => h.t === 13);
  assert.ok(at13, `expected layout change at 13, got ${hits.map(h => `${h.t}:${h.kind}`)}`);
  assert.equal(at13.kind, 'layout');
});

test('finish --polish is a boolean flag, not a value option', () => {
  const a = parseArgs(['finish', '--project', 'X', '--polish']);
  assert.equal(a.polish, true);
  assert.equal(a.project, 'X');
  const b = parseArgs(['finish', '--project', 'X', '--music', '--polish', '--regen']);
  assert.equal(b.music, true);
  assert.equal(b.polish, true);
  assert.equal(b.regen, true);
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

test('finish scorecard and music prompt use contentEnd instead of the parked draft tail', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-finish-duration-'));
  const sidecar = path.join(temp, '.capcutctl', 'created.json');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, JSON.stringify({
    preserved: { start: US(20), end: US(38) },
    contentEnd: US(20),
  }));
  const d = grokLike();
  d.duration = US(48);
  try {
    const score = finishScorecard(d, { projectDir: temp });
    assert.equal(score.duration, 20);
    assert.match(score.musicPrompt, /20\.0-second/);
    assert.doesNotMatch(score.musicPrompt, /48\.0-second/);
    assert.equal(score.pictureChanges.some(hit => hit.t >= 20), false);
    assert.equal(score.polishPlan.some(hit => hit.t >= 20), false);
    const prompt = musicPrompt(d, { projectDir: temp });
    assert.match(prompt, /20\.0-second/);
    assert.doesNotMatch(prompt, /48\.0-second/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('finish scorecard flags a cold open and is quiet when the first seconds have B-roll', () => {
  const covered = finishScorecard(grokLike());
  assert.equal(covered.coldOpen, null);
  assert.equal(covered.firstPictureProof.ok, true);
  const d = grokLike();
  d.tracks[1].segments = [];
  d.tracks[2].segments = d.tracks[2].segments.map(s => ({ ...s, extra_material_refs: [] }));
  const score = finishScorecard(d);
  assert.ok(score.coldOpen, score.coldOpen);
  assert.equal(score.firstPictureProof.ok, false);
  assert.match(finishText(score), /cold-open/);
  assert.match(finishText(score), /first-picture: FAIL/);
  assert.throws(() => assertFirstPictureProof(d), error =>
    error.code === 'FIRST_PICTURE_NOT_PROOF' && error.exitCode === 2);
});

test('finish scorecard reports existing same-screen transitions separately', () => {
  const d = grokLike();
  d.tracks[2].segments = [
    seg(0, 6, { refs: ['MASK'], id: 'f0' }),
    seg(6, 4, { refs: ['MASK'], id: 'f1' }),
    seg(10, 3, { refs: ['MASK', 'TR1'], id: 'f2' }),
    seg(13, 7, { refs: ['MASK'], id: 'f2b' }),
    seg(20, 4, { id: 'f3' }),
    seg(24, 6, { refs: ['MASK'], id: 'f4' }),
  ];
  const score = finishScorecard(d);
  assert.ok(score.sameScreenTransitions.includes(13), score.sameScreenTransitions);
  assert.ok(score.sameScreenCuts.includes(13), score.sameScreenCuts);
  assert.match(finishText(score), /same-screen transitions \(remove these\): 13/);
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

test('opMusic ends the bed at the endcard, not the draft tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
  const mp3 = path.join(dir, 'bed.mp3');
  fs.writeFileSync(mp3, Buffer.alloc(64));
  const d = grokLike();
  d.tracks.push(track('video', [
    seg(20, 10, { desc: 'sig:endcard', id: 'cta' }),
  ], { name: 'sig-endcard' }));
  const r = opMusic(d, { file: mp3, duration: 40, volume: 0.16, fadeIn: 0.4, fadeOut: 1.2, __seed: 'SEED' });
  assert.equal(r.duration, 20);
  assert.equal(r.until, 20);
  const lane = d.tracks.find(t => t.name === 'finish-music');
  assert.equal(lane.segments[0].target_timerange.duration, US(20));
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
