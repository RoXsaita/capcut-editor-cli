import test from 'node:test';
import assert from 'node:assert/strict';
import { pacePlan, setSpeed, opPace } from '../src/pace.mjs';

const US = s => Math.round(s * 1e6);

function doc() {
  const seg = (start, dur, srcStart, srcDur, speedId, kf = null) => ({
    id: `s${start}`, material_id: 'FILE', speed: srcDur / dur,
    target_timerange: { start: US(start), duration: US(dur) },
    source_timerange: { start: US(srcStart), duration: US(srcDur) },
    extra_material_refs: [speedId],
    ...(kf ? { common_keyframes: [{ property_type: 'KFTypeScaleX', keyframe_list: kf.map(o => ({ time_offset: US(o), values: [2] })) }] } : {}),
  });
  return {
    duration: US(30),
    materials: {
      videos: [{ id: 'FILE', type: 'video', path: '/a/rec.mov', duration: US(600), material_name: 'rec.mov' },
               { id: 'FILE2', type: 'video', path: '/a/rec.mov', duration: US(600), material_name: 'rec.mov' },
               { id: 'PLATE', type: 'photo', path: '/a/frame.png' }],
      speeds: [{ id: 'sp1', type: 'speed', speed: 1, mode: 0, curve_speed: null },
               { id: 'sp2', type: 'speed', speed: 1, mode: 0, curve_speed: null },
               { id: 'sp3', type: 'speed', speed: 4, mode: 0, curve_speed: null }],
    },
    tracks: [
      { type: 'video', segments: [], id: 't0' },
      { type: 'video', id: 'broll', segments: [
        seg(0, 2, 10, 2, 'sp1', [10.5, 10.7]),      // 1x, 60s skipped after
        seg(2, 2, 70, 2, 'sp2'),                    // 1x, 3s skipped after (short)
        seg(4, 2, 75, 8, 'sp3'),                    // already 4x
      ] },
      { type: 'video', id: 'face', segments: [                     // gapless => principal
        { id: 'f1', material_id: 'FILE2', target_timerange: { start: 0, duration: US(15) },
          source_timerange: { start: 0, duration: US(15) }, extra_material_refs: [] },
        { id: 'f2', material_id: 'FILE2', target_timerange: { start: US(15), duration: US(15) },
          source_timerange: { start: US(15), duration: US(15) }, extra_material_refs: [] },
      ] },
    ],
  };
}

test('the plan skips the principal track — faces never ramp', () => {
  const rows = pacePlan(doc());
  assert.ok(rows.every(r => r.track === 1));
  assert.equal(rows.length, 3);
});

test('pace refuses rather than ramping the face when there is no principal', () => {
  const d = doc();
  d.tracks.pop();                                 // drop the face
  d.tracks[1].segments[1].target_timerange.start = US(10);  // open a hole
  assert.throws(() => pacePlan(d), /NO_PRINCIPAL_TRACK|no principal track/);
});

test('the plan suggests only for a long skip, and matches by path not material id', () => {
  const rows = pacePlan(doc(), { minGap: 5 });
  assert.equal(rows[0].skippedAfter, 58);           // source 12 -> 70
  assert.equal(rows[0].suggested, 30);              // (70-10)/2s
  assert.equal(rows[1].skippedAfter, 3);            // 72 -> 75, under minGap
  assert.equal(rows[1].suggested, null);
});

test('the plan caps at max', () => {
  assert.equal(pacePlan(doc(), { minGap: 5, max: 12 })[0].suggested, 12);
});

test('setSpeed keeps the timeline slot identical and grows only the source', () => {
  const d = doc();
  const seg = d.tracks[1].segments[0];
  const before = seg.target_timerange.duration;
  setSpeed(d, seg, 30);
  assert.equal(seg.target_timerange.duration, before);
  assert.equal(seg.source_timerange.start, US(10));
  assert.equal(seg.source_timerange.duration, US(60));
  assert.equal(seg.speed, 30);
  assert.equal(d.materials.speeds.find(s => s.id === 'sp1').speed, 30);
});

test('setSpeed preserves each zoom ON-SCREEN duration', () => {
  const d = doc();
  const seg = d.tracks[1].segments[0];
  const kl = seg.common_keyframes[0].keyframe_list;
  const screenBefore = (kl[1].time_offset - kl[0].time_offset) / 1e6 / 1;   // at 1x
  setSpeed(d, seg, 30);
  const screenAfter = (kl[1].time_offset - kl[0].time_offset) / 1e6 / 30;   // at 30x
  assert.ok(Math.abs(screenBefore - screenAfter) < 0.005, `${screenBefore} vs ${screenAfter}`);
  // and every keyframe still lies inside the new source window
  const { start, duration } = seg.source_timerange;
  for (const kf of kl) assert.ok(kf.time_offset >= start && kf.time_offset <= start + duration);
});

test('setSpeed clamps at the end of the source instead of running past it', () => {
  const d = doc();
  const seg = d.tracks[1].segments[2];
  seg.source_timerange.start = US(595);
  const out = setSpeed(d, seg, 100);
  assert.equal(out.clamped, true);
  assert.ok(seg.source_timerange.start + seg.source_timerange.duration <= US(600));
});

test('setSpeed slowing down keeps keyframes inside the shrunken window', () => {
  const d = doc();
  const seg = d.tracks[1].segments[0];
  setSpeed(d, seg, 0.4);
  const { start, duration } = seg.source_timerange;
  assert.equal(duration, US(0.8));
  for (const kf of seg.common_keyframes[0].keyframe_list) {
    assert.ok(kf.time_offset >= start && kf.time_offset <= start + duration);
  }
});

test('auto never overrides a ramp somebody already chose', () => {
  const d = doc();
  d.tracks[1].segments[1].source_timerange.start = US(70);   // make seg 1 have a long skip
  d.tracks[1].segments[2].source_timerange.start = US(200);
  const r = opPace(d, { auto: true, minGap: 5 });
  assert.ok(r.applied.every(a => a.from === 1), JSON.stringify(r.applied));
  assert.equal(d.materials.speeds.find(s => s.id === 'sp3').speed, 4);   // untouched
});

test('--cover computes the speed from the range', () => {
  const d = doc();
  const r = opPace(d, { set: [{ at: 0, cover: [10, 70] }] });
  assert.equal(r.applied[0].speed, 30);                       // 60s of source in a 2s slot
  assert.deepEqual(r.applied[0].source, [10, 70]);
});

test('pace refuses rather than silently doing nothing', () => {
  assert.throws(() => opPace(doc(), {}), /NOTHING_TO_PACE|changed nothing/);
});

test('the result reports the compression ratio', () => {
  const d = doc();
  const r = opPace(d, { set: [{ at: 0, speed: 30 }] });
  assert.ok(r.compression > 1);
  assert.equal(typeof r.realtimePercent, 'number');
});
