import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySpec, doctor, readJson, stableJson } from '../src/core.mjs';

function fixture({ duration = 10_000_000, endcard = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-add-'));
  const project = path.join(temp, 'Add Project');
  const timelineId = 'TIMELINE-ONE';
  const media = path.join(temp, 'face.mp4');
  const broll = path.join(temp, 'screen.mp4');
  fs.writeFileSync(media, 'face-bytes');
  fs.writeFileSync(broll, 'screen-bytes');
  const segs = [{
    id: 'SUBJECT', material_id: 'VIDEO', extra_material_refs: [],
    enable_video_mask: false, speed: 1, volume: 1, render_index: 2, track_render_index: 1,
    desc: 'scene 1',
    source_timerange: { start: 0, duration: 5_000_000 },
    target_timerange: { start: 0, duration: 5_000_000 },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
  }];
  if (endcard) {
    segs.push({
      id: 'ENDCARD', material_id: 'VIDEO', extra_material_refs: [],
      enable_video_mask: false, speed: 1, volume: 1, desc: 'layout:endcard',
      source_timerange: { start: 0, duration: 2_000_000 },
      target_timerange: { start: 8_000_000, duration: 2_000_000 },
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
    });
  }
  const doc = {
    id: timelineId, name: 'Add Project', duration, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [{ id: 'VIDEO', type: 'video', path: media, duration: 60_000_000, width: 1440, height: 2560 }],
      common_mask: [], video_effects: [], speeds: []
    },
    tracks: [
      { id: 'T0', type: 'video', flag: 0, attribute: 0, segments: [] },
      { id: 'T1', type: 'video', flag: 2, attribute: 0, name: 'content', segments: segs }
    ]
  };
  const write = (dir, value) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, f), stableJson(value));
    }
  };
  write(project, doc);
  write(path.join(project, 'Timelines', timelineId), structuredClone(doc));
  fs.writeFileSync(path.join(project, 'Timelines', 'project.json'),
    stableJson({ main_timeline_id: timelineId, timelines: [{ id: timelineId }] }));
  if (endcard) {
    fs.mkdirSync(path.join(project, '.capcutctl'), { recursive: true });
    fs.writeFileSync(path.join(project, '.capcutctl', 'created.json'), stableJson({
      template: 'Preset 3', contentTrack: 1,
      preserved: { start: 8_000_000, end: 10_000_000 }
    }));
  }
  return { temp, project, broll, timelineDir: path.join(project, 'Timelines', timelineId) };
}

const addOp = (f, extra = {}) => ({
  op: 'clip.add',
  media: f.broll,
  at: 1,
  duration: 2,
  src: 10,
  track: 'broll',
  volume: 0,
  desc: 'reading-files',
  width: 1080,
  height: 2652,
  mediaDuration: 1_800_000_000,
  ...extra
});

test('add places a muted clip on a new named overlay below the face, ids match across documents', () => {
  const f = fixture();
  const result = applySpec(f.project, { version: 1, name: 'add', operations: [addOp(f)] }, { forceRunning: true });
  assert.equal(result.committed, true);
  const ids = [];
  for (const dir of [f.project, f.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    assert.equal(doc.tracks[0].segments.length, 0, 'main track stays empty');
    const broll = doc.tracks.find(t => t.name === 'broll');
    assert.ok(broll);
    assert.equal(broll.flag, 2);
    assert.equal(broll.segments.length, 1);
    const seg = broll.segments[0];
    ids.push(seg.id);
    assert.equal(seg.desc, 'reading-files');
    assert.equal(seg.volume, 0);
    assert.equal(seg.source_timerange.start, 10_000_000);
    assert.equal(seg.target_timerange.start, 1_000_000);
    assert.equal(seg.target_timerange.duration, 2_000_000);
    const faceIdx = doc.tracks.findIndex(t => t.name === 'content');
    const brollIdx = doc.tracks.indexOf(broll);
    assert.ok(brollIdx < faceIdx, 'broll sits behind the talking head');
  }
  assert.equal(new Set(ids).size, 1);
  const report = doctor(f.project, { checkFiles: true });
  assert.equal(report.errors, 0, report.issues.map(i => i.message).join('; '));
});

test('add refuses overlap on the named overlay rather than committing a warning', () => {
  const f = fixture();
  applySpec(f.project, { version: 1, operations: [addOp(f)] }, { forceRunning: true });
  assert.throws(
    () => applySpec(f.project, { version: 1, operations: [addOp(f, { at: 2, desc: 'overlap' })] }, { forceRunning: true }),
    err => err.code === 'CLIP_OVERLAP' || /overlaps/.test(err.message)
  );
});

test('numeric --track does not create a track', () => {
  const f = fixture();
  assert.throws(
    () => applySpec(f.project, { version: 1, operations: [addOp(f, { track: 9 })] }, { forceRunning: true }),
    err => err.code === 'TRACK_MISSING' || /never creates/.test(err.message)
  );
});

test('add past the end slides the preserved endcard and rewrites created.json', () => {
  const f = fixture({ duration: 10_000_000, endcard: true });
  applySpec(f.project, { version: 1, operations: [addOp(f, { at: 8, duration: 3, src: 0 })] }, { forceRunning: true });
  const created = readJson(path.join(f.project, '.capcutctl', 'created.json'));
  assert.equal(created.preserved.start, 11_000_000);
  assert.equal(created.preserved.end, 13_000_000);
  const doc = readJson(path.join(f.project, 'draft_info.json'));
  const endcard = doc.tracks.flatMap(t => t.segments).find(s => s.id === 'ENDCARD');
  assert.equal(endcard.target_timerange.start, 11_000_000);
  const clip = doc.tracks.find(t => t.name === 'broll').segments[0];
  assert.equal(clip.target_timerange.start, 8_000_000);
  assert.equal(clip.target_timerange.duration, 3_000_000);
  assert.ok(clip.target_timerange.start + clip.target_timerange.duration <= doc.duration);
  assert.equal(doctor(f.project).errors, 0);
});

test('replace-media keeps keyframes and does not clone the segment', () => {
  const f = fixture();
  applySpec(f.project, { version: 1, operations: [addOp(f)] }, { forceRunning: true });
  const before = readJson(path.join(f.project, 'draft_info.json'));
  const seg = before.tracks.find(t => t.name === 'broll').segments[0];
  seg.common_keyframes = [{ property_type: 'KFTypeScaleX', keyframe_list: [
    { time_offset: 10_000_000, values: [1] },
    { time_offset: 10_200_000, values: [2.4] }
  ] }];
  for (const dir of [f.project, f.timelineDir]) {
    const d = readJson(path.join(dir, 'draft_info.json'));
    d.tracks.find(t => t.name === 'broll').segments[0].common_keyframes = seg.common_keyframes;
    fs.writeFileSync(path.join(dir, 'draft_info.json'), stableJson(d));
    fs.writeFileSync(path.join(dir, 'draft_info.json.bak'), stableJson(d));
    fs.writeFileSync(path.join(dir, 'template-2.tmp'), stableJson(d));
  }
  const other = path.join(f.temp, 'other.mp4');
  fs.writeFileSync(other, 'other');
  applySpec(f.project, { version: 1, operations: [{
    op: 'replace.media', selector: { id: seg.id }, path: other,
    width: 1080, height: 1920, mediaDuration: 20_000_000
  }] }, { forceRunning: true });
  const after = readJson(path.join(f.project, 'draft_info.json'));
  const next = after.tracks.find(t => t.name === 'broll').segments[0];
  assert.equal(next.id, seg.id);
  assert.equal(next.common_keyframes[0].keyframe_list[1].values[0], 2.4);
  const mat = after.materials.videos.find(m => m.id === next.material_id);
  assert.equal(mat.path, other);
  assert.equal(mat.width, 1080);
});

test('add past the end slides the endcard on root AND the timeline, not just created.json', () => {
  const f = fixture({ duration: 10_000_000, endcard: true });
  applySpec(f.project, { version: 1, operations: [addOp(f, { at: 8, duration: 3, src: 0 })] }, { forceRunning: true });
  for (const dir of [f.project, f.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    const endcard = doc.tracks.flatMap(t => t.segments).find(s => s.id === 'ENDCARD');
    assert.equal(endcard.target_timerange.start, 11_000_000, dir);
  }
});

test('dry-run add does not rewrite created.json', () => {
  const f = fixture({ duration: 10_000_000, endcard: true });
  applySpec(f.project, { version: 1, operations: [addOp(f, { at: 8, duration: 3, src: 0 })] }, { forceRunning: true, dryRun: true });
  const created = readJson(path.join(f.project, '.capcutctl', 'created.json'));
  assert.equal(created.preserved.start, 8_000_000);
  assert.equal(created.preserved.end, 10_000_000);
});

test('shift past the end extends and slides the preserved window', () => {
  const f = fixture({ duration: 10_000_000, endcard: true });
  applySpec(f.project, { version: 1, operations: [addOp(f, { at: 1, duration: 2 })] }, { forceRunning: true });
  const before = readJson(path.join(f.project, 'draft_info.json'));
  const id = before.tracks.find(t => t.name === 'broll').segments[0].id;
  applySpec(f.project, { version: 1, operations: [{ op: 'clip.shift', selector: { id }, by: 7 }] }, { forceRunning: true });
  const created = readJson(path.join(f.project, '.capcutctl', 'created.json'));
  assert.equal(created.preserved.start, 10_000_000);
  const doc = readJson(path.join(f.project, 'draft_info.json'));
  const clip = doc.tracks.find(t => t.name === 'broll').segments[0];
  assert.equal(clip.target_timerange.start, 8_000_000);
  const endcard = doc.tracks.flatMap(t => t.segments).find(s => s.id === 'ENDCARD');
  assert.equal(endcard.target_timerange.start, 10_000_000);
  assert.equal(doctor(f.project).errors, 0);
});

test('trim rewrites the source window and speed', () => {
  const f = fixture();
  applySpec(f.project, { version: 1, operations: [addOp(f)] }, { forceRunning: true });
  const id = readJson(path.join(f.project, 'draft_info.json')).tracks.find(t => t.name === 'broll').segments[0].id;
  applySpec(f.project, { version: 1, operations: [{ op: 'clip.trim', selector: { id }, src: [20, 28] }] }, { forceRunning: true });
  const seg = readJson(path.join(f.project, 'draft_info.json')).tracks.find(t => t.name === 'broll').segments[0];
  assert.equal(seg.source_timerange.start, 20_000_000);
  assert.equal(seg.source_timerange.duration, 8_000_000);
  assert.equal(seg.speed, 4);
});

test('fade clones a harvested audio_fade extra onto the clip, same id on both documents', () => {
  const f = fixture();
  applySpec(f.project, { version: 1, operations: [addOp(f)] }, { forceRunning: true });
  const id = readJson(path.join(f.project, 'draft_info.json')).tracks.find(t => t.name === 'broll').segments[0].id;
  applySpec(f.project, { version: 1, operations: [{ op: 'clip.fade', selector: { id }, in: 0.08, out: 0.12 }] }, { forceRunning: true });
  const fadeIds = [];
  for (const dir of [f.project, f.timelineDir]) {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    const seg = doc.tracks.find(t => t.name === 'broll').segments[0];
    const fades = doc.materials.audio_fades;
    assert.equal(fades.length, 1);
    assert.equal(fades[0].type, 'audio_fade');
    assert.equal(fades[0].fade_type, 0);
    assert.equal(fades[0].fade_in_duration, 80_000);
    assert.equal(fades[0].fade_out_duration, 120_000);
    assert.ok(seg.extra_material_refs.includes(fades[0].id));
    fadeIds.push(fades[0].id);
  }
  assert.equal(new Set(fadeIds).size, 1);
});

test('scale keyframe offsets are absolute source positions, not 0', () => {
  const f = fixture();
  applySpec(f.project, { version: 1, operations: [addOp(f, { at: 1, duration: 4, src: 90 })] }, { forceRunning: true });
  const id = readJson(path.join(f.project, 'draft_info.json')).tracks.find(t => t.name === 'broll').segments[0].id;
  applySpec(f.project, { version: 1, operations: [{
    op: 'keyframe.scale', selector: { id }, at: 1.0, to: 2.4, hold: 0, ramp: 0.2
  }] }, { forceRunning: true });
  const seg = readJson(path.join(f.project, 'draft_info.json')).tracks.find(t => t.name === 'broll').segments[0];
  const list = seg.common_keyframes[0].keyframe_list;
  assert.equal(seg.common_keyframes[0].property_type, 'KFTypeScaleX');
  assert.equal(list[0].time_offset, 90_000_000);
  assert.equal(list[1].time_offset, 90_200_000);
  assert.equal(list[1].values[0], 2.4);
});

test('scale keyframe refuses two keys that clamp to the same offset', () => {
  const f = fixture();
  applySpec(f.project, { version: 1, operations: [addOp(f, { at: 1, duration: 2, src: 90 })] }, { forceRunning: true });
  const id = readJson(path.join(f.project, 'draft_info.json')).tracks.find(t => t.name === 'broll').segments[0].id;
  assert.throws(
    () => applySpec(f.project, { version: 1, operations: [{
      op: 'keyframe.scale', selector: { id }, at: 3.0, to: 2.4, hold: 0, ramp: 0.2
    }] }, { forceRunning: true }),
    err => err.code === 'KEYFRAME_CLAMPED' || /clamp/.test(err.message)
  );
});

/* ---- regressions from the 2026-08-26 review ---- */

test('two adds in one spec slide the endcard once each, not twice', () => {
  const f = fixture({ duration: 10_000_000, endcard: true });
  applySpec(f.project, {
    version: 1,
    operations: [
      addOp(f, { at: 6, duration: 3, track: 'brollA' }),     // ends 9s: pushes 8 -> 9
      addOp(f, { at: 9, duration: 1, track: 'brollB' })      // ends 10s: pushes 9 -> 10
    ]
  }, { forceRunning: true });
  for (const file of [path.join(f.project, 'draft_info.json'), path.join(f.timelineDir, 'draft_info.json')]) {
    const endcard = readJson(file).tracks.flatMap(t => t.segments).find(s => s.id === 'ENDCARD');
    assert.equal(endcard.target_timerange.start, 10_000_000, file);
  }
  const created = readJson(path.join(f.project, '.capcutctl', 'created.json'));
  assert.deepEqual(created.preserved, { start: 10_000_000, end: 12_000_000 });
  assert.equal(doctor(f.project).errors, 0);
});

test('a clip wholly inside the endcard does not push it, however often it is nudged', () => {
  const f = fixture({ duration: 12_000_000, endcard: true });
  // Park a clip inside the endcard window by hand — adding it through clip.add would slide
  // the endcard out from under it, which is the legitimate case, not the one under test.
  for (const dir of [f.project, f.timelineDir]) {
    const d = readJson(path.join(dir, 'draft_info.json'));
    const inside = structuredClone(d.tracks[1].segments[0]);
    inside.id = 'INSIDE';
    inside.target_timerange = { start: 8_500_000, duration: 1_000_000 };
    inside.source_timerange = { start: 0, duration: 1_000_000 };
    d.tracks.push({ id: 'T2', type: 'video', flag: 2, attribute: 0, name: 'inside', segments: [inside] });
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(d));
    }
  }
  const before = readJson(path.join(f.project, '.capcutctl', 'created.json')).preserved;
  for (const by of [0.001, 0.001, 0.001]) {
    assert.throws(
      () => applySpec(f.project, { version: 1, operations: [{ op: 'clip.shift', selector: { id: 'INSIDE' }, by }] }, { forceRunning: true }),
      /INSIDE_ENDCARD|already sits inside the endcard/, `nudge ${by}`);
  }
  assert.deepEqual(readJson(path.join(f.project, '.capcutctl', 'created.json')).preserved, before);
  assert.equal(doctor(f.project).errors, 0);
});

test('no verb will touch the flag=0 main track', async () => {
  const { resolveClip } = await import('../src/add.mjs');
  const { loadProject } = await import('../src/core.mjs');
  const f = fixture();
  for (const dir of [f.project, f.timelineDir]) {
    const d = readJson(path.join(dir, 'draft_info.json'));
    const onMain = structuredClone(d.tracks[1].segments[0]);
    onMain.id = 'ON-MAIN';
    d.tracks[0].segments = [onMain];
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(d));
    }
  }
  const doc = loadProject(f.project).groups.find(g => g.name === 'root').doc;

  // resolveClip is the single gate every verb resolves through — remove / volume / trim /
  // shift / fade / keyframe all reach a segment this way. It used to filter on track TYPE
  // only, so all six could edit the cover track that is supposed to stay empty.
  assert.throws(() => resolveClip(doc, { id: 'ON-MAIN' }), /MAIN_TRACK|main\/cover track/);
  assert.throws(() => resolveClip(doc, { at: 2, track: '0' }), /MAIN_TRACK|main\/cover track/);
  assert.throws(() => resolveClip(doc, { at: 2, track: 0 }), /MAIN_TRACK|main\/cover track/);

  // and the main track is invisible to an unfiltered --at, rather than silently ambiguous
  assert.equal(resolveClip(doc, { at: 2 }).trackIndex, 1);

  for (const op of [
    { op: 'clip.shift', selector: { id: 'ON-MAIN' }, by: 1 },
    { op: 'clip.trim', selector: { id: 'ON-MAIN' }, src: [1, 3] },
    { op: 'clip.fade', selector: { id: 'ON-MAIN' }, in: 0.1 },
    { op: 'keyframe.scale', selector: { id: 'ON-MAIN' }, to: 2, hold: 1 }
  ]) {
    assert.throws(
      () => applySpec(f.project, { version: 1, operations: [op] }, { forceRunning: true }),
      /MAIN_TRACK|main\/cover track/, op.op);
  }
  const still = readJson(path.join(f.project, 'draft_info.json'));
  assert.equal(still.tracks[0].segments.length, 1);
  assert.equal(still.tracks[0].segments[0].target_timerange.start, 0);
});

test('an added clip records its speed on the speed material, so pace can read it', () => {
  const f = fixture();
  applySpec(f.project, { version: 1, operations: [addOp(f, { at: 1, duration: 2, srcDur: 8 })] }, { forceRunning: true });
  const doc = readJson(path.join(f.project, 'draft_info.json'));
  const seg = doc.tracks.find(t => t.name === 'broll').segments[0];
  assert.equal(seg.speed, 4);
  const speeds = (doc.materials.speeds || []).filter(m => seg.extra_material_refs.includes(m.id));
  for (const m of speeds) assert.equal(m.speed, 4, 'speed material still reports the template value');
});

test('--src defaults to the start of the media, not to the timeline position', () => {
  const f = fixture({ duration: 60_000_000 });
  applySpec(f.project, { version: 1, operations: [addOp(f, { at: 30, duration: 2, src: undefined })] }, { forceRunning: true });
  const seg = readJson(path.join(f.project, 'draft_info.json')).tracks.find(t => t.name === 'broll').segments[0];
  assert.equal(seg.source_timerange.start, 0);
});

test('--cover and --src-dur together are refused rather than one silently winning', () => {
  const f = fixture();
  assert.throws(
    () => applySpec(f.project, { version: 1, operations: [addOp(f, { cover: [2, 6], srcDur: 8 })] }, { forceRunning: true }),
    /BAD_SOURCE_WINDOW|not both/);
});

test('a template segment with two extras of one kind does not mint one id twice', () => {
  const f = fixture();
  for (const dir of [f.project, f.timelineDir]) {
    const d = readJson(path.join(dir, 'draft_info.json'));
    d.materials.canvases = [
      { id: 'CANVAS-A', type: 'canvas_color', color: '' },
      { id: 'CANVAS-B', type: 'canvas_color', color: '' }
    ];
    d.tracks[1].segments[0].extra_material_refs = ['CANVAS-A', 'CANVAS-B'];
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(d));
    }
  }
  applySpec(f.project, { version: 1, operations: [addOp(f)] }, { forceRunning: true });
  const doc = readJson(path.join(f.project, 'draft_info.json'));
  const ids = (doc.materials.canvases || []).map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate canvas ids: ${ids}`);
  assert.equal(doctor(f.project).errors, 0);
});

test('replace-media and trim refuse upfront instead of rolling the transaction back', () => {
  const f = fixture();
  applySpec(f.project, { version: 1, operations: [addOp(f)] }, { forceRunning: true });
  const id = readJson(path.join(f.project, 'draft_info.json')).tracks.find(t => t.name === 'broll').segments[0].id;
  const short = path.join(f.temp, 'short.mp4');
  fs.writeFileSync(short, 'short-bytes');

  // a window past the end of the new file, without --retime
  assert.throws(
    () => applySpec(f.project, { version: 1, operations: [
      { op: 'replace.media', selector: { id }, path: short, mediaDuration: 1_000_000 }] }, { forceRunning: true }),
    /SOURCE_AFTER_END|--retime/);

  // a file that is not there at all
  assert.throws(
    () => applySpec(f.project, { version: 1, operations: [
      { op: 'replace.media', selector: { id }, path: path.join(f.temp, 'gone.mp4') }] }, { forceRunning: true }),
    /MISSING_MEDIA|does not exist/);

  // a selector that matches more than one clip
  assert.throws(
    () => applySpec(f.project, { version: 1, operations: [
      { op: 'replace.media', selector: {}, path: short, mediaDuration: 1_000_000 }] }, { forceRunning: true }),
    /SELECTOR_AMBIGUOUS|matched \d+ segments/);

  // and a trim past the end of the material
  assert.throws(
    () => applySpec(f.project, { version: 1, operations: [{ op: 'clip.trim', selector: { id }, src: [0, 9000] }] }, { forceRunning: true }),
    /SOURCE_AFTER_END|exceeds/);

  assert.equal(doctor(f.project).errors, 0);
});
