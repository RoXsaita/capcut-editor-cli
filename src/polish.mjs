import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CapcutError, clone, seededId, allSegments, loadPreset, resolveMediaPath, contentEndUs, removeUnreferencedMaterials
} from './core.mjs';
import { carryLevels, snapshotLevels } from './levels.mjs';
import { hasClipAnimations } from './animations.mjs';
import { resolveClip } from './add.mjs';
import { partForMedia, takeParts, vtInPart } from './rl2-take.mjs';
import { readMetaRecord } from './repair.mjs';
import { detachLibraryIdentity, localizeAudioFile, probeAudioDuration } from './local-audio.mjs';

export function sfxPresets() {
  return loadPreset('sfx');
}

let SEED = null;
const mint = key => seededId(SEED, key);

const US = s => Math.round(s * 1e6);
const arr = (doc, kind) => (doc.materials[kind] ||= []);

const SCREEN_RECORDING_DESC = 'layout:screen-recording';

function isScreenRecording(segment) {
  const desc = String(segment?.desc || '');
  return desc === SCREEN_RECORDING_DESC || desc.startsWith(`${SCREEN_RECORDING_DESC} `);
}

/** Generated screen decorations are not independent footage or callout plates. */
function isScreenHelper(segment) {
  const desc = String(segment?.desc || '');
  // A rendered graphic entering is not a scene cut: no transition or seam sound belongs there
  // (the graphic carries its own cue).
  if (desc.startsWith('mograph:')) return true;
  return desc.startsWith('layout:') && !isScreenRecording(segment);
}

function contentBoundaryUs(doc, projectDir = null) {
  let end = Number(contentEndUs(doc, projectDir));
  const declared = Number(doc?.contentEnd);
  if (Number.isFinite(declared) && declared > 0) {
    const declaredUs = declared > 100_000 ? Math.round(declared) : US(declared);
    end = end > 0 ? Math.min(end, declaredUs) : declaredUs;
  }
  if (!(end > 0)) end = Number(doc?.duration) || 0;
  return end;
}

/** Material lookups by id, first record wins (as `Array.find` did). */
function videosById(doc) {
  const videos = new Map();
  for (const m of doc.materials?.videos || []) if (m && !videos.has(m.id)) videos.set(m.id, m);
  return videos;
}

/**
 * What the planners look up again and again, computed once per entry point: the content end
 * (contentEndUs re-reads created.json and re-resolves the principal track on every call, and
 * it used to be called per segment per probe), the videos by id, and the visible B-roll per
 * principal index. Never cached on the doc: ops mutate it between calls.
 */
function planCtx(doc, projectDir = null) {
  return { boundaryUs: contentBoundaryUs(doc, projectDir), videos: videosById(doc), broll: new Map(), masks: null };
}

function inContent(doc, segment, boundaryUs) {
  const start = Number(segment?.target_timerange?.start);
  return Number.isFinite(start) && start < boundaryUs;
}

function isVisibleBroll(doc, segment, track, trackIndex, principalIndex, videos = videosById(doc)) {
  const desc = String(segment?.desc || '');
  const markedScreen = isScreenRecording(segment);
  const belowPrincipal = trackIndex < principalIndex;
  const markedAbovePrincipal = trackIndex > principalIndex && markedScreen;
  if (!track || track.type !== 'video' || track.flag === 0 || track.hidden === true || track.visible === false
      || (!belowPrincipal && !markedAbovePrincipal)
      || isScreenHelper(segment) || desc.startsWith('sig:')) return false;
  const material = videos.get(segment.material_id);
  if (!material) return false;
  if (material.capcutctl_mograph) return false;
  if (material.type && material.type !== 'video') return false;
  const file = String(material.path || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic)$/.test(file)) return false;
  if ((segment.clip?.alpha ?? 1) <= 0) return false;
  const alphaGroups = (segment.common_keyframes || []).filter(group => group.property_type === 'KFTypeAlpha');
  if (alphaGroups.length && alphaGroups.every(group => (group.keyframe_list || []).length > 0
      && group.keyframe_list.every(keyframe => Array.isArray(keyframe.values)
        && keyframe.values.length > 0 && keyframe.values.every(value => Number(value) <= 0)))) return false;
  return Boolean(segment.source_timerange && segment.target_timerange);
}

function r2(n) { return Math.round(n * 100) / 100; }

/** The visible, in-content B-roll for one principal index, in allSegments order. */
function brollList(doc, principalIndex, ctx) {
  let list = ctx.broll.get(principalIndex);
  if (list) return list;
  list = [];
  for (const { segment: s, track, trackIndex: i } of allSegments(doc)) {
    if (!isVisibleBroll(doc, s, track, i, principalIndex, ctx.videos)) continue;
    if (!s.target_timerange || !inContent(doc, s, ctx.boundaryUs)) continue;
    const a = s.target_timerange.start;
    list.push({ s, i, a, b: a + s.target_timerange.duration });
  }
  ctx.broll.set(principalIndex, list);
  return list;
}

function coveringBroll(doc, t, principalIndex, ctx) {
  const us = US(t);
  if (us < 0 || us >= ctx.boundaryUs) return null;
  let found = null;
  for (const { s, i, a, b } of brollList(doc, principalIndex, ctx)) {
    if (!(a - 20000 < us && us < b - 20000)) continue;
    const m = ctx.videos.get(s.material_id);
    const sr = s.source_timerange || {};
    const cl = s.clip || {};
    const hit = {
      desc: s.desc || '', path: m?.path || '', id: s.id,
      scale: cl.scale?.x ?? 1, tx: cl.transform?.x ?? 0, ty: cl.transform?.y ?? 0,
      srcStart: (sr.start || 0) / 1e6,
      srcEnd: ((sr.start || 0) + (sr.duration || 0)) / 1e6,
    };
    // An explicitly marked upper screen recording is composited over the face and any lower B-roll.
    if (i > principalIndex || !found) found = hit;
  }
  return found;
}

function coveringLayout(doc, t, principal, ctx = null) {
  if (!principal) return 'none';
  const us = US(t);
  let masks = ctx?.masks;
  if (!masks) {
    masks = new Map((doc.materials?.common_mask || []).map(m => [m.id, m]));
    if (ctx) ctx.masks = masks;
  }
  const seg = (principal.track.segments || []).find(s => {
    const a = s.target_timerange.start, b = a + s.target_timerange.duration;
    return a - 20000 <= us && us < b + 20000;
  });
  if (!seg) return 'none';
  const refs = seg.extra_material_refs || [];
  if (seg.enable_video_mask === false) return 'full-face';
  const hit = refs.map(id => masks.get(id)).find(Boolean);
  if (!hit) return 'full-face';
  const name = String(hit.name || '').toLowerCase();
  const rtype = String(hit.resource_type || '').toLowerCase();
  if (name === 'circle' || rtype === 'circle') return 'circle';
  if (name === 'split' || rtype === 'line') return 'split-screen';
  return 'split-screen';
}

function collapse(marks, minGap) {
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  const out = [];
  for (const m of sorted) {
    if (out.length && m.t - out.at(-1).t < minGap) {
      out.at(-1).kind = out.at(-1).kind === 'layout' && m.kind === 'broll' ? 'broll' : out.at(-1).kind;
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Is this a different SHOT, not merely a different segment?
 *
 * Keying on `path|desc` alone made three consecutive clips of one screen recording —
 * same file, same desc, but reframed 3.33x -> 5.0x -> 5.0x-panned — read as ONE
 * continuous shot, so `--motivated` dropped the seams at both cuts. Reframing the same
 * file is a new shot: the viewer sees the picture jump.
 *
 * Deliberately NOT keyed on the source window. A same-file, same-framing cut that jumps
 * in the source is also a visible cut, but every packer leaves frame-boundary slivers
 * and some fixtures carry no source at all, so that rule costs more false positives than
 * it buys. Reframing is the signal that is always real.
 */
function shotChanged(a, b) {
  if (!a || !b) return a !== b;
  if (a.path !== b.path || a.desc !== b.desc) return true;
  const fr = x => `${r2(x.scale)}|${r2(x.tx)}|${r2(x.ty)}`;
  return fr(a) !== fr(b);
}

/**
 * Cuts the VIEWER can see: B-roll shot change or layout class change.
 * An A-roll splice over an unchanged files list is not a picture change —
 * decorating those is what made grok-build-final feel machine-made.
 */
export function pictureChanges(doc, { minGap = 0.9, track = null, projectDir = null } = {}) {
  const principal = optionalPrincipal(doc, track);
  // With no talking head above it, every visible video track is B-roll.
  const brollBelow = principal ? principal.index : doc.tracks.length;
  const ctx = planCtx(doc, projectDir);
  const marks = [];
  const seen = new Set();
  for (const { segment, track: tr } of allSegments(doc)) {
    if (tr.type !== 'video' || !(tr.segments || []).length) continue;
    if (isScreenHelper(segment) || !inContent(doc, segment, ctx.boundaryUs)) continue;
    const t = segment.target_timerange.start / 1e6;
    if (t <= 0.001) continue;
    const key = Math.round(t * 30) / 30;
    if (seen.has(key)) continue;
    seen.add(key);
    const beforeB = coveringBroll(doc, t - 0.05, brollBelow, ctx);
    const afterB = coveringBroll(doc, t + 0.05, brollBelow, ctx);
    const beforeL = coveringLayout(doc, t - 0.05, principal, ctx);
    const afterL = coveringLayout(doc, t + 0.05, principal, ctx);
    const brollChanged = shotChanged(beforeB, afterB);
    const layoutChanged = beforeL !== afterL;
    if (!brollChanged && !layoutChanged) continue;
    marks.push({
      t: r2(t),
      kind: brollChanged ? 'broll' : 'layout',
      from: brollChanged ? (beforeB?.desc || beforeL) : beforeL,
      to: brollChanged ? (afterB?.desc || afterL) : afterL,
    });
  }
  return collapse(marks, minGap);
}

/** Cut points that a viewer actually sees: a scene change on any visual track. */
export function cutPoints(doc, { minGap = 0.9, projectDir = null } = {}) {
  const marks = new Map();
  const boundaryUs = contentBoundaryUs(doc, projectDir);
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video' || !(track.segments || []).length) continue;
    if (isScreenHelper(segment) || !inContent(doc, segment, boundaryUs)) continue;
    const t = segment.target_timerange.start / 1e6;
    if (t <= 0.001) continue;                              // the first frame is not a cut
    const key = Math.round(t * 30) / 30;                   // frame-quantised
    marks.set(key, (marks.get(key) || 0) + 1);
  }
  const sorted = [...marks.entries()].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [t, weight] of sorted) {
    if (out.length && t - out.at(-1).t < minGap) { out.at(-1).weight += weight; continue; }
    out.push({ t, weight });
  }
  return out;
}

/**
 * Is the file this preset points at actually on THIS machine?
 *
 * The SFX and transition palettes are CapCut's own effect/music cache. CapCut mints those
 * paths when *you* download a sound in its UI, so they exist only on the machine that was
 * harvested. On any other machine `polish` used to write the reference anyway, and the whole
 * transaction died with `Transaction failed validation with 12 error(s)` — a working project
 * refusing to be polished because of one person's ~/Library. Missing assets are skipped and
 * reported instead: the polish that CAN be applied still is.
 *
 * A template with no path at all (a pure structural transition) is always usable.
 */
function templateIsAvailable(tpl) {
  const file = tpl?.path;
  if (typeof file !== 'string' || !file) return true;
  return fs.existsSync(file);
}

/** Names skipped this run, so the command can say what it could not place and why. */
let UNAVAILABLE = new Set();
export function resetUnavailableSfx() { UNAVAILABLE = new Set(); }
export function unavailableSfx() { return [...UNAVAILABLE].sort(); }

/**
 * Ensure a named SFX material exists; return its id, or `null` when the sound is not on this
 * machine. Every caller must treat null as "place no sound here".
 */
export function ensureAudio(doc, name, mintFn = mint) {
  const p = sfxPresets();
  const tpl = p.audioTemplates[name];
  if (!tpl) throw new CapcutError(`unknown sfx "${name}". Known: ${Object.keys(p.audioTemplates).join(', ')}`, { code: 'UNKNOWN_SFX', exitCode: 2 });
  const found = (doc.materials.audios || []).find(m => m.name === name);
  if (found) return found.id;
  if (!templateIsAvailable(tpl)) { UNAVAILABLE.add(name); return null; }
  const m = clone(tpl);
  m.id = mintFn(`audio:${name}`);
  arr(doc, 'audios').push(m);
  return m.id;
}

/** Returns null when the transition's effect file is not cached on this machine. */
function makeTransition(doc, name, durationS, key) {
  const p = sfxPresets();
  const tpl = p.transitionTemplates[name];
  if (!tpl) throw new CapcutError(`unknown transition "${name}"`, { code: 'UNKNOWN_TRANSITION', exitCode: 2 });
  if (!templateIsAvailable(tpl)) { UNAVAILABLE.add(name); return null; }
  const m = clone(tpl);
  m.id = mint(`transition:${key}`);
  m.duration = US(durationS);
  // Ownership mark. A CapCut save strips it, but the meta ledger records every capcutctl_* key
  // by id, so the next polish still knows which transitions are its own.
  m.capcutctl_polish = true;
  arr(doc, 'transitions').push(m);
  return m.id;
}

/**
 * Take back the transitions an earlier polish placed, and only those: marked
 * capcutctl_polish, or recorded so in the meta ledger (a CapCut save strips the mark).
 * A transition the user added by hand stays where it is.
 *
 * A legacy draft — transitions present, none marked, no polish entry in the ledger — was
 * polished before the mark existed, so its polish transitions are indistinguishable from hand
 * ones. It gets the old clear-all once (reported); every transition placed after that is marked.
 */
function clearOwnedTransitions(doc, projectDir = null) {
  const all = doc.materials.transitions || [];
  let ledgerOwned = new Set();
  if (projectDir) {
    const record = readMetaRecord(projectDir);
    ledgerOwned = new Set(Object.entries(record?.materials || {})
      .filter(([, entry]) => entry?.fields?.capcutctl_polish === true).map(([id]) => id));
  }
  const isOwned = m => m?.capcutctl_polish === true || ledgerOwned.has(m?.id);
  const legacyClearAll = all.length > 0 && !ledgerOwned.size && !all.some(isOwned);
  const removing = new Set(all.filter(m => legacyClearAll || isOwned(m)).map(m => m.id));
  for (const { segment } of allSegments(doc)) {
    segment.extra_material_refs = (segment.extra_material_refs || []).filter(r => !removing.has(r));
  }
  doc.materials.transitions = all.filter(m => !removing.has(m.id));
  return { removed: removing.size, kept: new Set(doc.materials.transitions.map(m => m.id)), legacyClearAll };
}

/** Filter out the segments `drop` claims, recording what they referenced in `owned`. */
function dropOwned(segments, owned, drop) {
  return (segments || []).filter(s => {
    if (!drop(s)) return true;
    if (s.material_id) owned.add(s.material_id);
    for (const r of s.extra_material_refs || []) owned.add(r);
    return false;
  });
}

/**
 * Remove what the dropped cues referenced and nothing now uses. A stable seed re-mints a
 * dropped cue's extras under the same ids, so of several records under one owned id only the
 * freshest (last pushed) is kept.
 */
function sweepOwned(doc, owned) {
  if (!owned.size) return;
  removeUnreferencedMaterials(doc, owned);
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    const last = new Map();
    values.forEach((value, i) => { if (owned.has(value?.id)) last.set(value.id, i); });
    if (!last.size) continue;
    doc.materials[kind] = values.filter((value, i) => !owned.has(value?.id) || last.get(value.id) === i);
  }
}

/**
 * Instantiated from a real CapCut audio segment (Hermes-agent), not invented. An audio
 * clip references speeds / placeholder_infos / beats / sound_channel_mappings /
 * vocal_separations — there is no audio_fades key, and guessing one produces a segment
 * CapCut will not play.
 *
 * `mintFn` lets another module (music) mint ids from ITS transaction seed; ids must be a
 * pure function of (seed, key) or the root and timeline mirrors drift apart.
 */
export function audioSegment(doc, materialId, startS, durationS, key, volume, desc = 'polish:sfx', mintFn = mint) {
  const p = sfxPresets();
  const seg = clone(p.audioSegmentTemplate);
  const refs = [];
  for (const [kind, tpl] of Object.entries(p.audioExtraTemplates)) {
    const m = clone(tpl);
    m.id = mintFn(`${kind}:${key}`);
    if ('bind_segment_id' in m) m.bind_segment_id = '';
    arr(doc, kind).push(m);
    refs.push(m.id);
  }
  seg.id = mintFn(`seg:${key}`);
  seg.material_id = materialId;
  seg.extra_material_refs = refs;
  seg.target_timerange = { start: US(Math.max(0, startS)), duration: US(durationS) };
  seg.source_timerange = { start: 0, duration: US(durationS) };
  seg.volume = volume;
  seg.last_nonzero_volume = volume;
  seg.desc = desc;
  return seg;
}

export function ensureAudioTrack(doc, name, mintFn = mint) {
  let track = doc.tracks.find(t => t.type === 'audio' && t.name === name);
  if (track) return track;
  const tpl = doc.tracks.find(t => t.type === 'audio');
  track = clone(tpl || sfxPresets().audioTrackTemplate);
  track.id = mintFn(`track:${name}`);
  track.name = name;
  track.segments = [];
  track.is_default_name = false;
  doc.tracks.push(track);
  return track;
}

function isLayoutOrPlate(doc, segment, videos = videosById(doc)) {
  if ((segment.desc || '').startsWith('layout:')) return true;
  const m = videos.get(segment.material_id);
  return Boolean(m && m.type && m.type !== 'video');
}

/**
 * The principal track — the one a transition must ride.
 *
 * Measured from Hermes-agent: all 9 of its transitions sit on the talking head, none
 * anywhere else. That track is gapless, starts at zero, and sits above the B-roll so
 * the whole frame wipes together.
 *
 * A cloned Preset 3 endcard after the face used to fail the old "90% of duration"
 * check (40s of face in a 48s draft). A split-screen seam-bar stacked above the
 * face used to WIN it (highest index, gapless, full span). Both are wrong.
 *
 * So: skip plates and layout:* overlays, skip the empty main track, allow a single
 * continuous clip, pick the longest gapless-from-zero video track, and if several
 * share that span, the highest index (the face sits above the B-roll).
 */
export function principalTrack(doc, explicit = null) {
  if (explicit != null) {
    const t = doc.tracks[explicit];
    if (!t || t.type !== 'video') throw new CapcutError(`track ${explicit} is not a video track`, { code: 'BAD_TRACK', exitCode: 2 });
    return { index: explicit, track: t };
  }
  const candidates = [];
  const videos = videosById(doc);
  for (const [index, track] of doc.tracks.entries()) {
    if (track.type !== 'video' || track.flag === 0) continue;
    const segs = [...(track.segments || [])]
      .filter(s => s.target_timerange && !isLayoutOrPlate(doc, s, videos))
      .sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    if (!segs.length) continue;
    let gap = false, cursor = segs[0].target_timerange.start;
    for (const s of segs) {
      if (s.target_timerange.start - cursor > 20000) { gap = true; break; }
      cursor = s.target_timerange.start + s.target_timerange.duration;
    }
    if (gap) continue;
    if (segs[0].target_timerange.start > 20000) continue;
    const span = (cursor - segs[0].target_timerange.start) / 1e6;
    candidates.push({ index, track, span });
  }
  if (!candidates.length) {
    throw new CapcutError(
      'no principal track: no video track is gapless from t=0 (the talking head). '
      + 'Transitions must ride one continuous track or CapCut drops them on load. Pass --track N to override.',
      { code: 'NO_PRINCIPAL_TRACK', exitCode: 2 });
  }
  const longest = Math.max(...candidates.map(c => c.span));
  const top = candidates.filter(c => longest - c.span < 0.05);
  return top.at(-1);
}

/**
 * The principal track when there is one, `null` when there is not.
 *
 * Seams and sweeps are a nice-to-have; transitions are not. `--no-transitions` exists
 * precisely for drafts with no gapless-from-zero video track (B-roll that starts at 2s),
 * so the sweep/no-sweep decision must degrade there instead of throwing. `opPolish` still
 * calls `principalTrack` directly for the transition pass, so a draft that genuinely needs
 * one still fails loudly.
 */
function optionalPrincipal(doc, explicit = null) {
  try {
    return principalTrack(doc, explicit);
  } catch (err) {
    if (err instanceof CapcutError && err.code === 'NO_PRINCIPAL_TRACK') return null;
    throw err;
  }
}

/**
 * The right half's extra materials, so the two halves of a split do not share state.
 *
 * Each ref gets its own id: keyed by bucket alone, a clip with a speed and two effects minted
 * one id for both effects, and the next validation failed CONFLICTING_MATERIAL_ID. A material
 * bound to the old segment is rebound to the new one. A transition is not cloned: it belongs
 * to the segment's END, which the right half now owns, so it moves there.
 */
function cloneRefs(doc, segment, rightId, key) {
  const left = [], right = [], pairs = [];
  for (const [i, ref] of (segment.extra_material_refs || []).entries()) {
    let found = null, bucket = null;
    for (const [k, v] of Object.entries(doc.materials)) {
      if (!Array.isArray(v)) continue;
      const m = v.find(x => x && x.id === ref);
      if (m) { found = m; bucket = k; break; }
    }
    if (!found) { left.push(ref); right.push(ref); continue; }
    if (bucket === 'transitions') { right.push(ref); continue; }
    const copy = clone(found);
    copy.id = mint(`${bucket}:${i}:${ref}:${key}`);
    if ('bind_segment_id' in copy && (copy.bind_segment_id === segment.id || copy.bind_segment_id === '')) {
      copy.bind_segment_id = rightId;
    }
    doc.materials[bucket].push(copy);
    left.push(ref);
    right.push(copy.id);
    pairs.push({ bucket, left: found, right: copy });
  }
  return { left, right, pairs };
}

/**
 * Cut `entry.segment` (on `entry.track`) at absolute `us`, which must lie inside it. The left
 * half keeps the original id; the right half gets `rightId` (or one minted from `key`).
 * Shared by polish and ramp (through `sliceAt`) and by `clip.split`:
 *
 * - the source splits at the speed-scaled offset, so both halves keep the clip's speed;
 * - every extra material is private to its half (`cloneRefs`), a transition moves right;
 * - render_timerange follows target_timerange on each half;
 * - a fade-in stays on the left and a fade-out moves right (each half's other side is zeroed);
 * - an intro animation stays left, an outro moves right with its start measured on the right
 *   half. Combo animations and keyframes are the caller's to refuse.
 */
export function splitSegmentAt(doc, entry, us, key, seed, { rightId = null } = {}) {
  const prev = SEED;
  if (seed !== undefined) SEED = seed;
  try {
    const seg = entry.segment;
    const segs = entry.track.segments;
    const tt = seg.target_timerange, st = seg.source_timerange;
    const offset = us - tt.start;
    const ratio = st && tt.duration ? st.duration / tt.duration : 1;
    const srcOffset = Math.round(offset * ratio);

    const right = clone(seg);
    right.id = rightId || mint(`slice:${key}`);
    const refs = cloneRefs(doc, seg, right.id, `slice:${key}`);
    seg.extra_material_refs = refs.left;
    right.extra_material_refs = refs.right;
    right.target_timerange = { ...tt, start: us, duration: tt.duration - offset };
    if (st) right.source_timerange = { ...st, start: st.start + srcOffset, duration: st.duration - srcOffset };

    tt.duration = offset;
    if (st) st.duration = srcOffset;
    if (seg.render_timerange?.duration) {
      right.render_timerange = { ...seg.render_timerange, start: right.target_timerange.start, duration: right.target_timerange.duration };
      seg.render_timerange = { ...seg.render_timerange, start: tt.start, duration: tt.duration };
    }

    for (const { bucket, left, right: copy } of refs.pairs) {
      if (bucket === 'audio_fades') {
        if ('fade_out_duration' in left) left.fade_out_duration = 0;
        if ('fade_in_duration' in copy) copy.fade_in_duration = 0;
      } else if (bucket === 'material_animations' && Array.isArray(left.animations)) {
        left.animations = left.animations.filter(a => a?.type !== 'out');
        copy.animations = (copy.animations || []).filter(a => a?.type === 'out')
          .map(a => ({ ...a, start: Math.max(0, right.target_timerange.duration - Number(a.duration || 0)) }));
      }
    }

    segs.push(right);
    segs.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    return right;
  } finally {
    if (seed !== undefined) SEED = prev;
  }
}

/**
 * Split the segment straddling `t` (absolute seconds) in two. Returns 'split' when a cut was
 * made, 'existing' when one was already there, false when nothing straddles `t`.
 * Keyframed segments are refused ('keyframed') — their values are anchored to the segment's
 * own timeline and splitting silently rescales the animation. Clips with a native intro/outro
 * animation are refused too ('animated'): both halves would carry it, so the intro replays
 * mid-shot and the outro keeps a start measured from the old, longer clip.
 */
export function sliceAt(doc, track, t, key, seed) {
  const us = US(t);
  const segs = track.segments || [];
  if (segs.some(s => Math.abs(s.target_timerange.start - us) < 20000)) return 'existing';
  const seg = segs.find(s => s.target_timerange.start + 20000 < us
                          && s.target_timerange.start + s.target_timerange.duration - 20000 > us);
  if (!seg) return false;
  if ((seg.common_keyframes || []).some(k => (k.keyframe_list || []).length)) return 'keyframed';
  if (hasClipAnimations(doc, seg)) return 'animated';
  splitSegmentAt(doc, { segment: seg, track }, us, key, seed);
  return 'split';
}

const SPLIT_ID_SEED = 'clip.split.v1';

/**
 * `clip.split`: cut one clip in two at timeline second `at`. Select it by `selector.id`
 * (or `id`), or by `at` + `track`. T snaps to the project's frame grid. Splitting on an
 * existing boundary is a no-op; within one frame of an edge is SPLIT_EDGE. Keyframed clips
 * and combo animations are refused in v1. The left half keeps the id; the right id is a pure
 * function of (id, T), so the root and timeline mirrors agree and a rerun names the same clip.
 */
export function opClipSplit(doc, op = {}) {
  if (op.at == null || !Number.isFinite(Number(op.at)) || Number(op.at) < 0) {
    throw new CapcutError('clip.split requires at SECONDS (timeline).', { code: 'BAD_TIME', exitCode: 2 });
  }
  const id = op.selector?.id || op.id || null;
  const entry = resolveClip(doc, id ? { id: String(id) } : { at: Number(op.at), track: op.track });
  const seg = entry.segment;
  const tt = seg.target_timerange;
  const fps = Number.isFinite(doc.fps) && doc.fps > 0 ? doc.fps : 30;
  const frameUs = 1e6 / fps;
  const us = Math.round(Math.round(Number(op.at) * fps) * frameUs);
  const start = tt.start, end = tt.start + tt.duration;
  const base = { id: seg.id, at: us / 1e6 };
  if (Math.abs(us - start) < frameUs / 2 || Math.abs(us - end) < frameUs / 2) {
    return { changed: 0, ...base, leftId: seg.id, rightId: null, existing: true };
  }
  if (us < start || us > end) {
    throw new CapcutError(`clip.split: ${base.at}s is outside clip ${seg.id} (${start / 1e6}–${end / 1e6}s).`,
      { code: 'SPLIT_OUTSIDE', exitCode: 2 });
  }
  if (us - start < frameUs || end - us < frameUs) {
    throw new CapcutError(`clip.split: ${base.at}s is within one frame of an edge of ${seg.id}; split elsewhere or trim instead.`,
      { code: 'SPLIT_EDGE', exitCode: 2 });
  }
  if ((seg.common_keyframes || []).some(k => (k.keyframe_list || []).length)) {
    throw new CapcutError(`clip.split refuses ${seg.id}: it has keyframes, and splitting would rescale the move. `
      + 'Clear the camera move (keyframe --clear), split, then re-add it on the half that needs it.',
    { code: 'SPLIT_KEYFRAMED', exitCode: 2 });
  }
  const refs = new Set(seg.extra_material_refs || []);
  const animations = (doc.materials?.material_animations || []).filter(m => refs.has(m?.id))
    .flatMap(m => m.animations || []);
  if (animations.some(a => a?.type !== 'in' && a?.type !== 'out')) {
    throw new CapcutError(`clip.split refuses ${seg.id}: it has a combo animation that spans the whole clip.`,
      { code: 'SPLIT_ANIMATED', exitCode: 2 });
  }
  const leftDur = us - start, rightDur = end - us;
  const tooLong = animations.find(a => Number(a.duration || 0) > (a.type === 'in' ? leftDur : rightDur));
  if (tooLong) {
    throw new CapcutError(`clip.split: the ${tooLong.type === 'in' ? 'intro' : 'outro'} animation on ${seg.id} `
      + `is longer than its half after the split.`, { code: 'SPLIT_ANIMATED', exitCode: 2 });
  }
  const rightId = seededId(SPLIT_ID_SEED, `${seg.id}:${us}`);
  if (allSegments(doc).some(e => e.segment.id === rightId)) {
    throw new CapcutError(`clip.split: ${seg.id} was already split at ${base.at}s.`, { code: 'SPLIT_EXISTS', exitCode: 2 });
  }
  splitSegmentAt(doc, entry, us, `split:${seg.id}:${us}`, op.__seed || SPLIT_ID_SEED, { rightId });
  return { changed: 1, ...base, leftId: seg.id, rightId,
    left: { start: start / 1e6, duration: leftDur / 1e6 }, right: { start: us / 1e6, duration: rightDur / 1e6 } };
}

/**
 * Choose a pair per cut. His grammar, measured: a sweep for a layout change, a flash
 * for a jump inside a scene, a glitch when the machine does something. Deterministic —
 * the same timeline always gets the same treatment.
 *
 * Coin/cashier is a success *accent*, not a scene-transition. Wiring it to the last
 * cut made the CTA splice ding like a slot machine.
 */
export function planPolish(doc, opts = {}) {
  const p = sfxPresets();
  let cuts = cutPoints(doc, { minGap: opts.minGap ?? 0.9, projectDir: opts.projectDir ?? null });
  if (opts.motivated) {
    const allowed = pictureChanges(doc, {
      minGap: opts.minGap ?? 0.9,
      track: opts.track ?? null,
      projectDir: opts.projectDir ?? null,
    });
    cuts = cuts.filter(c => allowed.some(a => Math.abs(a.t - c.t) < 0.08));
    // a picture change with no clip-boundary still needs a seam if the principal can be sliced
    for (const a of allowed) {
      if (!cuts.some(c => Math.abs(c.t - a.t) < 0.08)) cuts.push({ t: a.t, weight: 1 });
    }
    cuts.sort((x, y) => x.t - y.t);
  }
  // A sweep means the LAYOUT changed (split-screen <-> full face), which is what
  // `Horizontal Triptych` reads as. Testing for a `layout:seam-bar` segment START was
  // wrong: the seam bar is re-cut at every split-screen B-roll boundary, so every such
  // cut claimed to be a layout change and took a sweep — 8 of 13 seams here, a 62%
  // Horizontal Triptych share against the ~45% ceiling in his hand-cut projects.
  // Compare the actual layout class either side instead.
  const principalT = optionalPrincipal(doc, opts.track ?? null);
  const layoutCtx = { masks: null };
  const layoutChange = t =>
    coveringLayout(doc, t - 0.05, principalT, layoutCtx) !== coveringLayout(doc, t + 0.05, principalT, layoutCtx);

  // A sweep is reserved for a layout change (above), so it does not belong in the
  // generic rotation — drawing sweepL here put Horizontal Triptych on cuts that changed
  // no layout and pushed its share back over the ceiling. `fade` (Black Fade + the click)
  // was defined in sfx.json and never reachable; it is in his top-7 palette, 27 uses
  // across 12 projects.
  const rotate = ['flash', 'glitch', 'whiteflash', 'glitch2', 'flash', 'fade'];
  const plan = [];
  let rot = 0, prev = null, sweepAlt = 0;
  for (const c of cuts) {
    if (opts.only && !opts.only.includes(Math.round(c.t * 100) / 100)) continue;
    let name;
    // A layout change gets a sweep, but ALTERNATE the two sweeps. `sweep` used to be exempt
    // from the never-twice-running rule below, and a video whose every scene changes layout
    // then got the identical Horizontal Triptych + Woosh on every cut — 18 of 24 seams in
    // GrokBuild-20260825. Identical seams are the loudest tell that a machine made the edit.
    if (layoutChange(c.t)) name = ['sweep', 'sweepL'][sweepAlt++ % 2];
    else { name = rotate[rot++ % rotate.length]; }
    if (name === prev) name = name === 'sweep' ? 'sweepL'
                            : name === 'sweepL' ? 'sweep'
                            : rotate[rot++ % rotate.length];               // never twice running
    prev = name;
    plan.push({ ...c, pair: name, ...p.pairs[name] });
  }
  return plan;
}

/** A callout is a still or a GIF he drops on top; footage is never one. */
const PLATE_EXT = /\.(gif|png|webp|apng|jpe?g|heic)$/;

/**
 * Highlight GIFs/PNGs he drops on a UI element: rectangles, arrows, circles.
 * Not the split-screen indigo bar, not the circle-layout white ring, not the logo.
 *
 * The basename is a hint, never the whole test. Matching on it alone put a click on the
 * first frame of any real clip whose file happened to be called `arrow-keys-demo.mp4` — so
 * the file has to BE a still or a GIF as well.
 *
 * Deliberately the extension and not `material.type`, which is how `coveringBroll` tells a
 * plate from a clip: `clip.add` stamps every material it makes `type: 'video'` whatever the
 * file is, so a plate dropped in through capcutctl rather than through CapCut would read as
 * footage and silently lose its click.
 */
export function isCalloutPlate(material, segment) {
  const desc = segment?.desc || '';
  if (desc.startsWith('layout:') || desc.startsWith('sig:')) return false;
  const file = path.basename(material?.path || '').toLowerCase();
  if (!file) return false;
  if (!PLATE_EXT.test(file)) return false;
  if (file.includes('indigo')) return false;
  if (file.includes('suheilai-circle-white')) return false;
  return /arrow|rectangle|^rect-|\bcircle\b/.test(file);
}

export function calloutPlates(doc, { minGap = 0.15, projectDir = null } = {}) {
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const boundaryUs = contentBoundaryUs(doc, projectDir);
  const hits = [];
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video') continue;
    const m = videos.get(segment.material_id);
    if (!isCalloutPlate(m, segment)) continue;
    const tr = segment.target_timerange;
    if (!tr) continue;
    if (!inContent(doc, segment, boundaryUs)) continue;
    hits.push({ t: r2(tr.start / 1e6), file: path.basename(m.path || ''), id: segment.id });
  }
  hits.sort((a, b) => a.t - b.t);
  const out = [];
  for (const h of hits) {
    if (out.length && h.t - out.at(-1).t < minGap) continue;
    out.push(h);
  }
  return out;
}

/** The lane the clicks live on. Deliberately NOT the seam lane — see `opCalloutSfx`. */
const CALLOUT_LANE = 'polish-callout';

/**
 * Enter/click/select on each callout appearance, alternating the two variants.
 * Coincident with the picture — these are clicks, not seam wooshes.
 *
 * On its own lane, because a click and a seam woosh legitimately collide. A callout
 * appearing IS a cut, so `opPolish` has already put a seam cue at [t - lead, t - lead + dur]
 * — a window that always contains t — and dropping the click at t onto the same track
 * produced overlapping segments: two TRACK_OVERLAP warnings from doctor and a state the
 * CapCut UI cannot make on one track. Every polished project with callouts hit it.
 */
export function opCalloutSfx(doc, op = {}, context = {}) {
  SEED = op.__seed || SEED || null;
  const p = sfxPresets();
  const names = p.rules?.calloutSfx || [
    p.accents?.enter, p.accents?.select,
  ].filter(Boolean);
  if (!names.length) {
    throw new CapcutError('no callout SFX configured in presets/sfx.json', { code: 'UNKNOWN_SFX', exitCode: 2 });
  }
  const volume = op.volume ?? p.rules.volume ?? 1;
  const owned = new Set();
  for (const track of doc.tracks) {
    track.segments = dropOwned(track.segments, owned, s => (s.desc || '') === 'polish:callout');
  }
  const projectDir = op.projectDir || context.projectDir || null;
  const plates = calloutPlates(doc, { projectDir });
  if (!plates.length) {
    // do not leave an empty lane behind when the last callout is removed
    doc.tracks = doc.tracks.filter(t => t.name !== CALLOUT_LANE || (t.segments || []).length);
    doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
    sweepOwned(doc, owned);
    return { changed: 0, sfx: 0, cues: [] };
  }
  const lane = ensureAudioTrack(doc, CALLOUT_LANE);
  const cues = [];
  const maxEnd = contentBoundaryUs(doc, projectDir) / 1e6;
  for (const [i, plate] of plates.entries()) {
    const name = names[i % names.length];
    const audioId = ensureAudio(doc, name);
    if (!audioId) continue;                       // sound not cached on this machine
    const tpl = p.audioTemplates[name];
    const dur = Math.min((tpl.duration || US(0.5)) / 1e6, 1.2);
    if (plate.t >= maxEnd) continue;
    // two callouts closer together than the click is long would overlap each other too
    const ceiling = Math.min(maxEnd, plates[i + 1]?.t ?? maxEnd);
    const clipped = Math.max(0.05, Math.min(dur, ceiling - plate.t));
    lane.segments.push(audioSegment(doc, audioId, plate.t, clipped, `callout:${i}:${plate.t}`, volume, 'polish:callout'));
    cues.push({ t: plate.t, sfx: name, file: plate.file });
  }
  lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
  sweepOwned(doc, owned);
  return { changed: cues.length, sfx: cues.length, cues };
}

const INTERACT_LANE = 'polish-interact';
const INTERACT_DESC = /^polish:(click|type)$/;

/** Every on-screen B-roll window, in timeline order. Chopped clips are the map — a click in a skipped source gap has no timeline. */
export function brollWindows(doc, { projectDir = null } = {}) {
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  let principal = null;
  try { principal = optionalPrincipal(doc, null); } catch { /* malformed drafts are still inspectable */ }
  const principalIndex = principal ? principal.index : doc.tracks.length;
  const ctx = planCtx(doc, projectDir);
  const out = [];
  for (const { segment, trackIndex } of allSegments(doc)) {
    const track = doc.tracks[trackIndex];
    if (!isVisibleBroll(doc, segment, track, trackIndex, principalIndex, ctx.videos)) continue;
    if (!inContent(doc, segment, ctx.boundaryUs)) continue;
    const st = segment.source_timerange, tt = segment.target_timerange;
    if (!(tt.duration > 0) || !(st.duration > 0)) continue;
    out.push({
      srcIn: st.start / 1e6,
      srcOut: (st.start + st.duration) / 1e6,
      tgtIn: tt.start / 1e6,
      speed: st.duration / tt.duration,
      path: resolveMediaPath(videos.get(segment.material_id)?.path, projectDir) || videos.get(segment.material_id)?.path || '',
      id: segment.id,
      takeId: segment.source_take_id || segment.rl2_take_id
        || videos.get(segment.material_id)?.source_take_id
        || videos.get(segment.material_id)?.rl2_take_id || null,
    });
  }
  out.sort((a, b) => a.tgtIn - b.tgtIn);
  return out;
}

export function mapVtToTimeline(windows, vt) {
  for (const w of windows) {
    if (vt >= w.srcIn && vt < w.srcOut) return r2(w.tgtIn + (vt - w.srcIn) / w.speed);
  }
  return null;
}

function eventHost(ev) {
  if (Number.isFinite(ev.host)) return ev.host;
  if (Number.isFinite(ev.input_time)) return ev.input_time;
  if (Number.isFinite(ev.start)) return ev.start;
  return null;
}

export function eventVt(ev, session, frames) {
  if (Number.isFinite(ev.vt)) return ev.vt;
  const host = eventHost(ev);
  if (host == null) return null;
  if (frames?.length) {
    let best = frames[0], bestD = Math.abs(frames[0].host - host);
    for (const f of frames) {
      const d = Math.abs(f.host - host);
      if (d < bestD) { best = f; bestD = d; }
    }
    if (Number.isFinite(best.vt)) return best.vt;
  }
  const origin = session?.clock?.first_frame_host ?? session?.start_host;
  if (Number.isFinite(origin)) return host - origin;
  return null;
}

function readNdjson(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a truncated line */ }
  }
  return out;
}

export function findRl2Sessions(projectDir, doc) {
  const dirs = new Set();
  const add = d => {
    if (d && fs.existsSync(path.join(d, 'trace.ndjson'))) dirs.add(d);
  };
  if (projectDir) {
    const root = path.join(projectDir, '.capcutctl', 'rl2');
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) add(path.join(root, name));
    }
  }
  const homes = [
    path.join(os.homedir(), 'Desktop', 'Screen Recordings'),
    path.join(os.homedir(), 'Movies', 'rl2'),
  ];
  for (const m of doc.materials?.videos || []) {
    const p = typeof m.path === 'string' ? m.path : '';
    if (!p) continue;
    // `split('##/', 1)` returns only the FIRST piece, so `[1]` was always undefined and this
    // resolved to the project dir itself — the rl2 trace lookup never saw Resources/.
    const resolved = projectDir ? resolveMediaPath(p, projectDir) : p;
    if (!resolved) continue;
    add(path.dirname(resolved));
    const base = path.basename(p);
    const take = /^(.*)__screen\.mp4$/i.exec(base);
    if (take) for (const home of homes) add(path.join(home, take[1]));
  }
  return [...dirs];
}

export function loadSession(dir) {
  const sessionFile = path.join(dir, 'session.json');
  let session = {};
  if (fs.existsSync(sessionFile)) {
    try { session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch { session = {}; }
  }
  const manifestFile = path.join(dir, 'take.json');
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
        session.capcutctl = {
          ...(session.capcutctl && typeof session.capcutctl === 'object' ? session.capcutctl : {}),
          ...manifest,
        };
      }
    } catch {}
  }
  return {
    dir,
    session,
    parts: takeParts(dir, session),
    sourceTakeId: sessionTakeId(session),
    events: readNdjson(path.join(dir, 'trace.ndjson')),
    frames: readNdjson(path.join(dir, 'frames.ndjson')),
  };
}

/**
 * Map one take-wide vt onto the timeline through the windows cut from the file that holds it.
 * A restarted take is several files on one vt clock; each B-roll window's source time is its
 * own file's clock, so the vt moves to that part's file time first. One-part takes map as before.
 */
export function mapTakeVt(windows, parts, vt) {
  if (!parts || parts.length <= 1) return mapVtToTimeline(windows, vt);
  for (const w of windows) {
    const t = vtInPart(parts, partForMedia(parts, w.path), vt);
    if (t != null && t >= w.srcIn && t < w.srcOut) return r2(w.tgtIn + (t - w.srcIn) / w.speed);
  }
  return null;
}

function sessionTakeId(session) {
  const metadata = session?.capcutctl || session?.capcutCtl || session?.metadata || {};
  return session?.source_take_id || session?.sourceTakeId || metadata.source_take_id
    || metadata.sourceTakeId || null;
}

function sessionSourcePath(session) {
  const metadata = session?.capcutctl || session?.capcutCtl || session?.metadata || {};
  return session?.source_path || session?.sourcePath || metadata.source_path || metadata.sourcePath || null;
}

function sessionLocalizedPath(session) {
  const metadata = session?.capcutctl || session?.capcutCtl || session?.metadata || {};
  return session?.localized_path || session?.localizedPath || metadata.localized_path || metadata.localizedPath || null;
}

/** Associate a trace with its own chopped take before converting source time to timeline time. */
export function windowsForSession(windows, loaded) {
  const { dir, session, sourceTakeId } = loaded;
  if (sourceTakeId) {
    // CapCut drops custom take ids on save; exact recorded paths remain authoritative.
    const paths = [sessionSourcePath(session), sessionLocalizedPath(session)].filter(Boolean).map(p => path.resolve(p));
    return windows.filter(w => w.takeId ? w.takeId === sourceTakeId : paths.includes(path.resolve(w.path || '')));
  }

  // Once any material carries an explicit identity, an unmarked legacy session must not
  // attach to it by a human-readable basename. That is exactly how two `take/screen.mp4`
  // recordings used to cross-wire. Legacy fallback remains available for old, all-unmarked
  // projects.
  const legacyWindows = windows.some(window => window.takeId)
    ? windows.filter(window => !window.takeId)
    : windows;

  const source = sessionSourcePath(session);
  const localized = sessionLocalizedPath(session);
  const normalized = value => {
    try { return path.resolve(String(value)); } catch { return null; }
  };
  const sourcePath = normalized(source);
  const localizedPath = normalized(localized);
  const byPath = legacyWindows.filter(window => {
    const windowPath = normalized(window.path);
    return (localizedPath && windowPath === localizedPath) || (sourcePath && windowPath === sourcePath);
  });
  if (byPath.length) return byPath;

  // Legacy sidecars had no identity. A directory basename is a useful fallback only when it
  // identifies one window; ambiguous same-basename takes must be ignored rather than mapped to
  // the first recording by accident.
  const name = path.basename(dir);
  const byName = legacyWindows.filter(window => path.basename(window.path || '').startsWith(`${name}__`));
  return byName.length === 1 ? byName : [];
}

/**
 * Clicks and typing_bursts from an rl2 take, mapped onto the chopped B-roll.
 * in_capture:false is the recorder's own UI — skip it. A moment that did not survive
 * the B-roll cut has no timeline and is dropped, not guessed onto a neighbour.
 */
export function planInteractions(doc, { projectDir = null, minGap = 0.15 } = {}) {
  const windows = brollWindows(doc, { projectDir });
  if (!windows.length) return [];
  const boundaryUs = contentBoundaryUs(doc, projectDir);
  const cues = [];
  for (const dir of findRl2Sessions(projectDir, doc)) {
    const loaded = loadSession(dir);
    const { session, events, frames, parts } = loaded;
    const sessionWindows = windowsForSession(windows, loaded);
    if (!sessionWindows.length) continue;
    for (const ev of events) {
      const kind = ev.type === 'click' ? 'click'
                 : ev.type === 'typing_burst' ? 'type'
                 : null;
      if (!kind) continue;
      if (kind === 'click' && ev.in_capture === false) continue;
      const vt = eventVt(ev, session, frames);
      if (!Number.isFinite(vt)) continue;
      const t = mapTakeVt(sessionWindows, parts, vt);
      if (t == null) continue;
      if (US(t) >= boundaryUs) continue;
      let dur = 0.3;
      if (kind === 'type') {
        const host0 = eventHost(ev);
        const host1 = Number.isFinite(ev.end) ? ev.end : null;
        if (host0 != null && host1 != null && host1 > host0) dur = Math.min(1.5, host1 - host0);
        else dur = 0.6;
      }
      cues.push({ t: r2(t), kind, dur: r2(dur), vt: r2(vt) });
    }
  }
  cues.sort((a, b) => a.t - b.t);
  const out = [];
  for (const c of cues) {
    if (out.length && c.t - out.at(-1).t < minGap) continue;
    out.push(c);
  }
  return out;
}

export function opInteractions(doc, op = {}, context = {}) {
  SEED = op.__seed || SEED || null;
  if (op.skip) return { changed: 0, sfx: 0, cues: [], skipped: true };
  const p = sfxPresets();
  const volume = op.volume ?? p.rules.volume ?? 1;
  const owned = new Set();
  for (const track of doc.tracks) {
    track.segments = dropOwned(track.segments, owned, s => INTERACT_DESC.test(s.desc || ''));
  }
  const plan = planInteractions(doc, { projectDir: context.projectDir, minGap: op.minGap });
  if (!plan.length) {
    doc.tracks = doc.tracks.filter(t => t.name !== INTERACT_LANE || (t.segments || []).length);
    doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
    sweepOwned(doc, owned);
    return { changed: 0, sfx: 0, cues: [], sessions: findRl2Sessions(context.projectDir, doc).length };
  }
  const lane = ensureAudioTrack(doc, INTERACT_LANE);
  const clickName = p.accents?.click;
  const typeName = p.accents?.typing;
  const cues = [];
  const maxEnd = contentBoundaryUs(doc, context.projectDir) / 1e6;
  for (const [i, hit] of plan.entries()) {
    const name = hit.kind === 'type' ? typeName : clickName;
    if (!name) continue;
    const audioId = ensureAudio(doc, name);
    if (!audioId) continue;                       // sound not cached on this machine
    const tpl = p.audioTemplates[name];
    const fileDur = (tpl.duration || US(0.5)) / 1e6;
    const dur = Math.min(hit.dur || 0.3, fileDur, 1.5);
    if (hit.t >= maxEnd) continue;
    const ceiling = Math.min(maxEnd, plan[i + 1]?.t ?? maxEnd);
    const clipped = Math.max(0.05, Math.min(dur, ceiling - hit.t));
    lane.segments.push(audioSegment(doc, audioId, hit.t, clipped, `interact:${i}:${hit.t}`, volume, `polish:${hit.kind}`));
    cues.push({ t: hit.t, kind: hit.kind, sfx: name, vt: hit.vt });
  }
  lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
  sweepOwned(doc, owned);
  return { changed: cues.length, sfx: cues.length, cues };
}

/**
 * The first audio lane of the `base` family (base, base-2, base-3, …) with nothing over the
 * half-open range [startUs, startUs + durUs). The next lane is created only when every lane
 * is busy. A typing bed and the clicks inside it used to stack on one lane, which CapCut
 * plays as one and doctor reports as TRACK_OVERLAP.
 */
export function pickFreeAudioLane(doc, base, startUs, durUs, mintFn = mint) {
  const endUs = startUs + durUs;
  const busy = track => (track.segments || []).some(segment => {
    const tt = segment.target_timerange;
    return tt && tt.start < endUs && startUs < tt.start + tt.duration;
  });
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const track = doc.tracks.find(t => t.type === 'audio' && t.name === name);
    if (!track) return ensureAudioTrack(doc, name, mintFn);
    if (!busy(track)) return track;
  }
}

/** An audio lane named `base` or `base-N`. */
function laneFamily(base) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:-\\d+)?$`);
}

/** Audio file extensions `sfx --file` takes and `add` refuses. */
export const AUDIO_FILE_EXTENSIONS = Object.freeze(['.wav', '.mp3', '.m4a', '.aac', '.aif', '.aiff', '.flac', '.ogg', '.opus', '.caf']);

/**
 * The material for a local audio file: localized under a content hash, cloned from a
 * harvested sound template with the library identity removed, and typed 'sound' — never
 * 'music', which loudness and duck treat as the bed. A rerun reuses it by path.
 */
function ensureFileAudio(doc, file, context = {}) {
  const source = path.resolve(String(file));
  if (!fs.existsSync(source)) {
    throw new CapcutError(`sfx --file not found: ${file}`, { code: 'SFX_FILE_MISSING', exitCode: 2 });
  }
  const durationS = probeAudioDuration(source);
  const placed = localizeAudioFile(context.projectDir, source, { dryRun: context.dryRun, prefix: 'sfx' });
  const base = path.basename(source);
  const found = (doc.materials.audios || []).find(m => m.path === placed && m.type === 'sound');
  if (found) return { id: found.id, durationS, base, placed, reused: true };
  const templates = Object.values(sfxPresets().audioTemplates);
  const tpl = templates.find(m => m.type === 'sound') || templates.find(m => m.type !== 'music') || templates[0];
  const material = detachLibraryIdentity(clone(tpl));
  material.id = mint(`audio:file:${path.basename(placed)}`);
  material.type = 'sound';
  material.name = base;
  material.path = placed;
  material.duration = US(durationS);
  if ('wave_points' in material) material.wave_points = [];
  arr(doc, 'audios').push(material);
  return { id: material.id, durationS, base, placed, reused: false };
}

function attachFade(doc, segment, fadeIn, fadeOut) {
  if (!(fadeIn > 0) && !(fadeOut > 0)) return null;
  const fade = { type: 'audio_fade', fade_type: 0, fade_in_duration: US(fadeIn || 0), fade_out_duration: US(fadeOut || 0) };
  fade.id = mint(`fade:${segment.id}`);
  arr(doc, 'audio_fades').push(fade);
  segment.extra_material_refs = [...(segment.extra_material_refs || []), fade.id];
  return fade.id;
}

/**
 * Place a named palette sound (`sound`) or a local audio file (`file`) at explicit times:
 * typing under a typed command, an Enter click on the real Enter, a WAV whoosh, a voice patch.
 * Cues are {at, dur?, src?} in timeline seconds; `src` starts inside a long bed such as the
 * one-minute typing recording. `lead` moves every cue earlier. Each cue takes the first free
 * lane of the family (sfx-keys, sfx-keys-2, …; an explicit `track` spills to <track>-2), so
 * overlapping cues never stack on one lane. A cue identical to one already placed (same
 * sound, start, length and source offset) is skipped and reported, not duplicated.
 */
export function opSfxPlace(doc, op = {}, context = {}) {
  SEED = op.__seed || SEED || null;
  const p = sfxPresets();
  const hasSound = op.sound != null && op.sound !== '';
  const hasFile = op.file != null && op.file !== '';
  if (hasSound === hasFile) {
    throw new CapcutError('sfx takes exactly one of --sound NAME or --file PATH.', { code: 'SFX_SOURCE', exitCode: 2 });
  }
  if (!Array.isArray(op.cues) || !op.cues.length) throw new CapcutError('sfx needs --cues AT[:DUR[:SRC]],…', { code: 'SFX_NO_CUES', exitCode: 2 });
  let audioId, fileDur, name, desc, file = null;
  if (hasFile) {
    const local = ensureFileAudio(doc, op.file, context);
    audioId = local.id;
    fileDur = local.durationS;
    name = local.base;
    desc = `sfx:file:${local.base}`;
    file = { path: local.placed, reused: local.reused };
  } else {
    name = p.accents?.[op.sound] || (p.audioTemplates[op.sound] ? op.sound : null);
    if (!name) {
      throw new CapcutError(`sfx: unknown sound "${op.sound}". Use ${Object.keys(p.accents || {}).join(', ')} or a palette name from presets/sfx.json.`, { code: 'UNKNOWN_SFX', exitCode: 2 });
    }
    audioId = ensureAudio(doc, name);
    if (!audioId) throw new CapcutError(`sfx: "${name}" is not cached on this machine; open it once in CapCut or pick another sound.`, { code: 'SFX_UNAVAILABLE', exitCode: 2 });
    fileDur = (p.audioTemplates[name].duration || US(0.5)) / 1e6;
    desc = `sfx:${op.sound}`;
  }
  const base = String(op.track || 'sfx-keys');
  const volume = op.volume ?? p.rules?.volume ?? 1;
  const lead = Number(op.lead ?? 0);
  if (!Number.isFinite(lead) || lead < 0) throw new CapcutError('sfx --lead must be a nonnegative number of seconds.', { code: 'BAD_NUMBER', exitCode: 2 });
  const family = laneFamily(base);
  const familySegments = () => doc.tracks.filter(t => t.type === 'audio' && family.test(t.name || ''))
    .flatMap(t => t.segments || []);
  const touched = new Set();
  const lanes = [];
  const duplicates = [];
  let placed = 0;
  for (const [i, cue] of op.cues.entries()) {
    const src = Math.max(0, Number(cue.src) || 0);
    const dur = Math.min(Number(cue.dur) || fileDur, fileDur - src);
    if (!(Number.isFinite(cue.at) && cue.at >= 0 && dur > 0)) throw new CapcutError(`sfx cue ${i} is out of range: ${JSON.stringify(cue)}`, { code: 'SFX_BAD_CUE', exitCode: 2 });
    const at = Math.max(0, cue.at - lead);
    const startUs = US(at), durUs = US(dur), srcUs = US(src);
    const twin = familySegments().find(s => s.material_id === audioId && s.target_timerange?.start === startUs
      && s.target_timerange?.duration === durUs && (s.source_timerange?.start ?? 0) === srcUs);
    if (twin) { duplicates.push({ at: Math.round(at * 1000) / 1000, id: twin.id, code: 'SFX_DUPLICATE' }); continue; }
    const lane = pickFreeAudioLane(doc, base, startUs, durUs);
    const seg = audioSegment(doc, audioId, at, dur, `sfx-place:${name}:${i}:${cue.at}`, volume, desc);
    seg.source_timerange = { start: srcUs, duration: durUs };
    attachFade(doc, seg, Number(op.fadeIn) || 0, Number(op.fadeOut) || 0);
    lane.segments.push(seg);
    touched.add(lane);
    if (!lanes.includes(lane.name)) lanes.push(lane.name);
    placed++;
  }
  for (const lane of touched) lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
  return {
    changed: placed, sfx: name, track: lanes[0] || base, tracks: lanes,
    ...(file ? { file } : {}),
    ...(duplicates.length ? { skipped: duplicates } : {}),
  };
}

/**
 * First seconds are full-face with nothing on screen. His recut of the Hermes Telegram
 * open replaced that with split-screen proof. Flag it; do not invent the B-roll.
 */
export function coldOpen(doc, { seconds = 5, projectDir = null } = {}) {
  const principal = optionalPrincipal(doc, null);
  if (!principal) return null;
  const t0 = (principal.track.segments[0]?.target_timerange?.start || 0) / 1e6;
  const ctx = planCtx(doc, projectDir);
  const contentEnd = ctx.boundaryUs / 1e6;
  const sampleEnd = Math.min(t0 + seconds, contentEnd);
  let n = 0, covered = 0;
  for (let t = t0 + 0.2; t < sampleEnd; t += 0.5) {
    n++;
    if (coveringBroll(doc, t, principal.index, ctx)) covered++;
  }
  if (!n) return null;
  if (covered / n >= 0.5) return null;
  const layout = coveringLayout(doc, t0 + 0.25, principal, ctx);
  if (layout !== 'full-face') return null;
  return { seconds: Math.min(seconds, Math.max(0, sampleEnd - t0)), layout, covered, samples: n };
}

/**
 * How lopsided is the seam vocabulary? His hand-cut projects keep any one transition under
 * ~45% of cuts (Hermes-agent 4/9, Higgsfield 2/6); the unaided CLI hit 18/24 on one name.
 * Reported, never enforced — a short video legitimately has few cuts to vary.
 */
export function seamVariety(plan) {
  const byTransition = new Map();
  for (const cue of plan) {
    const name = cue.transition || cue.pair;
    byTransition.set(name, (byTransition.get(name) || 0) + 1);
  }
  const total = plan.length;
  const top = [...byTransition.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return {
    cuts: total,
    distinct: byTransition.size,
    top: top[0],
    topShare: total ? Math.round((top[1] / total) * 100) / 100 : 0,
    lopsided: total >= 6 && top[1] / total > 0.45
  };
}

/**
 * Take back what an earlier polish pass placed, without planning a new one: its SFX cues
 * (polish:sfx/callout/click/type) and only the transitions named in `only` (build records the
 * ids it placed, so a transition the user added by hand survives). The slices it cut into the
 * principal track stay: they are invisible without a transition. For `seams: false`.
 */
function prunePolish(doc, op) {
  const only = new Set(op.only || []);
  let removedSfx = 0;
  const owned = new Set();
  for (const track of doc.tracks) {
    const before = (track.segments || []).length;
    track.segments = (track.segments || []).filter(s => {
      if (!/^polish:(sfx|callout|click|type)$/.test(s.desc || '')) return true;
      if (s.material_id) owned.add(s.material_id);
      for (const r of s.extra_material_refs || []) owned.add(r);
      return false;
    });
    removedSfx += before - track.segments.length;
  }
  const present = new Set((doc.materials.transitions || []).map(m => m.id));
  const removedTransitions = [...only].filter(id => present.has(id));
  for (const { segment } of allSegments(doc)) {
    segment.extra_material_refs = (segment.extra_material_refs || []).filter(r => !only.has(r));
  }
  doc.materials.transitions = (doc.materials.transitions || []).filter(m => !only.has(m.id));
  doc.tracks = doc.tracks.filter(t => t.name !== 'polish-sfx' || (t.segments || []).length);
  removeUnreferencedMaterials(doc, owned);
  return { changed: removedSfx + removedTransitions.length, pruned: true, removedTransitions: removedTransitions.length,
    removedSfx, transitionsUnknown: [...only].filter(id => !present.has(id)).length };
}

export function opPolish(doc, op, context = {}) {
  if (op.prune) return prunePolish(doc, op);
  SEED = op.__seed || null;
  const p = sfxPresets();
  const lead = op.lead ?? p.rules.sfxLeadSeconds;
  const volume = op.volume ?? p.rules.volume;
  const ownsCue = s => /^polish:/.test(s.desc || '');
  const levels = snapshotLevels(doc, ownsCue);

  // start clean so re-running is idempotent; what the dropped cues owned is swept at the end
  const owned = new Set();
  for (const track of doc.tracks) {
    track.segments = dropOwned(track.segments, owned, s => (s.desc || '') === 'polish:sfx'
      || (op.noSfx && /^polish:(callout|click|type)$/.test(s.desc || '')));
    for (const s of track.segments || []) {
      if (Array.isArray(s.extra_material_refs) && s.__polishTransition) delete s.__polishTransition;
    }
  }
  const ownership = clearOwnedTransitions(doc, context.projectDir);

  let plan = planPolish(doc, { ...op, motivated: Boolean(op.motivated), projectDir: context.projectDir });
  const lane = op.noSfx ? null : ensureAudioTrack(doc, 'polish-sfx');

  // Every transition rides the principal track, and the principal track gets sliced to
  // make room. This is the Hermes-agent rule: the transition belongs to the layer above
  // the B-roll so the whole frame wipes together, and it needs a clip on *both* sides —
  // a transition on a segment with nothing after it is silently discarded by CapCut.
  const principal = op.noTransitions ? null : principalTrack(doc, op.track ?? null);
  const slices = { split: 0, existing: 0, refused: [], animated: [] };
  if (principal) {
    for (const [i, cue] of plan.entries()) {
      const r = sliceAt(doc, principal.track, cue.t, `${i}:${cue.t}`);
      if (r === 'split') slices.split++;
      else if (r === 'existing') slices.existing++;
      else if (r === 'keyframed') slices.refused.push(cue.t);
      else if (r === 'animated') { slices.refused.push(cue.t); slices.animated.push(cue.t); }
    }
  }

  // A seam the user already dressed by hand keeps its own transition, and gets no second
  // transition or woosh from polish on top of it.
  const seamKeptByHand = [];
  if (principal && ownership.kept.size) {
    const segs = principal.track.segments;
    plan = plan.filter(cue => {
      const at = segs.findIndex(s =>
        Math.abs((s.target_timerange.start + s.target_timerange.duration) / 1e6 - cue.t) < 0.05);
      const hand = at >= 0 && (segs[at].extra_material_refs || []).some(r => ownership.kept.has(r));
      if (hand) seamKeptByHand.push(cue.t);
      return !hand;
    });
  }

  let transitions = 0;
  let sfxPlaced = 0;
  const skipped = [];
  resetUnavailableSfx();
  const maxEnd = contentBoundaryUs(doc, context.projectDir) / 1e6;
  for (const [i, cue] of plan.entries()) {
    if (principal) {
      const segs = principal.track.segments;
      const at = segs.findIndex(s =>
        Math.abs((s.target_timerange.start + s.target_timerange.duration) / 1e6 - cue.t) < 0.05);
      // no clip after the boundary => CapCut drops the transition on load, so do not write one
      if (at >= 0 && at < segs.length - 1) {
        const id = makeTransition(doc, cue.transition, cue.duration, `${i}:${cue.t}`);
        if (id) {
          segs[at].extra_material_refs = [...(segs[at].extra_material_refs || []), id];
          transitions++;
        }
      } else {
        skipped.push(cue.t);
      }
    }
    if (op.noSfx) continue;
    const audioId = ensureAudio(doc, cue.sfx);
    if (!audioId) continue;                       // sound not cached on this machine
    const tpl = p.audioTemplates[cue.sfx];
    const dur = Math.min((tpl.duration || US(0.5)) / 1e6, 1.2);
    const start = Math.max(0, cue.t - lead);
    if (start >= maxEnd) continue;
    const clipped = Math.max(0.05, Math.min(dur, maxEnd - start));
    lane.segments.push(audioSegment(doc, audioId, start, clipped, `${i}:${cue.t}`, volume));
    sfxPlaced++;
  }
  lane?.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  const callouts = op.noSfx ? { cues: [] }
    : opCalloutSfx(doc, { volume, __seed: op.__seed, projectDir: context.projectDir });
  const interactions = opInteractions(doc, { volume, __seed: op.__seed, skip: op.noSfx || op.noInteractions }, context);
  const unavailable = unavailableSfx();
  // a cue re-placed on the same beat keeps the volume and fade it was given in CapCut
  SEED = op.__seed || null;
  const carried = carryLevels(doc, levels, { owns: ownsCue, tolerance: 0.25, mint: key => mint(`carry:${key}`),
    keepVolume: () => op.volume == null });
  sweepOwned(doc, owned);
  return { changed: plan.length, transitions, removedTransitions: ownership.removed, sfx: sfxPlaced,
           keptHandTransitions: ownership.kept.size,
           ...(ownership.legacyClearAll ? { legacyClearAll: true } : {}),
           ...(seamKeptByHand.length ? { seamKeptByHand } : {}),
           // keepExisting is deprecated: hand-made transitions are always kept now, and keeping
           // polish's own as well only stacked a second transition on every seam.
           ...(op.keepExisting ? { deprecated: ['keepExisting'] } : {}),
           ...(carried.length ? { carried } : {}),
           // Named, not silent: a palette entry whose CapCut cache file is not on this machine
           // is skipped rather than written as a broken reference. `capcutctl harvest` after
           // downloading the same sounds in CapCut re-points them.
           ...(unavailable.length ? { unavailableSfx: unavailable } : {}),
           principalTrack: principal ? principal.index : null,
           variety: seamVariety(plan),
           sliced: slices.split, alreadyCut: slices.existing,
           callouts: callouts.cues,
           interactions: interactions.cues,
           ...(slices.refused.length ? { keyframedSoNotSliced: slices.refused } : {}),
           ...(slices.animated.length ? { animatedSoNotSliced: slices.animated } : {}),
           ...(skipped.length ? { noTransition: skipped } : {}),
           cues: plan.map(c => ({ t: c.t, pair: c.pair, transition: c.transition, sfx: c.sfx })) };
}
