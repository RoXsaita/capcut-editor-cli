import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchOcrBoxes, pickBox, focusRectForZoom, planPunchTiming, assertNoDoublePunch,
  opPunch, DEFAULT_ZOOM, CLICK_LEAD, CHANGE_HIGH,
} from '../src/punch.mjs';
import { UPSCALE_REFUSE } from '../src/crispness.mjs';
import { cameraValue } from '../src/add.mjs';

const US = s => Math.round(s * 1e6);
const value = (segment, property, t, fallback = 0) => cameraValue(segment, property, US(t), fallback);

function doc({
  srcIn = 0, srcDur = 10, timelineDur = 10, scale = 1, keys = null,
  width = 1920, height = 1080,
} = {}) {
  const segment = {
    id: 'b0', material_id: 'FILE', desc: 'broll: screen',
    source_timerange: { start: US(srcIn), duration: US(srcDur) },
    target_timerange: { start: 0, duration: US(timelineDur) },
    extra_material_refs: [],
    clip: { scale: { x: scale, y: scale }, transform: { x: 0, y: 0 }, alpha: 1 },
    ...(keys ? { common_keyframes: keys } : {}),
  };
  return {
    canvas_config: { width: 1080, height: 1920 },
    materials: {
      videos: [{ id: 'FILE', type: 'video', path: '/tmp/capcutctl-punch-fixture.mp4', width, height }],
    },
    tracks: [{ type: 'video', flag: 2, segments: [segment] }],
  };
}

const publish = { text: 'Publish', conf: 0.9, x: 0.40, y: 0.80, w: 0.12, h: 0.05 };
const otherPublish = { text: 'Publish', conf: 0.88, x: 0.05, y: 0.10, w: 0.10, h: 0.04 };

test('matchOcrBoxes is case-insensitive and fuzzy', () => {
  const boxes = [publish, { text: 'Cancel', conf: 1, x: 0.6, y: 0.8, w: 0.1, h: 0.04 }];
  assert.equal(matchOcrBoxes(boxes, 'publish').length, 1);
  assert.equal(matchOcrBoxes(boxes, 'PUBLISH')[0].text, 'Publish');
  assert.equal(matchOcrBoxes(boxes, 'lish').length, 1);
  assert.equal(matchOcrBoxes(boxes, 'nope').length, 0);
});

test('pickBox refuses ambiguity unless a click is nearer one hit', () => {
  const hits = [publish, otherPublish];
  assert.throws(() => pickBox(hits), { code: 'PUNCH_AMBIGUOUS' });
  try { pickBox(hits); } catch (error) {
    assert.equal(error.details.candidates.length, 2);
  }
  const chosen = pickBox(hits, { nx: 0.46, ny: 0.82 });
  assert.equal(chosen.x, publish.x);
  assert.equal(pickBox([publish]).text, 'Publish');
  assert.throws(() => pickBox([]), { code: 'PUNCH_NOT_FOUND' });
});

test('focusRectForZoom centres 1.6× on the box and stays inside the source', () => {
  const [x, y, w, h] = focusRectForZoom({
    box: publish, sourceW: 1920, sourceH: 1080, canvasW: 1080, canvasH: 1920, zoom: 1.6,
  });
  assert.ok(x >= 0 && y >= 0);
  assert.ok(x + w <= 1920 + 1e-6);
  assert.ok(y + h <= 1080 + 1e-6);
  const cx = x + w / 2, boxCx = (publish.x + publish.w / 2) * 1920;
  // Near the bottom edge the window clamps vertically; horizontally it should still track.
  assert.ok(Math.abs(cx - boxCx) < 80, { cx, boxCx });
});

test('planPunchTiming arrives 250 ms early on a click and holds through the reaction', () => {
  const moments = [{ start: 5.0, end: 5.8, peak: 0.9 }];
  const plan = planPunchTiming({ kind: 'click', eventSource: 5.0, moments, ramp: 0.2, speed: 1 });
  assert.equal(plan.arrive, 5.0 - CLICK_LEAD);
  assert.ok(Math.abs(plan.hold - (5.8 - plan.arrive - 0.2)) < 1e-9);
  assert.equal(plan.shifted, false);
});

test('a result waits for the change to settle before zooming', () => {
  const moments = [{ start: 5.0, end: 5.6, peak: 0.8 }];
  const plan = planPunchTiming({ kind: 'result', eventSource: 5.1, moments, ramp: 0.2 });
  assert.equal(plan.arrive, 5.6);
});

test('a zoom that would start mid-scroll shifts to the next quiet frame', () => {
  const moments = [{ start: 4.6, end: 5.2, peak: CHANGE_HIGH }];
  const plan = planPunchTiming({ kind: 'click', eventSource: 5.0, moments, ramp: 0.2, speed: 1 });
  assert.equal(plan.shifted, true);
  assert.equal(plan.arrive, 5.2);
  assert.equal(plan.shiftedFrom, 5.0 - CLICK_LEAD);
});

test('opPunch writes Line Scale+Position keys timed around the named element', () => {
  const d = doc();
  const out = opPunch(d, {
    segment: 'b0', on: 'Publish', at: 5, kind: 'click', zoom: DEFAULT_ZOOM, ramp: 0.2,
    hold: 'auto', __seed: 'punch-happy',
    boxes: [publish],
    clicks: [{ type: 'click', vt: 5.0, nx: 0.46, ny: 0.82 }],
    moments: [{ start: 5.0, end: 5.8, peak: 0.9 }],
  });
  const seg = d.tracks[0].segments[0];
  const scale = seg.common_keyframes.find(k => k.property_type === 'KFTypeScaleX').keyframe_list;
  const posX = seg.common_keyframes.find(k => k.property_type === 'KFTypePositionX');
  const posY = seg.common_keyframes.find(k => k.property_type === 'KFTypePositionY');
  assert.ok(scale.length >= 4, 'push-hold-release');
  assert.ok(scale.every(k => k.curveType === 'Line'));
  assert.ok(posX && posY, 'focus path writes PositionX/Y');
  assert.equal(scale[0].curveType, 'Line');
  assert.ok(Math.abs(out.arrive - 4.75) < 1e-9);
  assert.ok(Math.abs(value(seg, 'KFTypeScaleX', 4.75) - 1) < 1e-6);
  assert.ok(Math.abs(value(seg, 'KFTypeScaleX', 4.95) - out.to) < 1e-6);
  assert.ok(out.to > 1.4 && out.to < 1.8, out.to);
  assert.ok(out.upscale < UPSCALE_REFUSE);
  assert.equal(out.focus.length, 4);
  assert.equal(out.on, 'Publish');
});

test('ambiguous OCR hits without a click are refused', () => {
  const d = doc();
  assert.throws(() => opPunch(d, {
    segment: 'b0', on: 'Publish', at: 5, boxes: [publish, otherPublish], clicks: [], moments: [],
  }), { code: 'PUNCH_AMBIGUOUS' });
});

test('a zoom that would exceed 2.0× is refused', () => {
  const d = doc({ width: 1080, height: 1920 });
  assert.throws(() => opPunch(d, {
    segment: 'b0', on: 'Publish', at: 5, zoom: 2.2, boxes: [publish], clicks: [], moments: [],
    hold: 1,
  }), { code: 'UPSCALE_REFUSE' });
});

test('a second punch-in without a return to wide is refused', () => {
  const d = doc();
  opPunch(d, {
    segment: 'b0', on: 'Publish', at: 3, zoom: 1.6, boxes: [publish], clicks: [], moments: [],
    hold: 1, ramp: 0.2, __seed: 'first',
  });
  assert.throws(() => opPunch(d, {
    segment: 'b0', on: 'Publish', at: 3.4, zoom: 1.6, boxes: [publish], clicks: [], moments: [],
    hold: 1, ramp: 0.2, __seed: 'second',
  }), { code: 'DOUBLE_PUNCH' });
});

test('assertNoDoublePunch allows a new move after a completed return', () => {
  const segment = {
    clip: { scale: { x: 1, y: 1 } },
    common_keyframes: [{
      property_type: 'KFTypeScaleX',
      keyframe_list: [
        { time_offset: US(1), values: [1], curveType: 'Line' },
        { time_offset: US(1.2), values: [1.6], curveType: 'Line' },
        { time_offset: US(2.8), values: [1.6], curveType: 'Line' },
        { time_offset: US(3.0), values: [1], curveType: 'Line' },
      ],
    }],
  };
  assert.doesNotThrow(() => assertNoDoublePunch(segment, US(5), US(7)));
  assert.throws(() => assertNoDoublePunch(segment, US(1.5), US(2.5)), { code: 'DOUBLE_PUNCH' });
});
