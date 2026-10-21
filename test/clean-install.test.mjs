import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');

/**
 * "Someone installs this and it works", proved against the artefact rather than the clone.
 *
 * Everything else in the suite runs from the repository, where every file exists whether or
 * not `files` in package.json ships it. That is exactly the gap where a tool resolves a
 * preset from a path that is not in the tarball, and the failure only ever reproduces on a
 * stranger's machine. So: pack, unpack somewhere else, point HOME at an empty directory,
 * and drive the packed binary.
 *
 * Bounded on purpose — help, preflight, and one synthetic project. Nothing here transcribes,
 * downloads a model, or touches a real CapCut library.
 */

let packed = null;

/** Pack once and unpack into a throwaway prefix. Returns null if the tools are unavailable. */
function packageSandbox() {
  if (packed !== null) return packed;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-packed-'));
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', sandbox], {
    cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 180_000,
  });
  if (pack.error || pack.status !== 0) {
    fs.rmSync(sandbox, { recursive: true, force: true });
    packed = { skip: `npm pack failed: ${pack.error?.message || pack.stderr}` };
    return packed;
  }
  let tarball;
  try {
    tarball = path.join(sandbox, JSON.parse(pack.stdout)[0].filename);
  } catch (error) {
    packed = { skip: `could not read npm pack output: ${error.message}` };
    return packed;
  }
  const extract = spawnSync('tar', ['-xzf', tarball, '-C', sandbox], { encoding: 'utf8', timeout: 120_000 });
  if (extract.error || extract.status !== 0) {
    packed = { skip: `tar unavailable: ${extract.error?.message || extract.stderr}` };
    return packed;
  }
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(home, { recursive: true });
  packed = {
    root: sandbox,
    home,
    bin: path.join(sandbox, 'package', 'bin', 'capcutctl.mjs'),
    dir: path.join(sandbox, 'package'),
  };
  return packed;
}

/** Run the packed binary with a sandboxed HOME and no inherited capcutctl configuration. */
function runPacked(box, args, extraEnv = {}) {
  const env = { ...process.env, HOME: box.home, ...extraEnv };
  // A stray override from the developer's shell would make this test prove nothing.
  for (const key of ['CAPCUTCTL_ASSET_DIR', 'CAPCUTCTL_PRESET_DIR', 'CAPCUTCTL_PYTHON']) {
    if (!(key in extraEnv)) delete env[key];
  }
  // Send the child's coverage somewhere the test runner never reads.
  //
  // Under `node --test --experimental-test-coverage` each test file runs with
  // NODE_V8_COVERAGE pointing at the run's collection directory, and children inherit it.
  // The unpacked copy of src/*.mjs then reports as a second, barely-exercised set of files
  // and drags the total from ~89% to ~67% — a measurement artefact that reads exactly like
  // a coverage regression. Deleting the variable is not enough (the runner supplies it per
  // file), so point it at a directory that is thrown away with the sandbox.
  const dropped = path.join(box.root, 'coverage-discard');
  fs.mkdirSync(dropped, { recursive: true });
  env.NODE_V8_COVERAGE = dropped;
  return spawnSync(process.execPath, [box.bin, ...args], { encoding: 'utf8', env, timeout: 180_000 });
}

test('the packed tarball runs help and preflight from a sandboxed HOME', t => {
  const box = packageSandbox();
  if (box.skip) return t.skip(box.skip);

  const help = runPacked(box, ['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /capcutctl — transactional CapCut timeline control/);

  // preflight must produce a verdict, not a crash, on a machine with no CapCut at all.
  const drafts = path.join(box.root, 'no-such-capcut');
  const pre = runPacked(box, ['preflight', '--json', '--root', drafts]);
  const report = JSON.parse(pre.stdout);
  assert.equal(typeof report.ok, 'boolean');

  const byName = new Map(report.checks.map(check => [check.name, check]));
  // The runtime contract is reported from the package, not only from a clone.
  assert.ok(byName.has('Python runtime'), 'preflight must report the resolved interpreter');
  assert.ok(byName.has('Python runtime dependencies'));
  // An empty HOME has no profile plate: reported as a choice, never a failure.
  assert.equal(byName.get('background plate')?.ok, true);
  assert.equal(byName.get('background plate')?.blocking, false);
  assert.equal(byName.get('Caption generation')?.blocking, false);
  // The bundled overlays are in the tarball, so these pass with no setup whatsoever.
  assert.equal(byName.get('asset: suheilai-circle-white-1080x1920.png')?.ok, true,
    'the overlay artwork must ship in the package');

  // A missing CapCut library is reported as missing — never as ready.
  assert.equal(byName.get('CapCut drafts folder')?.ok, false);
  assert.equal(report.ok, false, 'no drafts folder cannot be an overall pass');
  for (const check of report.checks) {
    if (!check.ok && check.blocking !== false) {
      assert.ok(check.fix, `a blocking failure must carry a fix: ${check.name}`);
    }
  }
});

test('the packed tarball builds and reads a synthetic project with no CapCut installed', t => {
  const box = packageSandbox();
  if (box.skip) return t.skip(box.skip);

  const drafts = path.join(box.root, 'drafts');
  // --blank is the documented path that needs no local draft to clone from.
  // The sandbox has no CapCut installation; a host process may still be open.
  const made = runPacked(box, ['new', '--blank', '--project', 'Packed Check', '--root', drafts, '--force-running']);
  assert.equal(made.status, 0, made.stderr);
  const created = JSON.parse(made.stdout);
  assert.equal(created.created, true);
  assert.ok(fs.existsSync(path.join(created.project, 'draft_info.json')));

  const doctored = runPacked(box, ['doctor', '--project', 'Packed Check', '--root', drafts, '--json']);
  assert.equal(doctored.status, 0, doctored.stderr);
  const health = JSON.parse(doctored.stdout);
  assert.ok(Array.isArray(health.findings) || typeof health === 'object');
});

test('the packed tarball ships no private catalogue, media, or local paths', t => {
  const box = packageSandbox();
  if (box.skip) return t.skip(box.skip);

  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(box.dir);
  const relative = files.map(file => path.relative(box.dir, file));

  // The harvested catalogue is one person's draft library. package.json excludes it; this
  // is the assertion that keeps the exclusion true after someone edits that list.
  assert.ok(!relative.includes(path.join('presets', 'harvest.json')),
    'presets/harvest.json is a private draft catalogue and must never ship');
  for (const name of ['.env', '.env.local']) {
    assert.ok(!relative.includes(name), `${name} must never ship`);
  }
  assert.ok(!relative.some(file => /\.(mp4|mov|wav|m4a|srt|vtt)$/i.test(file)),
    'no media or transcripts in the package');
  assert.ok(!relative.some(file => file.startsWith('test' + path.sep) || file.includes('__pycache__')),
    'tests and caches are not part of the distributed tool');

  // Text scan: an absolute home directory baked into a shipped file is a dead path on every
  // machine but one. Preset *search* paths are relative-by-design and expanded at runtime.
  const offenders = [];
  for (const file of files) {
    if (/\.(png|jpg|jpeg|mp4|mov|tgz)$/i.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of [/\/Users\/[a-z]/i, /\/home\/[a-z]/i, /[A-Z]:\\\\Users\\\\/i]) {
      const hit = text.match(pattern);
      if (hit) offenders.push(`${path.relative(box.dir, file)}: ${hit[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'no absolute user paths may ship in the package');
});

test('doctor exits unsuccessfully when the project contains structural errors', t => {
  const box = packageSandbox();
  if (box.skip) return t.skip(box.skip);
  const project = path.join(box.root, 'broken-project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'draft_info.json'), JSON.stringify({
    id: 'broken', name: 'Broken', tracks: [], duration: 0,
    materials: { videos: [{ id: 'missing', type: 'video', path: path.join(project, 'missing.mp4') }] },
  }));
  const run = runPacked(box, ['doctor', '--project', project, '--json']);
  const report = JSON.parse(run.stdout);
  assert.ok(report.errors > 0);
  assert.equal(run.status, 1, run.stderr);
});

test('preflight reports the room plate and background pipeline without ever blocking', async () => {
  const { preflight, preflightBackground } = await import('../src/core.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-preflight-bg-'));
  const plate = path.join(root, 'room.png');
  fs.writeFileSync(plate, 'png');
  const pipeline = path.join(root, 'comp.py');
  const run = (profile, { importsOk = true, present = null } = {}) => {
    const calls = [];
    const background = options => preflightBackground({
      ...options,
      profileValue: (key, fallback) => {
        const leaf = key.replace(/^brand\.background\./, '');
        return leaf in profile ? profile[leaf] : fallback;
      },
      exists: file => (present ? present.has(file) : fs.existsSync(file)),
      commandRunner: (command, args) => {
        calls.push({ command, args });
        return importsOk ? { ok: true } : { ok: false, detail: "No module named 'torch'" };
      },
    });
    const report = preflight({
      root,
      binaryCheck: () => true,
      pythonCheck: () => ([
        { name: 'Python runtime', ok: true, detail: 'stub', interpreter: '/stub/python3', version: '3.12.0', source: 'stub' },
        { name: 'Python runtime dependencies', ok: true, detail: 'stub', missing: [] },
      ]),
      commandRunner: command => (command === 'ffprobe' ? { ok: true, stdout: '2,2\n' } : { ok: true, stdout: '' }),
      statfs: () => ({ bsize: 4096, bavail: 1024 * 1024 }),
      mographCheck: () => ({ ok: true, detail: 'stub' }),
      backgroundCheck: background,
    });
    const rows = report.checks.filter(c => c.name.startsWith('background'));
    assert.ok(rows.length, 'background rows are reported');
    assert.ok(rows.every(c => c.blocking === false), 'background rows never block');
    return { report, byName: new Map(rows.map(c => [c.name, c])), calls };
  };

  const unset = run({});
  assert.equal(unset.report.ok, true, 'the stubbed machine is otherwise ready');
  assert.equal(unset.byName.get('background plate').ok, true);
  assert.match(unset.byName.get('background plate').detail, /left as shot/);
  assert.equal(unset.byName.has('background pipeline'), false);

  const missingPlate = run({ plate: path.join(root, 'gone.png') });
  assert.equal(missingPlate.byName.get('background plate').ok, false);
  assert.ok(missingPlate.byName.get('background plate').fix);
  assert.equal(missingPlate.report.ok, true);

  const folderPlate = run({ plate: root });
  assert.equal(folderPlate.byName.get('background plate').ok, false);
  assert.match(folderPlate.byName.get('background plate').detail, /not a file/);

  const missingPipeline = run({ plate, pipeline: path.join(root, 'no-comp.py') });
  assert.equal(missingPipeline.byName.get('background plate').ok, true);
  assert.equal(missingPipeline.byName.get('background pipeline').ok, false);
  assert.equal(missingPipeline.report.ok, true);

  fs.writeFileSync(pipeline, '# pipeline');
  const weights = path.join(root, 'rvm.pth');
  const failing = run({ plate, pipeline, python: '/venv/bin/python', requires: ['torch', 'cv2'], weights: [weights] },
    { importsOk: false, present: new Set([plate, pipeline, '/venv/bin/python']) });
  assert.equal(failing.byName.get('background pipeline').ok, true);
  assert.equal(failing.byName.get('background pipeline imports').ok, false);
  assert.match(failing.byName.get('background pipeline imports').fix, /installs nothing/);
  assert.equal(failing.byName.get('background pipeline weights').ok, false);
  assert.ok(failing.calls.some(c => c.command === '/venv/bin/python' && c.args.join(' ') === '-c import torch, cv2'),
    'the import check runs under the pipeline interpreter');
  assert.equal(failing.report.ok, true);

  const passing = run({ plate, pipeline, requires: 'torch' });
  assert.equal(passing.byName.get('background pipeline imports').ok, true);
  assert.ok(passing.calls.some(c => c.command === '/stub/python3'), 'falls back to the resolved interpreter');

  const unsafe = run({ plate, requires: ['os; print(1)'] });
  assert.equal(unsafe.byName.get('background pipeline imports').ok, false);
  assert.equal(unsafe.calls.length, 0, 'a non-module name is never executed');
  fs.rmSync(root, { recursive: true, force: true });
});
