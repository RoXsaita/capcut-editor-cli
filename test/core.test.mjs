import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';

import {
  CapcutError,
  applyOperations,
  applySpec,
  assertCapcutClosed,
  capcutProcess,
  capcutStatus,
  closeCapcut,
  contentEndUs,
  createSnapshot,
  discoverOpenDraft,
  draftDurationUs,
  doctor,
  durationInfo,
  executeTransaction,
  getProjectLockStatus,
  inspectProject,
  LIVE_FILE_NAMES,
  PRESET3_DUPLICATE_BASELINE,
  projectLockStatus,
  listSnapshots,
  readJson,
  restoreProjectSnapshot,
  sha256,
  stableJson,
  syncMirrors,
  validateDocument,
  waitForCapcutClosed,
  waitForClose
} from '../src/core.mjs';
import { contentEndUs as addContentEndUs } from '../src/add.mjs';

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
    assert.match(doc.materials.videos[0].path, /Resources\/CapcutctlMedia\/.*replacement\.mov$/);
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
    assert.match(material.path, /Resources\/CapcutctlMedia\/.*second-raw\.mp4$/);
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
  // The inner reason used to vanish inside {snapshot}. Need it to debug the rollback.
  try {
    process.env.CAPCUTCTL_FAIL_AFTER_WRITES = '2';
    applySpec(fx.project, { version: 1, operations: [{ op: 'segment.patch', selector: { id: 'SEGMENT-ONE' }, set: { volume: 0.1 } }] }, { forceRunning: true });
    assert.fail('should have rolled back');
  } catch (error) {
    assert.equal(error.code, 'ROLLED_BACK');
    assert.ok(error.details?.cause?.message);
  } finally {
    delete process.env.CAPCUTCTL_FAIL_AFTER_WRITES;
  }
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

test('CapCut probe errors are unknown and only verified no-match is closed', () => {
  const failed = capcutProcess({
    spawn: () => ({ status: 2, stdout: '', stderr: 'permission denied' }),
  });
  assert.equal(failed.running, null);
  assert.equal(failed.verified, false);
  assert.equal(capcutStatus({ processState: failed }).state, 'unknown');
  assert.throws(
    () => assertCapcutClosed({ probe: () => failed }),
    error => error instanceof CapcutError && error.code === 'CAPCUT_PROCESS_UNKNOWN'
  );

  const noMatch = capcutProcess({ spawn: () => ({ status: 1, stdout: '' }) });
  assert.equal(noMatch.running, false);
  assert.equal(noMatch.verified, true);
  assert.doesNotThrow(() => assertCapcutClosed({ probe: () => noMatch }));

  const throwing = capcutProcess({
    spawn: () => { throw Object.assign(new Error('pgrep unavailable'), { code: 'ENOENT' }); },
  });
  assert.equal(throwing.running, null);
  assert.equal(throwing.verified, false);
});

test('transactions lock before loading and serialize concurrent writers', async () => {
  const fx = fixture({ drift: false });
  let observedLock = null;
  const local = executeTransaction(fx.project, groups => {
    observedLock = projectLockStatus(fx.project);
    for (const group of groups) group.doc.lockProbe = true;
    return { changed: true };
  }, { processProbe: () => ({ running: false, verified: true, pids: [] }), backup: false });
  assert.equal(local.committed, true);
  assert.equal(observedLock?.locked, true);
  assert.equal(observedLock?.ownedByCurrentProcess, true);

  const coreUrl = new URL('../src/core.mjs', import.meta.url).href;
  const childCode = `
    import { executeTransaction } from ${JSON.stringify(coreUrl)};
    import { spawnSync } from 'node:child_process';
    try {
      executeTransaction(${JSON.stringify(fx.project)}, groups => {
        for (const group of groups) group.doc.concurrentWrites = (group.doc.concurrentWrites || 0) + 1;
        spawnSync('sleep', ['0.35'], { stdio: 'ignore' });
        return { changed: true };
      }, { processProbe: () => ({ running: false, verified: true, pids: [] }), backup: false });
    } catch (error) {
      process.stderr.write(String(error.code || error.message));
      process.exitCode = error.code === 'LOCKED' ? 4 : 1;
    }
  `;
  const first = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
    cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lockFile = path.join(fx.project, '.capcutctl', 'write.lock');
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(lockFile) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(lockFile), true, 'first writer never acquired the project lock');

  const second = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
    cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wait = child => new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  });
  const [firstResult, secondResult] = await Promise.all([wait(first), wait(second)]);
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.equal(secondResult.code, 4, secondResult.stderr);
  for (const dir of [fx.project, fx.timelineDir]) {
    assert.equal(readJson(path.join(dir, 'draft_info.json')).concurrentWrites, 1);
  }
  assert.equal(fs.existsSync(lockFile), false);
});

test('inspect reports root and active timeline separately', () => {
  const fx = fixture({ drift: false });
  const inspected = inspectProject(fx.project);
  assert.equal(inspected.activeTimelineId, 'TIMELINE-ONE');
  assert.equal(inspected.groups.length, 2);
  assert.equal(inspected.groups[0].tracks[0].segments, 1);
  assert.ok('name' in inspected.groups[0].tracks[0]);
});

test('snapshots include created.json so restore does not leave a stale endcard window', () => {
  const fx = fixture({ drift: false });
  const sidecar = path.join(fx.project, '.capcutctl', 'created.json');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, stableJson({ preserved: { start: 1_000_000, end: 2_000_000 } }));
  const snap = createSnapshot(fx.project, 'with-sidecar');
  fs.writeFileSync(sidecar, stableJson({ preserved: { start: 9_000_000, end: 10_000_000 } }));
  restoreProjectSnapshot(fx.project, snap, { forceRunning: true });
  assert.deepEqual(readJson(sidecar).preserved, { start: 1_000_000, end: 2_000_000 });
});

test('restore still works after the project folder is renamed', () => {
  const fx = fixture({ drift: false });
  const first = applySpec(fx.project, {
    version: 1,
    operations: [{ op: 'segment.patch', selector: { id: 'SEGMENT-ONE' }, set: { volume: 0.25 } }]
  }, { forceRunning: true });
  const renamed = `${fx.project}-moved`;
  fs.renameSync(fx.project, renamed);
  const snapName = path.basename(first.snapshot);
  restoreProjectSnapshot(renamed, snapName, { forceRunning: true });
  assert.equal(readJson(path.join(renamed, 'draft_info.json')).tracks[0].segments[0].volume, 1);
});

test('a stale write.lock from a dead pid is stolen, not a hard lock', () => {
  const fx = fixture({ drift: false });
  const lock = path.join(fx.project, '.capcutctl', 'write.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, stableJson({ pid: 99999999, startedAt: new Date().toISOString() }));
  const result = applySpec(fx.project, {
    version: 1,
    operations: [{ op: 'segment.patch', selector: { id: 'SEGMENT-ONE' }, set: { volume: 0.4 } }]
  }, { forceRunning: true });
  assert.equal(result.committed, true);
  assert.equal(readJson(path.join(fx.project, 'draft_info.json')).tracks[0].segments[0].volume, 0.4);
});

test('doctor counts TRANSITION_OFF_PRINCIPAL as a warning', () => {
  const fx = fixture({ drift: false });
  const video = { id: 'VIDEO-ONE', type: 'video', path: fx.media, duration: 10_000_000, width: 1080, height: 1920 };
  const seg = (id, start, refs = []) => ({
    id, material_id: 'VIDEO-ONE', extra_material_refs: refs,
    target_timerange: { start, duration: 5_000_000 },
    source_timerange: { start, duration: 5_000_000 },
    clip: { scale: { x: 1, y: 1 } }
  });
  for (const dir of [fx.project, fx.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    doc.duration = 10_000_000;
    doc.materials.videos = [video];
    doc.materials.transitions = [{ id: 'TR1', type: 'transition', duration: 200_000 }];
    doc.tracks = [
      { id: 'MAIN', type: 'video', flag: 0, segments: [] },
      { id: 'BROLL', type: 'video', flag: 2, segments: [seg('B1', 0, ['TR1']), seg('B2', 5_000_000)] },
      { id: 'FACE', type: 'video', flag: 2, segments: [seg('F1', 0), seg('F2', 5_000_000)] }
    ];
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(doc));
    }
  }
  const report = doctor(fx.project, { checkFiles: false });
  const hit = report.issues.filter(item => item.code === 'TRANSITION_OFF_PRINCIPAL');
  assert.ok(hit.length, JSON.stringify(report.issues.map(i => i.code)));
  assert.equal(hit[0].level, 'warning');
  assert.ok(report.warnings >= hit.length);
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

test('shared duration helpers distinguish edit end from the full parked draft end', () => {
  const fx = fixture({ drift: false });
  fs.mkdirSync(path.join(fx.project, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(fx.project, '.capcutctl', 'created.json'), stableJson({
    template: 'Preset 3',
    preserved: { start: 8_000_000, end: 12_000_000 },
  }));
  for (const dir of [fx.project, fx.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    doc.duration = 5_000_000;
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(doc));
    }
  }

  const doc = readJson(path.join(fx.project, 'draft_info.json'));
  assert.equal(contentEndUs(doc, fx.project), 5_000_000);
  assert.equal(addContentEndUs(doc, fx.project), 5_000_000, 'add keeps the shared compatibility export');
  assert.equal(draftDurationUs(doc, fx.project), 12_000_000);
  assert.deepEqual(durationInfo(doc, fx.project), {
    unit: 'microseconds',
    contentEndUs: 5_000_000,
    contentDurationUs: 5_000_000,
    editEndUs: 5_000_000,
    editDurationUs: 5_000_000,
    draftEndUs: 12_000_000,
    draftDurationUs: 12_000_000,
    declaredDraftDurationUs: 5_000_000,
    parkedRange: { start: 8_000_000, end: 12_000_000 },
  });

  const report = doctor(fx.project, { checkFiles: false });
  assert.equal(report.errors, 0, JSON.stringify(report.issues));
  assert.equal(report.durations[0].editDurationUs, 5_000_000);
  assert.equal(report.durations[0].draftDurationUs, 12_000_000);
  const inspected = inspectProject(fx.project);
  assert.equal(inspected.groups[0].contentDuration, 5_000_000);
  assert.equal(inspected.groups[0].draftDuration, 12_000_000);
});

test('duration validation permits only targets inside the declared parked range past draft duration', () => {
  const fx = fixture({ drift: false });
  fs.mkdirSync(path.join(fx.project, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(fx.project, '.capcutctl', 'created.json'), stableJson({
    template: 'Preset 3',
    preserved: { start: 8_000_000, end: 12_000_000 },
  }));
  for (const dir of [fx.project, fx.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    doc.duration = 5_000_000;
    doc.tracks.push({ id: 'PARKED-TRACK', type: 'video', flag: 2, segments: [{
      id: 'PARKED-OK', material_id: 'VIDEO-ONE', extra_material_refs: [],
      source_timerange: { start: 0, duration: 4_000_000 },
      target_timerange: { start: 8_000_000, duration: 4_000_000 },
    }] });
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(doc));
    }
  }
  const clean = doctor(fx.project, { checkFiles: false });
  assert.equal(clean.issues.filter(item => item.code === 'SEGMENT_AFTER_END').length, 0);
  assert.equal(validateDocument(readJson(path.join(fx.project, 'draft_info.json')), {
    projectDir: fx.project,
    checkFiles: false,
  }).filter(item => item.code === 'SEGMENT_AFTER_END').length, 0);

  for (const dir of [fx.project, fx.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    doc.tracks.at(-1).segments[0].target_timerange = { start: 11_000_000, duration: 2_000_000 };
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(doc));
    }
  }
  const bad = doctor(fx.project, { checkFiles: false });
  const afterEnd = bad.issues.filter(item => item.code === 'SEGMENT_AFTER_END');
  assert.equal(afterEnd.length, 2, 'the out-of-park target is reported in both documents');
  assert.equal(afterEnd[0].durationGuard.parkedRange.end, 12_000_000);
});

test('status backend discovers an open draft, reports lock ownership, and waits cleanly', () => {
  const fx = fixture({ drift: false });
  const processState = { running: true, pids: ['4242'] };
  const processes = [{ pid: 4242, command: `CapCut --draft-path "${fx.project}"` }];
  const status = capcutStatus({ root: fx.temp, processState, processes });
  assert.equal(status.state, 'running');
  assert.deepEqual(status.pids, ['4242']);
  assert.equal(status.openDraft, fx.project);
  assert.deepEqual(discoverOpenDraft({ root: fx.temp, processes }), fx.project);

  const unlocked = projectLockStatus(fx.project);
  assert.equal(unlocked.status, 'unlocked');
  assert.equal(unlocked.locked, false);
  const lock = path.join(fx.project, '.capcutctl', 'write.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, stableJson({ pid: process.pid, startedAt: '2026-08-29T00:00:00.000Z' }));
  const owned = getProjectLockStatus(fx.project);
  assert.equal(owned.status, 'owned');
  assert.equal(owned.locked, true);
  assert.equal(owned.ownedByCurrentProcess, true);
  fs.writeFileSync(lock, stableJson({ pid: 99999999, startedAt: '2026-08-29T00:00:00.000Z' }));
  const stale = projectLockStatus(fx.project);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.locked, false);
  assert.equal(stale.stale, true);

  let probes = 0;
  const waited = waitForCapcutClosed({
    timeoutMs: 100,
    intervalMs: 0,
    now: () => 0,
    sleep: () => {},
    processProbe: () => probes++ === 0 ? { running: true, pids: ['7'] } : { running: false, pids: [] },
  });
  assert.equal(waited.closed, true);
  assert.equal(waited.reason, 'closed');
  assert.equal(waited.wasRunning, true);

  const timedOut = waitForClose({ timeoutMs: 0, processProbe: () => ({ running: true, pids: ['7'] }) });
  assert.equal(timedOut.closed, false);
  assert.equal(timedOut.reason, 'timeout');
  assert.equal(timedOut.errorCode, 'CLOSE_TIMEOUT');
  assert.throws(
    () => waitForClose({ timeoutMs: 0, throwOnTimeout: true, processProbe: () => ({ running: true, pids: ['7'] }) }),
    error => error instanceof CapcutError && error.code === 'CLOSE_TIMEOUT' && error.details.reason === 'timeout'
  );
});

test('close backend exposes branchable refusal and cancellation reasons', () => {
  const refused = () => closeCapcut({
    timeoutMs: 0,
    processProbe: () => ({ running: true, pids: ['8'] }),
    requestQuit: () => { throw Object.assign(new Error('user cancelled the save dialog'), { status: -128 }); },
  });
  assert.throws(refused, error => error instanceof CapcutError
    && error.code === 'CLOSE_CANCELLED'
    && error.details.reason === 'quit_cancelled');

  assert.throws(() => closeCapcut({
    timeoutMs: 0,
    processProbe: () => ({ running: true, pids: ['9'] }),
    executeQuit: () => { throw Object.assign(new Error('osascript missing'), { code: 'ENOENT' }); },
  }), error => error instanceof CapcutError
    && error.code === 'CLOSE_COMMAND_FAILED'
    && error.details.reason === 'quit_command_failed');
});

test('doctor baselines only the known Preset 3 duplicates and still reports new ones', () => {
  const fx = fixture({ drift: false });
  const baseline = PRESET3_DUPLICATE_BASELINE[0];
  fs.mkdirSync(path.join(fx.project, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(fx.project, '.capcutctl', 'created.json'), stableJson({ template: 'Preset 3' }));
  for (const dir of [fx.project, fx.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    const known = { ...baseline, path: fx.media };
    doc.materials.videos.push(known, structuredClone(known));
    const novel = structuredClone(doc.materials.videos.find(item => item.id === 'VIDEO-ONE'));
    doc.materials.videos.push(novel);
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(doc));
    }
  }

  const report = doctor(fx.project, { checkFiles: false });
  assert.equal(report.issues.filter(item => item.code === 'DUPLICATE_MATERIAL_ID').length, 2,
    'only the new VIDEO-ONE duplicate remains, once per document');
  assert.equal(report.duplicateBaseline.enabled, true);
  assert.equal(report.duplicateBaseline.matches.length, 2);

  const noBaseline = doctor(fx.project, { checkFiles: false, duplicateBaseline: false });
  assert.equal(noBaseline.issues.filter(item => item.code === 'DUPLICATE_MATERIAL_ID').length, 4,
    'disabling the explicit baseline restores both known warnings');

  for (const dir of [fx.project, fx.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    doc.materials.videos.find(item => item.id === baseline.id).duration = baseline.duration - 1;
    fs.writeFileSync(path.join(dir, 'draft_info.json'), stableJson(doc));
    fs.writeFileSync(path.join(dir, 'draft_info.json.bak'), stableJson(doc));
    fs.writeFileSync(path.join(dir, 'template-2.tmp'), stableJson(doc));
  }
  const conflict = doctor(fx.project, { checkFiles: false });
  assert.ok(conflict.issues.some(item => item.code === 'CONFLICTING_MATERIAL_ID'),
    'a known id with conflicting data is still an error');
});

function writeRecutDocs(f, mutate) {
  for (const dir of [f.project, f.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    mutate(doc);
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(doc));
    }
  }
}

function recutFixture() {
  const f = fixture({ drift: false });
  // recut validates the actual source duration with ffprobe. Keep the general fixture's
  // text placeholder for cheap native-operation tests, but make this source real media.
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30',
    '-t', '8', '-an', '-c:v', 'mpeg4', '-y', f.media
  ], { stdio: 'ignore' });
  const clip = (id, materialId, start, duration, sourceStart = 0, desc = '') => ({
    id, material_id: materialId, extra_material_refs: [], desc, speed: 1, volume: 1,
    source_timerange: { start: sourceStart, duration },
    target_timerange: { start, duration },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
  });
  writeRecutDocs(f, doc => {
    doc.tracks[0].flag = 2;
    doc.tracks[0].name = 'content';
    doc.materials.videos.push({
      id: 'BROLL-MATERIAL', type: 'video', path: f.media, duration: 20_000_000,
      width: 1080, height: 1920
    });
    doc.materials.audios = [{
      id: 'AUDIO-MATERIAL', type: 'audio', path: f.media, duration: 20_000_000
    }];
    doc.tracks[0].segments.push(clip('LAYOUT-ANCHOR', 'BROLL-MATERIAL', 1_000_000, 3_000_000, 0, 'layout:manual'));
    doc.tracks.push(
      { id: 'BROLL-TRACK', type: 'video', flag: 2, name: 'broll', segments: [
        clip('BROLL-ANCHOR', 'BROLL-MATERIAL', 1_000_000, 3_000_000)
      ] },
      { id: 'DROP-TRACK', type: 'video', flag: 2, name: 'drop', segments: [
        clip('DROPPED-ANCHOR', 'BROLL-MATERIAL', 2_100_000, 800_000, 0)
      ] },
      { id: 'SFX-TRACK', type: 'audio', name: 'sfx', segments: [
        clip('SFX-ANCHOR', 'AUDIO-MATERIAL', 1_000_000, 3_000_000)
      ] },
      { id: 'MUSIC-TRACK', type: 'audio', name: 'music', segments: [
        clip('MUSIC-ANCHOR', 'AUDIO-MATERIAL', 0, 5_000_000)
      ] }
    );
  });
  return f;
}

function recutSpec(f, timeline = [
  { beat: 0, tl_in: 0, tl_out: 2, src_in: 0, dur: 2, text: 'first' },
  { beat: 1, tl_in: 2, tl_out: 4, src_in: 3, dur: 2, text: 'second' },
]) {
  return {
    version: 1,
    name: 'cut-recut',
    operations: [{
      op: 'cut.recut', contract: 'cut.recut.v1', into: f.project, media: f.media,
      plan: { media: f.media, kept: [0, 1], timeline, duration: 4, fps: 30, lint: [] },
      audioRamps: [
        { op: 'clip.fade', at: 0, in: 2 / 30, out: 2 / 30 },
        { op: 'clip.fade', at: 2, in: 2 / 30, out: 2 / 30 }
      ],
      preserve: ['broll', 'layout', 'sfx', 'music'],
      retimeAnchored: true
    }]
  };
}

test('cut.recut source-maps anchors, keeps principal at 1x, mirrors ids, and is idempotent', () => {
  const f = recutFixture();
  const spec = recutSpec(f);
  const first = applySpec(f.project, spec, { forceRunning: true });
  assert.equal(first.committed, true);

  const docs = [readJson(path.join(f.project, 'draft_info.json')), readJson(path.join(f.timelineDir, 'draft_info.json'))];
  const principalSegments = doc => doc.tracks.find(track => track.name === 'content').segments
    .filter(segment => !segment.desc?.startsWith('layout:'));
  for (const doc of docs) {
    const principal = principalSegments(doc);
    assert.equal(principal.length, 2);
    assert.deepEqual(principal.map(s => s.target_timerange), [
      { start: 0, duration: 2_000_000 }, { start: 2_000_000, duration: 2_000_000 }
    ]);
    assert.deepEqual(principal.map(s => s.source_timerange), [
      { start: 0, duration: 2_000_000 }, { start: 3_000_000, duration: 2_000_000 }
    ]);
    assert.deepEqual(principal.map(s => s.speed), [1, 1]);
    assert.equal(doc.materials.audio_fades.length, 2);
    for (const segment of principal) {
      const fade = doc.materials.audio_fades.find(item => segment.extra_material_refs.includes(item.id));
      assert.ok(fade);
      assert.equal(fade.fade_in_duration, 66_667);
      assert.equal(fade.fade_out_duration, 66_667);
    }
    assert.equal(doc.tracks.find(track => track.name === 'broll').segments.length, 2);
    assert.deepEqual(doc.tracks.find(track => track.name === 'broll').segments.map(s => s.target_timerange), [
      { start: 1_000_000, duration: 1_000_000 }, { start: 2_000_000, duration: 1_000_000 }
    ]);
    assert.equal(doc.tracks.find(track => track.name === 'drop').segments.length, 0);
    const sfx = doc.tracks.find(track => track.name === 'sfx').segments;
    const music = doc.tracks.find(track => track.name === 'music').segments;
    assert.equal(sfx.length, 1);
    assert.equal(music.length, 1);
    assert.deepEqual(sfx[0].target_timerange, { start: 1_000_000, duration: 3_000_000 });
    assert.deepEqual(music[0].target_timerange, { start: 0, duration: 5_000_000 });
    assert.equal(doc.tracks.find(track => track.name === 'content').segments.filter(s => s.desc === 'layout:manual').length, 2);
    assert.equal(doctor(f.project, { checkFiles: false }).errors, 0);
  }
  const ids = doc => ({
    tracks: doc.tracks.map(track => [track.id, track.name, track.segments.map(s => s.id)]),
    fades: (doc.materials.audio_fades || []).map(item => item.id),
    videos: doc.materials.videos.map(item => item.id)
  });
  assert.deepEqual(ids(docs[0]), ids(docs[1]));

  const rootBefore = stableJson(docs[0]);
  const timelineBefore = stableJson(docs[1]);
  const second = applySpec(f.project, spec, { forceRunning: true });
  assert.equal(second.committed, false);
  assert.equal(stableJson(readJson(path.join(f.project, 'draft_info.json'))), rootBefore);
  assert.equal(stableJson(readJson(path.join(f.timelineDir, 'draft_info.json'))), timelineBefore);
});

test('cut.recut rejects malformed or ambiguous plans before changing either mirror', () => {
  const f = recutFixture();
  const before = [f.project, f.timelineDir].map(dir => stableJson(readJson(path.join(dir, 'draft_info.json'))));
  const bad = recutSpec(f, [
    { beat: 0, tl_in: 0, tl_out: 2, src_in: 0, dur: 2 },
    { beat: 1, tl_in: 1.5, tl_out: 4, src_in: 3, dur: 2.5 }
  ]);
  assert.throws(() => applySpec(f.project, bad, { forceRunning: true }),
    error => error instanceof CapcutError && error.code === 'CUT_PLAN_AMBIGUOUS');
  assert.equal(stableJson(readJson(path.join(f.project, 'draft_info.json'))), before[0]);
  assert.equal(stableJson(readJson(path.join(f.timelineDir, 'draft_info.json'))), before[1]);
});

test('cut.recut rolls back all mirrors after an injected commit failure', () => {
  const f = recutFixture();
  process.env.CAPCUTCTL_FAIL_AFTER_WRITES = '2';
  try {
    assert.throws(() => applySpec(f.project, recutSpec(f), { forceRunning: true }),
      error => error instanceof CapcutError && error.code === 'ROLLED_BACK');
  } finally {
    delete process.env.CAPCUTCTL_FAIL_AFTER_WRITES;
  }
  for (const dir of [f.project, f.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    assert.equal(doc.tracks.find(track => track.name === 'content').segments[0].id, 'SEGMENT-ONE');
    assert.equal(doc.materials.audio_fades, undefined);
    const mirrors = ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']
      .map(name => sha256(fs.readFileSync(path.join(dir, name))));
    assert.equal(new Set(mirrors).size, 1);
  }
});

test('cut.recut commits the parked timeline and created metadata as one transaction', () => {
  const f = recutFixture();
  const sidecar = path.join(f.project, '.capcutctl', 'created.json');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, stableJson({
    template: 'Preset 3',
    preserved: { start: 8_000_000, end: 12_000_000 },
  }));
  writeRecutDocs(f, doc => {
    doc.duration = 12_000_000;
    doc.tracks.push({
      id: 'PARKED-TRACK', type: 'video', flag: 2, name: 'parked parts bin',
      segments: [{
        id: 'PARKED-SEGMENT', material_id: 'BROLL-MATERIAL', extra_material_refs: [],
        source_timerange: { start: 0, duration: 4_000_000 },
        target_timerange: { start: 8_000_000, duration: 4_000_000 },
      }],
    });
  });

  const result = applySpec(f.project, recutSpec(f), { forceRunning: true });
  assert.equal(result.committed, true);
  assert.deepEqual(readJson(sidecar).preserved, { start: 34_000_000, end: 38_000_000 });
  for (const dir of [f.project, f.timelineDir]) {
    const parked = readJson(path.join(dir, 'draft_info.json')).tracks
      .find(track => track.id === 'PARKED-TRACK').segments[0];
    assert.deepEqual(parked.target_timerange, { start: 34_000_000, duration: 4_000_000 });
    assert.ok(readJson(path.join(dir, 'draft_info.json')).duration >= 38_000_000);
  }
});

test('cut.recut no-backup rollback restores every mirror and created metadata byte-for-byte', () => {
  const f = recutFixture();
  const sidecar = path.join(f.project, '.capcutctl', 'created.json');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, stableJson({
    template: 'Preset 3',
    preserved: { start: 8_000_000, end: 12_000_000 },
  }));
  const files = [
    ...[f.project, f.timelineDir].flatMap(dir => LIVE_FILE_NAMES.map(name => path.join(dir, name))),
    sidecar,
  ];
  const before = new Map(files.map(file => [file, fs.readFileSync(file)]));
  process.env.CAPCUTCTL_FAIL_AFTER_WRITES = '7';
  try {
    assert.throws(
      () => applySpec(f.project, recutSpec(f), { forceRunning: true, backup: false }),
      error => error instanceof CapcutError
        && error.code === 'ROLLED_BACK'
        && error.details?.snapshot === null
    );
  } finally {
    delete process.env.CAPCUTCTL_FAIL_AFTER_WRITES;
  }
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, file);
  assert.equal(fs.existsSync(path.join(f.project, '.capcutctl', 'write.lock')), false);
});

test('cut.recut resolves canonical original media paths and rejects source past real EOF', () => {
  const canonical = recutFixture();
  const localized = path.join(canonical.temp, 'localized-source.mp4');
  fs.copyFileSync(canonical.media, localized);
  writeRecutDocs(canonical, doc => {
    const source = doc.materials.videos.find(item => item.id === 'VIDEO-ONE');
    source.path = localized;
    source.original_path = canonical.media;
    source.duration = 8_000_000;
  });
  applySpec(canonical.project, recutSpec(canonical), { forceRunning: true });
  for (const dir of [canonical.project, canonical.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    const principal = doc.tracks.find(track => track.name === 'content').segments
      .filter(segment => !segment.desc?.startsWith('layout:'));
    assert.deepEqual(principal.map(segment => segment.material_id), ['VIDEO-ONE', 'VIDEO-ONE']);
  }

  const eof = recutFixture();
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30',
    '-t', '3', '-an', '-c:v', 'mpeg4', '-y', eof.media
  ], { stdio: 'ignore' });
  const before = [eof.project, eof.timelineDir].map(dir => fs.readFileSync(path.join(dir, 'draft_info.json')));
  assert.throws(
    () => applySpec(eof.project, recutSpec(eof), { forceRunning: true }),
    error => error instanceof CapcutError && error.code === 'SOURCE_AFTER_END'
  );
  assert.deepEqual(fs.readFileSync(path.join(eof.project, 'draft_info.json')), before[0]);
  assert.deepEqual(fs.readFileSync(path.join(eof.timelineDir, 'draft_info.json')), before[1]);
});

test('cut.recut clones shared speed refs and filters/rebases animated split keyframes', () => {
  const f = recutFixture();
  writeRecutDocs(f, doc => {
    doc.materials.speeds = [{ id: 'SHARED-SPEED', type: 'speed', speed: 2, mode: 0, curve_speed: null }];
    const broll = doc.tracks.find(track => track.name === 'broll').segments[0];
    broll.extra_material_refs = ['SHARED-SPEED'];
    broll.keyframe_refs = [{ id: 'SHARED-KF-REF' }];
    broll.common_keyframes = [{
      property_type: 'KFTypePositionX',
      keyframe_list: [0, 1, 2, 2.5, 3].map(time_offset => ({ time_offset: time_offset * 1_000_000, values: [time_offset] })),
    }];
  });
  applySpec(f.project, recutSpec(f), { forceRunning: true });
  for (const dir of [f.project, f.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    const broll = doc.tracks.find(track => track.name === 'broll').segments;
    assert.equal(broll.length, 2);
    const speedRefs = broll.map(segment => segment.extra_material_refs
      .find(ref => doc.materials.speeds.some(speed => speed.id === ref)));
    assert.equal(new Set(speedRefs).size, broll.length);
    assert.equal(doc.materials.speeds.find(speed => speed.id === 'SHARED-SPEED').speed, 2);
    for (const [index, segment] of broll.entries()) {
      const speed = doc.materials.speeds.find(item => item.id === speedRefs[index]);
      assert.equal(speed.speed, segment.speed);
      for (const group of segment.common_keyframes || []) {
        for (const keyframe of group.keyframe_list || []) {
          assert.ok(keyframe.time_offset >= segment.source_timerange.start - 1);
          assert.ok(keyframe.time_offset <= segment.source_timerange.start + segment.source_timerange.duration + 1);
        }
      }
    }
    assert.notStrictEqual(broll[0].keyframe_refs, broll[1].keyframe_refs);
    const keyframes = broll.flatMap(segment => segment.common_keyframes?.[0]?.keyframe_list || []);
    assert.equal(keyframes.length, 5, 'each split piece retains only its own source keyframes');
  }
});

test('cut.recut treats project FPS as authoritative and quantizes non-30fps plans', () => {
  const f = recutFixture();
  writeRecutDocs(f, doc => { doc.fps = 24; });
  const mismatch = recutSpec(f);
  assert.throws(
    () => applySpec(f.project, mismatch, { forceRunning: true }),
    error => error instanceof CapcutError && error.code === 'CUT_FPS_MISMATCH'
  );

  const unquantized = recutSpec(f);
  unquantized.operations[0].plan.fps = 24;
  unquantized.operations[0].plan.timeline[0].tl_out = 2.01;
  unquantized.operations[0].plan.timeline[0].dur = 2.01;
  assert.throws(
    () => applySpec(f.project, unquantized, { forceRunning: true }),
    error => error instanceof CapcutError && error.code === 'CUT_PLAN_UNQUANTIZED'
  );

  const valid = recutSpec(f);
  valid.operations[0].plan.fps = 24;
  valid.operations[0].audioRamps = [
    { op: 'clip.fade', at: 0, in: 2 / 24, out: 2 / 24 },
    { op: 'clip.fade', at: 2, in: 2 / 24, out: 2 / 24 },
  ];
  assert.equal(applySpec(f.project, valid, { forceRunning: true }).committed, true);
  const frame = 1_000_000 / 24;
  for (const dir of [f.project, f.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    assert.equal(doc.fps, 24);
    for (const segment of doc.tracks.find(track => track.name === 'content').segments) {
      assert.ok(Math.abs(segment.target_timerange.start - Math.round(segment.target_timerange.start / frame) * frame) <= 4);
      assert.ok(Math.abs(segment.target_timerange.duration - Math.round(segment.target_timerange.duration / frame) * frame) <= 4);
    }
  }
});

test('cut.recut leaves unrelated audio anchored but maps explicitly tied audio', () => {
  const f = recutFixture();
  writeRecutDocs(f, doc => {
    doc.tracks.find(track => track.name === 'sfx').segments[0].source_tied_to_principal = true;
  });
  applySpec(f.project, recutSpec(f), { forceRunning: true });
  for (const dir of [f.project, f.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    assert.equal(doc.tracks.find(track => track.name === 'sfx').segments.length, 2);
    assert.equal(doc.tracks.find(track => track.name === 'music').segments.length, 1);
    assert.deepEqual(doc.tracks.find(track => track.name === 'music').segments[0].target_timerange,
      { start: 0, duration: 5_000_000 });
  }
});

test('a live lock is never reclaimed after a stale preflight check', () => {
  const f = fixture({ drift: false });
  const lock = path.join(f.project, '.capcutctl', 'write.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const before = stableJson({ pid: process.pid, ownerToken: 'live-owner', startedAt: new Date().toISOString() });
  fs.writeFileSync(lock, before);
  assert.throws(
    () => applySpec(f.project, {
      version: 1,
      operations: [{ op: 'segment.patch', selector: { id: 'SEGMENT-ONE' }, set: { volume: 0.2 } }],
    }, { forceRunning: true }),
    error => error instanceof CapcutError && error.code === 'LOCKED'
  );
  assert.equal(fs.readFileSync(lock, 'utf8'), before);
  fs.unlinkSync(lock);
});
