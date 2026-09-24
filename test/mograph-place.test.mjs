import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { applySpec, readJson } from '../src/core.mjs';
import { placementFor, safeZoneViolations } from '../src/mograph-geometry.mjs';
import { buildProject } from './helpers/polish-project.mjs';

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
