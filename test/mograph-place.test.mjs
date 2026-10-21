import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import crypto from 'node:crypto';

import { applySpec, readJson } from '../src/core.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { normalizePlan, runBuild } from '../src/build.mjs';
import { placementFor, safeZoneAdvice, safeZoneViolations } from '../src/mograph-geometry.mjs';
import { anchoredStart, liveMographStart, opMographPlace } from '../src/mograph-place.mjs';
import { opRipple } from '../src/ripple.mjs';
import { loadProfile } from '../src/profile.mjs';
import { buildProject } from './helpers/polish-project.mjs';
import { stubMograph } from './helpers/mograph-stub.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function project() {
  const dir = buildProject();
  fs.mkdirSync(path.join(dir, 'mograph'), { recursive: true });
  const mov = path.join(dir, 'mograph', 'kw.mov');
  fs.writeFileSync(mov, 'prores-bytes');
  const png = path.join(dir, 'mograph', 'chip.png');
  fs.writeFileSync(png, PNG);
  return { dir, mov, png };
}

const doc = dir => readJson(path.join(dir, 'draft_info.json'));
const place = (extra = {}) => ({
  op: 'mograph.place', id: 'kw-1', template: 'keyword-super', format: 'prores',
  at: 2, duration: 1.5, box: { x: 205, y: 1212, w: 582, h: 188 }, sfx: 'pop', fingerprint: 'abc', ...extra,
});

test('placementFor maps a canvas box to CapCut clip scale and half-canvas transform', () => {
  const geo = placementFor({ x: 0, y: 0, w: 1080, h: 1920 });
  assert.equal(geo.scale, 1);
  assert.deepEqual([geo.x, geo.y], [0, 0]);
  // A box in the lower band: fitted to the canvas width at scale 1, so it must shrink to its own size.
  const band = placementFor({ x: 205, y: 1212, w: 582, h: 188 });
  assert.ok(Math.abs(band.scale - 582 / 1080) < 1e-9);
  assert.ok(Math.abs(band.x - ((205 + 291) - 540) / 540) < 1e-9);
  assert.ok(Math.abs(band.y - -((1212 + 94) - 960) / 960) < 1e-9, 'y is positive UP');
  // A 2x render displays at the same size.
  assert.ok(Math.abs(placementFor({ x: 205, y: 1212, w: 582, h: 188 }, undefined, 2).scale - band.scale) < 1e-9);
});

test('safe zones flag the platform UI bands', () => {
  assert.deepEqual(safeZoneViolations({ x: 100, y: 1180, w: 600, h: 200 }), []);
  assert.deepEqual(safeZoneViolations({ x: 100, y: 100, w: 600, h: 200 }), ['top-bar']);
  assert.ok(safeZoneViolations({ x: 900, y: 1400, w: 150, h: 200 }).includes('bottom-ui'));
});

test('mograph.place puts a generated clip on a top lane with exact geometry, and replaces itself', () => {
  const { dir } = project();
  const mov = path.join(dir, 'mograph', 'kw.mov');
  applySpec(dir, { version: 1, operations: [place({ file: mov })] });
  let d = doc(dir);
  const lanes = d.tracks.filter(t => /^mograph-\d+$/.test(t.name || ''));
  assert.equal(lanes.length, 1);
  assert.equal(d.tracks.indexOf(lanes[0]), d.tracks.filter(t => t.type === 'video').length - 1 + d.tracks.slice(0, d.tracks.indexOf(lanes[0])).filter(t => t.type !== 'video').length,
    'the graphic lane is the topmost video track');
  const seg = lanes[0].segments[0];
  assert.equal(seg.desc, 'mograph:kw-1');
  assert.equal(seg.target_timerange.start, 2_000_000);
  assert.equal(seg.volume, 0);
  assert.ok(Math.abs(seg.clip.scale.x - 582 / 1080) < 1e-9);
  const material = d.materials.videos.find(m => m.id === seg.material_id);
  assert.equal(material.capcutctl_mograph.importVerified, false);
  assert.equal(material.width, 582);

  // Placing the same id again replaces it; the root and timeline mirrors stay in step.
  applySpec(dir, { version: 1, operations: [place({ file: mov, at: 3 })] });
  d = doc(dir);
  const all = d.tracks.flatMap(t => t.segments || []).filter(s => s.desc === 'mograph:kw-1');
  assert.equal(all.length, 1);
  assert.equal(all[0].target_timerange.start, 3_000_000);
  const timeline = readJson(path.join(dir, 'Timelines', 'TIMELINE-ONE', 'draft_info.json'));
  assert.deepEqual(timeline.tracks.find(t => t.name === 'mograph-1').segments.map(s => s.id), all.map(s => s.id));
});

test('overlapping graphics open a second lane; a png-still becomes an eased native photo clip', () => {
  const { dir, mov, png } = project();
  applySpec(dir, { version: 1, operations: [
    place({ file: mov }),
    place({ id: 'chip-1', template: 'brand-chip', format: 'png-still', file: png, at: 2.5, duration: 2, box: { x: 300, y: 1200, w: 400, h: 120 } }),
  ] });
  const d = doc(dir);
  assert.deepEqual(d.tracks.filter(t => /^mograph-\d+$/.test(t.name || '')).map(t => t.name).sort(), ['mograph-1', 'mograph-2']);
  const still = d.tracks.flatMap(t => t.segments || []).find(s => s.desc === 'mograph:chip-1');
  const scaleKeys = still.common_keyframes.find(k => k.property_type === 'KFTypeScaleX');
  assert.ok(scaleKeys.keyframe_list.length >= 3, 'pop overshoots and settles');
  assert.ok(scaleKeys.keyframe_list.some(k => k.curveType !== 'Line'), 'entrance is eased, never linear');
  assert.equal(d.materials.videos.find(m => m.id === still.material_id).type, 'photo');
});

test('an unchanged placement is byte-identical on re-apply (stable ids)', () => {
  const { dir, mov } = project();
  applySpec(dir, { version: 1, operations: [place({ file: mov })] });
  const first = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  applySpec(dir, { version: 1, operations: [place({ file: mov })] });
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), first);
});

test('webm is refused for placement', () => {
  const { dir, mov } = project();
  assert.throws(() => applySpec(dir, { version: 1, operations: [place({ file: mov, format: 'webm' })] }), /cannot be placed/);
});

test('safeZoneAdvice gives the overlap in px and the smallest move that clears every zone', () => {
  const box = { x: 100, y: 100, w: 600, h: 200 };
  const advice = safeZoneAdvice(box);
  assert.deepEqual(advice.hits.map(h => h.name), ['top-bar']);
  const top = advice.hits[0];
  assert.equal(top.overlapY, 120, 'y 100–300 against a 220 px top bar');
  assert.equal(top.overlapX, 600);
  assert.deepEqual(top.zone, { x: 0, y: 0, w: 1080, h: 220 });
  assert.ok(advice.suggestCenter, 'a single move clears it');
  const [cx, cy] = advice.suggestCenter;
  const moved = { x: cx - box.w / 2, y: cy - box.h / 2, w: box.w, h: box.h };
  assert.deepEqual(safeZoneViolations(moved), [], `the suggested centre ${advice.suggestCenter} is clear`);
  assert.equal(advice.shift.y, 120, 'down by exactly the overlap');
  // Nothing to move inside the safe band; nothing a single move can fix for the whole canvas.
  assert.deepEqual(safeZoneAdvice({ x: 100, y: 1180, w: 600, h: 200 }).hits, []);
  assert.equal(safeZoneAdvice({ x: 0, y: 0, w: 1080, h: 1920 }).suggestCenter, null);
});

test('liveMographStart reads where a graphic sits now; anchoredStart leads a template, not a scene', () => {
  const { dir, mov } = project();
  const d = doc(dir);
  opMographPlace(d, place({ file: mov }), { projectDir: dir });
  assert.equal(liveMographStart(d, 'kw-1'), 2);
  opRipple(d, { from: 0.5, to: 1.0 }, { projectDir: dir });
  assert.equal(liveMographStart(d, 'kw-1'), 1.5, 'a ripple moved it; the sidecar does not know');
  assert.equal(liveMographStart(d, 'nope'), null);

  const profile = loadProfile();
  assert.equal(anchoredStart({ at: 5 }, { scene: true, profile }), 5, 'a scene is a cut on its word');
  assert.ok(Math.abs(anchoredStart({ at: 5 }, { profile }) - 4.9) < 1e-9, 'a template leads its word by 3 frames');
  assert.equal(anchoredStart({ at: 0.05 }, { profile }), 0, 'never before 0');
});

test('mograph.place refuses a draft whose canvas is not the one the graphic was rendered for', () => {
  const { dir, mov } = project();
  const d = doc(dir);
  d.canvas_config = { ...d.canvas_config, width: 2160, height: 3840 };
  const before = JSON.stringify(d);
  assert.throws(() => opMographPlace(d, place({ file: mov }), { projectDir: dir }),
    error => error.code === 'MOGRAPH_CANVAS' && error.exitCode === 2 && /2160×3840/.test(error.message));
  assert.equal(JSON.stringify(d), before, 'the draft is untouched');
  // No canvas_config: falls back to the 1080×1920 arithmetic, at scale 1 for a full-canvas box.
  delete d.canvas_config;
  const out = opMographPlace(d, place({ file: mov, box: { x: 0, y: 0, w: 1080, h: 1920 } }), { projectDir: dir });
  assert.equal(out.scale, 1);
});

/** `capcutctl …` against a project, its JSON output parsed. */
async function cli(argv, dependencies) {
  let out = '';
  const restore = setOutput(chunk => { out += String(chunk); return true; });
  try { await main([...argv, '--force-running', '--no-backup'], dependencies); } finally { restore(); }
  return out.trim() ? JSON.parse(out) : null;
}
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const placedFile = (dir, id) => {
  const d = doc(dir);
  const segment = d.tracks.flatMap(t => t.segments || []).find(s => s.desc === `mograph:${id}`);
  return d.materials.videos.find(m => m.id === segment.material_id).path;
};

test('a rerender renders to a new fingerprinted file; an unsafe one leaves the placed bytes alone', async () => {
  const dir = buildProject();
  const mograph = stubMograph();
  await cli(['mograph', 'add', '--project', dir, '--template', 'keyword-super', '--id', 'g1', '--at', '2',
    '--params', JSON.stringify({ text: 'one' })], { mograph });
  const first = placedFile(dir, 'g1');
  assert.match(path.basename(first), /^g1-[0-9a-f]{16}\.mov$/, 'named by its fingerprint');
  const bytes = sha(first);
  assert.equal(readJson(path.join(dir, 'mograph', 'g1.json')).file, first);

  // An unsafe box: refused with numbers, before anything is written, and the draft still plays the original.
  await assert.rejects(cli(['mograph', 'rerender', '--project', dir, '--id', 'g1',
    '--params', JSON.stringify({ text: 'two', testBox: [100, 100, 600, 200] })], { mograph }),
  error => error.code === 'MOGRAPH_SAFE_ZONE' && /top-bar/.test(error.message) && /by 600×120px/.test(error.message)
    && /params\.center \[/.test(error.message));
  assert.equal(placedFile(dir, 'g1'), first);
  assert.equal(sha(first), bytes, 'the placed file was not overwritten');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mograph')).filter(f => f.endsWith('.mov')), [path.basename(first)],
    'the refused render wrote nothing');

  // A safe rerender: a new file, and the sidecar names it.
  await cli(['mograph', 'rerender', '--project', dir, '--id', 'g1', '--params', JSON.stringify({ text: 'two' })], { mograph });
  const second = placedFile(dir, 'g1');
  assert.notEqual(second, first);
  assert.match(path.basename(second), /^g1-[0-9a-f]{16}\.mov$/);
  assert.equal(readJson(path.join(dir, 'mograph', 'g1.json')).file, second);
  assert.equal(sha(first), bytes, 'the old render is still intact for a restore');
});

test('a rerender keeps the graphic where it sits now and says it moved', async () => {
  const dir = buildProject();
  const mograph = stubMograph();
  await cli(['mograph', 'add', '--project', dir, '--template', 'keyword-super', '--id', 'g1', '--at', '2',
    '--params', JSON.stringify({ text: 'one' })], { mograph });
  applySpec(dir, { version: 1, operations: [{ op: 'timeline.ripple', from: 0.5, to: 1 }] }, { forceRunning: true, backup: false });
  assert.equal(liveMographStart(doc(dir), 'g1'), 1.5);
  const out = await cli(['mograph', 'rerender', '--project', dir, '--id', 'g1', '--params', JSON.stringify({ text: 'two' })], { mograph });
  assert.deepEqual(out.moved, { from: 2, to: 1.5 });
  assert.equal(liveMographStart(doc(dir), 'g1'), 1.5, 'not back at the sidecar time');
  assert.equal(readJson(path.join(dir, 'mograph', 'g1.json')).at, 1.5);
});

test('a build that refuses a graphic keeps the renders it finished, and reuses them after the fix', async () => {
  const dir = buildProject();
  const mograph = stubMograph();
  const plan = boxB => normalizePlan({
    version: 1, logos: false, layout: false, camera: { stress: false }, sound: { seams: false, loudness: false, music: false },
    graphics: [
      { id: 'A', template: 'keyword-super', at: 1, params: { text: 'a' } },
      { id: 'B', template: 'keyword-super', at: 3, params: { text: 'b', testBox: boxB } },
    ],
  });
  await assert.rejects(runBuild(dir, plan([100, 100, 600, 200]), { forceRunning: true, backup: false, renderers: { mograph } }),
    error => error.code === 'MOGRAPH_SAFE_ZONE' && /^B /.test(error.message) && /overlaps top-bar/.test(error.message));
  const files = fs.readdirSync(path.join(dir, 'mograph'));
  assert.ok(!files.some(f => f.startsWith('B-')), 'the refused graphic was never encoded');
  const cacheA = readJson(path.join(dir, 'mograph', '.render', 'A.json'));
  assert.ok(fs.existsSync(cacheA.file), 'A finished and is cached');
  assert.equal(mograph.calls.length, 2);

  const fixed = await runBuild(dir, plan([205, 1212, 582, 188]), { forceRunning: true, backup: false, renderers: { mograph } });
  const planned = Object.fromEntries(fixed.stages.graphics.planned.map(g => [g.id, g]));
  assert.equal(planned.A.cached, true, 'A came from the render cache');
  assert.equal(planned.B.cached, false);
  assert.equal(mograph.calls.length, 3, 'only B rendered again');
});
