import './helpers/sfx-fixture.mjs';   // repoint the SFX palette off this machine — must come first
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readJson } from '../src/core.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { normalizePlan, runBuild } from '../src/build.mjs';
import { opMographPlace, resolvePlacementSfx } from '../src/mograph-place.mjs';
import { opPolish } from '../src/polish.mjs';
import { opSignature } from '../src/signature.mjs';
import { buildProject } from './helpers/polish-project.mjs';
import { stubMograph } from './helpers/mograph-stub.mjs';

const US = s => Math.round(s * 1e6);
const all = d => d.tracks.flatMap(t => t.segments || []);
const fadeOf = (d, s) => (d.materials.audio_fades || []).find(f => (s.extra_material_refs || []).includes(f.id));

/** What a person does in CapCut after a build: turn a cue down and give it a fade. */
function handLevel(d, s, volume, fadeId, fadeIn = 0.05, fadeOut = 0.2) {
  s.volume = volume;
  s.last_nonzero_volume = volume;
  (d.materials.audio_fades ||= []).push({ id: fadeId, type: 'audio_fade', fade_type: 0,
    fade_in_duration: US(fadeIn), fade_out_duration: US(fadeOut) });
  s.extra_material_refs = [...(s.extra_material_refs || []), fadeId];
}

function project() {
  const dir = buildProject();
  fs.mkdirSync(path.join(dir, 'mograph'), { recursive: true });
  const mov = path.join(dir, 'mograph', 'kw.mov');
  fs.writeFileSync(mov, 'prores-bytes');
  return { dir, mov, d: readJson(path.join(dir, 'draft_info.json')) };
}

const place = (mov, extra = {}) => ({
  op: 'mograph.place', id: 'kw-1', template: 'keyword-super', format: 'prores', file: mov,
  at: 2, duration: 1.5, box: { x: 205, y: 1212, w: 582, h: 188 }, sfx: 'pop', sfxLead: 0, fingerprint: 'v1', ...extra,
});

test('mograph rerender keeps the pop cue volume and fade it was given, and a scene keeps its clip level', () => {
  const { dir, mov, d } = project();
  opMographPlace(d, place(mov), { projectDir: dir });
  const cue = all(d).find(s => s.desc === 'mograph:sfx:kw-1');
  assert.equal(cue.volume, 1, 'the preset level on first placement');
  handLevel(d, cue, 0.35, 'HAND-FADE');

  // rerender: a new render (fingerprint) of the same id, as `mograph rerender` and a rebuild do
  const out = opMographPlace(d, place(mov, { fingerprint: 'v2' }), { projectDir: dir });
  const cues = all(d).filter(s => s.desc === 'mograph:sfx:kw-1');
  assert.equal(cues.length, 1, 'replaced, not stacked');
  assert.equal(cues[0].volume, 0.35);
  assert.equal(cues[0].last_nonzero_volume, 0.35);
  const fade = fadeOf(d, cues[0]);
  assert.ok(fade, 'the fade came across');
  assert.deepEqual([fade.fade_in_duration, fade.fade_out_duration], [US(0.05), US(0.2)]);
  assert.equal(d.materials.audio_fades.filter(f => f.id === fade.id).length, 1);
  assert.ok(out.carried.some(c => c.desc === 'mograph:sfx:kw-1' && c.volume.to === 0.35));

  // an explicit volume on the op still wins over the carried one; the fade still carries
  opMographPlace(d, place(mov, { fingerprint: 'v3', sfxVolume: 0.8 }), { projectDir: dir });
  const forced = all(d).find(s => s.desc === 'mograph:sfx:kw-1');
  assert.equal(forced.volume, 0.8);
  assert.ok(fadeOf(d, forced));

  // a scene carries its sound in the clip: 1 by default, a hand level survives the rerender
  const scene = { ...place(mov), id: 'ws-1', template: 'scene:word-slam', sfx: null, at: 5, fingerprint: 's1',
    box: { x: 0, y: 0, w: 1080, h: 1920 } };
  opMographPlace(d, scene, { projectDir: dir });
  const clip = all(d).find(s => s.desc === 'mograph:ws-1');
  assert.equal(clip.volume, 1);
  clip.volume = 0.5;
  opMographPlace(d, { ...scene, fingerprint: 's2' }, { projectDir: dir });
  assert.equal(all(d).find(s => s.desc === 'mograph:ws-1').volume, 0.5);
  opMographPlace(d, { ...scene, fingerprint: 's3', clipVolume: 0 }, { projectDir: dir });
  assert.equal(all(d).find(s => s.desc === 'mograph:ws-1').volume, 0, '--no-sfx still mutes');
});

test('a rerun of polish keeps a seam woosh at the level and fade it was given', () => {
  const { d } = project();
  opPolish(d, { __seed: 'FIRST' });
  const woosh = all(d).find(s => s.desc === 'polish:sfx');
  assert.ok(woosh, 'polish placed a seam cue');
  const at = woosh.target_timerange.start;
  handLevel(d, woosh, 0.4, 'SEAM-FADE', 0, 0.1);
  const out = opPolish(d, { __seed: 'SECOND' });
  const again = all(d).filter(s => s.desc === 'polish:sfx');
  assert.equal(again.length, 1);
  assert.notEqual(again[0].id, woosh.id, 'a fresh segment');
  assert.equal(again[0].target_timerange.start, at);
  assert.equal(again[0].volume, 0.4);
  assert.equal(fadeOf(d, again[0]).fade_out_duration, US(0.1));
  assert.equal(out.carried.length, 1);
  // a third pass with the same seed re-mints the same ids: still one fade, still the hand level
  opPolish(d, { __seed: 'SECOND' });
  const third = all(d).find(s => s.desc === 'polish:sfx');
  assert.equal(third.volume, 0.4);
  assert.equal(d.materials.audio_fades.filter(f => f.id === fadeOf(d, third).id).length, 1);
});

test('a rerun of the endcard keeps its cue level; a cue on a beat that moved starts fresh', () => {
  const face = (tStart, tDur, sStart) => ({
    id: `f${tStart}`, material_id: 'CAM', extra_material_refs: [],
    target_timerange: { start: US(tStart), duration: US(tDur) },
    source_timerange: { start: US(sStart), duration: US(tDur) },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
  });
  const d = {
    duration: US(20),
    materials: { videos: [{ id: 'CAM', type: 'video', path: '/a/cam.mp4', duration: US(400) }], audios: [], texts: [], speeds: [] },
    tracks: [
      { type: 'video', segments: [], id: 't0' },
      { type: 'video', id: 'principal', segments: [face(0, 10, 100), face(10, 10, 300)] },
      { type: 'audio', id: 'a0', name: '', segments: [] },
    ],
  };
  opSignature(d, { endcard: { text: 'Follow' } });
  const cue = all(d).find(s => s.desc === 'sig:sfx:endcard');
  assert.ok(cue, 'the endcard cue was written');
  handLevel(d, cue, 0.3, 'END-FADE');
  const out = opSignature(d, { endcard: { text: 'Follow' } });
  const again = all(d).filter(s => s.desc === 'sig:sfx:endcard');
  assert.equal(again.length, 1);
  assert.equal(again[0].volume, 0.3);
  assert.ok(fadeOf(d, again[0]));
  assert.ok(out.carried.some(c => c.desc === 'sig:sfx:endcard'));

  // the edit got 5 s shorter: the endcard moves, so its old level is not guessed onto it
  d.tracks[1].segments.pop();
  d.duration = US(10);
  opSignature(d, { endcard: { text: 'Follow' } });
  assert.equal(all(d).find(s => s.desc === 'sig:sfx:endcard').volume, 1);
});

test('the placement cue: no-sfx and an explicit null mean none, a named cue wins, otherwise the template\'s', () => {
  assert.equal(resolvePlacementSfx(undefined, 'pop'), 'pop', 'the template default');
  assert.equal(resolvePlacementSfx(null, 'pop'), null, 'the plan said no cue');
  assert.equal(resolvePlacementSfx('impact', 'pop'), 'impact');
  assert.equal(resolvePlacementSfx('impact', 'pop', true), null, '--no-sfx');
  assert.equal(resolvePlacementSfx(undefined, null), null);
});

test('a rerender keeps the plan\'s "no cue" and its accepted unsafe box', async () => {
  const dir = buildProject();
  const mograph = stubMograph();
  const unsafe = [100, 100, 600, 200];
  const plan = normalizePlan({
    version: 1, logos: false, layout: false, camera: { stress: false }, sound: { seams: false, loudness: false, music: false },
    graphics: [{ id: 'g1', template: 'keyword-super', at: 2, sfx: null, allowUnsafe: true, params: { text: 'one', testBox: unsafe } }],
  });
  await runBuild(dir, plan, { forceRunning: true, backup: false, renderers: { mograph } });
  const sidecar = readJson(path.join(dir, 'mograph', 'g1.json'));
  assert.equal(sidecar.sfx, null, 'the sidecar keeps the null');
  assert.equal(sidecar.allowUnsafe, true);
  const cues = () => all(readJson(path.join(dir, 'draft_info.json'))).filter(s => s.desc === 'mograph:sfx:g1');
  assert.equal(cues().length, 0);

  let out = '';
  const restore = setOutput(chunk => { out += String(chunk); return true; });
  try {
    await main(['mograph', 'rerender', '--project', dir, '--id', 'g1', '--params', JSON.stringify({ text: 'two' }),
      '--force-running', '--no-backup'], { mograph });
  } finally { restore(); }
  assert.ok(JSON.parse(out).committed !== false, 'placed without MOGRAPH_SAFE_ZONE');
  assert.equal(cues().length, 0, 'still no cue: the template default did not come back');
  const placed = all(readJson(path.join(dir, 'draft_info.json'))).find(s => s.desc === 'mograph:g1');
  assert.ok(placed, 'the graphic is placed');
  assert.equal(readJson(path.join(dir, 'mograph', 'g1.json')).params.text, 'two');
});
