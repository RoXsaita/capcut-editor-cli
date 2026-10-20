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
  hasEditorialDecision,
  isInPlaceCut,
  main,
  parseArgs,
  serializeCloseFailure,
  statusPayload,
  setOutput,
} from '../src/cli.mjs';
import { resetPythonCache, resolvePython } from '../src/python.mjs';
import { writeCliProject } from './helpers/cli-project.mjs';

const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A stand-in interpreter for the Python handoff tests.
 *
 * Since the runtime contract landed, the CLI no longer spawns whatever `python3` PATH
 * offers — it resolves a declared interpreter and proves it can import what the tool needs.
 * So a shim has to answer the two probes src/python.mjs makes before it is handed a script:
 * a version query (`-c SCRIPT`) and an import query (`-c SCRIPT mod...`). Tests then point
 * CAPCUTCTL_PYTHON at the shim, which is the documented override rather than a PATH trick.
 */
function writeFakePython(file, bodyLines = []) {
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    "if (args[0] === '-c') {",
    // Two arguments is the version probe; anything more is the import probe, and this
    // interpreter claims to import everything so the tool under test is actually reached.
    "  if (args.length === 2) process.stdout.write(JSON.stringify({ v: [3, 12, 0], x: process.argv[1] }));",
    "  else process.stdout.write('[]');",
    '  process.exit(0);',
    '}',
    ...bodyLines,
  ].join('\n'));
  fs.chmodSync(file, 0o755);
}


test('main cut --into builds the recut spec and allowlists Python arroll flags', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-cli-main-'));
  const media = path.join(temp, 'face.mp4');
  const log = path.join(temp, 'python-args.json');
  const review = path.join(temp, 'decisions.json');
  fs.writeFileSync(media, 'fixture media');
  fs.writeFileSync(review, '{}');
  const project = writeCliProject(temp, media);
  const fakePython = path.join(temp, 'python3');
  writeFakePython(fakePython, [
    "fs.writeFileSync(process.env.CAPCUT_TEST_ARG_LOG, JSON.stringify(args));",
    "const media = path.resolve(args[1]);",
    "const stem = path.basename(media).replace(/\\.[^.]+$/, '');",
    "fs.writeFileSync(path.join(path.dirname(media), stem + '.plan.json'), JSON.stringify({",
    "  media, fps: 30, kept: [0], duration: 2, lint: [],",
    "  timeline: [{ beat: 0, tl_in: 0, tl_out: 2, src_in: 0, dur: 2 }],",
    "  handoff: { operations: [{ op: 'clip.fade', at: 0, in: 0.067, out: 0.067 }] }",
    "}));",
  ]);

  const previousPython = process.env.CAPCUTCTL_PYTHON;
  const previousLog = process.env.CAPCUT_TEST_ARG_LOG;
  const previousCwd = process.cwd();
  let stdout = '';
  const results = [];
  const pythonArgs = [];
  const applied = [];
  process.env.CAPCUTCTL_PYTHON = fakePython;
  resetPythonCache();
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
    if (previousPython == null) delete process.env.CAPCUTCTL_PYTHON;
    else process.env.CAPCUTCTL_PYTHON = previousPython;
    resetPythonCache();
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
  writeFakePython(fakePython, [
    "fs.writeFileSync(process.env.CAPCUT_TEST_ARG_LOG, JSON.stringify(args));",
  ]);

  const run = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'capcutctl.mjs'),
    'cut', media, '--review', review, '--project', 'A-roll Review', '--dry-run',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CAPCUTCTL_PYTHON: fakePython,
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

test('preview forwards bounded proxy controls to the streamed QA worker', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-preview-options-'));
  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'draft_info.json'), '{}');
  const log = path.join(temp, 'args.json');
  const fakePython = path.join(temp, 'python3');
  writeFakePython(fakePython, [
    "fs.writeFileSync(process.env.CAPCUT_TEST_ARG_LOG, JSON.stringify(args));",
  ]);
  try {
    const run = spawnSync(process.execPath, [
      path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'capcutctl.mjs'),
      'preview', '--project', project, '--out', path.join(temp, 'review.mp4'), '--fps', '6',
      '--from', '2', '--to', '5', '--resolution', '540x960', '--native', '--no-cache', '--no-grade',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPCUTCTL_PYTHON: fakePython,
        CAPCUT_TEST_ARG_LOG: log,
      },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const args = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.ok(args.includes('--resolution') && args.includes('540x960'));
    assert.ok(args.includes('--native'));
    assert.ok(args.includes('--no-cache'));
    assert.ok(args.includes('--no-grade'));
    assert.deepEqual(args.slice(args.indexOf('--from'), args.indexOf('--from') + 2), ['--from', '2']);
    assert.deepEqual(args.slice(args.indexOf('--to'), args.indexOf('--to') + 2), ['--to', '5']);
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
    assert.match(output, /--resolution 360x640/);
    assert.match(output, /--no-cache/);
    assert.match(output, /layout screen.*--media FILE/);
    assert.match(output, /--src S.*--src-dur S/);

    output = '';
    await main(['layout', 'list']);
    const rows = JSON.parse(output);
    // Named as `layout <name>` accepts it, so a reader can copy the row straight into a command.
    assert.ok(rows.some(row => row.name === 'screen' && row.preset === 'screenRecording'));
    assert.ok(rows.some(row => row.name === 'full-face'));
  } finally {
    restoreOutput();
  }
});

test('the check script syntax-checks every shipped src module', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.check, /src\/\*\.mjs/);
});

test('bootstrap version works and failed JSON preflight remains branchable by exit code', () => {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'capcutctl.mjs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), pkg.version);

  const missing = path.join(os.tmpdir(), `capcutctl-missing-${process.pid}`);
  const preflight = spawnSync(process.execPath, [cli, 'preflight', '--root', missing, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(preflight.status, 1, preflight.stderr || preflight.stdout);
  assert.equal(JSON.parse(preflight.stdout).ok, false);

  for (const argv of [['preflight', '--jsoon', 'yes'], ['preflight', 'extra']]) {
    const invalid = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8' });
    assert.equal(invalid.status, 2, invalid.stderr || invalid.stdout);
  }
});

test('status preserves unknown process state and rejects ignored arguments', () => {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'capcutctl.mjs');
  const unknown = spawnSync(process.execPath, [cli, 'status', '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });
  assert.equal(unknown.status, 3, unknown.stderr || unknown.stdout);
  const payload = JSON.parse(unknown.stdout);
  assert.equal(payload.state, 'unknown');
  assert.equal(payload.closed, false);
  assert.equal(payload.ok, false);

  for (const argv of [
    ['status', 'extra'],
    ['status', '--jsoon', 'yes'],
    ['status', '--timeout', '1'],
    ['status', '--wait-for-close', '--timeout', 'nope'],
  ]) {
    const invalid = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8' });
    assert.equal(invalid.status, 2, invalid.stderr || invalid.stdout);
  }
});


test('cut --into=P routes to the transactional recut, and --recover-beat alone is a decision', () => {
  const args = parseArgs(['cut', 'v.mp4', '--into=P', '--recover-beat=3:out=0.8']);
  assert.equal(args.into, 'P');
  assert.deepEqual(args.recoverBeat, ['3:out=0.8']);
  // `--into=P` used to miss the router and reach aroll.py, which laid fades over the old cut.
  assert.equal(isInPlaceCut(['cut', 'v.mp4', '--into=P']), true);
  assert.equal(isInPlaceCut(['cut', 'v.mp4', '--in-place']), true);
  assert.equal(isInPlaceCut(['cut', 'v.mp4', '--project', 'P']), false);
  assert.equal(hasEditorialDecision({ recoverBeat: ['3:out=0.8'] }), true);
  assert.equal(hasEditorialDecision({ trimBeat: [] }), false);
  assert.equal(hasEditorialDecision({}), false);
  // A boolean given a value is a mistake, not `true`.
  assert.throws(() => parseArgs(['cut', 'v.mp4', '--force=yes']), error => error.exitCode === 2);
});

test('aroll.py refuses --into unless capcutctl cut routed it there', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-aroll-into-'));
  try {
    const media = path.join(temp, 'face.mp4');
    fs.writeFileSync(media, 'fixture media');
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'aroll.py');
    const env = { ...process.env };
    delete env.CAPCUTCTL_IN_PLACE_CUT;
    const run = spawnSync(resolvePython().executable, [script, media, '--into', path.join(temp, 'project'), '--keep', '0'],
      { encoding: 'utf8', env });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /capcutctl cut VIDEO --into PROJECT/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Python tools call back into THIS capcutctl, and cut forwards --root and --force-running', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-tool-env-'));
  const media = path.join(temp, 'face.mp4');
  const log = path.join(temp, 'python-call.json');
  const fakePython = path.join(temp, 'python3');
  fs.writeFileSync(media, 'fixture media');
  writeFakePython(fakePython, [
    "fs.writeFileSync(process.env.CAPCUT_TEST_ARG_LOG, JSON.stringify({ args,",
    "  node: process.env.CAPCUTCTL_NODE, bin: process.env.CAPCUTCTL_BIN }));",
  ]);
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'capcutctl.mjs');
  const run = spawnSync(process.execPath, [
    bin, 'cut', media, '--keep', '0', '--project', 'A-roll', '--root', temp, '--force-running', '--dry-run',
  ], { encoding: 'utf8', env: { ...process.env, CAPCUTCTL_PYTHON: fakePython, CAPCUT_TEST_ARG_LOG: log } });
  try {
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const call = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(fs.realpathSync(call.bin), fs.realpathSync(bin), 'CAPCUTCTL_BIN names this checkout');
    assert.equal(call.node, process.execPath);
    assert.deepEqual(call.args.slice(call.args.indexOf('--root'), call.args.indexOf('--root') + 2), ['--root', temp]);
    assert.ok(call.args.includes('--force-running'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
