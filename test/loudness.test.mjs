import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  volumeForLufs, playbackLufs, classifyLoudnessRole, isMusicSegment,
  opLoudness, DEFAULT_TARGET_LUFS, analyzeAudio,
} from '../src/loudness.mjs';

const US = s => Math.round(s * 1e6);

test('edited-range measurement, peak-limited gain, mixed clipping and mute preservation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-levels-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'levels.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=8:sample_rate=48000', '-af',
    "volume='if(lt(t,4),0.1,4)':eval=frame", '-c:a', 'pcm_f32le', file]);
  const d = { duration: US(4), materials: { audios: [{ id: 'A', type: 'extract', path: file }] },
    tracks: [{ type: 'audio', segments: [{ id: 'a', material_id: 'A', volume: 1,
      source_timerange: { start: 0, duration: US(4) }, target_timerange: { start: 0, duration: US(4) }, extra_material_refs: [] }] }] };
  const quiet = analyzeAudio(d, root);
  const automated = structuredClone(d);
  automated.tracks[0].segments[0].common_keyframes = [{ property_type: 'KFTypeVolume' }];
  assert.throws(() => analyzeAudio(automated, root), { code: 'AUDIO_MEASURE_FAILED' });
  d.tracks[0].segments[0].source_timerange.start = US(4);
  const loud = analyzeAudio(d, root);
  assert.ok(loud.mix.lufs - quiet.mix.lufs > 25);
  const normalized = opLoudness(d, { target: -8, peak: -12 }, { projectDir: root });
  assert.equal(normalized.segments[0].peakLimited, true);
  assert.ok(normalized.afterMix.truePeak <= -11.95);
  const muted = structuredClone(d.tracks[0].segments[0]);
  muted.id = 'muted'; muted.volume = 0;
  d.tracks[0].segments.push(muted);
  const repeat = opLoudness(d, { target: -8, peak: -12 }, { projectDir: root });
  assert.ok(repeat.skipped.some(s => s.id === 'muted' && s.reason === 'muted'));
  assert.equal(muted.volume, 0);
  const bed = structuredClone(d.tracks[0].segments[0]);
  bed.id = 'music'; bed.volume = 4; bed.desc = 'finish:music';
  d.tracks.push({ type: 'audio', name: 'finish-music', segments: [bed] });
  const before = structuredClone(d);
  assert.throws(() => opLoudness(d, { target: -14, limitPeak: false }, { projectDir: root }), { code: 'MIX_PEAK_EXCEEDED' });
  assert.deepEqual(d, before);
  // by default the over is limited, not refused: the bed only ever goes down
  const limited = opLoudness(d, { target: -14 }, { projectDir: root });
  assert.ok(limited.afterMix.truePeak <= -1);
  assert.ok(bed.volume < 4 || d.tracks[1].segments[0].volume < 4);
  assert.ok(d.tracks[1].segments[0].volume < 4);
  d.materials.audios[0].path = path.join(root, 'missing.wav');
  assert.throws(() => analyzeAudio(d, root), { code: 'AUDIO_MEASURE_FAILED' });
});

/** Synthetic stems: a voice, a hot 0.3 s hit (too short to gate, so loudness keeps its level), a bed. */
function stems(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-peaks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // lavfi's sine is 1/8 full scale, so `peak` is the tone's peak amplitude after the ×8
  const tone = (name, freq, duration, peak) => {
    const file = path.join(root, `${name}.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${duration}:sample_rate=48000`,
      '-af', `volume=${peak * 8}`, '-c:a', 'pcm_f32le', file]);
    return file;
  };
  const audio = (id, material, start, duration, volume, desc, name = '') => ({ type: 'audio', name, segments: [{
    id, material_id: material, volume, desc, extra_material_refs: [],
    source_timerange: { start: 0, duration: US(duration) }, target_timerange: { start: US(start), duration: US(duration) } }] });
  const d = {
    duration: US(6),
    materials: { audios: [
      { id: 'V', type: 'extract', path: tone('voice', 220, 6, 0.5) },
      { id: 'LOUD', type: 'extract', path: tone('loud', 220, 6, 1) },
      { id: 'HIT', type: 'extract', path: tone('hit', 1000, 0.3, 1) },
      { id: 'BED', type: 'music', name: 'finish-music', path: tone('bed', 110, 6, 0.8) },
    ] },
    tracks: [
      audio('voice', 'V', 0, 6, 1, 'voice'),
      audio('hit', 'HIT', 2, 0.3, 1, 'mograph:sfx:kw-1'),
      audio('music', 'BED', 0, 6, 0.211, 'finish:music', 'finish-music'),
    ],
  };
  return { root, d, audio };
}

test('a hot hit over the voice is limited to the ceiling by lowering the layers around the voice', t => {
  const { root, d } = stems(t);
  const level = id => d.tracks.flatMap(x => x.segments).find(s => s.id === id).volume;
  const out = opLoudness(d, { target: -14, peak: -1 }, { projectDir: root });
  assert.ok(out.beforeMix.truePeak > -1, 'the fixture really is over before');
  assert.ok(out.afterMix.truePeak <= -1, `mix true peak ${out.afterMix.truePeak} dBTP`);
  assert.ok(out.refused.some(r => r.id === 'hit' && r.code === 'LUFS_UNMEASURABLE'), 'the short hit keeps its level in the clip pass');
  assert.equal(out.peakLimit.ceiling, -1);
  assert.equal(out.peakLimit.afterTruePeak, out.afterMix.truePeak);
  assert.ok(out.peakLimit.steps.length >= 1);
  assert.ok(out.peakLimit.steps.every(step => step.stage === 'around-voice'), 'the voice stays at its target');
  assert.deepEqual(out.peakLimit.steps[0].segments.map(r => r.id).sort(), ['hit', 'music']);
  assert.ok(level('hit') < 1);
  assert.ok(level('music') < 0.211, 'music only ever goes down from the level the user set');
  const voiceRow = out.segments.find(r => r.id === 'voice');
  assert.ok(Math.abs(level('voice') - voiceRow.volume) < 1e-6, 'the limiter left the voice where the clip pass put it');
});

test('when the voice itself makes the over, the whole mix comes down and music never rises', t => {
  const { root, d, audio } = stems(t);
  // no hit: two voices in phase are the over, and a bed far below them cannot fix it
  d.tracks.splice(1, 1);
  d.tracks[0].segments[0].material_id = 'LOUD';
  d.tracks.push(audio('voice2', 'LOUD', 0, 6, 1, 'voice'));
  d.tracks[1].segments[0].volume = 0.02;
  const out = opLoudness(d, { target: -6, peak: -1 }, { projectDir: root });
  assert.ok(out.beforeMix.truePeak > -1);
  assert.ok(out.afterMix.truePeak <= -1, `mix true peak ${out.afterMix.truePeak} dBTP`);
  assert.equal(out.peakLimit.steps.at(-1).stage, 'whole-mix');
  assert.ok(!out.peakLimit.steps.some(step => step.stage === 'around-voice'), 'a step that did not help was undone');
  const music = d.tracks.flatMap(x => x.segments).find(s => s.id === 'music');
  assert.ok(music.volume < 0.02);
  assert.ok(out.changed >= 3);
});

function doc() {
  return {
    loudnesses: { enable: false, target_loudness: 0 },
    materials: {
      videos: [
        { id: 'CAM', type: 'video', path: '/tmp/capcutctl-loudness-cam.mp4' },
        { id: 'SCR', type: 'video', path: '/tmp/capcutctl-loudness-screen.mp4' },
      ],
      audios: [
        { id: 'SFX', type: 'extract', path: '/tmp/capcutctl-loudness-click.mp4', name: 'click' },
        { id: 'BED', type: 'music', path: '/tmp/capcutctl-loudness-bed.mp3', name: 'finish-music' },
      ],
      audio_fades: [{
        id: 'fade1', type: 'audio_fade', fade_type: 0,
        fade_in_duration: US(0.08), fade_out_duration: US(0.12),
      }],
    },
    tracks: [
      { type: 'video', flag: 0, segments: [] },
      {
        type: 'video', flag: 2, name: 'face',
        segments: [{
          id: 'face0', material_id: 'CAM', desc: 'talking-head', volume: 1,
          extra_material_refs: ['fade1'],
          source_timerange: { start: 0, duration: US(4) },
          target_timerange: { start: 0, duration: US(4) },
        }],
      },
      {
        type: 'video', flag: 2, name: 'broll',
        segments: [{
          id: 'b0', material_id: 'SCR', desc: 'broll: screen', volume: 0,
          extra_material_refs: [],
          source_timerange: { start: 0, duration: US(4) },
          target_timerange: { start: 0, duration: US(4) },
        }],
      },
      {
        type: 'audio', flag: 0, name: 'polish-sfx',
        segments: [{
          id: 'sfx0', material_id: 'SFX', desc: 'polish:sfx', volume: 1,
          extra_material_refs: [],
          source_timerange: { start: 0, duration: US(0.2) },
          target_timerange: { start: US(1), duration: US(0.2) },
        }],
      },
      {
        type: 'audio', flag: 0, name: 'finish-music',
        segments: [{
          id: 'mus0', material_id: 'BED', desc: 'finish:music', volume: 0.08,
          extra_material_refs: [],
          source_timerange: { start: 0, duration: US(4) },
          target_timerange: { start: 0, duration: US(4) },
        }],
      },
    ],
  };
}

test('volumeForLufs is 10^((target-measured)/20)', () => {
  assert.ok(Math.abs(volumeForLufs(-8, -14) - 10 ** (-6 / 20)) < 1e-12);
  assert.ok(Math.abs(volumeForLufs(-20, -14) - 10 ** (6 / 20)) < 1e-12);
  assert.equal(volumeForLufs(-14, -14), 1);
  assert.equal(playbackLufs(-8, volumeForLufs(-8, -14)), -14);
});

test('a selected boost leaves other clips alone and ebur128 silence is never amplified', () => {
  const d = doc(); const before = structuredClone(d.tracks[3]);
  const out = opLoudness(d, { segments: ['face0'], measurements: -18, allowBoost: true });
  assert.equal(out.changed, 1);
  assert.ok(d.tracks[1].segments[0].volume > 1);
  assert.deepEqual(d.tracks[3], before);
  const silent = opLoudness(d, { segments: ['sfx0'], measurements: -70, allowBoost: true });
  assert.equal(silent.changed, 0);
  assert.equal(silent.refused[0].code, 'LUFS_UNMEASURABLE');
  assert.deepEqual(d.tracks[3], before);
  assert.throws(() => opLoudness(d, { segments: ['missing'], measurements: -18 }), { code: 'SELECTOR_EMPTY' });
  const trimmed = opLoudness(doc(), { segments: ' face0 ', measurements: -18, allowBoost: true });
  assert.equal(trimmed.changed, 1);
  assert.throws(() => opLoudness(doc(), { segments: 'missing', measurements: -18 }), { code: 'SELECTOR_EMPTY' });
});

test('music vs speech vs sfx vs b-roll classification', () => {
  const d = doc();
  const face = d.tracks[1].segments[0];
  const broll = d.tracks[2].segments[0];
  const sfx = d.tracks[3].segments[0];
  const mus = d.tracks[4].segments[0];
  const videos = Object.fromEntries(d.materials.videos.map(m => [m.id, m]));
  const audios = Object.fromEntries(d.materials.audios.map(m => [m.id, m]));
  assert.equal(classifyLoudnessRole(d.tracks[1], face, videos.CAM), 'speech');
  assert.equal(classifyLoudnessRole(d.tracks[2], broll, videos.SCR), 'skip');
  assert.equal(classifyLoudnessRole(d.tracks[3], sfx, audios.SFX), 'sfx');
  assert.equal(classifyLoudnessRole(d.tracks[4], mus, audios.BED), 'music');
  assert.equal(isMusicSegment(d.tracks[4], mus, audios.BED), true);
  // a graphic's paired cue is an effect around the voice, not a second voice
  assert.equal(classifyLoudnessRole({ type: 'audio', name: 'mograph-sfx' }, { ...sfx, desc: 'mograph:sfx:kw-1' }, audios.SFX), 'sfx');
});

test('opLoudness attenuates speech and SFX to −14 LUFS and leaves music/b-roll/fades', () => {
  const d = doc();
  const fadeBefore = JSON.stringify(d.materials.audio_fades);
  const refsBefore = [...d.tracks[1].segments[0].extra_material_refs];
  const musicVol = d.tracks[4].segments[0].volume;
  const brollVol = d.tracks[2].segments[0].volume;
  const loudnesses = JSON.stringify(d.loudnesses);
  const out = opLoudness(d, {
    target: DEFAULT_TARGET_LUFS,
    measurements: {
      '/tmp/capcutctl-loudness-cam.mp4': -8,
      '/tmp/capcutctl-loudness-click.mp4': -8,
      '/tmp/capcutctl-loudness-bed.mp3': -18,
      '/tmp/capcutctl-loudness-screen.mp4': -8,
    },
  });
  const expected = volumeForLufs(-8, -14);
  assert.ok(expected < 1);
  assert.equal(out.changed, 2);
  assert.equal(d.tracks[1].segments[0].volume, expected);
  assert.equal(d.tracks[3].segments[0].volume, expected);
  assert.equal(d.tracks[4].segments[0].volume, musicVol);
  assert.equal(d.tracks[2].segments[0].volume, brollVol);
  assert.deepEqual(d.tracks[1].segments[0].extra_material_refs, refsBefore);
  assert.equal(JSON.stringify(d.materials.audio_fades), fadeBefore);
  assert.equal(JSON.stringify(d.loudnesses), loudnesses);
  assert.ok(out.skipped.some(row => row.reason === 'music'));
  assert.equal(out.segments.length, 2);
  assert.equal(out.segments[0].afterLufs, -14);
  assert.equal(out.refused.length, 0);
});

test('a needed boost is refused as VOLUME_BOOST_UNVERIFIED and the clip is unchanged', () => {
  const d = doc();
  const out = opLoudness(d, {
    measurements: {
      '/tmp/capcutctl-loudness-cam.mp4': -20,
      '/tmp/capcutctl-loudness-click.mp4': -8,
    },
  });
  assert.equal(d.tracks[1].segments[0].volume, 1);
  assert.ok(out.refused.some(row => row.id === 'face0' && row.code === 'VOLUME_BOOST_UNVERIFIED'));
  assert.ok(d.tracks[3].segments[0].volume < 1);
  assert.equal(out.changed, 1);
});

test('--allow-boost writes volume > 1 and marks UNVERIFIED', () => {
  const d = doc();
  const out = opLoudness(d, {
    allowBoost: true,
    measurements: {
      '/tmp/capcutctl-loudness-cam.mp4': -20,
      '/tmp/capcutctl-loudness-click.mp4': -14,
    },
  });
  assert.ok(d.tracks[1].segments[0].volume > 1);
  assert.equal(out.unverified, true);
  assert.ok(out.segments.some(row => row.id === 'face0' && row.unverified));
  assert.equal(d.tracks[3].segments[0].volume, 1);
});
