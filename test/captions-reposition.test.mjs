import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { captionsOnFace } from '../src/gate.mjs';
import { opCaptionsReposition } from '../src/captions.mjs';
import { applySpec, loadProject } from '../src/core.mjs';
import { buildProject } from './helpers/polish-project.mjs';

const face = (start, dur, y, scale = 1) => ({ id: `F${start}`, material_id: 'FACE', target_timerange: { start, duration: dur },
  source_timerange: { start, duration: dur }, clip: { scale: { x: scale, y: scale }, transform: { x: 0, y } } });
const cap = (start, y, duration = 400_000, extra = {}) => ({ id: `C${start}`, material_id: `T${start}`,
  target_timerange: { start, duration }, clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y } }, ...extra });

function doc(caps, { faces = [face(0, 5_000_000, 0), face(5_000_000, 5_000_000, -0.52)], scene = null } = {}) {
  const videos = [{ id: 'FACE', type: 'video', width: 1080, height: 1920 }];
  const tracks = [
    { type: 'video', flag: 0, segments: [] },
    { type: 'video', flag: 2, name: 'content', segments: faces },
    { type: 'text', name: 'captions:x', segments: caps },
  ];
  if (scene) {
    videos.push({ id: 'SCENE', type: 'video', capcutctl_mograph: { scene: 'opener' } });
    tracks.push({ type: 'video', name: 'mograph', segments: [{ id: 'S', material_id: 'SCENE',
      target_timerange: { start: scene[0], duration: scene[1] - scene[0] }, clip: {} }] });
  }
  return { materials: { videos, texts: [] }, tracks };
}

test('a centre word on a full face moves to -0.6; a -0.6 word on a split moves to the seam', () => {
  const d = doc([cap(1_000_000, 0), cap(6_000_000, -0.6)]);
  assert.equal(captionsOnFace(d).length, 2);
  const out = opCaptionsReposition(d);
  assert.equal(out.moved.length, 2);
  assert.equal(d.tracks[2].segments[0].clip.transform.y, -0.6);
  assert.equal(d.tracks[2].segments[1].clip.transform.y, 0);
  assert.deepEqual(captionsOnFace(d), []);
  assert.equal(opCaptionsReposition(d).moved.length, 0, 'a second run moves nothing');
});

test('a word already clear is left byte-identical', () => {
  const d = doc([cap(1_000_000, -0.6), cap(6_000_000, 0)]);
  const before = JSON.stringify(d);
  assert.equal(opCaptionsReposition(d).changed, 0);
  assert.equal(JSON.stringify(d), before);
});

test('a punched-in full face takes the highest position below 20 that clears it, or is reported', () => {
  const d = doc([cap(1_000_000, 0)], { faces: [face(0, 10_000_000, 0, 1.3)] });
  const out = opCaptionsReposition(d);
  assert.equal(out.moved[0].position, 17);
  assert.ok(out.moved[0].position < 20);
  assert.deepEqual(captionsOnFace(d), []);
  const huge = doc([cap(1_000_000, 0)], { faces: [face(0, 10_000_000, 0, 2.5)] });
  const stuck = opCaptionsReposition(huge);
  assert.equal(stuck.moved.length, 0);
  assert.equal(stuck.unresolved.length, 1);
});

test('a word straddling a layout cut is reported, and trimmed to its 70% side with --clamp', () => {
  // 4.8–5.6s: 0.2s full face, 0.6s split (75% after the cut).
  const d = doc([cap(4_800_000, -0.6, 800_000)]);
  const reported = opCaptionsReposition(d);
  assert.equal(reported.straddling.length, 1);
  assert.equal(reported.straddling[0].clampable, true);
  assert.equal(d.tracks[2].segments[0].target_timerange.start, 4_800_000);
  const clamped = opCaptionsReposition(d, { clamp: true });
  assert.equal(clamped.trimmed.length, 1);
  assert.deepEqual(d.tracks[2].segments[0].target_timerange, { start: 5_000_000, duration: 600_000 });
  assert.equal(d.tracks[2].segments[0].clip.transform.y, 0, 'the kept side is a split: the seam');
  // An even straddle is never clamped.
  const even = doc([cap(4_700_000, -0.6, 600_000)]);
  const kept = opCaptionsReposition(even, { clamp: true });
  assert.equal(kept.trimmed.length, 0);
  assert.equal(kept.straddling[0].clampable, false);
});

test('words under a mograph scene and keyframed words are untouched', () => {
  const keyed = cap(2_000_000, 0, 400_000, { common_keyframes: [{ property_type: 'KFTypePositionY', keyframe_list: [{ time_offset: 0, values: [0] }] }] });
  const d = doc([cap(1_000_000, 0), keyed], { scene: [500_000, 1_600_000] });
  const before = JSON.stringify(d);
  const out = opCaptionsReposition(d);
  assert.equal(out.moved.length, 0);
  assert.deepEqual(out.keyframed, [2]);
  assert.equal(JSON.stringify(d), before);
});

test('reposition re-stamps an untouched track so an identical captions run stays unchanged', () => {
  const project = buildProject();
  try {
    const cues = [{ id: 1, start: 0, end: .5, text: 'خليت', position: 50 }, { id: 2, start: 5, end: 5.5, text: 'CV', position: 20 }];
    const op = { op: 'captions', name: 'suheil', cues };
    applySpec(project, { version: 1, operations: [op] }, { forceRunning: true });
    const out = applySpec(project, { version: 1, operations: [{ op: 'captions-reposition' }] }, { forceRunning: true });
    assert.equal(out.result[0].operations[0].moved.length, 1);
    const again = applySpec(project, { version: 1, operations: [op] }, { forceRunning: true });
    assert.equal(again.result[0].operations[0].unchanged, true);
    const d = loadProject(project).groups[0].doc;
    assert.deepEqual(captionsOnFace(d), []);
  } finally { fs.rmSync(path.dirname(project), { recursive: true, force: true }); }
});
