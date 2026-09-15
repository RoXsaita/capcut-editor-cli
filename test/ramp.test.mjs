import test from 'node:test';
import assert from 'node:assert/strict';
import { findResultMoment, opRamp, DEFAULT_SPEED } from '../src/ramp.mjs';

const US = s => Math.round(s * 1e6);
const S = us => us / 1e6;

function doc({ srcIn = 95, srcDur = 5, timelineDur = 5, keys = false } = {}) {
  const broll = {
    id: 'b0', material_id: 'FILE', desc: 'broll: files', speed: 1,
    target_timerange: { start: 0, duration: US(timelineDur) },
    source_timerange: { start: US(srcIn), duration: US(srcDur) },
    extra_material_refs: ['sp1'],
    clip: { scale: { x: 1, y: 1 } },
    ...(keys ? {
      common_keyframes: [{
        property_type: 'KFTypeScaleX',
        keyframe_list: [{ time_offset: US(srcIn), values: [1], curveType: 'Line' }],
      }],
    } : {}),
  };
  return {
    duration: US(10),
    materials: {
      videos: [
        { id: 'FILE', type: 'video', path: '/screen.mp4', duration: US(600), material_name: 'screen.mp4' },
        { id: 'FACE', type: 'video', path: '/cam.mp4', duration: US(600), material_name: 'cam.mp4' },
      ],
      speeds: [{ id: 'sp1', type: 'speed', speed: 1, mode: 0, curve_speed: null }],
    },
    tracks: [
      { type: 'video', flag: 0, segments: [] },
      { type: 'video', id: 'broll', flag: 2, segments: [broll] },
      { type: 'video', id: 'face', flag: 2, segments: [
        {
          id: 'f0', material_id: 'FACE',
          target_timerange: { start: 0, duration: US(10) },
          source_timerange: { start: 0, duration: US(10) },
          extra_material_refs: [],
        },
      ] },
    ],
  };
}

test('findResultMoment is the first peak after a quiet stretch, not the in-point burst', () => {
  const moments = [
    { start: 95, end: 95.4, peak: 0.8 },
    { start: 99, end: 99.3, peak: 0.9 },
  ];
  const hit = findResultMoment(moments, 95, 100);
  assert.equal(hit.start, 99);
  assert.equal(findResultMoment(moments, 95, 100, { minQuiet: 10 }), null);
  assert.equal(findResultMoment([{ start: 95.1, end: 96, peak: 0.7 }], 95, 100), null);
});

test('opRamp splits at the result, paces the wait, and leaves the result at 1×', () => {
  const d = doc();
  const out = opRamp(d, {
    segment: 'b0', speed: DEFAULT_SPEED, settle: 0.5, resultAt: 99.5, __seed: 'ramp-test',
  });
  const wait = d.tracks[1].segments[0];
  const shown = d.tracks[1].segments[1];
  assert.equal(d.tracks[1].segments.length, 2);
  assert.equal(out.split, 'split');
  assert.equal(shown.target_timerange.start, wait.target_timerange.start + wait.target_timerange.duration);
  assert.ok(Math.abs(out.wait.speed - 20) < 0.02, out.wait);
  assert.ok(Math.abs(out.result.speed - 1) < 0.02, out.result);
  const waitSrcEnd = S(wait.source_timerange.start + wait.source_timerange.duration);
  const resultSrcStart = S(shown.source_timerange.start);
  assert.ok(Math.abs(waitSrcEnd - resultSrcStart) < 0.02, { waitSrcEnd, resultSrcStart });
  assert.ok(Math.abs(resultSrcStart - 99) < 0.02, resultSrcStart);
  for (const speed of d.materials.speeds) {
    assert.equal(speed.curve_speed, null);
  }
  assert.equal(wait.source_timerange.start + wait.source_timerange.duration,
    shown.source_timerange.start);
});

test('opRamp --result-at does not need a change sidecar', () => {
  const d = doc();
  const out = opRamp(d, { at: 0, resultAt: 99.5, speed: 20, settle: 0.5, __seed: 'ramp-override' });
  assert.equal(out.resultAt, 99.5);
  assert.equal(d.tracks[1].segments.length, 2);
});

test('native 30fps ramp cut keeps the 20x wait contiguous with the 1x result after frame snapping', () => {
  const d = doc(); d.fps = 30;
  const s = d.tracks[1].segments[0];
  s.source_timerange = { start: US(930), duration: US(20) };
  s.target_timerange = { start: US(22.3), duration: US(0.9) };
  d.materials.videos.find(m => m.id === s.material_id).duration = US(1400);
  opRamp(d, { segment: 'b0', speed: 20, resultAt: 935.988822, settle: 0.5 });
  const [wait, result] = d.tracks[1].segments;
  assert.equal(result.target_timerange.start, 22533333);
  assert.equal(result.source_timerange.start, 935500000);
  assert.equal(wait.speed, 20);
  assert.equal(wait.source_timerange.start + wait.source_timerange.duration, result.source_timerange.start);
  assert.equal(wait.target_timerange.duration, 233333);
  const waitMat = d.materials.speeds.find(m => (wait.extra_material_refs || []).includes(m.id));
  const resultMat = d.materials.speeds.find(m => (result.extra_material_refs || []).includes(m.id));
  assert.equal(waitMat.speed, 20);
  assert.equal(resultMat.speed, 1);
  assert.notEqual(waitMat.id, resultMat.id);
});

test('an unpaced wait keeps the slice source seam instead of jumping to the snapped split', () => {
  const d = doc(); d.fps = 30;
  const s = d.tracks[1].segments[0];
  s.source_timerange = { start: US(930), duration: US(20) };
  s.target_timerange = { start: US(22.3), duration: US(0.9) };
  d.materials.videos.find(m => m.id === s.material_id).duration = US(1400);
  opRamp(d, { segment: 'b0', speed: 1.01, resultAt: 935.988822, settle: 0.5 });
  const [wait, result] = d.tracks[1].segments;
  assert.equal(wait.source_timerange.start + wait.source_timerange.duration, result.source_timerange.start);
  const waitImplied = wait.source_timerange.duration / wait.target_timerange.duration;
  assert.ok(waitImplied > 20, waitImplied);
  assert.ok(Math.abs(result.source_timerange.duration / result.target_timerange.duration - 1) < 0.02);
});

test('opRamp uses the first peak after quiet when moments are supplied', () => {
  const d = doc();
  const out = opRamp(d, {
    segment: 'b0', speed: 20, settle: 0.5, __seed: 'ramp-moments',
    moments: [
      { start: 95, end: 95.3, peak: 0.8 },
      { start: 99.5, end: 99.8, peak: 0.91 },
    ],
  });
  assert.equal(out.resultAt, 99.5);
  assert.ok(Math.abs(out.result.speed - 1) < 0.02);
});

test('faces never ramp', () => {
  const d = doc();
  assert.throws(() => opRamp(d, { segment: 'f0', resultAt: 5, speed: 20, __seed: 'face' }), {
    code: 'PRINCIPAL_TRACK',
  });
});

test('keyframed B-roll is refused rather than silently rescaled', () => {
  const d = doc({ keys: true });
  assert.throws(() => opRamp(d, { segment: 'b0', resultAt: 99.5, speed: 20, settle: 0.5, __seed: 'keys' }), {
    code: 'KEYFRAMED',
  });
});

test('missing quiet stretch without --result-at fails clearly', () => {
  const d = doc();
  assert.throws(() => opRamp(d, {
    segment: 'b0', speed: 20, settle: 0.5, __seed: 'no-result',
    moments: [{ start: 95, end: 99.8, peak: 0.9 }],
  }), { code: 'NO_RESULT' });
});
