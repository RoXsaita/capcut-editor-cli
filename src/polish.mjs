import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapcutError, clone, uuid, allSegments } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let SFX = null;
export function sfxPresets() {
  if (!SFX) SFX = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'presets', 'sfx.json'), 'utf8'));
  return SFX;
}

let SEED = null;
function mint(key) {
  if (!SEED) return uuid();
  const h = crypto.createHash('sha256').update(`${SEED}|${key}`).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const US = s => Math.round(s * 1e6);
const arr = (doc, kind) => (doc.materials[kind] ||= []);

/** Cut points that a viewer actually sees: a scene change on any visual track. */
export function cutPoints(doc, { minGap = 0.9 } = {}) {
  const marks = new Map();
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video' || !(track.segments || []).length) continue;
    const desc = segment.desc || '';
    if (desc.startsWith('layout:')) continue;              // bars and plates are not cuts
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

/** Ensure a named SFX / transition material exists; return its id. */
function ensureAudio(doc, name) {
  const p = sfxPresets();
  const tpl = p.audioTemplates[name];
  if (!tpl) throw new CapcutError(`unknown sfx "${name}". Known: ${Object.keys(p.audioTemplates).join(', ')}`, { code: 'UNKNOWN_SFX', exitCode: 2 });
  const found = (doc.materials.audios || []).find(m => m.name === name);
  if (found) return found.id;
  const m = clone(tpl);
  m.id = mint(`audio:${name}`);
  arr(doc, 'audios').push(m);
  return m.id;
}

function makeTransition(doc, name, durationS, key) {
  const p = sfxPresets();
  const tpl = p.transitionTemplates[name];
  if (!tpl) throw new CapcutError(`unknown transition "${name}"`, { code: 'UNKNOWN_TRANSITION', exitCode: 2 });
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
 */
function audioSegment(doc, materialId, startS, durationS, key, volume) {
  const p = sfxPresets();
  const seg = clone(p.audioSegmentTemplate);
  const refs = [];
  for (const [kind, tpl] of Object.entries(p.audioExtraTemplates)) {
    const m = clone(tpl);
    m.id = mint(`${kind}:${key}`);
    if ('bind_segment_id' in m) m.bind_segment_id = '';
    arr(doc, kind).push(m);
    refs.push(m.id);
  }
  seg.id = mint(`seg:${key}`);
  seg.material_id = materialId;
  seg.extra_material_refs = refs;
  seg.target_timerange = { start: US(Math.max(0, startS)), duration: US(durationS) };
  seg.source_timerange = { start: 0, duration: US(durationS) };
  seg.volume = volume;
  seg.last_nonzero_volume = volume;
  seg.desc = 'polish:sfx';
  return seg;
}

function ensureAudioTrack(doc, name) {
  let track = doc.tracks.find(t => t.type === 'audio' && t.name === name);
  if (track) return track;
  const tpl = doc.tracks.find(t => t.type === 'audio');
  track = clone(tpl || sfxPresets().audioTrackTemplate);
  track.id = mint(`track:${name}`);
  track.name = name;
  track.segments = [];
  doc.tracks.push(track);
  return track;
}

/**
 * The principal track — the one a transition must ride.
 *
 * Measured from Hermes-agent, which is the reference for layering: all 9 of its
 * transitions sit on track[4], the talking head, and none anywhere else. That track is
 * the only video track that is gapless and spans the whole timeline, and it is sliced at
 * every visible cut *even where the face content is continuous*, purely so the transition
 * has a boundary to live on. Because it sits above the screen recording, everything under
 * it inherits the wipe; a transition placed on the B-roll instead dissolves underneath a
 * face that hard-cuts.
 *
 * So: gapless, spans the timeline, highest index among the candidates.
 */
export function principalTrack(doc, explicit = null) {
  if (explicit != null) {
    const t = doc.tracks[explicit];
    if (!t || t.type !== 'video') throw new CapcutError(`track ${explicit} is not a video track`, { code: 'BAD_TRACK', exitCode: 2 });
    return { index: explicit, track: t };
  }
  const total = (doc.duration || 0) / 1e6;
  const candidates = [];
  for (const [index, track] of doc.tracks.entries()) {
    if (track.type !== 'video') continue;
    const segs = [...(track.segments || [])].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    if (segs.length < 2) continue;
    let gap = false, cursor = segs[0].target_timerange.start;
    for (const s of segs) {
      if (s.target_timerange.start - cursor > 20000) { gap = true; break; }   // 20ms slack
      cursor = s.target_timerange.start + s.target_timerange.duration;
    }
    if (gap) continue;
    const span = (cursor - segs[0].target_timerange.start) / 1e6;
    if (segs[0].target_timerange.start > 20000) continue;                     // must start at zero
    if (total && span < total * 0.9) continue;
    candidates.push({ index, track, span });
  }
  if (!candidates.length) {
    throw new CapcutError(
      'no principal track: no video track is gapless and spans the timeline. Transitions must ride '
      + 'one continuous track (the talking head) or CapCut drops them on load. Pass --track N to override.',
      { code: 'NO_PRINCIPAL_TRACK', exitCode: 2 });
  }
  return candidates.at(-1);                                                   // highest index wins
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
 * for a jump inside a scene, a glitch when the machine does something, a coin on the
 * payoff. Deterministic — the same timeline always gets the same treatment.
 */
export function planPolish(doc, opts = {}) {
  const p = sfxPresets();
  const cuts = cutPoints(doc, { minGap: opts.minGap ?? 0.9 });
  const duration = (doc.duration || 0) / 1e6;
  const layoutChange = t => allSegments(doc).some(({ segment }) =>
    (segment.desc || '') === 'layout:seam-bar'
    && Math.abs(segment.target_timerange.start / 1e6 - t) < 0.05);

  // The coin is the payoff and there is exactly one payoff: the last cut into the CTA.
  // Firing it on everything in the closing stretch gave four coins in a row.
  const last = cuts.length ? cuts.at(-1).t : null;
  const rotate = ['flash', 'glitch', 'whiteflash', 'glitch2', 'flash', 'sweepL'];
  const plan = [];
  let rot = 0, prev = null;
  for (const c of cuts) {
    if (opts.only && !opts.only.includes(Math.round(c.t * 100) / 100)) continue;
    let name;
    if (c.t === last && duration > 20) name = 'payoff';
    else if (layoutChange(c.t)) name = 'sweep';
    else { name = rotate[rot++ % rotate.length]; }
    if (name === prev && name !== 'sweep') name = rotate[rot++ % rotate.length];  // never twice running
    prev = name;
    plan.push({ ...c, pair: name, ...p.pairs[name] });
  }
  return plan;
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

  const plan = planPolish(doc, op);
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
  const skipped = [];
  for (const [i, cue] of plan.entries()) {
    if (principal) {
      const segs = principal.track.segments;
      const at = segs.findIndex(s =>
        Math.abs((s.target_timerange.start + s.target_timerange.duration) / 1e6 - cue.t) < 0.05);
      // no clip after the boundary => CapCut drops the transition on load, so do not write one
      if (at >= 0 && at < segs.length - 1) {
        const id = makeTransition(doc, cue.transition, cue.duration, `${i}:${cue.t}`);
          segs[at].extra_material_refs = [...(segs[at].extra_material_refs || []), id];
        transitions++;
      } else {
        skipped.push(cue.t);
      }
    }
    const audioId = ensureAudio(doc, cue.sfx);
    const tpl = p.audioTemplates[cue.sfx];
    const dur = Math.min((tpl.duration || US(0.5)) / 1e6, 1.2);
    lane.segments.push(audioSegment(doc, audioId, cue.t - lead, dur, `${i}:${cue.t}`, volume));
  }
  lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
  return { changed: plan.length, transitions, removedTransitions: removed, sfx: plan.length,
           principalTrack: principal ? principal.index : null,
           sliced: slices.split, alreadyCut: slices.existing,
           ...(slices.refused.length ? { keyframedSoNotSliced: slices.refused } : {}),
           ...(skipped.length ? { noTransition: skipped } : {}),
           cues: plan.map(c => ({ t: c.t, pair: c.pair, transition: c.transition, sfx: c.sfx })) };
}
