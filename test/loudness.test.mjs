import test from 'node:test';
import assert from 'node:assert/strict';
import {
  volumeForLufs, playbackLufs, parseEbur128, classifyLoudnessRole, isMusicSegment,
  opLoudness, DEFAULT_TARGET_LUFS,
} from '../src/loudness.mjs';

const US = s => Math.round(s * 1e6);

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

test('parseEbur128 reads the Integrated loudness summary', () => {
  const stderr = `
[Parsed_ebur128_0 @ 0x1] Summary:
  Integrated loudness:
    I:         -23.7 LUFS
  Loudness range:
    LRA:         4.2 LU
`;
  assert.equal(parseEbur128(stderr), -23.7);
  assert.equal(parseEbur128('I:  -14.0 LUFS'), -14);
  assert.equal(parseEbur128('no loudness here'), null);
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
