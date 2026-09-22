import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureProject, diffCaptures, canonicalize, classifyRecord, indexRecords, walkTree,
  SUCCESS_VERDICTS, VERDICTS,
} from '../src/oracle.mjs';

/* Two synthetic directories stand in for "what we wrote" and "what came back out of CapCut".
   No CapCut UI runs here, by design: the harness compares directories a human captured. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-oracle-'));

const write = (dir, relative, value) => {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};

/** A draft carrying one volume-keyframe block on a music segment — the Q02 shape. */
const draft = ({ keyframes = true, volume = 0.08 } = {}) => ({
  canvas_config: { width: 1080, height: 1920 },
  materials: { videos: [{ id: 'mat-1', type: 'video', path: '/durable/take.mp4' }] },
  tracks: [{
    type: 'audio',
    segments: [{
      id: 'seg-music',
      material_id: 'mat-1',
      volume,
      target_timerange: { start: 0, duration: 10_000_000 },
      common_keyframes: keyframes ? [{
        id: 'kf-block-volume',
        property_type: 'KFTypeVolume',
        keyframe_list: [
          { id: 'kf-1', time_offset: 0, values: [0.08], curveType: 'Line' },
          { id: 'kf-2', time_offset: 2_000_000, values: [0.02], curveType: 'Line' },
        ],
      }] : [],
    }],
  }],
});

const findingFor = (report, id) => report.findings.find(f => f.id === id);

test('a deleted keyframe type is pruned, and the report refuses to call it success', () => {
  const before = tmp(), after = tmp();
  write(before, 'draft_info.json', draft());
  write(after, 'draft_info.json', draft({ keyframes: false }));

  const report = diffCaptures({ before, after });
  assert.equal(findingFor(report, 'kf-block-volume').verdict, 'pruned');
  assert.equal(findingFor(report, 'kf-1').verdict, 'pruned');
  assert.equal(findingFor(report, 'kf-2').verdict, 'pruned');
  assert.equal(report.ok, false);
  assert.equal(report.verdict, 'NOT production-safe');
  assert.equal(report.counts.pruned, 3);
});

test('a reformatted, uuid-preserving rewrite is normalized, not a change', () => {
  const before = tmp(), after = tmp();
  write(before, 'draft_info.json', draft());
  // Same records, same ids, same values — different key order and float spelling. This is
  // CapCut rewriting the file, which is exactly what `normalized` is for.
  const reordered = JSON.parse(JSON.stringify(draft()));
  const block = reordered.tracks[0].segments[0].common_keyframes[0];
  block.keyframe_list = block.keyframe_list.map(k => ({
    curveType: k.curveType, values: [Number(k.values[0].toFixed(9))], id: k.id, time_offset: k.time_offset,
  }));
  write(after, 'draft_info.json', JSON.stringify(reordered));   // no pretty-printing either

  const report = diffCaptures({ before, after });
  assert.equal(findingFor(report, 'kf-1').verdict, 'normalized');
  assert.equal(findingFor(report, 'kf-block-volume').verdict, 'normalized');
  assert.ok(report.ok, 'a normalized rewrite is a passing round trip');
  assert.equal(report.counts.pruned, 0);
  assert.equal(report.counts.reset, 0);
});

test('an unchanged record is preserved and is not reported at all', () => {
  const before = tmp(), after = tmp();
  write(before, 'draft_info.json', draft());
  write(after, 'draft_info.json', draft());
  const report = diffCaptures({ before, after });
  assert.deepEqual(report.findings, []);
  assert.ok(report.ok);
});

test('a kept record whose values did not survive is reset; a baseline says it was put back', () => {
  const baseline = tmp(), before = tmp(), after = tmp();
  write(baseline, 'draft_info.json', draft({ keyframes: false, volume: 0.08 }));
  write(before, 'draft_info.json', draft({ keyframes: false, volume: 0.02 }));   // what we wrote
  write(after, 'draft_info.json', draft({ keyframes: false, volume: 0.08 }));    // what came back

  const plain = diffCaptures({ before, after });
  assert.equal(findingFor(plain, 'seg-music').verdict, 'reset');
  assert.equal(findingFor(plain, 'seg-music').restoredToBaseline, undefined);
  assert.equal(plain.ok, false);

  const withBaseline = diffCaptures({ before, after, baseline });
  assert.equal(findingFor(withBaseline, 'seg-music').restoredToBaseline, true,
    'the value is the one that was there before we wrote');
});

test('a record kept in one document and dropped from another is an authority-miss', () => {
  const before = tmp(), after = tmp();
  for (const dir of [before, after]) write(dir, 'draft_info.json', draft());
  write(before, 'Timelines/tl-1/draft_info.json', draft());
  write(after, 'Timelines/tl-1/draft_info.json', draft({ keyframes: false }));

  const report = diffCaptures({ before, after });
  const nested = report.findings.find(f => f.id === 'kf-block-volume' && f.file === 'Timelines/tl-1/draft_info.json');
  assert.equal(nested.verdict, 'authority-miss',
    'the root kept it and the nested timeline did not — the two documents disagree');
  assert.match(nested.detail, /kept in draft_info\.json/);
  assert.equal(report.ok, false);
});

test('files the app materialises are cache, not failure; a removed file is pruned', () => {
  const before = tmp(), after = tmp();
  write(before, 'draft_info.json', draft());
  write(after, 'draft_info.json', draft());
  write(after, 'materials/analysis/audio-peaks.dat', 'binary-ish');
  write(before, 'template-2.tmp', draft());

  const report = diffCaptures({ before, after });
  const cache = report.findings.find(f => f.file === 'materials/analysis/audio-peaks.dat');
  assert.equal(cache.verdict, 'materialized-cache');
  assert.ok(SUCCESS_VERDICTS.has('materialized-cache'));
  const gone = report.findings.find(f => f.file === 'template-2.tmp' && f.verdict === 'pruned');
  assert.ok(gone, 'a whole document disappearing is a prune');
  assert.equal(report.ok, false);
});

test('resource-noop is a qa verdict handed in, never inferred from JSON', () => {
  const before = tmp(), after = tmp();
  write(before, 'draft_info.json', draft());
  write(after, 'draft_info.json', draft());

  const clean = diffCaptures({ before, after });
  assert.ok(clean.ok, 'identical JSON says nothing about pixels on its own');

  const asserted = diffCaptures({ before, after, resourceNoop: ['kf-block-volume'] });
  assert.equal(findingFor(asserted, 'kf-block-volume').verdict, 'resource-noop');
  assert.equal(asserted.ok, false, 'structure survived but pixels did not — not success');
});

test('capture copies the whole tree and skips our own bookkeeping', () => {
  const project = tmp();
  write(project, 'draft_info.json', draft());
  write(project, 'draft_meta_info.json', { id: 'meta-1' });
  write(project, 'Timelines/tl-1/draft_info.json', draft());
  write(project, 'template-2.tmp', draft());
  write(project, '.capcutctl/history/old/manifest.json', { version: 1 });

  const result = captureProject(project, { label: 'before-open' });
  const captured = walkTree(path.join(result.capture, 'tree'));
  assert.deepEqual(captured.sort(), [
    'Timelines/tl-1/draft_info.json', 'draft_info.json', 'draft_meta_info.json', 'template-2.tmp',
  ]);
  assert.equal(result.files, 4);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.capture, 'oracle.json'), 'utf8'));
  assert.ok(manifest.files.every(f => typeof f.sha256 === 'string' && f.sha256.length === 64));

  // A capture directory reads back as a tree, so `oracle diff` takes either shape.
  const report = diffCaptures({ before: result.capture, after: project });
  assert.deepEqual(report.findings, []);

  assert.throws(() => captureProject(project, { label: 'before-open' }), { code: 'ORACLE_CAPTURE_EXISTS' });
});

test('--values carries the record JSON, which is the whole point of a harvest', () => {
  const before = tmp(), after = tmp();
  write(before, 'draft_info.json', draft({ keyframes: false }));
  write(after, 'draft_info.json', draft());

  const bare = findingFor(diffCaptures({ before, after }), 'kf-block-volume');
  assert.equal(bare.verdict, 'materialized-cache');
  assert.equal(bare.after, undefined, 'the default report is verdicts, not payloads');

  const full = findingFor(diffCaptures({ before, after, values: true }), 'kf-block-volume');
  assert.equal(full.before, null, 'the block did not exist before');
  assert.equal(full.after.property_type, 'KFTypeVolume');
  assert.equal(full.after.keyframe_list.length, 2);
  assert.deepEqual(full.after.keyframe_list[1].values, [0.02],
    'a harvest reads units off the record, so the values have to be in the report');
});

test('canonicalize separates reserialisation from a real change', () => {
  assert.equal(JSON.stringify(canonicalize({ b: 1, a: 2 })), JSON.stringify(canonicalize({ a: 2, b: 1 })));
  assert.equal(canonicalize(0.1 + 0.2), canonicalize(0.3), 'float noise is not a change');
  assert.notEqual(canonicalize(0.08), canonicalize(0.02), 'a real gain change survives rounding');
});

test('indexRecords finds every id-bearing record, keyframe points included', () => {
  const ids = [...indexRecords(draft()).keys()].sort();
  assert.deepEqual(ids, ['kf-1', 'kf-2', 'kf-block-volume', 'mat-1', 'seg-music']);
  assert.equal(indexRecords(draft()).get('kf-block-volume').kind, 'KFTypeVolume');
});

test('the taxonomy names exactly the report vocabulary, and only three are success', () => {
  assert.deepEqual(Object.keys(VERDICTS).sort(), [
    'authority-miss', 'materialized-cache', 'normalized', 'preserved', 'pruned', 'reset', 'resource-noop',
  ]);
  assert.deepEqual([...SUCCESS_VERDICTS].sort(), ['materialized-cache', 'normalized', 'preserved']);
  for (const verdict of ['pruned', 'reset', 'resource-noop', 'authority-miss']) {
    assert.equal(SUCCESS_VERDICTS.has(verdict), false, `${verdict} must never read as success`);
  }
});

test('classifyRecord is pure and covers each transition', () => {
  const record = value => ({ path: '$', value, kind: null });
  assert.equal(classifyRecord({ before: record({ id: 'x', v: 1 }), after: null }).verdict, 'pruned');
  assert.equal(classifyRecord({ before: null, after: record({ id: 'x' }) }).verdict, 'materialized-cache');
  assert.equal(classifyRecord({ before: record({ id: 'x', v: 1 }), after: record({ id: 'x', v: 1 }) }).verdict, 'preserved');
  assert.equal(classifyRecord({
    before: record({ id: 'x', v: 1 }), after: record({ id: 'x', v: 1 }),
    beforeText: '{"v":1}', afterText: '{ "v": 1 }',
  }).verdict, 'normalized');
  assert.equal(classifyRecord({ before: record({ id: 'x', v: 1 }), after: record({ id: 'x', v: 2 }) }).verdict, 'reset');
});
