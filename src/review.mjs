import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { CapcutError, allSegments, loadProject, stableJson } from './core.mjs';
import { contentEndUs } from './add.mjs';
import { principalTrack } from './polish.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAME_QA = path.join(HERE, '..', 'tools', 'frame_qa.py');
const US = value => Math.round(Number(value) * 1e6);
const S = value => (Number(value) || 0) / 1e6;
const r3 = value => Math.round(Number(value) * 1000) / 1000;

function activeDocument(projectDir) {
  const state = loadProject(projectDir);
  return state.groups.find(group => group.name.startsWith('timeline:'))?.doc || state.groups[0]?.doc;
}

function principalIndex(doc) {
  try { return principalTrack(doc).index; }
  catch { return null; }
}

function contentStartUs(doc, principal = principalIndex(doc)) {
  if (principal == null) return 0;
  const track = doc.tracks?.[principal];
  const starts = (track?.segments || [])
    .filter(segment => segment.target_timerange && !(segment.desc || '').startsWith('layout:'))
    .map(segment => segment.target_timerange.start)
    .filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : 0;
}

/**
 * Return the actual edit range. New projects retain a parked Preset 3 parts-bin tail;
 * review artifacts must stop at the talking-head/content end rather than showing that tail.
 */
export function reviewContentRange(doc, projectDir = null) {
  const principal = principalIndex(doc);
  const startUs = contentStartUs(doc, principal);
  const endUs = Math.max(startUs, contentEndUs(doc, projectDir));
  return {
    start: r3(S(startUs)),
    end: r3(S(endUs)),
    duration: r3(Math.max(0, S(endUs - startUs))),
  };
}

function materialMaps(doc) {
  const byId = new Map();
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (value?.id) byId.set(value.id, { kind, value });
  }
  return byId;
}

function videoRole(segment, material, trackIndex, principal) {
  const desc = segment.desc || '';
  if (desc.startsWith('layout:')) return desc;
  if (trackIndex === principal) return 'talking-head';
  if (desc.startsWith('broll:') || /screen|recording|gameplay/i.test(material?.path || '')) return 'broll';
  return 'anchored-video';
}

function sourceWindow(segment, targetStart, targetEnd) {
  const target = segment.target_timerange || {};
  const source = segment.source_timerange || { start: 0, duration: target.duration || 0 };
  const targetDuration = Number(target.duration) || 0;
  const sourceDuration = Number(source.duration) || 0;
  const ratio = targetDuration > 0 ? sourceDuration / targetDuration : 1;
  const offsetStart = Math.max(0, targetStart - (target.start || 0));
  const offsetEnd = Math.max(offsetStart, targetEnd - (target.start || 0));
  return {
    start: r3(S((source.start || 0) + offsetStart * ratio)),
    end: r3(S((source.start || 0) + offsetEnd * ratio)),
  };
}

/**
 * Build the review EDL without changing the project. Entries are clamped to the content
 * range and retain source windows, track identity, and the non-principal anchor class so a
 * later recut can be audited against the same B-roll/layout/SFX/music decisions.
 */
export function buildReviewEdl(doc, { projectDir = null } = {}) {
  const range = reviewContentRange(doc, projectDir);
  if (!(range.duration > 0)) {
    throw new CapcutError('review: project has no watchable content range.', { code: 'REVIEW_EMPTY', exitCode: 2 });
  }
  const rangeStart = US(range.start);
  const rangeEnd = US(range.end);
  const principal = principalIndex(doc);
  const materials = materialMaps(doc);
  const entries = [];

  for (const { track, trackIndex, segment } of allSegments(doc)) {
    const target = segment.target_timerange;
    if (!target || !Number.isFinite(target.start) || !Number.isFinite(target.duration)) continue;
    const start = Math.max(rangeStart, target.start);
    const end = Math.min(rangeEnd, target.start + target.duration);
    if (end <= start) continue;
    const material = materials.get(segment.material_id)?.value;
    const type = track.type || 'unknown';
    const role = type === 'video' ? videoRole(segment, material, trackIndex, principal) : type;
    entries.push({
      id: segment.id || null,
      track: trackIndex,
      trackId: track.id || null,
      trackName: track.name || null,
      type,
      role,
      anchored: !(type === 'video' && trackIndex === principal),
      desc: segment.desc || null,
      material: material ? {
        id: material.id || segment.material_id || null,
        type: material.type || null,
        name: material.material_name || material.name || null,
        path: material.path || null,
      } : { id: segment.material_id || null },
      timeline: { start: r3(S(start)), end: r3(S(end)), duration: r3(S(end - start)) },
      source: sourceWindow(segment, start, end),
    });
  }

  entries.sort((a, b) => a.timeline.start - b.timeline.start || a.track - b.track || String(a.id).localeCompare(String(b.id)));
  return {
    version: 1,
    type: 'capcutctl-review-edl',
    project: doc.name || null,
    projectId: doc.id || null,
    contentRange: range,
    principalTrack: principal,
    entries,
  };
}

/** Choose labelled frame times at visual boundaries, including the first and last content frame. */
export function reviewSampleTimes(edl, { lastFrame = 1 / 30 } = {}) {
  const range = edl.contentRange;
  const values = [range.start];
  for (const entry of edl.entries || []) {
    if (entry.type !== 'video') continue;
    values.push(entry.timeline.start);
    values.push(Math.min(range.end - lastFrame, entry.timeline.end - lastFrame));
  }
  values.push(Math.max(range.start, range.end - lastFrame));
  return [...new Set(values
    .filter(value => Number.isFinite(value) && value >= range.start && value < range.end + 1e-6)
    .map(r3))].sort((a, b) => a - b);
}

function safeComponent(value) {
  const raw = String(value || 'project');
  if (raw === '.' || raw === '..') {
    throw new CapcutError('review --id cannot be "." or "..".', { code: 'BAD_OUTPUT_ID', exitCode: 2 });
  }
  const component = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  if (component === '.' || component === '..') {
    throw new CapcutError('review --id must resolve to a named output directory.', { code: 'BAD_OUTPUT_ID', exitCode: 2 });
  }
  return component;
}

export function reviewOutputPaths(projectDir, { outputRoot = path.resolve('outputs'), id = null } = {}) {
  const doc = activeDocument(projectDir);
  const outputId = safeComponent(id || doc?.id || path.basename(path.resolve(projectDir)));
  const root = path.resolve(outputRoot);
  const dir = path.resolve(root, outputId);
  const relative = path.relative(root, dir);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || path.dirname(dir) !== root) {
    throw new CapcutError('review output must be a direct child of --output-root.', {
      code: 'BAD_OUTPUT_ID', exitCode: 2, details: { outputRoot: root, id: outputId },
    });
  }
  return {
    id: outputId,
    dir,
    proxy: path.join(dir, 'proxy.mp4'),
    edl: path.join(dir, 'edl.json'),
    contactSheet: path.join(dir, 'contact-sheet.png'),
    frames: path.join(dir, 'frames'),
  };
}

function pathsAtDirectory(dir, id) {
  return {
    id,
    dir,
    proxy: path.join(dir, 'proxy.mp4'),
    edl: path.join(dir, 'edl.json'),
    contactSheet: path.join(dir, 'contact-sheet.png'),
    frames: path.join(dir, 'frames'),
  };
}

function runTool(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new CapcutError(
      `${label} failed${result.status == null ? '' : ` (exit ${result.status})`}: ${result.error?.message || result.stderr?.trim() || 'unknown error'}`,
      { code: 'REVIEW_TOOL_FAILED', exitCode: 2,
        details: { command, args, status: result.status, signal: result.signal, error: result.error?.message || null } }
    );
  }
  return result;
}

function assertReviewArtifacts(outputs) {
  const files = [
    ['proxy', outputs.proxy],
    ['EDL', outputs.edl],
    ['contact sheet', outputs.contactSheet],
  ];
  for (const [label, file] of files) {
    if (!fs.existsSync(file)) {
      throw new CapcutError(`review ${label} was not produced: ${file}`, {
        code: 'REVIEW_ARTIFACT_MISSING', exitCode: 2, details: { file, label },
      });
    }
  }
  if (!fs.existsSync(outputs.frames) || !fs.readdirSync(outputs.frames).length) {
    throw new CapcutError(`review frames were not produced: ${outputs.frames}`, {
      code: 'REVIEW_ARTIFACT_MISSING', exitCode: 2,
      details: { file: outputs.frames, label: 'frames' },
    });
  }
}

function publishReviewDirectory(stagedDir, destination) {
  const parent = path.dirname(destination);
  const backup = path.join(parent, `.capcutctl-review-backup-${process.pid}-${Date.now()}-${randomUUID()}`);
  let movedPrevious = false;
  try {
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      movedPrevious = true;
    }
    fs.renameSync(stagedDir, destination);
  } catch (error) {
    if (movedPrevious && !fs.existsSync(destination) && fs.existsSync(backup)) {
      try { fs.renameSync(backup, destination); } catch (restoreError) {
        error.restoreError = restoreError.message;
      }
    }
    throw new CapcutError(`review output publish failed: ${error.message}`, {
      code: 'REVIEW_PUBLISH_FAILED', exitCode: 2,
      details: { destination, backup: movedPrevious ? backup : null, restoreError: error.restoreError || null },
    });
  }
  if (movedPrevious) {
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* new output is already published */ }
  }
}

/**
 * Write the content-range proxy, EDL, and labelled contact sheet. This deliberately calls
 * the external compositor and ffmpeg; it never opens CapCut or drives its export UI.
 */
export function reviewProject(projectDir, {
  outputRoot = path.resolve('outputs'),
  id = null,
  python = 'python3',
  ffmpeg = 'ffmpeg',
  fps = 6,
  width = 240,
} = {}) {
  if (!Number.isFinite(Number(fps)) || Number(fps) <= 0) {
    throw new CapcutError('review requires --fps greater than zero.', { code: 'BAD_FPS', exitCode: 2 });
  }
  if (!Number.isFinite(Number(width)) || Number(width) <= 0) {
    throw new CapcutError('review requires --width greater than zero.', { code: 'BAD_WIDTH', exitCode: 2 });
  }
  const doc = activeDocument(projectDir);
  if (!doc) throw new CapcutError(`review: no active timeline in ${projectDir}.`, { code: 'PROJECT_EMPTY', exitCode: 2 });
  const edl = buildReviewEdl(doc, { projectDir });
  const times = reviewSampleTimes(edl);
  const outputs = reviewOutputPaths(projectDir, { outputRoot, id });
  fs.mkdirSync(path.dirname(outputs.dir), { recursive: true });
  const stagedDir = fs.mkdtempSync(path.join(path.dirname(outputs.dir), `.capcutctl-review-stage-${outputs.id}-`));
  const staged = pathsAtDirectory(stagedDir, outputs.id);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-review-'));
  let published = false;
  try {
    fs.mkdirSync(staged.frames, { recursive: true });
    fs.writeFileSync(staged.edl, stableJson(edl));
    const fullProxy = path.join(tmp, 'full-proxy.mp4');
    runTool(python, [FRAME_QA, '--project', projectDir, '--preview', fullProxy,
      '--from', String(edl.contentRange.start), '--to', String(edl.contentRange.end),
      '--fps', String(fps)], 'review proxy compositor');

    const trimArgs = ['-y', '-loglevel', 'error'];
    // frame_qa already renders the explicit content range above. Re-encode that proxy for a
    // broadly watchable output, but do not apply the timeline offset a second time.
    trimArgs.push('-i', fullProxy,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', staged.proxy);
    runTool(ffmpeg, trimArgs, 'review content-range trim');

    runTool(python, [FRAME_QA, '--project', projectDir, '--times', times.join(','),
      '--out', staged.frames, '--sheet', staged.contactSheet, '--width', String(width)],
    'review contact sheet');
    assertReviewArtifacts(staged);
    publishReviewDirectory(staged.dir, outputs.dir);
    published = true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!published) fs.rmSync(staged.dir, { recursive: true, force: true });
  }

  return {
    id: outputs.id,
    project: projectDir,
    contentRange: edl.contentRange,
    sampleTimes: times,
    proxy: outputs.proxy,
    edl: outputs.edl,
    contactSheet: outputs.contactSheet,
    frames: outputs.frames,
  };
}

export const writeReview = reviewProject;
