import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySpec, doctor, readJson, stableJson } from '../src/core.mjs';
import { assertOrigin, isEphemeralPath, isPreframed } from '../src/origin.mjs';

/** node:assert's throws() does not hand back the error, and the error's `code` is the contract. */
function raises(fn) {
  try { fn(); } catch (error) { return error; }
  throw new assert.AssertionError({ message: 'expected a throw, got none' });
}

/**
 * The regression these guard is "AI Video Editor": B-roll cropped 1920x1080 -> 1080x960 with
 * ffmpeg in a session scratchpad, imported, and placed with an identity transform. It looked
 * right and doctor passed — and the human could not reframe a single shot, because the rows
 * outside the crop were gone and the recorded original pointed into a deleted temp directory.
 */

test('a frame exactly half the canvas is a crop, not a capture', () => {
  assert.ok(isPreframed({ width: 1080, height: 960, canvas: [1080, 1920] }));
  assert.equal(isPreframed({ width: 1080, height: 960, canvas: [1080, 1920] }).region, 'upper/lower half');
  assert.ok(isPreframed({ width: 540, height: 1920, canvas: [1080, 1920] }));
});

test('plausible capture sizes are not flagged — including the canvas itself', () => {
  // Phones really do record exactly 1080x1920, so full-canvas media carries no information.
  assert.equal(isPreframed({ width: 1080, height: 1920, canvas: [1080, 1920] }), null);
  assert.equal(isPreframed({ width: 1920, height: 1080, canvas: [1080, 1920] }), null);
  assert.equal(isPreframed({ width: 1440, height: 2560, canvas: [1080, 1920] }), null);
  assert.equal(isPreframed({ width: 4112, height: 2658, canvas: [1080, 1920] }), null);
});

test('scratchpad and system temp paths are ephemeral, a recordings folder is not', () => {
  assert.equal(isEphemeralPath('/private/tmp/claude-501/x/scratchpad/broll/grok-work.mp4'), true);
  assert.equal(isEphemeralPath(path.join(os.tmpdir(), 'clip.mp4')), true);
  assert.equal(isEphemeralPath('/Users/x/Desktop/Screen Recordings/screen-1/screen.mp4'), false);
});

test('a pre-framed import is refused, and the message names the native route', () => {
  const error = raises(() => assertOrigin({
    file: '/Users/x/Movies/broll.mp4', width: 1080, height: 960, canvas: [1080, 1920],
  }));
  assert.equal(error.code, 'PREFRAMED_MEDIA');
  assert.match(error.message, /layout broll .*--row/);
  assert.match(error.message, /layout screen/);
});

test('--generated is the escape hatch for a render with no editable original', () => {
  const note = assertOrigin({
    file: '/Users/x/Movies/gfx-cli.mp4', width: 1080, height: 960, canvas: [1080, 1920],
    generated: true,
  });
  assert.equal(note.kind, 'generated');
  assert.equal(note.preframed, true);
});

test('--derived-from is accepted only when it names a real, durable file', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-origin-'));
  const missing = raises(() => assertOrigin({
    file: '/Users/x/Movies/broll.mp4', width: 1080, height: 960, canvas: [1080, 1920],
    derivedFrom: path.join(temp, 'nope.mp4'),
  }));
  assert.equal(missing.code, 'DERIVED_SOURCE_MISSING');

  const scratch = path.join(temp, 'scratchpad');
  fs.mkdirSync(scratch);
  const inTemp = path.join(scratch, 'origin.mp4');
  fs.writeFileSync(inTemp, 'bytes');
  const ephemeral = raises(() => assertOrigin({
    file: '/Users/x/Movies/broll.mp4', width: 1080, height: 960, canvas: [1080, 1920],
    derivedFrom: inTemp,
  }));
  assert.equal(ephemeral.code, 'DERIVED_SOURCE_EPHEMERAL');
});

test('an ephemeral source is refused, unless the project is just as temporary', () => {
  const scratch = '/private/tmp/agent-session/scratchpad/broll/grok-work.mp4';
  const error = raises(() => assertOrigin({
    file: scratch, width: 1920, height: 1080, canvas: [1080, 1920],
    projectDir: '/Users/x/Movies/CapCut/User Data/Projects/com.lveditor.draft/Demo',
  }));
  assert.equal(error.code, 'EPHEMERAL_MEDIA');
  // A draft under the same temp root cannot outlive its own media, so there is nothing to protect.
  assert.equal(assertOrigin({
    file: scratch, width: 1920, height: 1080, canvas: [1080, 1920],
    projectDir: '/private/tmp/agent-session/Demo',
  }).kind, 'capture');
});

function project({ width = 1920, height = 1080 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-origin-project-'));
  const dir = path.join(temp, 'Origin Project');
  const timelineId = 'TIMELINE-ONE';
  const face = path.join(temp, 'face.mp4');
  const broll = path.join(temp, 'screen.mp4');
  fs.writeFileSync(face, 'face-bytes');
  fs.writeFileSync(broll, 'screen-bytes');
  const doc = {
    id: timelineId, name: 'Origin Project', duration: 10_000_000, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [{ id: 'VIDEO', type: 'video', path: face, duration: 60_000_000, width: 1440, height: 2560 }],
      common_mask: [], video_effects: [], speeds: []
    },
    tracks: [
      { id: 'T0', type: 'video', flag: 0, attribute: 0, segments: [] },
      { id: 'T1', type: 'video', flag: 2, attribute: 0, name: 'content', segments: [{
        id: 'SUBJECT', material_id: 'VIDEO', extra_material_refs: [],
        enable_video_mask: false, speed: 1, volume: 1, render_index: 2, track_render_index: 1,
        desc: 'scene 1',
        source_timerange: { start: 0, duration: 5_000_000 },
        target_timerange: { start: 0, duration: 5_000_000 },
        clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
      }] }
    ]
  };
  const write = (target, value) => {
    fs.mkdirSync(target, { recursive: true });
    for (const f of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(target, f), stableJson(value));
    }
  };
  write(dir, doc);
  write(path.join(dir, 'Timelines', timelineId), structuredClone(doc));
  fs.writeFileSync(path.join(dir, 'Timelines', 'project.json'),
    stableJson({ main_timeline_id: timelineId, timelines: [{ id: timelineId }] }));
  return { temp, dir, broll, width, height };
}

const add = (p, extra = {}) => ({
  op: 'clip.add', media: p.broll, at: 1, duration: 2, src: 0, track: 'broll',
  volume: 0, desc: 'b-roll', width: p.width, height: p.height,
  mediaDuration: 400_100_000, localize: true, ...extra
});

test('clip.add refuses half-canvas media and commits nothing', () => {
  const p = project({ width: 1080, height: 960 });
  const error = raises(() => applySpec(p.dir, { version: 1, operations: [add(p)] }, { forceRunning: true }));
  assert.equal(error.code, 'PREFRAMED_MEDIA');
  const doc = readJson(path.join(p.dir, 'draft_info.json'));
  assert.equal(doc.tracks.find(t => t.name === 'broll'), undefined);
});

test('a full-frame capture goes in and is stamped as one', () => {
  const p = project();
  applySpec(p.dir, { version: 1, operations: [add(p)] }, { forceRunning: true });
  const doc = readJson(path.join(p.dir, 'draft_info.json'));
  const seg = doc.tracks.find(t => t.name === 'broll').segments[0];
  const material = doc.materials.videos.find(m => m.id === seg.material_id);
  assert.equal(material.capcutctl_origin, 'capture');
  assert.equal(material.capcutctl_preframed, undefined);
});

test('--generated lets a rendered graphic through and records why', () => {
  const p = project({ width: 1080, height: 960 });
  applySpec(p.dir, { version: 1, operations: [add(p, { generated: true })] }, { forceRunning: true });
  const doc = readJson(path.join(p.dir, 'draft_info.json'));
  const seg = doc.tracks.find(t => t.name === 'broll').segments[0];
  const material = doc.materials.videos.find(m => m.id === seg.material_id);
  assert.equal(material.capcutctl_origin, 'generated');
  const map = readJson(path.join(p.dir, '.capcutctl', 'media-map.json'));
  assert.equal(Object.values(map.materials)[0].origin, 'generated');
  // A generated asset has no original to relink, so doctor must not nag about it.
  const report = doctor(p.dir, { checkFiles: false });
  assert.equal(report.issues.filter(i => i.code === 'MEDIA_PREFRAMED').length, 0);
});

test('--derived-from records the real source and satisfies the contract', () => {
  const p = project({ width: 1080, height: 960 });
  const original = path.join(p.temp, 'screen-original.mp4');
  fs.writeFileSync(original, 'original-bytes');
  applySpec(p.dir, { version: 1, operations: [add(p, { derivedFrom: original, derivedOffset: 220 })] },
    { forceRunning: true });
  const doc = readJson(path.join(p.dir, 'draft_info.json'));
  const seg = doc.tracks.find(t => t.name === 'broll').segments[0];
  const material = doc.materials.videos.find(m => m.id === seg.material_id);
  assert.equal(material.capcutctl_origin, 'derived');
  assert.equal(material.derived_from_path, fs.realpathSync.native(original));
  assert.equal(material.derived_from_offset, 220);
});

test('doctor reports pre-framed media and an origin that no longer exists', () => {
  const p = project();
  const gone = path.join(p.temp, 'deleted-source.mp4');
  fs.writeFileSync(gone, 'bytes');
  applySpec(p.dir, { version: 1, operations: [add(p, { media: gone })] }, { forceRunning: true });
  // Simulate the scratchpad being cleaned up, and a project built before the contract existed.
  fs.unlinkSync(gone);
  const file = path.join(p.dir, 'draft_info.json');
  const doc = readJson(file);
  const material = doc.materials.videos.find(m => m.capcutctl_origin === 'capture');
  material.width = 1080;
  material.height = 960;
  delete material.capcutctl_origin;
  fs.writeFileSync(file, stableJson(doc));

  const report = doctor(p.dir, { checkFiles: false });
  const codes = report.issues.map(i => i.code);
  assert.ok(codes.includes('MEDIA_PREFRAMED'), `expected MEDIA_PREFRAMED, got ${codes.join(', ')}`);
  assert.ok(codes.includes('MEDIA_ORIGIN_LOST'), `expected MEDIA_ORIGIN_LOST, got ${codes.join(', ')}`);
  assert.equal(report.errors, 0, 'the audit must never break an existing project');
});

test('layout.screen obeys the same contract — it is the verb that replaces the ffmpeg crop', () => {
  const p = project();
  const cropped = path.join(p.temp, 'already-cropped.mp4');
  fs.writeFileSync(cropped, 'bytes');
  const error = raises(() => applySpec(p.dir, { version: 1, operations: [{
    op: 'layout.screen', media: cropped, at: 1, duration: 2,
    width: 1080, height: 960, mediaDuration: 60_000_000, track: 'screen',
  }] }, { forceRunning: true }));
  assert.equal(error.code, 'PREFRAMED_MEDIA');
});
