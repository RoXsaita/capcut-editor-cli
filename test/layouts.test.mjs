import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySpec, readJson, stableJson } from '../src/core.mjs';
import { buildLayoutSpec, describeScenes, findCircleScenes, presets } from '../src/layouts.mjs';

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
  // Preset mask/effect paths point at the current user's CapCut cache. Tests must validate the
  // material wiring without depending on those machine-local downloads being present.
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
