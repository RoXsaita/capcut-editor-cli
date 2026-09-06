import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main, setOutput } from '../src/cli.mjs';
import { musicCachePaths, musicPrompt, opMusic, prepareMusic, promptHash } from '../src/music.mjs';

const US = seconds => Math.round(seconds * 1e6);

function dryRunProject(root) {
  const project = path.join(root, 'project');
  const media = path.join(root, 'screen.mp4');
  const doc = {
    id: 'MUSIC-TIMELINE',
    name: 'Music dry-run fixture',
    duration: US(8),
    fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [
        { id: 'BROLL', type: 'video', path: media, duration: US(8), width: 720, height: 1050 },
        { id: 'FACE', type: 'video', path: media, duration: US(8), width: 1080, height: 1920 },
      ],
      audios: [], common_mask: [], speeds: [], audio_fades: [], transitions: [],
    },
    tracks: [
      {
        id: 'BROLL-TRACK', type: 'video', flag: 2, name: 'broll', segments: [{
          id: 'BROLL-SEGMENT', material_id: 'BROLL', desc: 'broll:proof', volume: 0,
          source_timerange: { start: 0, duration: US(8) },
          target_timerange: { start: 0, duration: US(8) },
          clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        }],
      },
      {
        id: 'FACE-TRACK', type: 'video', flag: 2, name: 'content', segments: [{
          id: 'FACE-SEGMENT', material_id: 'FACE', volume: 1,
          source_timerange: { start: 0, duration: US(8) },
          target_timerange: { start: 0, duration: US(8) },
          clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        }],
      },
    ],
  };
  fs.writeFileSync(media, 'not decoded; dry-run must not probe or generate');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'draft_info.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return project;
}

test('music --dry-run propagates through finish preparation without Lyria or cache writes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-music-dry-run-'));
  const project = dryRunProject(temp);
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  let stdout = '';
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('Lyria must not be called during --dry-run');
  };
  // Capture through the CLI's own sink, never by hooking process.stdout.write: on Node 20 the
  // test runner reports through that same hook, so the JSON came back with the runner's binary
  // protocol spliced into it.
  const restoreOutput = setOutput(chunk => { stdout += String(chunk); return true; });
  const results = [];
  const cacheStates = [];
  try {
    for (const command of ['music', 'finish']) {
      stdout = '';
      await main(command === 'music'
        ? ['music', '--project', project, '--dry-run']
        : ['finish', '--project', project, '--music', '--dry-run']);
      results.push(JSON.parse(stdout));
      cacheStates.push(fs.existsSync(path.join(project, '.capcutctl')));
    }
  } finally {
    restoreOutput();
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
  for (const result of results) {
    assert.equal(result.dryRun, true);
    assert.equal(result.score.musicPrepared.dryRun, true);
    assert.equal(result.score.musicPrepared.wouldGenerate, false);
  }
  assert.equal(fetchCalls, 0);
  assert.deepEqual(cacheStates, [false, false]);
});

function readDraft(project) {
  return JSON.parse(fs.readFileSync(path.join(project, 'draft_info.json'), 'utf8'));
}

function addPictureChange(doc, at) {
  const first = doc.tracks[0].segments[0];
  doc.tracks[0].segments = [
    { ...first, id: 'BROLL-FIRST', desc: 'broll:first',
      source_timerange: { start: 0, duration: US(4) },
      target_timerange: { start: 0, duration: US(4) } },
    { ...first, id: 'BROLL-SECOND', desc: 'broll:second',
      source_timerange: { start: US(4), duration: US(4) },
      target_timerange: { start: US(at), duration: US(8 - at) } },
  ];
}

test('prepareMusic persists an explicit brief and regenerates it after picture changes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-music-brief-'));
  const project = dryRunProject(temp);
  const doc = readDraft(project);
  addPictureChange(doc, 4);
  const brief = 'Playful orchestral tension for three AI agents arguing, resolving into a warm final chord.';
  const prompts = [];
  const generate = async ({ prompt }) => { prompts.push(prompt); return Buffer.from(`local-audio-${prompts.length}`); };
  const probe = () => 8;
  const detect = () => [0.5, 1.5];
  try {
    const first = await prepareMusic(project, doc, { prompt: brief, generate, probe, detect });
    const firstMeta = JSON.parse(fs.readFileSync(musicCachePaths(project).meta, 'utf8'));
    assert.equal(firstMeta.brief, brief);
    assert.equal(firstMeta.briefHash, promptHash(brief));
    assert.equal(firstMeta.promptProvenance, 'explicit');
    assert.ok(firstMeta.timingHash);
    assert.match(musicPrompt(doc, { projectDir: project }), /Playful orchestral tension/);

    const changed = structuredClone(doc);
    changed.tracks[0].segments[1].target_timerange.start = US(5);
    const second = await prepareMusic(project, changed, { generate, probe, detect });
    assert.equal(prompts.length, 2, 'changed picture timing regenerates');
    assert.equal(second.brief, brief, 'saved brief survives without --prompt');
    assert.equal(second.briefSource, 'saved');
    assert.equal(second.promptProvenance, 'explicit');
    assert.match(second.prompt, /Playful orchestral tension/);
    assert.doesNotMatch(second.prompt, /product-demo Reel/i);
    assert.notEqual(second.timingHash, first.timingHash);

    await prepareMusic(project, changed, { regen: true, generate, probe, detect });
    assert.equal(prompts.length, 3, '--regen uses the saved brief');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('an old generic prompt becomes an actionable brief-required plan', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-music-generic-'));
  const project = dryRunProject(temp);
  const doc = readDraft(project);
  const cache = musicCachePaths(project);
  fs.mkdirSync(cache.dir, { recursive: true });
  fs.writeFileSync(cache.file, 'cached-audio');
  fs.writeFileSync(cache.meta, JSON.stringify({
    prompt: 'Create a 8.0-second instrumental-only background bed for a vertical tech demo.\n'
      + 'Quiet modern electronic / soft pulse, 95–110 BPM, minor key, pads and muted perc.\n'
      + 'Think product-demo Reel, not a trailer.',
    duration: 8,
  }));
  try {
    const plan = await prepareMusic(project, doc, { dryRun: true });
    assert.equal(plan.needsBrief, true);
    assert.equal(plan.wouldGenerate, false);
    assert.match(plan.error, /--prompt/);
    assert.doesNotMatch(plan.prompt, /product-demo Reel/i);
    await assert.rejects(
      prepareMusic(project, doc, { generate: async () => { throw new Error('must not run'); } }),
      error => error.code === 'MUSIC_BRIEF_REQUIRED' && /--prompt/.test(error.message)
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('prepareMusic exposes a selected local track and opMusic keeps local identity', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-music-local-'));
  const project = dryRunProject(temp);
  const doc = readDraft(project);
  const local = path.join(temp, 'chosen-track.mp3');
  fs.writeFileSync(local, 'chosen-track-bytes');
  try {
    const plan = await prepareMusic(project, doc, { file: local, dryRun: true });
    await assert.rejects(prepareMusic(project, doc, { file: local, regen: true, dryRun: true }), { code: 'MUSIC_OPTIONS' });
    await assert.rejects(prepareMusic(project, doc, { file: local, volume: NaN, dryRun: true }), { code: 'BAD_VOLUME' });
    assert.equal(plan.local, true);
    assert.equal(plan.file, path.resolve(local));
    assert.equal(plan.needsBrief, false);
    assert.equal(plan.wouldGenerate, false);
    assert.equal(fs.existsSync(musicCachePaths(project).meta), false);

    const prepared = await prepareMusic(project, doc, {
      file: local, probe: () => 8, detect: () => [0.5],
    });
    const saved = JSON.parse(fs.readFileSync(musicCachePaths(project).meta, 'utf8'));
    assert.equal(prepared.mode, 'local');
    assert.equal(saved.mode, 'local');
    assert.equal(saved.file, path.resolve(local));

    const reused = await prepareMusic(project, doc, { dryRun: true });
    assert.equal(reused.mode, 'local');
    assert.equal(reused.file, path.resolve(local));
    assert.equal(reused.wouldGenerate, false);

    const switched = await prepareMusic(project, doc, {
      prompt: 'Use sparse suspense and resolve into a clear confident cadence.', dryRun: true,
    });
    assert.equal(switched.mode, 'generated');
    assert.equal(switched.local, undefined);
    assert.equal(switched.needsBrief, false);
    assert.equal(switched.wouldGenerate, true);

    const regen = await prepareMusic(project, doc, { regen: true, dryRun: true });
    assert.equal(regen.mode, 'generated');
    assert.equal(regen.needsBrief, true, 'regen needs a saved/generated brief after local-only selection');

    doc.materials.audios = [{ id: 'OLD', name: 'finish-music', music_id: 'old-library-id', path: '/cache/old.mp3' }];
    opMusic(doc, { file: local, duration: 8, __seed: 'MUSIC-LOCAL' }, { projectDir: project });
    const material = doc.materials.audios.find(item => item.name === 'finish-music');
    assert.equal(doc.materials.audios.filter(item => item.name === 'finish-music').length, 1);
    assert.equal(material.music_id, '');
    assert.equal(material.music_source, '');
    assert.match(material.path, /Resources[\\/]CapcutctlMedia[\\/]finish-music-[0-9a-f]{12}\.mp3$/);
    assert.equal(fs.existsSync(material.path), true);
    const wav = path.join(temp, 'chosen-track.wav');
    fs.writeFileSync(wav, 'wav-bytes');
    opMusic(doc, { file: wav, duration: 8, __seed: 'MUSIC-WAV' }, { projectDir: project });
    const wavMaterial = doc.materials.audios.find(item => item.name === 'finish-music');
    assert.equal(path.extname(wavMaterial.path), '.wav');
    assert.equal(fs.readFileSync(wavMaterial.path, 'utf8'), 'wav-bytes');
    assert.equal(fs.existsSync(musicCachePaths(project).meta), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
