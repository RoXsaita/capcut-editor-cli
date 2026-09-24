import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { checkExportReport, checkExportText, expectedDelivery, maxGap, projectPacing, referenceReport } from '../src/media-check.mjs';
import { loadProfile } from '../src/profile.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { buildProject } from './helpers/polish-project.mjs';

const profile = loadProfile();

function scan(overrides = {}) {
  return {
    media: '/tmp/reel.mp4', duration: 20, width: 1080, height: 1920, fps: 30,
    videoCodec: 'h264', pixFmt: 'yuv420p', hasAudio: true, audioCodec: 'aac', sampleRate: 48000,
    cuts: [], builds: [], black: [], freezes: [], flashes: [], silences: [],
    loudness: { lufs: -14.2, truePeak: -1.4, lra: 4 },
    ...overrides,
  };
}

const at = (...times) => times.map(t => ({ t, score: 0.5 }));

test('maxGap counts both ends of the window', () => {
  assert.deepEqual(maxGap([2, 3], 0, 10), { gap: 7, from: 3, to: 10 });
  assert.deepEqual(maxGap([], 0, 4), { gap: 4, from: 0, to: 4 });
  assert.deepEqual(maxGap([5, 1], 0, 6), { gap: 4, from: 1, to: 5 });
});

test('reference: pace in the gate\'s terms, and a density override from it', () => {
  const s = scan({ cuts: at(0.4, 2, 4, 6, 9, 12, 15, 18), builds: at(1, 1.5, 3, 7) });
  const report = referenceReport(s, { profile });
  assert.equal(report.measured.shots, 9);
  assert.equal(report.measured.cutsPerSecond, 0.4);
  assert.equal(report.measured.eventsPerSecond, 0.6);
  assert.equal(report.measured.firstEvent, 0.4);
  assert.deepEqual(report.measured.longestStatic, { gap: 3, from: 9, to: 12 });
  assert.equal(report.measured.medianShot, 2);
  assert.deepEqual(report.override.density, { hookEventBy: 0.4, openingMaxGap: 2, maxStatic: 3 });
  const maxStatic = report.compare.find(row => row.profileKey === 'density.maxStatic');
  assert.deepEqual(maxStatic, { metric: 'longest static stretch (s)', profileKey: 'density.maxStatic', reference: 3, profile: profile.density.maxStatic });
  assert.equal(report.measured.sections.opening.to, profile.density.openingSeconds);
});

test('reference: builds count toward pace, and a one-take reel says so', () => {
  const builds = referenceReport(scan({ cuts: at(10), builds: at(1, 2, 3, 4, 5, 6, 7, 8) }), { profile });
  assert.ok(builds.notes.some(n => /in-shot builds/.test(n)));
  assert.equal(builds.override.density.maxStatic, 10);
  const oneTake = referenceReport(scan(), { profile });
  assert.ok(oneTake.notes.some(n => /no hard cuts/.test(n)));
  assert.equal(oneTake.override, null);
  assert.equal(oneTake.measured.medianShot, 20);
});

test('reference: speech ratio and first sound come from the silences', () => {
  const report = referenceReport(scan({ silences: [{ start: 0, end: 0.8, duration: 0.8 }, { start: 10, end: 11.2, duration: 1.2 }] }), { profile });
  assert.equal(report.measured.firstSoundAt, 0.8);
  assert.equal(report.measured.speechRatio, 0.9);
});

test('reference --project puts the edit\'s own gate values beside the reel', async () => {
  const project = buildProject();
  const pacing = await projectPacing(project, profile);
  const report = referenceReport(scan({ cuts: at(0.4, 2, 4) }), { profile, project: pacing });
  const row = report.compare.find(r => r.profileKey === 'density.maxStatic');
  assert.equal(row.project, pacing.checks.find(c => c.id === 'max-static').value);
  assert.equal(report.compare.find(r => r.metric === 'median shot (s)').project, null);
});

test('check-export: a clean render passes', () => {
  const report = checkExportReport(scan({ cuts: at(2, 4) }), { profile, expected: { source: 'project', width: 1080, height: 1920, fps: 30, duration: 20 } });
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.ok, true);
  assert.deepEqual(report.inspect, []);
  assert.equal(report.next, null);
});

test('check-export: black inside the edit, a clipped peak and a wrong length fail', () => {
  const report = checkExportReport(scan({
    black: [{ start: 8, end: 8.033, duration: 0.033 }],
    loudness: { lufs: -13.5, truePeak: 0.3, lra: 3 },
    duration: 19.5,
  }), { profile, expected: { source: 'project', width: 1080, height: 1920, fps: 30, duration: 20 } });
  assert.equal(report.verdict, 'FAIL');
  const failed = report.checks.filter(c => !c.ok).map(c => c.id).sort();
  assert.deepEqual(failed, ['black-inside', 'duration', 'true-peak']);
  assert.deepEqual(report.inspect, [8.02]);
  assert.match(report.next, /export-grid --media .* --times 8\.02$/);
});

test('check-export: edges, flashes, holds, silences and loudness warn', () => {
  const report = checkExportReport(scan({
    black: [{ start: 0, end: 0.2, duration: 0.2 }, { start: 19.5, end: 20, duration: 0.5 }],
    flashes: [{ t: 5, frames: 1, luma: 230, neighbours: 60 }],
    microShots: [{ t: 7, frames: 1 }],
    freezes: [{ start: 10, end: 14, duration: 4 }],
    silences: [{ start: 0, end: 0.9, duration: 0.9 }, { start: 12, end: 13.5, duration: 1.5 }],
    loudness: { lufs: -20, truePeak: -3, lra: 3 },
  }), { profile, expected: null });
  assert.equal(report.verdict, 'WARN');
  assert.equal(report.ok, true);
  const warned = report.checks.filter(c => !c.ok).map(c => c.id).sort();
  assert.deepEqual(warned, ['black-open', 'black-tail', 'dead-air', 'first-sound', 'flash-frames', 'frozen-picture', 'loudness', 'micro-shots']);
  assert.deepEqual(report.inspect, [5.02, 7.02, 10.02, 12.02, 19.52]);
  assert.match(checkExportText(report), /^check-export: WARN/);
});

test('check-export: no audio is a failure; --target and --peak override the profile', () => {
  const silent = checkExportReport(scan({ hasAudio: false, loudness: null }), { profile });
  assert.equal(silent.checks.find(c => c.id === 'audio-stream').ok, false);
  const custom = checkExportReport(scan({ loudness: { lufs: -16, truePeak: -1.5, lra: 3 } }), { profile, target: -16, peak: -2 });
  assert.equal(custom.checks.find(c => c.id === 'loudness').ok, true);
  assert.equal(custom.checks.find(c => c.id === 'true-peak').ok, false);
});

test('expectedDelivery reads the project canvas and content length, else the profile', async () => {
  assert.deepEqual(await expectedDelivery(null, profile),
    { source: 'profile', width: profile.canvas.width, height: profile.canvas.height, fps: profile.canvas.fps, duration: null });
  const expected = await expectedDelivery(buildProject(), profile);
  assert.deepEqual(expected, { source: 'project', width: 1080, height: 1920, fps: 30, duration: 8 });
});

const hasBinary = name => spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
const NEEDS_FFMPEG = hasBinary('ffmpeg') && hasBinary('ffprobe')
  ? {}
  : { skip: 'ffmpeg/ffprobe not on PATH — install ffmpeg to run the media scan suite' };

/** Red, blue, a one-frame white flash, blue, a stray yellow frame, green, a black tail; a tone with a gap. */
function synthReel(dir) {
  const out = path.join(dir, 'reel.mp4');
  const color = (c, d) => ['-f', 'lavfi', '-i', `color=c=${c}:s=180x320:r=30:d=${d}`];
  const run = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...color('red', 1.5), ...color('blue', 1.7), ...color('white', 0.0333), ...color('blue', 1.2),
    ...color('yellow', 0.0333), ...color('green', 1.1), ...color('black', 0.5),
    '-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.5',
    '-f', 'lavfi', '-i', 'sine=f=660:d=2.6:sample_rate=48000',
    '-filter_complex', '[0:v][1:v][2:v][3:v][4:v][5:v][6:v]concat=n=7:v=1:a=0[v];[7:a][8:a][9:a]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return out;
}

test('capcutctl check-export and reference measure a real render', NEEDS_FFMPEG, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-media-check-'));
  const reel = synthReel(dir);
  let stdout = '';
  const restore = setOutput(chunk => { stdout += String(chunk); return true; });
  t.after(restore);
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });

  await main(['check-export', '--media', reel, '--json']);
  const report = JSON.parse(stdout);
  const failed = id => report.checks.find(c => c.id === id);
  assert.equal(failed('flash-frames').ok, false, JSON.stringify(report.checks));
  assert.equal(failed('black-tail').ok, false);
  assert.equal(failed('dead-air').ok, false);
  assert.equal(failed('canvas').ok, false);
  assert.equal(failed('black-inside').ok, true);
  assert.equal(failed('micro-shots').ok, false, JSON.stringify(report.checks));
  assert.ok(report.inspect.some(t => Math.abs(t - 4.42) < 0.1), `stray frame near 4.4s in ${report.inspect}`);
  assert.equal(report.verdict, 'WARN');
  assert.ok(report.inspect.some(t => Math.abs(t - 3.22) < 0.1), `flash near 3.2s in ${report.inspect}`);

  stdout = '';
  const sheet = path.join(dir, 'shots.png');
  const override = path.join(dir, 'profile.json');
  await main(['reference', '--media', reel, '--sheet', sheet, '--profile-out', override]);
  const ref = JSON.parse(stdout);
  assert.ok(ref.measured.cuts >= 3, `cuts: ${JSON.stringify(ref.measured)}`);
  assert.ok(Math.abs(ref.measured.firstEvent - 1.5) < 0.05);
  assert.ok(fs.statSync(sheet).size > 0);
  assert.ok(ref.sheet.shots >= 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(override, 'utf8')).density, ref.override.density);

  // The override is a real profile file: the gate can load it.
  assert.equal(loadProfile({ file: override }).density.maxStatic, ref.override.density.maxStatic);
  await assert.rejects(main(['reference', '--media', reel, '--profile-out', override]), { code: 'REFERENCE_EXISTS' });
});
