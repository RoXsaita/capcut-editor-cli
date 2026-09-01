import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectBrands, spreadOverlapping, opSignature, sigPresets } from '../src/signature.mjs';
import { validateDocument } from '../src/core.mjs';

const US = s => Math.round(s * 1e6);
const rules = () => sigPresets().rules;

/* A 1x1 transparent PNG, written where a test can point a brand at it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

function tmpLogo(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, PNG);
  return file;
}

function baseDoc() {
  const seg = (i, start, dur) => ({
    id: `f${i}`, material_id: 'CAM', extra_material_refs: [],
    target_timerange: { start: US(start), duration: US(dur) },
    source_timerange: { start: US(start), duration: US(dur) },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, alpha: 1 },
  });
  return {
    duration: US(30),
    canvas_config: { width: 1080, height: 1920 },
    materials: { videos: [{ id: 'CAM', type: 'video', path: '/a/cam.mp4', duration: US(600) }] },
    tracks: [{ id: 'T0', type: 'video', flag: 0, name: '', segments: [] },
             { id: 'T1', type: 'video', flag: 2, name: 'content',
               segments: [seg(0, 0, 15), seg(1, 15, 15)] }],
  };
}

test('detectBrands: two brands sharing one artwork file yield one logo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const shared = tmpLogo(dir, 'shared.png');
  const transcript = { segments: [{ start: 0, words: [
    { start: 1.0, word: 'chatgpt' }, { start: 1.4, word: 'hermes' }] }] };
  const hits = detectBrands(transcript, t => t, {
    brands: {
      chatgpt: { aliases: ['chatgpt'], logo: shared },
      openai: { aliases: ['chatgpt'], logo: shared },     // same mark, same sentence
      hermes: { aliases: ['hermes'], logo: tmpLogo(dir, 'h.png') },
    },
  });
  assert.deepEqual(hits.map(h => h.brand), ['chatgpt', 'hermes'],
    'openai shares chatgpt\'s artwork, so it must not pop the identical glyph twice');
});

test('spreadOverlapping: marks on screen together are laid out side by side, in frame', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const logos = [
    { brand: 'a', at: 4.0, logo: tmpLogo(dir, 'a.png') },
    { brand: 'b', at: 4.6, logo: tmpLogo(dir, 'b.png') },
  ];
  spreadOverlapping(logos, rules());
  assert.ok(logos[0].pos && logos[1].pos, 'both marks get an explicit position');
  assert.ok(logos[0].pos[0] < 0 && logos[1].pos[0] > 0, 'the row straddles centre');
  assert.equal(logos[0].pos[1], logos[1].pos[1], 'a row shares one y');
  for (const l of logos) assert.ok(Math.abs(l.pos[0]) <= 1, `${l.brand} stays inside the frame`);
});

test('spreadOverlapping: marks that never share the screen keep the house position', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const logos = [
    { brand: 'a', at: 1.0, logo: tmpLogo(dir, 'a.png') },
    { brand: 'b', at: 20.0, logo: tmpLogo(dir, 'b.png') },
  ];
  spreadOverlapping(logos, rules());
  assert.ok(!logos[0].pos && !logos[1].pos, 'no overlap, no override');
});

test('glow reveal: underlay track sits BELOW the core mark and carries the effects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const doc = baseDoc();
  opSignature(doc, { op: 'signature', glow: true, noSfx: true,
                     logos: [{ brand: 'x', at: 4, logo: tmpLogo(dir, 'x.png') }] }, {});
  const names = doc.tracks.map(t => t.name);
  const under = names.indexOf('sig-logo-glow-0');
  const core = names.indexOf('sig-logo-0');
  assert.ok(under >= 0 && core >= 0, 'both layers exist');
  assert.ok(under < core, 'z-order is track order, so the glow must come first');

  const byId = new Map();
  for (const kind of ['video_effects', 'effects']) {
    for (const m of doc.materials[kind] || []) byId.set(m.id, m);
  }
  const refs = doc.tracks[under].segments[0].extra_material_refs.map(r => byId.get(r)).filter(Boolean);
  assert.ok(refs.some(m => m.name === 'Insane Glow'), 'underlay is lit');
  assert.ok(refs.some(m => m.name === 'Blur'), 'underlay is blurred');
  assert.ok(refs.some(m => m.type === 'mix_mode' && m.name === 'Screen'),
    'underlay screens, so the halo adds light instead of covering the picture');
  assert.equal(doc.tracks[core].segments[0].extra_material_refs
    .map(r => byId.get(r)).filter(m => m && (m.type === 'mix_mode' || m.type === 'video_effect')).length, 0,
    'the core mark stays clean');
});

test('glow reveal: base clip values are the resting state, not the first keyframe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const doc = baseDoc();
  opSignature(doc, { op: 'signature', glow: true, noSfx: true,
                     logos: [{ brand: 'x', at: 4, logo: tmpLogo(dir, 'x.png') }] }, {});
  const core = doc.tracks.find(t => t.name === 'sig-logo-0').segments[0];
  assert.equal(core.clip.alpha, 1,
    'anything that ignores keyframes must still draw the mark, not nothing');
  const kf = core.common_keyframes.find(k => k.property_type === 'KFTypeScaleX');
  assert.ok(core.clip.scale.x > kf.keyframe_list[0].values[0],
    'base scale is the settled size, not the 0.15 the pop starts from');
});

test('glow reveal: re-running sweeps the previous run\'s materials, not just its segments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const doc = baseDoc();
  const op = () => ({ op: 'signature', glow: true, noSfx: true,
                      logos: [{ brand: 'x', at: 4, logo: tmpLogo(dir, 'x.png') }] });
  opSignature(doc, op(), {});
  const after1 = { videos: doc.materials.videos.length,
                   fx: (doc.materials.video_effects || []).length,
                   fxx: (doc.materials.effects || []).length };
  opSignature(doc, op(), {});
  assert.deepEqual({ videos: doc.materials.videos.length,
                     fx: (doc.materials.video_effects || []).length,
                     fxx: (doc.materials.effects || []).length }, after1,
    'a stale logo material still carries a path, and CapCut scans materials — not tracks — '
    + 'when it decides media is missing, so leftovers raise the "Link media" dialog');

  const refs = new Set();
  for (const t of doc.tracks) for (const s of t.segments || []) {
    if (s.material_id) refs.add(s.material_id);
    for (const r of s.extra_material_refs || []) refs.add(r);
  }
  for (const kind of ['videos', 'video_effects', 'effects']) {
    for (const m of doc.materials[kind] || []) {
      assert.ok(refs.has(m.id), `orphaned ${kind} material ${m.id} left behind`);
    }
  }
});

test('doctor flags media outside the draft, deduped by path', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
  const stray = tmpLogo(outside, 'stray.png');
  const doc = baseDoc();
  // three material records for one file — CapCut's own shape
  doc.materials.videos.push(
    { id: 'M1', type: 'video', path: stray }, { id: 'M2', type: 'video', path: stray },
    { id: 'M3', type: 'video', path: stray });
  const issues = validateDocument(doc, { projectDir, file: 'draft_info.json' });
  const hits = issues.filter(i => i.code === 'MEDIA_NOT_LOCALIZED');
  assert.equal(hits.length, 1, 'one line per distinct path, not one per material record');
  assert.equal(hits[0].level, 'warning', 'it opens for some folders, so it is a risk not an error');
});

/* ---- `logo` resolves ARTWORK, not brand names ------------------------------------------ *
 * The command used to accept only a name registered in presets/brands.json, so an agent had
 * to edit a preset file before it could put a mark on screen. These cover the shapes that
 * matter: a bare path, several paths, and a folder of marks.
 * --------------------------------------------------------------------------------------- */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'capcutctl.mjs');

function logoPlan(projectDir, extra) {
  const out = execFileSync(process.execPath,
    [CLI, 'logo', '--project', projectDir, '--plan', ...extra], { encoding: 'utf8' });
  return JSON.parse(out);
}

function scratchProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logoproj-'));
  const doc = baseDoc();
  fs.mkdirSync(path.join(dir, 'Timelines', 'TL'), { recursive: true });
  const withId = { ...doc, id: 'TL' };
  for (const f of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
    fs.writeFileSync(path.join(dir, f), JSON.stringify(withId));
    fs.writeFileSync(path.join(dir, 'Timelines', 'TL', f), JSON.stringify(withId));
  }
  return dir;
}

test('logo places artwork given by path, with no brand registered anywhere', () => {
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  const file = tmpLogo(art, 'totally-unregistered.png');
  const plan = logoPlan(scratchProject(), ['--logo', file, '--at', '4.4']);
  assert.equal(plan.logos.length, 1);
  assert.equal(plan.logos[0].logo, file);
  assert.equal(plan.logos[0].brand, 'totally-unregistered', 'name falls back to the filename');
  assert.equal(plan.reveal, 'glow', 'the whole reveal is the default');
});

test('logo takes several paths with a time each, and lays them out side by side', () => {
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  const a = tmpLogo(art, 'a.png');
  const b = tmpLogo(art, 'b.png');
  const plan = logoPlan(scratchProject(), ['--logo', `${a},${b}`, '--at', '4.0,4.6']);
  assert.deepEqual(plan.logos.map(l => l.at), [4, 4.6]);
  assert.ok(plan.logos[0].pos[0] < plan.logos[1].pos[0], 'the row is ordered left to right');
});

test('logo expands a folder of marks and shrinks the row to fit the frame', () => {
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  for (const n of ['1.png', '2.png', '3.png', '4.png', '5.png', 'notes.txt']) {
    fs.writeFileSync(path.join(art, n), n.endsWith('.png') ? PNG : 'ignore me');
  }
  const plan = logoPlan(scratchProject(), ['--logo', art, '--at', '6']);
  assert.equal(plan.logos.length, 5, 'images only — the .txt is not a mark');
  assert.ok(plan.logos.every(l => Math.abs(l.pos[0]) <= 1), 'the whole row stays in frame');
  assert.ok(plan.logos.every(l => l.scale < 0.36), 'a crowded row scales down as one');
  const gaps = plan.logos.slice(1).map((l, i) => l.pos[0] - plan.logos[i].pos[0]);
  // positions are rounded to 3dp on the way out, so allow a rounding step
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 2e-3, `evenly spaced, got ${gaps}`);
});

test('logo --name overrides the filename', () => {
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  const plan = logoPlan(scratchProject(),
    ['--logo', tmpLogo(art, 'ugly-export-final-v3.png'), '--name', 'Acme', '--at', '2']);
  assert.equal(plan.logos[0].brand, 'Acme');
});

test('logo refuses artwork that is not there, by path', () => {
  assert.throws(() => logoPlan(scratchProject(), ['--logo', '/no/such/mark.png', '--at', '1']),
    /no such logo file/);
});

test('logo refuses a time count that does not match the marks', () => {
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  const a = tmpLogo(art, 'a.png');
  const b = tmpLogo(art, 'b.png');
  assert.throws(() => logoPlan(scratchProject(), ['--logo', `${a},${b}`, '--at', '1,2,3']),
    /3 times for 2 logos/);
  const plan = logoPlan(scratchProject(), ['--logo', `${a},${b}`, '--at', '5']);
  assert.deepEqual(plan.logos.map(l => l.at), [5, 5], 'one time brings the whole row in together');
});
