import './helpers/neutral-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { captureLastFrame, endingInput, planEnding, runEnding } from '../src/ending.mjs';
import { applySpec, contentEndUs, doctor, principalEndUs, readJson, stableJson } from '../src/core.mjs';
import { endingCard } from '../src/gate.mjs';
import { SCENE_DIR, sceneInput, sceneFingerprint } from '../src/mograph-scene.mjs';
import { launch, loadPlaywright } from '../src/mograph.mjs';
import { normalizePlan, runBuild } from '../src/build.mjs';
import { buildProject } from './helpers/polish-project.mjs';

// Every write is tested as if CapCut were open (npm test sets CAPCUTCTL_ASSUME_RUNNING=1).
const apply = (dir, spec) => applySpec(dir, spec, { forceRunning: true });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGMUafrKwMDAwgAGABHbAZE1ep4/AAAAAElFTkSuQmCC', 'base64');
const working = dir => readJson(path.join(dir, 'draft_info.json'));
const input = (t, override = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ending-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frame = path.join(dir, 'frame.png'); fs.writeFileSync(frame, PNG);
  const profileFile = path.join(dir, 'profile.json');
  fs.writeFileSync(profileFile, JSON.stringify({ version: 1, brand: { handle: '@creator' }, ending: { frame: 'frame.png', ...override } }));
  return { dir, frame, profileFile, ...endingInput({ profileFile }) };
};

test('ending resolves private layer paths and identity, uses role colors, and pins a three-second frame clock', t => {
  const i = input(t, { pill: 'Next part', headline: 'Follow', faceX: 430 });
  assert.equal(i.params.sub, '@creator');
  assert.equal(i.params.faceX, 430);
  assert.equal(i.frame, path.join(i.dir, 'frame.png'));
  assert.ok(i.params.imageData.startsWith('data:image/png;base64,'));
  assert.equal(i.profile.tokens.scene.bpm, 120);
  assert.equal(i.profile.tokens.scene.grain, 0);
  assert.equal(i.profile.tokens.scene.vignette, 0);
  assert.deepEqual(i.profile.tokens.scene.blur, { samples: 1, shutter: 0 });
  assert.equal(i.profile.tokens.scene.palette.brand, i.profile.tokens.color.brand);
  const a = sceneFingerprint('follow-ending', i.params, i.profile);
  assert.equal(sceneFingerprint('follow-ending', { ...i.params }, i.profile), a);
  assert.notEqual(sceneFingerprint('follow-ending', { ...i.params, headline: 'More' }, i.profile), a);
  assert.notEqual(sceneFingerprint('follow-ending', { ...i.params, noSfx: true }, i.profile), a);
  assert.throws(() => endingInput({ profileFile: i.profileFile, frame: path.join(i.dir, 'missing.png') }), e => e.code === 'ENDING_FRAME');
});

test('ending refuses unsupported input/config before writing', t => {
  const i = input(t);
  for (const ending of [{ faceScale: 0 }, { faceX: -1 }, { faceY: '920' }, { headline: '' }, { sub: 'two\nlines' }]) {
    fs.writeFileSync(i.profileFile, JSON.stringify({ version: 1, ending: { frame: 'frame.png', ...ending } }));
    assert.throws(() => endingInput({ profileFile: i.profileFile }), e => e.code === 'ENDING_PROFILE');
  }
  fs.writeFileSync(i.frame, 'not an image');
  assert.throws(() => endingInput({ frame: i.frame }), e => e.code === 'ENDING_FRAME');
  fs.writeFileSync(i.profileFile, JSON.stringify({ version: 1, canvas: { width: 1920, height: 1080 } }));
  assert.throws(() => endingInput({ profileFile: i.profileFile, frame: i.frame }), e => e.code === 'ENDING_CANVAS');
});

test('ending appends once, preserves the picture, survives build pruning and advances the shared ending gate/duration', t => {
  const dir = buildProject(); t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'mograph')); const file = path.join(dir, 'mograph', 'ending.mov'); fs.writeFileSync(file, 'prores-bytes');
  const before = working(dir);
  const picture = structuredClone(before.tracks.find(t => t.name === 'content').segments);
  const op = planEnding(before, dir, 'fingerprint', file);
  assert.equal(op.at, 8, 'uses picture end, ignoring the declared ten-second tail');
  apply(dir, { version: 1, operations: [op] });
  let doc = working(dir);
  assert.equal(contentEndUs(doc, dir), 11_000_000);
  assert.deepEqual(endingCard(doc, 11), { t: 8, end: 11, desc: 'mograph:follow-ender' });
  assert.deepEqual(doc.tracks.find(t => t.name === 'content').segments, picture);
  const first = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  const rerun = planEnding(doc, dir, 'fingerprint', file);
  assert.equal(rerun.at, 8);
  apply(dir, { version: 1, operations: [rerun] });
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), first);
  apply(dir, { version: 1, operations: [{ op: 'mograph.prune', keep: [] }] });
  doc = working(dir);
  assert.equal(doc.tracks.flatMap(t => t.segments || []).filter(s => s.desc === 'mograph:follow-ender').length, 1);
  const timeline = readJson(path.join(dir, 'Timelines', doc.id, 'draft_info.json'));
  assert.deepEqual(timeline, doc);
  assert.equal(doctor(dir).errors, 0);
  const owned = doc.tracks.flatMap(t => t.segments || []).find(s => s.desc === 'mograph:follow-ender');
  owned.target_timerange.start = 20_000_000;
  assert.equal(contentEndUs(doc, dir), 8_000_000, 'a detached old ending does not include empty time');
  doc.tracks.find(t => t.name === 'content').segments = [];
  assert.throws(() => planEnding(doc, dir, 'x', file), e => e.code === 'ENDING_EMPTY');
});

test('ending does not treat unrelated endcards or parked material as its append point', t => {
  const dir = buildProject(); t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const doc = working(dir);
  doc.tracks.push({ type: 'video', segments: [{ desc: 'endcard', target_timerange: { start: 50_000_000, duration: 5_000_000 } }] });
  assert.equal(planEnding(doc, dir, 'x', '/example.mov').at, 8);
  fs.mkdirSync(path.join(dir, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.capcutctl', 'created.json'), JSON.stringify({ preserved: { start: 10_000_000, end: 20_000_000 } }));
  assert.throws(() => planEnding(doc, dir, 'x', '/example.mov'), e => e.code === 'ENDING_PARKED_RANGE');
});

test('ending dry-run decodes the image, validates safe text, creates no files, and renders identical pixels regardless of seek order', async t => {
  const i = input(t);
  let browser;
  try { browser = await launch(await loadPlaywright()); }
  catch (error) {
    if (error.code === 'MOGRAPH_BROWSER' || /browserType\.launch/.test(error.message)) return t.skip(error.message.split('\n')[0]);
    throw error;
  }
  t.after(() => browser.close());
  const dir = buildProject(); t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const first = fs.readFileSync(path.join(dir, 'draft_info.json'));
  const report = await runEnding(dir, { profileFile: i.profileFile, frame: i.frame, dryRun: true });
  assert.equal(report.at, 8); assert.equal(report.end, 11); assert.equal(report.meta.frames, 90);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'draft_info.json')), first);
  assert.equal(fs.existsSync(path.join(dir, 'mograph')), false);
  assert.equal(fs.existsSync(path.join(dir, '.capcutctl')), false);
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.addInitScript(value => { window.__SCENE_INPUT__ = value; }, sceneInput('follow-ending', i.params, { profile: i.profile }));
  await page.goto(pathToFileURL(path.join(SCENE_DIR, 'host.html')).href);
  await page.evaluate(() => window.__scene.ready);
  const pixels = async frame => page.evaluate(frame => {
    window.__scene.frame(frame);
    const c = document.getElementById('out'), ctx = c.getContext('2d');
    let h = 2166136261;
    for (const x of ctx.getImageData(0, 0, c.width, c.height).data) h = Math.imul(h ^ x, 16777619);
    return h >>> 0;
  }, frame);
  const hash = await pixels(46); await pixels(12); await pixels(89); assert.equal(await pixels(46), hash);
  await pixels(0);
  assert.ok(await page.evaluate(async imageData => {
    const image = new Image(); image.src = imageData; await image.decode();
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1920;
    const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0, 1080, 1920);
    const expected = ctx.getImageData(0, 0, c.width, c.height).data;
    const actual = document.getElementById('out').getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return expected.every((value, index) => value === actual[index]);
  }, i.params.imageData), 'frame zero is the supplied frame without any decoration');
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const rewrite = (dir, mutate) => {
  const doc = working(dir); mutate(doc);
  for (const file of [path.join(dir, 'draft_info.json'), path.join(dir, 'Timelines', doc.id, 'draft_info.json')]) fs.writeFileSync(file, stableJson(doc));
};
/** The fixture's last clip shows source 10–14 s: frames 418–419 are green, 420+ red, earlier blue. */
function withMedia(dir) {
  const media = working(dir).materials.videos[0].path;
  const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "nullsrc=s=144x256:r=30:d=15,geq=r='if(gte(N\\,420)\\,255\\,0)':g='if(between(N\\,418\\,419)\\,255\\,0)':b='if(lt(N\\,418)\\,255\\,0)'",
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-f', 'mp4', media]);
  assert.equal(run.status, 0, String(run.stderr));
  rewrite(dir, doc => { Object.assign(doc.materials.videos[0], { width: 144, height: 256 }); });
}
const pixel = (png, x, y) => {
  const raw = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png, maxBuffer: 64 << 20 }).stdout;
  return [...raw.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3)].map(v => (v > 128 ? 1 : 0)).join('');
};

test('the captured frame is the last displayed source frame, placed with the clip transform', { skip: !hasFfmpeg && 'needs ffmpeg' }, t => {
  const dir = buildProject(); t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  withMedia(dir);
  let shot = captureLastFrame(working(dir), dir);
  assert.ok(Math.abs(shot.at - (14 - 1 / 30)) < 1e-3);
  assert.deepEqual(shot.approximate, []);
  assert.equal(pixel(shot.data, 540, 960), '010', 'green: the last frame inside the window, not the next one');
  rewrite(dir, doc => {
    const B = doc.tracks.find(tr => tr.name === 'content').segments.find(s => s.id === 'B');
    B.clip.scale = { x: 0.5, y: 0.5 }; B.clip.transform = { x: 0.5, y: 0 };
  });
  shot = captureLastFrame(working(dir), dir);
  assert.equal(pixel(shot.data, 810, 960), '010', 'half size, a quarter canvas to the right');
  assert.equal(pixel(shot.data, 300, 960), '000');
  rewrite(dir, doc => {
    const B = doc.tracks.find(tr => tr.name === 'content').segments.find(s => s.id === 'B');
    B.common_keyframes = [{ property_type: 'KFTypeScaleX', keyframe_list: [
      { time_offset: 13_000_000, values: [1], curveType: 'FreeCurveInOut' }, { time_offset: 15_000_000, values: [2] }] },
    { property_type: 'KFTypePositionX', keyframe_list: [   // an eased hold is not mid-ease
      { time_offset: 13_000_000, values: [0], curveType: 'FreeCurveInOut' }, { time_offset: 15_000_000, values: [0] }] }];
    doc.tracks.push({ id: 'TXT', type: 'text', segments: [{ id: 'END', desc: 'sig:endcard', target_timerange: { start: 6_000_000, duration: 2_000_000 } }] });
  });
  shot = captureLastFrame(working(dir), dir);
  assert.deepEqual(shot.approximate, ['KFTypeScaleX mid-ease']);
  assert.deepEqual(shot.onTop, ['text sig:endcard']);
  rewrite(dir, doc => { doc.materials.videos[0].path = path.join(dir, 'gone.mp4'); });
  assert.throws(() => captureLastFrame(working(dir), dir), e => e.code === 'ENDING_FRAME_CAPTURE');
});

test('edit.json ending: validated, copy overrides the profile per video', t => {
  assert.throws(() => normalizePlan({ version: 1, ending: 'yes' }), e => e.code === 'PLAN_INVALID');
  assert.throws(() => normalizePlan({ version: 1, ending: { colour: 'red' } }), e => e.code === 'PLAN_INVALID');
  assert.equal(normalizePlan({ version: 1, ending: { frame: 'f.png' } }, { baseDir: '/x' }).ending.frame, '/x/f.png');
  assert.equal(normalizePlan({ version: 1 }).ending, null);
  const i = input(t, { pill: 'Weekly', badge: '2' });
  const per = endingInput({ profileFile: i.profileFile, copy: { pill: 'Part two', badge: '' } });
  assert.equal(per.params.pill, 'Part two');
  assert.equal(per.params.badge, '', 'an empty badge hides it');
  assert.equal(per.params.headline, 'Follow');
});

test('build appends the ending on the edit\'s own last frame, keeps the endcard on the face, and ending:false removes it', { skip: !hasFfmpeg && 'needs ffmpeg' }, async t => {
  try { await (await launch(await loadPlaywright())).close(); }
  catch (error) {
    if (error.code === 'MOGRAPH_BROWSER' || /browserType\.launch/.test(error.message)) return t.skip(error.message.split('\n')[0]);
    throw error;
  }
  const dir = buildProject(); t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  withMedia(dir);
  const profile = path.join(path.dirname(dir), 'profile.json');
  fs.writeFileSync(profile, JSON.stringify({ version: 1, ending: { auto: true, pill: 'Weekly', headline: 'Follow', sub: '', badge: '' } }));
  const base = { version: 1, profile, endcard: { text: 'Follow' }, logos: false, layout: false, camera: { stress: false }, sound: { seams: false, loudness: false } };
  const enders = () => working(dir).tracks.flatMap(tr => tr.segments || []).filter(s => s.desc === 'mograph:follow-ender');
  const first = await runBuild(dir, normalizePlan(base), { forceRunning: true });
  assert.equal(first.stages.ending.at, 8);
  assert.deepEqual(first.stages.ending.captured.approximate, []);
  assert.ok(first.stages.ending.captured.onTop.some(x => /sig:endcard/.test(x)), 'the endcard runs to the last face frame');
  assert.equal(enders().length, 1);
  assert.equal(contentEndUs(working(dir), dir), 11_000_000);
  assert.equal(principalEndUs(working(dir), dir), 8_000_000);
  const frame = fs.readFileSync(first.stages.ending.file.replace(/\.mov$/, '-frame.png'));
  assert.equal(pixel(frame, 540, 960), '010', 'opens on the green last frame');
  // Timed off the face's end (96%, with a 0.4 s floor), never off the ending's.
  const endcard = () => working(dir).tracks.flatMap(tr => tr.segments || [])
    .filter(s => s.desc === 'sig:endcard').map(s => s.target_timerange);
  assert.deepEqual(endcard(), [{ start: 7_680_000, duration: 400_000 }], 'the endcard stays on the face');
  const again = await runBuild(dir, normalizePlan(base), { forceRunning: true, force: true });
  assert.equal(again.stages.ending.at, 8, 'a rebuild does not append after its own ending');
  assert.equal(enders().length, 1);
  assert.deepEqual(endcard(), [{ start: 7_680_000, duration: 400_000 }], 'a rebuild keeps the endcard off the ending');
  // A relink keeps the material id; the new file still invalidates the no-op hash.
  assert.equal((await runBuild(dir, normalizePlan(base), { forceRunning: true })).upToDate, true);
  fs.utimesSync(working(dir).materials.videos[0].path, new Date(), new Date(Date.now() + 5000));
  assert.notEqual((await runBuild(dir, normalizePlan(base), { forceRunning: true, dryRun: true })).upToDate, true);
  await runBuild(dir, normalizePlan({ ...base, ending: false }), { forceRunning: true });
  assert.equal(enders().length, 0);
  assert.equal(contentEndUs(working(dir), dir), 8_000_000);
});
