import test from 'node:test';
import assert from 'node:assert/strict';
import { opScaleKeyframe, cameraValue } from '../src/add.mjs';

const U = x => Math.round(x * 1e6);
const clip = (id, extra = {}) => ({ id, material_id: 'video', extra_material_refs: [],
  source_timerange: { start: U(90), duration: U(20) },
  target_timerange: { start: 0, duration: U(10) },
  clip: { scale: { x: 1.4, y: 1.4 }, transform: { x: .1, y: -.2 }, alpha: 1 }, ...extra });
const doc = segment => ({ canvas_config: { width: 1080, height: 1920 },
  materials: { videos: [{ id: 'video', width: 1920, height: 1080 }], common_mask: [] },
  tracks: [{ type: 'video', flag: 2, segments: [segment] }] });
const channel = (property, entries) => ({ property_type: property,
  keyframe_list: entries.map(([t,v]) => ({ time_offset: U(t), values: [v], curveType: 'Line' })) });
const value = (s, p, t, fallback = 0) => cameraValue(s, p, U(t), fallback);

test('camera preserves alpha and distant moves, uses current scale, and returns at source speed', () => {
  const s = clip('face');
  const alpha = channel('KFTypeAlpha', [[90, 1], [110, .8]]);
  s.common_keyframes = [alpha, channel('KFTypeScaleX', [[90,1.4], [94,1.4], [108,1.7], [110,1.7]])];
  const result = opScaleKeyframe(doc(s), { selector: { id: s.id }, at: 2, ramp: .25, hold: 1 });
  assert.equal(result.from, 1.4);
  assert.ok(Math.abs(result.to - 1.61) < 1e-9);
  assert.deepEqual(s.common_keyframes.find(k => k.property_type === 'KFTypeAlpha'), alpha);
  assert.equal(value(s,'KFTypeScaleX',97),1.4);
  assert.equal(value(s,'KFTypeScaleX',108),1.7);
  const before = structuredClone(s);
  assert.throws(() => opScaleKeyframe(doc(s), { selector:{id:s.id}, at:9, hold:2 }), { code:'MOTION_TOO_SHORT' });
  assert.deepEqual(s,before);
  opScaleKeyframe(doc(s), { selector:{id:s.id}, clear:true });
  assert.deepEqual(s.common_keyframes,[alpha]);
});

test('focus keeps the split seam fixed throughout the push and return', () => {
  const s = clip('screen', { extra_material_refs: ['mask'], enable_video_mask: true });
  const d = doc(s);
  d.materials.common_mask.push({ id:'mask', resource_type:'line', config:{rotation:0, centerY:.4} });
  const seam = (scale,ty) => 960 - ty*960 + (324-540)*.5625*scale;
  const initial = seam(1.4,-.2);
  opScaleKeyframe(d, { selector:{id:s.id}, at:1, focus:[600,60,300,200], hold:1 });
  // The seam is linear in (scale, ty), so it stays put between keys exactly when both channels
  // traverse on ONE progress curve. `cameraValue` refuses to interpolate an eased curve (it will
  // not fake CapCut's bezier), so check the two facts that imply the invariant instead: the seam
  // is fixed AT every key, and scale and position share the same times, curve and handle shape.
  const channelOf = p => s.common_keyframes.find(k => k.property_type === p).keyframe_list;
  const sx = channelOf('KFTypeScaleX'), py = channelOf('KFTypePositionY');
  assert.equal(sx.length, py.length);
  sx.forEach((k, i) => {
    assert.ok(Math.abs(seam(k.values[0], py[i].values[0]) - initial) < 1e-6, `seam moved at key ${i}`);
    assert.equal(k.time_offset, py[i].time_offset);
    assert.equal(k.curveType, 'FreeCurveInOut');
    assert.equal(py[i].curveType, 'FreeCurveInOut');
    const next = sx[i + 1];
    if (!next) return;
    const span = next.time_offset - k.time_offset;
    const dvS = next.values[0] - k.values[0], dvP = py[i + 1].values[0] - py[i].values[0];
    assert.equal(k.right_control.x / span, py[i].right_control.x / span);
    if (dvS && dvP) assert.ok(Math.abs(k.right_control.y / dvS - py[i].right_control.y / dvP) < 1e-9);
  });
  // With --no-ease both channels are Line, so the old point sampling still proves it directly.
  opScaleKeyframe(d, { selector:{id:s.id}, clear:true });
  opScaleKeyframe(d, { selector:{id:s.id}, at:1, focus:[600,60,300,200], hold:1, ease:false });
  for (const t of [92,92.2,92.4,94,94.8]) {
    assert.ok(Math.abs(seam(value(s,'KFTypeScaleX',t),value(s,'KFTypePositionY',t))-initial)<1e-6);
  }
  opScaleKeyframe(d, { selector:{id:s.id}, clear:true });
  opScaleKeyframe(d, { selector:{id:s.id}, at:1, focus:[600,60,300,200], hold:1 });
  assert.throws(() => opScaleKeyframe(d, { selector:{id:s.id}, at:5, focus:[0,500,200,200] }), {code:'FOCUS_MASKED'});
  d.materials.common_mask[0].config.invert = true;
  assert.throws(() => opScaleKeyframe(d,{selector:{id:s.id},at:5}),{code:'MOTION_MASK_UNSUPPORTED'});
});

test('explicit starting scale preserves a non-uniform vertical scale ratio', () => {
  const s = clip('face', {clip:{scale:{x:2,y:1.5},transform:{x:0,y:0},alpha:1}});
  opScaleKeyframe(doc(s),{selector:{id:s.id},at:1,from:1.6,to:1.8,hold:1});
  assert.ok(Math.abs(value(s,'KFTypeScaleY',92)-1.2)<1e-9);
  assert.ok(Math.abs(value(s,'KFTypeScaleY',92.4)-1.35)<1e-9);
  const unlocked = clip('unlocked', { uniform_scale: { on: false } });
  opScaleKeyframe(doc(unlocked), { selector: { id: unlocked.id }, at: 1, to: 1.8, hold: 1 });
  assert.equal(value(unlocked, 'KFTypeScaleY', 92.4), 1.8, 'unlinked equal scales still need both channels');
});

test('linked frame follows focus on its own time base; separate owners stay unchanged', () => {
  const s = clip('screen', { desc:'layout:screen-recording', screen_recording_id:'owner' });
  const frame = clip('border', { desc:'layout:screen-frame', screen_recording_id:'owner',
    source_timerange:{start:0,duration:U(10)} });
  const other = clip('other', { desc:'layout:screen-frame', screen_recording_id:'foreign' });
  const d = doc(s); d.tracks[0].segments.push(frame,other);
  s.clip.scale = {x:.8,y:.8}; frame.clip.scale = {x:.8,y:.8};
  const before = structuredClone(d);
  assert.throws(() => opScaleKeyframe(d, {selector:{id:s.id},at:1,focus:[800,100,300,300],hold:1}), {code:'MOTION_FRAME_CLIPPED'});
  assert.deepEqual(d,before);
  opScaleKeyframe(d, {selector:{id:s.id},at:1,focus:[0,0,1920,1080],viewport:[0,0,1080,960],hold:1});
  for (const [p,fallback] of [['KFTypeScaleX',1.4],['KFTypePositionX',.1],['KFTypePositionY',-.2]]) {
    assert.equal(value(s,p,92.4,fallback),value(frame,p,1.2,fallback));
  }
  assert.equal(other.common_keyframes,undefined);
  opScaleKeyframe(d,{selector:{id:s.id},clear:true});
  delete frame.screen_recording_id; frame.screenRecordingId='owner';
  frame.uniform_scale={on:false}; frame.clip.scale.y=.6;
  frame.common_keyframes=[channel('KFTypeScaleX',[[0,.8],[10,.8]])];
  opScaleKeyframe(d,{selector:{id:s.id},at:1,to:.85,hold:1});
  assert.ok(Math.abs(value(frame,'KFTypeScaleY',1.2)-.6375)<1e-9);
  d.materials.speeds=[{id:'speed',curve_speed:{points:[1,2]}}]; s.extra_material_refs=['speed'];
  assert.throws(() => opScaleKeyframe(d,{selector:{id:s.id},at:1}),{code:'MOTION_SPEED_CURVE'});
  assert.throws(() => opScaleKeyframe(doc(clip('hidden',{clip:{alpha:0}})),{selector:{id:'hidden'},at:1}),{code:'MOTION_HIDDEN'});
});
