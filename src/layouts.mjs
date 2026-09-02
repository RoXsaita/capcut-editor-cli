import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { principalTrack } from './polish.mjs';
import { assertOrigin } from './origin.mjs';
import {
  CapcutError, clone, seededId, allSegments, selectSegments, loadProject, loadPreset,
  expandHome, localizeMedia, stableJson, assetSearchRoots, preservedRange
} from './core.mjs';

/**
 * Root and active timeline are edited as separate documents, so every generated
 * id must be a pure function of (transaction seed, stable key) — never random —
 * or the two documents drift apart. Segment ids are identical across documents,
 * which makes them safe keys.
 */
let SEED = null;
const mint = key => seededId(SEED, key);

export function presets() {
  return loadPreset('layouts');
}

/** Indigo rect around an 80% centred rl2 window recording. Source of truth: presets/layouts.json screenRecording. */
export function screenRecordingFrame() {
  const g = presets().screenRecording;
  if (!g?.frame?.clip) throw new CapcutError('layouts.json is missing screenRecording.frame', { code: 'MISSING_PRESET' });
  return g;
}

// Wrapped, not aliased: core.mjs imports this module, so the binding is still
// in its TDZ while this module body runs.
const expand = p => expandHome(p);

const MEDIA_MAP_RELATIVE = path.join('.capcutctl', 'media-map.json');
const RL2_SIDECARS = ['trace.ndjson', 'session.json', 'frames.ndjson', 'change.ndjson'];

function canonicalMediaPath(value) {
  const expanded = expand(value);
  const resolved = path.resolve(expanded || '');
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

function safeArtifactName(value) {
  return String(value || 'take').replace(/[^a-zA-Z0-9._-]/g, '_') || 'take';
}

/** Stable identity for the source take, independent of the localized destination filename. */
export function sourceTakeId(source) {
  return `rl2-${crypto.createHash('sha256').update(canonicalMediaPath(source)).digest('hex').slice(0, 20)}`;
}

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.capcutctl-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function retireLegacyRl2Sidecar(projectDir, takeDir, destination) {
  const legacy = path.join(projectDir, '.capcutctl', 'rl2', safeArtifactName(path.basename(takeDir)));
  if (path.resolve(legacy) === path.resolve(destination) || !fs.existsSync(legacy)) return;
  // core.localizeMedia from older transaction hosts copied into this basename-only folder.
  // Retire it only when its copied trace/session still matches this source, so an unrelated
  // hand-kept legacy take is not removed while we migrate the current material.
  const copied = RL2_SIDECARS.filter(name => fs.existsSync(path.join(legacy, name)));
  const matching = copied.length > 0 && copied.every(name => {
    const from = path.join(takeDir, name), old = path.join(legacy, name);
    return fs.existsSync(from) && Buffer.from(fs.readFileSync(from)).equals(Buffer.from(fs.readFileSync(old)));
  });
  if (!matching) return;
  for (const name of copied) {
    try { fs.unlinkSync(path.join(legacy, name)); } catch {}
  }
  try { fs.rmdirSync(legacy); } catch {}
}

function readMediaMap(projectDir) {
  const file = path.join(projectDir, MEDIA_MAP_RELATIVE);
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    // A truncated map must not make a draft unreadable. The next atomic write replaces it.
    return {};
  }
}

/**
 * Persist provenance by material id. The whole map is replaced atomically, so a transcript
 * lookup never observes half a record after localize/relink. `paths` keeps compatibility with
 * the original direct `{localizedPath: originalPath}` map shape.
 */
export function persistMaterialSourceMapping(projectDir, {
  materialId, localizedPath, originalPath, sourceTakeId: takeId = null,
  origin = null, derivedFromPath = null, derivedFromOffset = null,
} = {}) {
  if (!projectDir || !materialId || !localizedPath || !originalPath) return null;
  const localized = canonicalMediaPath(localizedPath);
  const original = canonicalMediaPath(originalPath);
  if (localized === original) return null;
  const file = path.join(projectDir, MEDIA_MAP_RELATIVE);
  const map = readMediaMap(projectDir);
  map.version = 1;
  map.materials = map.materials && typeof map.materials === 'object' && !Array.isArray(map.materials)
    ? map.materials : {};
  map.paths = map.paths && typeof map.paths === 'object' && !Array.isArray(map.paths)
    ? map.paths : {};
  const stableTakeId = takeId || sourceTakeId(original);
  map.materials[materialId] = {
    id: materialId,
    material_id: materialId,
    localizedPath: localized,
    localized_path: localized,
    originalPath: original,
    original_path: original,
    sourceTakeId: stableTakeId,
    source_take_id: stableTakeId,
    // What the origin contract decided at import: 'capture' (an original recording),
    // 'generated' (a render with no editable source), or 'derived' (pre-processed, with the
    // real original named). `doctor` needs this to know which lost origins are repairable.
    origin: origin || null,
    derived_from_path: derivedFromPath || null,
    derived_from_offset: derivedFromOffset ?? null,
  };
  map.paths[localized] = original;
  atomicWrite(file, stableJson(map));
  return file;
}

/**
 * Record where a localized material came from: the media map and, for rl2 takes, the trace
 * sidecar. Written as soon as the media is copied rather than after the draft commits — the
 * copy itself survives a rollback, so provenance for it is never wrong, and both writes are
 * atomic and idempotent so a retried operation cannot leave a half record.
 */
export function recordMediaProvenance(context, record = {}) {
  if (!context?.projectDir || context.dryRun) return null;
  const source = record.originalPath || record.sourcePath;
  const localized = record.localizedPath || record.destination;
  if (!record.materialId || !source || !localized || canonicalMediaPath(source) === canonicalMediaPath(localized)) return null;
  const normalized = {
    ...record,
    projectDir: context.projectDir,
    originalPath: canonicalMediaPath(source),
    localizedPath: canonicalMediaPath(localized),
    sourceTakeId: record.sourceTakeId || sourceTakeId(source),
    origin: record.origin || null,
    derivedFromPath: record.derivedFromPath || null,
    derivedFromOffset: record.derivedFromOffset ?? null,
  };
  persistMaterialSourceMapping(context.projectDir, normalized);
  persistRl2TakeSidecar(context.projectDir, normalized);
  return normalized;
}

/**
 * Copy an RL2 trace beside the draft under a collision-safe, source-derived directory. The
 * session gets the same identity as the material, which lets polish associate two takes that
 * share both `screen.mp4` and their human-readable take-directory basename.
 */
export function persistRl2TakeSidecar(projectDir, {
  originalPath, localizedPath, materialId, sourceTakeId: takeId = null
} = {}) {
  if (!projectDir || !originalPath || !materialId) return null;
  const source = canonicalMediaPath(originalPath);
  const takeDir = path.dirname(source);
  if (!fs.existsSync(path.join(takeDir, 'trace.ndjson'))) return null;
  const identity = takeId || sourceTakeId(source);
  const safeIdentity = identity.replace(/[^a-zA-Z0-9_-]/g, '');
  const name = `${safeArtifactName(path.basename(takeDir))}__${safeIdentity}`;
  const destination = path.join(projectDir, '.capcutctl', 'rl2', name);
  fs.mkdirSync(destination, { recursive: true });
  for (const sidecar of RL2_SIDECARS) {
    const from = path.join(takeDir, sidecar);
    if (!fs.existsSync(from)) continue;
    atomicWrite(path.join(destination, sidecar), fs.readFileSync(from));
  }
  let session = {};
  const sessionFile = path.join(destination, 'session.json');
  try {
    const value = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) session = value;
  } catch {}
  const metadata = {
    source_take_id: identity,
    sourceTakeId: identity,
    source_path: source,
    original_path: source,
    localized_path: localizedPath ? canonicalMediaPath(localizedPath) : null,
    material_id: materialId,
  };
  session.capcutctl = { ...(session.capcutctl && typeof session.capcutctl === 'object' ? session.capcutctl : {}), ...metadata };
  atomicWrite(sessionFile, stableJson(session));
  atomicWrite(path.join(destination, 'take.json'), stableJson(metadata));
  retireLegacyRl2Sidecar(projectDir, takeDir, destination);
  return destination;
}

function ensureMaterialArray(doc, kind) {
  if (!Array.isArray(doc.materials[kind])) doc.materials[kind] = [];
  return doc.materials[kind];
}

function materialById(doc) {
  const map = new Map();
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (value?.id) map.set(value.id, { kind, value });
  }
  return map;
}

/** Renumber track_render_index so it always mirrors the track's position. */
export function renumberTracks(doc) {
  doc.tracks.forEach((track, index) => {
    for (const segment of track.segments || []) segment.track_render_index = index;
  });
}

/**
 * Insert an empty video overlay track at `index`, cloning the shell of an
 * existing overlay track so we never invent CapCut track structure.
 */
export function insertOverlayTrack(doc, index, id) {
  const template = (doc.tracks || []).find(t => t.type === 'video' && t.flag === 2)
    || (doc.tracks || []).find(t => t.type === 'video');
  if (!template) throw new CapcutError('layout: project has no video track to model a new overlay track on.', { code: 'NO_TRACK_TEMPLATE' });
  const track = clone(template);
  track.id = id || mint(`track:${index}`);
  track.segments = [];
  track.flag = 2;
  track.attribute = 0;
  doc.tracks.splice(index, 0, track);
  renumberTracks(doc);
  return track;
}

/** Locate the asset on disk, preferring a copy already referenced by the project. */
function resolveAsset(doc, basename, projectDir) {
  for (const material of doc.materials?.videos || []) {
    if (material.path && path.basename(material.path) === basename) return material.path;
  }
  const roots = [
    path.join(projectDir, 'Resources'),
    ...assetSearchRoots(presets().assetSearchPaths || []),
  ];
  for (const root of roots) {
    const direct = path.join(root, basename);
    if (fs.existsSync(direct)) return direct;
  }
  throw new CapcutError(
    `layout: asset "${basename}" not found. Searched the project's materials and: ${roots.join(', ')}\n`
    + 'The overlays the built-in layouts need ship in the package\'s assets/ directory, so this '
    + 'normally cannot happen — check that install did not drop it. To use your own artwork, put a '
    + 'file of this name in a directory named by $CAPCUTCTL_ASSET_DIR.',
    { code: 'ASSET_NOT_FOUND' }
  );
}

/** Reuse the project's existing material for this asset, or mint one from the template. */
function ensurePhotoMaterial(doc, basename, projectDir) {
  const existing = (doc.materials?.videos || []).find(m => m.path && path.basename(m.path) === basename);
  if (existing) return existing.id;
  const file = resolveAsset(doc, basename, projectDir);
  const material = clone(presets().photoMaterialTemplate);
  material.id = mint(`asset:${basename}`);
  material.path = file;
  material.material_name = basename;
  material.local_material_id = '';
  ensureMaterialArray(doc, 'videos').push(material);
  return material.id;
}

/** Attach (or retune) a mask on a segment so it matches the preset exactly. */
function applyMask(doc, segment, maskTemplate, config) {
  const index = materialById(doc);
  const bound = (segment.extra_material_refs || [])
    .map(id => index.get(id))
    .find(item => item?.kind === 'common_mask' || item?.value?.type === 'mask');
  if (bound) {
    const keep = bound.value.id;
    const fresh = clone(maskTemplate);
    fresh.id = keep;
    fresh.config = clone(config);
    Object.keys(bound.value).forEach(k => delete bound.value[k]);
    Object.assign(bound.value, fresh);
  } else {
    const mask = clone(maskTemplate);
    mask.id = mint(`${segment.id}:mask`);
    mask.config = clone(config);
    ensureMaterialArray(doc, 'common_mask').push(mask);
    segment.extra_material_refs = [...(segment.extra_material_refs || []), mask.id];
  }
  segment.enable_video_mask = true;
}

/** Build an overlay segment (seam bar / white ring) covering `subject`'s span. */
function buildOverlaySegment(doc, subject, spec, projectDir) {
  const segment = clone(spec.segmentTemplate);
  segment.id = mint(`${subject.id}:${spec.role}`);
  segment.material_id = ensurePhotoMaterial(doc, spec.asset, projectDir);
  segment.target_timerange = clone(subject.target_timerange);
  segment.source_timerange = { start: 0, duration: subject.target_timerange.duration };
  segment.clip = clone(spec.clip);
  segment.render_index = (subject.render_index || 0) + (spec.renderIndexOffset || 1);
  segment.extra_material_refs = [];
  segment.desc = `layout:${spec.role}`;
  if (spec.ownerId) segment.screen_recording_id = spec.ownerId;
  if (spec.mask) applyMask(doc, segment, spec.maskTemplate, spec.mask);
  else segment.enable_video_mask = false;
  return segment;
}

function overlapsAny(track, range) {
  return (track.segments || []).some(s => {
    const a = s.target_timerange;
    return a.start < range.start + range.duration && range.start < a.start + a.duration;
  });
}

/**
 * Find (or create) a track ABOVE `subjectTrackIndex` that can hold overlays for
 * `range` without colliding. Returns { track, index, created }.
 */
function overlayTrackFor(doc, subjectTrackIndex, range, role, asset) {
  const want = `layout:${role}`;
  const isOurs = s => {
    if (s.desc === want) return true;
    if (!asset) return false;
    const m = (doc.materials?.videos || []).find(v => v.id === s.material_id);
    return Boolean(m?.path) && path.basename(m.path) === asset;   // an existing hand-built overlay
  };
  // A track is usable when nothing FOREIGN overlaps the span. Overlapping
  // overlays we own (or that already use this asset) get replaced, not duplicated.
  const usable = i => {
    const track = doc.tracks[i];
    if (!track || track.type !== 'video') return false;
    return !(track.segments || []).some(s => {
      const a = s.target_timerange;
      const hits = a.start < range.start + range.duration && range.start < a.start + a.duration;
      return hits && !isOurs(s);
    });
  };
  // 1. a track already dedicated to this exact role
  for (let i = subjectTrackIndex + 1; i < doc.tracks.length; i++) {
    if (!usable(i)) continue;
    const segs = doc.tracks[i].segments || [];
    if (segs.length && segs.every(isOurs)) return { track: doc.tracks[i], index: i, created: false };
  }
  // 2. an empty overlay track
  for (let i = subjectTrackIndex + 1; i < doc.tracks.length; i++) {
    if (usable(i) && (doc.tracks[i].segments || []).length === 0) return { track: doc.tracks[i], index: i, created: false };
  }
  const at = doc.tracks.length;
  const track = insertOverlayTrack(doc, at, mint(`overlaytrack:${role}`));
  track.name = `layout-${role}`;
  return { track, index: at, created: true };
}

const LAYOUT_DESC = name => `layout:${name}`;

export function opLayoutApply(doc, op, context = {}) {
  SEED = op.__seed || null;
  const config = presets();
  const layout = config.layouts[op.layout];
  if (!layout) {
    throw new CapcutError(
      `layout.apply: unknown layout "${op.layout}". Known: ${Object.keys(config.layouts).join(', ')}`,
      { code: 'UNKNOWN_LAYOUT' }
    );
  }
  const found = selectSegments(doc, op.selector || {});
  if (!found.length) {
    if (op.optional === true) return { changed: 0, skipped: true };
    throw new CapcutError(`layout.apply: no segments matched ${JSON.stringify(op.selector)}.`, { code: 'SELECTOR_EMPTY' });
  }
  if (found.length > 1 && op.all !== true) {
    throw new CapcutError(`layout.apply: selector matched ${found.length} segments; add "all": true.`, { code: 'SELECTOR_AMBIGUOUS' });
  }
  const targets = op.all ? found : found.slice(0, 1);
  const overlays = [];
  for (const entry of targets) {
    const subject = entry.segment;
    subject.clip = clone(layout.subject.clip);
    subject.uniform_scale = { on: true, value: 1.0 };
    subject.desc = subject.desc && subject.desc.startsWith('layout:') ? LAYOUT_DESC(op.layout) : (subject.desc || LAYOUT_DESC(op.layout));
    if (layout.subject.mask) applyMask(doc, subject, layout.subject.maskTemplate, layout.subject.mask);
    else removeMask(doc, subject);
    // Always strip other-role plates on this span (seam-bar, white-ring, blur).
    // Switching split ↔ circle used to stack both because overlays are keyed by role.
    removeOverlaysOver(doc, entry.trackIndex, subject.target_timerange);

    if (layout.overlay && op.overlay !== false) {
      const slot = overlayTrackFor(doc, entry.trackIndex, subject.target_timerange, layout.overlay.role, layout.overlay.asset);
      // replace any overlay already covering exactly this span, so re-running is idempotent
      const sameSpan = s => s.target_timerange.start === subject.target_timerange.start
        && s.target_timerange.duration === subject.target_timerange.duration;
      const usesAsset = s => {
        const m = (doc.materials?.videos || []).find(v => v.id === s.material_id);
        return Boolean(m?.path) && path.basename(m.path) === layout.overlay.asset;
      };
      slot.track.segments = (slot.track.segments || [])
        .filter(s => !(sameSpan(s) && ((s.desc || '').startsWith('layout:') || usesAsset(s))));
      const overlay = buildOverlaySegment(doc, subject, layout.overlay, context.projectDir || '.');
      slot.track.segments.push(overlay);
      slot.track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
      overlays.push({ id: overlay.id, track: slot.index, created: slot.created });
    }
  }
  renumberTracks(doc);
  return { changed: targets.length, layout: op.layout, overlays };
}

/** Detach and delete the mask a previous layout bound to this segment. */
function removeMask(doc, segment) {
  const index = materialById(doc);
  const bound = (segment.extra_material_refs || [])
    .map(id => index.get(id))
    .filter(item => item?.kind === 'common_mask' || item?.value?.type === 'mask');
  if (!bound.length) return;
  const ids = new Set(bound.map(b => b.value.id));
  segment.extra_material_refs = (segment.extra_material_refs || []).filter(r => !ids.has(r));
  doc.materials.common_mask = (doc.materials.common_mask || []).filter(m => !ids.has(m.id));
}

/** Drop layout plates on ANY track covering this span (blur sits BELOW the subject). */
function removeOverlaysOver(doc, _trackIndex, span) {
  for (const track of doc.tracks) {
    if (track.type !== 'video') continue;
    track.segments = (track.segments || []).filter(s =>
      !((s.desc || '').startsWith('layout:')
        && s.target_timerange.start === span.start
        && s.target_timerange.duration === span.duration));
  }
}

/**
 * Which layout each principal clip SHOULD have — a rule, not a judgement call. If moving
 * picture covers the moment from a lower track, he is sharing the frame: split screen.
 * If nothing does, he is alone in it: full face. Verified against grok-build-final, where
 * this reproduces the eight split-screen beats and the two full-face ones exactly.
 */
export function layoutAudit(doc, trackIndex = null) {
  const { index: pi, track } = principalTrack(doc, trackIndex);
  const plates = new Set((doc.materials.videos || []).filter(m => m.type && m.type !== 'video').map(m => m.id));
  const masks = new Set((doc.materials.common_mask || []).map(m => m.id));
  const covers = (start, end) => doc.tracks.some((t, i) =>
    i < pi && t.type === 'video' && (t.segments || []).some(s =>
      !plates.has(s.material_id) && !(s.desc || '').startsWith('layout:')
      && s.target_timerange.start < end - 20000
      && s.target_timerange.start + s.target_timerange.duration > start + 20000));
  return [...track.segments]
    .sort((a, b) => a.target_timerange.start - b.target_timerange.start)
    .map(s => {
      const start = s.target_timerange.start, end = start + s.target_timerange.duration;
      const want = covers(start, end) ? 'split-screen' : 'full-face';
      const is = currentLook(doc, s, masks);
      // Circle with B-roll under it should become split-screen. Circle with nothing
      // under it is a look, not a miss — auto must not strip it to full-face.
      const change = is === 'circle' ? want === 'split-screen' : is !== want;
      return { id: s.id, at: Math.round(start / 1000) / 1000, end: Math.round(end / 1000) / 1000,
               brollUnder: covers(start, end), is, want, change };
    });
}

function currentLook(doc, segment, masks) {
  if (hasLayoutMask(doc, segment, 'split-screen')) return 'split-screen';
  if (hasLayoutMask(doc, segment, 'circle')) return 'circle';
  if ((segment.extra_material_refs || []).some(r => masks.has(r)) && segment.enable_video_mask !== false) {
    return 'split-screen';
  }
  return 'full-face';
}

/** True when the segment carries this layout's exact subject mask config. */
function hasLayoutMask(doc, segment, layoutName) {
  const want = presets().layouts[layoutName]?.subject?.mask;
  if (!want) return false;
  if (segment.enable_video_mask === false) return false;   // disabled leftovers are not a style
  const index = materialById(doc);
  return (segment.extra_material_refs || []).some(id => {
    const item = index.get(id);
    if (!item || (item.kind !== 'common_mask' && item.value?.type !== 'mask')) return false;
    const got = item.value.config || {};
    return Math.abs((got.height ?? -1) - want.height) < 1e-9
      && Math.abs((got.centerY ?? -1) - want.centerY) < 1e-9
      && item.value.resource_type === presets().layouts[layoutName].subject.maskTemplate.resource_type;
  });
}

/** Does a white-ring overlay cover this segment's span? */
function ringCovers(doc, segment) {
  const ring = presets().layouts.circle.overlay;
  return allSegments(doc).some(({ segment: s }) => {
    if (s.desc !== `layout:${ring.role}`) {
      const mat = (doc.materials?.videos || []).find(m => m.id === s.material_id);
      if (!mat || path.basename(mat.path || '') !== ring.asset) return false;
    }
    return s.target_timerange.start === segment.target_timerange.start
      && s.target_timerange.duration === segment.target_timerange.duration;
  });
}

export function findCircleScenes(doc) {
  return allSegments(doc)
    .filter(({ segment }) => hasLayoutMask(doc, segment, 'circle') && ringCovers(doc, segment))
    .map(({ segment, trackIndex }) => ({ id: segment.id, trackIndex, range: segment.target_timerange }));
}

export function opLayoutBackground(doc, op, context = {}) {
  SEED = op.__seed || null;
  const config = presets();
  const bg = config.background;
  let scenes = op.selector
    ? selectSegments(doc, op.selector).map(e => ({ id: e.segment.id, trackIndex: e.trackIndex, range: e.segment.target_timerange }))
    : findCircleScenes(doc);
  let skipped = 0;
  const preserved = op.includeTemplate ? null : preservedRange(context.projectDir);
  if (preserved && !op.selector) {
    const before = scenes.length;
    scenes = scenes.filter(s => s.range.start < preserved.start);
    skipped = before - scenes.length;
  }
  if (!scenes.length) {
    return {
      changed: 0, scenes: 0, skippedTemplate: skipped,
      note: skipped
        ? `no circle scenes outside the cloned preset (${skipped} skipped; use --include-template to override)`
        : 'no circle scenes with a white ring found'
    };
  }

  const byId = new Map(allSegments(doc).map(e => [e.segment.id, e]));
  // Behind everything except the empty main track. Inserting at the circle's own
  // index dropped the blur ON TOP of the B-roll that the circle is sharing the
  // frame with.
  let bgTrack = doc.tracks.find(t => t.type === 'video' && t.name === 'layout-background');
  if (!bgTrack) {
    bgTrack = insertOverlayTrack(doc, 1, mint('track:layout-background'));
    bgTrack.name = 'layout-background';
  }

  let changed = 0;
  for (const scene of scenes) {
    const entry = byId.get(scene.id);
    if (!entry) continue;
    const subject = entry.segment;
    bgTrack.segments = (bgTrack.segments || []).filter(s =>
      !(s.target_timerange.start === subject.target_timerange.start
        && s.target_timerange.duration === subject.target_timerange.duration));
    const plate = clone(bg.segmentTemplate);
    plate.id = mint(`${subject.id}:bgplate`);
    plate.material_id = subject.material_id;
    plate.target_timerange = clone(subject.target_timerange);
    plate.source_timerange = clone(subject.source_timerange || { start: 0, duration: subject.target_timerange.duration });
    plate.clip = clone(bg.clip);
    plate.render_index = Math.max(0, (subject.render_index || 0) - 1);
    plate.desc = 'layout:background-blur';
    plate.volume = 0;
    plate.enable_video_mask = false;
    const effect = clone(bg.effect);
    effect.id = mint(`${subject.id}:blur`);
    if ('bind_segment_id' in effect) effect.bind_segment_id = plate.id;
    ensureMaterialArray(doc, 'video_effects').push(effect);
    plate.extra_material_refs = [effect.id];
    bgTrack.segments.push(plate);
    changed++;
  }
  bgTrack.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  renumberTracks(doc);
  return { changed, scenes: scenes.length, skippedTemplate: skipped, track: doc.tracks.indexOf(bgTrack) };
}


/** The active-timeline document, which is what CapCut actually plays. */
function activeDoc(projectDir) {
  const state = loadProject(projectDir);
  const group = state.groups.find(g => g.name.startsWith('timeline:')) || state.groups[0];
  return group.doc;
}

const round3 = v => Math.round(v * 1000) / 1000;

/**
 * Transcript caches are keyed by the source file that was transcribed, not necessarily by
 * the path CapCut currently stores. `localize` deliberately changes that path, and rl2 also
 * gives every take the same `screen.mp4` basename, so basename-only lookup is not enough.
 *
 * The sidecar names below are intentionally additive. Older projects have no map, while
 * newer callers may persist one of these small maps beside the draft. Material-level fields
 * are checked first because they survive a project copy without another file being present.
 */
const ORIGINAL_PATH_KEYS = [
  'original_path', 'originalPath', 'original_source', 'originalSource',
  'source_path', 'sourcePath', 'source_file', 'sourceFile', 'origin_path', 'originPath',
  'media_path', 'mediaPath', 'file_path', 'filePath', 'file_Path'
];
const TRANSCRIPT_PATH_KEYS = [
  'transcript_path', 'transcriptPath', 'whisper_path', 'whisperPath',
  'transcript_file', 'transcriptFile', 'cache_path', 'cachePath'
];
const SOURCE_MAP_FILES = [
  path.join('.capcutctl', 'media-map.json'),
  path.join('.capcutctl', 'media_map.json'),
  path.join('.capcutctl', 'media-sources.json'),
  path.join('.capcutctl', 'media_sources.json'),
  path.join('.capcutctl', 'source-map.json'),
  path.join('.capcutctl', 'source_map.json'),
  path.join('.capcutctl', 'sources.json'),
  path.join('.capcutctl', 'created.json')
];

function pathValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPathLike(value) {
  return Boolean(pathValue(value))
    && (value.includes('/') || value.includes('\\') || /\.[a-z0-9]{2,8}$/i.test(value));
}

function absolutePath(value, base) {
  const raw = pathValue(value);
  if (!raw) return null;
  const expanded = expand(raw);
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded));
}

function pushUnique(list, value, base) {
  const resolved = absolutePath(value, base);
  if (resolved && !list.includes(resolved)) list.push(resolved);
}

/** Read known optional maps without making a malformed map break `scenes`. */
function sourceMaps(projectDir) {
  const maps = [];
  for (const relative of SOURCE_MAP_FILES) {
    const file = path.join(projectDir || '.', relative);
    if (!fs.existsSync(file)) continue;
    try { maps.push(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* fall back below */ }
  }
  return maps;
}

/**
 * Extract original paths from both direct `{localized: original}` maps and record-shaped
 * maps such as `{id, localizedPath, originalPath}`. The walk is deliberately conservative:
 * arbitrary strings are not treated as paths unless they are attached to a matching key/id.
 */
function mappedSourcePaths(maps, material, localizedPath, base) {
  const out = [];
  const wanted = new Set([
    pathValue(material?.id), pathValue(localizedPath), path.basename(localizedPath || ''),
    material?.material_name, material?.name
  ].filter(Boolean));
  const idKeys = new Set(['id', 'material_id', 'materialId', 'localized_id', 'localizedId']);
  const localKeys = new Set([
    'localized', 'localized_path', 'localizedPath', 'destination', 'destination_path',
    'destinationPath', 'dest', 'to', 'path', 'local_path', 'localPath'
  ]);
  const originalKeys = new Set(ORIGINAL_PATH_KEYS.concat(['original', 'source', 'from']));

  const visit = (node, keyHint = null) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyHint);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const keyMatches = keyHint != null && wanted.has(String(keyHint));
    const idMatches = [...idKeys].some(key => wanted.has(String(node[key] ?? '')));
    const localMatches = [...localKeys].some(key => {
      const value = pathValue(node[key]);
      return value && (value === localizedPath || path.normalize(value) === path.normalize(localizedPath || '')
        || path.basename(value) === path.basename(localizedPath || ''));
    });
    const recordMatches = keyMatches || idMatches || localMatches;

    if (recordMatches) {
      for (const key of originalKeys) {
        const value = node[key];
        if (isPathLike(value)) pushUnique(out, value, base);
        else if (value && typeof value === 'object') {
          for (const nested of ORIGINAL_PATH_KEYS) if (isPathLike(value[nested])) pushUnique(out, value[nested], base);
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      // Direct maps use the localized path/material id as the object key.
      if (wanted.has(key) && isPathLike(value)) pushUnique(out, value, base);
      visit(value, key);
    }
  };

  for (const map of maps) visit(map);
  return out.filter(candidate => path.normalize(candidate) !== path.normalize(localizedPath || ''));
}

function materialSourcePaths(material, mediaPath, projectDir) {
  const base = projectDir || process.cwd();
  const out = [];
  for (const key of ORIGINAL_PATH_KEYS) {
    const value = material?.[key];
    if (isPathLike(value)) pushUnique(out, value, base);
    else if (value && typeof value === 'object') {
      for (const nested of ORIGINAL_PATH_KEYS) if (isPathLike(value[nested])) pushUnique(out, value[nested], base);
    }
  }
  if (mediaPath) pushUnique(out, mediaPath, base);
  return out;
}

function transcriptStems(sourcePaths) {
  const stems = [];
  const add = value => {
    const stem = path.basename(value || '').replace(/\.[^.]+$/, '');
    if (!stem) return;
    for (const candidate of [stem, stem.includes('__') ? stem.split('__').at(-1) : null,
      stem.includes('-') ? stem.split('-')[0] : null]) {
      if (candidate && !stems.includes(candidate)) stems.push(candidate);
    }
  };
  for (const source of sourcePaths) add(source);
  return stems;
}

function transcriptFileInDirectory(directory, stems) {
  if (!directory || !fs.existsSync(directory)) return null;
  let names;
  try { names = fs.readdirSync(directory).sort(); } catch { return null; }
  for (const stem of stems) {
    const whisper = names.find(name => name.startsWith(`${stem}.whisper`));
    if (whisper) return path.join(directory, whisper);
    const legacy = names.find(name => name === `${stem}_transcript_ar.json`);
    if (legacy) return path.join(directory, legacy);
  }
  return null;
}

function transcriptCandidates(mediaPath, projectDir, material) {
  const base = projectDir || process.cwd();
  const sources = materialSourcePaths(material, mediaPath, base);
  const mapped = mappedSourcePaths(sourceMaps(projectDir), material, mediaPath, base);
  for (const source of mapped.reverse()) sources.unshift(source);

  const direct = [];
  for (const key of TRANSCRIPT_PATH_KEYS) {
    const value = material?.[key];
    if (isPathLike(value)) pushUnique(direct, value, base);
  }

  const directories = [];
  const addDirectory = directory => {
    if (!directory) return;
    const resolved = path.normalize(directory);
    if (!directories.includes(resolved)) directories.push(resolved);
  };
  const envCache = process.env.CAPCUTCTL_VIDEO_INDEX || process.env.VIDEO_INDEX_DIR;
  if (envCache) addDirectory(expand(envCache));
  for (const source of sources) {
    const dir = path.dirname(source);
    addDirectory(path.join(dir, '.video-index'));
    addDirectory(path.join(dir, '.cache', 'video-index'));
    addDirectory(dir); // supports a transcript saved beside the source
  }
  addDirectory(path.join(base, '.capcutctl', '.video-index'));
  addDirectory(path.join(base, '.video-index'));
  // Keep the historical cache as the last fallback. It is useful for old projects, but must
  // not be the only place we look after a source has been localized from elsewhere.
  addDirectory(path.join(os.homedir(), 'Downloads', '.video-index'));

  const stems = transcriptStems(sources);
  const files = [...direct.filter(file => fs.existsSync(file))];
  for (const directory of directories) {
    const file = transcriptFileInDirectory(directory, stems);
    if (file && !files.includes(file)) files.push(file);
  }
  return { files, sources, directories, stems };
}

function transcriptPayloadSegments(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.segments || payload?.transcript?.segments || payload?.result?.segments || [];
}

function normalizeTranscriptSegments(payload) {
  return transcriptPayloadSegments(payload).map(segment => {
    const start = Number(segment?.start);
    const end = Number(segment?.end ?? (Number(segment?.duration) + start));
    const text = String(segment?.text ?? segment?.transcript ?? '').trim();
    return { start, end, text };
  }).filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end)
    && segment.end >= segment.start && segment.text);
}

/**
 * Resolve a transcript for a CapCut material. The returned status is part of the public
 * read API so callers can distinguish "no words overlap this clip" from "no cache was found".
 */
export function resolveTranscript(mediaPath, projectDir = null, material = null) {
  if (!mediaPath) {
    return {
      status: 'missing', segments: [], source: null, path: null,
      note: 'No transcript cache: the video material has no source path.'
    };
  }
  const lookup = transcriptCandidates(mediaPath, projectDir, material);
  if (!lookup.files.length) {
    const source = lookup.sources[0] || mediaPath;
    const where = lookup.directories.length ? ` Searched: ${lookup.directories.join(', ')}.` : '';
    return {
      status: 'missing', segments: [], source, path: null,
      note: `No transcript cache found for ${path.basename(source)}.${where}`
    };
  }
  let invalid = null;
  let empty = null;
  for (const file of lookup.files) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      invalid ||= {
        status: 'invalid', segments: [], source: lookup.sources[0] || mediaPath, path: file,
        note: `Transcript cache ${file} could not be read: ${error.message}`
      };
      continue;
    }
    const segments = normalizeTranscriptSegments(payload);
    if (segments.length) {
      return { status: 'resolved', segments, source: lookup.sources[0] || mediaPath, path: file, note: null };
    }
    empty ||= {
      status: 'empty', segments, source: lookup.sources[0] || mediaPath, path: file,
      note: `Transcript cache ${file} contains no usable segments.`
    };
  }
  return invalid || empty || {
    status: 'missing', segments: [], source: lookup.sources[0] || mediaPath, path: null,
    note: `No usable transcript cache found for ${path.basename(mediaPath)}.`
  };
}

/** Human-readable scene list, so you can pick what to restyle without opening CapCut. */
/** Join each scene to what is being said over it. */

export function describeScenes(projectDir, trackFilter = null, withTranscript = false) {
  const doc = activeDoc(projectDir);
  const config = presets();
  const mats = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const rows = [];
  for (const { segment, trackIndex, track } of allSegments(doc)) {
    if (track.type !== 'video') continue;
    if (trackFilter != null && trackIndex !== trackFilter) continue;
    const t = segment.target_timerange;
    const sr = segment.source_timerange;
    let style = 'plain';
    for (const name of Object.keys(config.layouts)) if (hasLayoutMask(doc, segment, name)) style = name;
    // overlay plates (seam-bar / white-ring / background-blur) are named by their role
    const role = (segment.desc || '').startsWith('layout:') ? segment.desc.slice(7) : null;
    if (role && !config.layouts[role]) style = role;
    const mat = mats.get(segment.material_id);
    rows.push({
      id: segment.id,
      track: trackIndex,
      start: round3(t.start / 1e6),
      end: round3((t.start + t.duration) / 1e6),
      style,
      scale: segment.clip?.scale?.x,
      transformY: segment.clip?.transform?.y,
      desc: segment.desc || null,
      media: mat?.path ? path.basename(mat.path) : null,
      source: sr ? [round3(sr.start / 1e6), round3((sr.start + sr.duration) / 1e6)] : null
    });
  }
  if (withTranscript) {
    const byMedia = new Map();
    for (const { segment, track } of allSegments(doc)) {
      if (track.type !== 'video') continue;
      const mat = mats.get(segment.material_id);
      const row = rows.find(r => r.id === segment.id);
      if (!row) continue;
      if (mat?.type === 'photo') {
        row.transcriptStatus = 'not-applicable';
        row.transcriptNote = 'Photo/plate material has no spoken transcript.';
        continue;
      }
      const key = `${mat?.id || ''}:${mat?.path || ''}`;
      if (!byMedia.has(key)) byMedia.set(key, resolveTranscript(mat?.path, projectDir, mat));
      const resolved = byMedia.get(key);
      row.says = null;
      row.transcriptStatus = resolved.status;
      row.transcriptNote = resolved.note;
      if (resolved.path) row.transcriptPath = resolved.path;
      if (resolved.source) row.transcriptSource = resolved.source;
      if (resolved.status !== 'resolved' && resolved.note) row.note = resolved.note;
      if (resolved.status === 'missing' || resolved.status === 'invalid') continue;
      const segs = resolved.segments;
      const sr = segment.source_timerange || { start: 0, duration: 0 };
      const a = sr.start / 1e6, b = (sr.start + sr.duration) / 1e6;
      row.says = segs.filter(x => x.start < b && x.end > a).map(x => x.text.trim()).join(' ').trim() || null;
    }
  }
  return rows.sort((a, b) => a.start - b.start || a.track - b.track);
}

/**
 * Turn `layout <name> --segments|--at` into a normal v1 spec, so layouts ride the
 * same transaction, snapshot, mirror-sync and doctor path as every other edit.
 */
/** Resolve --segments / --at into concrete segment ids, refusing to guess. */
function resolveIds(projectDir, opts = {}, required = true) {
  const doc = activeDoc(projectDir);
  const ids = [...(opts.segments || [])];
  for (const seconds of opts.at || []) {
    const us = Math.round(seconds * 1e6);
    const hits = allSegments(doc).filter(({ segment, track, trackIndex }) =>
      track.type === 'video'
      && (opts.track == null || trackIndex === opts.track)
      && segment.target_timerange.start <= us
      && us < segment.target_timerange.start + segment.target_timerange.duration);
    if (!hits.length) {
      throw new CapcutError(`No video segment covers ${seconds}s${opts.track == null ? '' : ` on track ${opts.track}`}.`,
        { code: 'SELECTOR_EMPTY', exitCode: 2 });
    }
    if (hits.length > 1 && opts.track == null) {
      throw new CapcutError(
        `${hits.length} segments cover ${seconds}s (tracks ${hits.map(h => h.trackIndex).join(', ')}). Re-run with --track N.`,
        { code: 'SELECTOR_AMBIGUOUS', exitCode: 2 }
      );
    }
    ids.push(hits[0].segment.id);
  }
  if (required && !ids.length) {
    throw new CapcutError('layout requires --segments ID[,ID] or --at SECONDS[,SECONDS].', { exitCode: 2 });
  }
  const known = new Set(allSegments(doc).map(e => e.segment.id));
  for (const id of ids) if (!known.has(id)) throw new CapcutError(`Segment ${id} is not in this project.`, { code: 'SELECTOR_EMPTY', exitCode: 2 });
  return ids;
}

/**
 * Turn `layout <name> --segments|--at` into a normal v1 spec, so layouts ride the
 * same transaction, snapshot, mirror-sync and doctor path as every other edit.
 */
/**
 * Place a B-roll clip in the TOP half of a split screen, framed on a chosen source row.
 *
 *   displayed height = 1920 * s / fitK ... in canvas terms the clip is (sw,sh) fitted then
 *   scaled, so a source row R lands at canvas y = clipTop + R*k0*s. Solving for the row to
 *   sit at the centre of the top half (y=480) gives the transform; the mask line that cuts
 *   the clip at y=960 then falls out as centreY = -ty/s.
 *
 * The window is clamped inside the frame: a window running off the top or bottom leaves
 * blank canvas behind the B-roll, which is the one thing the look must never have.
 */
export function brollFocus({ sourceWidth, sourceHeight, row, scale, explicitFraming = false, canvas = [1080, 1920] }) {
  const [W, H] = canvas.map(Number);
  const sw = Number(sourceWidth), sh = Number(sourceHeight), requestedRow = Number(row);
  if (!(W > 0 && H > 0 && sw > 0 && sh > 0)) {
    throw new CapcutError('layout.broll: source and canvas dimensions must be positive.', { code: 'BAD_DIMENSIONS', exitCode: 2 });
  }
  if (!Number.isFinite(requestedRow)) {
    throw new CapcutError('layout.broll: --row must be a finite source-pixel row.', { code: 'BAD_ROW', exitCode: 2 });
  }
  const k0 = Math.min(W / sw, H / sh);
  const fillScale = (W / sw) / k0;                       // scale at which the clip is exactly canvas-wide
  // a hand-typed fill scale is usually a rounding hair under the exact one; snap it up
  // rather than refuse, and only complain when the clip would genuinely show background.
  const scaleWasExplicit = scale != null || explicitFraming === true;
  let s = scale == null ? fillScale : Number(scale);
  if (!(s > 0) || !Number.isFinite(s)) {
    throw new CapcutError('layout.broll: --scale must be a finite positive number.', { code: 'BAD_SCALE', exitCode: 2 });
  }
  let snapped = false;
  if (s < fillScale) {
    if (s > fillScale * 0.99) { s = fillScale; snapped = true; }
    else {
      throw new CapcutError(
        `scale ${s.toFixed(5)} leaves the clip ${(sourceWidth * k0 * s).toFixed(0)}px wide on a ${W}px canvas — `
        + `that is blank background either side. Minimum is ${fillScale.toFixed(5)}.`,
        { code: 'BROLL_TOO_SMALL', exitCode: 2 });
    }
  }
  // A landscape/window capture fitted to the canvas width is shorter than the 960px
  // upper split-screen half. Automatically inventing a crop here is what made `layout
  // broll` silently produce a short floating rectangle. `layout screen` owns the measured
  // window treatment; callers that intentionally choose a crop may opt into explicit framing.
  const displayedHeight = sh * k0 * s;
  if (!scaleWasExplicit && displayedHeight < H / 2 - 1e-6) {
    throw new CapcutError(
      `layout broll: ${sw}x${sh} landscape/window capture cannot fill the tall-source `
      + `framing automatically; use layout screen for screen recordings or pass an explicit `
      + 'framing/--scale.',
      { code: 'BROLL_NEEDS_SCREEN_LAYOUT', exitCode: 2 }
    );
  }
  const visibleRows = (H / 2) / (k0 * s);
  const clamped = Math.max(visibleRows / 2, Math.min(sh - visibleRows / 2, requestedRow));
  // Half the clip's ON-CANVAS height. This used to be written `(H / 2) * s`, which is the same
  // number ONLY while k0 === H / sh — i.e. only for sources taller than the canvas aspect, which
  // is every phone capture this was built on. A source that is WIDER than the canvas aspect takes
  // k0 = W / sw, and the shorthand then placed the clip dead-centre (ty = 0) instead of in the top
  // half: a 1080x960 B-roll rendered with 480px of black above it and its bottom 480px buried
  // under the talking head. `doctor` cannot see that; only a composited frame shows it.
  const halfDisplayedHeight = (sh / 2) * k0 * s;
  const ty = ((H / 4) - halfDisplayedHeight + clamped * k0 * s) / (H / 2);
  // Seam offset in half-CLIP units (y up), carrying the same generalisation.
  const maskCenterY = -(ty * (H / 2)) / halfDisplayedHeight;
  return {
    clip: { scale: { x: s, y: s }, transform: { x: 0, y: round6(ty) }, rotation: 0,
            flip: { horizontal: false, vertical: false }, alpha: 1 },
    mask: { width: 0.28, height: 0, centerX: 0, centerY: round6(maskCenterY), rotation: 0,
            feather: 0, expansion: 0, roundCorner: 0, invert: false, aspectRatio: 1 },
    scale: s, snapped, row: clamped, clamped: Math.abs(clamped - requestedRow) > 0.5,
    window: [Math.round(clamped - visibleRows / 2), Math.round(clamped + visibleRows / 2)],
  };
}
const round6 = v => Math.round(v * 1e6) / 1e6;

/** Frame an existing B-roll segment on a source row, and cut it at the seam. */
export function opLayoutBroll(doc, op) {
  SEED = op.__seed || null;
  const found = selectSegments(doc, op.selector || {});
  if (!found.length) throw new CapcutError(`layout.broll: no segment matched ${JSON.stringify(op.selector)}.`, { code: 'SELECTOR_EMPTY' });
  const targets = op.all ? found : found.slice(0, 1);
  const explicitScale = op.scale ?? op.framing?.scale;
  const explicitFraming = explicitScale != null || op.explicitFraming === true
    || op.framing === true || op.crop != null || op.frame != null;
  // Compute every frame before mutating any segment. A multi-selection that contains one
  // landscape capture must fail as a whole, not leave the earlier targets half-applied.
  const plans = targets.map(entry => {
    const seg = entry.segment;
    const mat = (doc.materials?.videos || []).find(m => m.id === seg.material_id);
    if (!mat?.width || !mat?.height) throw new CapcutError(`layout.broll: material for ${seg.id} has no dimensions.`, { code: 'MISSING_MATERIAL_SOURCE' });
    const cc = doc.canvas_config || {};
    const g = brollFocus({ sourceWidth: mat.width, sourceHeight: mat.height,
                           row: op.row, scale: explicitScale, explicitFraming,
                           canvas: [cc.width || 1080, cc.height || 1920] });
    return { entry, seg, mat, g };
  });
  const out = [];
  for (const { seg, g } of plans) {
    seg.clip = clone(g.clip);
    seg.uniform_scale = { on: true, value: 1.0 };
    if (op.seam === false) { seg.enable_video_mask = false; }
    else applyMask(doc, seg, presets().layouts['split-screen'].subject.maskTemplate, g.mask);
    out.push({ id: seg.id, scale: g.scale, row: g.row, window: g.window, clamped: g.clamped });
  }
  return { changed: out.length, framed: out };
}

export const SCREEN_LAYOUT_OPERATION = 'layout.screen';
const SCREEN_LAYOUT_ROLES = new Set([
  'layout:screen-frame', 'layout:screen-pip', 'layout:screen-pip-ring', 'layout:screen-blur'
]);
const SCREEN_RECORDING_DESC = 'layout:screen-recording';

function screenLayerOwner(segment) {
  return segment?.screen_recording_id || segment?.screenRecordingId || segment?.layout_owner_id || null;
}

/** Recognise an existing RL2/window capture without trusting an arbitrary video selector. */
export function isScreenRecordingSegment(doc, value) {
  const segment = value?.segment || value;
  if (!segment || typeof segment !== 'object') return false;
  const material = (doc.materials?.videos || []).find(item => item.id === segment.material_id);
  const desc = String(segment.desc || '').trim().toLowerCase();
  if (desc === SCREEN_RECORDING_DESC || segment.screen_recording === true || segment.screenRecording === true
      || segment.layout_role === 'screen-recording' || segment.layoutRole === 'screen-recording') return true;
  if (/screen[ _-]*(recording|capture)/i.test(desc) || /raw[ _-]*(window|screen)[ _-]*capture/i.test(desc)) return true;
  // A filename and dimensions are not an identity: an ordinary 720x1050 clip can have
  // `screen.mp4` as its name. Callers must carry an explicit screen marker instead of making
  // an arbitrary video selector eligible for this layout.
  return Boolean(segment.source_take_id && material?.source_take_id
    && segment.source_take_id === material.source_take_id
    && (segment.screen_recording_id || segment.screenRecordingId));
}

function assertScreenRecordingEntry(doc, entry) {
  if (entry.track?.type !== 'video') {
    throw new CapcutError(`layout.screen: selected segment ${entry.segment?.id || '<unknown>'} is not video footage.`,
      { code: 'NOT_SCREEN_RECORDING', exitCode: 2 });
  }
  if (entry.track.flag === 0) {
    throw new CapcutError('layout.screen: the main/cover track stays empty; select an overlay recording.',
      { code: 'MAIN_TRACK', exitCode: 2 });
  }
  if (!isScreenRecordingSegment(doc, entry)) {
    throw new CapcutError(
      `layout.screen: selector matched ${entry.segment?.id || '<unknown>'}, but it is not an existing screen recording. `
      + 'Select a layout:screen-recording segment or pass media/at/duration to create one.',
      { code: 'NOT_SCREEN_RECORDING', exitCode: 2 });
  }
}

function selectorValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return { id: String(value) };
  if (!value || typeof value !== 'object') return null;
  const selector = clone(value);
  if (selector.trackIndex != null) selector.trackIndex = Number(selector.trackIndex);
  return selector;
}

function sameRange(a, b) {
  return a?.start === b?.start && a?.duration === b?.duration;
}

function rangesOverlap(a, b) {
  return Boolean(a && b && a.start < b.start + b.duration && b.start < a.start + a.duration);
}

function removeScreenLayersAt(doc, span, recordingId) {
  const removed = [];
  const competing = new Set(allSegments(doc)
    .filter(({ segment }) => isScreenRecordingSegment(doc, segment)
      && segment.id !== recordingId && sameRange(segment.target_timerange, span))
    .map(({ segment }) => segment.id));
  // Old screen layers predate the owner marker. They are safe to clean only when there is no
  // same-range second recording; with two targets, leaving an unowned legacy layer is safer
  // than deleting the other recording's treatment.
  const removeLegacy = competing.size === 0;
  for (const track of doc.tracks || []) {
    if (track.type !== 'video') continue;
    const keep = [];
    for (const segment of track.segments || []) {
      const owner = screenLayerOwner(segment);
      const ownedByTarget = owner != null && String(owner) === String(recordingId);
      const legacyForTarget = owner == null && removeLegacy && sameRange(segment.target_timerange, span);
      if (SCREEN_LAYOUT_ROLES.has(segment.desc) && (ownedByTarget || legacyForTarget)) removed.push(segment);
      else keep.push(segment);
    }
    track.segments = keep;
  }

  // Pip masks and blur effects are generated by this operation. Remove only the generated
  // records that no remaining segment references; shared native materials stay untouched.
  const removedRefs = new Set(removed.flatMap(segment => segment.extra_material_refs || []));
  const usedRefs = new Set(allSegments(doc).flatMap(({ segment }) => segment.extra_material_refs || []));
  for (const kind of ['common_mask', 'video_effects']) {
    if (!Array.isArray(doc.materials?.[kind])) continue;
    doc.materials[kind] = doc.materials[kind].filter(material =>
      !removedRefs.has(material.id) || usedRefs.has(material.id));
  }
  return removed;
}

/** Find or create a dedicated screen-layout lane and repair its z-order before reuse. */
function screenTrack(doc, name, recordingTrack, before = false, span = null, ownerId = null) {
  const role = name.match(/^layout-screen-(background|frame|pip|pip-ring)(?:--.*)?$/)?.[1] || null;
  const expectedDesc = role ? `layout:screen-${role === 'background' ? 'blur' : role}` : null;
  const safeName = ownerId ? `${name}--${safeArtifactName(ownerId)}` : name;
  const hasForeignSameRange = track => span && (track.segments || []).some(segment =>
    expectedDesc && segment.desc === expectedDesc && sameRange(segment.target_timerange, span)
    && String(screenLayerOwner(segment) || '') !== String(ownerId || ''));
  let named = (doc.tracks || []).find(track => track.name === name);
  if (named && hasForeignSameRange(named)) named = null;
  if (!named && safeName !== name) named = (doc.tracks || []).find(track => track.name === safeName);
  if (named) {
    if (named.type !== 'video') {
      throw new CapcutError(`layout.screen: generated lane "${name}" is not a video track.`,
        { code: 'UNSAFE_SCREEN_LANE', exitCode: 2 });
    }
    if (named.flag === 0) {
      throw new CapcutError(`layout.screen: generated lane "${name}" is the main/cover track.`,
        { code: 'MAIN_TRACK', exitCode: 2 });
    }
    if (named.flag !== 2) {
      throw new CapcutError(`layout.screen: generated lane "${name}" is not an overlay track (flag=${named.flag}).`,
        { code: 'UNSAFE_SCREEN_LANE', exitCode: 2 });
    }
    if (named === recordingTrack) {
      throw new CapcutError(`layout.screen: generated lane "${name}" aliases the recording track.`,
        { code: 'UNSAFE_SCREEN_LANE', exitCode: 2 });
    }
    if (expectedDesc && (named.segments || []).some(segment => segment.desc !== expectedDesc)) {
      throw new CapcutError(`layout.screen: generated lane "${named.name}" contains foreign footage.`,
        { code: 'UNSAFE_SCREEN_LANE', exitCode: 2 });
    }
    const current = doc.tracks.indexOf(named);
    const anchor = doc.tracks.indexOf(recordingTrack);
    if (anchor < 1 || current < 0) {
      throw new CapcutError('layout.screen: recording/lane order is invalid.', { code: 'UNSAFE_SCREEN_LANE', exitCode: 2 });
    }
    doc.tracks.splice(current, 1);
    const anchorAfter = doc.tracks.indexOf(recordingTrack);
    const desired = Math.max(1, Math.min(doc.tracks.length, anchorAfter + (before ? 0 : 1)));
    doc.tracks.splice(desired, 0, named);
    renumberTracks(doc);
    return { track: named, index: doc.tracks.indexOf(named), created: false, repaired: current !== desired };
  }
  const recordingIndex = doc.tracks.indexOf(recordingTrack);
  if (recordingIndex < 1 || recordingTrack.flag === 0) {
    throw new CapcutError('layout.screen: the recording must be on an overlay track; the main/cover track stays empty.',
      { code: 'MAIN_TRACK', exitCode: 2 });
  }
  const at = Math.max(1, recordingIndex + (before ? 0 : 1));
  const track = insertOverlayTrack(doc, at, mint(`screen:track:${safeName}`));
  track.name = safeName;
  return { track, index: doc.tracks.indexOf(track), created: true, repaired: false };
}

function screenPipSelector(op) {
  return selectorValue(op.pipSelector || op.pipSegmentId);
}

function resolveScreenPip(doc, recording, op) {
  const selector = screenPipSelector(op);
  if (selector) {
    const found = selectSegments(doc, selector).filter(entry => entry.segment.id !== recording.id);
    if (!found.length) {
      throw new CapcutError(`layout.screen: no circle-pip source matched ${JSON.stringify(selector)}.`,
        { code: 'PIP_SELECTOR_EMPTY', exitCode: 2 });
    }
    if (found.length > 1 && op.allPips !== true) {
      throw new CapcutError(`layout.screen: pip selector matched ${found.length} segments; use a unique id or "allPips": true.`,
        { code: 'PIP_SELECTOR_AMBIGUOUS', exitCode: 2 });
    }
    return found[0];
  }

  let principal;
  try {
    principal = principalTrack(doc, op.pipTrack == null ? null : Number(op.pipTrack));
  } catch (error) {
    throw new CapcutError(
      `layout.screen: provide pipSelector for the talking-head source (${error.message})`,
      { code: 'PIP_SELECTOR_REQUIRED', exitCode: 2 }
    );
  }
  const candidates = (principal.track.segments || [])
    .filter(segment => segment.id !== recording.id && !SCREEN_LAYOUT_ROLES.has(segment.desc)
      && rangesOverlap(segment.target_timerange, recording.target_timerange))
    .map(segment => ({ segment, track: principal.track, trackIndex: principal.index }))
    .sort((a, b) => {
      const overlap = entry => Math.min(entry.segment.target_timerange.start + entry.segment.target_timerange.duration,
        recording.target_timerange.start + recording.target_timerange.duration)
        - Math.max(entry.segment.target_timerange.start, recording.target_timerange.start);
      return overlap(b) - overlap(a);
    });
  if (!candidates.length) {
    throw new CapcutError(
      'layout.screen: no talking-head segment overlaps the recording; pass pipSelector explicitly.',
      { code: 'PIP_SELECTOR_REQUIRED', exitCode: 2 }
    );
  }
  return candidates[0];
}

function screenTime(value, field, { allowZero = false } = {}) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || (allowZero ? seconds < 0 : seconds <= 0)) {
    throw new CapcutError(`layout.screen: ${field} must be ${allowZero ? 'finite and non-negative' : 'finite and positive'} seconds.`,
      { code: 'BAD_TIME', exitCode: 2 });
  }
  return Math.round(seconds * 1e6);
}

function screenMaterialDuration(value, fallback) {
  if (value == null) return fallback;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new CapcutError('layout.screen: mediaDuration must be finite and positive.', { code: 'BAD_TIME', exitCode: 2 });
  }
  // The CLI probe supplies CapCut-native microseconds. Accept seconds as well for direct API
  // callers, while keeping the operation's target/source fields unambiguously in seconds.
  return Math.round(duration > 100_000 ? duration : duration * 1e6);
}

function screenSegmentTemplate(doc) {
  const segments = (doc.tracks || []).filter(track => track.type === 'video')
    .flatMap(track => track.segments || []);
  if (segments.length) {
    const materialKinds = new Map();
    for (const [kind, values] of Object.entries(doc.materials || {})) {
      if (Array.isArray(values)) for (const material of values) if (material?.id) materialKinds.set(material.id, kind);
    }
    const clean = segment => !(segment.extra_material_refs || [])
      .some(ref => ['common_mask', 'video_effects', 'material_animations', 'filters', 'adjusts', 'effects', 'chromas', 'hsl']
        .includes(materialKinds.get(ref)));
    return segments.find(segment => clean(segment) && segment.enable_video_mask === false)
      || segments.find(clean) || segments[0];
  }
  // A blank project still has a track shell, but no segment to clone. Keep the fallback to the
  // native fields that validateDocument needs; CapCut fills the remaining optional fields in.
  return {
    extra_material_refs: [], enable_video_mask: false, speed: 1, volume: 1,
    render_index: 2, keyframe_refs: [], common_keyframes: [],
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0,
      flip: { horizontal: false, vertical: false }, alpha: 1 }
  };
}

function screenTrackForRecording(doc, trackSpec) {
  const requested = trackSpec == null || trackSpec === '' ? 'screen' : trackSpec;
  const numeric = typeof requested === 'number' || /^\d+$/.test(String(requested));
  if (numeric) {
    const index = Number(requested);
    const track = doc.tracks?.[index];
    if (!track || track.type !== 'video') {
      throw new CapcutError(`layout.screen: no video track at index ${index}.`, { code: 'TRACK_MISSING', exitCode: 2 });
    }
    if (track.flag === 0) {
      throw new CapcutError('layout.screen: the main/cover track stays empty; use an overlay track.',
        { code: 'MAIN_TRACK', exitCode: 2 });
    }
    return { track, index, created: false };
  }
  const name = String(requested);
  const existing = (doc.tracks || []).find(track => track.type === 'video' && track.name === name);
  if (existing) {
    const index = doc.tracks.indexOf(existing);
    if (existing.flag === 0) {
      throw new CapcutError('layout.screen: the main/cover track stays empty; use an overlay track.',
        { code: 'MAIN_TRACK', exitCode: 2 });
    }
    if (existing.flag !== 2 || index < 1) {
      throw new CapcutError(`layout.screen: recording lane "${name}" is not a safe overlay track (flag=${existing.flag}).`,
        { code: 'UNSAFE_SCREEN_LANE', exitCode: 2 });
    }
    if ((existing.segments || []).some(segment => segment.desc !== SCREEN_RECORDING_DESC)) {
      throw new CapcutError(`layout.screen: recording lane "${name}" contains foreign footage.`,
        { code: 'UNSAFE_SCREEN_LANE', exitCode: 2 });
    }
    let principal;
    try { principal = principalTrack(doc).index; } catch { principal = doc.tracks.length; }
    if (index >= principal) {
      doc.tracks.splice(index, 1);
      const at = Math.max(1, Math.min(doc.tracks.length, principal));
      doc.tracks.splice(at, 0, existing);
      renumberTracks(doc);
    }
    return { track: existing, index: doc.tracks.indexOf(existing), created: false };
  }
  let at = 1;
  try { at = principalTrack(doc).index; }
  catch {
    at = (doc.tracks || []).findIndex(track => track.type === 'video' && track.flag === 2);
    if (at < 1) at = 1;
  }
  const track = insertOverlayTrack(doc, at, mint(`screen:recording-track:${name}`));
  track.name = name;
  return { track, index: at, created: true };
}

function ensureScreenMaterial(doc, op, context, screen, sourceStartUs, sourceDurationUs) {
  // Keep the absolute spelling supplied by the caller on the material for transcript/cache
  // diagnostics. Canonicalization is still used by sourceTakeId and the map writer, so symlink
  // aliases cannot create two identities for one take.
  const source = path.resolve(expand(op.media));
  let destination = source;
  if (op.localize !== false && context.projectDir) {
    destination = localizeMedia(context.projectDir, source, undefined, { dryRun: context.dryRun });
  } else if (!context.dryRun && !fs.existsSync(destination)) {
    throw new CapcutError(`layout.screen: media does not exist: ${source}`, { code: 'MISSING_SOURCE', exitCode: 2 });
  }

  let material = (doc.materials?.videos || []).find(item => {
    if (!item?.path) return false;
    const itemPath = canonicalMediaPath(item.path);
    return itemPath === canonicalMediaPath(destination) || itemPath === canonicalMediaPath(source);
  });
  const width = op.width == null ? Number(screen.source.width) : Number(op.width);
  const height = op.height == null ? Number(screen.source.height) : Number(op.height);
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new CapcutError('layout.screen: media width and height must be finite and positive.',
      { code: 'BAD_DIMENSIONS', exitCode: 2 });
  }
  const requestedDuration = screenMaterialDuration(op.mediaDuration, sourceStartUs + sourceDurationUs);
  if (material) {
    if (path.resolve(expand(material.path)) !== path.resolve(destination)) material.path = destination;
    material.source_take_id = sourceTakeId(source);
    material.source_path = source;
    if (path.resolve(destination) !== source) {
      material.original_path = source;
      recordMediaProvenance(context, {
        materialId: material.id,
        originalPath: source,
        localizedPath: destination,
        sourceTakeId: material.source_take_id,
      });
    }
    if (!Number.isFinite(material.duration) || material.duration < requestedDuration) material.duration = requestedDuration;
    if (!material.width) material.width = width;
    if (!material.height) material.height = height;
    if (sourceStartUs + sourceDurationUs > material.duration + 1) {
      throw new CapcutError(`layout.screen: source window ends at ${(sourceStartUs + sourceDurationUs) / 1e6}s, `
        + `beyond media duration ${material.duration / 1e6}s.`, { code: 'SOURCE_AFTER_END', exitCode: 2 });
    }
    return material;
  }

  const template = (doc.materials?.videos || []).find(item => item.type === 'video')
    || { type: 'video', crop_scale: 1 };
  material = clone(template);
  material.id = op.materialId || mint(`screen:material:${path.resolve(destination)}`);
  if ((doc.materials?.videos || []).some(item => item.id === material.id)) {
    throw new CapcutError(`layout.screen: material id ${material.id} already exists.`, { code: 'MATERIAL_ID_CONFLICT', exitCode: 2 });
  }
  material.type = 'video';
  material.path = destination;
  material.material_name = path.basename(destination);
  material.local_material_id = '';
  material.width = width;
  material.height = height;
  material.duration = requestedDuration;
  material.source_take_id = sourceTakeId(source);
  material.source_path = source;
  if (path.resolve(destination) !== source) {
    material.original_path = source;
    recordMediaProvenance(context, {
      materialId: material.id,
      originalPath: source,
      localizedPath: destination,
      sourceTakeId: material.source_take_id,
    });
  }
  ensureMaterialArray(doc, 'videos').push(material);
  return material;
}

function upsertScreenRecording(doc, op, context, screen) {
  if (!op.media) throw new CapcutError('layout.screen requires media or an existing recording selector.',
    { code: 'NO_MEDIA', exitCode: 2 });
  const atUs = screenTime(op.at, '--at', { allowZero: true });
  const durationUs = screenTime(op.duration, '--duration');
  const sourceStartUs = screenTime(op.src == null ? 0 : op.src, '--src', { allowZero: true });
  const sourceDurationUs = screenTime(op.srcDur == null ? op.duration : op.srcDur, '--src-dur');
  const material = ensureScreenMaterial(doc, op, context, screen, sourceStartUs, sourceDurationUs);
  if (sourceStartUs + sourceDurationUs > material.duration + 1) {
    throw new CapcutError(`layout.screen: source window ends at ${(sourceStartUs + sourceDurationUs) / 1e6}s, `
      + `beyond media duration ${(material.duration || 0) / 1e6}s.`, { code: 'SOURCE_AFTER_END', exitCode: 2 });
  }
  const destination = screenTrackForRecording(doc, op.track);
  const existing = (destination.track.segments || []).find(segment =>
    (op.id && segment.id === op.id)
    || (segment.desc === 'layout:screen-recording'
      && segment.material_id === material.id
      && sameRange(segment.target_timerange, { start: atUs, duration: durationUs })));
  if (existing) return { segment: existing, track: destination.track, index: doc.tracks.indexOf(destination.track), created: destination.created };
  const occupied = (destination.track.segments || []).find(segment => rangesOverlap(segment.target_timerange,
    { start: atUs, duration: durationUs }));
  if (occupied) {
    throw new CapcutError(`layout.screen: recording overlaps ${occupied.id} on track "${destination.track.name || destination.track.id}".`,
      { code: 'CLIP_OVERLAP', exitCode: 2 });
  }
  const recording = clone(screenSegmentTemplate(doc));
  recording.id = op.id || mint(`screen:recording:${material.id}:${atUs}:${durationUs}:${sourceStartUs}:${sourceDurationUs}`);
  recording.material_id = material.id;
  recording.target_timerange = { start: atUs, duration: durationUs };
  recording.source_timerange = { start: sourceStartUs, duration: sourceDurationUs };
  recording.clip = { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0,
    flip: { horizontal: false, vertical: false }, alpha: 1 };
  recording.uniform_scale = clone(screen.recording.uniform_scale);
  recording.extra_material_refs = [];
  recording.keyframe_refs = [];
  recording.common_keyframes = [];
  recording.enable_video_mask = false;
  recording.speed = sourceDurationUs / durationUs;
  recording.volume = 0;
  recording.source_take_id = material.source_take_id;
  recording.render_index = Number.isFinite(recording.render_index) ? recording.render_index : 2;
  recording.desc = 'layout:screen-recording';
  destination.track.segments = [...(destination.track.segments || []), recording]
    .sort((a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0));
  doc.duration = Math.max(Number(doc.duration) || 0, atUs + durationUs);
  renumberTracks(doc);
  return { segment: recording, track: destination.track, index: doc.tracks.indexOf(destination.track), created: destination.created };
}

function pipSourceRange(source, target) {
  const sourceRange = source.source_timerange;
  const targetRange = source.target_timerange;
  if (!sourceRange || !targetRange || !(targetRange.duration > 0)) {
    return { start: 0, duration: target.duration };
  }
  const speed = sourceRange.duration / targetRange.duration || 1;
  const offset = Math.max(0, target.start - targetRange.start);
  return {
    start: sourceRange.start + Math.round(offset * speed),
    duration: Math.round(target.duration * speed)
  };
}

function buildScreenPip(doc, recording, source, circle) {
  const pip = clone(source.segment);
  pip.id = mint(`${recording.id}:screen-pip`);
  pip.material_id = source.segment.material_id;
  pip.target_timerange = clone(recording.target_timerange);
  pip.source_timerange = pipSourceRange(source.segment, recording.target_timerange);
  pip.clip = clone(circle.subject.clip);
  pip.uniform_scale = { on: true, value: 1.0 };
  pip.extra_material_refs = [];
  pip.enable_video_mask = false;
  pip.keyframe_refs = [];
  pip.common_keyframes = [];
  pip.volume = 0;
  pip.desc = 'layout:screen-pip';
  pip.screen_recording_id = recording.id;
  pip.render_index = (recording.render_index || 0) + 3;
  applyMask(doc, pip, circle.subject.maskTemplate, circle.subject.mask);
  return pip;
}

function buildScreenBlur(doc, recording, background) {
  const plate = clone(background.segmentTemplate);
  plate.id = mint(`${recording.id}:screen-blur`);
  plate.material_id = recording.material_id;
  plate.target_timerange = clone(recording.target_timerange);
  plate.source_timerange = clone(recording.source_timerange || {
    start: 0, duration: recording.target_timerange.duration
  });
  plate.clip = clone(background.clip);
  plate.render_index = Math.max(0, (recording.render_index || 0) - 1);
  plate.desc = 'layout:screen-blur';
  plate.screen_recording_id = recording.id;
  plate.volume = 0;
  plate.enable_video_mask = false;
  const effect = clone(background.effect);
  effect.id = mint(`${recording.id}:screen-blur-effect`);
  if ('bind_segment_id' in effect) effect.bind_segment_id = plate.id;
  ensureMaterialArray(doc, 'video_effects').push(effect);
  plate.extra_material_refs = [effect.id];
  return { plate, effect };
}

/**
 * Apply the complete screen-recording treatment as one operation.
 *
 * Wiring contract for core/CLI: dispatch operation name `layout.screen` to
 * `opLayoutScreen(doc, op, context)`. A media contract (`media`, `at`, `duration`, optional
 * `src`, `srcDur`, `track`, dimensions and `localize`) creates/reuses the recording clip;
 * `op.selector` (or `op.recordingSelector`) selects an existing one. `op.pipSelector` optionally
 * selects the face source; when omitted, the overlapping principal-track clip is used. The
 * operation keeps the recording clip in place and adds/replaces four deterministic layers:
 * `layout:screen-frame`, `layout:screen-pip`, `layout:screen-pip-ring`, and `layout:screen-blur`.
 */
export function opLayoutScreen(doc, op = {}, context = {}) {
  SEED = op.__seed || null;
  const config = presets();
  const screen = screenRecordingFrame();
  const circle = config.layouts.circle;
  const background = config.background;
  const projectDir = context.projectDir || '.';
  const recordingSelector = selectorValue(op.recordingSelector || op.selector);
  // The CLI contract supplies media/at/duration and asks this operation to create the
  // recording. Direct callers may instead point at a recording already present in the draft;
  // both paths feed the same layer-building transaction below.
  // The origin contract gates this operation FIRST — before the preset assets are resolved.
  // layout.screen is the verb that replaces the ffmpeg crop, so a source that was already
  // cropped to the half-frame defeats its whole purpose; refusing it must not depend on
  // whether an unrelated indigo PNG happens to be on this machine (on CI it is not, and the
  // caller got ASSET_NOT_FOUND instead of the reason they actually needed).
  if (op.media) {
    const canvasConfig = doc.canvas_config || {};
    assertOrigin({
      file: path.resolve(expandHome(String(op.media))),
      width: op.width == null ? Number(screen.source.width) : Number(op.width),
      height: op.height == null ? Number(screen.source.height) : Number(op.height),
      canvas: [canvasConfig.width || 1080, canvasConfig.height || 1920],
      label: 'layout.screen', projectDir: context.projectDir || null,
      generated: op.generated === true, derivedFrom: op.derivedFrom || null,
      derivedOffset: op.derivedOffset, allowEphemeral: op.allowEphemeral === true,
    });
  }
  resolveAsset(doc, screen.frame.asset, projectDir);
  resolveAsset(doc, circle.overlay.asset, projectDir);

  let found;
  if (recordingSelector) found = selectSegments(doc, recordingSelector);
  else if (op.media) {
    const created = upsertScreenRecording(doc, op, context, screen);
    found = [{ segment: created.segment, track: created.track, trackIndex: created.index }];
  } else {
    throw new CapcutError('layout.screen requires media/at/duration or selector (the existing recording clip).',
      { code: 'SELECTOR_EMPTY', exitCode: 2 });
  }
  if (!found.length) {
    throw new CapcutError(`layout.screen: no recording segment matched ${JSON.stringify(recordingSelector)}.`,
      { code: 'SELECTOR_EMPTY', exitCode: 2 });
  }
  for (const entry of found) assertScreenRecordingEntry(doc, entry);
  if (found.length > 1 && op.all !== true) {
    throw new CapcutError(`layout.screen: selector matched ${found.length} recording segments; add "all": true.`,
      { code: 'SELECTOR_AMBIGUOUS', exitCode: 2 });
  }
  const targets = op.all === true ? found : found.slice(0, 1);
  const plans = targets.map(entry => {
    const material = (doc.materials?.videos || []).find(item => item.id === entry.segment.material_id);
    if (!material || material.type === 'photo') {
      throw new CapcutError(`layout.screen: recording ${entry.segment.id} has no video material.`,
        { code: 'MISSING_MATERIAL_SOURCE', exitCode: 2 });
    }
    return { recordingEntry: entry, pipSource: resolveScreenPip(doc, entry.segment, op) };
  });

  const output = [];
  for (const { recordingEntry, pipSource } of plans) {
    const recording = recordingEntry.segment;
    const recordingTrack = recordingEntry.track;
    removeScreenLayersAt(doc, recording.target_timerange, recording.id);

    // The recording itself is the measured 720x1050 window. A screen treatment deliberately
    // removes any stale mask from a previously split/circle-styled B-roll segment.
    removeMask(doc, recording);
    recording.clip = clone(screen.recording.clip);
    recording.uniform_scale = clone(screen.recording.uniform_scale);
    recording.enable_video_mask = false;
    recording.desc = 'layout:screen-recording';
    recording.screen_recording_id = recording.id;

    const backgroundTrack = screenTrack(doc, 'layout-screen-background', recordingTrack, true,
      recording.target_timerange, recording.id);
    const frameTrack = screenTrack(doc, 'layout-screen-frame', recordingTrack, false,
      recording.target_timerange, recording.id);
    const pipTrack = screenTrack(doc, 'layout-screen-pip', frameTrack.track, false,
      recording.target_timerange, recording.id);
    const ringTrack = screenTrack(doc, 'layout-screen-pip-ring', pipTrack.track, false,
      recording.target_timerange, recording.id);

    const frame = buildOverlaySegment(doc, recording, {
      asset: screen.frame.asset,
      role: 'screen-frame',
      clip: screen.frame.clip,
      uniformScale: screen.frame.uniform_scale,
      renderIndexOffset: 1,
      ownerId: recording.id,
      segmentTemplate: config.layouts['split-screen'].overlay.segmentTemplate
    }, projectDir);
    frame.uniform_scale = clone(screen.frame.uniform_scale);
    frame.volume = 0;
    frameTrack.track.segments = (frameTrack.track.segments || []).filter(segment =>
      !(sameRange(segment.target_timerange, recording.target_timerange)
        && String(screenLayerOwner(segment) || '') === String(recording.id)));
    frameTrack.track.segments.push(frame);

    const pip = buildScreenPip(doc, recording, pipSource, circle);
    pipTrack.track.segments = (pipTrack.track.segments || []).filter(segment => segment.desc !== 'layout:screen-pip'
      || !sameRange(segment.target_timerange, recording.target_timerange)
      || String(screenLayerOwner(segment) || '') !== String(recording.id));
    pipTrack.track.segments.push(pip);

    const ring = buildOverlaySegment(doc, recording, {
      asset: circle.overlay.asset,
      role: 'screen-pip-ring',
      clip: circle.overlay.clip,
      mask: circle.overlay.mask,
      maskTemplate: circle.overlay.maskTemplate,
      renderIndexOffset: 2,
      ownerId: recording.id,
      segmentTemplate: circle.overlay.segmentTemplate
    }, projectDir);
    ringTrack.track.segments = (ringTrack.track.segments || []).filter(segment => segment.desc !== 'layout:screen-pip-ring'
      || !sameRange(segment.target_timerange, recording.target_timerange)
      || String(screenLayerOwner(segment) || '') !== String(recording.id));
    ringTrack.track.segments.push(ring);

    const blur = buildScreenBlur(doc, recording, background);
    backgroundTrack.track.segments = (backgroundTrack.track.segments || []).filter(segment => segment.desc !== 'layout:screen-blur'
      || !sameRange(segment.target_timerange, recording.target_timerange)
      || String(screenLayerOwner(segment) || '') !== String(recording.id));
    backgroundTrack.track.segments.push(blur.plate);

    for (const lane of [backgroundTrack, frameTrack, pipTrack, ringTrack]) {
      lane.track.segments.sort((a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0));
    }
    output.push({
      recording: recording.id,
      pip: pip.id,
      frame: frame.id,
      ring: ring.id,
      blur: blur.plate.id,
      tracks: {
        recording: doc.tracks.indexOf(recordingTrack),
        background: doc.tracks.indexOf(backgroundTrack.track),
        frame: doc.tracks.indexOf(frameTrack.track),
        pip: doc.tracks.indexOf(pipTrack.track),
        ring: doc.tracks.indexOf(ringTrack.track)
      }
    });
  }
  renumberTracks(doc);
  return {
    changed: output.length,
    layout: 'screen',
    operation: SCREEN_LAYOUT_OPERATION,
    layers: output
  };
}

export function buildLayoutSpec(projectDir, name, opts = {}) {
  if (name === 'screen') {
    const ids = resolveIds(projectDir, opts, true);
    const pipSelector = selectorValue(opts.pipSelector || opts.pipSegmentId);
    return {
      version: 1,
      name: 'layout-screen',
      operations: ids.map(id => ({
        op: SCREEN_LAYOUT_OPERATION,
        selector: { id },
        ...(pipSelector ? { pipSelector } : {})
      }))
    };
  }
  if (name === 'background') {
    const base = opts.includeTemplate ? { op: 'layout.background', includeTemplate: true } : { op: 'layout.background' };
    const ids = resolveIds(projectDir, opts, false);
    const operations = ids.length ? ids.map(id => ({ ...base, selector: { id } })) : [base];
    return { version: 1, name: 'layout-background', operations };
  }
  if (name === 'broll') {
    if (opts.row == null) throw new CapcutError('layout broll requires --row (the source row to frame on).', { exitCode: 2 });
    const ids = resolveIds(projectDir, opts, true);
    return { version: 1, name: 'layout-broll',
             operations: ids.map(id => ({ op: 'layout.broll', selector: { id },
                                          row: Number(opts.row), scale: opts.scale ? Number(opts.scale) : undefined,
                                          seam: opts.seam })) };
  }
  if (name === 'auto') {
    const doc = activeDoc(projectDir);
    const rows = layoutAudit(doc, opts.track == null ? null : Number(opts.track));
    const changes = rows.filter(r => r.change);
    return { version: 1, name: 'layout-auto',
             operations: changes.map(r => ({ op: 'layout.apply', layout: r.want, selector: { id: r.id } })),
             __audit: rows };
  }
  const config = presets();
  if (!config.layouts[name]) {
    const known = [...new Set([...Object.keys(config.layouts), 'background', 'broll', 'screen', 'auto', 'audit'])];
    throw new CapcutError(`Unknown layout "${name}". Known: ${known.join(', ')}`, { code: 'UNKNOWN_LAYOUT', exitCode: 2 });
  }
  const ids = resolveIds(projectDir, opts, true);
  return {
    version: 1,
    name: `layout-${name}`,
    operations: ids.map(id => ({ op: 'layout.apply', layout: name, selector: { id }, overlay: opts.overlay }))
  };
}
