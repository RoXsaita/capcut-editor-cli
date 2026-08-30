import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  FIELD_REPORT_OPERATIONS,
  buildCutRecutSpec,
  buildScreenLayoutSpec,
  buildArrollArgs,
  main,
  parseArgs,
  serializeCloseFailure,
  statusPayload,
  setOutput,
} from '../src/cli.mjs';

const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;

function writeCliProject(root, media) {
  const project = path.join(root, 'project');
  const timelineId = 'CLI-TIMELINE';
  const timelineDir = path.join(project, 'Timelines', timelineId);
  const doc = {
    id: timelineId,
    name: 'CLI fixture',
    duration: 3_000_000,
    fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [{ id: 'VIDEO', type: 'video', path: media, duration: 3_000_000, width: 1080, height: 1920 }],
      audios: [],
      common_mask: [],
      speeds: [],
      audio_fades: [],
      transitions: [],
    },
    tracks: [
      { id: 'COVER', type: 'video', flag: 0, segments: [] },
      {
        id: 'CONTENT', type: 'video', flag: 2, name: 'content', segments: [{
          id: 'SEGMENT', material_id: 'VIDEO', extra_material_refs: [],
          enable_video_mask: false, speed: 1, volume: 1,
          source_timerange: { start: 0, duration: 3_000_000 },
          target_timerange: { start: 0, duration: 3_000_000 },
          clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 },
        }],
      },
    ],
  };
  for (const dir of [project, timelineDir]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(doc));
    }
  }
  fs.mkdirSync(path.join(project, 'Timelines'), { recursive: true });
  fs.writeFileSync(path.join(project, 'Timelines', 'project.json'), stableJson({
    main_timeline_id: timelineId, timelines: [{ id: timelineId }],
  }));
  fs.writeFileSync(path.join(project, 'draft_meta_info.json'), stableJson({ draft_name: doc.name }));
  fs.writeFileSync(path.join(project, 'draft_virtual_store.json'), stableJson({ draft_materials: [] }));
  return project;
}

test('field-report CLI flags parse as booleans and --into remains a target value', () => {
  const args = parseArgs(['cut', 'face.mp4', '--into', 'existing', '--keep', '0,2', '--force']);
  assert.deepEqual(args._, ['cut', 'face.mp4']);
  assert.equal(args.into, 'existing');
  assert.equal(args.keep, '0,2');
  assert.equal(args.force, true);

  const status = parseArgs(['status', '--json', '--wait-for-close']);
  assert.equal(status.json, true);
  assert.equal(status.waitForClose, true);
});

test('reviewed A-roll flags preserve order and repeated inward trims across the Node handoff', () => {
  const args = parseArgs([
    'cut', 'face.mp4', '--into', 'existing', '--review', 'decisions.json',
    '--trim-beat', '10:out=-1.16', '--trim-beat', '18:out=-1.72', '--fps', '24',
  ]);
  assert.deepEqual(args.trimBeat, ['10:out=-1.16', '18:out=-1.72']);
  assert.deepEqual(buildArrollArgs(args, 'face.mp4'), [
    'face.mp4', '--review', 'decisions.json',
    '--trim-beat', '10:out=-1.16', '--trim-beat', '18:out=-1.72', '--fps', '24',
  ]);
  const ordered = parseArgs(['cut', 'face.mp4', '--order', '2,0', '--keep', '0,2']);
  assert.deepEqual(buildArrollArgs(ordered, 'face.mp4'), [
    'face.mp4', '--keep', '0,2', '--order', '2,0',
  ]);
});

test('layout screen emits the named transactional core contract', () => {
  const spec = buildScreenLayoutSpec({
    media: 'recording.mp4', at: 2.5, duration: 8,
    sourceStart: 4, sourceDuration: 8,
    width: 720, height: 1050, mediaDuration: 20_000_000,
  });
  const op = spec.operations[0];
  assert.equal(op.op, FIELD_REPORT_OPERATIONS.screenLayout);
  assert.equal(op.op, 'layout.screen');
  assert.equal(op.preset, 'screenRecording');
  assert.equal(op.frame, 'screen-frame');
  assert.equal(op.track, 'screen');
  assert.equal(op.src, 4);
  assert.equal(op.srcDur, 8);
  assert.ok(op.media.endsWith('/recording.mp4'));
});

test('cut --into emits an anchored recut contract without project JSON writes', () => {
  const sourceToken = { ino: 1, size: 2, mtime_ns: 3, content_hash: 'same' };
  const spec = buildCutRecutSpec({
    projectDir: '/tmp/existing-project',
    planFile: '/tmp/face.plan.json',
    plan: {
      media: '/tmp/face.mp4',
      kept: [0, 2],
      order: [2, 0],
      sourceToken,
      source_token: sourceToken,
      editorial: { order: [2, 0] },
      adjustments: [{ beat: 2, offsets: { outOffset: -0.2 } }],
      repairs: ['b2 OUT 2.500 -> 2.300 (trough)'],
      duration: 4.5,
      lint: [],
      handoff: { operations: [{ op: 'clip.fade', at: 0, track: 'content', in: 0.067, out: 0.067 }] },
      timeline: [
        { beat: 0, tl_in: 0, tl_out: 2, src_in: 10, dur: 2, text: 'one' },
        { beat: 2, tl_in: 2, tl_out: 4.5, src_in: 20, dur: 2.5, text: 'two' },
      ],
    },
  });
  const op = spec.operations[0];
  assert.equal(op.op, FIELD_REPORT_OPERATIONS.cutRecut);
  assert.equal(op.op, 'cut.recut');
  assert.deepEqual(op.preserve, ['broll', 'layout', 'sfx', 'music']);
  assert.equal(op.retimeAnchored, true);
  assert.equal(op.plan.timeline.length, 2);
  assert.deepEqual(op.plan.order, [2, 0]);
  assert.deepEqual(op.plan.sourceToken, sourceToken);
  assert.deepEqual(op.plan.adjustments, [{ beat: 2, offsets: { outOffset: -0.2 } }]);
  assert.deepEqual(op.plan.repairs, ['b2 OUT 2.500 -> 2.300 (trough)']);
  assert.equal(op.audioRamps.length, 1);
  assert.match(op.planFile, /face\.plan\.json$/);
});

test('status payload is branchable and close failures retain the Builder D error shape', () => {
  const payload = statusPayload({ running: true, pids: ['42'] }, { waitForClose: true });
  assert.equal(payload.state, 'running');
  assert.equal(payload.closed, false);
  assert.deepEqual(payload.pids, ['42']);
  assert.equal(payload.waitForClose, true);

  const failure = serializeCloseFailure({
    code: 'CAPCUT_RUNNING', exitCode: 2, message: 'save dialog refused quit',
    details: { pids: ['42'] },
  });
  assert.deepEqual(failure, {
    code: 'CAPCUT_RUNNING', exitCode: 2, message: 'save dialog refused quit', details: { pids: ['42'] },
  });
});

test('main cut --into builds the recut spec and allowlists Python arroll flags', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-cli-main-'));
  const media = path.join(temp, 'face.mp4');
  const log = path.join(temp, 'python-args.json');
  const review = path.join(temp, 'decisions.json');
  fs.writeFileSync(media, 'fixture media');
  fs.writeFileSync(review, '{}');
  const project = writeCliProject(temp, media);
  const fakePython = path.join(temp, 'python3');
  fs.writeFileSync(fakePython, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "fs.writeFileSync(process.env.CAPCUT_TEST_ARG_LOG, JSON.stringify(args));",
    "const media = path.resolve(args[1]);",
    "const stem = path.basename(media).replace(/\\.[^.]+$/, '');",
    "fs.writeFileSync(path.join(path.dirname(media), stem + '.plan.json'), JSON.stringify({",
    "  media, fps: 30, kept: [0], duration: 2, lint: [],",
    "  timeline: [{ beat: 0, tl_in: 0, tl_out: 2, src_in: 0, dur: 2 }],",
    "  handoff: { operations: [{ op: 'clip.fade', at: 0, in: 0.067, out: 0.067 }] }",
    "}));",
  ].join('\n'));
  fs.chmodSync(fakePython, 0o755);

  const previousPath = process.env.PATH;
  const previousLog = process.env.CAPCUT_TEST_ARG_LOG;
  const previousCwd = process.cwd();
  let stdout = '';
  const results = [];
  const pythonArgs = [];
  const applied = [];
  process.env.PATH = `${temp}${path.delimiter}${previousPath || ''}`;
  process.env.CAPCUT_TEST_ARG_LOG = log;
  const restoreOutput = setOutput(chunk => { stdout += String(chunk); return true; });
  try {
    await main([
      'cut', media, '--into', project, '--keep', '0', '--force',
      '--force-running', '--no-backup', '--root', temp,
    ], {
      applySpec: (directory, spec, options) => {
        applied.push({ directory, spec, options });
        return { committed: true, project: directory, result: [] };
      },
    });
    results.push(JSON.parse(stdout));
    pythonArgs.push(JSON.parse(fs.readFileSync(log, 'utf8')));

    stdout = '';
    process.chdir(project);
    await main([
      'cut', media, '--in-place', '--keep', '0', '--force',
      '--force-running', '--no-backup',
    ], {
      applySpec: (directory, spec, options) => {
        applied.push({ directory, spec, options });
        return { committed: true, project: directory, result: [] };
      },
    });
    results.push(JSON.parse(stdout));
    pythonArgs.push(JSON.parse(fs.readFileSync(log, 'utf8')));

    stdout = '';
    await main([
      'cut', media, '--into', project, '--review', review, '--dry-run',
      '--force-running', '--no-backup', '--root', temp,
    ], {
      applySpec: (directory, spec, options) => {
        applied.push({ directory, spec, options });
        return { committed: false, project: directory, result: [] };
      },
    });
    results.push(JSON.parse(stdout));
    pythonArgs.push(JSON.parse(fs.readFileSync(log, 'utf8')));
  } finally {
    process.chdir(previousCwd);
    restoreOutput();
    if (previousPath == null) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog == null) delete process.env.CAPCUT_TEST_ARG_LOG;
    else process.env.CAPCUT_TEST_ARG_LOG = previousLog;
    fs.rmSync(temp, { recursive: true, force: true });
  }

  assert.equal(results.length, 3);
  assert.equal(results.slice(0, 2).every(result => result.result.committed), true);
  assert.equal(results[2].result.committed, false);
  assert.equal(applied.length, 3);
  assert.equal(applied.every(call => call.spec.operations[0].op === 'cut.recut'), true);
  assert.equal(applied.every(call => call.spec.operations[0].contract === 'cut.recut.v1'), true);
  for (const [index, args] of pythonArgs.entries()) {
    if (index < 2) {
      assert.ok(args.includes('--keep'));
      assert.ok(args.includes('--force'));
    }
    for (const forbidden of ['--into', '--in-place', '--root', '--force-running', '--no-backup']) {
      assert.equal(args.includes(forbidden), false, `Python must not receive ${forbidden}`);
    }
  }
  const reviewArgs = pythonArgs[2];
  assert.equal(reviewArgs.includes('--keep'), false);
  assert.deepEqual(reviewArgs.slice(reviewArgs.indexOf('--review'), reviewArgs.indexOf('--review') + 2), [
    '--review', review,
  ]);
});

test('direct cut --project forwards review and dry-run flags to the Python editor', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-cli-project-'));
  const media = path.join(temp, 'face.mp4');
  const review = path.join(temp, 'decisions.json');
  const log = path.join(temp, 'python-args.json');
  const fakePython = path.join(temp, 'python3');
  fs.writeFileSync(media, 'fixture media');
  fs.writeFileSync(review, '{}');
  fs.writeFileSync(fakePython, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.CAPCUT_TEST_ARG_LOG, JSON.stringify(process.argv.slice(2)));",
  ].join('\n'));
  fs.chmodSync(fakePython, 0o755);

  const run = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'capcutctl.mjs'),
    'cut', media, '--review', review, '--project', 'A-roll Review', '--dry-run',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${temp}${path.delimiter}${process.env.PATH || ''}`,
      CAPCUT_TEST_ARG_LOG: log,
    },
  });
  try {
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const args = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(args[1], media);
    assert.deepEqual(args.slice(args.indexOf('--review'), args.indexOf('--review') + 2), [
      '--review', review,
    ]);
    assert.deepEqual(args.slice(args.indexOf('--project'), args.indexOf('--project') + 2), [
      '--project', 'A-roll Review',
    ]);
    assert.ok(args.includes('--dry-run'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('preview rejects zero and non-finite FPS instead of silently using 6', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-preview-fps-'));
  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'draft_info.json'), '{}');
  try {
    for (const fps of ['0', 'Infinity', '-1']) {
      const run = spawnSync(process.execPath, [
        path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'capcutctl.mjs'),
        'preview', '--project', project, '--fps', fps,
      ], { encoding: 'utf8' });
      assert.equal(run.status, 2);
      assert.match(run.stderr, /preview requires --fps greater than zero/);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('help and layout list expose the supported screen and automatic QA surface', async () => {
  let output = '';
  const restoreOutput = setOutput(chunk => { output += String(chunk); return true; });
  try {
    await main(['help']);
    assert.match(output, /--at-cuts/);
    assert.match(output, /--at-scenes/);
    assert.match(output, /--at-broll/);
    assert.match(output, /layout screen.*--media FILE/);
    assert.match(output, /--src S.*--src-dur S/);

    output = '';
    await main(['layout', 'list']);
    const rows = JSON.parse(output);
    assert.ok(rows.some(row => row.name === 'screenRecording'));
  } finally {
    restoreOutput();
  }
});

test('the check script syntax-checks the shipped review module', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.check, /node --check src\/review\.mjs/);
});
