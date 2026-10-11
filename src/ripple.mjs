import { CapcutError, contentEndUs, removeUnreferencedMaterials } from './core.mjs';

const US = s => Math.round(Number(s) * 1_000_000);
const S = us => us / 1_000_000;
const r3 = n => Math.round(n * 1000) / 1000;
const ONE_SHOT_US = 1_500_000;

/**
 * Ripple-delete a timeline range on EVERY track: the dead air between two words, with
 * everything after it pulled up so graphics, captions, sounds and B-roll stay on their words.
 *
 * Clips keep their speed (the face stays 1×): a clip that straddles an edge loses the part
 * inside the range from its source window; one that spans the whole range gives up the
 * range from its tail, so a music bed stays continuous. One-shot sounds (audio up to 1.5s)
 * move instead of being cut. Media keyframes are source-time and
 * are only clamped into the new window; keyframes on source-less layers (text) are
 * segment-relative and move with a head trim. Parked leftovers past the content end are
 * not content and stay where they are.
 */
export function opRipple(doc, op, context = {}) {
  const a = US(op.from), b = US(op.to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a) || a < 0) {
    throw new CapcutError('ripple needs --from S --to S with to > from >= 0.', { code: 'BAD_TIME', exitCode: 2 });
  }
  const d = b - a;
  const contentEnd = contentEndUs(doc, context.projectDir);
  if (b > contentEnd) throw new CapcutError('ripple range runs past the end of the content.', { code: 'BAD_TIME', exitCode: 2 });
  const rows = { removed: [], shifted: 0, headTrimmed: [], tailTrimmed: [], shortened: [] };
  const refIds = new Set();

  for (const track of doc.tracks || []) {
    const keep = [];
    for (const seg of track.segments || []) {
      const tt = seg.target_timerange;
      const start = tt.start, end = tt.start + tt.duration;
      const st = seg.source_timerange;
      const speed = st && tt.duration > 0 ? st.duration / tt.duration : 1;
      const label = `${track.name || track.type}:${seg.id.slice(0, 8)}`;

      if (end <= a || start >= contentEnd) { keep.push(seg); continue; }
      if (start >= b) { setStart(seg, start - d); rows.shifted++; keep.push(seg); continue; }
      if (track.type === 'audio' && tt.duration <= ONE_SHOT_US) {
        // A one-shot sound is never cut: one that starts before the range stays put, one that
        // starts inside it lands at the range start.
        if (start >= a) { setStart(seg, a); rows.shifted++; }
        keep.push(seg);
        continue;
      }
      if (start >= a && end <= b) {
        for (const ref of seg.extra_material_refs || []) refIds.add(ref);
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
      } else {
        // Spans the whole range: give the range up from its tail.
        resize(seg, start, tt.duration - d, st ? st.start : null, speed);
        rows.shortened.push(label);
      }
      keep.push(seg);
    }
    track.segments = keep;
  }
  if (rows.removed.length) removeUnreferencedMaterials(doc, refIds);
  doc.duration = Math.max(0, ...(doc.tracks || []).flatMap(t => (t.segments || []).map(x => x.target_timerange.start + x.target_timerange.duration)));
  return { changed: rows.removed.length + rows.shifted + rows.headTrimmed.length + rows.tailTrimmed.length + rows.shortened.length,
    from: r3(S(a)), to: r3(S(b)), removedSeconds: r3(S(d)), ...rows };
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
