import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { principalTrack } from './polish.mjs';
import { CapcutError, clone, uuid, allSegments, selectSegments, loadProject } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET_FILE = path.join(HERE, '..', 'presets', 'layouts.json');

/**
 * Root and active timeline are edited as separate documents, so every generated
 * id must be a pure function of (transaction seed, stable key) — never random —
 * or the two documents drift apart. Segment ids are identical across documents,
 * which makes them safe keys.
 */
let SEED = null;
function mint(key) {
  if (!SEED) return uuid();
  const h = crypto.createHash('sha256').update(`${SEED}|${key}`).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

let CACHED = null;
export function presets() {
  if (!CACHED) CACHED = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
  return CACHED;
}

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
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
  const roots = [path.join(projectDir, 'Resources'), ...(presets().assetSearchPaths || []).map(expand)];
  for (const root of roots) {
    const direct = path.join(root, basename);
    if (fs.existsSync(direct)) return direct;
  }
  throw new CapcutError(
    `layout: asset "${basename}" not found. Searched the project's materials and: ${roots.join(', ')}`,
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
    // A layout with no overlay must also take away the one a previous layout left behind,
    // or a full-face shot keeps the seam bar from the split screen it used to be.
    if (!layout.overlay) removeOverlaysOver(doc, entry.trackIndex, subject.target_timerange);

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

/** Drop layout plates on higher tracks that cover exactly this span. */
function removeOverlaysOver(doc, trackIndex, span) {
  for (const [i, track] of doc.tracks.entries()) {
    if (i <= trackIndex || track.type !== 'video') continue;
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
      const masked = (s.extra_material_refs || []).some(r => masks.has(r));
      const want = covers(start, end) ? 'split-screen' : 'full-face';
      const is = masked ? 'split-screen' : 'full-face';
      return { id: s.id, at: Math.round(start / 1000) / 1000, end: Math.round(end / 1000) / 1000,
               brollUnder: covers(start, end), is, want, change: is !== want };
    });
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

/** Time range carried over from the cloned preset (the endcard), if recorded. */
function preservedRange(projectDir) {
  try {
    const file = path.join(projectDir || '.', '.capcutctl', 'created.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).preserved || null;
  } catch { return null; }
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
  const lowest = Math.min(...scenes.map(s => s.trackIndex));
  // The blur plate must render BEHIND the subject: insert directly below it.
  let bgTrack = doc.tracks.find(t => t.type === 'video' && t.name === 'layout-background');
  let bgIndex;
  if (bgTrack) {
    bgIndex = doc.tracks.indexOf(bgTrack);
  } else {
    bgIndex = Math.max(1, lowest);
    bgTrack = insertOverlayTrack(doc, bgIndex, mint('track:layout-background'));
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

/** Human-readable scene list, so you can pick what to restyle without opening CapCut. */
/** Join each scene to what is being said over it. */
function transcriptFor(mediaPath) {
  const cache = path.join(os.homedir(), 'Downloads', '.video-index');
  const stem = path.basename(mediaPath).replace(/\.[^.]+$/, '');
  let file = null;
  try {
    for (const n of fs.readdirSync(cache).sort()) {
      if (n.startsWith(stem) && n.includes('.whisper')) { file = path.join(cache, n); break; }
    }
    if (!file) {
      const legacy = path.join(cache, `${stem.split('-')[0]}_transcript_ar.json`);
      if (fs.existsSync(legacy)) file = legacy;
    }
  } catch { return null; }
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).segments || [];
}

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
      if (!mat?.path || mat.type === 'photo') continue;
      if (!byMedia.has(mat.path)) byMedia.set(mat.path, transcriptFor(mat.path));
      const segs = byMedia.get(mat.path);
      const row = rows.find(r => r.id === segment.id);
      if (!segs || !row) continue;
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
export function brollFocus({ sourceWidth, sourceHeight, row, scale, canvas = [1080, 1920] }) {
  const [W, H] = canvas;
  const k0 = Math.min(W / sourceWidth, H / sourceHeight);
  const fillScale = (W / sourceWidth) / k0;              // scale at which the clip is exactly canvas-wide
  // a hand-typed fill scale is usually a rounding hair under the exact one; snap it up
  // rather than refuse, and only complain when the clip would genuinely show background.
  let s = scale || fillScale;
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
  const visibleRows = (H / 2) / (k0 * s);
  const clamped = Math.max(visibleRows / 2, Math.min(sourceHeight - visibleRows / 2, row));
  const ty = ((H / 4) - (H / 2) * s + clamped * k0 * s) / (H / 2);
  return {
    clip: { scale: { x: s, y: s }, transform: { x: 0, y: round6(ty) }, rotation: 0,
            flip: { horizontal: false, vertical: false }, alpha: 1 },
    mask: { width: 0.28, height: 0, centerX: 0, centerY: round6(-ty / s), rotation: 0,
            feather: 0, expansion: 0, roundCorner: 0, invert: false, aspectRatio: 1 },
    scale: s, snapped, row: clamped, clamped: Math.abs(clamped - row) > 0.5,
    window: [Math.round(clamped - visibleRows / 2), Math.round(clamped + visibleRows / 2)],
  };
}
const round6 = v => Math.round(v * 1e6) / 1e6;

/** Frame an existing B-roll segment on a source row, and cut it at the seam. */
export function opLayoutBroll(doc, op) {
  SEED = op.__seed || null;
  const found = selectSegments(doc, op.selector || {});
  if (!found.length) throw new CapcutError(`layout.broll: no segment matched ${JSON.stringify(op.selector)}.`, { code: 'SELECTOR_EMPTY' });
  const out = [];
  for (const entry of (op.all ? found : found.slice(0, 1))) {
    const seg = entry.segment;
    const mat = (doc.materials?.videos || []).find(m => m.id === seg.material_id);
    if (!mat?.width || !mat?.height) throw new CapcutError(`layout.broll: material for ${seg.id} has no dimensions.`, { code: 'MISSING_MATERIAL_SOURCE' });
    const cc = doc.canvas_config || {};
    const g = brollFocus({ sourceWidth: mat.width, sourceHeight: mat.height,
                           row: op.row, scale: op.scale, canvas: [cc.width || 1080, cc.height || 1920] });
    seg.clip = clone(g.clip);
    seg.uniform_scale = { on: true, value: 1.0 };
    if (op.seam === false) { seg.enable_video_mask = false; }
    else applyMask(doc, seg, presets().layouts['split-screen'].subject.maskTemplate, g.mask);
    out.push({ id: seg.id, scale: g.scale, row: g.row, window: g.window, clamped: g.clamped });
  }
  return { changed: out.length, framed: out };
}

let _core = null;
function require_core() {
  if (!_core) throw new CapcutError('layout auto needs the core loader; call setCoreLoader first.', { exitCode: 1 });
  return _core;
}
export function setCoreLoader(mod) { _core = mod; }

export function buildLayoutSpec(projectDir, name, opts = {}) {
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
    const { loadProject } = require_core();
    const doc = loadProject(projectDir).groups.find(g => g.name === 'root').doc;
    const rows = layoutAudit(doc, opts.track == null ? null : Number(opts.track));
    const changes = rows.filter(r => r.change);
    if (!changes.length) {
      throw new CapcutError('layout auto: every principal clip already has the layout its B-roll implies.',
        { code: 'LAYOUT_ALREADY_CORRECT', exitCode: 0 });
    }
    return { version: 1, name: 'layout-auto',
             operations: changes.map(r => ({ op: 'layout.apply', layout: r.want, selector: { id: r.id } })),
             __audit: rows };
  }
  const config = presets();
  if (!config.layouts[name]) {
    throw new CapcutError(`Unknown layout "${name}". Known: ${Object.keys(config.layouts).join(', ')}, broll, background`, { code: 'UNKNOWN_LAYOUT', exitCode: 2 });
  }
  const ids = resolveIds(projectDir, opts, true);
  return {
    version: 1,
    name: `layout-${name}`,
    operations: ids.map(id => ({ op: 'layout.apply', layout: name, selector: { id }, overlay: opts.overlay }))
  };
}
