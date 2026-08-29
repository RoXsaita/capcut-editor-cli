import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJson, stableJson, PRESET_PARK_GAP_US } from '../src/core.mjs';
import { createProject, parseScenes } from '../src/create.mjs';

/**
 * A stand-in for "Preset 3": an endcard sitting late on the timeline whose backdrop
 * segment carries a Blur effect — the exact shape that silently blurred every new
 * scene when the template segment was cloned wholesale.
 */
function templateLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-new-'));
  const project = path.join(root, 'Preset 3');
  const timelineId = 'TPL-TIMELINE';
  const doc = {
    id: 'TPL-TIMELINE', name: 'Preset 3', duration: 76_000_000, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [{ id: 'TPL-VIDEO', type: 'video', path: path.join(root, 'endcard.mp4'), duration: 8_000_000, width: 1080, height: 1920 }],
      video_effects: [{ id: 'TPL-BLUR', type: 'video_effect', name: 'Blur' }],
      speeds: [{ id: 'TPL-SPEED', type: 'speed', speed: 1 }],
      canvases: [{ id: 'TPL-CANVAS', type: 'canvas_color' }],
      common_mask: []
    },
    tracks: [
      { id: 'TPL-MAIN', type: 'video', flag: 0, attribute: 0, segments: [] },
      {
        id: 'TPL-CARD', type: 'video', flag: 2, attribute: 0,
        segments: [{
          id: 'TPL-SEG', material_id: 'TPL-VIDEO',
          extra_material_refs: ['TPL-SPEED', 'TPL-CANVAS', 'TPL-BLUR'],
          enable_video_mask: false, speed: 1, volume: 1, render_index: 20, track_render_index: 1,
          source_timerange: { start: 0, duration: 8_000_000 },
          target_timerange: { start: 68_000_000, duration: 8_000_000 },
          clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }
        }]
      }
    ]
  };
  fs.writeFileSync(path.join(root, 'endcard.mp4'), 'media');
  const media = path.join(root, 'face.mp4');
  fs.writeFileSync(media, 'media');
  const write = (dir, value) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) fs.writeFileSync(path.join(dir, f), stableJson(value));
  };
  write(project, doc);
  write(path.join(project, 'Timelines', timelineId), doc);
  fs.writeFileSync(path.join(project, 'Timelines', 'project.json'), stableJson({ main_timeline_id: timelineId, timelines: [{ id: timelineId }] }));
  fs.writeFileSync(path.join(project, 'draft_meta_info.json'), stableJson({
    draft_name: 'Preset 3', draft_id: 'TPL-DRAFT',
    draft_materials: [{ type: 0, value: [{ metetype: 'video', file_Path: path.join(root, 'endcard.mp4'), width: 1080, height: 1920, duration: 8_000_000 }] }, { type: 1, value: [] }],
    draft_segment_extra_info: []
  }));
  fs.writeFileSync(path.join(project, 'draft_cover.jpg'), 'jpg');
  fs.writeFileSync(path.join(project, 'Timelines', 'TPL-TIMELINE', 'template.tmp'), '{}');
  fs.mkdirSync(path.join(project, 'matting', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(project, 'matting', 'cache', 'big'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(root, 'root_meta_info.json'), stableJson({ all_draft_store: [], draft_ids: [], root_path: root }));
  return { root, media };
}

const opts = extra => ({ forceRunning: true, width: 1440, height: 2560, duration: 300, ...extra });
const activeDoc = dir => readJson(path.join(dir, 'Timelines', readJson(path.join(dir, 'Timelines', 'project.json')).main_timeline_id, 'draft_info.json'));

test('parseScenes reads ranges and source offsets, and rejects nonsense', () => {
  assert.deepEqual(parseScenes('0:6@122.4'), [{ start: 0, duration: 6_000_000, source: 122_400_000 }]);
  assert.equal(parseScenes('0:6,6:12').length, 2);
  assert.throws(() => parseScenes('6:6'), /Bad scene/);
  assert.throws(() => parseScenes('0:10,5:12'), /overlap/);
});

test('new clones the preset and parks its leftover after a gap, not as the ending', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6,6:12,12:18' }));
  assert.equal(r.created, true);
  assert.equal(r.duration, (18_000_000 + PRESET_PARK_GAP_US + 8_000_000) / 1e6);

  const doc = activeDoc(r.project);
  const leftover = doc.tracks.flatMap(t => t.segments).find(s => s.material_id === 'TPL-VIDEO');
  assert.equal(leftover.target_timerange.start, 18_000_000 + PRESET_PARK_GAP_US,
    'preset leftover sits after a gap, not glued to the talking head');
  assert.equal(doc.tracks[r.contentTrack].segments.length, 3);
});

test('new scenes never inherit the template look (mask, blur, animations)', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6' }));
  const doc = activeDoc(r.project);
  const scene = doc.tracks[r.contentTrack].segments[0];
  const kindOf = id => Object.entries(doc.materials)
    .find(([, v]) => Array.isArray(v) && v.some(m => m.id === id))?.[0];
  const kinds = scene.extra_material_refs.map(kindOf);
  assert.ok(!kinds.includes('video_effects'), `a new scene must not inherit an effect, got ${kinds.join(',')}`);
  assert.ok(!kinds.includes('common_mask'));
  assert.equal(scene.enable_video_mask, false);
  assert.deepEqual(scene.clip.transform, { x: 0, y: 0 });
});

test('new records a sidecar so later commands can skip the cloned preset', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6' }));
  const side = readJson(path.join(r.project, '.capcutctl', 'created.json'));
  assert.equal(side.template, 'Preset 3');
  assert.equal(side.preserved.start, 6_000_000 + PRESET_PARK_GAP_US);
  assert.equal(side.contentEnd, 6_000_000);
});

test('a new project is a byte-for-byte duplicate apart from the name', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root }));               // no media: pure duplicate
  const before = readJson(path.join(root, 'Preset 3', 'draft_info.json'));
  const after = readJson(path.join(r.project, 'draft_info.json'));
  const differing = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  assert.deepEqual(differing, ['name'], 'only the name may change');
  assert.equal(after.name, 'demo');
  assert.ok(fs.existsSync(path.join(r.project, 'draft_cover.jpg')), 'the whole project is copied');
  assert.ok(fs.existsSync(path.join(r.project, 'Timelines', 'TPL-TIMELINE', 'template.tmp')));
});

test('the ~94MB matting cache is not copied', () => {
  const { root } = templateLibrary();
  const r = createProject('demo', opts({ root }));
  assert.ok(fs.existsSync(path.join(r.project, 'matting')), 'the directory must exist');
  assert.equal(fs.readdirSync(path.join(r.project, 'matting')).length, 0, 'but not its cache');
});

test('draft_info.id stays equal to the timeline id in every document', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6' }));
  const timelineId = readJson(path.join(r.project, 'Timelines', 'project.json')).main_timeline_id;
  // Verified against every openable project in the real library. Random ids here
  // produce a project that passes every structural check and still will not open.
  assert.equal(readJson(path.join(r.project, 'draft_info.json')).id, timelineId);
  assert.equal(activeDoc(r.project).id, timelineId);
});

test('every mirror of a document is written from the same edit', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6,6:12' }));
  for (const dir of [r.project, path.join(r.project, 'Timelines', 'TPL-TIMELINE')]) {
    const canonical = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
    for (const mirror of ['draft_info.json.bak', 'template-2.tmp']) {
      assert.equal(fs.readFileSync(path.join(dir, mirror), 'utf8'), canonical,
        `${mirror} drifted from draft_info.json — ids were minted per file`);
    }
  }
});

test('root and timeline receive identical generated ids', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6,6:12' }));
  const ids = doc => doc.tracks.flatMap(t => t.segments).map(s => s.id).sort();
  assert.deepEqual(ids(readJson(path.join(r.project, 'draft_info.json'))), ids(activeDoc(r.project)));
});

test('new registers the draft and refuses to overwrite an existing project', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6' }));
  const registry = readJson(path.join(root, 'root_meta_info.json'));
  assert.ok(registry.all_draft_store.some(e => e.draft_fold_path === r.project));
  assert.throws(() => createProject('demo', opts({ root, media, scenes: '0:6' })), /already exists/);
});

test('a scene that reads past the end of the media is refused', () => {
  const { root, media } = templateLibrary();
  assert.throws(
    () => createProject('demo', opts({ root, media, scenes: '0:6@299', duration: 300 })),
    /but the media is only/
  );
});

test('a missing template names the alternatives instead of guessing', () => {
  const { root, media } = templateLibrary();
  fs.renameSync(path.join(root, 'Preset 3'), path.join(root, 'Something Else'));
  assert.throws(() => createProject('demo', opts({ root, media })), /Template "Preset 3" not found/);
});

test('--blank without media actually empties the timeline', () => {
  const { root } = templateLibrary();
  const r = createProject('demo', opts({ root, blank: true }));
  const doc = activeDoc(r.project);
  assert.equal(doc.tracks.flatMap(t => t.segments || []).length, 0);
  assert.equal(r.carriedOver, 'none (--blank)');
  assert.equal(readJson(path.join(r.project, '.capcutctl', 'created.json')).preserved, null);
});

test('--blank --media keeps the new scenes and drops the template endcard', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6,6:12', blank: true }));
  const doc = activeDoc(r.project);
  assert.equal(doc.tracks[r.contentTrack].segments.length, 2);
  assert.ok(!doc.tracks.flatMap(t => t.segments).some(s => s.material_id === 'TPL-VIDEO'));
  assert.equal(r.duration, 12);
});

test('--canvas and --fps are applied, not discarded', () => {
  const { root, media } = templateLibrary();
  const r = createProject('demo', opts({ root, media, scenes: '0:6', canvas: '1920x1080', fps: 24 }));
  const doc = activeDoc(r.project);
  assert.equal(doc.canvas_config.width, 1920);
  assert.equal(doc.canvas_config.height, 1080);
  assert.equal(doc.fps, 24);
  assert.equal(r.canvas.width, 1920);
});

test('--new-timeline-id is refused rather than silently ignored', () => {
  const { root } = templateLibrary();
  assert.throws(() => createProject('demo', opts({ root, newTimelineId: true })), /not supported/);
});
