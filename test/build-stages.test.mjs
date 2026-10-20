import './helpers/neutral-profile.mjs';
import './helpers/sfx-fixture.mjs';   // synthetic SFX, so logo pops and polish cues place on any machine
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applySpec, contentEndUs, loadWorkingDoc, readJson, stableJson } from '../src/core.mjs';
import { foldBuildStages, gateReport } from '../src/gate.mjs';
import { planEnding } from '../src/ending.mjs';
import { normalizePlan, runBuild } from '../src/build.mjs';
import { buildProject } from './helpers/polish-project.mjs';
import { capcutResave } from './helpers/capcut-resave.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const RUN = { forceRunning: true };   // CapCut may be open on the machine running the tests; these are temp drafts

const docOf = dir => readJson(path.join(dir, 'draft_info.json'));
const segs = dir => docOf(dir).tracks.flatMap(tr => tr.segments || []);
const descs = dir => segs(dir).map(s => s.desc);
const count = (dir, desc) => descs(dir).filter(d => d === desc).length;
const stateOf = dir => readJson(path.join(dir, '.capcutctl', 'build.json'));
const quiet = extra => normalizePlan({ version: 1, logos: false, layout: false, camera: { stress: false },
  ...extra, sound: { seams: false, loudness: false, ...(extra?.sound || {}) } });

function writeDoc(dir, doc) {
  for (const base of [dir, path.join(dir, 'Timelines', doc.id)]) {
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) fs.writeFileSync(path.join(base, name), stableJson(doc));
  }
}

function logoFile(dir) {
  const file = path.join(path.dirname(dir), 'grok.png');
  fs.writeFileSync(file, PNG);
  return file;
}

/** One second of 8 kHz mono silence: a real WAV ffprobe reads. */
function wav(file) {
  const n = 8000;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(file, b);
  return file;
}

/** A temp HOME for the length of one test: no speech index, no Gemini key from the environment. */
function isolate(t) {
  const saved = { HOME: process.env.HOME, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-home-'));
  process.env.HOME = home;
  delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// ---- the meta ledger -------------------------------------------------------------------------

test('a CapCut re-save between builds does not orphan the follow ender or stack it', async () => {
  const dir = buildProject();
  fs.mkdirSync(path.join(dir, 'mograph'));
  const file = path.join(dir, 'mograph', 'ending.mov');
  fs.writeFileSync(file, 'prores-bytes');
  applySpec(dir, { version: 1, name: 'ending', operations: [planEnding(docOf(dir), dir, 'fingerprint', file)] }, RUN);
  const plan = quiet({ endcard: {} });
  await runBuild(dir, plan, RUN);
  assert.equal(count(dir, 'mograph:follow-ender'), 1);
  assert.equal(contentEndUs(docOf(dir), dir), 11_000_000);
  const segments = segs(dir).length;

  writeDoc(dir, capcutResave(docOf(dir)));
  assert.equal(count(dir, 'mograph:follow-ender'), 0, 'the save stripped the ender\'s identity');
  const { doc: restoredDoc, restored } = loadWorkingDoc(dir);
  assert.ok(restored.length > 0);
  assert.equal(contentEndUs(docOf(dir), dir), 8_000_000, 'raw: the edit seems to stop 3s before the ender');
  assert.equal(contentEndUs(restoredDoc, dir), 11_000_000, 'restored: the ender is the end of the edit');
  assert.equal(gateReport(restoredDoc, { projectDir: dir }).duration, 11);

  // A forced rebuild prunes graphics the plan does not name; the ender must survive it.
  const rebuilt = await runBuild(dir, plan, { ...RUN, force: true });
  assert.ok(rebuilt.stages.repaired?.restored > 0, 'build put the stripped keys back first');
  assert.equal(count(dir, 'mograph:follow-ender'), 1, 'the ender survives prune, once');
  assert.equal(count(dir, 'sig:endcard'), 1, 'the endcard is replaced, not stacked');
  assert.equal(contentEndUs(docOf(dir), dir), 11_000_000);

  writeDoc(dir, capcutResave(docOf(dir)));
  await runBuild(dir, plan, { ...RUN, force: true });
  assert.equal(descs(dir).filter(d => /^mograph:/.test(d || '')).length, 1, 'mograph:* does not grow across re-saves');
  assert.equal(count(dir, 'sig:endcard'), 1);
  assert.equal(segs(dir).length, segments, 'nothing stacked: the stripped copies were recognised and replaced');
});

test('a dry run on a re-saved draft judges the restored copy and says so', async () => {
  const dir = buildProject();
  await runBuild(dir, quiet({ endcard: {} }), RUN);
  const resaved = capcutResave(docOf(dir));
  resaved.materials.videos.pop();            // keys stripped only: a duplicate id already refuses any dry run
  writeDoc(dir, resaved);
  const bytes = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  const dry = await runBuild(dir, quiet({ endcard: {} }), { ...RUN, dryRun: true });
  const note = dry.gate.checks.find(c => c.id === 'meta-restored');
  assert.equal(note.level, 'NOTE');
  assert.match(note.message, /meta restored from ledger: \d+ keys; run doctor --fix/);
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), bytes, 'a dry run repairs nothing');
});

// ---- logos and the endcard ---------------------------------------------------------------------

test('logos:false removes the earlier pop, its sound and their materials; the endcard stays', async () => {
  const dir = buildProject();
  const logo = logoFile(dir);
  await runBuild(dir, quiet({ logos: [{ brand: 'grok', at: 1, logo }], endcard: {} }), RUN);
  assert.ok(count(dir, 'sig:logo') >= 1);
  assert.equal(count(dir, 'sig:sfx:logo'), 1);
  assert.equal(stateOf(dir).logos, 1, 'build.json records the pops it placed');
  const logoMaterials = docOf(dir).materials.videos.filter(m => /grok\.png$/.test(m.path || '')).map(m => m.id);
  assert.ok(logoMaterials.length);

  const result = await runBuild(dir, quiet({ logos: false, endcard: {} }), RUN);
  assert.deepEqual(result.stages.graphics.cleared, ['clearLogos']);
  assert.equal(count(dir, 'sig:logo'), 0);
  assert.equal(count(dir, 'sig:sfx:logo'), 0);
  assert.ok(!docOf(dir).tracks.some(t => /^sig-logo/.test(t.name || '')), 'no empty sig-logo track left');
  const ids = new Set(Object.values(docOf(dir).materials).filter(Array.isArray).flat().map(m => m.id));
  assert.ok(logoMaterials.every(id => !ids.has(id)), 'the logo material went with its pop');
  assert.equal(count(dir, 'sig:endcard'), 1);
  assert.equal(count(dir, 'sig:sfx:endcard'), 1, 'the endcard keeps its cue');
});

test('logos:false with no pop to clear writes nothing: the clear-only pass is a no-op', async () => {
  const dir = buildProject();
  const bytes = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  for (const options of [RUN, { ...RUN, force: true }]) {
    const result = await runBuild(dir, quiet(), options);
    assert.deepEqual(result.stages.graphics.cleared, ['clearLogos']);
    assert.equal(result.stages.graphics.result.committed, false, 'no transaction write');
    assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), bytes, 'the draft is byte-identical');
  }
});

test('auto logos with no transcript keep the earlier pops and say why', async () => {
  const dir = buildProject();
  const logo = logoFile(dir);
  await runBuild(dir, quiet({ logos: [{ brand: 'grok', at: 1, logo }] }), RUN);
  assert.ok(count(dir, 'sig:logo') >= 1);
  const again = await runBuild(dir, quiet({ logos: 'auto' }), RUN);
  assert.match(again.stages.logosSkipped, /no word-level transcript/);
  assert.ok(count(dir, 'sig:logo') >= 1, 'detection could not run, so nothing was judged absent');
  assert.equal(stateOf(dir).logos, 1, 'the record keeps the pops it could not re-judge');
});

test('endcard:false clears the card; endcard left out keeps it', async () => {
  const dir = buildProject();
  await runBuild(dir, quiet({ endcard: {} }), RUN);
  assert.equal(count(dir, 'sig:endcard'), 1);
  await runBuild(dir, quiet({ endcard: null, notes: 'keep' }), RUN);
  assert.equal(count(dir, 'sig:endcard'), 1, 'null is "not this build\'s business"');
  await runBuild(dir, quiet({ endcard: false }), RUN);
  assert.equal(count(dir, 'sig:endcard'), 0);
  assert.equal(count(dir, 'sig:sfx:endcard'), 0);
});

// ---- preflight and rollback ----------------------------------------------------------------------

test('a music brief with no Gemini key refuses before the first write; the dry run reports it', async t => {
  isolate(t);
  const { loadEnv, geminiApiKey } = await import('../src/env.mjs');
  loadEnv();
  if (geminiApiKey()) return t.skip('a Gemini key is configured in a .env file');
  const dir = buildProject();
  const plan = quiet({ endcard: {}, sound: { music: { prompt: 'warm lo-fi bed under a calm voice' }, duck: false } });
  const dry = await runBuild(dir, plan, { ...RUN, dryRun: true });
  assert.equal(dry.stages.music.keyMissing, true);
  assert.match(dry.stages.music.error, /GEMINI_API_KEY.*sound\.music\.file/);
  const bytes = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  await assert.rejects(runBuild(dir, plan, RUN), error => error.code === 'NO_API_KEY' && /sound\.music\.file/.test(error.message));
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), bytes, 'graphics were not committed first');
  assert.equal(count(dir, 'sig:endcard'), 0);
});

test('a duck with no speech index refuses before the first write', async t => {
  isolate(t);
  const dir = buildProject();
  const bed = wav(path.join(path.dirname(dir), 'bed.wav'));
  const plan = quiet({ endcard: {}, sound: { music: { file: bed }, duck: true } });
  const dry = await runBuild(dir, plan, { ...RUN, dryRun: true });
  assert.equal(dry.stages.duck.code, 'DUCK_NO_SPEECH_INDEX');
  const bytes = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  await assert.rejects(runBuild(dir, plan, RUN), error => error.code === 'DUCK_NO_SPEECH_INDEX');
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), bytes);
});

test('a music file the probe rejects rolls the committed graphics back', async t => {
  isolate(t);
  const dir = buildProject();
  const bed = path.join(path.dirname(dir), 'bed.wav');
  fs.writeFileSync(bed, 'not really audio');
  const bytes = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  await assert.rejects(runBuild(dir, quiet({ endcard: {}, sound: { music: { file: bed }, duck: false } }), RUN), error => {
    assert.equal(error.details.rolledBack, true, error.message);
    assert.equal(error.details.failedStage, 'build-sound');
    assert.ok(error.details.snapshot);
    return true;
  });
  assert.equal(count(dir, 'sig:endcard'), 0, 'the endcard committed in build-graphics is gone again');
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), bytes);
});

// ---- skipped stages ------------------------------------------------------------------------------

test('a skipped stress pass is a build-stages WARN, reported again when up to date', async () => {
  const dir = buildProject();
  const plan = quiet({ endcard: {}, camera: { stress: true } });
  const first = await runBuild(dir, plan, RUN);
  const row = first.gate.checks.find(c => c.id === 'build-stages');
  assert.equal(row.ok, false);
  assert.equal(row.level, 'WARN');
  assert.match(row.message, /stress/);
  assert.ok(first.skipped.some(s => s.stage === 'stress'));
  assert.ok(stateOf(dir).skipped.some(s => s.stage === 'stress'));
  const again = await runBuild(dir, plan, RUN);
  assert.equal(again.upToDate, true);
  assert.equal(again.gate.checks.find(c => c.id === 'build-stages').ok, false, 'the up-to-date path still names the skip');
});

test('a skipped loudness pass FAILs build-stages; a stage with nothing skipped is ok', () => {
  const report = () => ({ checks: [] });
  const loud = foldBuildStages(report(), [{ stage: 'loudness', reason: 'true peak over the ceiling', code: 'MIX_PEAK_EXCEEDED' }]);
  assert.equal(loud.verdict, 'FAIL');
  assert.deepEqual(loud.failed, ['build-stages']);
  assert.match(loud.checks[0].message, /loudness \(MIX_PEAK_EXCEEDED\)/);
  const clean = foldBuildStages(report(), []);
  assert.equal(clean.checks[0].ok, true);
  assert.equal(clean.verdict, 'PASS');
});

test('a loudness refusal falls back and FAILs the gate; any other sound error propagates and rolls back', async () => {
  const dir = buildProject();
  // The fixture's media is not audio, so the measurement itself fails: a refusal build falls back from.
  const measured = await runBuild(dir, quiet({ endcard: {}, sound: { loudness: true } }), RUN);
  assert.ok(measured.skipped.some(s => s.stage === 'loudness'), JSON.stringify(measured.skipped));
  assert.ok(measured.gate.failed.includes('build-stages'));

  const other = buildProject();
  const profile = path.join(path.dirname(other), 'profile.json');
  fs.writeFileSync(profile, JSON.stringify({ version: 1, sound: { peak: 5 } }));   // loudness refuses it as BAD_PEAK
  await assert.rejects(runBuild(other, quiet({ profile, endcard: {}, sound: { loudness: true } }), RUN), error => {
    assert.equal(error.code, 'BAD_PEAK');
    assert.equal(error.details.rolledBack, true);
    return true;
  });
  assert.equal(count(other, 'sig:endcard'), 0);
});

// ---- seams ----------------------------------------------------------------------------------------

test('seams:false takes back the transitions and cues an earlier build placed, and only those', async () => {
  const dir = buildProject();
  const broll = path.join(path.dirname(dir), 'screen.mp4');
  fs.writeFileSync(broll, 'screen');
  const shots = path.join(path.dirname(dir), 'shots.json');
  fs.writeFileSync(shots, JSON.stringify([{ decision: 'place', ops: [{ op: 'clip.add', media: broll, at: 0, duration: 4, src: 0,
    track: 'broll', volume: 0, width: 1080, height: 1920, mediaDuration: 20_000_000 }] }]));
  await runBuild(dir, quiet({ shots, sound: { seams: 'all' } }), RUN);
  const placed = stateOf(dir).seamTransitions;
  assert.ok(placed.length > 0, 'polish placed a transition on the A|B seam');
  assert.ok(descs(dir).some(d => /^polish:/.test(d || '')), 'and its woosh');

  // The user adds a transition of their own in CapCut.
  const doc = docOf(dir);
  const handMade = { ...structuredClone(doc.materials.transitions[0]), id: 'HAND-MADE-TRANSITION' };
  doc.materials.transitions.push(handMade);
  const B = doc.tracks.flatMap(t => t.segments || []).find(s => s.id === 'B') || doc.tracks.find(t => t.name === 'content').segments.at(-1);
  B.extra_material_refs = [...(B.extra_material_refs || []), handMade.id];
  writeDoc(dir, doc);

  const off = await runBuild(dir, quiet({ shots, sound: { seams: false } }), RUN);
  assert.ok(off.stages.seams.pruned.transitions > 0, JSON.stringify(off.stages.seams));
  assert.equal(descs(dir).filter(d => /^polish:/.test(d || '')).length, 0, 'no polish cue left');
  const left = docOf(dir).materials.transitions.map(m => m.id);
  assert.deepEqual(left, ['HAND-MADE-TRANSITION'], 'the hand-made transition survives');
  assert.deepEqual(stateOf(dir).seamTransitions, []);
});

// ---- the profile the export will gate with ---------------------------------------------------------

test('build.json records the profile file and style for the export gate', async () => {
  const dir = buildProject();
  const profile = path.join(path.dirname(dir), 'profile.json');
  fs.writeFileSync(profile, JSON.stringify({ version: 1, styles: { tutorial: { pace: { graphicEvery: [4, 7] } } } }));
  await runBuild(dir, quiet({ profile, style: 'tutorial', endcard: {} }), RUN);
  const state = stateOf(dir);
  assert.equal(state.profile, profile);
  assert.equal(state.style, 'tutorial');
});
