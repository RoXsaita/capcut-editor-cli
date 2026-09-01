import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAdjust, gradeBuffer, scope, solveGrade, opGradeApply, resolveMediaPath, ROLE_TARGETS } from '../src/grade.mjs';

const US = s => Math.round(s * 1e6);
const SLIDERS = ['brightness', 'contrast', 'saturation', 'highlight', 'shadow', 'white', 'black', 'temperature', 'tone'];

/* ---- the forward model ---------------------------------------------------- */

test('every slider is exactly the identity at 0', () => {
  // The whole solver assumes it can start from all-zeros and measure the untouched image.
  // A slider that drifts at 0 makes "no grade" a grade, and every measurement after it lies.
  const px = [0.3, 0.5, 0.7];
  for (const k of SLIDERS) {
    assert.deepEqual(applyAdjust(px, { [k]: 0 }), px, `${k} is not the identity at 0`);
  }
  assert.deepEqual(applyAdjust(px, {}), px);
});

test('temperature moves R-B monotonically, and in the direction the name promises', () => {
  const px = [0.5, 0.45, 0.4];
  const rb = v => { const o = applyAdjust(px, { temperature: v }); return o[0] - o[2]; };
  const series = [-0.4, -0.2, 0, 0.2, 0.4].map(rb);
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i] > series[i - 1], `temperature is not monotone at step ${i}`);
  }
  assert.ok(rb(-0.3) < rb(0), 'negative temperature must cool (lower R-B)');
});

test('saturation -1 is monochrome and +ve raises measured saturation', () => {
  const [r, g, b] = applyAdjust([0.8, 0.3, 0.2], { saturation: -1 });
  assert.ok(Math.abs(r - g) < 1e-6 && Math.abs(g - b) < 1e-6, 'saturation -1 should be grey');
  const buf = Buffer.from([204, 76, 51, 40, 90, 160, 128, 128, 128]);
  assert.ok(scope(gradeBuffer(buf, { saturation: 0.3 })).saturation > scope(buf).saturation);
});

test('black pulls the black point down and white pulls the white point up', () => {
  // The one thing this pass exists to fix: footage that never reaches 0 or 255.
  const buf = Buffer.alloc(300 * 3);
  for (let i = 0; i < 300; i++) {                       // a ramp from 20 to 210 — lifted + short
    const v = Math.round(20 + (190 * i) / 299);
    buf[i * 3] = buf[i * 3 + 1] = buf[i * 3 + 2] = v;
  }
  const before = scope(buf);
  const after = scope(gradeBuffer(buf, { black: -0.3, white: 0.3 }));
  assert.ok(before.black > 15 && before.white < 215, 'fixture should start lifted and short');
  assert.ok(after.black < before.black - 8, `black point did not fall: ${before.black} -> ${after.black}`);
  assert.ok(after.white > before.white + 8, `white point did not rise: ${before.white} -> ${after.white}`);
});

test('nothing escapes 0..255', () => {
  for (const g of [{ brightness: 1 }, { brightness: -1 }, { contrast: 1 }, { white: 1, black: -1 },
                   { saturation: 1, temperature: 1 }, { highlight: 1, shadow: 1 }]) {
    for (const px of [[0, 0, 0], [1, 1, 1], [0.5, 0.2, 0.9]]) {
      for (const v of applyAdjust(px, g)) {
        assert.ok(v >= 0 && v <= 1 && Number.isFinite(v), `${JSON.stringify(g)} produced ${v}`);
      }
    }
  }
});

/* ---- the solver ----------------------------------------------------------- */

test('the solver leaves a source that already hits the target nearly alone', () => {
  // Regularisation earns its keep here: a 3s clip that is already right should not get a
  // 0.4 slider chasing the last two points of a target.
  const buf = Buffer.alloc(400 * 3);
  for (let i = 0; i < 400; i++) {                       // a full-range ramp with some colour in it
    const v = Math.round(3 + (238 * i) / 399);
    buf[i * 3] = Math.min(255, v + 14); buf[i * 3 + 1] = v; buf[i * 3 + 2] = Math.max(0, v - 14);
  }
  // saturationIsCeiling is how planGrade always calls this for a screen: pulling a muted
  // source UP to the target would be inventing colour the recording does not contain.
  const { sliders } = solveGrade(buf, { ...ROLE_TARGETS.screen, warmth: null },
                                 { saturationIsCeiling: true });
  const biggest = Math.max(...Object.values(sliders).map(Math.abs));
  assert.ok(biggest <= 0.2, `expected a near-null grade, got ${JSON.stringify(sliders)}`);
});

test('the solver never desaturates a face when told not to', () => {
  const buf = Buffer.alloc(300 * 3);
  for (let i = 0; i < 300; i++) {                       // warm, flat, lifted — the fixture is the problem
    buf[i * 3] = Math.round(60 + (150 * i) / 299);
    buf[i * 3 + 1] = Math.round(45 + (130 * i) / 299);
    buf[i * 3 + 2] = Math.round(30 + (110 * i) / 299);
  }
  const { sliders } = solveGrade(buf, ROLE_TARGETS.face, { bounds: { saturation: [0, 0.4] } });
  assert.ok(sliders.saturation >= 0, `face was desaturated: ${sliders.saturation}`);
});

/* ---- the write ------------------------------------------------------------ */

function doc() {
  const seg = (id, materialId, refs = []) => ({
    id, material_id: materialId,
    target_timerange: { start: 0, duration: US(4) },
    source_timerange: { start: 0, duration: US(4) },
    extra_material_refs: ['sp1', ...refs, 'canvas1'],
  });
  return {
    duration: US(4),
    materials: {
      videos: [{ id: 'FACE', type: 'video', path: '/m/face.mp4' },
               { id: 'SCREEN', type: 'video', path: '/m/screen.mp4' },
               { id: 'PLATE', type: 'photo', path: '/m/bar.png' }],
      canvases: [{ id: 'canvas1', type: 'canvas_color' }],
      speeds: [{ id: 'sp1', type: 'speed', speed: 1 }],
      effects: [],
    },
    tracks: [
      { type: 'video', flag: 2, segments: [seg('a', 'FACE'), seg('c', 'PLATE')] },
      { type: 'video', flag: 2, segments: [seg('b', 'SCREEN')] },
    ],
  };
}

test('grade.apply writes one effects material per non-zero slider and refs it', () => {
  const d = doc();
  const r = opGradeApply(d, { op: 'grade.apply', __seed: 'seed',
    sources: { 'face.mp4': { black: -0.2, white: 0.3, contrast: 0 } } });
  assert.equal(r.changed, 1);
  assert.equal(r.materials, 2, 'a zero slider must not become a material');
  const types = d.materials.effects.map(e => e.type).sort();
  assert.deepEqual(types, ['black', 'white']);
  const face = d.tracks[0].segments[0];
  for (const e of d.materials.effects) assert.ok(face.extra_material_refs.includes(e.id));
  assert.equal(face.enable_adjust, true);
  // the adjust refs sit before canvas_color, where CapCut puts its own
  const at = face.extra_material_refs.indexOf('canvas1');
  assert.ok(face.extra_material_refs.slice(0, at).includes(d.materials.effects[0].id));
});

test('a still plate carries no grade even when it shares a track with graded video', () => {
  const d = doc();
  opGradeApply(d, { op: 'grade.apply', __seed: 's', sources: { 'bar.png': { white: 0.3 } } });
  assert.equal(d.materials.effects.length, 0, 'photos are not graded');
});

test('re-running replaces its own materials instead of stacking them', () => {
  const d = doc();
  const op = { op: 'grade.apply', __seed: 's', sources: { 'face.mp4': { black: -0.2, white: 0.3 } } };
  opGradeApply(d, { ...op });
  const first = d.materials.effects.length;
  const r = opGradeApply(d, { ...op, sources: { 'face.mp4': { black: -0.1 } } });
  assert.equal(r.replaced, first);
  assert.equal(d.materials.effects.length, 1, 'second run stacked instead of replacing');
  assert.equal(d.materials.effects[0].value, -0.1);
  const refs = d.tracks[0].segments[0].extra_material_refs;
  assert.equal(new Set(refs).size, refs.length, 'stale refs left behind');
});

test('an unknown slider name is refused rather than written as dead JSON', () => {
  assert.throws(() => opGradeApply(doc(), { op: 'grade.apply', sources: { 'face.mp4': { gamma: 0.4 } } }),
    /Unknown adjust slider "gamma"/);
});

test('the same seed produces the same ids, so the mirrors cannot drift', () => {
  const a = doc(), b = doc();
  const op = { op: 'grade.apply', __seed: 'fixed', sources: { 'screen.mp4': { white: 0.4 } } };
  opGradeApply(a, { ...op });
  opGradeApply(b, { ...op });
  assert.deepEqual(a.materials.effects.map(e => e.id), b.materials.effects.map(e => e.id));
});

test('draft-relative media paths resolve to the file on disk', () => {
  assert.equal(
    resolveMediaPath('##_draftpath_placeholder_ABC_##/Resources/CapcutctlMedia/x.mp4', '/p/proj'),
    '/p/proj/Resources/CapcutctlMedia/x.mp4');
  assert.equal(resolveMediaPath('/abs/x.mp4', '/p/proj'), '/abs/x.mp4');
  assert.equal(resolveMediaPath('', '/p/proj'), null);
});
