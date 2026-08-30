import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySpec, readJson, stableJson } from '../src/core.mjs';
import {
  brollFocus,
  buildLayoutSpec,
  describeScenes,
  findCircleScenes,
  isScreenRecordingSegment,
  opLayoutBroll,
  opLayoutScreen,
  presets
} from '../src/layouts.mjs';

/** A two-document project with one plain full-frame subject segment. */
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-layout-'));
  const project = path.join(temp, 'Layout Project');
  const timelineId = 'TIMELINE-ONE';
  const media = path.join(temp, 'face.mp4');
  fs.writeFileSync(media, 'media');
  // the layout assets must resolve; drop them where resolveAsset looks first
  const assets = path.join(project, 'Resources');
  fs.mkdirSync(assets, { recursive: true });
  for (const name of ['suheilai-rect-indigo-1080x1920 (2).png', 'suheilai-circle-white-1080x1920.png']) {
    fs.writeFileSync(path.join(assets, name), 'png');
  }
  // Preset mask/effect paths point at the current user's CapCut cache. Tests must
  // validate the material wiring without those machine-local downloads present.
  let resourceIndex = 0;
  const localizeMissingResources = value => {
    if (Array.isArray(value)) return value.forEach(localizeMissingResources);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'path' && typeof child === 'string' && child && !fs.existsSync(child)) {
        const fixturePath = path.join(assets, `preset-resource-${resourceIndex++}`);
        fs.writeFileSync(fixturePath, 'fixture');
        value[key] = fixturePath;
      } else {
        localizeMissingResources(child);
      }
    }
  };
  localizeMissingResources(presets());
  const doc = {
    id: timelineId, name: 'Layout Project', duration: 10_000_000, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [{ id: 'VIDEO', type: 'video', path: media, duration: 10_000_000, width: 1440, height: 2560 }],
      common_mask: [], video_effects: [], speeds: []
    },
    tracks: [
      { id: 'T0', type: 'video', flag: 0, attribute: 0, segments: [] },
      {
        id: 'T1', type: 'video', flag: 2, attribute: 0,
        segments: [{
          id: 'SUBJECT', material_id: 'VIDEO', extra_material_refs: [],
          enable_video_mask: false, speed: 1, volume: 1, render_index: 2, track_render_index: 1,
          desc: 'usage-10pct',
          source_timerange: { start: 2_000_000, duration: 5_000_000 },
          target_timerange: { start: 0, duration: 5_000_000 },
          clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
        }]
      }
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
  return { temp, project, timelineDir: path.join(project, 'Timelines', timelineId) };
}

const activeDoc = f => readJson(path.join(f.timelineDir, 'draft_info.json'));
const rootDoc = f => readJson(path.join(f.project, 'draft_info.json'));
const subjectOf = doc => doc.tracks.flatMap(t => t.segments).find(s => s.id === 'SUBJECT');
const writeDoc = (dir, doc) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
    fs.writeFileSync(path.join(dir, file), stableJson(doc));
  }
};

function addScreenRecording(f) {
  const screen = path.join(f.temp, 'Windows Take', 'screen.mp4');
  fs.mkdirSync(path.dirname(screen), { recursive: true });
  fs.writeFileSync(screen, 'screen-bytes');
  const recording = {
    id: 'RECORDING', material_id: 'SCREEN', extra_material_refs: [],
    enable_video_mask: false, speed: 1, volume: 0, render_index: 3, track_render_index: 2,
    desc: 'raw window capture',
    source_timerange: { start: 0, duration: 5_000_000 },
    target_timerange: { start: 0, duration: 5_000_000 },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
  };
  const mutate = dir => {
    const doc = readJson(path.join(dir, 'draft_info.json'));
    doc.materials.videos.push({
      id: 'SCREEN', type: 'video', path: screen, duration: 20_000_000,
      width: 720, height: 1050
    });
    doc.tracks.push({ id: 'T2', type: 'video', flag: 2, attribute: 0, name: 'screen-source', segments: [structuredClone(recording)] });
    writeDoc(dir, doc);
  };
  mutate(f.project);
  mutate(f.timelineDir);
  return { screen, recording };
}

function addLandscapeBroll(doc) {
  const file = path.join(os.tmpdir(), `capcutctl-landscape-${process.pid}.mp4`);
  fs.writeFileSync(file, 'landscape');
  doc.materials.videos.push({ id: 'LANDSCAPE', type: 'video', path: file, duration: 10_000_000, width: 1920, height: 1080 });
  doc.tracks[1].segments.push({
    id: 'LANDSCAPE-SEGMENT', material_id: 'LANDSCAPE', extra_material_refs: [],
    enable_video_mask: false, speed: 1, volume: 0, render_index: 4, track_render_index: 1,
    desc: 'landscape window', source_timerange: { start: 0, duration: 5_000_000 },
    target_timerange: { start: 5_000_000, duration: 5_000_000 },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
  });
  return file;
}

test('split-screen writes the exact measured geometry and a seam bar', () => {
  const f = fixture();
  const spec = buildLayoutSpec(f.project, 'split-screen', { segments: ['SUBJECT'] });
  applySpec(f.project, spec, { forceRunning: true });

  const want = presets().layouts['split-screen'];
  for (const doc of [activeDoc(f), rootDoc(f)]) {
    const subject = subjectOf(doc);
    assert.deepEqual(subject.clip.scale, want.subject.clip.scale);
    assert.equal(subject.clip.transform.y, -0.5208333333333334);
    assert.equal(subject.enable_video_mask, true);
    const mask = doc.materials.common_mask.find(m => subject.extra_material_refs.includes(m.id));
    assert.equal(mask.resource_type, 'line');
    assert.equal(mask.config.centerY, 0.5415114961139896);
    assert.equal(mask.config.rotation, 180);

    const bar = doc.tracks.flatMap(t => t.segments).find(s => s.desc === 'layout:seam-bar');
    assert.ok(bar, 'seam bar segment exists');
    assert.deepEqual(bar.target_timerange, subject.target_timerange);
    assert.equal(bar.clip.scale.x, 1.8272246516061672);
    assert.equal(bar.clip.transform.y, -0.6036269430051813);
  }
});

test('generated ids are identical in root and active timeline', () => {
  const f = fixture();
  applySpec(f.project, buildLayoutSpec(f.project, 'circle', { segments: ['SUBJECT'] }), { forceRunning: true });
  const ids = doc => doc.tracks.flatMap(t => t.segments).map(s => s.id).sort()
    .concat(doc.materials.common_mask.map(m => m.id).sort());
  assert.deepEqual(ids(rootDoc(f)), ids(activeDoc(f)),
    'root and timeline must mint the same ids or the documents drift apart');
});

test('circle attaches the ring and is idempotent when re-run', () => {
  const f = fixture();
  const spec = buildLayoutSpec(f.project, 'circle', { segments: ['SUBJECT'] });
  applySpec(f.project, spec, { forceRunning: true });
  const first = activeDoc(f);
  const rings = d => d.tracks.flatMap(t => t.segments).filter(s => s.desc === 'layout:white-ring');
  assert.equal(rings(first).length, 1);
  assert.equal(subjectOf(first).clip.transform.x, -0.5559524128804151);

  applySpec(f.project, buildLayoutSpec(f.project, 'circle', { segments: ['SUBJECT'] }), { forceRunning: true });
  assert.equal(rings(activeDoc(f)).length, 1, 're-running must replace the ring, not duplicate it');
});

test('switching split-screen to circle removes the seam bar', () => {
  const f = fixture();
  applySpec(f.project, buildLayoutSpec(f.project, 'split-screen', { segments: ['SUBJECT'] }), { forceRunning: true });
  applySpec(f.project, buildLayoutSpec(f.project, 'circle', { segments: ['SUBJECT'] }), { forceRunning: true });
  const segs = activeDoc(f).tracks.flatMap(t => t.segments || []);
  assert.equal(segs.filter(s => s.desc === 'layout:seam-bar').length, 0);
  assert.equal(segs.filter(s => s.desc === 'layout:white-ring').length, 1);
});

test('layout auto is a no-op (not an error) when every clip already matches', () => {
  const f = fixture();
  const spec = buildLayoutSpec(f.project, 'auto', {});
  assert.equal(spec.operations.length, 0);
});

test('background finds circle scenes and lands the blur plate below the subject', () => {
  const f = fixture();
  applySpec(f.project, buildLayoutSpec(f.project, 'circle', { segments: ['SUBJECT'] }), { forceRunning: true });
  assert.equal(findCircleScenes(activeDoc(f)).length, 1);

  applySpec(f.project, buildLayoutSpec(f.project, 'background', {}), { forceRunning: true });
  const doc = activeDoc(f);
  const bgIndex = doc.tracks.findIndex(t => t.segments?.some(s => s.desc === 'layout:background-blur'));
  const subjIndex = doc.tracks.findIndex(t => t.segments?.some(s => s.id === 'SUBJECT'));
  assert.ok(bgIndex >= 0 && bgIndex < subjIndex, `blur track ${bgIndex} must render behind subject track ${subjIndex}`);

  const plate = doc.tracks[bgIndex].segments[0];
  assert.equal(plate.clip.alpha, 0.72);
  assert.equal(plate.clip.scale.x, 1.12);
  assert.equal(plate.material_id, 'VIDEO', 'blur plate reuses the subject media, it does not invent one');
  assert.ok(doc.materials.video_effects.some(e => plate.extra_material_refs.includes(e.id) && e.name === 'Blur'));
  // track_render_index must keep mirroring track position after the insert
  doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => assert.equal(s.track_render_index, i)));
});

test('background is a no-op when no circle scene has a ring', () => {
  const f = fixture();
  const result = applySpec(f.project, buildLayoutSpec(f.project, 'background', {}), { forceRunning: true });
  const op = result.result[0].operations[0];
  assert.equal(op.changed, 0);
  assert.match(op.note, /no circle scenes/);
});

test('scenes always lists desc, media basename and source window', () => {
  const f = fixture();
  const row = describeScenes(f.project).find(r => r.id === 'SUBJECT');
  assert.equal(row.desc, 'usage-10pct');
  assert.equal(row.media, 'face.mp4');
  assert.deepEqual(row.source, [2, 7]);
});

test('scenes reports style and ignores disabled masks', () => {
  const f = fixture();
  applySpec(f.project, buildLayoutSpec(f.project, 'split-screen', { segments: ['SUBJECT'] }), { forceRunning: true });
  assert.equal(describeScenes(f.project).find(r => r.id === 'SUBJECT').style, 'split-screen');

  applySpec(f.project, { version: 1, name: 'off', operations: [{ op: 'segment.patch', selector: { id: 'SUBJECT' }, set: { enable_video_mask: false } }] }, { forceRunning: true });
  assert.equal(describeScenes(f.project).find(r => r.id === 'SUBJECT').style, 'plain',
    'a disabled mask is a leftover, not a style');
});

test('an unknown layout name fails loudly', () => {
  const f = fixture();
  assert.throws(() => buildLayoutSpec(f.project, 'diagonal', { segments: ['SUBJECT'] }), /Unknown layout/);
});

test('screenRecording geometry is locked for rl2 720x1050', () => {
  const g = presets().screenRecording;
  assert.equal(g.source.width, 720);
  assert.equal(g.source.height, 1050);
  assert.equal(g.recording.clip.scale.x, 0.8);
  assert.equal(g.recording.clip.scale.y, 0.8);
  assert.equal(g.frame.clip.scale.x, 1.05);
  assert.equal(g.frame.clip.scale.y, 0.7835820895522388);
  assert.equal(g.frame.uniform_scale.on, false);
  assert.equal(g.pixelGeometry.screen.width, 864);
  assert.equal(g.pixelGeometry.screen.height, 1260);
});

test('circle pip is the lifted rl2 pair, not the old 0.644/0.633', () => {
  const c = presets().layouts.circle;
  assert.equal(c.subject.clip.transform.y, 0.6692708333333334);
  assert.equal(c.overlay.clip.transform.y, 0.6640625);
});

test('scenes resolves a localized media path through its durable original-source map', () => {
  const f = fixture();
  const original = path.join(f.temp, 'Original Take', 'screen.mp4');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, 'original-screen-bytes');
  const cache = path.join(path.dirname(original), '.video-index');
  fs.mkdirSync(cache, { recursive: true });
  const transcript = path.join(cache, 'screen.whisper-test.json');
  fs.writeFileSync(transcript, JSON.stringify({ segments: [
    { start: 2, end: 4, text: 'read the original source' }
  ] }));

  const localized = path.join(f.project, 'Resources', 'CapcutctlMedia', 'Original-Take__screen.mp4');
  fs.mkdirSync(path.dirname(localized), { recursive: true });
  fs.writeFileSync(localized, 'original-screen-bytes');
  const doc = activeDoc(f);
  const material = doc.materials.videos.find(m => m.id === 'VIDEO');
  material.path = localized;
  fs.mkdirSync(path.join(f.project, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.capcutctl', 'media-map.json'), stableJson({ [localized]: original }));
  writeDoc(f.timelineDir, doc);

  const row = describeScenes(f.project, null, true).find(r => r.id === 'SUBJECT');
  assert.equal(row.says, 'read the original source');
  assert.equal(row.transcriptStatus, 'resolved');
  assert.equal(row.transcriptSource, original);
  assert.equal(row.transcriptPath, transcript);
});

test('scenes finds a transcript cache next to the source without relying on Downloads', () => {
  const f = fixture();
  const original = path.join(f.temp, 'Elsewhere', 'talking-head.mp4');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, 'talking-head');
  const cache = path.join(path.dirname(original), '.video-index');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'talking-head.whisper-local.json'), JSON.stringify({ segments: [
    { start: 1, end: 4, text: 'cache beside source' }
  ] }));

  const doc = activeDoc(f);
  const material = doc.materials.videos.find(m => m.id === 'VIDEO');
  material.path = path.join(f.project, 'Resources', 'CapcutctlMedia', 'Elsewhere__talking-head.mp4');
  material.originalPath = original;
  writeDoc(f.timelineDir, doc);

  const row = describeScenes(f.project, null, true).find(r => r.id === 'SUBJECT');
  assert.equal(row.says, 'cache beside source');
  assert.equal(row.transcriptStatus, 'resolved');
});

test('scenes reports missing and invalid transcript resolution instead of a silent empty says value', () => {
  const missing = fixture();
  const missingRow = describeScenes(missing.project, null, true).find(r => r.id === 'SUBJECT');
  assert.equal(missingRow.says, null);
  assert.equal(missingRow.transcriptStatus, 'missing');
  assert.match(missingRow.transcriptNote, /No transcript cache found/);
  assert.equal(missingRow.note, missingRow.transcriptNote);

  const invalid = fixture();
  const source = path.join(invalid.temp, 'invalid-source.mp4');
  fs.writeFileSync(source, 'invalid-source');
  const cache = path.join(path.dirname(source), '.video-index');
  fs.mkdirSync(cache, { recursive: true });
  const cacheFile = path.join(cache, 'invalid-source.whisper-bad.json');
  fs.writeFileSync(cacheFile, '{not json');
  const doc = activeDoc(invalid);
  doc.materials.videos.find(m => m.id === 'VIDEO').original_path = source;
  writeDoc(invalid.timelineDir, doc);

  const invalidRow = describeScenes(invalid.project, null, true).find(r => r.id === 'SUBJECT');
  assert.equal(invalidRow.says, null);
  assert.equal(invalidRow.transcriptStatus, 'invalid');
  assert.match(invalidRow.transcriptNote, /could not be read/);
  assert.equal(invalidRow.transcriptPath, cacheFile);
});

test('scenes reports an explicitly empty transcript cache', () => {
  const f = fixture();
  const source = path.join(f.temp, 'empty-source.mp4');
  fs.writeFileSync(source, 'empty-source');
  const cache = path.join(path.dirname(source), '.video-index');
  fs.mkdirSync(cache, { recursive: true });
  const cacheFile = path.join(cache, 'empty-source.whisper-empty.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ segments: [] }));
  const doc = activeDoc(f);
  doc.materials.videos.find(m => m.id === 'VIDEO').original_source = source;
  writeDoc(f.timelineDir, doc);

  const row = describeScenes(f.project, null, true).find(r => r.id === 'SUBJECT');
  assert.equal(row.says, null);
  assert.equal(row.transcriptStatus, 'empty');
  assert.match(row.transcriptNote, /contains no usable segments/);
});

test('layout broll refuses an unframed landscape/window capture and names layout screen', () => {
  const f = fixture();
  const doc = activeDoc(f);
  addLandscapeBroll(doc);
  assert.throws(
    () => opLayoutBroll(doc, { selector: { id: 'LANDSCAPE-SEGMENT' }, row: 540 }),
    error => error.code === 'BROLL_NEEDS_SCREEN_LAYOUT' && /layout screen/.test(error.message)
  );
});

test('layout broll accepts an explicit crop scale for a landscape capture', () => {
  const f = fixture();
  const doc = activeDoc(f);
  addLandscapeBroll(doc);
  const result = opLayoutBroll(doc, {
    selector: { id: 'LANDSCAPE-SEGMENT' }, row: 540, scale: 2, __seed: 'BROLL-SEED'
  });
  const segment = doc.tracks.flatMap(track => track.segments).find(s => s.id === 'LANDSCAPE-SEGMENT');
  assert.equal(result.changed, 1);
  assert.equal(segment.clip.scale.x, 2);
  assert.equal(segment.enable_video_mask, true);
});

test('layout broll keeps the measured portrait window path available without explicit framing', () => {
  const focus = brollFocus({ sourceWidth: 720, sourceHeight: 1050, row: 525 });
  assert.equal(focus.scale, 1);
  assert.equal(focus.clamped, false);
});

test('layout screen applies recording, indigo frame, circle pip, ring and blur as deterministic layers', () => {
  const f = fixture();
  addScreenRecording(f);
  const operation = {
    op: 'layout.screen', __seed: 'SCREEN-SEED', selector: { id: 'RECORDING' },
    pipSelector: { id: 'SUBJECT' }
  };
  const root = rootDoc(f);
  const active = activeDoc(f);
  const rootResult = opLayoutScreen(root, operation, { projectDir: f.project });
  const activeResult = opLayoutScreen(active, operation, { projectDir: f.project });
  assert.deepEqual(activeResult, rootResult, 'the same seed and source structure must produce the same result');
  assert.equal(activeResult.changed, 1);
  assert.equal(activeResult.operation, 'layout.screen');

  const screen = presets().screenRecording;
  const circle = presets().layouts.circle;
  const background = presets().background;
  const recording = active.tracks.flatMap(track => track.segments).find(s => s.id === 'RECORDING');
  assert.deepEqual(recording.clip, screen.recording.clip);
  assert.deepEqual(recording.uniform_scale, screen.recording.uniform_scale);
  assert.equal(recording.desc, 'layout:screen-recording');

  const segmentWith = desc => active.tracks.flatMap(track => track.segments).find(s => s.desc === desc);
  const frame = segmentWith('layout:screen-frame');
  const pip = segmentWith('layout:screen-pip');
  const ring = segmentWith('layout:screen-pip-ring');
  const blur = segmentWith('layout:screen-blur');
  assert.ok(frame && pip && ring && blur, 'all screen layers must be present');
  assert.deepEqual(frame.clip, screen.frame.clip);
  assert.deepEqual(frame.uniform_scale, screen.frame.uniform_scale);
  assert.deepEqual(frame.target_timerange, recording.target_timerange);
  assert.deepEqual(pip.clip, circle.subject.clip);
  assert.equal(pip.volume, 0);
  assert.deepEqual(ring.clip, circle.overlay.clip);
  assert.deepEqual(blur.clip, background.clip);
  assert.equal(blur.material_id, 'SCREEN');
  const pipMask = active.materials.common_mask.find(m => pip.extra_material_refs.includes(m.id));
  const ringMask = active.materials.common_mask.find(m => ring.extra_material_refs.includes(m.id));
  assert.equal(pipMask.resource_type, 'circle');
  assert.equal(ringMask.resource_type, 'circle');
  const effect = active.materials.video_effects.find(e => blur.extra_material_refs.includes(e.id));
  assert.equal(effect.name, 'Blur');
  assert.equal(effect.bind_segment_id, blur.id);

  const tracks = activeResult.layers[0].tracks;
  assert.ok(tracks.background < tracks.recording);
  assert.ok(tracks.recording < tracks.frame);
  assert.ok(tracks.frame < tracks.pip);
  assert.ok(tracks.pip < tracks.ring);

  const ids = doc => doc.tracks.flatMap(track => track.segments).map(s => s.id).sort()
    .concat(doc.materials.common_mask.map(m => m.id).sort())
    .concat(doc.materials.video_effects.map(m => m.id).sort());
  assert.deepEqual(ids(root), ids(active), 'root and active documents must receive identical layer ids');
});

test('layout screen is idempotent and buildLayoutSpec exposes the wiring operation', () => {
  const f = fixture();
  addScreenRecording(f);
  const spec = buildLayoutSpec(f.project, 'screen', {
    segments: ['RECORDING'], pipSegmentId: 'SUBJECT'
  });
  assert.equal(spec.name, 'layout-screen');
  assert.equal(spec.operations.length, 1);
  assert.equal(spec.operations[0].op, 'layout.screen');
  assert.deepEqual(spec.operations[0].pipSelector, { id: 'SUBJECT' });

  const doc = activeDoc(f);
  const operation = { ...spec.operations[0], __seed: 'SCREEN-IDEMPOTENT' };
  opLayoutScreen(doc, operation, { projectDir: f.project });
  const first = stableJson(doc);
  opLayoutScreen(doc, operation, { projectDir: f.project });
  assert.equal(stableJson(doc), first, 're-running with the same seed must not add or reorder layers');
  assert.equal(doc.tracks.flatMap(track => track.segments).filter(s => s.desc === 'layout:screen-frame').length, 1);
  assert.equal(doc.tracks.flatMap(track => track.segments).filter(s => s.desc === 'layout:screen-pip').length, 1);
  assert.equal(doc.tracks.flatMap(track => track.segments).filter(s => s.desc === 'layout:screen-pip-ring').length, 1);
  assert.equal(doc.tracks.flatMap(track => track.segments).filter(s => s.desc === 'layout:screen-blur').length, 1);
  assert.equal(doc.materials.common_mask.length, 2);
  assert.equal(doc.materials.video_effects.length, 1);
});

test('layout screen accepts the media/at/duration contract emitted by the CLI', () => {
  const f = fixture();
  const media = path.join(f.temp, 'rl2-take', 'screen.mp4');
  fs.mkdirSync(path.dirname(media), { recursive: true });
  fs.writeFileSync(media, 'screen-contract');
  const operation = {
    op: 'layout.screen', contract: 'layout.screen.v1', __seed: 'SCREEN-CONTRACT',
    media, at: 2.5, duration: 4, src: 1, srcDur: 4,
    width: 720, height: 1050, mediaDuration: 10_000_000,
    track: 'screen', preset: 'screenRecording', frame: 'screen-frame', localize: true
  };
  const root = rootDoc(f);
  const active = activeDoc(f);
  const rootResult = opLayoutScreen(root, operation, { projectDir: f.project });
  const activeResult = opLayoutScreen(active, operation, { projectDir: f.project });
  assert.deepEqual(activeResult, rootResult);

  const recording = active.tracks.flatMap(track => track.segments)
    .find(segment => segment.desc === 'layout:screen-recording');
  assert.ok(recording);
  assert.deepEqual(recording.target_timerange, { start: 2_500_000, duration: 4_000_000 });
  assert.deepEqual(recording.source_timerange, { start: 1_000_000, duration: 4_000_000 });
  assert.deepEqual(recording.clip, presets().screenRecording.recording.clip);
  assert.equal(active.tracks.find(track => track.segments.includes(recording)).name, 'screen');
  const material = active.materials.videos.find(item => item.id === recording.material_id);
  assert.ok(material.path.endsWith('/Resources/CapcutctlMedia/rl2-take__screen.mp4'));
  assert.equal(material.original_path, media);
  assert.equal(material.width, 720);
  assert.equal(material.height, 1050);
  assert.equal(material.duration, 10_000_000);
  assert.ok(active.tracks.flatMap(track => track.segments).some(s => s.desc === 'layout:screen-frame'));
  assert.ok(active.tracks.flatMap(track => track.segments).some(s => s.desc === 'layout:screen-pip'));
  assert.ok(active.tracks.flatMap(track => track.segments).some(s => s.desc === 'layout:screen-pip-ring'));
  assert.ok(active.tracks.flatMap(track => track.segments).some(s => s.desc === 'layout:screen-blur'));
});

test('layout screen requires a pip source when no principal clip overlaps the recording', () => {
  const f = fixture();
  addScreenRecording(f);
  const doc = activeDoc(f);
  const subject = subjectOf(doc);
  subject.target_timerange = { start: 8_000_000, duration: 1_000_000 };
  assert.throws(
    () => opLayoutScreen(doc, { selector: { id: 'RECORDING' }, __seed: 'NO-PIP' }, { projectDir: f.project }),
    error => error.code === 'PIP_SELECTOR_REQUIRED' && /pipSelector/.test(error.message)
  );
});

test('layout.screen rejects the main track and arbitrary video selectors', () => {
  const f = fixture();
  addScreenRecording(f);
  const doc = activeDoc(f);
  assert.equal(isScreenRecordingSegment(doc, subjectOf(doc)), false);
  assert.throws(
    () => opLayoutScreen(doc, { selector: { id: 'SUBJECT' }, pipSelector: { id: 'SUBJECT' } }),
    error => error.code === 'NOT_SCREEN_RECORDING'
  );

  const recording = doc.tracks.find(track => track.name === 'screen-source').segments[0];
  doc.tracks.find(track => track.name === 'screen-source').segments = [];
  doc.tracks[0].segments = [recording];
  assert.throws(
    () => opLayoutScreen(doc, { selector: { id: 'RECORDING' }, pipSelector: { id: 'SUBJECT' } }),
    error => error.code === 'MAIN_TRACK'
  );
});

test('layout.screen repairs a misplaced generated lane and refuses an unsafe lane', () => {
  const repaired = fixture();
  addScreenRecording(repaired);
  const doc = activeDoc(repaired);
  doc.tracks.push({ id: 'MISPLACED', type: 'video', flag: 2, name: 'layout-screen-frame', segments: [] });
  opLayoutScreen(doc, { selector: { id: 'RECORDING' }, pipSelector: { id: 'SUBJECT' }, __seed: 'REPAIR' });
  const recordingIndex = doc.tracks.findIndex(track => track.segments.some(segment => segment.id === 'RECORDING'));
  const frameIndex = doc.tracks.findIndex(track => track.name === 'layout-screen-frame');
  assert.equal(frameIndex, recordingIndex + 1, 'frame lane is restored directly above the recording');
  assert.equal(doc.tracks[frameIndex].flag, 2);

  const unsafe = fixture();
  addScreenRecording(unsafe);
  const unsafeDoc = activeDoc(unsafe);
  unsafeDoc.tracks.push({ id: 'UNSAFE', type: 'video', flag: 1, name: 'layout-screen-frame', segments: [] });
  assert.throws(
    () => opLayoutScreen(unsafeDoc, { selector: { id: 'RECORDING' }, pipSelector: { id: 'SUBJECT' }, __seed: 'REFUSE' }),
    error => error.code === 'UNSAFE_SCREEN_LANE'
  );
});

test('layout.screen --all scopes same-range cleanup and generated lanes by recording identity', () => {
  const f = fixture();
  addScreenRecording(f);
  const doc = activeDoc(f);
  const firstTrack = doc.tracks.find(track => track.name === 'screen-source');
  const first = firstTrack.segments[0];
  first.desc = 'layout:screen-recording';
  const secondMaterial = { ...doc.materials.videos.find(material => material.id === 'SCREEN'), id: 'SCREEN-B' };
  doc.materials.videos.push(secondMaterial);
  const second = structuredClone(first);
  second.id = 'RECORDING-B';
  second.material_id = 'SCREEN-B';
  second.screen_recording_id = undefined;
  doc.tracks.push({ id: 'SCREEN-B-TRACK', type: 'video', flag: 2, name: 'screen-source-b', segments: [second] });

  const operation = {
    selector: { desc: 'layout:screen-recording' }, all: true,
    pipSelector: { id: 'SUBJECT' }, __seed: 'SAME-RANGE'
  };
  const result = opLayoutScreen(doc, operation);
  assert.equal(result.changed, 2);
  const layers = doc.tracks.flatMap(track => track.segments)
    .filter(segment => ['layout:screen-frame', 'layout:screen-pip', 'layout:screen-pip-ring', 'layout:screen-blur'].includes(segment.desc));
  assert.equal(layers.filter(segment => segment.screen_recording_id === 'RECORDING').length, 4);
  assert.equal(layers.filter(segment => segment.screen_recording_id === 'RECORDING-B').length, 4);
  assert.ok(doc.tracks.some(track => track.name === 'layout-screen-frame--RECORDING-B'));
  assert.equal(new Set(layers.map(segment => segment.id)).size, 8);

  opLayoutScreen(doc, { selector: { id: 'RECORDING-B' }, pipSelector: { id: 'SUBJECT' }, __seed: 'SAME-RANGE' });
  const after = doc.tracks.flatMap(track => track.segments)
    .filter(segment => ['layout:screen-frame', 'layout:screen-pip', 'layout:screen-pip-ring', 'layout:screen-blur'].includes(segment.desc));
  assert.equal(after.filter(segment => segment.screen_recording_id === 'RECORDING').length, 4);
  assert.equal(after.filter(segment => segment.screen_recording_id === 'RECORDING-B').length, 4);
});

test('layout.screen runs transactionally across root and timeline mirrors and retries cleanly', () => {
  const f = fixture();
  addScreenRecording(f);
  const spec = buildLayoutSpec(f.project, 'screen', {
    segments: ['RECORDING'], pipSegmentId: 'SUBJECT'
  });
  const first = applySpec(f.project, spec, { forceRunning: true });
  assert.equal(first.committed, true);

  const logicalIds = doc => ({
    tracks: doc.tracks.map(track => [track.id, track.name, track.segments.map(segment => segment.id)]),
    masks: (doc.materials.common_mask || []).map(item => item.id),
    effects: (doc.materials.video_effects || []).map(item => item.id)
  });
  const root = rootDoc(f);
  const active = activeDoc(f);
  assert.deepEqual(logicalIds(root), logicalIds(active));
  for (const dir of [f.project, f.timelineDir]) {
    const hashes = ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']
      .map(name => fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.equal(new Set(hashes).size, 1);
  }
  const rootBefore = stableJson(root);
  const activeBefore = stableJson(active);
  const second = applySpec(f.project, spec, { forceRunning: true });
  assert.equal(second.committed, false);
  assert.equal(stableJson(rootDoc(f)), rootBefore);
  assert.equal(stableJson(activeDoc(f)), activeBefore);
});
