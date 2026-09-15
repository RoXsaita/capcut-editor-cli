import test from 'node:test';
import assert from 'node:assert/strict';
import { opScaleKeyframe } from '../src/add.mjs';
import { applyFreeCurve, FREE_CURVE_HANDLES, freeCurveControls } from '../src/easing.mjs';
import { opPunch } from '../src/punch.mjs';

const U = x => Math.round(x * 1e6);
const clip = (id, extra = {}) => ({ id, material_id: 'video', extra_material_refs: [],
  source_timerange: { start: U(90), duration: U(20) },
  target_timerange: { start: 0, duration: U(10) },
  clip: { scale: { x: 1.4, y: 1.4 }, transform: { x: .1, y: -.2 }, alpha: 1 }, ...extra });
const doc = segment => ({ canvas_config: { width: 1080, height: 1920 },
  materials: { videos: [{ id: 'video', width: 1920, height: 1080 }], common_mask: [] },
  tracks: [{ type: 'video', flag: 2, segments: [segment] }] });

const publish = { text: 'Publish', conf: 0.9, x: 0.40, y: 0.80, w: 0.12, h: 0.05 };

test('Line remains the default; control objects on Line do not mean easing', () => {
  const s = clip('face');
  opScaleKeyframe(doc(s), { selector: { id: s.id }, at: 2, ramp: 0.25, hold: 1 });
  const keys = s.common_keyframes.find(k => k.property_type === 'KFTypeScaleX').keyframe_list;
  assert.ok(keys.every(k => k.curveType === 'Line'));
  assert.ok(keys.every(k => k.left_control && k.right_control),
    'CapCut writes control objects on Line points too — test curveType, not presence');
  assert.ok(keys.every(k => k.left_control.x === 0 && k.right_control.x === 0));
});

test('--ease writes FreeCurveInOut on ScaleX with harvested handle shape', () => {
  const s = clip('face');
  const result = opScaleKeyframe(doc(s), { selector: { id: s.id }, at: 2, ramp: 0.25, hold: 1, ease: true });
  assert.equal(result.ease, true);
  assert.equal(result.easePosition, false);
  const keys = s.common_keyframes.find(k => k.property_type === 'KFTypeScaleX').keyframe_list;
  assert.ok(keys.every(k => k.curveType === 'FreeCurveInOut'));
  const first = keys[0], second = keys[1];
  const span = second.time_offset - first.time_offset;
  const dv = second.values[0] - first.values[0];
  assert.equal(first.right_control.x, Math.round(FREE_CURVE_HANDLES.outX * span));
  assert.ok(Math.abs(first.right_control.y - FREE_CURVE_HANDLES.outY * dv) < 1e-9);
  assert.equal(second.left_control.x, Math.round(FREE_CURVE_HANDLES.inX * span));
});

test('--ease leaves PositionX/Y as Line; --ease-position writes the native round-tripped curve', () => {
  const s = clip('screen');
  opScaleKeyframe(doc(s), {
    selector: { id: s.id }, at: 1, hold: 1, ease: true,
    focus: [600, 60, 300, 200],
  });
  const pos = s.common_keyframes.find(k => k.property_type === 'KFTypePositionX').keyframe_list;
  const scale = s.common_keyframes.find(k => k.property_type === 'KFTypeScaleX').keyframe_list;
  assert.ok(scale.every(k => k.curveType === 'FreeCurveInOut'));
  assert.ok(pos.every(k => k.curveType === 'Line'));

  const s2 = clip('screen2');
  const result = opScaleKeyframe(doc(s2), {
    selector: { id: s2.id }, at: 1, hold: 1, ease: true, easePosition: true,
    focus: [600, 60, 300, 200],
  });
  const pos2 = s2.common_keyframes.find(k => k.property_type === 'KFTypePositionX').keyframe_list;
  assert.ok(pos2.every(k => k.curveType === 'FreeCurveInOut'));
  assert.equal(result.verifiedIn, 'CapCut 9.4.0');
  assert.equal(result.unverified, undefined);
  assert.ok(pos2.every(k => k.graphID === ''));
});

test('applyFreeCurve matches freeCurveControls on neighbouring legs', () => {
  const list = [
    { time_offset: 0, values: [1], left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 } },
    { time_offset: 200_000, values: [1.6], left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 } },
  ];
  const eased = applyFreeCurve(list);
  const expected = freeCurveControls({
    outSpan: 200_000, inSpan: 0, outDv: 0.6, inDv: 0,
  });
  assert.equal(eased[0].curveType, 'FreeCurveInOut');
  assert.equal(eased[0].right_control.x, expected.right_control.x);
  assert.ok(Math.abs(eased[0].right_control.y - expected.right_control.y) < 1e-9);
});

test('punch --ease eases scale and keeps position Line', () => {
  const segment = {
    id: 'b0', material_id: 'FILE', desc: 'broll: screen',
    source_timerange: { start: 0, duration: U(10) },
    target_timerange: { start: 0, duration: U(10) },
    extra_material_refs: [],
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, alpha: 1 },
  };
  const d = {
    canvas_config: { width: 1080, height: 1920 },
    materials: { videos: [{ id: 'FILE', type: 'video', path: '/tmp/capcutctl-ease.mp4', width: 1920, height: 1080 }] },
    tracks: [{ type: 'video', flag: 2, segments: [segment] }],
  };
  opPunch(d, {
    segment: 'b0', on: 'Publish', at: 5, kind: 'click', zoom: 1.6, ramp: 0.2, hold: 1,
    ease: true, boxes: [publish], clicks: [], moments: [], __seed: 'ease-punch',
  });
  const scale = segment.common_keyframes.find(k => k.property_type === 'KFTypeScaleX').keyframe_list;
  const pos = segment.common_keyframes.find(k => k.property_type === 'KFTypePositionX').keyframe_list;
  assert.ok(scale.every(k => k.curveType === 'FreeCurveInOut'));
  assert.ok(pos.every(k => k.curveType === 'Line'));
});
