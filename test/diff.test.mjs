import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySpec, createSnapshot, listSnapshots, stableJson } from '../src/core.mjs';
import { diffSummaries, materialUsers, parseAllow, scopeCheck, summarizeDoc, summarizeProject } from '../src/diff.mjs';
import { main, setOutput } from '../src/cli.mjs';

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

function twoClips() {
  const seg = (id, start) => ({
    id, material_id: 'V1', extra_material_refs: [],
    source_timerange: { start: 0, duration: 2_000_000 },
    target_timerange: { start, duration: 2_000_000 },
    clip: { scale: { x: 1, y: 1 } }, volume: 1, speed: 1
  });
  return bare([
    { id: 'T1', type: 'video', flag: 2, name: 'content', segments: [seg('FACE', 0)] },
    { id: 'T2', type: 'video', flag: 0, name: 'broll', segments: [seg('SHOT', 1_000_000)] }
  ]);
}

const scoped = (before, after, allow) => {
  const a = summarizeDoc(before), b = summarizeDoc(after);
  return scopeCheck(diffSummaries(a, b), parseAllow(allow), materialUsers(a, b));
};

test('diff --allow: a change to the allowed segment is in scope', () => {
  const before = twoClips();
  const after = structuredClone(before);
  after.tracks[1].segments[0].volume = 0;
  const scope = scoped(before, after, 'SHOT');
  assert.equal(scope.ok, true);
  assert.deepEqual(scope.touched, ['SHOT']);
  assert.deepEqual(scope.outOfScope, []);
});

test('diff --allow: a change outside the allowed ids is named with both values', () => {
  const before = twoClips();
  const after = structuredClone(before);
  after.tracks[1].segments[0].volume = 0;
  after.tracks[0].segments[0].target_timerange.start = 500_000;
  const scope = scoped(before, after, ['SHOT']);
  assert.equal(scope.ok, false);
  assert.equal(scope.outOfScope.length, 1);
  const [finding] = scope.outOfScope;
  assert.equal(finding.id, 'FACE');
  assert.equal(finding.change, 'changed');
  assert.deepEqual(finding.fields.start, { from: 0, to: 0.5 });
});

test('diff --allow track:NAME admits segments the edit added on that track', () => {
  const before = twoClips();
  const after = structuredClone(before);
  after.tracks[1].segments.push({ ...structuredClone(after.tracks[1].segments[0]), id: 'NEW',
    target_timerange: { start: 4_000_000, duration: 1_000_000 } });
  assert.equal(scoped(before, after, 'track:broll').ok, true);
  assert.equal(scoped(before, after, 'track:1').ok, true);
  const wrong = scoped(before, after, 'track:content');
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.outOfScope.map(f => [f.kind, f.change, f.id]), [['segment', 'added', 'NEW']]);
});

test('diff --allow: prepending an empty track shifts indices without leaving scope', () => {
  const before = twoClips();
  const after = structuredClone(before);
  after.tracks.unshift({ id: 'T0', type: 'video', flag: 0, segments: [] });
  after.tracks[2].segments[0].volume = 0.5;
  // The broll track is index 1 before and 2 after; either selector names it.
  assert.equal(scoped(before, after, 'track:broll').ok, true);
  assert.equal(scoped(before, after, 'SHOT').ok, true);
});

test('diff --allow: a material swapped under an out-of-scope clip is out of scope', () => {
  const before = twoClips();
  const after = structuredClone(before);
  after.materials.videos.push({ id: 'V2', type: 'video', path: '/b.mp4', width: 1080, height: 1920, duration: 60_000_000 });
  after.tracks[0].segments[0].material_id = 'V2';
  const scope = scoped(before, after, 'SHOT');
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.outOfScope.map(f => `${f.kind}:${f.change}:${f.id}`).sort(),
    ['material:added:V2', 'segment:changed:FACE']);
});

test('parseAllow refuses an empty selector list', () => {
  assert.throws(() => parseAllow(''), /at least one/);
  assert.throws(() => parseAllow('track:'), /empty track selector/);
  assert.deepEqual([...parseAllow(['A,B', 'track:broll']).segments], ['A', 'B']);
});

test('capcutctl diff --allow exits 1 and reports the out-of-scope change', async t => {
  const f = fixture();
  const snap = createSnapshot(f.project, 'before-scoped');
  const broll = path.join(f.temp, 'screen.mp4');
  fs.writeFileSync(broll, 'screen');
  applySpec(f.project, { version: 1, operations: [{
    op: 'clip.add', media: broll, at: 1, duration: 2, src: 0, track: 'broll',
    volume: 0, width: 1080, height: 1920, mediaDuration: 20_000_000
  }] }, { forceRunning: true });
  let stdout = '';
  const restore = setOutput(chunk => { stdout += String(chunk); return true; });
  t.after(restore);
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });

  await main(['diff', '--project', f.project, '--snapshot', path.basename(snap), '--allow', 'track:broll']);
  assert.equal(JSON.parse(stdout).scope.ok, true);
  assert.notEqual(process.exitCode, 1);

  stdout = '';
  await main(['diff', '--project', f.project, '--snapshot', path.basename(snap), '--allow', 'SUBJECT']);
  const report = JSON.parse(stdout);
  assert.equal(report.scope.ok, false);
  assert.ok(report.scope.outOfScope.some(item => item.kind === 'segment' && item.change === 'added'));
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;
});
