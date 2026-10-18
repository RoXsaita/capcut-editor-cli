import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySpec, doctor, listSnapshots, readJson, repairProject, resolveProject, stableJson } from '../src/core.mjs';
import { commitStage, discardStage, stageStatus, startStage } from '../src/stage.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { LEDGER_RELATIVE } from '../src/repair.mjs';

const CLOSED = () => ({ running: false, verified: true, pids: [] });
const RUNNING = () => ({ running: true, verified: true, pids: [4242] });
const MIRRORS = ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp'];

/** A drafts root with one project: a gapless face track, a B-roll lane and a pop on an sfx lane. */
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-stage-'));
  const root = path.join(temp, 'drafts');
  const project = path.join(root, 'Hook Edit');
  const stages = path.join(temp, 'stages');
  const face = path.join(temp, 'face.mp4');
  const screen = path.join(temp, 'screen.mp4');
  const pop = path.join(temp, 'pop.wav');
  for (const file of [face, screen, pop]) fs.writeFileSync(file, path.basename(file));
  const seg = (id, material, start, duration, src, extra = {}) => ({
    id, material_id: material, extra_material_refs: [], speed: 1, volume: 1,
    source_timerange: { start: src, duration }, target_timerange: { start, duration },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 },
    keyframe_refs: [], common_keyframes: [], ...extra,
  });
  const doc = {
    id: 'TL', name: 'Hook Edit', duration: 10_000_000, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920 },
    materials: {
      videos: [
        { id: 'FACE', type: 'video', path: face, duration: 60_000_000, width: 1440, height: 2560 },
        { id: 'SCREEN', type: 'video', path: screen, duration: 5_000_000, width: 1920, height: 1080 },
      ],
      audios: [{ id: 'POP', type: 'sound', path: pop, duration: 500_000, name: 'pop' }],
      speeds: [], transitions: [], common_mask: [], texts: [],
    },
    tracks: [
      { id: 'T0', type: 'video', flag: 0, attribute: 0, segments: [] },
      { id: 'T1', type: 'video', flag: 2, attribute: 0, name: 'content', segments: [
        seg('A', 'FACE', 0, 4_000_000, 0), seg('B', 'FACE', 4_000_000, 6_000_000, 10_000_000),
      ] },
      { id: 'T2', type: 'video', flag: 2, attribute: 0, name: 'broll', segments: [seg('SHOT', 'SCREEN', 5_000_000, 3_000_000, 1_000_000, { volume: 0 })] },
      { id: 'T3', type: 'audio', flag: 0, attribute: 0, name: 'sfx', segments: [seg('POP-1', 'POP', 5_000_000, 400_000, 0, { volume: 0.35 })] },
    ],
  };
  writeDraft(project, doc);
  return { temp, root, project, stages, doc, face };
}

function writeDraft(project, doc) {
  for (const dir of [project, path.join(project, 'Timelines', 'TL')]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of MIRRORS) fs.writeFileSync(path.join(dir, name), stableJson(doc));
  }
  fs.writeFileSync(path.join(project, 'Timelines', 'project.json'), stableJson({ main_timeline_id: 'TL', timelines: [{ id: 'TL' }] }));
}

const live = project => readJson(path.join(project, 'Timelines', 'TL', 'draft_info.json'));
const segment = (doc, id) => doc.tracks.flatMap(t => t.segments).find(s => s.id === id);
const patch = (id, set) => ({ version: 1, name: 'test', operations: [{ op: 'segment.patch', selector: { id }, set }] });

test('stage: writes land on a copy outside the drafts folder while CapCut runs; the swap needs it closed', () => {
  const fx = fixture();
  const started = startStage(fx.project, { root: fx.stages });
  assert.equal(started.started, true);
  assert.ok(started.stage.startsWith(fx.stages + path.sep), 'the stage is outside the drafts root');

  // Every command resolves the project to the stage now, and a write there ignores CapCut.
  const target = resolveProject('Hook Edit', fx.root);
  assert.equal(target, started.stage);
  assert.equal(resolveProject('Hook Edit', fx.root, { live: true }), fx.project);
  const tx = applySpec(target, patch('SHOT', { clip: { alpha: 0.5 } }), { processProbe: RUNNING });
  assert.equal(tx.committed, true);
  assert.equal(segment(live(fx.project), 'SHOT').clip.alpha, 1, 'the live draft is untouched until the swap');

  const status = stageStatus(fx.project);
  assert.equal(status.active, true);
  assert.ok(status.changed.includes('Timelines/TL/draft_info.json'));
  assert.deepEqual(status.conflicts, []);

  // The swap keeps the existing guard.
  assert.throws(() => commitStage(fx.project, { processProbe: RUNNING }), error => error.code === 'CAPCUT_RUNNING');
  const dry = commitStage(fx.project, { dryRun: true });
  assert.equal(dry.committed, false);
  assert.equal(segment(live(fx.project), 'SHOT').clip.alpha, 1);

  const done = commitStage(fx.project, { processProbe: CLOSED });
  assert.equal(done.committed, true);
  for (const dir of [fx.project, path.join(fx.project, 'Timelines', 'TL')]) {
    for (const name of MIRRORS) assert.equal(segment(readJson(path.join(dir, name)), 'SHOT').clip.alpha, 0.5, `${name} swapped`);
  }
  assert.equal(doctor(fx.project).errors, 0);
  assert.ok(listSnapshots(fx.project).some(s => s.name.endsWith('before-stage-commit')), 'the swap is undoable');
  assert.equal(fs.existsSync(started.stage), false, 'the stage is cleaned up');
  assert.equal(resolveProject('Hook Edit', fx.root), fx.project, 'commands target the live draft again');
});

test('stage: a CapCut save after staging makes the swap refuse and keeps the user\'s edit', () => {
  const fx = fixture();
  const { stage } = startStage(fx.project, { root: fx.stages });
  applySpec(stage, patch('SHOT', { clip: { alpha: 0.5 } }), { processProbe: RUNNING });

  // The user moves the pop in CapCut and saves.
  const saved = structuredClone(fx.doc);
  segment(saved, 'POP-1').target_timerange.start = 5_200_000;
  writeDraft(fx.project, saved);

  assert.equal(stageStatus(fx.project).conflicts.length > 0, true);
  assert.throws(() => commitStage(fx.project, { processProbe: CLOSED }), error => {
    assert.equal(error.code, 'STAGE_CONFLICT');
    assert.match(error.message, /draft_info\.json/);
    return true;
  });
  assert.equal(segment(live(fx.project), 'POP-1').target_timerange.start, 5_200_000, 'the CapCut edit survives');
  assert.equal(segment(live(fx.project), 'SHOT').clip.alpha, 1);

  const discarded = discardStage(fx.project);
  assert.equal(discarded.discarded, true);
  assert.equal(fs.existsSync(stage), false);
  assert.equal(stageStatus(fx.project).active, false);
});

test('stage: new media and paths written on the stage are swapped in pointing at the live draft', () => {
  const fx = fixture();
  const { stage } = startStage(fx.project, { root: fx.stages });
  const staged = path.join(stage, 'Resources', 'CapcutctlMedia', 'take.mp4');
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, 'new take');
  applySpec(stage, { version: 1, name: 'relink', operations: [
    { op: 'material.patch', selector: { id: 'SCREEN' }, set: { path: staged } },
  ] }, { processProbe: RUNNING });
  fs.writeFileSync(path.join(stage, '.capcutctl', 'media-map.json'), stableJson({ materials: { SCREEN: { localizedPath: staged } } }));

  commitStage(fx.project, { processProbe: CLOSED });
  const moved = path.join(fx.project, 'Resources', 'CapcutctlMedia', 'take.mp4');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'new take');
  assert.equal(live(fx.project).materials.videos.find(m => m.id === 'SCREEN').path, moved);
  assert.equal(readJson(path.join(fx.project, '.capcutctl', 'media-map.json')).materials.SCREEN.localizedPath, moved);
  assert.equal(doctor(fx.project).errors, 0);
});

test('stage: a second start is refused while one is active', () => {
  const fx = fixture();
  startStage(fx.project, { root: fx.stages });
  assert.throws(() => startStage(fx.project, { root: fx.stages }), error => error.code === 'STAGE_EXISTS');
});

/** What a CapCut save does to a capcutctl draft, plus two deliberate user edits. */
function capcutResave(doc) {
  const out = structuredClone(doc);
  for (const values of Object.values(out.materials)) {
    if (!Array.isArray(values)) continue;
    for (const m of values) for (const key of Object.keys(m)) if (key.startsWith('capcutctl_')) delete m[key];
  }
  for (const s of out.tracks.flatMap(t => t.segments)) delete s.desc;
  const dup = structuredClone(out.materials.videos[0]);
  dup.duration += 33_333;                                   // CapCut's one-frame re-probe
  out.materials.videos.push(dup);
  segment(out, 'SHOT').source_timerange.duration = 4_500_000; // now reads 0.5 s past the 5 s source
  segment(out, 'SHOT').target_timerange.duration = 4_500_000;
  out.duration = 10_000_000;
  segment(out, 'POP-1').volume = 0.6;                       // the user's own level change
  out.tracks.find(t => t.name === 'sfx').segments = [];     // ...and the user deleted the pop
  return out;
}

test('repair: restores stripped metadata from the ledger, dedupes ids, clamps B-roll, keeps user edits', () => {
  const fx = fixture();
  applySpec(fx.project, { version: 1, name: 'meta', operations: [
    { op: 'material.patch', selector: { id: 'SCREEN' }, set: { capcutctl_origin: 'capture' } },
    { op: 'material.patch', selector: { id: 'FACE' }, set: { capcutctl_mograph: { template: 'scene:seam-wipe', scene: true } } },
    { op: 'segment.patch', selector: { id: 'SHOT' }, set: { desc: 'mograph:seam-wipe' } },
    { op: 'segment.patch', selector: { id: 'POP-1' }, set: { desc: 'mograph:sfx:seam-wipe' } },
  ] }, { processProbe: CLOSED });
  const ledger = readJson(path.join(fx.project, LEDGER_RELATIVE));
  assert.equal(ledger.materials.SCREEN.fields.capcutctl_origin, 'capture');
  assert.equal(ledger.segments.SHOT.fields.desc, 'mograph:seam-wipe');

  writeDraft(fx.project, capcutResave(live(fx.project)));
  assert.ok(doctor(fx.project).errors > 0, 'the resaved draft is broken before repair');

  const result = repairProject(fx.project, { processProbe: CLOSED });
  assert.equal(result.committed, true);
  const doc = live(fx.project);
  assert.equal(doc.materials.videos.filter(m => m.id === 'FACE').length, 1, 'duplicate id merged');
  assert.equal(doc.materials.videos.find(m => m.id === 'SCREEN').capcutctl_origin, 'capture');
  assert.equal(doc.materials.videos.find(m => m.id === 'FACE').capcutctl_mograph.template, 'scene:seam-wipe');
  assert.equal(segment(doc, 'SHOT').desc, 'mograph:seam-wipe');
  assert.deepEqual(segment(doc, 'SHOT').source_timerange, { start: 1_000_000, duration: 4_000_000 }, 'clamped to its source');
  assert.equal(segment(doc, 'SHOT').target_timerange.start, 5_000_000, 'the clamp never moves a clip');
  assert.equal(segment(doc, 'POP-1'), undefined, 'a segment the user deleted stays deleted');
  assert.deepEqual(segment(doc, 'A').target_timerange, { start: 0, duration: 4_000_000 }, 'face timing untouched');
  assert.equal(doctor(fx.project).errors, 0);

  const again = repairProject(fx.project, { processProbe: CLOSED });
  assert.deepEqual(again.repaired, { merged: 0, restored: 0, clamped: 0, unclamped: 0 }, 'repair is idempotent');
});

test('repair: without a ledger the history snapshots are the record; a relinked material is left alone', () => {
  const fx = fixture();
  applySpec(fx.project, { version: 1, name: 'meta', operations: [
    { op: 'material.patch', selector: { id: 'SCREEN' }, set: { capcutctl_origin: 'derived', derived_from_path: '/originals/screen.mov' } },
    { op: 'material.patch', selector: { id: 'FACE' }, set: { capcutctl_origin: 'capture' } },
  ] }, { processProbe: CLOSED });
  // A later no-op-ish write snapshots the draft WITH its metadata; then drop the ledger.
  applySpec(fx.project, patch('A', { clip: { alpha: 0.9 } }), { processProbe: CLOSED });
  fs.rmSync(path.join(fx.project, LEDGER_RELATIVE));

  const resaved = capcutResave(live(fx.project));
  resaved.materials.videos.find(m => m.id === 'FACE').path = path.join(fx.temp, 'other-take.mp4');
  fs.writeFileSync(path.join(fx.temp, 'other-take.mp4'), 'other');
  resaved.materials.videos = resaved.materials.videos.filter((m, i, all) => all.findIndex(x => x.id === m.id) === i);
  writeDraft(fx.project, resaved);

  repairProject(fx.project, { processProbe: CLOSED });
  const doc = live(fx.project);
  const screen = doc.materials.videos.find(m => m.id === 'SCREEN');
  assert.equal(screen.capcutctl_origin, 'derived');
  assert.equal(screen.derived_from_path, '/originals/screen.mov');
  assert.equal(doc.materials.videos.find(m => m.id === 'FACE').capcutctl_origin, undefined,
    'provenance of the old file is not stamped onto a material relinked to another one');
});

test('stage start repairs the copy, so a CapCut save before staging is fixed before the first write', () => {
  const fx = fixture();
  applySpec(fx.project, { version: 1, name: 'meta', operations: [
    { op: 'material.patch', selector: { id: 'SCREEN' }, set: { capcutctl_origin: 'capture' } },
  ] }, { processProbe: CLOSED });
  writeDraft(fx.project, capcutResave(live(fx.project)));

  const started = startStage(fx.project, { root: fx.stages });
  assert.ok(started.repaired.restored >= 1 && started.repaired.merged >= 1 && started.repaired.clamped >= 1, JSON.stringify(started.repaired));
  assert.equal(readJson(path.join(started.stage, 'draft_info.json')).materials.videos.find(m => m.id === 'SCREEN').capcutctl_origin, 'capture');
  commitStage(fx.project, { processProbe: CLOSED });
  assert.equal(doctor(fx.project).errors, 0);
});

async function cli(argv) {
  let out = '';
  const restore = setOutput(chunk => { out += String(chunk); return true; });
  try { await main(argv); } finally { restore(); }
  return JSON.parse(out);
}

test('cli: stage start → edits by project name → stage commit; doctor --fix repairs a resave', async () => {
  const fx = fixture();
  const previous = process.env.CAPCUTCTL_STAGE_DIR;
  process.env.CAPCUTCTL_STAGE_DIR = fx.stages;
  try {
    const at = ['--project', 'Hook Edit', '--root', fx.root];
    const started = await cli(['stage', 'start', ...at]);
    assert.ok(started.stage.startsWith(fx.stages));
    const spec = path.join(fx.temp, 'spec.json');
    fs.writeFileSync(spec, stableJson(patch('SHOT', { clip: { alpha: 0.25 } })));
    const applied = await cli(['apply', ...at, '--spec', spec]);
    assert.equal(applied.project, started.stage, 'the edit went to the stage by name, no --force-running needed');
    assert.equal(segment(live(fx.project), 'SHOT').clip.alpha, 1);
    assert.equal((await cli(['stage', 'status', ...at])).changed.includes('draft_info.json'), true);
    const committed = await cli(['stage', 'commit', ...at, '--force-running']);
    assert.equal(committed.committed, true);
    assert.equal(segment(live(fx.project), 'SHOT').clip.alpha, 0.25);

    writeDraft(fx.project, capcutResave(live(fx.project)));
    const report = await cli(['doctor', ...at, '--fix', '--json', '--force-running']);
    assert.equal(report.repair.committed, true);
    assert.ok(report.repair.merged >= 1 && report.repair.clamped >= 1);
    assert.equal(report.errors, 0);
  } finally {
    if (previous == null) delete process.env.CAPCUTCTL_STAGE_DIR; else process.env.CAPCUTCTL_STAGE_DIR = previous;
  }
});
