import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readJson, stableJson } from '../src/core.mjs';
import { resolveAnchor, resolveAnchors } from '../src/anchors.mjs';
import { sourceToTimeline } from '../src/signature.mjs';
import { gateReport } from '../src/gate.mjs';
import { normalizePlan, runBuild } from '../src/build.mjs';
import { buildProject } from './helpers/polish-project.mjs';

// The helper's principal track: A = source 0–4 → timeline 0–4, B = source 10–14 → timeline 4–8.
const WORDS = [
  { word: 'hello', start: 1.0, end: 1.4 },
  { word: 'fast', start: 5.0, end: 5.4 },          // source 5 is cut out (between A and B)
  { word: 'أسرع', start: 11.0, end: 11.5 },         // survives: timeline 5.0
  { word: 'بعشر', start: 11.5, end: 11.9 },
  { word: 'fast', start: 12.5, end: 12.9 },        // the only SURVIVING "fast": timeline 6.5
];

function withWords(dir) {
  const file = path.join(path.dirname(dir), 'face.whisper-large.json');
  fs.writeFileSync(file, JSON.stringify({ segments: [{ start: 0, end: 14, text: '', words: WORDS }] }));
  return file;
}

function rewrite(dir, mutate) {
  const timeline = path.join(dir, 'Timelines', 'TIMELINE-ONE');
  for (const base of [dir, timeline]) {
    const doc = readJson(path.join(base, 'draft_info.json'));
    mutate(doc);
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) fs.writeFileSync(path.join(base, name), stableJson(doc));
  }
}

const docOf = dir => readJson(path.join(dir, 'draft_info.json'));

test('anchors count occurrences among the words that survived the cut', () => {
  const dir = buildProject();
  const mapper = sourceToTimeline(docOf(dir));
  assert.equal(resolveAnchor({ say: 'fast' }, WORDS.map(w => ({ text: w.word, start: w.start, end: w.end })), mapper).at, 6.5,
    'the first "fast" was cut, so the first one heard is the second in the take');
  const arabic = resolveAnchor({ say: 'اسرع بعشر' }, WORDS.map(w => ({ text: w.word, start: w.start, end: w.end })), mapper);
  assert.equal(arabic.at, 5, 'hamza folds, and a two-word phrase anchors on its first word');
  assert.throws(() => resolveAnchors([{ id: 'x', say: 'missing words' }], { doc: docOf(dir), words: [] }), /Orphaned anchors/);
});

test('edit plans refuse unknown keys and graphics without a time', () => {
  assert.throws(() => normalizePlan({ version: 1, grafics: [] }), /unknown edit plan keys: grafics/);
  assert.throws(() => normalizePlan({ version: 1, graphics: [{ template: 'keyword-super' }] }), /needs "say"/);
  const plan = normalizePlan({ version: 1 });
  assert.equal(plan.camera.stress, true, 'stress pushes are on by default');
  assert.equal(plan.sound.seams, 'motivated');
});

test('gate fails a static full-face edit and names why', () => {
  const report = gateReport(docOf(buildProject()));
  assert.equal(report.verdict, 'FAIL');
  for (const id of ['hook', 'proof', 'max-static', 'first-picture']) assert.ok(report.failed.includes(id), `expected ${id} to fail`);
  assert.match(report.scope, /cannot see pixels/);
});

async function browserOr(t) {
  try {
    const { probeMograph } = await import('../src/mograph.mjs');
    await probeMograph({ template: 'keyword-super', params: { text: 'ok' } });
    return true;
  } catch (error) {
    if (['MOGRAPH_BROWSER'].includes(error.code)) { t.skip(`no headless Chromium: ${error.message.split('.')[0]}`); return false; }
    throw error;
  }
}

test('build places graphics on their words, is a no-op when nothing changed, and follows a recut', async t => {
  if (!(await browserOr(t))) return;
  const dir = buildProject();
  const words = withWords(dir);
  const plan = normalizePlan({
    version: 1, words, logos: false, layout: false, camera: { stress: false },
    sound: { seams: false, loudness: false },
    graphics: [{ id: 'kw', template: 'keyword-super', say: 'أسرع', params: { text: 'أسرع' } }],
  });
  const first = await runBuild(dir, plan, { forceRunning: true });
  const placed = () => docOf(dir).tracks.flatMap(tr => tr.segments || []).filter(s => s.desc === 'mograph:kw');
  assert.equal(placed().length, 1);
  const lead = 3 / 30;
  assert.ok(Math.abs(placed()[0].target_timerange.start / 1e6 - (5 - lead)) < 1 / 30, 'lands its lead frames before the word');
  assert.ok(fs.existsSync(path.join(dir, 'mograph', 'kw.mov')));
  assert.equal(readJson(path.join(dir, 'mograph', 'kw.json')).anchor.say, 'أسرع');
  assert.ok(first.gate.checks.length > 5);

  const bytes = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  const again = await runBuild(dir, plan, { forceRunning: true });
  assert.equal(again.upToDate, true);
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), bytes, 'an unchanged rebuild writes nothing');

  // A recut: B now starts at 2s on the timeline (the take before it was shortened).
  rewrite(dir, doc => {
    const content = doc.tracks.find(tr => tr.name === 'content');
    const A = content.segments.find(s => s.id === 'A');
    A.target_timerange.duration = 2_000_000; A.source_timerange.duration = 2_000_000;
    content.segments.find(s => s.id === 'B').target_timerange.start = 2_000_000;
  });
  await runBuild(dir, plan, { forceRunning: true });
  assert.equal(placed().length, 1, 'rebuild replaces, never stacks');
  assert.ok(Math.abs(placed()[0].target_timerange.start / 1e6 - (3 - lead)) < 1 / 30, 'the graphic followed its word to 3s');

  // A recut that drops the word refuses by name.
  rewrite(dir, doc => {
    const B = doc.tracks.find(tr => tr.name === 'content').segments.find(s => s.id === 'B');
    B.source_timerange.start = 12_000_000;
  });
  await assert.rejects(runBuild(dir, plan, { forceRunning: true }), error => error.code === 'ANCHOR_ORPHANED' && /أسرع/.test(error.message));
});

test('harvest --profile measures the drafts it is given and writes only what they show', async () => {
  const { profileFromDrafts } = await import('../src/harvest.mjs');
  const dir = buildProject();
  rewrite(dir, doc => {
    const A = doc.tracks.find(tr => tr.name === 'content').segments.find(s => s.id === 'A');
    A.common_keyframes = [{ property_type: 'KFTypeScaleX', keyframe_list: [
      { time_offset: 0, values: [1] }, { time_offset: 200000, values: [1.2] }, { time_offset: 1800000, values: [1.2] }] }];
  });
  const profile = profileFromDrafts(path.dirname(dir), [path.basename(dir)]);
  assert.equal(profile.version, 1);
  assert.equal(profile.camera.push.scale, 1.2);
  assert.equal(profile.seams.hardCutsByDefault, true, 'no transitions in the drafts');
  assert.deepEqual(profile.provenance.drafts, [path.basename(dir)]);
  assert.equal(profile.tokens, undefined, 'tokens are not guessed from drafts');
});
