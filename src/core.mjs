import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { opLayoutApply, opLayoutBackground, opLayoutBroll } from './layouts.mjs';
import { opPolish, principalTrack } from './polish.mjs';
import { opPace } from './pace.mjs';
import { opSignature } from './signature.mjs';

export const DEFAULT_ROOT = path.join(
  process.env.HOME || '',
  'Movies/CapCut/User Data/Projects/com.lveditor.draft'
);

export const LIVE_FILE_NAMES = ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp'];

export class CapcutError extends Error {
  constructor(message, { code = 'CAPCUTCTL_ERROR', exitCode = 1, details } = {}) {
    super(message);
    this.name = 'CapcutError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const clone = value => JSON.parse(JSON.stringify(value));
export const uuid = () => crypto.randomUUID().toUpperCase();
export const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CapcutError(`Invalid JSON: ${file}\n${error.message}`, {
      code: 'INVALID_JSON',
      details: { file }
    });
  }
}

export function capcutProcess() {
  if (process.env.CAPCUTCTL_ASSUME_RUNNING === '1') return { running: true, pids: ['test'] };
  const result = spawnSync('pgrep', ['-x', 'CapCut'], { encoding: 'utf8' });
  const pids = result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean) : [];
  return { running: pids.length > 0, pids };
}

export function assertCapcutClosed({ forceRunning = false } = {}) {
  const state = capcutProcess();
  if (state.running && !forceRunning) {
    throw new CapcutError(
      `CapCut is running (PID ${state.pids.join(', ')}). Close it before writing, or pass --force-running if you accept auto-save races.`,
      { code: 'CAPCUT_RUNNING', exitCode: 3, details: state }
    );
  }
  return state;
}

export function listProjects(root = DEFAULT_ROOT) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const projectDir = path.join(root, dirent.name);
    const infoPath = path.join(projectDir, 'draft_info.json');
    if (!fs.existsSync(infoPath)) continue;
    let info = null;
    let error = null;
    try { info = readJson(infoPath); } catch (caught) { error = caught.message; }
    entries.push({
      name: dirent.name,
      path: projectDir,
      duration: info?.duration ?? null,
      fps: info?.fps ?? null,
      tracks: info?.tracks?.length ?? null,
      error
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveProject(input, root = DEFAULT_ROOT) {
  if (!input) throw new CapcutError('Missing --project <name-or-path>.', { code: 'MISSING_PROJECT', exitCode: 2 });
  const direct = path.resolve(input);
  const projectDir = fs.existsSync(path.join(direct, 'draft_info.json')) ? direct : path.join(root, input);
  if (!fs.existsSync(path.join(projectDir, 'draft_info.json'))) {
    throw new CapcutError(`CapCut project not found: ${input}`, { code: 'PROJECT_NOT_FOUND', exitCode: 2 });
  }
  return projectDir;
}

export function activeTimelineId(projectDir) {
  const projectJson = path.join(projectDir, 'Timelines/project.json');
  if (!fs.existsSync(projectJson)) return null;
  return readJson(projectJson).main_timeline_id || null;
}

export function documentGroups(projectDir) {
  const groups = [{
    name: 'root',
    dir: projectDir,
    canonical: path.join(projectDir, 'draft_info.json'),
    mirrors: LIVE_FILE_NAMES.map(name => path.join(projectDir, name))
  }];
  const timelineId = activeTimelineId(projectDir);
  if (timelineId) {
    const timelineDir = path.join(projectDir, 'Timelines', timelineId);
    const canonical = path.join(timelineDir, 'draft_info.json');
    if (fs.existsSync(canonical)) {
      groups.push({
        name: `timeline:${timelineId}`,
        dir: timelineDir,
        canonical,
        mirrors: LIVE_FILE_NAMES.map(name => path.join(timelineDir, name))
      });
    }
  }
  return groups;
}

export function loadProject(projectDir) {
  const groups = documentGroups(projectDir).map(group => ({ ...group, doc: readJson(group.canonical) }));
  return { projectDir, groups, activeTimelineId: activeTimelineId(projectDir) };
}

export function materialIndex(doc) {
  const index = new Map();
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (value?.id) index.set(value.id, { kind, value });
  }
  return index;
}

export function allSegments(doc) {
  return (doc.tracks || []).flatMap((track, trackIndex) =>
    (track.segments || []).map((segment, segmentIndex) => ({ track, trackIndex, segment, segmentIndex }))
  );
}

function issue(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

export function validateDocument(doc, { file = '<memory>', checkFiles = true } = {}) {
  const issues = [];
  if (!doc || typeof doc !== 'object') return [issue('error', 'DOC_TYPE', 'Draft must be an object.', { file })];
  if (!Array.isArray(doc.tracks)) issues.push(issue('error', 'TRACKS_TYPE', 'tracks must be an array.', { file }));
  if (!doc.materials || typeof doc.materials !== 'object') issues.push(issue('error', 'MATERIALS_TYPE', 'materials must be an object.', { file }));
  const materials = materialIndex(doc);
  const seenSegmentIds = new Set();
  const seenMaterialIds = new Map();
  const seenTrackIds = new Set();
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!value?.id) continue;
      if (seenMaterialIds.has(value.id)) {
        const previous = seenMaterialIds.get(value.id);
        if (JSON.stringify(previous.value) !== JSON.stringify(value)) {
          issues.push(issue('error', 'CONFLICTING_MATERIAL_ID', `Material id ${value.id} is reused with conflicting data.`, { file, id: value.id, kind, previousKind: previous.kind }));
        } else if (!previous.reported) {
          issues.push(issue('warning', 'DUPLICATE_MATERIAL_ID', `CapCut repeats identical material id ${value.id}; it is treated as one logical material.`, { file, id: value.id, kind }));
          previous.reported = true;
        }
      } else seenMaterialIds.set(value.id, { kind, value, reported: false });
      const mediaPath = value.path;
      if (checkFiles && typeof mediaPath === 'string' && mediaPath.startsWith('/') && !fs.existsSync(mediaPath)) {
        issues.push(issue('error', 'MISSING_MEDIA', `Missing media file: ${mediaPath}`, { file, id: value.id, path: mediaPath }));
      }
    }
  }

  for (const entry of allSegments(doc)) {
    const { segment, trackIndex } = entry;
    if (!segment.id) issues.push(issue('error', 'SEGMENT_ID', `Segment without id on track ${trackIndex}.`, { file, trackIndex }));
    else if (seenSegmentIds.has(segment.id)) issues.push(issue('error', 'DUPLICATE_SEGMENT_ID', `Duplicate segment id ${segment.id}.`, { file, id: segment.id }));
    else seenSegmentIds.add(segment.id);
    if (segment.material_id && !materials.has(segment.material_id)) {
      issues.push(issue('error', 'MISSING_MATERIAL_REF', `Segment ${segment.id} references missing material ${segment.material_id}.`, { file, id: segment.id }));
    }
    for (const ref of segment.extra_material_refs || []) {
      if (!materials.has(ref)) issues.push(issue('error', 'MISSING_EXTRA_REF', `Segment ${segment.id} references missing extra material ${ref}.`, { file, id: segment.id, ref }));
    }
    for (const key of ['target_timerange', 'source_timerange']) {
      const range = segment[key];
      if (range == null && key === 'source_timerange') continue;
      if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.duration)) {
        issues.push(issue('error', 'BAD_TIMERANGE', `${segment.id}.${key} is invalid.`, { file, id: segment.id, key }));
      } else if (range.start < 0 || range.duration < 0) {
        issues.push(issue('error', 'NEGATIVE_TIMERANGE', `${segment.id}.${key} is negative.`, { file, id: segment.id, key }));
      }
    }
    const target = segment.target_timerange;
    if (target && Number.isFinite(doc.duration) && target.start + target.duration > doc.duration + 1) {
      issues.push(issue('error', 'SEGMENT_AFTER_END', `Segment ${segment.id} extends beyond draft duration.`, { file, id: segment.id }));
    }
    const source = segment.source_timerange;
    const material = materials.get(segment.material_id)?.value;
    if (source && Number.isFinite(material?.duration) && source.start + source.duration > material.duration + 1) {
      issues.push(issue('error', 'SOURCE_AFTER_END', `Segment ${segment.id} exceeds source material duration.`, { file, id: segment.id, materialId: segment.material_id }));
    }
    const numericLeaves = [];
    walk(segment.clip, (value, keyPath) => { if (typeof value === 'number') numericLeaves.push([keyPath, value]); });
    for (const [keyPath, value] of numericLeaves) if (!Number.isFinite(value)) {
      issues.push(issue('error', 'NONFINITE_CLIP', `${segment.id}.${keyPath} is non-finite.`, { file, id: segment.id }));
    }
  }
  for (const [trackIndex, track] of (doc.tracks || []).entries()) {
    if (track.id) {
      if (seenTrackIds.has(track.id)) issues.push(issue('error', 'DUPLICATE_TRACK_ID', `Duplicate track id ${track.id}.`, { file, id: track.id, trackIndex }));
      seenTrackIds.add(track.id);
    }
    const ordered = [...(track.segments || [])].filter(segment => segment.target_timerange).sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 1; i < ordered.length; i++) {
      const previousEnd = ordered[i - 1].target_timerange.start + ordered[i - 1].target_timerange.duration;
      if (ordered[i].target_timerange.start < previousEnd) {
        issues.push(issue('warning', 'TRACK_OVERLAP', `Track ${trackIndex} has overlapping segments ${ordered[i - 1].id} and ${ordered[i].id}.`, { file, trackIndex }));
      }
    }
  }
  return issues;
}

export function documentFingerprint(doc) {
  return sha256(JSON.stringify({
    duration: doc.duration,
    fps: doc.fps,
    canvas: doc.canvas_config,
    tracks: (doc.tracks || []).map(track => ({
      type: track.type,
      segments: (track.segments || []).map(segment => ({
        id: segment.id,
        material_id: segment.material_id,
        target_timerange: segment.target_timerange,
        source_timerange: segment.source_timerange,
        clip: segment.clip,
        volume: segment.volume,
        speed: segment.speed,
        enable_video_mask: segment.enable_video_mask
      }))
    }))
  }));
}

export function doctor(projectDir, { checkFiles = true } = {}) {
  const state = loadProject(projectDir);
  const issues = [];
  for (const group of state.groups) {
    issues.push(...validateDocument(group.doc, { file: group.canonical, checkFiles }));
    const canonicalHash = sha256(fs.readFileSync(group.canonical));
    for (const mirror of group.mirrors) {
      if (!fs.existsSync(mirror)) {
        issues.push(issue('warning', 'MISSING_MIRROR', `Missing live mirror ${mirror}.`, { file: mirror, group: group.name }));
        continue;
      }
      let mirrorHash;
      try { mirrorHash = sha256(fs.readFileSync(mirror)); readJson(mirror); }
      catch (error) { issues.push(issue('error', 'INVALID_MIRROR', error.message, { file: mirror, group: group.name })); continue; }
      if (mirrorHash !== canonicalHash) issues.push(issue('warning', 'MIRROR_DRIFT', `Mirror differs from canonical: ${mirror}`, { file: mirror, group: group.name }));
    }
  }
  if (state.groups.length > 1) {
    const fingerprints = state.groups.map(group => ({ name: group.name, value: documentFingerprint(group.doc) }));
    if (new Set(fingerprints.map(item => item.value)).size > 1) {
      issues.push(issue('warning', 'DOCUMENT_DRIFT', 'Root draft and active timeline differ structurally. Semantic edits will be applied to both documents independently.', { fingerprints }));
    }
  }
  // CapCut resolves a draft's timeline by draft_info.json's top-level `id`. When it
  // does not match the active timeline, every structural check still passes and the
  // project simply will not open.
  if (state.activeTimelineId) {
    for (const group of state.groups) {
      if (group.doc?.id && group.doc.id !== state.activeTimelineId) {
        issues.push(issue('error', 'TIMELINE_ID_MISMATCH',
          `${group.name}: draft_info.json id "${group.doc.id}" does not match the active timeline "${state.activeTimelineId}". CapCut will not open this project.`,
          { file: group.canonical, group: group.name }));
      }
    }
  }
  // A transition needs a clip on BOTH sides. CapCut silently discards one attached to a
  // segment with nothing after it on its own track, so the edit looks applied on disk and
  // is gone the moment the project is opened. And a transition below the talking head
  // wipes the B-roll while the face hard-cuts — the layer, not just the timing, is wrong.
  for (const group of state.groups) {
    const doc = group.doc;
    if (!doc || !Array.isArray(doc.tracks)) continue;
    const transitionIds = new Set((doc.materials?.transitions || []).map(m => m.id));
    if (!transitionIds.size) continue;
    const videoTracks = doc.tracks
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.type === 'video' && (t.segments || []).length);
    const carriers = [];
    for (const { t, i } of videoTracks) {
      const segs = [...t.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
      for (const [n, seg] of segs.entries()) {
        if (!(seg.extra_material_refs || []).some(r => transitionIds.has(r))) continue;
        const end = seg.target_timerange.start + seg.target_timerange.duration;
        carriers.push({ i, at: end });
        const next = segs[n + 1];
        if (!next || next.target_timerange.start - end > 20000) {
          issues.push(issue('error', 'TRANSITION_ORPHANED',
            `${group.name}: a transition at ${(end / 1e6).toFixed(2)}s sits on track ${i} with no clip after it. CapCut will drop it on load.`,
            { file: group.canonical, track: i, at: end / 1e6 }));
        }
      }
    }
    // Hermes-agent puts all nine of its transitions on one track — the talking head — and
    // none anywhere else. Split across layers, each wipe only affects its own layer while
    // the others cut straight through, which is the difference between a polished cut and
    // a B-roll that dissolves under a face that jumps.
    let principal = null;
    try { principal = principalTrack(doc).index; } catch { /* no continuous track; skip */ }
    if (principal != null) {
      const strays = [...new Set(carriers.filter(c => c.i !== principal).map(c => c.i))];
      if (strays.length) {
        const n = carriers.filter(c => c.i !== principal).length;
        issues.push(issue('warn', 'TRANSITION_OFF_PRINCIPAL',
          `${group.name}: ${n} transition(s) sit on track(s) ${strays.join(', ')} instead of the principal track ${principal} (the gapless talking head). Re-run \`capcutctl polish\` to move them.`,
          { file: group.canonical, strays, principal }));
      }
    }

    // A frame plate above the cut is fine: a PNG or GIF swapping when the layout changes is
    // the frame following the scene, and Hermes-agent — the reference — does exactly that at
    // four of its nine cuts. The fault is a higher track of MOVING PICTURE that cuts at the
    // same instant with no transition of its own: that layer hard-cuts through the wipe.
    const plates = new Set((doc.materials?.videos || [])
      .filter(m => m.type && m.type !== 'video').map(m => m.id));
    for (const { i, at } of carriers) {
      for (const { i: j, t } of videoTracks) {
        if (j <= i) continue;
        const bare = (t.segments || []).find(s =>
          Math.abs(s.target_timerange.start + s.target_timerange.duration - at) < 20000
          && !plates.has(s.material_id)
          && !(s.desc || '').startsWith('layout:')
          && !(s.extra_material_refs || []).some(r => transitionIds.has(r)));
        if (!bare) continue;
        issues.push(issue('warn', 'TRANSITION_BELOW_TOP',
          `${group.name}: the transition at ${(at / 1e6).toFixed(2)}s is on track ${i}, but track ${j} cuts at the same instant with no transition and renders above it — the upper layer hard-cuts through the wipe. Put transitions on the principal (talking-head) track.`,
          { file: group.canonical, track: i, cutAlsoOn: j, at: at / 1e6 }));
        break;
      }
    }
  }

  const running = capcutProcess();
  if (running.running) issues.push(issue('warning', 'CAPCUT_RUNNING', `CapCut is running (PID ${running.pids.join(', ')}). Writes are blocked by default.`, { pids: running.pids }));
  return {
    project: projectDir,
    activeTimelineId: state.activeTimelineId,
    documents: state.groups.map(group => ({ name: group.name, file: group.canonical })),
    errors: issues.filter(item => item.level === 'error').length,
    warnings: issues.filter(item => item.level === 'warning').length,
    issues
  };
}

function walk(value, visitor, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    visitor(child, keyPath);
    walk(child, visitor, keyPath);
  }
}

export function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      deepMerge(target[key], value);
    } else target[key] = clone(value);
  }
  return target;
}

export function unsetPath(target, dotted) {
  const keys = dotted.split('.');
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cursor || typeof cursor !== 'object') return;
    cursor = cursor[keys[i]];
  }
  if (cursor && typeof cursor === 'object') delete cursor[keys.at(-1)];
}

function matches(value, selector = {}) {
  if (selector.id && value.id !== selector.id) return false;
  if (selector.name && value.name !== selector.name) return false;
  if (selector.desc && value.desc !== selector.desc) return false;
  if (selector.material_id && value.material_id !== selector.material_id) return false;
  if (selector.path && value.path !== selector.path) return false;
  if (selector.pathEndsWith && !value.path?.endsWith(selector.pathEndsWith)) return false;
  return true;
}

export function selectSegments(doc, selector = {}) {
  return allSegments(doc).filter(entry => {
    if (selector.trackIndex != null && entry.trackIndex !== selector.trackIndex) return false;
    if (selector.trackType && entry.track.type !== selector.trackType) return false;
    return matches(entry.segment, selector);
  });
}

export function selectMaterials(doc, selector = {}) {
  const result = [];
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (matches(value, selector)) result.push({ kind, value });
  }
  return result;
}

function equivalentMaterialMatches(found) {
  if (!found.length) return false;
  const first = found[0];
  return found.every(entry => entry.kind === first.kind && entry.value.id === first.value.id && JSON.stringify(entry.value) === JSON.stringify(first.value));
}

function requireMatches(matchesList, op, label) {
  if (!matchesList.length && op.optional === true) return false;
  if (!matchesList.length) throw new CapcutError(`${op.op}: no ${label} matched ${JSON.stringify(op.selector || op.segment || op.from)}.`, { code: 'SELECTOR_EMPTY' });
  if (matchesList.length > 1 && op.all !== true) {
    throw new CapcutError(`${op.op}: selector matched ${matchesList.length} ${label}; add \"all\": true or use a unique id.`, { code: 'SELECTOR_AMBIGUOUS' });
  }
  return true;
}

function ensureMaterialArray(doc, kind) {
  if (!Array.isArray(doc.materials[kind])) doc.materials[kind] = [];
  return doc.materials[kind];
}

function cloneExtraRefs(doc, template, segmentId) {
  const index = materialIndex(doc);
  const refs = [];
  for (const oldId of template.extra_material_refs || []) {
    const indexed = index.get(oldId);
    if (!indexed) continue;
    const copied = clone(indexed.value);
    copied.id = uuid();
    if (copied.bind_segment_id === template.id || copied.bind_segment_id === '') copied.bind_segment_id = segmentId;
    ensureMaterialArray(doc, indexed.kind).push(copied);
    refs.push(copied.id);
  }
  return refs;
}

function removeUnreferencedMaterials(doc, ids) {
  const live = new Set();
  for (const { segment } of allSegments(doc)) {
    if (segment.material_id) live.add(segment.material_id);
    for (const ref of segment.extra_material_refs || []) live.add(ref);
  }
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    doc.materials[kind] = values.filter(value => !ids.has(value?.id) || live.has(value.id));
  }
}

function normalizeUs(value, field) {
  if (value == null) return null;
  if (Number.isInteger(value) && Math.abs(value) > 100000) return value;
  if (!Number.isFinite(value)) throw new CapcutError(`${field} must be finite.`, { code: 'BAD_TIME' });
  return Math.round(value * 1_000_000);
}

function opSegmentPatch(doc, op) {
  const found = selectSegments(doc, op.selector);
  if (!requireMatches(found, op, 'segments')) return { changed: 0, skipped: true };
  for (const entry of op.all ? found : found.slice(0, 1)) {
    deepMerge(entry.segment, op.set || {});
    for (const key of op.unset || []) unsetPath(entry.segment, key);
  }
  return { changed: op.all ? found.length : 1 };
}

function opSegmentRemove(doc, op) {
  const found = selectSegments(doc, op.selector);
  if (!requireMatches(found, op, 'segments')) return { changed: 0, skipped: true };
  const selected = op.all ? found : found.slice(0, 1);
  const refIds = new Set();
  for (const entry of selected) for (const ref of entry.segment.extra_material_refs || []) refIds.add(ref);
  for (const track of doc.tracks || []) {
    track.segments = (track.segments || []).filter(segment => !selected.some(entry => entry.segment === segment));
  }
  if (op.pruneRefs !== false) removeUnreferencedMaterials(doc, refIds);
  return { changed: selected.length };
}

function resolveTrack(doc, selector = {}) {
  const tracks = (doc.tracks || []).map((track, index) => ({ track, index })).filter(entry => {
    if (selector.index != null && entry.index !== selector.index) return false;
    if (selector.id && entry.track.id !== selector.id) return false;
    if (selector.type && entry.track.type !== selector.type) return false;
    return true;
  });
  if (tracks.length !== 1) throw new CapcutError(`Track selector matched ${tracks.length} tracks: ${JSON.stringify(selector)}`, { code: 'TRACK_SELECTOR' });
  return tracks[0];
}

function opSegmentClone(doc, op) {
  const templates = selectSegments(doc, op.from || {});
  if (!requireMatches(templates, { ...op, selector: op.from }, 'template segments')) return { changed: 0, skipped: true };
  const template = templates[0].segment;
  const destination = resolveTrack(doc, op.track || { index: templates[0].trackIndex });
  const copied = clone(template);
  copied.id = op.id || uuid();
  copied.extra_material_refs = cloneExtraRefs(doc, template, copied.id);
  copied.keyframe_refs = [];
  copied.common_keyframes = [];
  if (op.material) {
    const materials = selectMaterials(doc, op.material);
    if (materials.length !== 1 && !equivalentMaterialMatches(materials)) throw new CapcutError(`Material selector matched ${materials.length} distinct materials: ${JSON.stringify(op.material)}`, { code: 'MATERIAL_SELECTOR' });
    copied.material_id = materials[0].value.id;
  }
  if (op.target) copied.target_timerange = { start: normalizeUs(op.target.start, 'target.start'), duration: normalizeUs(op.target.duration, 'target.duration') };
  if (op.source === null) copied.source_timerange = null;
  else if (op.source) copied.source_timerange = { start: normalizeUs(op.source.start, 'source.start'), duration: normalizeUs(op.source.duration, 'source.duration') };
  if (op.set) deepMerge(copied, op.set);
  destination.track.segments.push(copied);
  destination.track.segments.sort((a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0));
  return { changed: 1, id: copied.id };
}

function opMaskPatch(doc, op) {
  const segments = selectSegments(doc, op.segment || op.selector || {});
  if (!requireMatches(segments, { ...op, selector: op.segment || op.selector }, 'segments')) return { changed: 0, skipped: true };
  let changed = 0;
  for (const entry of op.all ? segments : segments.slice(0, 1)) {
    const index = materialIndex(doc);
    const masks = (entry.segment.extra_material_refs || []).map(id => index.get(id)).filter(item => item?.kind === 'common_mask' || item?.value?.type === 'mask');
    if (!masks.length) throw new CapcutError(`mask.patch: segment ${entry.segment.id} has no bound mask.`, { code: 'MASK_NOT_FOUND' });
    if (masks.length > 1 && !op.mask?.id && !op.mask?.name) throw new CapcutError(`mask.patch: segment ${entry.segment.id} has multiple masks; select one.`, { code: 'MASK_AMBIGUOUS' });
    const mask = masks.find(item => matches(item.value, op.mask || {})) || masks[0];
    deepMerge(mask.value, op.set || {});
    entry.segment.enable_video_mask = op.enable ?? true;
    changed++;
  }
  return { changed };
}

function localizeMedia(projectDir, source, fileName, { dryRun = false } = {}) {
  if (!fs.existsSync(source)) throw new CapcutError(`Source media does not exist: ${source}`, { code: 'MISSING_SOURCE' });
  const mediaDir = path.join(projectDir, 'Resources', 'CapcutctlMedia');
  const safe = (fileName || path.basename(source)).replace(/[^a-zA-Z0-9._-]/g, '_');
  const destination = path.join(mediaDir, safe);
  if (!dryRun) {
    fs.mkdirSync(mediaDir, { recursive: true });
    if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
  }
  return destination;
}

function opMaterialRelink(doc, op, context) {
  const found = selectMaterials(doc, op.selector || {});
  if (!found.length && op.optional === true) return { changed: 0, skipped: true };
  if (!found.length) throw new CapcutError(`${op.op}: no materials matched ${JSON.stringify(op.selector || {})}.`, { code: 'SELECTOR_EMPTY' });
  if (found.length > 1 && op.all !== true && !equivalentMaterialMatches(found)) {
    throw new CapcutError(`${op.op}: selector matched ${found.length} distinct materials; add "all": true or use a unique id.`, { code: 'SELECTOR_AMBIGUOUS' });
  }
  let destination = path.resolve(op.path);
  if (op.localize) destination = localizeMedia(context.projectDir, destination, op.fileName, { dryRun: context.dryRun });
  if (!context.dryRun && !fs.existsSync(destination)) throw new CapcutError(`Relink target does not exist: ${destination}`, { code: 'MISSING_RELINK_TARGET' });
  const selected = op.all || equivalentMaterialMatches(found) ? found : found.slice(0, 1);
  for (const entry of selected) {
    entry.value.path = destination;
    if ('media_path' in entry.value) entry.value.media_path = '';
    if (op.name) entry.value.material_name = op.name;
    if (op.set) deepMerge(entry.value, op.set);
  }
  return { changed: selected.length, logicalMaterials: equivalentMaterialMatches(found) ? 1 : selected.length, path: destination };
}

function opMaterialClone(doc, op, context) {
  const found = selectMaterials(doc, op.from || {});
  if (!found.length && op.optional === true) return { changed: 0, skipped: true };
  if (!found.length) throw new CapcutError(`${op.op}: no template materials matched ${JSON.stringify(op.from || {})}.`, { code: 'SELECTOR_EMPTY' });
  if (found.length > 1 && !equivalentMaterialMatches(found)) throw new CapcutError(`${op.op}: template selector matched ${found.length} distinct materials.`, { code: 'SELECTOR_AMBIGUOUS' });
  const template = found[0];
  const copied = clone(template.value);
  copied.id = op.id;
  if (op.path) {
    let destination = path.resolve(op.path);
    if (op.localize) destination = localizeMedia(context.projectDir, destination, op.fileName, { dryRun: context.dryRun });
    if (!context.dryRun && !fs.existsSync(destination)) throw new CapcutError(`Material source does not exist: ${destination}`, { code: 'MISSING_MATERIAL_SOURCE' });
    copied.path = destination;
    if ('media_path' in copied) copied.media_path = '';
  }
  if (op.name) copied.material_name = op.name;
  if (op.set) deepMerge(copied, op.set);
  for (const key of op.unset || []) unsetPath(copied, key);
  ensureMaterialArray(doc, op.kind || template.kind).push(copied);
  return { changed: 1, id: copied.id, kind: op.kind || template.kind, path: copied.path };
}

function opTrackClone(doc, op) {
  const template = resolveTrack(doc, op.from || {});
  const copied = clone(template.track);
  copied.id = op.id;
  copied.segments = [];
  if (op.set) deepMerge(copied, op.set);
  for (const key of op.unset || []) unsetPath(copied, key);
  const at = op.at == null ? doc.tracks.length : Number(op.at);
  if (!Number.isInteger(at) || at < 0 || at > doc.tracks.length) throw new CapcutError(`track.clone: invalid insertion index ${op.at}.`, { code: 'TRACK_INDEX' });
  doc.tracks.splice(at, 0, copied);
  return { changed: 1, id: copied.id, index: at };
}

function opTimelineSet(doc, op) {
  if (op.duration != null) doc.duration = normalizeUs(op.duration, 'duration');
  if (op.fps != null) doc.fps = op.fps;
  if (op.canvas) doc.canvas_config = clone(op.canvas);
  if (op.name) doc.name = op.name;
  return { changed: 1 };
}

export function applyOperations(doc, operations, context) {
  const results = [];
  for (const [index, op] of (operations || []).entries()) {
    if (!op?.op) throw new CapcutError(`Operation ${index} is missing \"op\".`, { code: 'BAD_OPERATION' });
    if (Array.isArray(op.documents)) {
      const kind = context.group.startsWith('timeline:') ? 'timeline' : context.group;
      if (!op.documents.includes(context.group) && !op.documents.includes(kind)) {
        results.push({ index, op: op.op, changed: 0, skipped: true, reason: 'document_scope' });
        continue;
      }
    }
    let result;
    if (op.op === 'segment.patch') result = opSegmentPatch(doc, op);
    else if (op.op === 'segment.remove') result = opSegmentRemove(doc, op);
    else if (op.op === 'segment.clone') result = opSegmentClone(doc, op);
    else if (op.op === 'mask.patch') result = opMaskPatch(doc, op);
    else if (op.op === 'material.relink') result = opMaterialRelink(doc, op, context);
    else if (op.op === 'material.clone') result = opMaterialClone(doc, op, context);
    else if (op.op === 'track.clone') result = opTrackClone(doc, op);
    else if (op.op === 'timeline.set') result = opTimelineSet(doc, op);
    else if (op.op === 'layout.apply') result = opLayoutApply(doc, op, context);
    else if (op.op === 'layout.background') result = opLayoutBackground(doc, op, context);
    else if (op.op === 'layout.broll') result = opLayoutBroll(doc, op, context);
    else if (op.op === 'polish') result = opPolish(doc, op, context);
    else if (op.op === 'pace') result = opPace(doc, op, context);
    else if (op.op === 'signature') result = opSignature(doc, op, context);
    else throw new CapcutError(`Unsupported operation: ${op.op}`, { code: 'UNSUPPORTED_OPERATION' });
    results.push({ index, op: op.op, ...result });
  }
  return results;
}

function snapshotFiles(projectDir) {
  const files = new Set();
  for (const group of documentGroups(projectDir)) for (const file of group.mirrors) if (fs.existsSync(file)) files.add(file);
  for (const relative of ['draft_meta_info.json', 'draft_virtual_store.json', 'Timelines/project.json']) {
    const file = path.join(projectDir, relative);
    if (fs.existsSync(file)) files.add(file);
  }
  return [...files];
}

export function createSnapshot(projectDir, label = 'snapshot') {
  const root = path.join(projectDir, '.capcutctl', 'history', `${nowStamp()}-${label.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  fs.mkdirSync(root, { recursive: true });
  const managed = documentGroups(projectDir).flatMap(group => group.mirrors);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    projectDir,
    files: [],
    absent: managed.filter(file => !fs.existsSync(file)).map(file => path.relative(projectDir, file))
  };
  for (const file of snapshotFiles(projectDir)) {
    const relative = path.relative(projectDir, file);
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
    manifest.files.push({ relative, sha256: sha256(fs.readFileSync(file)) });
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), stableJson(manifest));
  return root;
}

function restoreSnapshot(snapshotDir) {
  const manifest = readJson(path.join(snapshotDir, 'manifest.json'));
  for (const relative of manifest.absent || []) {
    const destination = path.join(manifest.projectDir, relative);
    try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch {}
  }
  for (const item of manifest.files) {
    const source = path.join(snapshotDir, item.relative);
    const destination = path.join(manifest.projectDir, item.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

export function listSnapshots(projectDir) {
  const history = path.join(projectDir, '.capcutctl', 'history');
  if (!fs.existsSync(history)) return [];
  return fs.readdirSync(history, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(history, entry.name, 'manifest.json')))
    .map(entry => {
      const snapshot = path.join(history, entry.name);
      const manifest = readJson(path.join(snapshot, 'manifest.json'));
      return { name: entry.name, path: snapshot, createdAt: manifest.createdAt, files: manifest.files?.length || 0 };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function acquireLock(projectDir) {
  const dir = path.join(projectDir, '.capcutctl');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'write.lock');
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, stableJson({ pid: process.pid, startedAt: new Date().toISOString() }));
    return { file, fd };
  } catch (error) {
    if (error.code === 'EEXIST') throw new CapcutError(`Another capcutctl write is active: ${file}`, { code: 'LOCKED', exitCode: 4 });
    throw error;
  }
}

function releaseLock(lock) {
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.file); } catch {}
}

function stageWrites(writes, transactionId) {
  const staged = [];
  for (const write of writes) {
    fs.mkdirSync(path.dirname(write.file), { recursive: true });
    const temp = `${write.file}.capcutctl-${transactionId}.tmp`;
    const fd = fs.openSync(temp, 'w');
    fs.writeFileSync(fd, write.data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    readJson(temp);
    staged.push({ ...write, temp });
  }
  return staged;
}

function commitStaged(staged) {
  let writes = 0;
  for (const item of staged) {
    fs.renameSync(item.temp, item.file);
    writes++;
    if (process.env.CAPCUTCTL_FAIL_AFTER_WRITES && writes >= Number(process.env.CAPCUTCTL_FAIL_AFTER_WRITES)) {
      throw new Error('Injected transaction failure.');
    }
  }
}

function cleanStaged(staged) {
  for (const item of staged || []) try { if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp); } catch {}
}

export function executeTransaction(projectDir, mutator, {
  dryRun = false,
  forceRunning = false,
  backup = true,
  label = 'edit',
  forceWriteAll = false
} = {}) {
  assertCapcutClosed({ forceRunning });
  const state = loadProject(projectDir);
  const working = state.groups.map(group => ({ ...group, doc: clone(group.doc) }));
  const result = mutator(working);
  const validation = working.flatMap(group => validateDocument(group.doc, { file: group.canonical, checkFiles: !dryRun }));
  const errors = validation.filter(item => item.level === 'error');
  if (errors.length) throw new CapcutError(`Transaction failed validation with ${errors.length} error(s).`, { code: 'VALIDATION_FAILED', details: errors });
  const changedGroups = working.filter((group, index) => forceWriteAll || stableJson(group.doc) !== stableJson(state.groups[index].doc));
  const preview = {
    dryRun,
    project: projectDir,
    changedGroups: changedGroups.map(group => group.name),
    documents: changedGroups.map(group => group.canonical),
    result,
    validation
  };
  if (dryRun || !changedGroups.length) return { ...preview, committed: false, snapshot: null };

  const lock = acquireLock(projectDir);
  let snapshot = null;
  let staged = [];
  try {
    if (backup) snapshot = createSnapshot(projectDir, label);
    const transactionId = uuid();
    const writes = [];
    for (const group of changedGroups) {
      const data = stableJson(group.doc);
      for (const file of group.mirrors) writes.push({ file, data });
    }
    staged = stageWrites(writes, transactionId);
    commitStaged(staged);
    const post = doctor(projectDir, { checkFiles: true });
    if (post.errors) throw new CapcutError(`Post-write validation found ${post.errors} errors.`, { code: 'POST_WRITE_VALIDATION', details: post.issues });
    return { ...preview, committed: true, snapshot, postDoctor: post };
  } catch (error) {
    if (snapshot) restoreSnapshot(snapshot);
    throw new CapcutError(`Transaction rolled back: ${error.message}`, { code: 'ROLLED_BACK', details: { snapshot } });
  } finally {
    cleanStaged(staged);
    releaseLock(lock);
  }
}

export function applySpec(projectDir, spec, options = {}) {
  if (spec.version !== 1) throw new CapcutError(`Unsupported spec version: ${spec.version}`, { code: 'SPEC_VERSION' });
  const operations = clone(spec.operations || []);
  for (const op of operations) {
    if (['segment.clone', 'material.clone', 'track.clone'].includes(op.op) && !op.id) op.id = uuid();
    // Every op gets one, not a whitelist of ops. Each document in the group is edited
    // independently, so an op that mints ids must mint the SAME ids in each pass or the
    // mirrors drift apart. This was a per-op list and adding `signature` without adding it
    // here produced exactly that drift — silently, until doctor caught it.
    if (!op.__seed) op.__seed = uuid();
  }
  return executeTransaction(projectDir, groups => groups.map(group => ({
    group: group.name,
    operations: applyOperations(group.doc, operations, { projectDir, group: group.name, dryRun: Boolean(options.dryRun) })
  })), { ...options, label: options.label || spec.name || 'apply' });
}

export function restoreProjectSnapshot(projectDir, snapshotNameOrPath, options = {}) {
  assertCapcutClosed({ forceRunning: options.forceRunning });
  const history = path.resolve(projectDir, '.capcutctl', 'history');
  const snapshotDir = path.resolve(snapshotNameOrPath.includes(path.sep) ? snapshotNameOrPath : path.join(history, snapshotNameOrPath));
  const relative = path.relative(history, snapshotDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CapcutError('Snapshot must be a named entry inside this project\'s .capcutctl/history directory.', { code: 'SNAPSHOT_SCOPE', exitCode: 2 });
  }
  const manifestFile = path.join(snapshotDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new CapcutError(`Snapshot not found: ${snapshotNameOrPath}`, { code: 'SNAPSHOT_NOT_FOUND', exitCode: 2 });
  const manifest = readJson(manifestFile);
  if (path.resolve(manifest.projectDir) !== path.resolve(projectDir)) throw new CapcutError('Snapshot belongs to a different project path.', { code: 'SNAPSHOT_PROJECT' });
  const lock = acquireLock(projectDir);
  let rescue = null;
  try {
    if (options.backup !== false) rescue = createSnapshot(projectDir, options.label || 'before-restore');
    restoreSnapshot(snapshotDir);
    const post = doctor(projectDir, { checkFiles: true });
    if (post.errors) throw new CapcutError(`Restored snapshot has ${post.errors} validation error(s).`, { code: 'RESTORE_VALIDATION', details: post.issues });
    return { restored: snapshotDir, rescue, postDoctor: post };
  } catch (error) {
    if (rescue) restoreSnapshot(rescue);
    throw new CapcutError(`Restore rolled back: ${error.message}`, { code: 'RESTORE_ROLLED_BACK', details: { rescue } });
  } finally {
    releaseLock(lock);
  }
}

/**
 * CapCut re-saves a material under an id it already used, differing only in noise
 * (an audio_fade object, a crop corner of 0.9999999999999997). Structurally that is a
 * CONFLICTING_MATERIAL_ID error even though every copy points at the same file. Collapse
 * them — but only when they are the same LOGICAL material, so a genuine id collision
 * between two different clips is still reported rather than silently merged.
 */
function dedupeMaterials(doc) {
  const merged = [];
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    const seen = new Map();
    const keep = [];
    for (const value of values) {
      if (!value?.id) { keep.push(value); continue; }
      const prev = seen.get(value.id);
      if (!prev) { seen.set(value.id, value); keep.push(value); continue; }
      const same = ['path', 'width', 'height', 'duration', 'type', 'name']
        .every(k => JSON.stringify(prev[k]) === JSON.stringify(value[k]));
      if (same) merged.push({ kind, id: value.id });
      else keep.push(value);                       // a real collision: leave it for doctor
    }
    doc.materials[kind] = keep;
  }
  return merged;
}

export function syncMirrors(projectDir, options = {}) {
  const merged = [];
  const result = executeTransaction(projectDir, groups => {
    for (const group of groups) {
      group.doc = clone(group.doc);
      if (options.dedupe !== false) merged.push(...dedupeMaterials(group.doc).map(m => ({ ...m, group: group.name })));
    }
    return groups.map(group => ({ group: group.name, mirrors: group.mirrors }));
  }, { ...options, forceWriteAll: true, label: options.label || 'sync' });
  return { ...result, mergedDuplicateMaterials: merged.length, merged };
}

export function inspectProject(projectDir) {
  const state = loadProject(projectDir);
  return {
    project: projectDir,
    activeTimelineId: state.activeTimelineId,
    capcut: capcutProcess(),
    groups: state.groups.map(group => ({
      name: group.name,
      file: group.canonical,
      duration: group.doc.duration,
      fps: group.doc.fps,
      canvas: group.doc.canvas_config,
      tracks: (group.doc.tracks || []).map((track, index) => ({ index, id: track.id, type: track.type, segments: track.segments?.length || 0 })),
      materials: Object.fromEntries(Object.entries(group.doc.materials || {}).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]))
    }))
  };
}
