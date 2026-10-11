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
