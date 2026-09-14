import test from 'node:test';
import assert from 'node:assert/strict';
import { peakUpscale, isFlatPlate, UPSCALE_WARN, UPSCALE_REFUSE } from '../src/crispness.mjs';

const canvas = { width: 1080, height: 1920 };
const source = { width: 1920, height: 1080 };
const US = s => Math.round(s * 1e6);

function segment(scale = 1, keys = null, extra = {}) {
  return {
    id: extra.id || 's',
    desc: extra.desc || 'broll: screen',
    clip: { scale: { x: scale, y: scale } },
    ...(keys ? { common_keyframes: keys } : {}),
    crop: extra.crop,
  };
}

function line(property, values) {
  return {
    property_type: property,
    keyframe_list: values.map(([t, v]) => ({ time_offset: US(t), values: [v], curveType: 'Line' })),
  };
}

test('1920×1080 on a 1080×1920 canvas at scale 5 is 2.81×', () => {
  // min(1080/1920, 1920/1080) * 5 = 0.5625 * 5 = 2.8125
  const result = peakUpscale(segment(5), source, canvas);
  assert.equal(result.exempt, false);
  assert.equal(result.factor, 2.813);
  assert.ok(result.factor > UPSCALE_WARN);
  assert.ok(result.factor > UPSCALE_REFUSE);
});

test('peakUpscale uses the highest Line ScaleX/ScaleY key, not the base', () => {
  const seg = segment(1, [
    line('KFTypeScaleX', [[0, 1], [1, 2.5], [2, 1.2]]),
  ]);
  const result = peakUpscale(seg, source, canvas);
  assert.equal(result.scale, 2.5);
  assert.equal(result.factor, 1.406); // 0.5625 * 2.5
});

test('ScaleY keys are included in the peak', () => {
  const seg = segment(1, [
    line('KFTypeScaleX', [[0, 1], [1, 1.1]]),
    line('KFTypeScaleY', [[0, 1], [1, 3]]),
  ]);
  const result = peakUpscale(seg, source, canvas);
  assert.equal(result.scale, 3);
});

test('a half-width crop doubles the upscale versus the uncropped clip', () => {
  const crop = {
    upper_left_x: 0.25, upper_left_y: 0,
    upper_right_x: 0.75, upper_right_y: 0,
    lower_left_x: 0.25, lower_left_y: 1,
    lower_right_x: 0.75, lower_right_y: 1,
  };
  const full = peakUpscale(segment(1), source, canvas);
  const cropped = peakUpscale(segment(1, null, { crop }), source, canvas, { crop });
  assert.equal(full.factor, 0.563);
  // usedW = 960, fit = min(1080/960, 1920/1080) = 1.125
  assert.equal(cropped.factor, 1.125);
  assert.ok(cropped.factor > full.factor);
});

test('flat plates are exempt, including the indigo seam bar', () => {
  const plate = segment(1.83, null, { desc: 'layout:seam-bar' });
  const material = { type: 'photo', path: '/assets/suheilai-rect-indigo-1080x1920.png' };
  assert.equal(isFlatPlate(plate, material), true);
  const result = peakUpscale(plate, source, canvas, { material });
  assert.equal(result.exempt, true);
  assert.equal(result.factor, 0);
});

test('a screen recording is not a plate', () => {
  const rec = segment(1, null, { desc: 'layout:screen-recording' });
  const material = { type: 'video', path: '/takes/screen.mp4' };
  assert.equal(isFlatPlate(rec, material), false);
  const result = peakUpscale(rec, source, canvas, { material });
  assert.equal(result.exempt, false);
  assert.equal(result.factor, 0.563);
});

test('missing source dimensions are unknown, not a guessed factor', () => {
  const result = peakUpscale(segment(5), null, canvas);
  assert.equal(result.unknown, true);
  assert.equal(result.factor, null);
});
