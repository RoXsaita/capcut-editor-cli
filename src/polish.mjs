import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CapcutError, clone, seededId, allSegments, loadPreset, resolveMediaPath, contentEndUs
} from './core.mjs';

export function sfxPresets() {
  return loadPreset('sfx');
}

let SEED = null;
const mint = key => seededId(SEED, key);

const US = s => Math.round(s * 1e6);
const arr = (doc, kind) => (doc.materials[kind] ||= []);

const SCREEN_RECORDING_DESC = 'layout:screen-recording';

/** Generated screen decorations are not independent footage or callout plates. */
function isScreenHelper(segment) {
  const desc = String(segment?.desc || '');
  return desc.startsWith('layout:') && desc !== SCREEN_RECORDING_DESC;
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

function inContent(doc, segment, projectDir = null) {
  const start = Number(segment?.target_timerange?.start);
  return Number.isFinite(start) && start < contentBoundaryUs(doc, projectDir);
}

function isVisibleBroll(doc, segment) {
  const desc = String(segment?.desc || '');
  if (isScreenHelper(segment) || desc.startsWith('sig:')) return false;
  const material = (doc.materials?.videos || []).find(item => item.id === segment.material_id);
  if (!material) return false;
  if (material.type && material.type !== 'video') return false;
  const file = String(material.path || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic)$/.test(file)) return false;
  return Boolean(segment.source_timerange && segment.target_timerange);
}

function r2(n) { return Math.round(n * 100) / 100; }

function coveringBroll(doc, t, principalIndex, projectDir = null) {
  const us = US(t);
  if (us < 0 || us >= contentBoundaryUs(doc, projectDir)) return null;
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  for (let i = 0; i < principalIndex; i++) {
    const track = doc.tracks[i];
    if (!track || track.type !== 'video' || track.flag === 0) continue;
    for (const s of track.segments || []) {
      if (!s.target_timerange) continue;
      if (!isVisibleBroll(doc, s) || !inContent(doc, s, projectDir)) continue;
      const a = s.target_timerange.start, b = a + s.target_timerange.duration;
      if (a - 20000 < us && us < b - 20000) {
        const m = videos.get(s.material_id);
        const sr = s.source_timerange || {};
        const cl = s.clip || {};
        return {
          desc: s.desc || '', path: m?.path || '', id: s.id,
          scale: cl.scale?.x ?? 1, tx: cl.transform?.x ?? 0, ty: cl.transform?.y ?? 0,
          srcStart: (sr.start || 0) / 1e6,
          srcEnd: ((sr.start || 0) + (sr.duration || 0)) / 1e6,
        };
      }
    }
  }
  return null;
}

function coveringLayout(doc, t, principal) {
  if (!principal) return 'none';
  const us = US(t);
  const masks = new Map((doc.materials?.common_mask || []).map(m => [m.id, m]));
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
  const marks = [];
  const seen = new Set();
  for (const { segment, track: tr } of allSegments(doc)) {
    if (tr.type !== 'video' || !(tr.segments || []).length) continue;
    if (isScreenHelper(segment) || !inContent(doc, segment, projectDir)) continue;
    const t = segment.target_timerange.start / 1e6;
    if (t <= 0.001) continue;
    const key = Math.round(t * 30) / 30;
    if (seen.has(key)) continue;
    seen.add(key);
    const beforeB = coveringBroll(doc, t - 0.05, brollBelow, projectDir);
    const afterB = coveringBroll(doc, t + 0.05, brollBelow, projectDir);
    const beforeL = coveringLayout(doc, t - 0.05, principal);
    const afterL = coveringLayout(doc, t + 0.05, principal);
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
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video' || !(track.segments || []).length) continue;
    const desc = segment.desc || '';
    if (isScreenHelper(segment) || !inContent(doc, segment, projectDir)) continue;
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
function ensureAudio(doc, name) {
  const p = sfxPresets();
  const tpl = p.audioTemplates[name];
  if (!tpl) throw new CapcutError(`unknown sfx "${name}". Known: ${Object.keys(p.audioTemplates).join(', ')}`, { code: 'UNKNOWN_SFX', exitCode: 2 });
  const found = (doc.materials.audios || []).find(m => m.name === name);
  if (found) return found.id;
  if (!templateIsAvailable(tpl)) { UNAVAILABLE.add(name); return null; }
  const m = clone(tpl);
  m.id = mint(`audio:${name}`);
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
  arr(doc, 'transitions').push(m);
  return m.id;
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

function isLayoutOrPlate(doc, segment) {
  if ((segment.desc || '').startsWith('layout:')) return true;
  const mats = doc.materials?.videos || [];
  const m = mats.find(x => x.id === segment.material_id);
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
  for (const [index, track] of doc.tracks.entries()) {
    if (track.type !== 'video' || track.flag === 0) continue;
    const segs = [...(track.segments || [])]
      .filter(s => s.target_timerange && !isLayoutOrPlate(doc, s))
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

/** Clone a segment's extra materials so the two halves of a split do not share state. */
function cloneRefs(doc, segment, key) {
  const out = [];
  for (const ref of segment.extra_material_refs || []) {
    let found = null, bucket = null;
    for (const [k, v] of Object.entries(doc.materials)) {
      if (!Array.isArray(v)) continue;
      const m = v.find(x => x && x.id === ref);
      if (m) { found = m; bucket = k; break; }
    }
    if (!found) { out.push(ref); continue; }
    const copy = clone(found);
    copy.id = mint(`${bucket}:${key}`);
    doc.materials[bucket].push(copy);
    out.push(copy.id);
  }
  return out;
}

/**
 * Split the segment straddling `t` (absolute seconds) in two. Returns true if a cut was
 * made or already existed. Keyframed segments are refused — their values are anchored to
 * the segment's own timeline and splitting silently rescales the animation.
 */
export function sliceAt(doc, track, t, key) {
  const us = US(t);
  const segs = track.segments || [];
  if (segs.some(s => Math.abs(s.target_timerange.start - us) < 20000)) return 'existing';
  const seg = segs.find(s => s.target_timerange.start + 20000 < us
                          && s.target_timerange.start + s.target_timerange.duration - 20000 > us);
  if (!seg) return false;
  if ((seg.common_keyframes || []).some(k => (k.keyframe_list || []).length)) return 'keyframed';

  const tt = seg.target_timerange, st = seg.source_timerange;
  const offset = us - tt.start;
  const ratio = st && tt.duration ? st.duration / tt.duration : 1;
  const srcOffset = Math.round(offset * ratio);

  const right = clone(seg);
  right.id = mint(`slice:${key}`);
  right.extra_material_refs = cloneRefs(doc, seg, `slice:${key}`);
  right.target_timerange = { ...tt, start: us, duration: tt.duration - offset };
  if (st) right.source_timerange = { ...st, start: st.start + srcOffset, duration: st.duration - srcOffset };

  tt.duration = offset;
  if (st) st.duration = srcOffset;

  segs.push(right);
  segs.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  return 'split';
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
  const layoutChange = t =>
    coveringLayout(doc, t - 0.05, principalT) !== coveringLayout(doc, t + 0.05, principalT);

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
  const hits = [];
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video') continue;
    const m = videos.get(segment.material_id);
    if (!isCalloutPlate(m, segment)) continue;
    const tr = segment.target_timerange;
    if (!tr) continue;
    if (!inContent(doc, segment, projectDir)) continue;
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
  for (const track of doc.tracks) {
    track.segments = (track.segments || []).filter(s => (s.desc || '') !== 'polish:callout');
  }
  const projectDir = op.projectDir || context.projectDir || null;
  const plates = calloutPlates(doc, { projectDir });
  if (!plates.length) {
    // do not leave an empty lane behind when the last callout is removed
    doc.tracks = doc.tracks.filter(t => t.name !== CALLOUT_LANE || (t.segments || []).length);
    doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
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
  return { changed: cues.length, sfx: cues.length, cues };
}

const INTERACT_LANE = 'polish-interact';
const INTERACT_DESC = /^polish:(click|type)$/;

function isBrollFootage(doc, segment) {
  return isVisibleBroll(doc, segment);
}

/** Every on-screen B-roll window, in timeline order. Chopped clips are the map — a click in a skipped source gap has no timeline. */
export function brollWindows(doc, { projectDir = null } = {}) {
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  let principal = null;
  try { principal = optionalPrincipal(doc, null); } catch { /* malformed drafts are still inspectable */ }
  const brollCeiling = principal ? principal.index : doc.tracks.length;
  const out = [];
  for (const { segment, trackIndex } of allSegments(doc)) {
    const track = doc.tracks[trackIndex];
    if (!track || track.type !== 'video' || track.flag === 0) continue;
    if (trackIndex >= brollCeiling) continue;
    if (!isBrollFootage(doc, segment)) continue;
    if (!inContent(doc, segment, projectDir)) continue;
    const st = segment.source_timerange, tt = segment.target_timerange;
    if (!(tt.duration > 0) || !(st.duration > 0)) continue;
    out.push({
      srcIn: st.start / 1e6,
      srcOut: (st.start + st.duration) / 1e6,
      tgtIn: tt.start / 1e6,
      speed: st.duration / tt.duration,
      path: videos.get(segment.material_id)?.path || '',
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

function eventVt(ev, session, frames) {
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

function loadSession(dir) {
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
    sourceTakeId: sessionTakeId(session),
    events: readNdjson(path.join(dir, 'trace.ndjson')),
    frames: readNdjson(path.join(dir, 'frames.ndjson')),
  };
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
function windowsForSession(windows, loaded) {
  const { dir, session, sourceTakeId } = loaded;
  if (sourceTakeId) return windows.filter(window => window.takeId === sourceTakeId);

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
  const cues = [];
  for (const dir of findRl2Sessions(projectDir, doc)) {
    const loaded = loadSession(dir);
    const { session, events, frames } = loaded;
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
      const t = mapVtToTimeline(sessionWindows, vt);
      if (t == null) continue;
      if (US(t) >= contentBoundaryUs(doc, projectDir)) continue;
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
  for (const track of doc.tracks) {
    track.segments = (track.segments || []).filter(s => !INTERACT_DESC.test(s.desc || ''));
  }
  const plan = planInteractions(doc, { projectDir: context.projectDir, minGap: op.minGap });
  if (!plan.length) {
    doc.tracks = doc.tracks.filter(t => t.name !== INTERACT_LANE || (t.segments || []).length);
    doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
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
  return { changed: cues.length, sfx: cues.length, cues };
}

/**
 * First seconds are full-face with nothing on screen. His recut of the Hermes Telegram
 * open replaced that with split-screen proof. Flag it; do not invent the B-roll.
 */
export function coldOpen(doc, { seconds = 5, projectDir = null } = {}) {
  const principal = optionalPrincipal(doc, null);
  if (!principal) return null;
  const t0 = (principal.track.segments[0]?.target_timerange?.start || 0) / 1e6;
  const contentEnd = contentBoundaryUs(doc, projectDir) / 1e6;
  const sampleEnd = Math.min(t0 + seconds, contentEnd);
  let n = 0, covered = 0;
  for (let t = t0 + 0.2; t < sampleEnd; t += 0.5) {
    n++;
    if (coveringBroll(doc, t, principal.index, projectDir)) covered++;
  }
  if (!n) return null;
  if (covered / n >= 0.5) return null;
  const layout = coveringLayout(doc, t0 + 0.25, principal);
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

export function opPolish(doc, op, context = {}) {
  SEED = op.__seed || null;
  const p = sfxPresets();
  const lead = op.lead ?? p.rules.sfxLeadSeconds;
  const volume = op.volume ?? p.rules.volume;

  // start clean so re-running is idempotent
  for (const track of doc.tracks) {
    track.segments = (track.segments || []).filter(s => (s.desc || '') !== 'polish:sfx');
    for (const s of track.segments || []) {
      if (Array.isArray(s.extra_material_refs) && s.__polishTransition) delete s.__polishTransition;
    }
  }
  // Polish owns the transitions. It cannot mark its own — CapCut strips unknown keys such as
  // __polish on the next save, so a marker-based cleanup silently duplicates on the second
  // run. So every transition is cleared and rebuilt from the plan, which is deterministic:
  // the same timeline always yields the same set. Pass keepExisting to leave hand-made ones.
  let removed = 0;
  if (!op.keepExisting) {
    const priorTransitions = new Set((doc.materials.transitions || []).map(m => m.id));
    removed = priorTransitions.size;
    for (const { segment } of allSegments(doc)) {
      segment.extra_material_refs = (segment.extra_material_refs || []).filter(r => !priorTransitions.has(r));
    }
    doc.materials.transitions = [];
  }

  const plan = planPolish(doc, { ...op, motivated: Boolean(op.motivated), projectDir: context.projectDir });
  const lane = ensureAudioTrack(doc, 'polish-sfx');

  // Every transition rides the principal track, and the principal track gets sliced to
  // make room. This is the Hermes-agent rule: the transition belongs to the layer above
  // the B-roll so the whole frame wipes together, and it needs a clip on *both* sides —
  // a transition on a segment with nothing after it is silently discarded by CapCut.
  const principal = op.noTransitions ? null : principalTrack(doc, op.track ?? null);
  const slices = { split: 0, existing: 0, refused: [] };
  if (principal) {
    for (const [i, cue] of plan.entries()) {
      const r = sliceAt(doc, principal.track, cue.t, `${i}:${cue.t}`);
      if (r === 'split') slices.split++;
      else if (r === 'existing') slices.existing++;
      else if (r === 'keyframed') slices.refused.push(cue.t);
    }
  }

  let transitions = 0;
  let sfxPlaced = 0;
  const skipped = [];
  resetUnavailableSfx();
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
    const audioId = ensureAudio(doc, cue.sfx);
    if (!audioId) continue;                       // sound not cached on this machine
    const tpl = p.audioTemplates[cue.sfx];
    const dur = Math.min((tpl.duration || US(0.5)) / 1e6, 1.2);
    const start = Math.max(0, cue.t - lead);
    const maxEnd = contentBoundaryUs(doc, context.projectDir) / 1e6;
    if (start >= maxEnd) continue;
    const clipped = Math.max(0.05, Math.min(dur, maxEnd - start));
    lane.segments.push(audioSegment(doc, audioId, start, clipped, `${i}:${cue.t}`, volume));
    sfxPlaced++;
  }
  lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  const callouts = opCalloutSfx(doc, { volume, __seed: op.__seed, projectDir: context.projectDir });
  const interactions = opInteractions(doc, { volume, __seed: op.__seed, skip: op.noInteractions }, context);
  const unavailable = unavailableSfx();
  return { changed: plan.length, transitions, removedTransitions: removed, sfx: sfxPlaced,
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
           ...(skipped.length ? { noTransition: skipped } : {}),
           cues: plan.map(c => ({ t: c.t, pair: c.pair, transition: c.transition, sfx: c.sfx })) };
}
