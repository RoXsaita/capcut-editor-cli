import test from 'node:test';
import assert from 'node:assert/strict';
import {
  opGradeApply, faceDetailSliders, FACE_DETAIL_DEFAULTS, FACE_DETAIL_WARNING,
} from '../src/grade.mjs';
import { loadPreset } from '../src/core.mjs';

const US = s => Math.round(s * 1e6);

function detailDoc() {
  const clip = (id, materialId) => ({
    id, material_id: materialId,
    target_timerange: { start: 0, duration: US(4) },
    source_timerange: { start: 0, duration: US(4) },
    extra_material_refs: ['sp1', 'canvas1'],
    desc: id === 'b0' ? 'broll: screen' : 'talking-head',
  });
  return {
    duration: US(4),
    materials: {
      videos: [
        { id: 'FACE', type: 'video', path: '/m/face.mp4' },
        { id: 'SCR', type: 'video', path: '/m/screen.mp4' },
      ],
      canvases: [{ id: 'canvas1', type: 'canvas_color' }],
      speeds: [{ id: 'sp1', type: 'speed', speed: 1 }],
      effects: [],
    },
    tracks: [
      { type: 'video', flag: 0, segments: [] },
      { type: 'video', flag: 2, name: 'broll', segments: [clip('b0', 'SCR')] },
      { type: 'video', flag: 2, name: 'face', segments: [clip('f0', 'FACE')] },
    ],
  };
}

test('faceDetailSliders default to restrained native calibration with vignette off', () => {
  const sliders = faceDetailSliders();
  assert.equal(sliders.sharpen, FACE_DETAIL_DEFAULTS.sharpen);
  assert.equal(sliders.clear, FACE_DETAIL_DEFAULTS.clear);
  assert.equal(sliders.vignetting, FACE_DETAIL_DEFAULTS.vignetting);
  assert.deepEqual(sliders, { sharpen: 0.15, clear: 0.1, vignetting: 0 });
});

test('face-detail writes sharpen v1, clear "", vignetting v1 on FACE only', () => {
  const d = detailDoc();
  const versions = loadPreset('adjust').versions;
  const sliders = faceDetailSliders({ vignette: 0.01 });
  const out = opGradeApply(d, {
    op: 'grade.apply', __seed: 'face-detail',
    sources: { 'face.mp4': sliders },
  });
  assert.equal(out.verifiedIn, 'CapCut 9.4.0');
  assert.equal(out.warning, FACE_DETAIL_WARNING);
  const written = d.materials.effects.filter(effect => FACE_DETAIL_DEFAULTS[effect.type] != null
    || effect.type === 'clear' || effect.type === 'vignetting' || effect.type === 'sharpen');
  const byType = Object.fromEntries(d.materials.effects.map(effect => [effect.type, effect]));
  assert.equal(byType.sharpen.type, 'sharpen');
  assert.equal(byType.sharpen.version, versions.sharpen);
  assert.equal(byType.sharpen.version, 'v1');
  assert.equal(byType.sharpen.value, 0.15);
  assert.equal(byType.clear.type, 'clear');
  assert.equal(byType.clear.version, versions.clear);
  assert.equal(byType.clear.version, '');
  assert.equal(byType.clear.value, 0.1);
  assert.equal(byType.vignetting.type, 'vignetting');
  assert.equal(byType.vignetting.version, versions.vignetting);
  assert.equal(byType.vignetting.version, 'v1');
  assert.equal(byType.vignetting.value, 0.01);
  const faceRefs = d.tracks[2].segments[0].extra_material_refs;
  assert.equal(d.tracks[2].segments[0].enable_adjust, true);
  for (const effect of d.materials.effects) assert.ok(faceRefs.includes(effect.id));
  const brollRefs = d.tracks[1].segments[0].extra_material_refs;
  for (const effect of d.materials.effects) assert.equal(brollRefs.includes(effect.id), false);
  assert.equal(written.length, 3);
});

test('face-detail on a screen recording is refused', () => {
  const d = detailDoc();
  const before = structuredClone(d);
  assert.throws(() => opGradeApply(d, {
    op: 'grade.apply', __seed: 'screen-detail',
    sources: { 'screen.mp4': faceDetailSliders() },
  }), { code: 'SCREEN_FACE_DETAIL' });
  assert.deepEqual(d, before);
});

test('face-detail leaves background helpers using the same face source untouched', () => {
  const d = detailDoc();
  const helper = structuredClone(d.tracks[2].segments[0]);
  helper.id = 'background';
  helper.desc = 'layout:background-blur';
  helper.enable_adjust = true;
  helper.extra_material_refs.push('background-grade');
  d.materials.effects.push({ id: 'background-grade', type: 'brightness', value: 0.2,
    name: 'capcutctl:grade:background:brightness' });
  d.tracks.splice(1, 0, { type: 'video', flag: 2, name: 'layout-screen-background', segments: [helper] });
  const before = structuredClone(helper);
  const out = opGradeApply(d, { sources: { 'face.mp4': faceDetailSliders() } });
  assert.equal(out.changed, 1);
  assert.deepEqual(helper, before);
  assert.ok(d.materials.effects.some(effect => effect.id === 'background-grade'));
  assert.equal(d.materials.effects.filter(effect => ['sharpen', 'clear', 'vignetting'].includes(effect.type)).length, 2);
});

test('a screen-only project cannot receive face-detail', () => {
  const d = detailDoc();
  d.tracks[2].segments = [];
  assert.throws(() => opGradeApply(d, {
    op: 'grade.apply', __seed: 'only-screen',
    sources: { 'screen.mp4': { sharpen: 0.6 } },
  }), { code: 'SCREEN_FACE_DETAIL' });
});
