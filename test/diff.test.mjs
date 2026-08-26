import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySpec, createSnapshot, listSnapshots, stableJson } from '../src/core.mjs';
import { diffSummaries, summarizeDoc, summarizeProject } from '../src/diff.mjs';

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-diff-'));
  const project = path.join(temp, 'Diff Project');
  const timelineId = 'TIMELINE-ONE';
  const media = path.join(temp, 'face.mp4');
  fs.writeFileSync(media, 'face');
  const doc = {
    id: timelineId, name: 'Diff Project', duration: 5_000_000, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: { videos: [{ id: 'VIDEO', type: 'video', path: media, duration: 60_000_000, width: 1440, height: 2560 }] },
    tracks: [
      { id: 'T0', type: 'video', flag: 0, attribute: 0, segments: [] },
      { id: 'T1', type: 'video', flag: 2, attribute: 0, name: 'content', segments: [{
        id: 'SUBJECT', material_id: 'VIDEO', extra_material_refs: [],
        source_timerange: { start: 0, duration: 5_000_000 },
        target_timerange: { start: 0, duration: 5_000_000 },
        clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } }, volume: 1, speed: 1
      }] }
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
  return { temp, project, media };
}

test('diff against a snapshot reports the added overlay', () => {
  const f = fixture();
  const snap = createSnapshot(f.project, 'before-add');
  const broll = path.join(f.temp, 'screen.mp4');
  fs.writeFileSync(broll, 'screen');
  applySpec(f.project, { version: 1, operations: [{
    op: 'clip.add', media: broll, at: 1, duration: 2, src: 0, track: 'broll',
    volume: 0, width: 1080, height: 1920, mediaDuration: 20_000_000
  }] }, { forceRunning: true });
  const d = diffSummaries(summarizeProject(snap), summarizeProject(f.project));
  assert.equal(d.segments.added.length, 1);
  assert.equal(d.segments.added[0].trackName, 'broll');
  assert.equal(d.segments.added[0].path, broll);
  assert.ok(d.tracks.added.some(t => t.name === 'broll'));
  assert.equal(d.fingerprint.same, false);
  const listed = listSnapshots(f.project);
  assert.ok(listed.some(s => s.path === snap));
});

const bare = tracks => ({ duration: 0, fps: 30, canvas_config: { width: 1080, height: 1920 },
  materials: { videos: [{ id: 'V1', type: 'video', path: '/a.mp4', width: 1080, height: 1920, duration: 60_000_000 }] },
  tracks });

test('duplicate material ids: a document does not differ from an identical copy of itself', () => {
  // CapCut re-saves a material under an id it already used, differing only in material_name.
  // Keying materials by id alone compared the first copy against the LAST one and called it
  // a change, on a diff that was byte-identical.
  const doc = bare([{ id: 'T1', type: 'video', flag: 2, name: 'content', segments: [] }]);
  doc.materials.videos.push({ ...doc.materials.videos[0], material_name: 'a.mp4' });
  const d = diffSummaries(summarizeDoc(doc), summarizeDoc(structuredClone(doc)));
  assert.equal(d.fingerprint.same, true);
  assert.deepEqual(d.materials, { added: [], removed: [], changed: [] });
});

test('id-less tracks: a document does not differ from itself', () => {
  // Two tracks with no id used to collapse into one Map entry and diff against each other.
  const doc = bare([
    { type: 'video', flag: 0, segments: [] },
    { type: 'video', flag: 0, segments: [] }
  ]);
  const d = diffSummaries(summarizeDoc(doc), summarizeDoc(structuredClone(doc)));
  assert.deepEqual(d.tracks, { added: [], removed: [], changed: [], moved: [] });
});

test('prepending a track reports the insertion and a move, not the whole project as changed', () => {
  const seg = {
    id: 'S1', material_id: 'V1', extra_material_refs: [],
    source_timerange: { start: 0, duration: 5_000_000 },
    target_timerange: { start: 0, duration: 5_000_000 },
    clip: { scale: { x: 1, y: 1 } }, volume: 1, speed: 1
  };
  const before = bare([{ id: 'T1', type: 'video', flag: 2, name: 'content', segments: [seg] }]);
  const after = structuredClone(before);
  after.tracks.unshift({ id: 'T0', type: 'video', flag: 0, segments: [] });
  const d = diffSummaries(summarizeDoc(before), summarizeDoc(after));
  assert.deepEqual(d.tracks.added.map(t => t.id), ['T0']);
  assert.deepEqual(d.tracks.changed, []);
  assert.deepEqual(d.segments.changed, []);
  assert.deepEqual(d.segments.added, []);
  assert.deepEqual(d.tracks.moved, [{ id: 'T1', from: 0, to: 1 }]);
  assert.deepEqual(d.segments.moved, [{ id: 'S1', from: 0, to: 1 }]);
});
