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
