import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateVt, partForMedia, takeParts, vtInPart } from '../src/rl2-take.mjs';
import { loadClicks } from '../src/punch.mjs';
import { momentsFromSidecar } from '../src/broll-lint.mjs';
import { mapTakeVt } from '../src/polish.mjs';

const ndjson = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

/** A take the watchdog restarted: part 1 is vt 0–10, a gap, part 2 starts at vt 12. */
function twoPartTake(segments) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-rl2-parts-'));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    clock: { first_frame_host: 100 },
    video_segments: segments ?? [
      { file: 'screen.mp4', start_vt: 0, end_vt: 10, frames: 300 },
      { file: 'screen-part02.mp4', start_vt: 12, end_vt: 20, frames: 240 },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'trace.ndjson'), ndjson([
    { type: 'click', vt: 5, in_capture: true },
    { type: 'click', vt: 11, in_capture: true },
    { type: 'click', vt: 15, in_capture: true },
  ]));
  fs.writeFileSync(path.join(dir, 'change.ndjson'), ndjson([
    { n: 1, vt: 0, score: 0 }, { n: 2, vt: 5, score: 9 }, { n: 3, vt: 11, score: 9 },
    { n: 4, vt: 15, score: 9 }, { n: 5, vt: 20, score: 0 },
  ]));
  for (const file of ['screen.mp4', 'screen-part02.mp4']) fs.writeFileSync(path.join(dir, file), '');
  return dir;
}

test('a restarted take locates vt in its part and refuses the gap', () => {
  const parts = [
    { file: 'screen.mp4', startVt: 0, endVt: 2390 },
    { file: 'screen-part02.mp4', startVt: 2400.06, endVt: null },
  ];
  const at = locateVt(parts, 2410);
  assert.equal(at.file, 'screen-part02.mp4');
  assert.ok(Math.abs(at.t - 9.94) < 1e-6);
  assert.equal(locateVt(parts, 2395), null, 'a restart gap is in no file');
  assert.deepEqual(locateVt(parts, 100), { file: 'screen.mp4', t: 100 });
  assert.equal(partForMedia(parts, '/p/Resources/take-1__screen-part02.mp4').file, 'screen-part02.mp4');
  assert.equal(partForMedia(parts, 'screen-part02__1a2b3c4d_2.mp4').file, 'screen-part02.mp4');
  assert.equal(partForMedia(parts, 'other.mp4'), null);
});

test('the first frames of a restarted part are its own, not the previous part\'s end slack', () => {
  // No end_vt recorded: part 1's end is derived as part 2's start.
  const derived = takeParts('unused', { video_segments: [
    { file: 'screen.mp4', start_vt: 0, frames: 10 },
    { file: 'screen-part02.mp4', start_vt: 100, frames: 10 },
  ] });
  const at = locateVt(derived, 100.02);
  assert.equal(at.file, 'screen-part02.mp4');
  assert.ok(Math.abs(at.t - 0.02) < 1e-6, at);
  assert.equal(locateVt(derived, 99.99).file, 'screen.mp4');
  // A restart gap shorter than the end slack.
  const tight = [
    { file: 'screen.mp4', startVt: 0, endVt: 99.98 },
    { file: 'screen-part02.mp4', startVt: 100, endVt: null },
  ];
  assert.equal(locateVt(tight, 100.01).file, 'screen-part02.mp4');
  assert.equal(locateVt(tight, 99.99).file, 'screen.mp4', 'the slack still covers the last frame');
});

test('a one-part take is the plain case: its file, and vt is the file time', () => {
  const dir = twoPartTake([{ file: 'screen.mp4', start_vt: 0, frames: 10 }]);
  const parts = takeParts(dir);
  assert.deepEqual(parts, [{ file: 'screen.mp4', startVt: 0, endVt: null }]);
  assert.equal(vtInPart(parts, partForMedia(parts, 'anything.mov'), 11), 11);
  assert.deepEqual(loadClicks(path.join(dir, 'screen.mp4')).map(click => click.vt), [5, 11, 15]);
});

test('clicks, moments and timeline mapping read a part on its own file clock', () => {
  const dir = twoPartTake();
  assert.deepEqual(takeParts(dir).map(part => [part.file, part.startVt, part.endVt]),
    [['screen.mp4', 0, 10], ['screen-part02.mp4', 12, 20]]);

  assert.deepEqual(loadClicks(path.join(dir, 'screen-part02.mp4')).map(click => click.vt), [3]);
  assert.deepEqual(loadClicks(path.join(dir, 'screen.mp4')).map(click => click.vt), [5]);

  const moments = momentsFromSidecar(path.join(dir, 'screen-part02.mp4'), null, { minScore: 1 });
  assert.deepEqual(moments.map(m => m.start), [3], 'the gap row at vt 11 is in no file');

  const parts = takeParts(dir);
  const windows = [
    { srcIn: 0, srcOut: 8, tgtIn: 0, speed: 1, path: path.join(dir, 'screen.mp4') },
    { srcIn: 0, srcOut: 8, tgtIn: 20, speed: 1, path: path.join(dir, 'screen-part02.mp4') },
  ];
  assert.equal(mapTakeVt(windows, parts, 15), 23);
  assert.equal(mapTakeVt(windows, parts, 5), 5);
  assert.equal(mapTakeVt(windows, parts, 11), null);
});
