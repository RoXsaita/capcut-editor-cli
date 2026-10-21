import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { premultiplyFile, straightAlphaLeak, PRORES_ALPHA_ARGS } from '../src/alpha.mjs';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// A straight-alpha ProRes clip like a glow's tail: full yellow at alpha 1/255 over the whole frame,
// and an opaque yellow bar. CapCut (premultiplied) paints the whole frame yellow.
function straightClip(dir) {
  const file = path.join(dir, 'glow.mov');
  const bar = 'between(X,8,55)*between(Y,12,19)';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x32:d=0.5,format=rgba',
    '-vf', `geq=r=255:g='if(${bar},216,255)':b='if(${bar},77,0)':a='if(${bar},255,1)'`, ...PRORES_ALPHA_ARGS, file]);
  return file;
}

test('a straight-alpha overlay leaks colour; premultiplyFile removes it, keeps the opaque bar, and is idempotent',
  { skip: !hasFfmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-'));
    try {
      const file = straightClip(dir);
      assert.ok(straightAlphaLeak(file).leak > 0, 'fixture must leak');
      const fixed = premultiplyFile(file);
      assert.equal(fixed.changed, true);
      assert.equal(straightAlphaLeak(file).leak, 0);
      const px = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.2', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-']);
      const at = (x, y) => [...px.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
      assert.ok(at(32, 16)[3] > 250 && at(32, 16)[0] > 240, 'opaque bar survives');
      assert.ok(Math.max(...at(2, 2).slice(0, 3)) <= at(2, 2)[3] + 3, 'transparent area carries no colour');
      assert.equal(premultiplyFile(file).changed, false, 'second run is a no-op');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

import { alphaSampleTimes, projectAlphaLeaks } from '../src/alpha.mjs';
import { gateReport } from '../src/gate.mjs';
import { resolveMediaPath } from '../src/core.mjs';

const probeStreams = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
  '-of', 'json', file], { encoding: 'utf8' })).streams.map(s => `${s.codec_type}:${s.codec_name}`);
const audioSeconds = file => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
  'stream=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());

// 64x64, 1s, 30 fps: transparent everywhere, with a straight-alpha glow (yellow at alpha 1/255)
// only where `when` holds, and an optional PCM track.
function glowClip(dir, name, when, { audio = false } = {}) {
  const file = path.join(dir, name);
  const glow = `if(${when},1,0)`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1:r=30,format=rgba',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1'] : []),
    '-vf', `geq=r='255*${glow}':g='255*${glow}':b=0:a='${glow}'`, ...PRORES_ALPHA_ARGS,
    ...(audio ? ['-c:a', 'pcm_s16le', '-shortest'] : []), file]);
  return file;
}

test('alpha samples run from the first frames to the last, at most 12', () => {
  const t = alphaSampleTimes(1);
  assert.ok(t[0] <= 0.05 && t.at(-1) >= 0.95, JSON.stringify(t));
  assert.ok(alphaSampleTimes(60).length <= 12);
});

test('premultiply keeps the audio and metadata; an entrance or exit glow is seen; force on a clean file refuses',
  { skip: !hasFfmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-'));
    try {
      const withAudio = glowClip(dir, 'sound.mov', 'lt(T,0.5)', { audio: true });
      const streams = probeStreams(withAudio);
      const seconds = audioSeconds(withAudio);
      assert.equal(premultiplyFile(withAudio).changed, true);
      assert.deepEqual(probeStreams(withAudio), streams, 'stream types are unchanged');
      assert.ok(Math.abs(audioSeconds(withAudio) - seconds) < 0.01, 'audio keeps its duration');
      assert.ok(!fs.readdirSync(dir).some(f => f.includes('.premult')), 'no temp file left');

      const entrance = glowClip(dir, 'in.mov', 'lt(T,0.1)');
      assert.ok(straightAlphaLeak(entrance).leak > 0, 'a glow only in the first 0.1s');
      assert.equal(premultiplyFile(entrance).changed, true);
      const exit = glowClip(dir, 'out.mov', 'gte(T,0.9)');
      assert.ok(straightAlphaLeak(exit).leak > 0, 'a glow only in the last 0.1s');
      assert.equal(premultiplyFile(exit).changed, true);

      assert.throws(() => premultiplyFile(entrance, { force: true }), err => err.code === 'ALREADY_PREMULTIPLIED');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

const overlayDoc = file => ({
  materials: { videos: [{ id: 'FACE', type: 'video', path: '/x/face.mp4', width: 1080, height: 1920 },
    { id: 'GLOW', type: 'video', path: file, width: 64, height: 64 }] },
  tracks: [{ type: 'video', flag: 0, segments: [] },
    { type: 'video', flag: 2, name: 'content', segments: [{ id: 'F', material_id: 'FACE', target_timerange: { start: 0, duration: 5_000_000 },
      source_timerange: { start: 0, duration: 5_000_000 } }] },
    { type: 'video', name: 'mograph-1', segments: [{ id: 'G', material_id: 'GLOW', desc: 'mograph:x', target_timerange: { start: 1_000_000, duration: 1_000_000 },
      source_timerange: { start: 0, duration: 1_000_000 } }] }],
});

test('alpha-premultiplied is never silently dropped: a missing overlay or no project is a WARN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-gate-'));
  try {
    const missing = path.join(dir, 'gone.mov');
    assert.deepEqual(projectAlphaLeaks(overlayDoc(missing), dir, { resolve: resolveMediaPath }).unchecked.map(u => u.reason), ['missing']);
    const row = gateReport(overlayDoc(missing), { projectDir: dir }).checks.find(c => c.id === 'alpha-premultiplied');
    assert.equal(row.level, 'WARN');
    assert.equal(row.ok, false);
    assert.match(row.message, /not checked: gone\.mov \(missing\)/);
    const none = gateReport(overlayDoc(missing), { projectDir: null }).checks.find(c => c.id === 'alpha-premultiplied');
    assert.match(none.message, /^not checked/);
    assert.equal(none.level, 'WARN');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
