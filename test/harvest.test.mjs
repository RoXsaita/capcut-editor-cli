import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stableJson } from '../src/core.mjs';
import { defaultSources, harvestDrafts, writeHarvest } from '../src/harvest.mjs';

test('harvest catalogues transitions, fades and a Position+Scale block from a fake draft root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-harvest-'));
  const project = path.join(root, 'IKEA Refund');
  fs.mkdirSync(project, { recursive: true });
  const doc = {
    id: 'TL', duration: 5_000_000,
    materials: {
      transitions: [{ id: 'TR', name: 'Horizontal Triptych' }],
      audios: [{ id: 'AU', name: 'Woosh' }],
      common_mask: [{ id: 'MK', name: 'Split' }],
      audio_fades: [{ id: 'FD', type: 'audio_fade', fade_type: 0, fade_in_duration: 80_000, fade_out_duration: 120_000 }],
      videos: [{ id: 'V', type: 'video', path: '/tmp/x.mp4' }]
    },
    tracks: [{
      type: 'video', flag: 2, segments: [{
        id: 'SEG', material_id: 'V',
        source_timerange: { start: 500_000, duration: 3_000_000 },
        target_timerange: { start: 0, duration: 3_000_000 },
        extra_material_refs: ['FD'],
        common_keyframes: [
          { property_type: 'KFTypePositionX', keyframe_list: [{ time_offset: 500000, values: [0] }, { time_offset: 833333, values: [0.2] }] },
          { property_type: 'KFTypePositionY', keyframe_list: [{ time_offset: 500000, values: [0.7] }, { time_offset: 833333, values: [0.5] }] },
          { property_type: 'KFTypeScaleX', keyframe_list: [{ time_offset: 500000, values: [1] }, { time_offset: 833333, values: [1.8] }] }
        ]
      }]
    }]
  };
  fs.writeFileSync(path.join(project, 'draft_info.json'), stableJson(doc));
  const cat = harvestDrafts(root, ['IKEA Refund']);
  assert.deepEqual(cat.scanned, ['IKEA Refund']);
  assert.equal(cat.transitions[0].name, 'Horizontal Triptych');
  assert.equal(cat.sfx[0].name, 'Woosh');
  assert.equal(cat.masks[0].name, 'Split');
  assert.equal(cat.audioFade.extra.type, 'audio_fade');
  assert.equal(cat.audioFade.extra.fade_in_duration, 80_000);
  assert.equal(cat.positionScale.segmentId, 'SEG');
  assert.ok(cat.positionScale.common_keyframes.some(k => k.property_type === 'KFTypePositionX'));
  assert.ok(cat.positionScale.common_keyframes.some(k => k.property_type === 'KFTypeScaleX'));
  const dest = path.join(root, 'harvest.json');
  writeHarvest(cat, dest);
  assert.ok(fs.existsSync(dest));
});

const minimal = (transition) => ({
  id: 'TL', duration: 1_000_000,
  materials: { transitions: [{ id: 'TR', name: transition }], videos: [] },
  tracks: []
});

test('one unparseable draft is skipped, not fatal — every other draft still catalogues', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-harvest-bad-'));
  for (const [name, body] of [['Bad Draft', '{ this is not json'],
                              ['IKEA Refund', stableJson(minimal('Pull In'))]]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'draft_info.json'), body);
  }
  const cat = harvestDrafts(root, ['Bad Draft', 'IKEA Refund']);
  assert.deepEqual(cat.scanned, ['IKEA Refund']);
  assert.deepEqual(cat.failed.map(f => f.name), ['Bad Draft']);
  assert.equal(cat.transitions[0].name, 'Pull In');
});

test('a corrupt draft under Timelines/ is skipped too — the loader picks it by mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-harvest-tl-'));
  const project = path.join(root, 'IKEA Refund');
  fs.mkdirSync(path.join(project, 'Timelines', 'TL'), { recursive: true });
  fs.writeFileSync(path.join(project, 'draft_info.json'), stableJson(minimal('Pull In')));
  const bad = path.join(project, 'Timelines', 'TL', 'draft_info.json');
  fs.writeFileSync(bad, 'not json either');
  const soon = new Date(Date.now() + 60_000);
  fs.utimesSync(bad, soon, soon);                     // newest by mtime, so it is the one read
  const cat = harvestDrafts(root, ['IKEA Refund']);
  assert.deepEqual(cat.scanned, []);
  assert.deepEqual(cat.failed.map(f => f.name), ['IKEA Refund']);
  assert.deepEqual(cat.missing, []);
});

test('the default source list walks the drafts root, so a brand new draft is visible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-harvest-scan-'));
  for (const name of ['Zulu Draft', 'IKEA Refund', 'Alpha Draft']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'loose.txt'), 'not a draft');
  // the five known names sort first as a preference, then everything else alphabetically
  assert.deepEqual(defaultSources(root), ['IKEA Refund', 'Alpha Draft', 'Zulu Draft']);
  assert.deepEqual(defaultSources(path.join(root, 'nope')).length, 5);
});

test('harvest catalogues a real FreeCurveInOut block alongside the Line one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-harvest-ease-'));
  const kf = (type, curve) => ({ property_type: type, keyframe_list: [
    { time_offset: 0, values: [0], curveType: curve, left_control: { x: 0, y: 0 }, right_control: { x: 0.3, y: 0 } },
    { time_offset: 1_000_000, values: [1], curveType: curve, left_control: { x: 0.7, y: 1 }, right_control: { x: 1, y: 1 } }
  ] });
  // Line points carry left_control/right_control too, so a predicate that keys on those
  // instead of curveType picks the Line block and calls it eased. Keep them in the fixture.
  const line = (type) => ({ property_type: type, keyframe_list: [
    { time_offset: 0, values: [0], curveType: 'Line', left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 } },
    { time_offset: 1_000_000, values: [1], curveType: 'Line', left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 } }
  ] });
  const doc = {
    id: 'TL', duration: 2_000_000, materials: { videos: [] },
    tracks: [{ type: 'video', segments: [
      { id: 'LINE', common_keyframes: [line('KFTypePositionX'), line('KFTypeScaleX')] },
      { id: 'EASED', common_keyframes: [kf('KFTypePositionX', 'FreeCurveInOut'), kf('KFTypeScaleX', 'FreeCurveInOut')] }
    ] }]
  };
  fs.mkdirSync(path.join(root, 'Higgsfield Refund'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Higgsfield Refund', 'draft_info.json'), stableJson(doc));
  const cat = harvestDrafts(root, ['Higgsfield Refund']);
  assert.equal(cat.positionScale.segmentId, 'LINE');            // the existing Line block survives
  assert.equal(cat.positionScaleEased.segmentId, 'EASED');
  assert.ok(cat.positionScaleEased.common_keyframes
    .every(k => k.keyframe_list.every(p => p.curveType === 'FreeCurveInOut' && p.right_control)));
});
