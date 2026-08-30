import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUNDLED_ASSET_DIR, assetSearchRoots, loadPreset, preflight, presetFile, hasBinary,
} from '../src/core.mjs';

/**
 * These guard the answer to "someone clones this and it works".
 *
 * Three things were only true on the machine that wrote them: the layout overlays lived in one
 * person's ~/Downloads, the SFX palette pointed into their CapCut effect cache, and ffmpeg was
 * assumed. The first failed halfway through a layout, the second killed a whole polish
 * transaction with twelve MISSING_MEDIA errors, and the third surfaced as `spawnSync ENOENT`.
 */

test('the overlays the built-in layouts need ship with the package', () => {
  for (const basename of [
    'suheilai-rect-indigo-1080x1920 (2).png',
    'suheilai-circle-white-1080x1920.png',
  ]) {
    const file = path.join(BUNDLED_ASSET_DIR, basename);
    assert.ok(fs.existsSync(file), `${basename} must be bundled, not fetched from a home directory`);
    // A truncated or placeholder file would resolve and then render nothing.
    assert.ok(fs.statSync(file).size > 10_000, `${basename} looks empty`);
  }
});

test('the bundle is searched before any home directory, and after an explicit override', () => {
  const previous = process.env.CAPCUTCTL_ASSET_DIR;
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-assets-'));
  try {
    process.env.CAPCUTCTL_ASSET_DIR = mine;
    const roots = assetSearchRoots(['~/Downloads/Media/Images/2026']);
    assert.equal(roots[0], path.resolve(mine), 'your own artwork wins');
    assert.equal(roots[1], path.resolve(BUNDLED_ASSET_DIR), 'then what ships with the tool');
    assert.ok(roots.indexOf(path.resolve(BUNDLED_ASSET_DIR))
      < roots.indexOf(path.join(os.homedir(), 'Downloads/Media/Images/2026')),
      'a home directory is the last resort, never a requirement');
  } finally {
    if (previous == null) delete process.env.CAPCUTCTL_ASSET_DIR;
    else process.env.CAPCUTCTL_ASSET_DIR = previous;
  }
});

test('CAPCUTCTL_PRESET_DIR overrides one preset and falls back for the rest', () => {
  const previous = process.env.CAPCUTCTL_PRESET_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-presets-'));
  try {
    fs.writeFileSync(path.join(dir, 'sfx.json'), JSON.stringify({ audioTemplates: {}, transitionTemplates: {} }));
    process.env.CAPCUTCTL_PRESET_DIR = dir;
    assert.equal(presetFile('sfx'), path.join(dir, 'sfx.json'), 'the override is used when present');
    // layouts.json is NOT in the override dir, so it must still resolve to the bundled one —
    // otherwise pointing at your own SFX would silently take the layouts with it.
    assert.match(presetFile('layouts'), /presets[/\\]layouts\.json$/);
    assert.ok(loadPreset('layouts').layouts, 'the bundled layouts still load');
  } finally {
    if (previous == null) delete process.env.CAPCUTCTL_PRESET_DIR;
    else process.env.CAPCUTCTL_PRESET_DIR = previous;
  }
});

test('no preset points at a literal home directory — every path is ~/ or bundled', () => {
  for (const name of ['layouts', 'sfx', 'brands', 'signature']) {
    const raw = fs.readFileSync(presetFile(name), 'utf8');
    const leaked = [...raw.matchAll(/\/Users\/[A-Za-z0-9._-]+/g)].map(m => m[0]);
    assert.deepEqual([...new Set(leaked)], [], `${name}.json hardcodes a user's home directory`);
  }
});

test('preflight names every environment problem and the command that fixes it', () => {
  const report = preflight();
  const byName = new Map(report.checks.map(c => [c.name, c]));

  for (const basename of [
    'asset: suheilai-rect-indigo-1080x1920 (2).png',
    'asset: suheilai-circle-white-1080x1920.png',
  ]) {
    assert.equal(byName.get(basename)?.ok, true, 'bundled assets resolve with no setup at all');
  }

  assert.ok(byName.has('ffmpeg') && byName.has('ffprobe'));
  assert.equal(byName.get('ffmpeg').ok, hasBinary('ffmpeg'));

  // Every failing check must carry a fix — a preflight that only says "no" is the ENOENT
  // problem with extra steps.
  for (const check of report.checks) {
    if (!check.ok) assert.ok(check.fix, `${check.name} reports a problem with no fix`);
  }

  // The SFX palette is CapCut's per-machine cache, so it is reported but never blocking:
  // polish placing no sounds is a degraded edit, not a broken install.
  const sfx = report.checks.find(c => c.name === 'sfx palette');
  assert.ok(sfx, 'the palette is reported');
  if (!sfx.ok) assert.equal(report.ok, hasBinary('ffmpeg') && hasBinary('ffprobe') && report.ok);
});

test('preflight exercises the toolchain and reports writable disk capacity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-preflight-'));
  const calls = [];
  const binaries = new Set(['ffmpeg', 'ffprobe', 'mlx_whisper', 'python3', 'swiftc']);
  const report = preflight({
    root,
    binaryCheck: name => binaries.has(name),
    commandRunner: (command, args) => {
      calls.push({ command, args });
      return command === 'ffprobe' ? { ok: true, stdout: '2,2\n' } : { ok: true, stdout: '' };
    },
    statfs: directory => {
      assert.equal(directory, root);
      return { bsize: 4096, bavail: 1024 * 1024 };
    },
  });
  const byName = new Map(report.checks.map(c => [c.name, c]));

  assert.equal(byName.get('ffmpeg probe')?.ok, true);
  assert.equal(byName.get('ffprobe probe')?.ok, true);
  assert.equal(byName.get('Whisper/MLX transcription')?.ok, true);
  assert.equal(byName.get('CapCut drafts folder write permission')?.ok, true);
  assert.equal(byName.get('free disk space')?.ok, true);
  assert.ok(calls.some(c => c.command === 'ffmpeg' && c.args.includes('lavfi')),
    'ffmpeg preflight must execute a synthetic frame probe');
  assert.ok(calls.some(c => c.command === 'ffprobe' && c.args.includes('-show_entries')),
    'ffprobe preflight must inspect a real input');
  assert.ok(calls.some(c => c.command === 'mlx_whisper' && c.args.includes('--help')),
    'MLX preflight must start the executable');
  assert.ok(calls.some(c => c.command === 'python3' && c.args.includes('import whisper')),
    'fallback Whisper preflight must import the module');
});

test('preflight fails closed when a probe hangs or the drafts volume is full', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-preflight-fail-'));
  const report = preflight({
    root,
    binaryCheck: () => true,
    commandRunner: command => command === 'ffmpeg'
      ? { ok: false, detail: 'timed out after 5000ms (SIGKILL)' }
      : command === 'ffprobe' ? { ok: true, stdout: '2,2\n' } : { ok: true, stdout: '' },
    statfs: () => ({ bsize: 4096, bavail: 1 }),
    writeProbe: () => ({ ok: false, detail: 'write probe failed: EACCES' }),
  });
  const byName = new Map(report.checks.map(c => [c.name, c]));

  assert.equal(report.ok, false);
  assert.equal(byName.get('ffmpeg probe')?.ok, false);
  assert.match(byName.get('ffmpeg probe')?.detail || '', /timed out/);
  assert.equal(byName.get('free disk space')?.ok, false);
  assert.equal(byName.get('CapCut drafts folder write permission')?.ok, false);
  for (const name of ['ffmpeg probe', 'free disk space', 'CapCut drafts folder write permission']) {
    assert.ok(byName.get(name)?.fix, `${name} must include a repair instruction`);
  }
});

test('polish skips sounds this machine does not have instead of writing broken references', async () => {
  // The failure this replaces: on any machine but the one the palette was harvested from,
  // `polish` wrote every reference anyway and the transaction died with
  // "Transaction failed validation with 12 error(s)" — a valid project refusing to be polished
  // because of someone else's ~/Library. Now the sounds that are missing are skipped and named.
  const previous = process.env.CAPCUTCTL_PRESET_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-absent-sfx-'));
  try {
    const palette = JSON.parse(fs.readFileSync(path.join(BUNDLED_ASSET_DIR, '..', 'presets', 'sfx.json'), 'utf8'));
    for (const kind of ['audioTemplates', 'transitionTemplates']) {
      for (const template of Object.values(palette[kind] || {})) {
        if (template.path) template.path = path.join(dir, 'this-sound-is-not-here.mp3');
      }
    }
    fs.writeFileSync(path.join(dir, 'sfx.json'), JSON.stringify(palette));
    process.env.CAPCUTCTL_PRESET_DIR = dir;

    const { buildProject } = await import('./helpers/polish-project.mjs');
    const { applySpec, doctor } = await import('../src/core.mjs');
    const project = buildProject();

    const result = applySpec(project, { version: 1, operations: [{ op: 'polish' }] }, { forceRunning: true });
    const polish = (result.result || []).find(g => g.group === 'root')?.operations?.[0];

    assert.equal(polish.sfx, 0, 'nothing was placed');
    assert.ok(polish.unavailableSfx?.length, 'and the run said which sounds it could not find');

    const report = doctor(project);
    assert.equal(report.errors, 0, JSON.stringify(report.issues.slice(0, 3), null, 2));
    assert.equal(report.issues.filter(i => i.code === 'MISSING_MEDIA').length, 0,
      'no reference was written to a file that is not there');
  } finally {
    if (previous == null) delete process.env.CAPCUTCTL_PRESET_DIR;
    else process.env.CAPCUTCTL_PRESET_DIR = previous;
  }
});

test('new --blank works on a machine with no CapCut drafts at all', async () => {
  // `--blank` is the documented route for someone building their own style, but it still cloned
  // "Preset 3" for the document SHAPE — so on a fresh install, where no draft exists, it failed
  // with NO_TEMPLATE and there was no way to create a project at all. The bundled skeleton is
  // that shape, harvested from a real draft and stripped of its identity, media and segments.
  const { createProject } = await import('../src/create.mjs');
  const { readJson } = await import('../src/core.mjs');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-empty-root-'));
  const media = path.join(root, 'face.mp4');
  fs.writeFileSync(media, 'face-bytes');

  const created = createProject('fresh', {
    root, blank: true, forceRunning: true, media,
    scenes: '0:4,4:8', width: 1440, height: 2560, duration: 30,
  });

  const doc = readJson(path.join(created.project, 'draft_info.json'));
  const content = doc.tracks.filter(t => t.type === 'video' && (t.segments || []).length);
  assert.equal(content.length, 1, 'the scenes landed on exactly one track');
  assert.equal(content[0].segments.length, 2);
  assert.equal(doc.tracks[0].flag, 0, 'the main/cover track is still track 0');
  assert.equal(doc.tracks[0].segments.length, 0, 'and it stays empty');

  // addScenes pushes its own 'content' track, so keeping the skeleton's shell too used to leave
  // a stray empty lane sitting above the real one in CapCut.
  const empties = doc.tracks.filter(t => t.type === 'video' && t.flag === 2 && !(t.segments || []).length);
  assert.deepEqual(empties, [], 'no stray empty overlay lane');
});

test('the bundled draft skeleton carries no trace of the project it was harvested from', () => {
  const raw = fs.readFileSync(presetFile('blank-draft'), 'utf8');
  assert.equal(raw.match(/\/Users\//g), null, 'no home directory');
  const skeleton = JSON.parse(raw);
  assert.equal(skeleton.name, '');
  assert.equal(skeleton.path, '');
  assert.equal(skeleton.duration, 0);
  for (const [bucket, value] of Object.entries(skeleton.materials)) {
    if (Array.isArray(value)) assert.equal(value.length, 0, `materials.${bucket} must be empty`);
  }
  for (const track of skeleton.tracks) {
    assert.equal(track.segments.length, 0, 'track shells carry no segments');
  }
  // The two templates new scenes are modelled on must survive the stripping.
  assert.ok(skeleton.segmentTemplate && skeleton.videoMaterialTemplate);
  assert.equal(skeleton.videoMaterialTemplate.path, '');
});
