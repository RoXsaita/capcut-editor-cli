import test from 'node:test';
import assert from 'node:assert/strict';
import { planScreenMotion, opScreenMotion, SCREEN_EASING } from '../src/screen-camera.mjs';
import { keyframeValue } from '../src/easing.mjs';
import { parseArgs } from '../src/cli.mjs';

test('screen-motion accepts replacement as a standalone CLI flag', () => {
  const args = parseArgs(['screen-motion', '--replace', '--regions', 'regions.json']);
  assert.equal(args.replace, true);
  assert.equal(args.regions, 'regions.json');
});

const U = t => Math.round(t * 1e6);
const properties = ['KFTypeScaleX', 'KFTypeScaleY', 'KFTypePositionX', 'KFTypePositionY'];
function fixture() {
  return { fps: 60, canvas_config: { width: 1920, height: 1080 }, materials: {
    videos: [{ id: 'source', width: 1920, height: 1080, type: 'video', duration: U(160) }], common_mask: [],
  }, tracks: [{ type: 'video', flag: 0, segments: [] }, { type: 'video', flag: 2, segments: [{
    id: 'screen', material_id: 'source', desc: 'screen:capture',
    source_timerange: { start: U(90), duration: U(40) }, target_timerange: { start: U(5), duration: U(20) },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, alpha: 1 },
    extra_material_refs: [], common_keyframes: [],
  }] }] };
}
const selected = d => d.tracks[1].segments[0];
const at = (s, t) => {
  const source = s.source_timerange.start + (U(t) - s.target_timerange.start) * s.source_timerange.duration / s.target_timerange.duration;
  return properties.map(p => keyframeValue(s.common_keyframes.find(b => b.property_type === p)?.keyframe_list, source));
};
const options = () => ({ segment: 'screen', regions: [
  { start: 6, end: 8, focus: [200, 100, 800, 450] },
  { start: 8.5, end: 11, focus: [900, 500, 800, 450] },
  { start: 13, end: 14, focus: [400, 200, 800, 450] },
] });

test('screen camera connects close targets, returns wide across long gaps, and writes sparse source-time native curves', () => {
  const d = fixture(), s = selected(d);
  const alpha = { property_type: 'KFTypeAlpha', keyframe_list: [{ time_offset: U(90), values: [1], curveType: 'Line' }] };
  s.common_keyframes.push(alpha);
  const face = structuredClone(s); face.id = 'face'; face.desc = 'layout:face'; d.tracks[1].segments.push(face);
  const beforeFace = structuredClone(face), beforeRange = structuredClone(s.source_timerange), beforeClip = structuredClone(s.clip);
  const result = opScreenMotion(d, options());
  assert.equal(result.changed, 1);
  assert.equal(result.connections, 1);
  assert.deepEqual(s.source_timerange, beforeRange);
  assert.deepEqual(s.clip, beforeClip);
  assert.deepEqual(face, beforeFace);
  assert.deepEqual(s.common_keyframes.find(k => k.property_type === 'KFTypeAlpha'), alpha);
  const camera = s.common_keyframes.filter(k => properties.includes(k.property_type));
  assert.equal(camera.length, 4);
  for (const block of camera) {
    assert.equal(block.keyframe_list.length, 10, 'six poses for connected targets, four for a separate zoom');
    assert.equal(block.keyframe_list[0].time_offset, U(92));
    assert.equal(block.keyframe_list.at(-1).time_offset, U(109.4));
    assert.ok(block.keyframe_list.every(k => k.curveType === 'FreeCurveInOut'));
    assert.ok(block.keyframe_list.every((k, i, keys) => !i || k.time_offset > keys[i - 1].time_offset));
  }
  assert.ok(Math.abs(at(s, 7)[0] - 2.16) < .02);
  for (let t = 5; t <= 25; t += .1) assert.ok(Math.abs(at(s, t)[0] - at(s, t)[1]) < 1e-9, 'uniform aspect ratio is preserved');
  assert.ok(Math.abs(at(s, 8.35)[0] - 2.16) < .001, 'connected pan stays zoomed');
  assert.ok(at(s, 8.35)[2] < at(s, 8)[2], 'camera glides toward the next focus');
  at(s, 12.8).forEach((v, j) => assert.ok(Math.abs(v - [1, 1, 0, 0][j]) < .001));
  assert.deepEqual(at(s, 18), [1, 1, 0, 0]);
  assert.deepEqual(result.easing, SCREEN_EASING);
  assert.equal(result.nativeVerified, false);
});

test('plan is read-only and replacement is explicit; invalid later targets cannot partially change a clip', () => {
  const d = fixture(), original = structuredClone(d);
  const result = opScreenMotion(d, { ...options(), plan: true });
  assert.equal(result.changed, 0);
  assert.deepEqual(d, original);
  const bad = options(); bad.regions[2].focus = [1800, 1000, 800, 450];
  assert.throws(() => opScreenMotion(d, bad), { code: 'BAD_FOCUS' });
  assert.deepEqual(d, original);
  opScreenMotion(d, options());
  const written = structuredClone(d);
  assert.throws(() => opScreenMotion(d, options()), { code: 'MOTION_OVERLAP' });
  assert.deepEqual(d, written);
  opScreenMotion(d, { ...options(), replace: true });
  assert.deepEqual(at(selected(d), 7), at(selected(written), 7));
});

test('split-screen motion pins the measured seam through native eased interpolation', () => {
  const d = fixture(), s = selected(d);
  d.canvas_config = { width: 1080, height: 1920 };
  s.clip.scale = { x: 1.4, y: 1.4 }; s.clip.transform = { x: .1, y: -.2 };
  s.extra_material_refs = ['mask']; s.enable_video_mask = true;
  d.materials.common_mask.push({ id: 'mask', resource_type: 'line', config: { rotation: 0, centerY: .4 } });
  const seam = v => 960 - v[3] * 960 + (324 - 540) * .5625 * v[0];
  const initial = seam([1.4, 1.4, .1, -.2]);
  const op = { segment: 'screen', regions: [{ start: 6, end: 9, focus: [600, 60, 300, 200] }] };
  opScreenMotion(d, op);
  for (let t = 6; t <= 9.7; t += 1 / 120) assert.ok(Math.abs(seam(at(s, t)) - initial) < 1e-6, `seam shifted at ${t}`);
  const bad = fixture(); selected(bad).extra_material_refs = ['mask'];
  bad.materials.common_mask = [{ id: 'mask', resource_type: 'circle' }];
  assert.throws(() => planScreenMotion(bad, options()), { code: 'MOTION_MASK_UNSUPPORTED' });
});

test('linked frame follows its own time base; other owners and layout layers remain unchanged', () => {
  const d = fixture(), s = selected(d);
  s.desc = 'layout:screen-recording'; s.screen_recording_id = 'owner'; s.clip.scale = { x: .8, y: .8 };
  const frame = structuredClone(s); frame.id = 'frame'; frame.desc = 'layout:screen-frame';
  frame.source_timerange = { start: 0, duration: U(20) };
  const other = structuredClone(frame); other.id = 'other'; other.screen_recording_id = 'other-owner';
  d.tracks[1].segments.push(frame, other);
  const beforeOther = structuredClone(other);
  opScreenMotion(d, { segment: 'screen', regions: [{ start: 6, end: 9, focus: [0, 0, 1920, 1080] }] });
  assert.deepEqual(other, beforeOther);
  for (let t = 5; t <= 15; t += .05) {
    const a = at(s, t), b = at(frame, t);
    a.forEach((v, j) => assert.ok(Math.abs(v - b[j]) < 1e-5));
  }
  assert.throws(() => opScreenMotion(d, { segment: 'screen', replace: true,
    regions: [{ start: 6, end: 9, focus: [600, 60, 300, 200] }] }), { code: 'MOTION_FRAME_CLIPPED' });
});

test('invalid timing, settings, source transforms and role selection fail before writing', () => {
  for (const update of [
    op => { op.regions[1].start = 7; }, op => { op.regions[2].end = 25; },
    op => { op.zoomIn = NaN; }, op => { op.glide = 0; }, op => { op.zoomOut = -1; },
    op => { op.regions[0].start = 4; }, op => { op.regions[0].end = 6.1; },
    op => { delete op.segment; },
  ]) {
    const d = fixture(), before = structuredClone(d), op = options(); update(op);
    assert.throws(() => opScreenMotion(d, op), { code: 'BAD_SCREEN_MOTION' });
    assert.deepEqual(d, before);
  }
  for (const update of [s => { s.reverse = true; }, s => { s.clip.rotation = 15; }, s => { s.source_timerange.duration = 0; }]) {
    const d = fixture(); update(selected(d)); const before = structuredClone(d);
    assert.throws(() => opScreenMotion(d, options())); assert.deepEqual(d, before);
  }
  const d = fixture(); selected(d).desc = 'layout:face';
  assert.throws(() => opScreenMotion(d, options()), { code: 'SCREEN_MOTION_ROLE' });
  const clipped = fixture(); const op = options(); op.regions[2].end = 24.4;
  assert.throws(() => opScreenMotion(clipped, op), { code: 'BAD_SCREEN_MOTION' });
});

test('one zoom has four poses, two connected targets have six, with flat holds and bounded easing', () => {
  for (const count of [1, 2]) {
    const d = fixture(), op = options(); op.regions = op.regions.slice(0, count);
    const plan = opScreenMotion(d, op), s = selected(d);
    assert.equal(plan.clips[0].poses, count === 1 ? 4 : 6);
    for (const block of s.common_keyframes) {
      const keys = block.keyframe_list;
      assert.equal(keys.length, count === 1 ? 4 : 6);
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i], lo = Math.min(a.values[0], b.values[0]), hi = Math.max(a.values[0], b.values[0]);
        assert.ok(a.right_control.y === 0 && b.left_control.y === 0);
        for (let n = 0; n <= 100; n++) {
          const v = keyframeValue(keys, a.time_offset + (b.time_offset - a.time_offset) * n / 100);
          assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, 'easing never overshoots safe endpoints');
        }
      }
    }
    at(s, 7).forEach((v, j) => assert.ok(Math.abs(v - at(s, 7.5)[j]) < 1e-9, 'focus hold is constant'));
    assert.deepEqual(at(s, 5), [1, 1, 0, 0]);
    assert.deepEqual(at(s, 25), [1, 1, 0, 0]);
  }
  const short = planScreenMotion(fixture(), { segment: 'screen', zoomIn: .2,
    regions: [{ start: 6.1, end: 6.3, focus: [200, 100, 800, 450] }] });
  assert.equal(short.clips[0].poses, 3, 'a zero-length hold shares its source-microsecond key');
});

test('corner targets and zoom-out never expose new source edges during native eased motion', () => {
  for (const layout of ['full-screen', 'letterboxed', 'cropped']) {
    const d = fixture(), s = selected(d), m = d.materials.videos[0];
    m.width = 720; m.height = 1050;
    d.canvas_config = layout === 'letterboxed' ? { width: 1080, height: 1920 } : { width: 720, height: 1050 };
    if (layout === 'letterboxed') { s.clip.scale = { x: .8, y: .8 }; s.clip.transform = { x: .1, y: .2 }; }
    if (layout === 'cropped') { s.clip.scale = { x: 1.2, y: 1.2 }; s.clip.transform = { x: .1, y: -.1 }; }
    const { width: W, height: H } = d.canvas_config, fit = Math.min(W / m.width, H / m.height);
    const bounds = ([sx, sy, tx, ty]) => [W / 2 + tx * W / 2 - m.width * fit * sx / 2,
      H / 2 - ty * H / 2 - m.height * fit * sy / 2,
      W / 2 + tx * W / 2 + m.width * fit * sx / 2,
      H / 2 - ty * H / 2 + m.height * fit * sy / 2];
    const original = bounds([s.clip.scale.x, s.clip.scale.y, s.clip.transform.x, s.clip.transform.y]);
    const visible = [Math.max(0, original[0]), Math.max(0, original[1]), Math.min(W, original[2]), Math.min(H, original[3])];
    opScreenMotion(d, { segment: s.id, regions: [
      { start: 6, end: 8, focus: [0, 0, 500, 700] },
      { start: 8.5, end: 10, focus: [220, 350, 500, 700] },
      { start: 10.5, end: 12, focus: [220, 0, 500, 700] },
      { start: 12.5, end: 14, focus: [0, 350, 500, 700] },
      { start: 17, end: 19, focus: [0, 0, 720, 1050] },
    ] });
    for (let t = 5; t <= 25; t += 1 / 120) {
      const box = bounds(at(s, t));
      assert.ok(box[0] <= visible[0] + 1e-6 && box[1] <= visible[1] + 1e-6
        && box[2] >= visible[2] - 1e-6 && box[3] >= visible[3] - 1e-6, `${layout} uncovered its original footprint at ${t}`);
    }
  }
});
