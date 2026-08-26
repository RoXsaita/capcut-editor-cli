import { CapcutError, allSegments } from './core.mjs';
import { principalTrack } from './polish.mjs';

const US = s => Math.round(s * 1e6);
const S = us => us / 1e6;
const r2 = n => Math.round(n * 100) / 100;

/**
 * Speed is arithmetic, not judgment. The target duration of a B-roll slot is already fixed
 * by the A-roll cut, so the only free variable is how much source it consumes:
 *
 *     speed = source_duration / target_duration
 *
 * Measured across his own projects: IKEA Refund compresses 1317s of screen recording into
 * 67s (19.7x, 70% of segments ramped, up to 100x); Hermes-agent runs 1.5x with 50% ramped.
 * grok-build-final was at 1.9x with 79% of its B-roll playing at real time — a viewer
 * watching a phone scroll at the speed it actually scrolled.
 */

function materialFor(doc, id) {
  for (const v of Object.values(doc.materials)) {
    if (!Array.isArray(v)) continue;
    const m = v.find(x => x && x.id === id);
    if (m) return m;
  }
  return null;
}

function speedMaterial(doc, seg) {
  for (const r of seg.extra_material_refs || []) {
    const m = materialFor(doc, r);
    if (m && m.type === 'speed') return m;
  }
  return null;
}

function currentSpeed(doc, seg) {
  const m = speedMaterial(doc, seg);
  if (m && m.speed) return m.speed;
  const st = seg.source_timerange, tt = seg.target_timerange;
  return st && tt.duration ? st.duration / tt.duration : 1;
}

/** Plates (PNG/GIF frames) have no source to race through. */
function isPlate(doc, seg) {
  const m = materialFor(doc, seg.material_id);
  return !m || (m.type && m.type !== 'video');
}

/**
 * Keyframe time_offset is an ABSOLUTE position in the source, always inside the segment's
 * source window — verified across all three reference projects. So when the window is
 * rescaled, offsets must be rescaled with it or a 0.2s punch-in at 10x becomes a 0.02s
 * ramp, which is under one frame and reads as a jump cut. Scaling the offset's distance
 * from the window start by the same factor as the window keeps every zoom's ON-SCREEN
 * duration identical, which is the thing the eye actually measures.
 */
function rescaleKeyframes(seg, oldStart, oldDur, newStart, newDur) {
  const factor = oldDur > 0 ? newDur / oldDur : 1;
  for (const k of seg.common_keyframes || []) {
    for (const kf of k.keyframe_list || []) {
      const rel = kf.time_offset - oldStart;
      const next = newStart + Math.round(rel * factor);
      kf.time_offset = Math.max(newStart, Math.min(newStart + newDur, next));
    }
  }
}

/** Apply a speed to one segment, keeping its slot on the timeline exactly as long. */
export function setSpeed(doc, seg, speed, { sourceStart = null } = {}) {
  if (!(speed > 0)) throw new CapcutError(`speed must be positive, got ${speed}`, { code: 'BAD_SPEED', exitCode: 2 });
  const mat = materialFor(doc, seg.material_id);
  const limit = mat?.duration ?? Infinity;
  const st = seg.source_timerange, tt = seg.target_timerange;
  const oldStart = st.start, oldDur = st.duration;
  const newStart = sourceStart == null ? oldStart : sourceStart;
  let newDur = Math.round(tt.duration * speed);

  let clamped = false;
  if (newStart + newDur > limit) {
    newDur = limit - newStart;
    speed = newDur / tt.duration;
    clamped = true;
  }
  if (newDur <= 0) {
    throw new CapcutError(`speed ${speed} would need source past the end of ${mat?.material_name || 'the clip'}`,
      { code: 'SOURCE_EXHAUSTED', exitCode: 2 });
  }

  rescaleKeyframes(seg, oldStart, oldDur, newStart, newDur);
  st.start = newStart;
  st.duration = newDur;
  seg.speed = speed;
  const sm = speedMaterial(doc, seg);
  if (sm) { sm.speed = speed; sm.mode = 0; sm.curve_speed = null; }
  return { speed, clamped, source: [S(newStart), S(newStart + newDur)] };
}

/**
 * The plan. For every B-roll segment: what it plays now, and how much source is being
 * skipped between it and the next shot from the same file. That skipped stretch is the
 * candidate — closing it means flying through the wait instead of cutting past it, which
 * is exactly what IKEA Refund does 21 times.
 */
export function pacePlan(doc, { track = null, max = 100, minGap = 5.0 } = {}) {
  // Do not catch NO_PRINCIPAL_TRACK. Swallowing it used to pace the talking head
  // itself — dead air already cut looks like "skipped source" and --auto 30×'s it.
  const principal = track == null ? principalTrack(doc).index : null;
  const rows = [];
  for (const [ti, t] of doc.tracks.entries()) {
    if (t.type !== 'video' || !(t.segments || []).length) continue;
    if (track != null ? ti !== track : ti === principal) continue;
    const segs = [...t.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (const [i, seg] of segs.entries()) {
      if (isPlate(doc, seg)) continue;
      const st = seg.source_timerange, tt = seg.target_timerange;
      if (!st) continue;
      const speed = currentSpeed(doc, seg);
      const srcEnd = st.start + st.duration;
      const next = segs[i + 1];
      // Compare by PATH, not material id: CapCut keeps many material records for one file
      // (that is what DUPLICATE_MATERIAL_ID reports), so identity by id misses adjacency.
      const here = materialFor(doc, seg.material_id);
      const there = next && materialFor(doc, next.material_id);
      const sameSource = Boolean(here && there && here.path && here.path === there.path);
      const gap = sameSource ? S(next.source_timerange.start - srcEnd) : null;
      let suggested = null;
      // Only a LONG skip is waiting. A few seconds is an editorial cut and should stay one;
      // two minutes of a screen recording between two shots of an agent building an app is,
      // by definition, the agent working — the thing IKEA Refund flies through at 100x.
      if (gap != null && gap >= minGap) {
        const cover = S(next.source_timerange.start - st.start);
        suggested = Math.min(max, cover / S(tt.duration));
        if (suggested <= speed * 1.2) suggested = null;
      }
      rows.push({
        track: ti, at: r2(S(tt.start)), screen: r2(S(tt.duration)),
        source: [r2(S(st.start)), r2(S(srcEnd))], speed: r2(speed),
        skippedAfter: gap == null ? null : r2(gap),
        suggested: suggested == null ? null : r2(suggested),
        keyframes: (seg.common_keyframes || []).reduce((n, k) => n + (k.keyframe_list || []).length, 0),
        desc: seg.desc || '', __seg: seg,
      });
    }
  }
  return rows;
}

export function opPace(doc, op) {
  const rows = pacePlan(doc, { track: op.track ?? null, max: op.max ?? 100, minGap: op.minGap ?? 5.0 });
  const find = at => {
    const hit = rows.filter(r => Math.abs(r.at - at) < 0.05);
    if (!hit.length) {
      throw new CapcutError(`no pace-able clip starts at ${at}s. Run \`capcutctl pace --project NAME\` for the plan.`,
        { code: 'NO_CLIP_AT', exitCode: 2 });
    }
    if (hit.length > 1) {
      throw new CapcutError(`${hit.length} clips start at ${at}s (tracks ${hit.map(h => h.track).join(', ')}). Pass --track.`,
        { code: 'AMBIGUOUS_CLIP', exitCode: 2 });
    }
    return hit[0];
  };

  const applied = [];
  for (const s of op.set || []) {
    const row = find(s.at);
    const speed = s.cover
      ? (s.cover[1] - s.cover[0]) / row.screen
      : s.speed;
    const out = setSpeed(doc, row.__seg, speed, { sourceStart: s.cover ? US(s.cover[0]) : null });
    applied.push({ at: row.at, track: row.track, from: row.speed, ...out, desc: row.desc });
  }

  if (op.auto) {
    for (const row of rows) {
      if (row.suggested == null) continue;
      // Never override a ramp somebody already chose. Auto fills in what was left at 1.0x.
      if (Math.abs(row.speed - 1) >= 0.02) continue;
      const out = setSpeed(doc, row.__seg, row.suggested);
      applied.push({ at: row.at, track: row.track, from: row.speed, ...out, desc: row.desc, auto: true });
    }
  }

  if (!applied.length) {
    throw new CapcutError('pace changed nothing: pass --auto, or --at T with --speed X or --cover IN-OUT.',
      { code: 'NOTHING_TO_PACE', exitCode: 2 });
  }

  // The single number worth watching: how much source the B-roll covers per screen second.
  const after = pacePlan(doc, { track: op.track ?? null });
  const src = after.reduce((n, r) => n + (r.source[1] - r.source[0]), 0);
  const scr = after.reduce((n, r) => n + r.screen, 0);
  const realtime = after.filter(r => Math.abs(r.speed - 1) < 0.02).reduce((n, r) => n + r.screen, 0);
  return {
    changed: applied.length, applied,
    compression: r2(scr ? src / scr : 0),
    ramped: `${after.filter(r => Math.abs(r.speed - 1) >= 0.02).length}/${after.length}`,
    realtimePercent: Math.round(scr ? (100 * realtime) / scr : 0),
  };
}
