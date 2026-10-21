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
    materials: { videos: [], texts: [{ id: 'M-INSIDE' }, { id: 'M-HEAD' }, { id: 'M-LATER' }] },
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
  // One-shot sounds are moved, never cut — and never stacked: the POP pulled to the range
  // start would land inside the WHOOSH, so it slides to the WHOOSH's end.
  assert.deepEqual(by.WHOOSH.target_timerange, { start: 9_500_000, duration: 400_000 });
  assert.deepEqual(by.POP.target_timerange, { start: 9_900_000, duration: 300_000 });
  assert.deepEqual(out.relaned, []);
  // The removed caption's text material goes with it.
  assert.deepEqual(d.materials.texts.map(m => m.id), ['M-HEAD', 'M-LATER']);
});

const speedOf = (d, s) => d.materials.speeds.find(m => s.extra_material_refs.includes(m.id));

function spanning(speed = 1) {
  const srcDur = 20_000_000 * speed;
  return {
    id: 'TIMELINE-RIPPLE',
    duration: 20_000_000,
    materials: {
      videos: [{ id: 'M-FACE', type: 'video', path: '/face.mp4', duration: 120_000_000 }],
      audios: [{ id: 'M-BED', type: 'music', path: '/bed.mp3', duration: 60_000_000 }],
      speeds: [{ id: 'SPEED', type: 'speed', speed, mode: 0, curve_speed: null }],
      texts: [{ id: 'M-CAP', type: 'text', content: '{"text":"later"}' }],
    },
    tracks: [
      { id: 'T-FACE', type: 'video', name: 'content', segments: [{
        id: 'FACE', material_id: 'M-FACE', extra_material_refs: ['SPEED'], speed,
        target_timerange: { start: 0, duration: 20_000_000 },
        source_timerange: { start: 50_000_000, duration: srcDur },
        common_keyframes: [{ id: 'KF-GROUP', property_type: 'KFTypeScaleX', keyframe_list: [
          { id: 'K1', time_offset: 50_000_000 + 2_000_000 * speed, values: [1] },
          { id: 'K2', time_offset: 50_000_000 + 15_000_000 * speed, values: [1.2] },
        ] }],
      }] },
      { id: 'T-CAP', type: 'text', name: 'captions:x', segments: [seg('CAP', 12_000_000, 600_000)].map(s => ({ ...s, material_id: 'M-CAP' })) },
      { id: 'T-BED', type: 'audio', name: 'music', segments: [{ ...seg('BED', 0, 20_000_000, 0), material_id: 'M-BED' }] },
    ],
  };
}

test('ripple inside one face clip splits it: the pause goes, the last words stay, the bed is trimmed', () => {
  const d = spanning();
  const out = opRipple(d, { from: 9.6, to: 10.4 });
  const face = d.tracks[0].segments;
  assert.equal(face.length, 2);
  const [head, tail] = face;
  assert.equal(head.id, 'FACE');
  assert.deepEqual(head.target_timerange, { start: 0, duration: 9_600_000 });
  assert.deepEqual(head.source_timerange, { start: 50_000_000, duration: 9_600_000 });
  assert.notEqual(tail.id, 'FACE');
  assert.deepEqual(tail.target_timerange, { start: 9_600_000, duration: 9_600_000 });
  assert.deepEqual(tail.source_timerange, { start: 60_400_000, duration: 9_600_000 });
  assert.notEqual(speedOf(d, tail).id, speedOf(d, head).id, 'the tail has its own speed material');
  assert.equal(speedOf(d, tail).speed, 1);
  // Source-time keys are partitioned, not clamped onto the cut.
  assert.deepEqual(head.common_keyframes[0].keyframe_list.map(k => k.time_offset), [52_000_000]);
  assert.deepEqual(tail.common_keyframes[0].keyframe_list.map(k => k.time_offset), [65_000_000]);
  assert.notEqual(tail.common_keyframes[0].keyframe_list[0].id, 'K2');
  assert.equal(d.tracks[1].segments[0].target_timerange.start, 11_200_000);
  assert.deepEqual(d.tracks[2].segments[0].target_timerange, { start: 0, duration: 19_200_000 });
  assert.deepEqual(out.split, ['content:FACE']);
  assert.equal(d.duration, 19_200_000);
  // The same ripple on the same draft mints the same tail (both mirrors, and a retry).
  const again = spanning();
  opRipple(again, { from: 9.6, to: 10.4 });
  assert.equal(again.tracks[0].segments[1].id, tail.id);
});

test('ripple split at half speed keeps the speed on both halves', () => {
  const d = spanning(0.5);
  opRipple(d, { from: 9.6, to: 10.4 });
  const [head, tail] = d.tracks[0].segments;
  assert.deepEqual(head.target_timerange, { start: 0, duration: 9_600_000 });
  assert.deepEqual(head.source_timerange, { start: 50_000_000, duration: 4_800_000 });
  assert.deepEqual(tail.target_timerange, { start: 9_600_000, duration: 9_600_000 });
  assert.deepEqual(tail.source_timerange, { start: 55_200_000, duration: 4_800_000 });
  assert.equal(speedOf(d, tail).speed, 0.5);
});

test('ripple never stacks one-shots: a moved sound slides after the last, or takes a ripple lane', () => {
  const d = {
    id: 'TL', duration: 20_000_000,
    materials: { audios: [{ id: 'M-S', type: 'sound', path: '/pop.wav', duration: 500_000 }] },
    tracks: [
      { id: 'T-FACE', type: 'video', name: 'content', segments: [seg('FACE', 0, 20_000_000, 0)] },
      { id: 'T-SFX', type: 'audio', name: 'sfx', segments: [
        { ...seg('S1', 9_700_000, 400_000, 0), material_id: 'M-S' },
        { ...seg('S2', 10_500_000, 400_000, 0), material_id: 'M-S' },
        { ...seg('S3', 11_200_000, 400_000, 0), material_id: 'M-S' },
      ] },
    ],
  };
  const out = opRipple(d, { from: 9.6, to: 10.8 });
  for (const track of d.tracks.filter(t => t.type === 'audio')) {
    const segs = track.segments;
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1].target_timerange;
      assert.ok(segs[i].target_timerange.start >= prev.start + prev.duration, `${track.name}: ${segs[i].id} overlaps ${segs[i - 1].id}`);
    }
  }
  const all = d.tracks.flatMap(t => t.segments.map(s => [s.id, t.name, s.target_timerange.start]));
  assert.deepEqual(all.filter(([id]) => id.startsWith('S')), [
    ['S1', 'sfx', 9_600_000], ['S3', 'sfx', 10_000_000], ['S2', 'sfx:ripple', 9_600_000],
  ]);
  assert.equal(out.relaned.length, 1);
  assert.equal(d.tracks[2].name, 'sfx:ripple');
  assert.notEqual(d.tracks[2].id, 'T-SFX');
  assert.ok(d.tracks.every((t, i) => t.segments.every(s => s.track_render_index === i)));
});

test('a removed segment takes its main material with it, unless another segment still uses it', () => {
  const d = doc();
  d.materials.texts = [{ id: 'M-INSIDE' }, { id: 'M-SHARED' }];
  d.tracks[1].segments[2].material_id = 'M-SHARED';
  d.tracks[1].segments.push({ ...seg('INSIDE-2', 9_800_000, 300_000), material_id: 'M-SHARED' });
  opRipple(d, { from: 9.6, to: 10.4 });
  assert.deepEqual(d.materials.texts.map(m => m.id), ['M-SHARED']);
});

test('ripple refuses an empty or reversed range', () => {
  assert.throws(() => opRipple(doc(), { from: 5, to: 5 }), /to > from/);
});
