import assert from 'node:assert/strict';
import test from 'node:test';

import { captionsOnFace } from '../src/gate.mjs';

const face = (start, dur, y) => ({ id: `F${start}`, material_id: 'FACE', target_timerange: { start, duration: dur },
  source_timerange: { start, duration: dur }, clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y } } });
const cap = (start, y) => ({ id: `C${start}`, material_id: 'T', target_timerange: { start, duration: 400_000 },
  clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y } } });

function doc(caps) {
  return {
    materials: { videos: [{ id: 'FACE', type: 'video', width: 1080, height: 1920 }] },
    tracks: [
      { type: 'video', flag: 0, segments: [] },
      { type: 'video', flag: 2, name: 'content', segments: [face(0, 5_000_000, 0), face(5_000_000, 5_000_000, -0.52)] },
      { type: 'text', name: 'captions:x', segments: caps },
    ],
  };
}

test('caption-face flags centre captions on full face and face-half captions on a split', () => {
  const hits = captionsOnFace(doc([cap(1_000_000, 0), cap(6_000_000, -0.6)]));
  assert.deepEqual(hits.map(h => h.layout), ['full', 'split']);
});

test('caption-face passes position 20 on full face and the seam on a split', () => {
  assert.deepEqual(captionsOnFace(doc([cap(1_000_000, -0.6), cap(6_000_000, 0)])), []);
});

import { graphicEvents } from '../src/gate.mjs';

// A caption layer nobody named captions:*: CapCut's own auto-captions (subtitle text) or a
// track named plain "captions" (the older SRT op).
function looseCaptions(track, materials = []) {
  const d = doc([]);
  d.tracks[2] = track;
  d.materials.texts = materials;
  return d;
}

test('caption-face and graphicEvents agree on what a caption track is', () => {
  const subtitle = looseCaptions({ type: 'text', segments: [{ ...cap(1_000_000, 0), material_id: 'SUB' }] },
    [{ id: 'SUB', type: 'subtitle' }]);
  assert.equal(captionsOnFace(subtitle).length, 1, 'an unnamed subtitle track over a full face is a hit');
  assert.equal(graphicEvents(subtitle).length, 0, 'and it is not a graphic entrance');
  const named = looseCaptions({ type: 'text', name: 'captions', segments: [cap(1_000_000, 0)] });
  assert.equal(captionsOnFace(named).length, 1);
  assert.equal(graphicEvents(named).length, 0);
});

test('caption-face reads a circle face as a circle: clear of the avatar passes, on it fails', () => {
  const circle = caps => ({
    materials: { videos: [{ id: 'FACE', type: 'video', width: 1080, height: 1920 }],
      common_mask: [{ id: 'MASK', type: 'mask', name: 'Circle', resource_type: 'circle', config: { width: 1.0032, height: 0.5618 } }] },
    tracks: [
      { type: 'video', flag: 0, segments: [] },
      { type: 'video', flag: 2, name: 'content', segments: [{ ...face(0, 10_000_000, 0.669), extra_material_refs: ['MASK'],
        clip: { scale: { x: 0.19, y: 0.19 }, transform: { x: -0.556, y: 0.669 } } }] },
      { type: 'text', name: 'captions:x', segments: caps },
    ],
  });
  assert.deepEqual(captionsOnFace(circle([cap(1_000_000, 0.1)])), [], 'a caption under the avatar is clear');
  const hits = captionsOnFace(circle([cap(1_000_000, 0.67)]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].layout, 'circle');
  assert.ok(hits[0].box.y0 < 318 && hits[0].box.y1 > 318);
});

import { openingSnaps } from '../src/gate.mjs';

const shot = (keys) => ({ materials: { videos: [] }, tracks: [{ type: 'video', name: 'screen', segments: [{
  id: 'S', material_id: 'M', target_timerange: { start: 10_000_000, duration: 2_000_000 },
  source_timerange: { start: 2_000_000, duration: 2_000_000 },
  common_keyframes: [{ property_type: 'KFTypeScaleX', keyframe_list: keys.map(([t, v]) => ({ time_offset: t, values: [v] })) }] }] }] });

test('opening-snap flags a snap re-frame in the first 0.6s, not a slow push or a later punch', () => {
  assert.equal(openingSnaps(shot([[2_300_000, 2], [2_330_000, 1.83]])).length, 1);
  assert.equal(openingSnaps(shot([[2_300_000, 2], [2_900_000, 2.1]])).length, 0);
  assert.equal(openingSnaps(shot([[3_000_000, 2], [3_030_000, 1.83]])).length, 0);
});

import { cameraMoves, gateReport, moveLegs } from '../src/gate.mjs';

const at = s => Math.round(s * 1e6);

test('opening-snap sees a snap keyed at the first frame or from before the window', () => {
  assert.equal(openingSnaps(shot([[at(2.0), 2], [at(2.1), 1.83]])).length, 1, 'keyed at the first frame');
  assert.equal(openingSnaps(shot([[at(1.95), 2], [at(2.1), 1.83]])).length, 1, 'keyed before the cut, landing after it');
  assert.equal(openingSnaps(shot([[at(1.95), 2], [at(2.1), 1.83]]))[0].t, 10, 'reported at the cut');
  assert.equal(openingSnaps(shot([[at(1.0), 1], [at(3.0), 1.2]])).length, 0, 'a slow push');
  assert.equal(openingSnaps(shot([[at(1.8), 2], [at(1.9), 1.83]])).length, 0, 'a snap over before the first frame');
  assert.equal(openingSnaps(shot([[at(2.0), 1.2], [at(2.23), 1]])).length, 0, 'the 0.23s default ramp at the cut');
});

test('a per-frame ramp is one move; a snap followed by dense drift is still a snap', () => {
  const ramp = Array.from({ length: 30 }, (_, i) => [at(2.0 + i / 30), 1 + 0.01 * i]);
  const doc = shot(ramp);
  assert.equal(moveLegs(doc.tracks[0].segments[0]).length, 1);
  assert.equal(cameraMoves(doc).length, 1);
  assert.equal(openingSnaps(doc).length, 0);
  doc.tracks[0].segments[0].target_timerange.start = 0;    // a principal from 0 so the gate runs
  assert.equal(gateReport(doc).checks.find(c => c.id === 'simultaneity').value, 1);
  const drift = [[at(2.0), 2], [at(2.1), 1.83], ...Array.from({ length: 20 }, (_, i) => [at(2.1 + (i + 1) / 30), 1.83 - 0.001 * (i + 1)])];
  assert.equal(openingSnaps(shot(drift)).length, 1);
  assert.equal(cameraMoves(shot(drift)).length, 2);
});
