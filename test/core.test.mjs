import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CapcutError,
  applyOperations,
  applySpec,
  doctor,
  inspectProject,
  listSnapshots,
  readJson,
  restoreProjectSnapshot,
  sha256,
  stableJson,
  syncMirrors
} from '../src/core.mjs';

function fixture({ missingMedia = false, drift = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-test-'));
  const project = path.join(temp, 'Fixture Project');
  const timelineId = 'TIMELINE-ONE';
  const timelineDir = path.join(project, 'Timelines', timelineId);
  fs.mkdirSync(timelineDir, { recursive: true });
  const media = path.join(temp, 'raw-source.mp4');
  fs.writeFileSync(media, 'fixture-media');
  const mask = {
    id: 'MASK-ONE',
    type: 'mask',
    name: 'Circle',
    config: { width: 1, height: 0.56, centerX: 0, centerY: 0, feather: 0, expansion: 0 }
  };
  const doc = {
    id: timelineId,               // real projects: draft_info.id === the timeline id
    name: 'Fixture Project',
    duration: 10_000_000,
    fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [{ id: 'VIDEO-ONE', type: 'video', path: missingMedia ? path.join(temp, 'missing.mp4') : media, duration: 10_000_000, width: 1080, height: 1920 }],
      common_mask: [mask],
      speeds: []
    },
    tracks: [{
      id: 'TRACK-ONE',
      type: 'video',
      segments: [{
        id: 'SEGMENT-ONE',
        material_id: 'VIDEO-ONE',
        extra_material_refs: ['MASK-ONE'],
        enable_video_mask: true,
        source_timerange: { start: 0, duration: 5_000_000 },
        target_timerange: { start: 0, duration: 5_000_000 },
        speed: 1,
        volume: 1,
        clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
      }]
    }]
  };
  const timelineDoc = structuredClone(doc);
  // `id` must equal the timeline id in both documents (CapCut resolves the draft by
  // it), so the documents are told apart by name instead.
  timelineDoc.id = timelineId;
  timelineDoc.name = 'Fixture Project (timeline)';
  const writeGroup = (dir, value) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'draft_info.json'), stableJson(value));
    fs.writeFileSync(path.join(dir, 'draft_info.json.bak'), stableJson(drift ? { ...value, name: 'drifted' } : value));
    fs.writeFileSync(path.join(dir, 'template-2.tmp'), stableJson(value));
  };
  writeGroup(project, doc);
  writeGroup(timelineDir, timelineDoc);
  fs.writeFileSync(path.join(project, 'draft_meta_info.json'), stableJson({ draft_name: 'Fixture Project' }));
  fs.writeFileSync(path.join(project, 'draft_virtual_store.json'), stableJson({ draft_materials: [] }));
  fs.writeFileSync(path.join(project, 'Timelines', 'project.json'), stableJson({ main_timeline_id: timelineId, timelines: [{ id: timelineId }] }));
  return { temp, project, media, timelineDir };
}

test('doctor detects mirror drift and missing media', () => {
  const good = fixture();
  const goodReport = doctor(good.project);
  assert.equal(goodReport.errors, 0);
  assert.ok(goodReport.issues.some(item => item.code === 'MIRROR_DRIFT'));

  const bad = fixture({ missingMedia: true });
  const badReport = doctor(bad.project);
  assert.ok(badReport.errors >= 2);
  assert.ok(badReport.issues.some(item => item.code === 'MISSING_MEDIA'));
});

test('identical CapCut material duplicates warn while conflicting duplicates fail', () => {
  const identical = fixture({ drift: false });
  for (const dir of [identical.project, identical.timelineDir]) {
    const file = path.join(dir, 'draft_info.json');
    const doc = readJson(file);
    doc.materials.videos.push(structuredClone(doc.materials.videos[0]));
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) fs.writeFileSync(path.join(dir, name), stableJson(doc));
  }
  const warning = doctor(identical.project);
  assert.equal(warning.errors, 0);
  assert.ok(warning.issues.some(item => item.code === 'DUPLICATE_MATERIAL_ID'));

  const file = path.join(identical.project, 'draft_info.json');
  const conflicting = readJson(file);
  conflicting.materials.videos.at(-1).duration = 9_000_000;
  fs.writeFileSync(file, stableJson(conflicting));
  const failure = doctor(identical.project);
  assert.ok(failure.issues.some(item => item.code === 'CONFLICTING_MATERIAL_ID'));
});

test('sync repairs each document mirror without flattening root into timeline', () => {
  const fx = fixture();
  const rootName = readJson(path.join(fx.project, 'draft_info.json')).name;
  const timelineName = readJson(path.join(fx.timelineDir, 'draft_info.json')).name;
  assert.notEqual(rootName, timelineName);

  const dry = syncMirrors(fx.project, { dryRun: true, forceRunning: true });
  assert.equal(dry.committed, false);
  assert.deepEqual(new Set(dry.changedGroups), new Set(['root', 'timeline:TIMELINE-ONE']));

  const result = syncMirrors(fx.project, { forceRunning: true });
  assert.equal(result.committed, true);
  for (const dir of [fx.project, fx.timelineDir]) {
    const hashes = ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp'].map(name => sha256(fs.readFileSync(path.join(dir, name))));
    assert.equal(new Set(hashes).size, 1);
  }
  assert.equal(readJson(path.join(fx.project, 'draft_info.json')).name, rootName);
  assert.equal(readJson(path.join(fx.timelineDir, 'draft_info.json')).name, timelineName);
});

test('apply patches native segment/mask, localizes raw media, and clones refs', () => {
  const fx = fixture({ drift: false });
  const replacement = path.join(fx.temp, 'replacement.mov');
  fs.writeFileSync(replacement, 'replacement-media');
  const spec = {
    version: 1,
    name: 'native-edit',
    operations: [
      { op: 'material.relink', selector: { id: 'VIDEO-ONE' }, path: replacement, localize: true },
      { op: 'segment.patch', selector: { id: 'SEGMENT-ONE' }, set: { volume: 0, clip: { scale: { x: 0.8, y: 0.8 } } } },
      { op: 'mask.patch', segment: { id: 'SEGMENT-ONE' }, mask: { name: 'Circle' }, set: { config: { width: 0.5 } } },
      {
        op: 'segment.clone',
        from: { id: 'SEGMENT-ONE' },
        track: { index: 0 },
        target: { start: 5, duration: 2 },
        source: { start: 2, duration: 2 },
        set: { desc: 'clone', volume: 0 }
      }
    ]
  };

  const dry = applySpec(fx.project, spec, { dryRun: true, forceRunning: true });
  assert.equal(dry.committed, false);
  assert.equal(fs.existsSync(path.join(fx.project, 'Resources', 'CapcutctlMedia', 'replacement.mov')), false);

  const result = applySpec(fx.project, spec, { forceRunning: true });
  assert.equal(result.committed, true);
  const clonedIds = [];
  for (const dir of [fx.project, fx.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    const original = doc.tracks[0].segments.find(item => item.id === 'SEGMENT-ONE');
    const copied = doc.tracks[0].segments.find(item => item.desc === 'clone');
    assert.equal(original.volume, 0);
    assert.equal(original.clip.scale.x, 0.8);
    assert.equal(doc.materials.common_mask.find(item => item.id === 'MASK-ONE').config.width, 0.5);
    assert.ok(copied);
    clonedIds.push(copied.id);
    assert.notEqual(copied.id, original.id);
    assert.notEqual(copied.extra_material_refs[0], original.extra_material_refs[0]);
    assert.equal(fs.existsSync(doc.materials.videos[0].path), true);
    assert.match(doc.materials.videos[0].path, /Resources\/CapcutctlMedia\/replacement\.mov$/);
  }
  assert.equal(new Set(clonedIds).size, 1, 'generated segment id must stay stable across root and timeline');
});

test('material and track cloning reuse verified native structures', () => {
  const fx = fixture({ drift: false });
  const replacement = path.join(fx.temp, 'second-raw.mp4');
  fs.writeFileSync(replacement, 'second-raw');
  const result = applySpec(fx.project, {
    version: 1,
    operations: [
      { op: 'material.clone', id: 'VIDEO-TWO', from: { id: 'VIDEO-ONE' }, path: replacement, localize: true, name: 'Second raw source' },
      { op: 'track.clone', id: 'TRACK-TWO', from: { id: 'TRACK-ONE' }, at: 1, set: { name: 'Screen card' } },
      {
        op: 'segment.clone',
        from: { id: 'SEGMENT-ONE' },
        track: { id: 'TRACK-TWO' },
        material: { id: 'VIDEO-TWO' },
        target: { start: 5, duration: 2 },
        source: { start: 1, duration: 2 },
        set: { desc: 'editable raw insert' }
      }
    ]
  }, { forceRunning: true });
  assert.equal(result.committed, true);
  for (const dir of [fx.project, fx.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    const material = doc.materials.videos.find(item => item.id === 'VIDEO-TWO');
    const track = doc.tracks.find(item => item.id === 'TRACK-TWO');
    assert.equal(material.material_name, 'Second raw source');
    assert.match(material.path, /Resources\/CapcutctlMedia\/second-raw\.mp4$/);
    assert.equal(track.segments.length, 1);
    assert.equal(track.segments[0].material_id, 'VIDEO-TWO');
    assert.equal(track.segments[0].desc, 'editable raw insert');
  }
});

test('transaction rollback restores every live document after a partial write', () => {
  const fx = fixture({ drift: false });
  const before = fs.readFileSync(path.join(fx.project, 'draft_info.json'), 'utf8');
  process.env.CAPCUTCTL_FAIL_AFTER_WRITES = '2';
  try {
    assert.throws(
      () => applySpec(fx.project, { version: 1, operations: [{ op: 'segment.patch', selector: { id: 'SEGMENT-ONE' }, set: { volume: 0.25 } }] }, { forceRunning: true }),
      error => error instanceof CapcutError && error.code === 'ROLLED_BACK'
    );
  } finally {
    delete process.env.CAPCUTCTL_FAIL_AFTER_WRITES;
  }
  assert.equal(fs.readFileSync(path.join(fx.project, 'draft_info.json'), 'utf8'), before);
  assert.equal(readJson(path.join(fx.timelineDir, 'draft_info.json')).tracks[0].segments[0].volume, 1);
});

test('history lists snapshots and manual restore preserves a rescue point', () => {
  const fx = fixture({ drift: false });
  const first = applySpec(fx.project, {
    version: 1,
    name: 'volume-change',
    operations: [{ op: 'segment.patch', selector: { id: 'SEGMENT-ONE' }, set: { volume: 0.25 } }]
  }, { forceRunning: true });
  assert.equal(readJson(path.join(fx.project, 'draft_info.json')).tracks[0].segments[0].volume, 0.25);
  const entries = listSnapshots(fx.project);
  assert.ok(entries.some(entry => entry.path === first.snapshot));

  const restored = restoreProjectSnapshot(fx.project, first.snapshot, { forceRunning: true });
  assert.equal(readJson(path.join(fx.project, 'draft_info.json')).tracks[0].segments[0].volume, 1);
  assert.equal(readJson(path.join(fx.timelineDir, 'draft_info.json')).tracks[0].segments[0].volume, 1);
  assert.ok(restored.rescue);
});

test('writes refuse to race CapCut unless explicitly forced', () => {
  const fx = fixture({ drift: false });
  process.env.CAPCUTCTL_ASSUME_RUNNING = '1';
  try {
    assert.throws(
      () => syncMirrors(fx.project),
      error => error instanceof CapcutError && error.code === 'CAPCUT_RUNNING'
    );
    const forced = syncMirrors(fx.project, { forceRunning: true, dryRun: true });
    assert.equal(forced.committed, false);
  } finally {
    delete process.env.CAPCUTCTL_ASSUME_RUNNING;
  }
});

test('inspect reports root and active timeline separately', () => {
  const fx = fixture({ drift: false });
  const inspected = inspectProject(fx.project);
  assert.equal(inspected.activeTimelineId, 'TIMELINE-ONE');
  assert.equal(inspected.groups.length, 2);
  assert.equal(inspected.groups[0].tracks[0].segments, 1);
});

test('segment.clone mints the same extra-material ids in every mirror document', () => {
  const doc = () => ({
    duration: 10_000_000,
    materials: {
      videos: [{ id: 'V', type: 'video', duration: 60_000_000 }],
      canvases: [{ id: 'C', type: 'canvas_color' }],
      speeds: [{ id: 'P', type: 'speed', speed: 1 }]
    },
    tracks: [
      { id: 'T0', type: 'video', flag: 0, segments: [] },
      { id: 'T1', type: 'video', flag: 2, name: 'content', segments: [{
        id: 'S', material_id: 'V', extra_material_refs: ['C', 'P'],
        target_timerange: { start: 0, duration: 2_000_000 },
        source_timerange: { start: 0, duration: 2_000_000 },
        clip: { scale: { x: 1, y: 1 } }
      }] }
    ]
  });
  // applyOperations runs once PER mirror. A raw uuid() in cloneExtraRefs gave each document
  // different ids for the same extras; both stayed internally valid, so doctor never saw it.
  const op = { op: 'segment.clone', from: { id: 'S' }, id: 'NEW', target: { start: 3, duration: 2 }, __seed: 'FIXED' };
  const root = doc(), timeline = doc();
  applyOperations(root, [op], { group: 'root' });
  applyOperations(timeline, [op], { group: 'timeline:x' });
  const refs = d => d.tracks[1].segments.find(s => s.id === 'NEW').extra_material_refs;
  assert.deepEqual(refs(root), refs(timeline));
  assert.equal(new Set(refs(root)).size, 2, 'two extras must not collapse onto one id');
});
