import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findIndexFile, findIndexForMaterial, indexStems, INDEX_MISMATCH } from '../src/video-index.mjs';
import { findWords, resolveAnchors } from '../src/anchors.mjs';
import { loadEnergy10, loadTranscript } from '../src/stress.mjs';
import { speechSpans } from '../src/duck.mjs';

/** A temp HOME with ~/Downloads/.video-index, restored after `fn`. */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-video-index-'));
  const cache = path.join(home, 'Downloads', '.video-index');
  fs.mkdirSync(cache, { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return fn({ home, cache }); } finally {
    process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function media(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function tokenFor(file) {
  const st = fs.statSync(file, { bigint: true });
  return { ino: Number(st.ino), inode: Number(st.ino), size: Number(st.size), mtime_ns: Number(st.mtimeNs), content_hash: 'x' };
}

const transcript = (words, extra = {}) => ({ segments: [{ start: words[0].start, end: words.at(-1).end, words }], ...extra });
const whisper = (cache, stem, words, token) => {
  const file = path.join(cache, `${stem}.whisper-mlx-community-whisper-large-v3-turbo.json`);
  fs.writeFileSync(file, JSON.stringify(transcript(words, token ? { _token: token } : {})));
  return file;
};
const energy = (cache, stem, db, token) => {
  const file = path.join(cache, `${stem}.energy10.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 2, bin: 0.01, db, ...(token ? { token } : {}) }));
  return file;
};

function faceDoc(material) {
  return {
    fps: 30, duration: 4_000_000,
    materials: { videos: [material], speeds: [] },
    tracks: [{ id: 'T', type: 'video', flag: 2, name: 'content', segments: [{
      id: 'S', material_id: material.id, volume: 1, extra_material_refs: [],
      source_timerange: { start: 0, duration: 4_000_000 }, target_timerange: { start: 0, duration: 4_000_000 },
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
    }] }],
  };
}

test('stems strip the localize prefix at any __ and the collision tag', () => {
  assert.ok(indexStems('/p/Resources/CapcutctlMedia/Downloads__face.mp4').includes('face'));
  assert.ok(indexStems('/p/My__Takes__face__1a2b3c4d_2.mp4').includes('face'));
  assert.ok(indexStems('/x/face 1.mp4').includes('face_1'));
});

test('two face.mp4 takes: a whisper whose token is the other take is refused, not returned', () => withHome(({ home, cache }) => {
  const a = media(path.join(home, 'a', 'face.mp4'), 'short');
  const b = media(path.join(home, 'b', 'face.mp4'), 'a much longer take');
  whisper(cache, 'face', [{ word: 'hi', start: 1, end: 1.4 }], tokenFor(b));
  const hit = findIndexFile(a, 'whisper');
  assert.equal(hit.file, null);
  assert.equal(hit.reason, INDEX_MISMATCH);
  assert.ok(findIndexFile(b, 'whisper').file, 'the take it was built from still finds it');
  assert.equal(findIndexFile(path.join(home, 'moved', 'face.mp4'), 'whisper').file, null, 'a tokened index never binds to missing media');
}));

test('a localized copy (new inode, same size) is accepted; same inode needs the same mtime', () => withHome(({ home, cache }) => {
  const original = media(path.join(home, 'Downloads', 'face.mp4'), 'take bytes');
  const copy = path.join(home, 'proj', 'Resources', 'CapcutctlMedia', 'Downloads__face.mp4');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(original, copy);
  const file = whisper(cache, 'face', [{ word: 'hi', start: 1, end: 1.4 }], tokenFor(original));
  assert.equal(findIndexFile(copy, 'whisper').file, file);
  const stale = { ...tokenFor(original), mtime_ns: tokenFor(original).mtime_ns - 5e9 };
  whisper(cache, 'face', [{ word: 'hi', start: 1, end: 1.4 }], stale);
  assert.equal(findIndexFile(original, 'whisper').file, null, 're-recorded in place: same inode, other mtime');
}));

test("facecam.whisper does not answer for face.mp4; legacy files with no token still resolve", () => withHome(({ home, cache }) => {
  const face = media(path.join(home, 'face.mp4'), 'face');
  whisper(cache, 'facecam', [{ word: 'no', start: 0, end: 1 }]);
  assert.equal(findIndexFile(face, 'whisper').file, null);
  const legacy = whisper(cache, 'face', [{ word: 'yes', start: 0, end: 1 }]);
  assert.deepEqual(findIndexFile(face, 'whisper'), { file: legacy, legacy: true });
}));

test('a derived face reaches its original index: words, energy and the duck all resolve', () => withHome(({ home, cache }) => {
  const original = media(path.join(home, 'Downloads', 'take.mp4'), 'original take');
  const project = path.join(home, 'proj');
  const derived = media(path.join(project, 'Resources', 'CapcutctlDerived', 'denoise-0123456789abcdef0123.mp4'), 'denoised');
  whisper(cache, 'take', [{ word: 'claude', start: 1.0, end: 1.5 }], tokenFor(original));
  energy(cache, 'take', Array(400).fill(-20), tokenFor(original));
  const material = { id: 'M', type: 'video', path: derived, derived_from_path: original, duration: 4_000_000 };
  const doc = faceDoc(material);
  assert.ok(findWords(doc).file.endsWith('take.whisper-mlx-community-whisper-large-v3-turbo.json'));
  assert.ok(loadTranscript(derived, { material, projectDir: project }));
  assert.equal(loadEnergy10(derived, { material, projectDir: project }).db.length, 400);
  const spans = speechSpans(doc, {}, { projectDir: project });
  assert.ok(spans.regions.length > 0);
  assert.equal(spans.sources[0].source, 'energy10');
  const [hit] = resolveAnchors([{ id: 'x', say: 'claude' }], { doc, projectDir: project });
  assert.equal(hit.at, 1);
}));

test('a nonzero derived offset shifts words and energy into the derived file’s time', () => withHome(({ home, cache }) => {
  const original = media(path.join(home, 'Downloads', 'take.mp4'), 'original take');
  const derived = media(path.join(home, 'proj', 'blur-x.mp4'), 'derived');
  whisper(cache, 'take', [{ word: 'early', start: 1.0, end: 1.5 }, { word: 'claude', start: 3.0, end: 3.4 }], tokenFor(original));
  energy(cache, 'take', [...Array(200).fill(-80), ...Array(200).fill(-20)], tokenFor(original));
  const material = { id: 'M', type: 'video', path: derived, derived_from_path: original, derived_from_offset: 2, duration: 4_000_000 };
  const doc = faceDoc(material);
  const found = findWords(doc);
  assert.equal(found.offset, 2);
  const [hit] = resolveAnchors([{ id: 'x', say: 'claude' }], { doc });
  assert.equal(hit.at, 1, 'a word at 3.0 in the original is 1.0 in the derived file');
  assert.throws(() => resolveAnchors([{ id: 'y', say: 'early' }], { doc }), err => err.code === 'ANCHOR_ORPHANED');
  const shifted = loadEnergy10(derived, { material });
  assert.equal(shifted.db.length, 200);
  assert.equal(shifted.db[0], -20);
  const index = findIndexForMaterial(material, null, 'whisper');
  assert.equal(index.media, original);
}));

test('a screen recording transcript is never chosen for the face', () => withHome(({ home, cache }) => {
  const face = media(path.join(home, 'face.mp4'), 'face');
  const screen = media(path.join(home, 'screen.mp4'), 'screen');
  whisper(cache, 'screen', [{ word: 'click', start: 0, end: 1 }], tokenFor(screen));
  const doc = faceDoc({ id: 'F', type: 'video', path: face, duration: 4_000_000 });
  doc.materials.videos.push({ id: 'SC', type: 'video', path: screen, duration: 4_000_000 });
  doc.tracks.push({ id: 'T2', type: 'video', flag: 2, name: 'screen', segments: [{ id: 'S2', material_id: 'SC',
    source_timerange: { start: 0, duration: 2_000_000 }, target_timerange: { start: 1_000_000, duration: 2_000_000 } }] });
  assert.equal(findWords(doc).file, null);
  assert.throws(() => resolveAnchors([{ id: 'x', say: 'click' }], { doc }), err => err.code === 'ANCHOR_NO_WORDS');
}));
