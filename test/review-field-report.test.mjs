import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildReviewEdl,
  reviewContentRange,
  reviewOutputPaths,
  reviewProject,
  reviewSampleTimes,
} from '../src/review.mjs';

const us = seconds => Math.round(seconds * 1e6);
const segment = (id, start, duration, extra = {}) => ({
  id,
  material_id: extra.material_id || 'FACE',
  target_timerange: { start: us(start), duration: us(duration) },
  source_timerange: { start: us(extra.source || 0), duration: us(duration) },
  desc: extra.desc || '',
  extra_material_refs: extra.refs || [],
});

function fixture() {
  return {
    id: 'TIMELINE-REVIEW', name: 'Review fixture', duration: us(40),
    materials: {
      videos: [
        { id: 'FACE', type: 'video', path: '/takes/face.mp4' },
        { id: 'SCREEN', type: 'video', path: '/takes/screen.mp4' },
      ],
      audios: [{ id: 'CLICK', type: 'audio', name: 'Click' }],
      common_mask: [],
    },
    tracks: [
      { id: 'MAIN', type: 'video', flag: 0, segments: [] },
      { id: 'BROLL', type: 'video', name: 'screen', segments: [
        segment('b0', 0, 3, { material_id: 'SCREEN', desc: 'broll:proof', source: 12 }),
        segment('b1', 7, 5, { material_id: 'SCREEN', desc: 'broll:payoff', source: 80 }),
      ] },
      { id: 'FACE-TRACK', type: 'video', name: 'face', segments: [
        segment('f0', 0, 10),
      ] },
      { id: 'SFX', type: 'audio', name: 'polish-sfx', segments: [
        segment('a0', 1, 1, { material_id: 'CLICK', desc: 'polish:click' }),
      ] },
    ],
  };
}

test('review EDL is content-range bounded and retains anchored media identity', () => {
  const edl = buildReviewEdl(fixture());
  assert.deepEqual(edl.contentRange, { start: 0, end: 10, duration: 10 });
  assert.equal(edl.principalTrack, 2);
  assert.equal(edl.entries.some(entry => entry.timeline.end > 10), false);

  const broll = edl.entries.find(entry => entry.id === 'b1');
  assert.equal(broll.role, 'broll');
  assert.equal(broll.anchored, true);
  assert.equal(broll.material.path, '/takes/screen.mp4');
  assert.deepEqual(broll.timeline, { start: 7, end: 10, duration: 3 });
  assert.deepEqual(broll.source, { start: 80, end: 83 });

  const sfx = edl.entries.find(entry => entry.id === 'a0');
  assert.equal(sfx.type, 'audio');
  assert.equal(sfx.anchored, true);
});

test('review samples are labelled scene-boundary times inside the content range', () => {
  const edl = buildReviewEdl(fixture());
  const times = reviewSampleTimes(edl);
  assert.deepEqual(times, [0, 2.967, 7, 9.967]);
  assert.ok(times.every(time => time >= edl.contentRange.start && time < edl.contentRange.end));
  assert.deepEqual(reviewContentRange(fixture()), { start: 0, end: 10, duration: 10 });
});

test('review output ids cannot escape the output root', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-review-path-'));
  const project = path.join(temp, 'project');
  const outputRoot = path.join(temp, 'outputs');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'draft_info.json'), JSON.stringify(fixture()));
  try {
    for (const id of ['.', '..']) {
      assert.throws(
        () => reviewOutputPaths(project, { outputRoot, id }),
        error => error?.code === 'BAD_OUTPUT_ID',
      );
    }
    const safe = reviewOutputPaths(project, { outputRoot, id: '../../outside' });
    assert.equal(path.dirname(safe.dir), path.resolve(outputRoot));
    assert.ok(safe.dir.startsWith(`${path.resolve(outputRoot)}${path.sep}`));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('reviewProject writes the proxy, EDL, frames and labelled sheet for the content range', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-review-'));
  const project = path.join(temp, 'project');
  const outputRoot = path.join(temp, 'outputs');
  const runner = path.join(temp, 'runner.cjs');
  const log = path.join(temp, 'commands.ndjson');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'draft_info.json'), JSON.stringify(fixture()));
  fs.writeFileSync(runner, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const value = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };",
    "const log = process.env.CAPCUT_REVIEW_TEST_LOG;",
    "if (log) fs.appendFileSync(log, JSON.stringify(args) + '\\n');",
    "const preview = value('--preview');",
    "if (preview) fs.writeFileSync(preview, 'proxy');",
    "const sheet = value('--sheet');",
    "if (sheet && process.env.CAPCUT_REVIEW_FAIL_ON_SHEET === '1') process.exit(19);",
    "if (sheet) fs.writeFileSync(sheet, 'labelled sheet');",
    "const out = value('--out');",
    "if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(out + '/frame-000001.png', 'frame'); }",
    "if (!preview && !sheet && !out) fs.writeFileSync(args.at(-1), 'watchable proxy');",
  ].join('\n'));
  fs.chmodSync(runner, 0o755);

  const previous = process.env.CAPCUT_REVIEW_TEST_LOG;
  process.env.CAPCUT_REVIEW_TEST_LOG = log;
  try {
    const result = reviewProject(project, {
      outputRoot,
      python: runner,
      ffmpeg: runner,
    });
    assert.equal(result.contentRange.end, 10);
    assert.ok(fs.existsSync(result.proxy));
    assert.ok(fs.existsSync(result.edl));
    assert.ok(fs.existsSync(result.contactSheet));
    assert.ok(fs.existsSync(path.join(result.frames, 'frame-000001.png')));
    assert.deepEqual(JSON.parse(fs.readFileSync(result.edl, 'utf8')).contentRange,
      { start: 0, end: 10, duration: 10 });

    const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const proxyCommand = commands.find(args => args.includes('--preview'));
    assert.equal(proxyCommand[proxyCommand.indexOf('--from') + 1], '0');
    assert.equal(proxyCommand[proxyCommand.indexOf('--to') + 1], '10');
    const sheetCommand = commands.find(args => args.includes('--sheet'));
    assert.ok(sheetCommand.some(arg => arg.includes('contact-sheet.png')));
  } finally {
    if (previous == null) delete process.env.CAPCUT_REVIEW_TEST_LOG;
    else process.env.CAPCUT_REVIEW_TEST_LOG = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('review publishes staged artifacts together and removes stale frames on a shorter rerun', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-review-staging-'));
  const project = path.join(temp, 'project');
  const outputRoot = path.join(temp, 'outputs');
  const runner = path.join(temp, 'runner.cjs');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'draft_info.json'), JSON.stringify(fixture()));
  fs.writeFileSync(runner, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const value = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };",
    "const preview = value('--preview');",
    "if (preview) fs.writeFileSync(preview, 'proxy-' + (process.env.CAPCUT_REVIEW_RUN || '1'));",
    "const sheet = value('--sheet');",
    "if (sheet && process.env.CAPCUT_REVIEW_FAIL_ON_SHEET === '1') process.exit(19);",
    "if (sheet) fs.writeFileSync(sheet, 'sheet-' + (process.env.CAPCUT_REVIEW_RUN || '1'));",
    "const out = value('--out');",
    "if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(out + '/frame-000001.png', 'frame-' + (process.env.CAPCUT_REVIEW_RUN || '1')); }",
    "if (!preview && !sheet && !out) fs.writeFileSync(args.at(-1), 'proxy-' + (process.env.CAPCUT_REVIEW_RUN || '1'));",
  ].join('\n'));
  fs.chmodSync(runner, 0o755);
  const options = { outputRoot, python: runner, ffmpeg: runner, id: 'staging-check' };
  const previousFail = process.env.CAPCUT_REVIEW_FAIL_ON_SHEET;
  const previousRun = process.env.CAPCUT_REVIEW_RUN;
  try {
    process.env.CAPCUT_REVIEW_RUN = '1';
    const first = reviewProject(project, options);
    const oldEdl = fs.readFileSync(first.edl, 'utf8');
    const oldProxy = fs.readFileSync(first.proxy, 'utf8');
    fs.writeFileSync(path.join(first.frames, 'stale.png'), 'stale');

    const changed = fixture();
    changed.name = 'changed review fixture';
    fs.writeFileSync(path.join(project, 'draft_info.json'), JSON.stringify(changed));
    process.env.CAPCUT_REVIEW_FAIL_ON_SHEET = '1';
    assert.throws(() => reviewProject(project, options), error => error?.code === 'REVIEW_TOOL_FAILED');
    assert.equal(fs.readFileSync(first.edl, 'utf8'), oldEdl);
    assert.equal(fs.readFileSync(first.proxy, 'utf8'), oldProxy);
    assert.equal(fs.existsSync(path.join(first.frames, 'stale.png')), true);
    assert.deepEqual(
      fs.readdirSync(outputRoot).filter(name => name.startsWith('.capcutctl-review-stage-')),
      [],
    );

    delete process.env.CAPCUT_REVIEW_FAIL_ON_SHEET;
    process.env.CAPCUT_REVIEW_RUN = '2';
    const second = reviewProject(project, options);
    assert.equal(fs.existsSync(path.join(second.frames, 'stale.png')), false);
    assert.equal(fs.readFileSync(second.proxy, 'utf8'), 'proxy-2');
    assert.equal(fs.readFileSync(second.contactSheet, 'utf8'), 'sheet-2');
  } finally {
    if (previousFail == null) delete process.env.CAPCUT_REVIEW_FAIL_ON_SHEET;
    else process.env.CAPCUT_REVIEW_FAIL_ON_SHEET = previousFail;
    if (previousRun == null) delete process.env.CAPCUT_REVIEW_RUN;
    else process.env.CAPCUT_REVIEW_RUN = previousRun;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
