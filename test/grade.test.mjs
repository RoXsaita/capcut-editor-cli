import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  applyAdjust, gradeBuffer, scope, solveGrade, planGrade, measureSources, opGradeApply, opGradeReset, opGradeLayer,
  resolveGradeSource, resolveMediaPath, ROLE_TARGETS
} from '../src/grade.mjs';

const US = s => Math.round(s * 1e6);
const SLIDERS = ['brightness', 'contrast', 'saturation', 'highlight', 'shadow', 'white', 'black', 'temperature', 'tone'];

test('native adjustment lane updates without duplication and resets only owned materials', () => {
  const d = doc();
  const op = { name: 'Finish', from: 1, to: 3, strength: 0.5, sliders: { contrast: 0.2 } };
  const before = structuredClone(d);
  assert.throws(() => opGradeLayer(d, { ...op, to: 99 }), { code: 'BAD_LAYER_RANGE' });
  assert.deepEqual(d, before);
  opGradeLayer(d, op);
  const layer = d.tracks.at(-1);
  assert.equal(layer.type, 'adjust');
  assert.equal(layer.segments[0].source_timerange, null);
  assert.equal(layer.segments[0].extra_material_refs.length, 1);
  assert.equal(d.materials.effects.at(-1).value, 0.1);
  opGradeLayer(d, op);
  assert.equal(d.tracks.filter(t => t.type === 'adjust').length, 1);
  assert.equal(d.materials.effects.length, 1);
  assert.equal(layer.segments[0].extra_material_refs.length, 1);
  layer.segments[0].extra_material_refs.push('foreign');
  const manual = structuredClone(d);
  assert.throws(() => opGradeLayer(d, { name: 'Finish', reset: true }), { code: 'LAYER_MANUAL_EDITS' });
  assert.deepEqual(d, manual);
  layer.segments[0].extra_material_refs.pop();
  opGradeLayer(d, { name: 'Finish', reset: true });
  assert.equal(d.tracks.length, before.tracks.length);
  assert.equal(d.materials.effects.length, 0);
  assert.equal(d.materials.placeholders.length, 0);
});

function solidVideo(dir, name, color) {
  const file = path.join(dir, name);
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=32x32:r=2:d=1`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file,
  ], { stdio: 'ignore' });
  return file;
}

function clip(id, materialId, start = 0) {
  return {
    id, material_id: materialId,
    target_timerange: { start: US(start), duration: US(1) },
    source_timerange: { start: 0, duration: US(1) },
    extra_material_refs: [],
  };
}

function sourceDoc(materials) {
  return {
    duration: US(1), materials: { videos: materials, effects: [] },
    tracks: materials.map((material, i) => ({
      type: 'video', flag: 2, name: `source-${i}`, segments: [clip(`clip-${i}`, material.id)],
    })),
  };
}

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

test('automatic grading leaves light and dark screen sources unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-grade-'));
  const d = sourceDoc([
    { id: 'LIGHT', type: 'video', path: solidVideo(dir, 'light.mp4', 'white') },
    { id: 'DARK', type: 'video', path: solidVideo(dir, 'dark.mp4', 'black') },
  ]);
  const plan = planGrade(d, dir);
  assert.equal(plan.automatic, false);
  assert.match(plan.reason, /No explicit target or reference/);
  assert.equal(plan.sources.length, 2);
  for (const row of plan.sources) {
    assert.deepEqual(row.sliders, {});
    assert.deepEqual(row.after, row.before);
    assert.match(row.reason, /preserving source appearance/);
  }
});

test('an explicit in-project reference uses its measured scope and leaves an acceptable face alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-grade-'));
  fs.mkdirSync(path.join(dir, 'refs'));
  const face = solidVideo(dir, 'face.mp4', 'sienna');
  fs.copyFileSync(face, path.join(dir, 'refs/reference.mp4'));
  const d = sourceDoc([{ id: 'FACE', type: 'video', path: face }]);
  const plan = planGrade(d, dir, { reference: 'face.mp4' });
  const row = resolveGradeSource(plan, 'face.mp4');
  assert.equal(plan.automatic, true);
  assert.equal(row.role, 'face');
  assert.equal(row.target.black, row.before.black);
  assert.equal(row.target.white, row.before.white);
  assert.deepEqual(row.sliders, {});
  assert.deepEqual(row.after, row.before);
  const filePlan = planGrade(d, dir, { reference: 'refs/reference.mp4', referenceAt: 0 });
  assert.equal(filePlan.sources[0].target.black, row.before.black);
  assert.throws(() => planGrade(d, dir, { reference: 'face.mp4', referenceAt: -1 }),
    { code: 'BAD_REFERENCE_TIME' });
  const atFrame = planGrade(d, dir, { reference: 'face.mp4', referenceAt: 0 });
  assert.equal(atFrame.sources[0].target.black, filePlan.sources[0].target.black);
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

test('same-basename sources stay separate and basename selection is explicitly ambiguous', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-grade-'));
  const aDir = path.join(dir, 'a'), bDir = path.join(dir, 'b');
  fs.mkdirSync(aDir); fs.mkdirSync(bDir);
  const a = solidVideo(aDir, 'screen.mp4', 'red');
  const b = solidVideo(bDir, 'screen.mp4', 'blue');
  const d = sourceDoc([
    { id: 'A', type: 'video', path: a, source_take_id: 'take-a' },
    { id: 'B', type: 'video', path: b, source_take_id: 'take-b' },
  ]);
  const rows = measureSources(d, dir);
  assert.deepEqual(rows.map(row => row.source).sort(), ['take-a', 'take-b']);
  assert.throws(() => resolveGradeSource({ sources: rows }, 'screen.mp4'), error => error.code === 'SOURCE_AMBIGUOUS');
  const before = structuredClone(d);
  assert.throws(() => opGradeApply(d, { sources: { 'screen.mp4': { white: 0.2 } } }),
    error => error.code === 'SOURCE_AMBIGUOUS');
  assert.deepEqual(d, before, 'ambiguous selection mutated the draft');
  opGradeApply(d, { __seed: 'identity', sources: { 'take-a': { white: 0.2 } } });
  assert.equal(d.tracks[0].segments[0].extra_material_refs.length, 1);
  assert.equal(d.tracks[1].segments[0].extra_material_refs.length, 0);
});

test('reset removes durable grade effects while retaining foreign corrections', () => {
  const d = doc();
  const foreign = { id: 'foreign-adjust', type: 'brightness', name: 'Manual adjustment', value: 0.1 };
  d.materials.effects.push(foreign);
  d.tracks[0].segments[0].extra_material_refs.splice(1, 0, foreign.id);
  opGradeApply(d, { __seed: 'owned', sources: { 'face.mp4': { white: 0.2 } } });
  const owned = d.materials.effects.find(effect => effect.name?.startsWith('capcutctl:grade:'));
  assert.ok(owned, 'grade effect has no durable native name marker');
  delete owned.capcutctl_owner;

  const result = opGradeReset(d, { sources: ['face.mp4'] });
  assert.equal(result.removed, 1);
  assert.equal(result.materials, 1);
  assert.deepEqual(d.materials.effects, [foreign]);
  const refs = d.tracks[0].segments[0].extra_material_refs;
  assert.ok(refs.includes(foreign.id));
  assert.ok(!refs.includes(owned.id));
  assert.equal(d.tracks[0].segments[0].enable_adjust, true);
});

test('an unknown slider name is refused rather than written as dead JSON', () => {
  const d = doc();
  const before = structuredClone(d);
  assert.throws(() => opGradeApply(d, { op: 'grade.apply', sources: { 'face.mp4': { gamma: 0.4 } } }),
    /Unknown adjust slider "gamma"/);
  assert.deepEqual(d, before, 'invalid input mutated the draft');
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
