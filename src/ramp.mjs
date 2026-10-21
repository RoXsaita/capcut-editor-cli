import { CapcutError, allSegments, resolveMediaPath } from './core.mjs';
import { principalTrack, sliceAt } from './polish.mjs';
import { setSpeed } from './pace.mjs';
import { isBrollSegment, momentsFromSidecar } from './broll-lint.mjs';

const US = s => Math.round(s * 1e6);
const S = us => (us || 0) / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;

export const DEFAULT_SPEED = 20;
export const DEFAULT_SETTLE = 0.5;
/** Same floor as the change-index merge gap: shorter than this is still the same event. */
export const MIN_QUIET = 1.0;
const MIN_PIECE = 0.05;
const EDGE = 0.02;

function materialFor(doc, id) {
  for (const values of Object.values(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    const found = values.find(item => item && item.id === id);
    if (found) return found;
  }
  return null;
}

function isPlate(doc, segment) {
  const material = materialFor(doc, segment.material_id);
  return !material || (material.type && material.type !== 'video');
}

function isLayoutHelper(segment) {
  const desc = String(segment?.desc || '');
  return desc.startsWith('layout:') && desc !== 'layout:screen-recording';
}

function currentSpeed(segment) {
  const st = segment.source_timerange, tt = segment.target_timerange;
  return st && tt?.duration ? st.duration / tt.duration : 1;
}

function timelineOfSource(segment, sourceS) {
  const tt = segment.target_timerange, st = segment.source_timerange;
  if (!st || !tt?.duration) return S(tt?.start);
  const speed = st.duration / tt.duration;
  return S(tt.start + Math.round((US(sourceS) - st.start) / speed));
}

/**
 * The result is the first change-index peak after a quiet stretch inside [srcIn, srcOut].
 * A peak sitting on the in-point is the wait, not the answer.
 */
export function findResultMoment(moments, srcIn, srcOut, { minQuiet = MIN_QUIET, minScore = 0.5 } = {}) {
  const peaks = (moments || [])
    .map(moment => ({
      start: Number(moment.start),
      end: Number(moment.end ?? moment.start),
      peak: Number(moment.peak ?? moment.score),
    }))
    .filter(moment => Number.isFinite(moment.start) && Number.isFinite(moment.end)
      && Number.isFinite(moment.peak) && moment.peak >= minScore)
    .filter(moment => moment.end > srcIn && moment.start < srcOut)
    .sort((a, b) => a.start - b.start);
  let cursor = srcIn;
  for (const moment of peaks) {
    const quiet = Math.min(moment.start, srcOut) - cursor;
    if (quiet >= minQuiet && moment.start >= srcIn && moment.start <= srcOut) return moment;
    cursor = Math.max(cursor, moment.end);
  }
  return null;
}

function principalIndex(doc) {
  try {
    return principalTrack(doc).index;
  } catch (error) {
    if (error instanceof CapcutError && error.code === 'NO_PRINCIPAL_TRACK') return null;
    throw error;
  }
}

function locateClip(doc, { segment, at, track } = {}) {
  const hits = [];
  for (const { segment: seg, track: tr, trackIndex } of allSegments(doc)) {
    if (tr.type !== 'video' || tr.flag === 0) continue;
    if (track != null && trackIndex !== track) continue;
    if (segment && seg.id !== segment) continue;
    if (at != null) {
      const start = S(seg.target_timerange?.start);
      const end = start + S(seg.target_timerange?.duration);
      const nearStart = Math.abs(start - at) < 0.05;
      const inside = start <= at && at < end;
      if (!nearStart && !inside) continue;
    }
    hits.push({ segment: seg, track: tr, trackIndex });
  }
  if (!hits.length) {
    throw new CapcutError(
      'ramp found no clip. Pass --segment ID or --at T on a B-roll shot.',
      { code: 'NO_CLIP', exitCode: 2 }
    );
  }
  if (hits.length > 1) {
    const principal = principalIndex(doc);
    const broll = hits.filter(hit => hit.trackIndex !== principal);
    if (broll.length === 1) return broll[0];
    throw new CapcutError(
      `${hits.length} clips match; pass --segment ID or --track.`,
      { code: 'AMBIGUOUS_CLIP', exitCode: 2 }
    );
  }
  return hits[0];
}

function refuseFace(doc, clip) {
  const principal = principalIndex(doc);
  if (principal != null && clip.trackIndex === principal) {
    throw new CapcutError(
      'ramp cannot change the talking-head track; faces never ramp. Recut speech at 1× with cut.',
      { code: 'PRINCIPAL_TRACK', exitCode: 2 }
    );
  }
  const material = materialFor(doc, clip.segment.material_id);
  if (isPlate(doc, clip.segment) || isLayoutHelper(clip.segment) || !isBrollSegment(clip.segment, material)) {
    throw new CapcutError(
      'ramp only applies to B-roll (screen recordings). Faces and plates never ramp.',
      { code: 'NOT_BROLL', exitCode: 2 }
    );
  }
}

function resolveMoments(doc, clip, op, context) {
  if (Array.isArray(op.moments)) return op.moments;
  if (op.resultAt != null) return [];
  const material = materialFor(doc, clip.segment.material_id);
  const projectDir = op.projectDir || context.projectDir || null;
  const file = resolveMediaPath(material?.path, projectDir) || material?.path || '';
  const found = momentsFromSidecar(file, projectDir);
  if (found == null) {
    throw new CapcutError(
      'ramp needs a change sidecar (change.ndjson) or --result-at T for the result moment.',
      { code: 'NO_CHANGE_SIDECAR', exitCode: 2 }
    );
  }
  return found;
}

function pathOf(doc, segment) {
  const material = materialFor(doc, segment?.material_id);
  return material?.path || segment?.material_id || null;
}

/**
 * How far the wait may reach into the source, and how far the result may run on.
 *
 * Back: never before the clip's in-point minus `reachBack` (default 0 — what sits before the
 * in-point was cut on purpose or is an earlier shot), and never into source another segment of
 * the same file already shows (its source end ≤ the split). Forward: the material's end, and the
 * in-point of the next segment from the same file.
 */
function reachBounds(doc, clipSeg, exclude, srcIn, splitSrc, reachBack) {
  const file = pathOf(doc, clipSeg);
  let floor = Math.max(0, srcIn - reachBack);
  let floorBy = reachBack > 0 ? 'reach-back' : 'in-point';
  const material = materialFor(doc, clipSeg.material_id);
  let ceiling = Number(material?.duration) > 0 ? S(material.duration) : Infinity;
  let ceilingBy = 'material end';
  for (const { segment } of allSegments(doc)) {
    if (exclude.has(segment) || !segment.source_timerange || pathOf(doc, segment) !== file) continue;
    const start = S(segment.source_timerange.start);
    const end = S(segment.source_timerange.start + segment.source_timerange.duration);
    if (end <= splitSrc + 1e-6 && end > floor) { floor = end; floorBy = `segment ${segment.id}`; }
    if (start >= splitSrc - 1e-6 && start < ceiling) { ceiling = start; ceilingBy = `segment ${segment.id}`; }
  }
  return { floor, floorBy, ceiling, ceilingBy };
}

function pieceEndingAt(track, us) {
  return (track.segments || []).find(seg =>
    Math.abs((seg.target_timerange.start + seg.target_timerange.duration) - us) < 20000);
}

function pieceStartingAt(track, us) {
  return (track.segments || []).find(seg =>
    Math.abs(seg.target_timerange.start - us) < 20000);
}

/**
 * Split a B-roll clip at the result moment, pace the waiting half, leave the result at 1×.
 * Uses sliceAt + setSpeed only — never curve_speed.
 */
export function opRamp(doc, op = {}, context = {}) {
  if (op.segment == null && op.at == null) {
    throw new CapcutError('ramp requires --segment ID or --at T.', { code: 'NO_CLIP', exitCode: 2 });
  }
  const speed = Number(op.speed ?? DEFAULT_SPEED);
  const settle = Number(op.settle ?? DEFAULT_SETTLE);
  const reachBack = Number(op.reachBack ?? 0);
  if (!Number.isFinite(reachBack) || reachBack < 0) {
    throw new CapcutError('ramp --reach-back must be a nonnegative number of seconds.', {
      code: 'BAD_REACH_BACK', exitCode: 2,
    });
  }
  // How far past the clip's out-point the result may run on when the wait is shortened. 0 by
  // default: what follows the out-point was cut on purpose, like what precedes the in-point.
  const reachForwardAllowed = Number(op.reachForward ?? 0);
  if (!Number.isFinite(reachForwardAllowed) || reachForwardAllowed < 0) {
    throw new CapcutError('ramp --reach-forward must be a nonnegative number of seconds.', {
      code: 'BAD_REACH_FORWARD', exitCode: 2,
    });
  }
  if (!(speed > 1) || !Number.isFinite(speed)) {
    throw new CapcutError(`ramp --speed must be greater than 1, got ${op.speed}`, {
      code: 'BAD_SPEED', exitCode: 2,
    });
  }
  if (!Number.isFinite(settle) || settle < 0) {
    throw new CapcutError('ramp --settle must be a nonnegative number of seconds.', {
      code: 'BAD_SETTLE', exitCode: 2,
    });
  }

  const clip = locateClip(doc, op);
  refuseFace(doc, clip);
  const seg = clip.segment;
  const st = seg.source_timerange, tt = seg.target_timerange;
  if (!st || !tt) {
    throw new CapcutError('ramp needs a clip with source and target timeranges.', {
      code: 'NO_TIMERANGE', exitCode: 2,
    });
  }
  const srcIn = S(st.start), srcOut = S(st.start + st.duration);

  let resultAt = op.resultAt != null ? Number(op.resultAt) : null;
  let result = null;
  if (resultAt == null) {
    result = findResultMoment(resolveMoments(doc, clip, op, context), srcIn, srcOut);
    if (!result) {
      throw new CapcutError(
        'no result moment: no change-index peak after a quiet stretch in this clip. Pass --result-at T.',
        { code: 'NO_RESULT', exitCode: 2 }
      );
    }
    resultAt = result.start;
  }
  if (!Number.isFinite(resultAt) || resultAt <= srcIn || resultAt >= srcOut) {
    throw new CapcutError(
      `result ${r3(resultAt)}s is outside this clip's source window ${r3(srcIn)}-${r3(srcOut)}s.`,
      { code: 'RESULT_OUT_OF_RANGE', exitCode: 2 }
    );
  }

  // Native saving snaps both cuts to frame boundaries. At 20x, a 20ms timeline
  // correction otherwise repeats almost half a second of the result source.
  const fps = Number(doc.fps) > 0 ? Number(doc.fps) : 30;
  const snap = seconds => Math.floor(Math.round(seconds * fps) * 1e6 / fps) / 1e6;
  const splitSource = snap(Math.min(srcOut - MIN_PIECE, Math.max(srcIn + MIN_PIECE, resultAt - settle)));
  if (!(splitSource > srcIn + EDGE && splitSource < srcOut - EDGE)) {
    throw new CapcutError(
      'not enough room inside the clip to split wait from result. Pick a later --result-at or a smaller --settle.',
      { code: 'SPLIT_EDGE', exitCode: 2 }
    );
  }
  const splitAt = snap(timelineOfSource(seg, splitSource));
  const sliced = sliceAt(doc, clip.track, splitAt, `ramp:${seg.id}`, op.__seed);
  if (sliced === 'keyframed') {
    throw new CapcutError(
      'ramp refuses a keyframed clip; splitting would rescale the animation. Clear keys first or pick another shot.',
      { code: 'KEYFRAMED', exitCode: 2 }
    );
  }
  if (sliced === 'animated') {
    throw new CapcutError(
      'ramp refuses a clip with an intro/outro animation; both halves would carry it. Remove the animation first or pick another shot.',
      { code: 'ANIMATED', exitCode: 2 }
    );
  }
  if (sliced === false) {
    throw new CapcutError(
      `could not split at ${r3(splitAt)}s (source ${r3(splitSource)}s).`,
      { code: 'SPLIT_FAILED', exitCode: 2 }
    );
  }

  const us = US(splitAt);
  const wait = sliced === 'existing' ? pieceEndingAt(clip.track, us) : seg;
  const shown = pieceStartingAt(clip.track, us);
  if (!wait || !shown) {
    throw new CapcutError('split succeeded but the wait/result halves could not be found.', {
      code: 'SPLIT_FAILED', exitCode: 2,
    });
  }

  const waitTl = S(wait.target_timerange.duration);
  const splitSrc = splitSource;
  const wantCover = waitTl * speed;
  const wantStart = splitSrc - wantCover;
  const bounds = reachBounds(doc, seg, new Set([wait, shown]), srcIn, splitSrc, reachBack);
  const sourceStart = Math.max(bounds.floor, wantStart);
  const limited = sourceStart > wantStart + 1e-6;
  let actualSpeed = speed;
  if (limited) {
    // Not enough source before the result to fill the wait at this speed, and source before
    // the in-point (an earlier shot, or content cut on purpose) may not play. Two ways out that
    // keep the clip's place and length on the timeline:
    //   - shorten the wait and give the freed timeline to the result at 1×, which plays source
    //     past the out-point: only within --reach-forward, since that too was cut on purpose;
    //   - otherwise keep the wait and pace it at the speed the reachable source allows.
    const shownEndUs = shown.target_timerange.start + shown.target_timerange.duration;
    const newSplitAt = snap(S(wait.target_timerange.start) + (splitSrc - sourceStart) / speed);
    const newWaitUs = US(newSplitAt) - wait.target_timerange.start;
    const resultUs = shownEndUs - US(newSplitAt);
    const needEnd = splitSrc + S(resultUs);
    const ceiling = Math.min(bounds.ceiling, srcOut + reachForwardAllowed);
    const ceilingBy = bounds.ceiling <= srcOut + reachForwardAllowed ? bounds.ceilingBy
      : reachForwardAllowed > 0 ? 'reach-forward' : 'out-point';
    const slowSpeed = waitTl > 0 ? (splitSrc - sourceStart) / waitTl : 0;
    if (newWaitUs > 0 && needEnd <= ceiling + 1e-3) {
      wait.target_timerange.duration = newWaitUs;
      shown.target_timerange.start = US(newSplitAt);
      shown.target_timerange.duration = resultUs;
      actualSpeed = (US(splitSrc) - US(sourceStart)) / newWaitUs;
    } else if (slowSpeed > 1.02) {
      actualSpeed = slowSpeed;
    } else {
      const backNeeded = Math.max(0, srcIn - wantStart);
      const forwardNeeded = Math.max(0, needEnd - srcOut);
      throw new CapcutError(
        `ramp needs source ${r3(wantStart)}-${r3(splitSrc)}s for the wait, but nothing before `
        + `${r3(bounds.floor)}s (${bounds.floorBy}) may play; shortening the wait instead needs `
        + `${r3(splitSrc)}-${r3(needEnd)}s at 1× for the result, past ${r3(ceiling)}s (${ceilingBy}). `
        + `Pass --reach-back ${r3(backNeeded)} if the earlier source may show`
        + (needEnd <= bounds.ceiling + 1e-3 ? `, or --reach-forward ${r3(forwardNeeded)} if the source after the out-point may` : '')
        + ', or pick a shorter clip / smaller --speed.',
        { code: 'REACH_LIMITED', exitCode: 2, details: {
          wait: [r3(wantStart), r3(splitSrc)], result: [r3(splitSrc), r3(needEnd)],
          floor: r3(bounds.floor), ceiling: r3(ceiling), reachBackNeeded: r3(backNeeded),
          reachForwardNeeded: r3(forwardNeeded),
        } }
      );
    }
  }
  const paced = limited || actualSpeed > 1.02
    ? setSpeed(doc, wait, actualSpeed, { sourceStart: US(sourceStart) })
    : { speed: currentSpeed(wait), clamped: true, source: [S(wait.source_timerange.start), S(wait.source_timerange.start + wait.source_timerange.duration)] };

  // When the wait is re-paced, both halves meet at the snapped split. When it is not,
  // keep the slice's source seam — forcing shown to splitSrc would skip or repeat frames.
  setSpeed(doc, shown, 1, { sourceStart: US(paced.source[1]) });
  for (const ref of shown.extra_material_refs || []) {
    const material = materialFor(doc, ref);
    if (material && material.type === 'speed') material.curve_speed = null;
  }

  return {
    changed: 1,
    split: sliced,
    wait: {
      id: wait.id,
      at: r3(S(wait.target_timerange.start)),
      speed: r3(paced.speed),
      source: paced.source,
      clamped: Boolean(paced.clamped || actualSpeed + 0.02 < speed),
    },
    limited,
    reachBack: r3(Math.max(0, srcIn - S(wait.source_timerange.start))),
    reachForward: r3(Math.max(0, S(shown.source_timerange.start + shown.source_timerange.duration) - srcOut)),
    result: {
      id: shown.id,
      at: r3(S(shown.target_timerange.start)),
      speed: r3(currentSpeed(shown)),
      source: [
        r3(S(shown.source_timerange.start)),
        r3(S(shown.source_timerange.start + shown.source_timerange.duration)),
      ],
    },
    resultAt: r3(resultAt),
    splitSource: r3(splitSrc),
    settle,
  };
}
