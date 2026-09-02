import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  CapcutError, clone, seededId, allSegments, selectSegments, localizeMedia,
  isLocalMedia, isCapCutCachePath, PRESET_PARK_GAP_US, contentEndUs, maxSegmentEndUs,
} from './core.mjs';
import { insertOverlayTrack, renumberTracks, recordMediaProvenance, sourceTakeId } from './layouts.mjs';
import { assertOrigin, stampOrigin } from './origin.mjs';
import { rescaleKeyframes } from './pace.mjs';
import { principalTrack } from './polish.mjs';

const US = s => Math.round(s * 1e6);
const S = us => us / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;

// Extras a newly placed clip must NEVER inherit from the segment it is modelled on.
// `transitions` belongs here: a transition is a property of the ORIGINAL cut, not of the clip.
// Cloning one onto a fresh B-roll clip puts it at the end of an overlay with no clip after it,
// which CapCut silently drops on load and `doctor` rejects as TRANSITION_ORPHANED — every `add`
// against a project that had already been polished rolled back. `polish` owns transitions; it
// clears and rebuilds them all on the finish pass, so there is nothing to preserve here.
const LOOK_KINDS = new Set([
  'common_mask', 'video_effects', 'material_animations',
  'filters', 'adjusts', 'effects', 'chromas', 'hsl', 'transitions'
]);

let SEED = null;
const mint = key => seededId(SEED, key);

function pickSegmentTemplate(doc) {
  const all = (doc.tracks || []).filter(t => t.type === 'video').flatMap(t => t.segments || []);
  if (!all.length) throw new CapcutError('clip.add: project has no video segment to model on.', { code: 'NO_TEMPLATE', exitCode: 2 });
  const kind = new Map();
  for (const [k, v] of Object.entries(doc.materials || {})) {
    if (Array.isArray(v)) for (const m of v) if (m?.id) kind.set(m.id, k);
  }
  const clean = s => !(s.extra_material_refs || []).some(r => LOOK_KINDS.has(kind.get(r)));
  const plain = s => s.enable_video_mask === false && s.clip?.scale?.x === 1 && !s.clip?.transform?.x && !s.clip?.transform?.y;
  return all.find(s => plain(s) && clean(s)) || all.find(clean) || all[0];
}

function cloneExtras(doc, template, segmentId) {
  const kind = new Map();
  for (const [k, v] of Object.entries(doc.materials || {})) {
    if (Array.isArray(v)) for (const m of v) if (m?.id) kind.set(m.id, k);
  }
  const refs = [];
  // Key the minted id by the SOURCE ref, not just its kind: a template segment carrying two
  // extras of the same kind (two canvases, say) otherwise minted the same id twice and the
  // whole transaction died on CONFLICTING_MATERIAL_ID.
  for (const [i, ref] of (template.extra_material_refs || []).entries()) {
    const k = kind.get(ref);
    if (!k || LOOK_KINDS.has(k)) continue;
    const found = (doc.materials[k] || []).find(m => m.id === ref);
    if (!found) continue;
    const copied = clone(found);
    copied.id = mint(`extra:${k}:${i}:${ref}:${segmentId}`);
    if (copied.bind_segment_id) copied.bind_segment_id = segmentId;
    doc.materials[k].push(copied);
    refs.push(copied.id);
  }
  return refs;
}

/**
 * Mirror a segment's speed onto its speed MATERIAL. `pace` (src/pace.mjs currentSpeed) reads
 * the material first, so a segment whose material still says 1x reads as un-ramped no matter
 * what its timeranges say. Same shape setSpeed writes.
 */
function setSpeedMaterial(doc, segment, speed) {
  for (const ref of segment.extra_material_refs || []) {
    for (const values of Object.values(doc.materials || {})) {
      if (!Array.isArray(values)) continue;
      const m = values.find(x => x?.id === ref && x.type === 'speed');
      if (m) { m.speed = speed; m.mode = 0; m.curve_speed = null; return m; }
    }
  }
  return null;
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function assertNoOverlap(track, startUs, durUs, exceptId = null, label = 'clip.add') {
  const end = startUs + durUs;
  for (const s of track.segments || []) {
    if (exceptId && s.id === exceptId) continue;
    const t = s.target_timerange;
    if (!t) continue;
    if (overlaps(startUs, end, t.start, t.start + t.duration)) {
      throw new CapcutError(
        `${label}: overlaps ${s.id} (${r3(S(t.start))}-${r3(S(t.start + t.duration))}s) on track "${track.name || track.id}".`,
        { code: 'CLIP_OVERLAP', exitCode: 2 });
    }
  }
}

/** Name creates/reuses a named overlay below the principal. A number uses that index and never creates. */
export function resolveAddTrack(doc, trackSpec) {
  if (trackSpec == null || trackSpec === '') {
    throw new CapcutError('clip.add requires --track NAME (creates/reuses) or --track N (existing index).', { code: 'TRACK_REQUIRED', exitCode: 2 });
  }
  if (/^\d+$/.test(String(trackSpec))) {
    const index = Number(trackSpec);
    const track = doc.tracks[index];
    if (!track || track.type !== 'video') {
      throw new CapcutError(`clip.add: no video track at index ${index}. Numeric --track never creates a track.`, { code: 'TRACK_MISSING', exitCode: 2 });
    }
    if (track.flag === 0) {
      throw new CapcutError('clip.add: track 0 is the main/cover track and stays empty.', { code: 'MAIN_TRACK', exitCode: 2 });
    }
    return { track, index, created: false };
  }
  const name = String(trackSpec);
  const existing = doc.tracks.find(t => t.type === 'video' && t.name === name);
  if (existing) return { track: existing, index: doc.tracks.indexOf(existing), created: false };
  let insertAt = 1;
  try { insertAt = principalTrack(doc).index; }
  catch { insertAt = Math.max(1, doc.tracks.findIndex(t => t.type === 'video' && t.flag === 2)); if (insertAt < 1) insertAt = 1; }
  const track = insertOverlayTrack(doc, insertAt, mint(`track:${name}`));
  track.name = name;
  if (track.flag === 0) track.flag = 2;
  return { track, index: insertAt, created: true };
}

/**
 * Slide the preserved endcard so a clip can extend past it, and report the new window.
 *
 * Two rules learned the hard way:
 *  - The window must be measured from where the endcard is NOW, not from created.json every
 *    time. Per-op state meant two `add`s in one spec each measured from the original start,
 *    so the second re-slid everything the first had already moved — usually a hard rollback
 *    on SEGMENT_AFTER_END, and a silently stale created.json when it did not roll back.
 *  - A clip that STARTS inside the endcard is not a reason to move the endcard. Sliding on
 *    that grew the project without bound: nudging a clip inside the window by 1ms pushed the
 *    endcard 1ms further, every time.
 *
 * Deltas are computed on the first document pass and replayed on the second, so both mirrors
 * move identically. created.json is written only after the transaction commits, so a dry-run
 * or a rollback cannot leave a stale window.
 */
function slideState(projectDir, shared) {
  if (!shared.preserved) {
    const file = projectDir ? path.join(projectDir, '.capcutctl', 'created.json') : null;
    let created = null;
    if (file) try { created = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { created = null; }
    shared.preserved = { file, created, window: created?.preserved || null, total: 0 };
  }
  return shared.preserved;
}

function slidePreserved(doc, context, clipEndUs, op = {}, { wasAtUs = null } = {}) {
  const state = slideState(context.projectDir, context.shared || (context.shared = {}));
  const extend = () => {
    const was = doc.duration || 0;
    if (clipEndUs > was) doc.duration = clipEndUs;
    return { extended: clipEndUs > was, preserved: state.window, slid: 0 };
  };
  if (!state.window) return extend();

  // Replay this op's own decision on the second document pass.
  if (op.__slide === undefined) {
    const start = state.window.start + state.total;
    if (clipEndUs <= start) op.__slide = 0;
    // Moving content up against the endcard pushes it — that is the documented workflow.
    // Nudging a clip that ALREADY sat inside the endcard must not: measuring the push from
    // the window start meant every 1ms nudge grew the project by another 1ms, forever.
    else if (wasAtUs != null && wasAtUs >= start) {
      throw new CapcutError(
        `that clip already sits inside the endcard (${r3(S(start))}s onward), so moving it `
        + 'will not push the endcard again. Move the endcard yourself, or work before it.',
        { code: 'INSIDE_ENDCARD', exitCode: 2 });
    } else op.__slide = clipEndUs - start;
    op.__slideFrom = start;                 // where the endcard stood for THIS op
    state.total += op.__slide;
    state.next = { start: state.window.start + state.total, end: state.window.end + state.total };
  }

  const delta = op.__slide;
  if (!delta) return extend();
  const from = op.__slideFrom;
  for (const { segment } of allSegments(doc)) {
    if (segment.target_timerange?.start >= from) {
      segment.target_timerange.start += delta;
      if (segment.render_timerange?.duration) segment.render_timerange.start = (segment.render_timerange.start || 0) + delta;
    }
  }
  doc.duration = Math.max(doc.duration || 0, clipEndUs, state.next.end);
  return { extended: true, preserved: state.next, slid: delta };
}

/**
 * Push the cloned Preset 3 leftover past a gap after the talking head.
 * Do not delete it — it is a parts bin (copy attributes). It is not the video's ending.
 * Idempotent: no-op if already parked far enough.
 */
export function parkPresetLeftover(doc, context = {}, op = {}) {
  const projectDir = context.projectDir;
  if (!projectDir) return { slid: 0 };
  const state = slideState(projectDir, context.shared || (context.shared = {}));
  if (!state.window?.start) return { slid: 0 };
  if (op.__park === undefined) {
    const contentEnd = contentEndUs(doc, projectDir);
    const desired = contentEnd + PRESET_PARK_GAP_US;
    const from = state.window.start + (state.total || 0);
    op.__park = from >= desired - 1000 ? 0 : desired - from;
    op.__parkFrom = from;
    if (op.__park) {
      state.total = (state.total || 0) + op.__park;
      state.next = { start: state.window.start + state.total, end: (state.window.end || state.window.start) + state.total };
      state.contentEnd = contentEnd;
    }
  }
  const delta = op.__park;
  if (!delta) return { slid: 0, preserved: state.window };
  const from = op.__parkFrom;
  for (const t of doc.tracks || []) {
    for (const s of t.segments || []) {
      if ((s.target_timerange?.start || 0) >= from) {
        s.target_timerange.start += delta;
        if (s.render_timerange?.duration) s.render_timerange.start = (s.render_timerange.start || 0) + delta;
      }
    }
  }
  // `state.next.end` is only where created.json SAYS the leftover ends. The parts bin is
  // there to be rearranged in CapCut, so a leftover segment can legitimately end past that
  // recorded window — and shifting it by `delta` then put it beyond doc.duration, which
  // post-write validation rejects as SEGMENT_AFTER_END and rolls the whole wrap/zoom
  // transaction back. Measure what is actually on the timeline instead.
  const end = Math.max(state.next.end, maxSegmentEndUs(doc));
  doc.duration = Math.max(doc.duration || 0, end);
  return { slid: delta, preserved: state.next };
}

/** Verified extra from Higgsfield Refund (video overlay) / IKEA Refund (audio). Not invented. */
const AUDIO_FADE_TEMPLATE = {
  type: 'audio_fade',
  fade_type: 0,
  fade_in_duration: 0,
  fade_out_duration: 0
};

function ensureMaterial(doc, op, context) {
  const mediaPath = path.resolve(op.media);
  const existing = (doc.materials?.videos || []).find(m => m.path === mediaPath && m.type === 'video');
  if (existing && !op.forceNewMaterial) return existing;
  const tpl = (doc.materials?.videos || []).find(m => m.type === 'video') || { type: 'video', crop_scale: 1 };
  const material = clone(tpl);
  material.id = op.materialId || mint(`mat:${path.basename(mediaPath)}`);
  material.path = mediaPath;
  material.material_name = path.basename(mediaPath);
  material.local_material_id = '';
  material.type = 'video';
  material.width = op.width || tpl.width;
  material.height = op.height || tpl.height;
  material.duration = op.mediaDuration != null ? op.mediaDuration : (tpl.duration || 0);
  (doc.materials.videos ||= []).push(material);
  return material;
}

function annotateMediaSource(material, segment, originalPath, localizedPath, context, origin = null) {
  if (!material || !originalPath) return null;
  const original = path.resolve(originalPath);
  const localized = localizedPath ? path.resolve(localizedPath) : path.resolve(material.path || original);
  const takeId = sourceTakeId(original);
  // These fields are intentionally redundant with media-map.json: they survive a project
  // copy even when a sidecar is omitted, and let polish associate RL2 events per take.
  material.source_take_id = takeId;
  material.source_path = original;
  if (localized !== original) material.original_path = original;
  if (segment) segment.source_take_id = takeId;
  if (localized !== original) {
    recordMediaProvenance(context, {
      materialId: material.id,
      originalPath: original,
      localizedPath: localized,
      sourceTakeId: takeId,
      // The origin contract's verdict travels with the provenance: `doctor` reads it to tell a
      // generated graphic (no original exists, nothing to relink) apart from a baked crop.
      origin: origin?.kind || null,
      derivedFromPath: origin?.derivedFrom || null,
      derivedFromOffset: origin?.derivedOffset ?? null,
    });
  }
  return takeId;
}

/**
 * Place a clip on a named overlay. Never invents CapCut structure — clones a
 * plain segment already in the draft. Overlap is refused here (TRACK_OVERLAP
 * is only a doctor warning). Extending past duration slides the preserved
 * endcard and rewrites created.json.
 */
export function opClipAdd(doc, op, context = {}) {
  SEED = op.__seed || null;
  if (!op.media) throw new CapcutError('clip.add requires media.', { code: 'NO_MEDIA', exitCode: 2 });
  // applySpec reuses the operation object for root and active-timeline passes. Preserve the
  // caller's source before the first pass replaces `op.media` with its localized destination.
  const originalMedia = path.resolve(op.__sourceMedia || op.media);
  op.__sourceMedia ||= originalMedia;
  const atUs = US(op.at);
  const durUs = US(op.duration);
  if (!(durUs > 0)) throw new CapcutError('clip.add: --dur must be positive.', { code: 'BAD_TIME', exitCode: 2 });
  // Before anything is copied: is this media the human can still reframe, from a source they
  // can still find? Runs on the caller's source, not the localized destination.
  const cc = doc.canvas_config || {};
  const origin = assertOrigin({
    file: originalMedia, width: op.width, height: op.height,
    canvas: [cc.width || 1080, cc.height || 1920], label: 'clip.add',
    projectDir: context.projectDir || null,
    generated: op.generated === true, derivedFrom: op.derivedFrom || null,
    derivedOffset: op.derivedOffset, allowEphemeral: op.allowEphemeral === true,
  });

  // Default the source window to the START of the media. It used to default to `at`, so
  // `add --at 30` silently began 30s into a file the user had just picked — and refused
  // outright for any media shorter than the timeline position.
  const srcStart = op.src != null ? US(op.src) : 0;
  // --cover wins over --src-dur only when --src-dur was not given; both silently applied
  // before, with cover overwriting an explicit window.
  if (op.cover && op.srcDur != null) {
    throw new CapcutError('clip.add: pass --cover or --src-dur, not both.', { code: 'BAD_SOURCE_WINDOW', exitCode: 2 });
  }
  const srcDur = op.srcDur != null ? US(op.srcDur)
    : op.cover ? US(op.cover[1] - op.cover[0])
    : durUs;
  const speed = srcDur / durUs;

  const dest = resolveAddTrack(doc, op.track);
  if (dest.track.flag === 0) {
    throw new CapcutError('clip.add: will not place on the main/cover track.', { code: 'MAIN_TRACK', exitCode: 2 });
  }
  assertNoOverlap(dest.track, atUs, durUs);

  if (op.localize && context.projectDir) {
    op.media = localizeMedia(context.projectDir, path.resolve(op.media), undefined, { dryRun: context.dryRun });
  }

  const slid = slidePreserved(doc, context, atUs + durUs, op);
  if (atUs + durUs > (doc.duration || 0) + 1) doc.duration = atUs + durUs;

  const material = stampOrigin(ensureMaterial(doc, op, context), origin);
  if (Number.isFinite(material.duration) && srcStart + srcDur > material.duration + 1) {
    throw new CapcutError(
      `clip.add: source ${r3(S(srcStart))}-${r3(S(srcStart + srcDur))}s exceeds media duration ${r3(S(material.duration))}s.`,
      { code: 'SOURCE_AFTER_END', exitCode: 2 });
  }

  const template = pickSegmentTemplate(doc);
  const segment = clone(template);
  segment.id = op.id || mint('seg:add');
  segment.material_id = material.id;
  segment.target_timerange = { start: atUs, duration: durUs };
  segment.source_timerange = { start: srcStart, duration: srcDur };
  segment.clip = { scale: { x: 1, y: 1 }, rotation: 0, transform: { x: 0, y: 0 }, flip: { horizontal: false, vertical: false }, alpha: 1 };
  segment.enable_video_mask = false;
  segment.volume = op.volume == null ? 1 : Number(op.volume);
  segment.speed = speed;
  // Keep the template's stacking rather than pinning every add to 2, which gave several
  // adds colliding render indices.
  if (!Number.isFinite(segment.render_index)) segment.render_index = 2;
  segment.desc = op.desc || '';
  segment.keyframe_refs = [];
  segment.common_keyframes = [];
  segment.extra_material_refs = cloneExtras(doc, template, segment.id);
  // AFTER cloneExtras, never before: until that line `segment.extra_material_refs` still holds
  // the TEMPLATE's ids, so setting the speed there wrote through to the template's own material
  // and left this clip on whatever the template happened to say.
  // `pace` reads the material first and only falls back to the segment, so a clip whose
  // material still says 1x reports as un-ramped forever.
  setSpeedMaterial(doc, segment, speed);
  annotateMediaSource(material, segment, originalMedia, material.path, context, origin);
  dest.track.segments = dest.track.segments || [];
  dest.track.segments.push(segment);
  dest.track.segments.sort((a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0));
  renumberTracks(doc);                      // also sets track_render_index on every segment

  return {
    changed: 1,
    id: segment.id,
    track: dest.track.name || dest.index,
    trackIndex: dest.index,
    createdTrack: dest.created,
    at: r3(S(atUs)),
    duration: r3(S(durUs)),
    source: [r3(S(srcStart)), r3(S(srcStart + srcDur))],
    speed: r3(speed),
    origin: origin.kind,
    extended: slid.extended,
    preserved: slid.preserved ? { start: r3(S(slid.preserved.start)), end: r3(S(slid.preserved.end)) } : null
  };
}

/** Relink this segment's material (or a clone of it if shared) without wiping keyframes. */
export function opReplaceMedia(doc, op, context = {}) {
  SEED = op.__seed || null;
  if (!op.path) throw new CapcutError('replace.media requires path.', { code: 'NO_MEDIA', exitCode: 2 });
  // The same operation is applied to root and active-timeline documents. Keep the original
  // source before the first pass replaces `op.path` with its localized destination.
  const originalPath = path.resolve(op.__sourcePath || op.path);
  op.__sourcePath ||= originalPath;
  const found = selectSegments(doc, op.selector || {});
  if (!found.length) throw new CapcutError(`replace.media: no segment matched ${JSON.stringify(op.selector)}.`, { code: 'SELECTOR_EMPTY' });
  // Silently relinking found[0] meant an ambiguous selector swapped one clip's media and left
  // the rest — the same trap `requireMatches` guards the generic ops against.
  if (found.length > 1 && op.all !== true) {
    throw new CapcutError(
      `replace.media: selector matched ${found.length} segments; pass a unique id or "all": true.`,
      { code: 'SELECTOR_AMBIGUOUS', exitCode: 2 });
  }
  const entry = found[0];
  const seg = entry.segment;
  const old = (doc.materials?.videos || []).find(m => m.id === seg.material_id);
  if (!old) throw new CapcutError(`replace.media: segment ${seg.id} has no video material.`, { code: 'MISSING_MATERIAL_REF' });
  // Swapping media is the other door into the project, and it was the wider one: it takes an
  // arbitrary file and needs no track or timing. Same contract as clip.add.
  const canvas = doc.canvas_config || {};
  const origin = assertOrigin({
    file: originalPath, width: op.width ?? old.width, height: op.height ?? old.height,
    canvas: [canvas.width || 1080, canvas.height || 1920], label: 'replace.media',
    projectDir: context.projectDir || null,
    generated: op.generated === true, derivedFrom: op.derivedFrom || null,
    derivedOffset: op.derivedOffset, allowEphemeral: op.allowEphemeral === true,
  });

  const shared = (doc.tracks || []).flatMap(t => t.segments || []).filter(s => s.material_id === old.id).length > 1;
  let material = old;
  if (shared) {
    material = clone(old);
    material.id = mint(`mat:replace:${seg.id}`);
    (doc.materials.videos ||= []).push(material);
    seg.material_id = material.id;
  }
  let dest = path.resolve(op.path);
  if (op.localize && context.projectDir) {
    dest = localizeMedia(context.projectDir, dest, undefined, { dryRun: context.dryRun });
  }
  // Refuse here rather than letting validateDocument roll the whole transaction back with a
  // MISSING_MEDIA dump — the same check opMaterialRelink does.
  if (!context.dryRun && !fs.existsSync(dest)) {
    throw new CapcutError(`replace.media: ${dest} does not exist.`, { code: 'MISSING_MEDIA', exitCode: 2 });
  }
  material.path = dest;
  material.material_name = path.basename(dest);
  if ('media_path' in material) material.media_path = '';
  if (op.width) material.width = op.width;
  if (op.height) material.height = op.height;
  if (op.mediaDuration != null) material.duration = op.mediaDuration;

  const tt = seg.target_timerange;
  if (op.retime && seg.source_timerange && Number.isFinite(material.duration)) {
    const speed = material.duration / tt.duration;
    seg.source_timerange = { start: 0, duration: material.duration };
    seg.speed = speed;
    setSpeedMaterial(doc, seg, speed);
  } else if (seg.source_timerange && Number.isFinite(material.duration)) {
    // Keeping the current window onto a SHORTER file used to die as a SOURCE_AFTER_END
    // rollback dump. Say what is wrong and what to pass instead.
    const st = seg.source_timerange;
    if (st.start + st.duration > material.duration + 1) {
      throw new CapcutError(
        `replace.media: this clip reads source ${r3(S(st.start))}-${r3(S(st.start + st.duration))}s `
        + `but ${path.basename(dest)} is only ${r3(S(material.duration))}s long. Pass --retime to `
        + 'rebuild the window from the new file.',
        { code: 'SOURCE_AFTER_END', exitCode: 2 });
    }
  }
  stampOrigin(material, origin);
  annotateMediaSource(material, seg, originalPath, dest, context, origin);
  return { changed: 1, id: seg.id, materialId: material.id, path: dest, origin: origin.kind, shared: shared && true };
}


function probeDurationUs(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    const s = Number(out);
    return s > 0 ? Math.round(s * 1e6) : 0;
  } catch {
    return 0;
  }
}

/**
 * Copy every outside video into Resources/CapcutctlMedia and relink.
 * Same-basename takes (every rl2 file is screen.mp4) get unique names from their parent folder.
 * CapCut cache SFX/stock stay put — those are already inside the sandbox.
 * Duplicate material records (CapCut repeats ids) are made identical so doctor
 * does not report CONFLICTING_MATERIAL_ID after the path change.
 */
export function opLocalizeAll(doc, op, context = {}) {
  const projectDir = context.projectDir;
  if (!projectDir) throw new CapcutError('media.localize needs a project directory.', { code: 'NO_PROJECT' });
  const kinds = op.kinds || ['videos'];
  const copied = [];
  const seen = new Map();
  for (const kind of kinds) {
    for (const mat of doc.materials?.[kind] || []) {
      const src = mat.path;
      if (typeof src !== 'string' || !src.startsWith('/')) continue;
      if (isLocalMedia(projectDir, src) || isCapCutCachePath(src)) continue;
      if (!fs.existsSync(src)) continue;
      let dest = seen.get(src);
      if (!dest) {
        dest = localizeMedia(projectDir, src, undefined, { dryRun: context.dryRun });
        seen.set(src, dest);
        copied.push({ from: src, to: dest });
      }
      mat.path = dest;
      if ('media_path' in mat) mat.media_path = '';
      mat.material_name = path.basename(dest);
      if (!(mat.duration > 0)) mat.duration = probeDurationUs(dest);
      annotateMediaSource(mat, null, src, dest, context);
    }
  }
  // Which paths this run actually put inside the project. A sibling record for the same id
  // may still point at the CapCut cache or at a file that no longer exists — the very
  // condition localize is run to fix — so `best` must be chosen by whether the path is GOOD,
  // not by `duration > 0` alone. It used to copy the un-localized path back over the
  // localized one: a silent revert, or a MISSING_MEDIA rollback when the path was gone.
  const localized = new Set(seen.values());
  const pathRank = m => (localized.has(m.path) ? 4 : 0)
                      + (isLocalMedia(projectDir, m.path) ? 2 : 0)
                      + (typeof m.path === 'string' && m.path && fs.existsSync(m.path) ? 1 : 0);
  for (const kind of kinds) {
    const byId = new Map();
    for (const mat of doc.materials?.[kind] || []) {
      if (!mat?.id) continue;
      if (!byId.has(mat.id)) byId.set(mat.id, []);
      byId.get(mat.id).push(mat);
    }
    for (const clones of byId.values()) {
      if (clones.length < 2) continue;
      // Stable sort, so equally-ranked records keep their order and this still resolves to
      // the old "first record with a duration" when no path is better than any other.
      const best = [...clones].sort((a, b) =>
        pathRank(b) - pathRank(a) || (b.duration > 0) - (a.duration > 0))[0];
      // The winning path may carry no probed duration yet; do not zero out one we have.
      const duration = best.duration > 0
        ? best.duration
        : (clones.find(m => m.duration > 0)?.duration ?? best.duration);
      for (const m of clones) {
        m.path = best.path;
        m.duration = duration;
        m.material_name = best.material_name;
        if (best.width) m.width = best.width;
        if (best.height) m.height = best.height;
        for (const key of ['original_path', 'source_path', 'source_take_id']) {
          if (best[key] != null) m[key] = best[key];
        }
        if ('media_path' in m) m.media_path = '';
      }
    }
  }
  return { changed: copied.length, copied };
}

const MAIN_TRACK = 'the main/cover track, which stays empty — move the clip to an overlay first';

/**
 * Resolve --at/--track to a single segment.
 *
 * Refuses the flag=0 main track. `resolveAddTrack` already guarded it, but every OTHER verb
 * (remove / volume / trim / shift / fade / keyframe) came through here, which filtered on
 * `type === 'video'` alone — so all six could edit the cover track that is supposed to stay
 * empty. That is rule zero of this project's style, and nothing downstream re-checks.
 *
 * Rule zero is about the *video* cover track only. CapCut writes `flag=0` on every audio and
 * text track by convention (verified across the hand-cut drafts: Hermes-agent, IKEA Refund,
 * Content System, Higgsfield Refund) — so guarding on `flag === 0` alone made every SFX, music
 * and text cue unreachable, and polish's own sound lane could not be nudged or removed except
 * by hand in the CapCut UI. Scope the refusal to video.
 */
const isCoverTrack = t => t?.type === 'video' && t?.flag === 0;

export function resolveClip(doc, { at, track, id } = {}) {
  const refuseMain = entry => {
    if (isCoverTrack(entry.track)) {
      throw new CapcutError(`segment ${entry.segment.id} is on ${MAIN_TRACK}.`, { code: 'MAIN_TRACK', exitCode: 2 });
    }
    return entry;
  };
  if (id) {
    const hits = allSegments(doc).filter(e => e.segment.id === id);
    if (hits.length !== 1) throw new CapcutError(`no unique segment id ${id}`, { code: 'SELECTOR_EMPTY', exitCode: 2 });
    return refuseMain(hits[0]);
  }
  if (at == null) throw new CapcutError('need --at SECONDS or --segments ID', { code: 'SELECTOR_EMPTY', exitCode: 2 });
  const us = US(at);
  // `track` may legitimately be the number 0 or the string '0'; `String(track || '')` turned
  // both into '' and skipped BOTH branches, so a numeric 0 silently meant "no filter".
  const spec = track == null || track === '' ? null : String(track);
  const numeric = spec != null && /^\d+$/.test(spec);
  const hits = [];
  for (const [ti, t] of (doc.tracks || []).entries()) {
    if (isCoverTrack(t)) continue;                    // never selectable, even by explicit index
    if (numeric && ti !== Number(spec)) continue;
    if (spec != null && !numeric && t.name !== spec) continue;
    for (const s of t.segments || []) {
      const tr = s.target_timerange;
      if (tr && tr.start <= us && us < tr.start + tr.duration) hits.push({ segment: s, track: t, trackIndex: ti });
    }
  }
  if (hits.length !== 1) {
    const onMain = numeric && isCoverTrack(doc.tracks?.[Number(spec)]);
    if (onMain) throw new CapcutError(`track ${spec} is ${MAIN_TRACK}.`, { code: 'MAIN_TRACK', exitCode: 2 });
    throw new CapcutError(`${hits.length} clips cover ${at}s. Pass --track NAME|N.`, { code: 'SELECTOR_AMBIGUOUS', exitCode: 2 });
  }
  return hits[0];
}

/** Scale-only punch. Offsets are absolute source positions (not 0). */
export function opScaleKeyframe(doc, op) {
  SEED = op.__seed || null;
  const entry = resolveOpClip(doc, op);
  const segment = entry?.segment;
  if (!segment) throw new CapcutError('keyframe: no segment matched.', { code: 'SELECTOR_EMPTY', exitCode: 2 });
  const st = segment.source_timerange || { start: 0, duration: segment.target_timerange.duration };
  const tt = segment.target_timerange;
  const speed = tt.duration ? st.duration / tt.duration : 1;
  const at = op.at != null ? op.at : S(tt.start) + 0.4;
  const into = Math.max(0, at - S(tt.start)) * speed;
  const ramp = (op.ramp ?? 0.2) * speed;
  const hold = (op.hold ?? 1.6) * speed;
  const from = op.from ?? 1;
  const to = op.to ?? 2.4;
  const origin = st.start;
  const clamp = t => Math.max(st.start, Math.min(st.start + st.duration, t));
  const c0 = clamp(origin + US(into));
  const c1 = clamp(origin + US(into + ramp));
  if (c0 === c1) {
    throw new CapcutError(
      `keyframe: both keys clamp to source ${r3(S(c0))}s (window ${r3(S(st.start))}-${r3(S(st.start + st.duration))}s).`,
      { code: 'KEYFRAME_CLAMPED', exitCode: 2 });
  }
  const list = [
    { id: mint('kfa'), curveType: 'Line', time_offset: c0, left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 }, values: [from], string_value: '', graphID: '' },
    { id: mint('kfb'), curveType: 'Line', time_offset: c1, left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 }, values: [to], string_value: '', graphID: '' }
  ];
  if (op.hold !== 0) {
    const tHold = clamp(origin + US(into + ramp + hold));
    const tBack = clamp(origin + US(into + ramp + hold + ramp));
    if (tHold > c1 && tBack > tHold) {
      list.push(
        { ...clone(list[1]), id: mint('kfc'), time_offset: tHold, values: [to] },
        { ...clone(list[0]), id: mint('kfd'), time_offset: tBack, values: [from] }
      );
    }
  }
  if (list.length < 2) throw new CapcutError('keyframe: refused a single keyframe (dead hold).', { code: 'KEYFRAME_SINGLE', exitCode: 2 });
  segment.common_keyframes = [{
    id: mint('kf'), material_id: '', property_type: 'KFTypeScaleX', keyframe_list: list
  }];
  return { changed: 1, id: segment.id, offsets: list.map(k => r3(S(k.time_offset))), to, from };
}

function resolveOpClip(doc, op) {
  // Always through resolveClip: the selector.id branch used to look segments up directly and
  // so skipped the main-track guard that every other path goes through.
  return resolveClip(doc, { at: op.at, track: op.track, id: op.selector?.id || op.id });
}

/** Move a clip on the timeline. Extends / slides the endcard the same way add does. */
export function opClipShift(doc, op, context = {}) {
  SEED = op.__seed || null;
  const entry = resolveOpClip(doc, op);
  if (op.by == null) throw new CapcutError('clip.shift requires by seconds.', { code: 'BAD_TIME', exitCode: 2 });
  const tt = entry.segment.target_timerange;
  const next = tt.start + US(op.by);
  if (next < 0) throw new CapcutError('clip.shift: target start would be negative.', { code: 'BAD_TIME', exitCode: 2 });
  assertNoOverlap(entry.track, next, tt.duration, entry.segment.id, 'clip.shift');
  // Slide BEFORE moving: at its old start the clip is still behind the endcard, so it is not
  // itself caught by the slide and then moved a second time.
  const slid = slidePreserved(doc, context, next + tt.duration, op, { wasAtUs: tt.start });
  tt.start = next;
  if (entry.segment.render_timerange?.duration) entry.segment.render_timerange.start = next;
  if (next + tt.duration > (doc.duration || 0) + 1) doc.duration = next + tt.duration;
  return { changed: 1, id: entry.segment.id, at: r3(S(next)), duration: r3(S(tt.duration)), extended: slid.extended,
    preserved: slid.preserved ? { start: r3(S(slid.preserved.start)), end: r3(S(slid.preserved.end)) } : null };
}

/** Change the source window; speed follows source/target. Keyframes rescale with the window. */
export function opClipTrim(doc, op) {
  SEED = op.__seed || null;
  const entry = resolveOpClip(doc, op);
  const st = entry.segment.source_timerange || { start: 0, duration: entry.segment.target_timerange.duration };
  const tt = entry.segment.target_timerange;
  let srcStart, srcDur;
  if (Array.isArray(op.src) && op.src.length === 2) {
    srcStart = US(op.src[0]);
    srcDur = US(op.src[1] - op.src[0]);
  } else if (op.start != null && op.duration != null) {
    srcStart = US(op.start);
    srcDur = US(op.duration);
  } else {
    throw new CapcutError('clip.trim requires src [IN, OUT] or start+duration.', { code: 'BAD_TIME', exitCode: 2 });
  }
  if (!(srcDur > 0)) throw new CapcutError('clip.trim: source duration must be positive.', { code: 'BAD_TIME', exitCode: 2 });
  if (srcStart < 0) throw new CapcutError('clip.trim: source start cannot be negative.', { code: 'BAD_TIME', exitCode: 2 });
  // Refuse a window past the end of the file here; it used to reach validateDocument and roll
  // the whole transaction back with a SOURCE_AFTER_END dump instead of naming the numbers.
  const material = (Object.values(doc.materials || {}).find(v => Array.isArray(v) && v.some(m => m?.id === entry.segment.material_id)) || [])
    .find(m => m?.id === entry.segment.material_id);
  if (Number.isFinite(material?.duration) && srcStart + srcDur > material.duration + 1) {
    throw new CapcutError(
      `clip.trim: source ${r3(S(srcStart))}-${r3(S(srcStart + srcDur))}s exceeds `
      + `${material.material_name || 'the media'} (${r3(S(material.duration))}s).`,
      { code: 'SOURCE_AFTER_END', exitCode: 2 });
  }
  const oldStart = st.start, oldDur = st.duration;
  entry.segment.source_timerange = { start: srcStart, duration: srcDur };
  entry.segment.speed = srcDur / tt.duration;
  setSpeedMaterial(doc, entry.segment, entry.segment.speed);
  rescaleKeyframes(entry.segment, oldStart, oldDur, srcStart, srcDur);
  return { changed: 1, id: entry.segment.id, source: [r3(S(srcStart)), r3(S(srcStart + srcDur))], speed: r3(entry.segment.speed) };
}

/** Attach or update a harvested audio_fade extra. Durations are seconds. */
export function opClipFade(doc, op) {
  SEED = op.__seed || null;
  const entry = resolveOpClip(doc, op);
  const fadeIn = US(op.in ?? 0);
  const fadeOut = US(op.out ?? 0);
  if (fadeIn < 0 || fadeOut < 0) throw new CapcutError('clip.fade: --in/--out must be >= 0.', { code: 'BAD_TIME', exitCode: 2 });
  const fades = doc.materials.audio_fades ||= [];
  const byId = new Map(fades.map(f => [f.id, f]));
  const existingId = (entry.segment.extra_material_refs || []).find(id => byId.has(id));
  if (existingId) {
    byId.get(existingId).fade_in_duration = fadeIn;
    byId.get(existingId).fade_out_duration = fadeOut;
    return { changed: 1, id: entry.segment.id, fadeId: existingId, in: r3(S(fadeIn)), out: r3(S(fadeOut)), updated: true };
  }
  const copied = clone(AUDIO_FADE_TEMPLATE);
  copied.id = mint(`fade:${entry.segment.id}`);
  copied.fade_in_duration = fadeIn;
  copied.fade_out_duration = fadeOut;
  fades.push(copied);
  entry.segment.extra_material_refs = [...(entry.segment.extra_material_refs || []), copied.id];
  return { changed: 1, id: entry.segment.id, fadeId: copied.id, in: r3(S(fadeIn)), out: r3(S(fadeOut)), updated: false };
}
