import test from 'node:test';
import assert from 'node:assert/strict';
import { principalTrack, sliceAt } from '../src/polish.mjs';

const US = s => Math.round(s * 1e6);
const seg = (start, dur, srcStart = 0, extra = {}) => ({
  id: `s${start}`, material_id: 'M',
  target_timerange: { start: US(start), duration: US(dur) },
  source_timerange: { start: US(srcStart), duration: US(dur) },
  extra_material_refs: [], clip: { scale: { x: 1, y: 1 } }, ...extra,
});
const track = (type, segments) => ({ type, segments, id: 't' });

/** The Hermes-agent shape: B-roll with a hole, a gapless face above it, plates on top. */
function doc() {
  return {
    duration: US(30),
    materials: { videos: [{ id: 'M', type: 'video' }], common_mask: [{ id: 'K', config: { centerY: 0.5 } }] },
    tracks: [
      track('video', []),                                                   // 0: main, empty
      track('video', [seg(0, 5), seg(5, 5), seg(20, 10)]),                  // 1: B-roll, gap 10-20
      track('video', [seg(0, 12, 100), seg(12, 18, 200)]),                  // 2: the face, gapless
      track('video', [seg(0, 8)]),                                          // 3: one plate
    ],
  };
}

test('principalTrack picks the gapless full-span track, not the busiest', () => {
  assert.equal(principalTrack(doc()).index, 2);
});

test('principalTrack prefers the highest index when several qualify', () => {
  const d = doc();
  d.tracks.push(track('video', [seg(0, 15), seg(15, 15)]));
  assert.equal(principalTrack(d).index, 4);
});

test('principalTrack refuses when nothing is continuous', () => {
  const d = doc();
  d.tracks = [d.tracks[0], d.tracks[1], d.tracks[3]];
  assert.throws(() => principalTrack(d), /NO_PRINCIPAL_TRACK|no principal track/);
});

test('principalTrack honours an explicit override', () => {
  assert.equal(principalTrack(doc(), 1).index, 1);
});

test('sliceAt splits frame-continuously and keeps the timeline gapless', () => {
  const d = doc();
  const t = d.tracks[2];
  assert.equal(sliceAt(d, t, 6, 'k'), 'split');
  assert.equal(t.segments.length, 3);
  const [a, b] = t.segments;
  assert.equal(a.target_timerange.duration, US(6));
  assert.equal(b.target_timerange.start, US(6));
  // the cut must not skip or repeat a frame of source
  assert.equal(a.source_timerange.start + a.source_timerange.duration, b.source_timerange.start);
  // and the track must still be gapless
  let cursor = 0;
  for (const s of t.segments) {
    assert.equal(s.target_timerange.start, cursor);
    cursor += s.target_timerange.duration;
  }
});

test('sliceAt maps source through a speed change', () => {
  const d = doc();
  const t = track('video', [seg(0, 10, 0)]);
  t.segments[0].source_timerange.duration = US(20);     // 2x speed
  d.tracks.push(t);
  sliceAt(d, t, 4, 'k');
  assert.equal(t.segments[0].source_timerange.duration, US(8));
  assert.equal(t.segments[1].source_timerange.start, US(8));
  assert.equal(t.segments[1].source_timerange.duration, US(12));
});

test('sliceAt clones extra materials so the halves do not share a mask', () => {
  const d = doc();
  const t = d.tracks[2];
  t.segments[0].extra_material_refs = ['K'];
  sliceAt(d, t, 6, 'k');
  const [a, b] = t.segments;
  assert.notEqual(a.extra_material_refs[0], b.extra_material_refs[0]);
  assert.equal(d.materials.common_mask.length, 2);
  assert.deepEqual(d.materials.common_mask[1].config, d.materials.common_mask[0].config);
});

test('sliceAt reports an existing boundary instead of cutting twice', () => {
  const d = doc();
  assert.equal(sliceAt(d, d.tracks[2], 12, 'k'), 'existing');
  assert.equal(d.tracks[2].segments.length, 2);
});

test('sliceAt refuses a keyframed segment rather than rescaling its animation', () => {
  const d = doc();
  d.tracks[2].segments[0].common_keyframes = [{ keyframe_list: [{ time_offset: 0 }] }];
  assert.equal(sliceAt(d, d.tracks[2], 6, 'k'), 'keyframed');
  assert.equal(d.tracks[2].segments.length, 2);
});
