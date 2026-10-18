import './helpers/sfx-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySpec, doctor, readJson, stableJson } from '../src/core.mjs';
import { normalizeHook, readHook, runVariant } from '../src/variant.mjs';
import { buildProject } from './helpers/polish-project.mjs';

const CLOSED = () => ({ running: false, verified: true, pids: [] });
const MIRRORS = ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp'];

/**
 * A signed-off cut: old hook A (0–4 s) then the body B (4–10 s); a hook-title graphic and its
 * pop inside the opening, a seam-wipe across the seam, a frame and a music bed from the top,
 * captions on both sides of the seam, and a B-roll shot with its own pop in the body.
 */
function signedOff() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-variant-'));
  const root = path.join(temp, 'drafts');
  const project = path.join(root, 'Launch');
  const file = name => { const f = path.join(project, 'Resources', name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, name); return f; };
  const seg = (id, material, start, duration, src = 0, extra = {}) => ({
    id, material_id: material, extra_material_refs: [], speed: 1, volume: 1,
    source_timerange: src == null ? null : { start: src, duration }, target_timerange: { start, duration },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 },
    keyframe_refs: [], common_keyframes: [], ...extra,
  });
  const text = (id, word) => ({ id, type: 'text', content: JSON.stringify({ styles: [{ range: [0, word.length], size: 28 }], text: word }),
    font_path: '/fonts/changa.ttf' });
  const doc = {
    id: 'TL', name: 'Launch', duration: 10_000_000, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920 },
    materials: {
      videos: [
        { id: 'FACE', type: 'video', path: file('face.mp4'), duration: 60_000_000, width: 1440, height: 2560 },
        { id: 'SCREEN', type: 'video', path: file('screen.mp4'), duration: 20_000_000, width: 1920, height: 1080 },
        { id: 'TITLE', type: 'video', path: file('hook-title.mov'), duration: 1_500_000, width: 582, height: 188,
          capcutctl_mograph: { template: 'hook-title', importVerified: true } },
        { id: 'WIPE', type: 'video', path: file('seam-wipe.mov'), duration: 800_000, width: 1080, height: 1920,
          capcutctl_mograph: { template: 'scene:seam-wipe', scene: true, importVerified: true } },
        { id: 'FRAME', type: 'photo', path: file('frame.png'), duration: 10_800_000_000, width: 1080, height: 1920 },
      ],
      audios: [
        { id: 'POP', type: 'sound', path: file('pop.wav'), duration: 500_000, name: 'pop' },
        { id: 'BED', type: 'music', path: file('bed.mp3'), duration: 30_000_000, name: 'bed' },
      ],
      texts: [text('W1', 'بنيت'), text('W2', 'موقع'), text('W3', 'أسرع')],
      speeds: [], transitions: [], common_mask: [],
    },
    tracks: [
      { id: 'T0', type: 'video', flag: 0, attribute: 0, segments: [] },
      { id: 'T1', type: 'video', flag: 2, attribute: 0, name: 'content', segments: [
        seg('A', 'FACE', 0, 4_000_000, 2_000_000, { common_keyframes: [{ property_type: 'KFTypeScaleX', keyframe_list: [{ time_offset: 0 }] }] }),
        seg('B', 'FACE', 4_000_000, 6_000_000, 30_000_000),
      ] },
      { id: 'T2', type: 'video', flag: 2, attribute: 0, name: 'broll', segments: [seg('SHOT', 'SCREEN', 6_000_000, 2_000_000, 1_000_000, { volume: 0 })] },
      { id: 'T3', type: 'video', flag: 2, attribute: 0, name: 'frame', segments: [seg('PLATE', 'FRAME', 0, 10_000_000, 0, { desc: 'layout:frame' })] },
      { id: 'T4', type: 'video', flag: 2, attribute: 0, name: 'mograph-1', segments: [
        seg('G-TITLE', 'TITLE', 1_000_000, 1_500_000, 0, { desc: 'mograph:hook-title', volume: 0 }),
        seg('G-WIPE', 'WIPE', 3_600_000, 800_000, 0, { desc: 'mograph:seam-wipe', volume: 0.8 }),
      ] },
      { id: 'T5', type: 'audio', flag: 0, attribute: 0, name: 'mograph-sfx', segments: [
        seg('S-TITLE', 'POP', 1_000_000, 400_000, 0, { desc: 'mograph:sfx:hook-title', volume: 0.42 }),
        seg('S-SHOT', 'POP', 6_000_000, 400_000, 0, { desc: 'polish:sfx', volume: 0.27 }),
      ] },
      { id: 'T6', type: 'audio', flag: 0, attribute: 0, name: 'music', segments: [seg('MUSIC', 'BED', 0, 10_000_000, 0, { volume: 0.18 })] },
      { id: 'T7', type: 'text', flag: 0, attribute: 0, name: 'captions:suheil', segments: [
        seg('C1', 'W1', 200_000, 400_000, null, { desc: 'captions:suheil:x' }),
        seg('C2', 'W2', 700_000, 500_000, null, { desc: 'captions:suheil:x' }),
        seg('C3', 'W3', 5_000_000, 400_000, null, { desc: 'captions:suheil:x' }),
      ] },
    ],
  };
  for (const dir of [project, path.join(project, 'Timelines', 'TL')]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of MIRRORS) fs.writeFileSync(path.join(dir, name), stableJson(doc));
  }
  fs.writeFileSync(path.join(project, 'Timelines', 'project.json'), stableJson({ main_timeline_id: 'TL', timelines: [{ id: 'TL' }] }));
  fs.writeFileSync(path.join(project, 'draft_meta_info.json'), stableJson({ draft_name: 'Launch', draft_fold_path: project, draft_id: 'OLD-ID' }));
  fs.writeFileSync(path.join(root, 'root_meta_info.json'), stableJson({ all_draft_store: [{ draft_fold_path: project, draft_name: 'Launch' }] }));
  const hooks = path.join(temp, 'hooks.json');
  fs.writeFileSync(hooks, stableJson({ hooks: [{ id: 'a', in: 2, out: 6 }, { id: 'b', in: 20, out: 25.5, text: 'جربت أداة' }] }));
  const words = [{ word: ' جربت', start: 20.1, end: 20.5 }, { word: ' أداة', start: 20.6, end: 21.2 }, { word: ' بعد', start: 25.6, end: 26 }];
  return { temp, root, project, hooks, words, doc };
}

const timeline = dir => readJson(path.join(dir, 'Timelines', 'TL', 'draft_info.json'));
const byId = doc => Object.fromEntries(doc.tracks.flatMap(t => t.segments).map(s => [s.id, s]));
const volumes = doc => Object.fromEntries(doc.tracks.flatMap(t => t.segments).filter(s => s.id.length < 10).map(s => [s.id, s.volume]));

test('readHook takes a hooks.json window by id; --src is the same window', () => {
  const fx = signedOff();
  assert.deepEqual(readHook(fx.hooks, 'b'), { id: 'b', in: 20, out: 25.5 });
  assert.throws(() => readHook(fx.hooks), error => error.code === 'HOOK_NOT_FOUND' && /a, b/.test(error.message));
  assert.deepEqual(normalizeHook({ src: '20-25.5', id: 'b' }), { id: 'b', in: 20, out: 25.5 });
  assert.throws(() => normalizeHook({ in: 5, out: 4 }), error => error.code === 'BAD_HOOK');
});

test('variant duplicates the project with the hook as its opening; body shifts, opening re-timed, levels kept', async () => {
  const fx = signedOff();
  const before = timeline(fx.project);
  const result = await runVariant(fx.project, { hook: readHook(fx.hooks, 'b'), words: fx.words, processProbe: CLOSED });
  assert.equal(result.created, true);
  assert.equal(result.name, 'Launch hook-b');
  assert.deepEqual(timeline(fx.project), before, 'the signed-off project is untouched');

  const doc = timeline(result.project);
  const s = byId(doc);
  assert.equal(result.plan.opening.was, 4);
  assert.equal(result.plan.opening.now, 5.5);
  // The hook is the opening; its old keyframes are gone, its layout stays.
  assert.deepEqual(s.A.source_timerange, { start: 20_000_000, duration: 5_500_000 });
  assert.deepEqual(s.A.target_timerange, { start: 0, duration: 5_500_000 });
  assert.deepEqual(s.A.common_keyframes, []);
  // The body moved by +1.5 s on every track.
  assert.equal(s.B.target_timerange.start, 5_500_000);
  assert.equal(s.SHOT.target_timerange.start, 7_500_000);
  assert.equal(s['S-SHOT'].target_timerange.start, 7_500_000);
  assert.equal(s.C3.target_timerange.start, 6_500_000);
  // Opening graphic + its pop re-timed proportionally; the seam-wipe stays on the seam.
  assert.equal(s['G-TITLE'].target_timerange.start, 1_375_000);
  assert.equal(s['S-TITLE'].target_timerange.start, 1_375_000);
  assert.equal(s['G-WIPE'].target_timerange.start, 5_100_000);
  // The frame and the music bed run from the top to the new end.
  assert.deepEqual(s.PLATE.target_timerange, { start: 0, duration: 11_500_000 });
  assert.deepEqual(s.MUSIC.target_timerange, { start: 0, duration: 11_500_000 });
  assert.equal(s.MUSIC.source_timerange.duration, 11_500_000);
  // Old hook captions out, the hook's words in, in the same style; the word after the hook is not.
  assert.equal(s.C1, undefined);
  assert.equal(s.C2, undefined);
  const captions = doc.tracks.find(t => t.name === 'captions:suheil').segments;
  assert.equal(captions.length, 3);
  const texts = new Map(doc.materials.texts.map(m => [m.id, JSON.parse(m.content)]));
  assert.deepEqual(captions.slice(0, 2).map(c => [c.target_timerange.start, texts.get(c.material_id).text]),
    [[100_000, 'جربت'], [600_000, 'أداة']]);
  assert.deepEqual(texts.get(captions[0].material_id).styles[0].range, [0, 4]);
  assert.equal(doc.materials.texts.some(m => m.id === 'W1'), false, 'dropped caption materials are pruned');
  // Every audio level is exactly what it was.
  assert.deepEqual(volumes(doc), Object.fromEntries(Object.entries(volumes(before)).filter(([id]) => !['C1', 'C2'].includes(id))));
  assert.equal(doc.duration, 11_500_000);

  // A real, registered, valid CapCut project, gated.
  assert.equal(doctor(result.project).errors, 0);
  assert.equal(readJson(path.join(result.project, 'draft_meta_info.json')).draft_name, 'Launch hook-b');
  assert.notEqual(readJson(path.join(result.project, 'draft_meta_info.json')).draft_id, 'OLD-ID');
  assert.equal(doc.materials.videos.find(m => m.id === 'FACE').path, path.join(result.project, 'Resources', 'face.mp4'),
    'in-draft media paths point into the duplicate');
  assert.ok(readJson(path.join(fx.root, 'root_meta_info.json')).all_draft_store.some(e => e.draft_fold_path === result.project));
  assert.ok(['PASS', 'FAIL', 'WARN'].includes(result.gate.verdict));

  // A second variant of the same hook gets its own name.
  const again = await runVariant(fx.project, { hook: readHook(fx.hooks, 'b'), words: fx.words, processProbe: CLOSED, gate: false });
  assert.equal(again.name, 'Launch hook-b 2');
});

test('variant --dry-run plans on the original and writes nothing; a shorter hook pulls the body in', async () => {
  const fx = signedOff();
  const listing = () => fs.readdirSync(fx.root).sort();
  const before = listing();
  const dry = await runVariant(fx.project, { hook: { id: 'short', in: 40, out: 42 }, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(listing(), before);
  assert.equal(dry.plan.opening.delta, -2);
  assert.ok(dry.plan.warnings.some(w => /captions/.test(w)), 'no words: the missing captions are named, not faked');

  const made = await runVariant(fx.project, { hook: { id: 'short', in: 40, out: 42 }, processProbe: CLOSED, gate: false });
  const s = byId(timeline(made.project));
  assert.equal(s.B.target_timerange.start, 2_000_000);
  assert.equal(s['G-WIPE'].target_timerange.start, 1_600_000);
  assert.ok(s['G-TITLE'].target_timerange.start + s['G-TITLE'].target_timerange.duration <= 2_000_000);
  assert.equal(doctor(made.project).errors, 0);
});

test('variant refuses an --opening that is not a cut, and a hook past the end of the take', async () => {
  const fx = signedOff();
  await assert.rejects(runVariant(fx.project, { hook: { id: 'x', in: 1, out: 3 }, opening: 2.5, dryRun: true }),
    error => error.code === 'BAD_OPENING' && /Cuts: 4/.test(error.message));
  await assert.rejects(runVariant(fx.project, { hook: { id: 'x', in: 58, out: 61 }, dryRun: true }), /face take is 60s/);
});

test('re-placing a graphic keeps the levels its picture and pop already have (rerender reset them to 1.0)', () => {
  const dir = buildProject();
  fs.mkdirSync(path.join(dir, 'mograph'), { recursive: true });
  const mov = path.join(dir, 'mograph', 'kw.mov');
  fs.writeFileSync(mov, 'prores-bytes');
  const place = extra => ({ version: 1, operations: [{ op: 'mograph.place', id: 'kw-1', template: 'keyword-super', format: 'prores',
    file: mov, at: 2, duration: 1.5, box: { x: 205, y: 1212, w: 582, h: 188 }, sfx: 'pop', fingerprint: 'abc', ...extra }] });
  applySpec(dir, place());
  const owned = () => readJson(path.join(dir, 'draft_info.json')).tracks.flatMap(t => t.segments).filter(s => /^mograph:(sfx:)?kw-1$/.test(s.desc));
  const pop = owned().find(s => s.desc === 'mograph:sfx:kw-1');
  assert.ok(pop, 'the fixture palette resolves the pop');
  applySpec(dir, { version: 1, operations: [{ op: 'segment.patch', selector: { id: pop.id }, set: { volume: 0.3 } }] });
  applySpec(dir, place({ fingerprint: 'typo-fixed' }));
  assert.equal(owned().find(s => s.desc === 'mograph:sfx:kw-1').volume, 0.3);
  applySpec(dir, place({ fingerprint: 'reset', resetLevels: true }));
  assert.notEqual(owned().find(s => s.desc === 'mograph:sfx:kw-1').volume, 0.3, 'resetLevels opts back into the palette level');
});

test('cli: variant --hooks/--hook dry run reports the plan and needs one hook source', async () => {
  const { main, setOutput } = await import('../src/cli.mjs');
  const fx = signedOff();
  const words = path.join(fx.temp, 'words.json');
  fs.writeFileSync(words, stableJson({ segments: [{ words: fx.words }] }));
  let out = '';
  const restore = setOutput(chunk => { out += String(chunk); return true; });
  try {
    await main(['variant', '--project', 'Launch', '--root', fx.root, '--hooks', fx.hooks, '--hook', 'b', '--words', words, '--dry-run']);
  } finally { restore(); }
  const plan = JSON.parse(out).plan;
  assert.equal(plan.opening.now, 5.5);
  assert.equal(plan.captions.added, 2);
  await assert.rejects(main(['variant', '--project', 'Launch', '--root', fx.root, '--dry-run']), error => error.code === 'HOOK_MISSING');
});
