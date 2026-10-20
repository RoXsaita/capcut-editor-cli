import './helpers/sfx-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { applySpec, readJson, validateDocument, LOCAL_MEDIA_DIR } from '../src/core.mjs';
import { opSfxPlace } from '../src/polish.mjs';
import { classifyLoudnessRole } from '../src/loudness.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { buildProject } from './helpers/polish-project.mjs';

const US = s => Math.round(s * 1e6);

function blank() {
  return {
    duration: US(30), fps: 30, canvas_config: { width: 1080, height: 1920 },
    materials: { videos: [], audios: [] }, tracks: [],
  };
}

const lane = (doc, name) => doc.tracks.find(t => t.type === 'audio' && t.name === name);

function assertNoLaneOverlap(doc) {
  for (const track of doc.tracks.filter(t => t.type === 'audio')) {
    const segs = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1].target_timerange;
      assert.ok(prev.start + prev.duration <= segs[i].target_timerange.start, `${track.name} overlaps`);
    }
  }
  assert.ok(!validateDocument(doc, { checkFiles: false }).some(issue => issue.code === 'TRACK_OVERLAP'));
}

test('a click inside a typing bed spills to the next lane, and comes back when free', () => {
  const doc = blank();
  const bed = opSfxPlace(doc, { sound: 'typing', cues: [{ at: 8, dur: 3 }], __seed: 'sfx-lanes' });
  assert.equal(bed.track, 'sfx-keys');
  const clicks = opSfxPlace(doc, { sound: 'click', cues: [{ at: 9 }, { at: 10 }], __seed: 'sfx-lanes' });
  assert.deepEqual(clicks.tracks, ['sfx-keys-2']);
  assert.equal(lane(doc, 'sfx-keys').segments.length, 1);
  assert.equal(lane(doc, 'sfx-keys-2').segments.length, 2);
  const later = opSfxPlace(doc, { sound: 'click', cues: [{ at: 20 }], __seed: 'sfx-lanes' });
  assert.deepEqual(later.tracks, ['sfx-keys']);
  assertNoLaneOverlap(doc);
});

test('one call whose own cues overlap splits across lanes; --track spills to <track>-2', () => {
  const doc = blank();
  const out = opSfxPlace(doc, { sound: 'typing', cues: [{ at: 1, dur: 2 }, { at: 2, dur: 2 }], __seed: 'sfx-self' });
  assert.deepEqual(out.tracks, ['sfx-keys', 'sfx-keys-2']);
  const named = opSfxPlace(doc, { sound: 'click', track: 'enter', cues: [{ at: 5 }, { at: 5.1 }], __seed: 'sfx-self' });
  assert.deepEqual(named.tracks, ['enter', 'enter-2']);
  assertNoLaneOverlap(doc);
  // An exact repeat is skipped, not stacked on a third lane.
  const again = opSfxPlace(doc, { sound: 'click', track: 'enter', cues: [{ at: 5 }], __seed: 'sfx-self' });
  assert.equal(again.changed, 0);
  assert.equal(again.skipped[0].code, 'SFX_DUPLICATE');
  assert.equal(lane(doc, 'enter-3'), undefined);
});

function tinyWav(dir) {
  const file = path.join(dir, 'whoosh.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
    '-ac', '1', '-ar', '22050', '-y', file], { stdio: 'ignore' });
  return file;
}

test('sfx --file localizes the WAV as a sound with no library identity', () => {
  const project = buildProject();
  const wav = tinyWav(path.dirname(project));
  const mediaDir = path.join(project, LOCAL_MEDIA_DIR);
  const spec = cues => ({ version: 1, name: 'sfx', operations: [{ op: 'sfx.place', file: wav, cues, volume: 0.7, fadeOut: 0.1 }] });

  applySpec(project, spec([{ at: 1 }, { at: 3, dur: 2 }]), { dryRun: true });
  assert.ok(!fs.existsSync(mediaDir) || !fs.readdirSync(mediaDir).some(n => n.startsWith('sfx-')), 'dry run copies nothing');

  applySpec(project, spec([{ at: 1 }, { at: 3, dur: 2 }]));
  let doc = readJson(path.join(project, 'draft_info.json'));
  const mats = doc.materials.audios.filter(m => m.name === 'whoosh.wav');
  assert.equal(mats.length, 1);
  const mat = mats[0];
  assert.equal(path.dirname(mat.path), mediaDir);
  assert.ok(fs.existsSync(mat.path));
  assert.equal(mat.type, 'sound');
  for (const key of ['effect_id', 'resource_id', 'music_id', 'third_resource_id', 'unique_id']) assert.equal(mat[key], '', key);
  const segs = doc.tracks.flatMap(t => t.segments.map(s => ({ s, t }))).filter(({ s }) => s.material_id === mat.id);
  assert.deepEqual(segs.map(({ s }) => s.target_timerange.start).sort((a, b) => a - b), [US(1), US(3)]);
  for (const { s, t } of segs) {
    assert.ok(Math.abs(s.target_timerange.duration - US(0.5)) <= 1000, 'clamped to the file length');
    assert.equal(s.desc, 'sfx:file:whoosh.wav');
    assert.equal(s.volume, 0.7);
    assert.notEqual(classifyLoudnessRole(t, s, mat), 'music');
    assert.equal(classifyLoudnessRole(t, s, mat), 'sfx');
  }

  applySpec(project, spec([{ at: 6 }]));
  doc = readJson(path.join(project, 'draft_info.json'));
  assert.equal(doc.materials.audios.filter(m => m.name === 'whoosh.wav').length, 1, 'a rerun reuses the material');
  assert.equal(doc.tracks.flatMap(t => t.segments).filter(s => s.material_id === mat.id).length, 3);
});

test('CLI: sfx needs exactly one source, add refuses audio', async t => {
  const project = buildProject();
  const restore = setOutput(() => true);
  t.after(restore);
  await assert.rejects(main(['sfx', '--project', project, '--sound', 'click', '--file', 'x.wav', '--cues', '1']),
    error => error.code === 'SFX_SOURCE' && error.exitCode === 2);
  await assert.rejects(main(['sfx', '--project', project, '--cues', '1']),
    error => error.code === 'SFX_SOURCE' && error.exitCode === 2);
  await assert.rejects(main(['add', '--project', project, '--media', 'x.wav', '--at', '1', '--dur', '1', '--track', 'broll']),
    error => error.code === 'ADD_AUDIO' && error.exitCode === 2 && /capcutctl sfx .*--file/.test(error.message));
});
