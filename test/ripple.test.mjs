import assert from 'node:assert/strict';
import test from 'node:test';

import { opRipple } from '../src/ripple.mjs';

const seg = (id, start, dur, src = null, extra = {}) => ({
  id, material_id: `M-${id}`, extra_material_refs: [],
  target_timerange: { start, duration: dur },
  ...(src != null ? { source_timerange: { start: src, duration: dur } } : {}),
  ...extra,
});

function doc() {
  return {
    duration: 20_000_000,
    materials: { videos: [], texts: [] },
    tracks: [
      { type: 'video', name: 'content', segments: [
        seg('FACE-A', 0, 10_000_000, 100_000_000, { common_keyframes: [{ keyframe_list: [{ time_offset: 109_900_000 }] }] }),
        seg('FACE-B', 10_000_000, 10_000_000, 200_000_000, { common_keyframes: [{ keyframe_list: [{ time_offset: 200_100_000 }, { time_offset: 201_000_000 }] }] }),
      ] },
      { type: 'text', name: 'captions:x', segments: [
        seg('INSIDE', 9_700_000, 400_000),
        seg('HEAD', 10_200_000, 600_000, null, { common_keyframes: [{ keyframe_list: [{ time_offset: 0 }, { time_offset: 500_000 }] }] }),
        seg('LATER', 15_000_000, 1_000_000),
      ] },
      { type: 'audio', name: 'music', segments: [seg('BED', 0, 20_000_000, 0)] },
      { type: 'audio', name: 'sfx', segments: [seg('WHOOSH', 9_500_000, 400_000, 0), seg('POP', 10_000_000, 300_000, 0)] },
    ],
  };
}

test('ripple removes a range on every track and keeps every clip at its speed', () => {
  const d = doc();
  const out = opRipple(d, { from: 9.6, to: 10.4 });
  const by = Object.fromEntries(d.tracks.flatMap(t => t.segments).map(s => [s.id, s]));
  assert.equal(out.removedSeconds, 0.8);
  assert.equal(d.duration, 19_200_000);
  // Tail trim: ends at the range start, source shrinks 1:1.
  assert.deepEqual(by['FACE-A'].target_timerange, { start: 0, duration: 9_600_000 });
  assert.deepEqual(by['FACE-A'].source_timerange, { start: 100_000_000, duration: 9_600_000 });
  assert.equal(by['FACE-A'].common_keyframes[0].keyframe_list[0].time_offset, 109_600_000);
  // Head trim: lands at the range start, source start moves by the cut.
  assert.deepEqual(by['FACE-B'].target_timerange, { start: 9_600_000, duration: 9_600_000 });
  assert.deepEqual(by['FACE-B'].source_timerange, { start: 200_400_000, duration: 9_600_000 });
  assert.deepEqual(by['FACE-B'].common_keyframes[0].keyframe_list.map(k => k.time_offset), [200_400_000, 201_000_000]);
  // A caption wholly inside is removed; a head-trimmed one keeps its relative keyframes in step.
  assert.equal(by.INSIDE, undefined);
  assert.deepEqual(by.HEAD.target_timerange, { start: 9_600_000, duration: 400_000 });
  assert.deepEqual(by.HEAD.common_keyframes[0].keyframe_list.map(k => k.time_offset), [0, 300_000]);
  assert.equal(by.LATER.target_timerange.start, 14_200_000);
  // Spanning bed gives the range up from its tail.
  assert.deepEqual(by.BED.target_timerange, { start: 0, duration: 19_200_000 });
  assert.deepEqual(by.BED.source_timerange, { start: 0, duration: 19_200_000 });
  // One-shot sounds are moved, never cut.
  assert.deepEqual(by.WHOOSH.target_timerange, { start: 9_500_000, duration: 400_000 });
  assert.deepEqual(by.POP.target_timerange, { start: 9_600_000, duration: 300_000 });
});

test('ripple refuses an empty or reversed range', () => {
  assert.throws(() => opRipple(doc(), { from: 5, to: 5 }), /to > from/);
});
