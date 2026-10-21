import {
  CapcutError, clone, cloneExtraRefs, contentEndUs, materialIndex, privateMaterial, recutFilterRebaseKeyframes,
  removeUnreferencedMaterials, seededId,
} from './core.mjs';
import { renumberTracks } from './layouts.mjs';

const US = s => Math.round(Number(s) * 1_000_000);
const S = us => us / 1_000_000;
const r3 = n => Math.round(n * 1000) / 1000;
const ONE_SHOT_US = 1_500_000;
const BED = /music|bed/i;

const isOneShot = (track, seg) => track.type === 'audio' && seg.target_timerange.duration <= ONE_SHOT_US;
const isBed = (track, seg) => BED.test(track.name || '') || BED.test(seg.desc || '');

/**
 * Ripple-delete a timeline range on EVERY track: the dead air between two words, with
 * everything after it pulled up so graphics, captions, sounds and B-roll stay on their words.
 *
 * Clips keep their speed (the face stays 1×): a clip that straddles an edge loses the part
 * inside the range from its source window. A video or voice clip that spans the whole range
 * is SPLIT around it — the head ends at the range start, a new tail (own id, own extras such
 * as its speed) starts there and plays on from the far edge — so the pause goes and the clip's
 * last words stay. A music bed (track or desc names music/bed) and a spanning text or sticker
 * give the range up from their tail instead, so a bed stays continuous.
 *
 * One-shot sounds (audio up to 1.5s) move instead of being cut; a moved one that would land
 * on another sound on its lane slides to that sound's end, or onto a `<lane>:ripple` lane
 * when it no longer fits there (dropped only when that lane is full too). Media keyframes are
 * source-time and are partitioned or clamped into the new windows; keyframes on source-less
 * layers (text) are segment-relative and move with a head trim. Parked leftovers past the
 * content end are not content and stay where they are.
 */
export function opRipple(doc, op, context = {}) {
  const a = US(op.from), b = US(op.to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a) || a < 0) {
    throw new CapcutError('ripple needs --from S --to S with to > from >= 0.', { code: 'BAD_TIME', exitCode: 2 });
  }
  const d = b - a;
  const contentEnd = contentEndUs(doc, context.projectDir);
  if (b > contentEnd) throw new CapcutError('ripple range runs past the end of the content.', { code: 'BAD_TIME', exitCode: 2 });
  // Not op.__seed: applySpec gives this op a fresh uuid per run, and the same ripple on the
  // same draft must mint the same tail ids. Every mirror shares doc.id, so they stay in step.
  const seed = `ripple|${doc.id || ''}|${a}|${b}`;
  const rows = { removed: [], shifted: 0, headTrimmed: [], tailTrimmed: [], shortened: [], split: [], relaned: [], dropped: [] };
  const refIds = new Set();
  const moved = new Set();

  for (const track of doc.tracks || []) {
    const keep = [];
    for (const seg of track.segments || []) {
      const tt = seg.target_timerange;
      const start = tt.start, end = tt.start + tt.duration;
      const st = seg.source_timerange;
      const speed = st && tt.duration > 0 ? st.duration / tt.duration : 1;
      const label = `${track.name || track.type}:${seg.id.slice(0, 8)}`;

      if (end <= a || start >= contentEnd) { keep.push(seg); continue; }
      if (start >= b) {
        setStart(seg, start - d);
        rows.shifted++;
        if (isOneShot(track, seg)) moved.add(seg);
        keep.push(seg);
        continue;
      }
      if (isOneShot(track, seg)) {
        // A one-shot sound is never cut: one that starts before the range stays put, one that
        // starts inside it lands at the range start.
        if (start >= a) { setStart(seg, a); rows.shifted++; moved.add(seg); }
        keep.push(seg);
        continue;
      }
      if (start >= a && end <= b) {
        forget(seg, refIds);
        rows.removed.push(label);
        continue;
      }
      if (start < a && end <= b) {
        // Tail runs into the range: end it at the range start.
        resize(seg, start, a - start, st ? st.start : null, speed);
        rows.tailTrimmed.push(label);
      } else if (start >= a && end > b) {
        // Head starts inside the range: drop the head, land it at the range start.
        const cut = b - start;
        resize(seg, a, end - b, st ? st.start + Math.round(cut * speed) : null, speed);
        if (!st) shiftRelativeKeyframes(seg, -cut);
        rows.headTrimmed.push(label);
      } else if (st && tt.duration > 0 && (track.type === 'video' || (track.type === 'audio' && !isBed(track, seg)))) {
        // Spans the whole range, and its tail is words or picture: split around the range.
        keep.push(seg, splitAround(doc, seg, a, b, seed, refIds));
        rows.split.push(label);
        continue;
      } else {
        // A bed (or a source-less layer) spans the whole range: give the range up from its tail.
        resize(seg, start, tt.duration - d, st ? st.start : null, speed);
        rows.shortened.push(label);
      }
      keep.push(seg);
    }
    track.segments = keep;
  }
  settleOneShots(doc, moved, seed, rows, refIds);
  if (refIds.size) removeUnreferencedMaterials(doc, refIds);
  doc.duration = Math.max(0, ...(doc.tracks || []).flatMap(t => (t.segments || []).map(x => x.target_timerange.start + x.target_timerange.duration)));
  return { changed: rows.removed.length + rows.shifted + rows.headTrimmed.length + rows.tailTrimmed.length
      + rows.shortened.length + rows.split.length + rows.relaned.length + rows.dropped.length,
    from: r3(S(a)), to: r3(S(b)), removedSeconds: r3(S(d)), ...rows };
}

/** A removed segment's main material and extras, pruned once nothing else points at them. */
function forget(seg, refIds) {
  for (const ref of seg.extra_material_refs || []) refIds.add(ref);
  if (seg.material_id) refIds.add(seg.material_id);
}

/**
 * Cut `seg` around [a, b): it keeps [start, a) and a new tail plays [b, end) from a. Both halves
 * keep the clip's speed; the tail gets private copies of every extra (speed, mask, fade...),
 * the transition at the clip's end moves to the tail alone, and the source-time keyframes are
 * partitioned between the two windows.
 */
function splitAround(doc, seg, a, b, seed, refIds) {
  const tt = seg.target_timerange, st = seg.source_timerange;
  const start = tt.start, end = tt.start + tt.duration;
  const speed = st.duration / tt.duration;
  const original = { start: st.start, duration: st.duration };
  const headSource = { start: st.start, duration: Math.round((a - start) * speed) };
  const tailStart = st.start + Math.round((b - start) * speed);
  const tailSource = { start: tailStart, duration: st.start + st.duration - tailStart };

  const tail = clone(seg);
  tail.id = seededId(seed, `ripple:${seg.id}:${a}`);
  tail.target_timerange = { start: a, duration: end - b };
  tail.source_timerange = tailSource;
  if (tail.render_timerange?.duration) tail.render_timerange = { ...tail.render_timerange, start: a, duration: end - b };
  tail.extra_material_refs = cloneExtraRefs(doc, seg, tail.id, seed, { key: i => `ripple:extra:${tail.id}:${i}` });
  recutFilterRebaseKeyframes(tail, original, tailSource, tailSource);
  for (const group of tail.common_keyframes || []) {
    if (group.id) group.id = seededId(seed, `ripple:keyframes:${tail.id}:${group.id}`);
    for (const key of group.keyframe_list || []) if (key?.id) key.id = seededId(seed, `ripple:keyframe:${tail.id}:${key.id}`);
  }

  recutFilterRebaseKeyframes(seg, original, headSource, headSource);
  tt.duration = a - start;
  st.duration = headSource.duration;
  if (seg.render_timerange?.duration) seg.render_timerange = { ...seg.render_timerange, start, duration: a - start };

  // The cut is mid-clip: no fade or outro at the head's new end, no fade-in or intro at the tail's start.
  const index = materialIndex(doc);
  // A transition plays at its clip's END: that boundary now belongs to the tail (which carries
  // its own copy), so the head drops it, or a second one would play at the mid-take cut.
  seg.extra_material_refs = (seg.extra_material_refs || []).filter(ref => {
    if (index.get(ref)?.kind !== 'transitions') return true;
    refIds.add(ref);
    return false;
  });
  for (const ref of tail.extra_material_refs) {
    const hit = index.get(ref);
    if (!hit) continue;
    if (hit.value.type === 'audio_fade' || hit.kind === 'audio_fades') {
      if ('fade_in_duration' in hit.value) hit.value.fade_in_duration = 0;
    } else if (hit.kind === 'material_animations' && Array.isArray(hit.value.animations)) {
      hit.value.animations = hit.value.animations.filter(x => x?.type === 'out')
        .map(x => ({ ...x, start: Math.max(0, tail.target_timerange.duration - Number(x.duration || 0)) }));
    }
  }
  for (const ref of [...(seg.extra_material_refs || [])]) {
    const hit = index.get(ref);
    if (!hit) continue;
    const fade = (hit.value.type === 'audio_fade' || hit.kind === 'audio_fades') && hit.value.fade_out_duration > 0;
    const outro = hit.kind === 'material_animations' && (hit.value.animations || []).some(x => x?.type === 'out');
    if (!fade && !outro) continue;
    for (const record of privateMaterial(doc, seg, ref, { seed, seedKey: `ripple:private:${seg.id}:${ref}` })) {
      if (fade) record.fade_out_duration = 0;
      else record.animations = record.animations.filter(x => x?.type !== 'out');
    }
  }
  return tail;
}

/**
 * Moving one-shots to the range start (or pulling them up) can stack two on one lane, which
 * CapCut plays as one smeared hit. Slide a moved one to the previous sound's end when it still
 * fits before the next; otherwise lift it onto a `<lane>:ripple` lane, and only when that lane
 * is occupied there too, drop it. A one-shot is never cut.
 */
function settleOneShots(doc, moved, seed, rows, refIds) {
  if (!moved.size) return;
  let added = false;
  for (let index = 0; index < (doc.tracks || []).length; index++) {
    const track = doc.tracks[index];
    if (track.type !== 'audio' || !(track.segments || []).some(seg => moved.has(seg))) continue;
    const ordered = [...track.segments].sort((x, y) => x.target_timerange.start - y.target_timerange.start);
    const lifted = [];
    let prevEnd = -Infinity;
    for (const [i, seg] of ordered.entries()) {
      const tt = seg.target_timerange;
      if (!moved.has(seg) || tt.start >= prevEnd) {
        prevEnd = Math.max(prevEnd, tt.start + tt.duration);
        continue;
      }
      const next = ordered[i + 1]?.target_timerange.start ?? Infinity;
      if (prevEnd + tt.duration <= next) {
        setStart(seg, prevEnd);
        prevEnd += tt.duration;
      } else lifted.push(seg);
    }
    if (!lifted.length) {
      track.segments = ordered;
      continue;
    }
    track.segments = ordered.filter(seg => !lifted.includes(seg));
    const name = `${track.name || track.type}:ripple`;
    let lane = doc.tracks.find(t => t.type === 'audio' && t.name === name);
    if (!lane) {
      lane = clone({ ...track, segments: [] });
      lane.id = seededId(seed, `ripple:lane:${track.id || index}`);
      lane.name = name;
      doc.tracks.splice(index + 1, 0, lane);
      added = true;
    }
    for (const seg of lifted) {
      const label = `${track.name || track.type}:${seg.id.slice(0, 8)}`;
      const s = seg.target_timerange.start, e = s + seg.target_timerange.duration;
      const free = (lane.segments || []).every(x => x.target_timerange.start >= e
        || x.target_timerange.start + x.target_timerange.duration <= s);
      if (free) {
        (lane.segments ||= []).push(seg);
        rows.relaned.push(label);
      } else {
        forget(seg, refIds);
        rows.dropped.push(label);
      }
    }
    lane.segments.sort((x, y) => x.target_timerange.start - y.target_timerange.start);
  }
  if (added) renumberTracks(doc);
}

function setStart(seg, start) {
  seg.target_timerange.start = start;
  if (seg.render_timerange?.duration) seg.render_timerange.start = start;
}

function resize(seg, start, dur, srcStart, speed) {
  setStart(seg, start);
  seg.target_timerange.duration = dur;
  if (seg.render_timerange?.duration) seg.render_timerange.duration = dur;
  const st = seg.source_timerange;
  if (!st) return;
  st.start = srcStart;
  st.duration = Math.round(dur * speed);
  for (const k of seg.common_keyframes || []) for (const kf of k.keyframe_list || []) {
    kf.time_offset = Math.max(st.start, Math.min(st.start + st.duration, kf.time_offset));
  }
}

function shiftRelativeKeyframes(seg, by) {
  const dur = seg.target_timerange.duration;
  for (const k of seg.common_keyframes || []) for (const kf of k.keyframe_list || []) {
    kf.time_offset = Math.max(0, Math.min(dur, kf.time_offset + by));
  }
}
