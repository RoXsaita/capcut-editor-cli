import { CapcutError, allSegments } from './core.mjs';
import { resolveClip, opScaleKeyframe, cameraValue, writeCameraPath } from './add.mjs';
import { applyFreeCurve } from './easing.mjs';

const PROPERTIES = ['KFTypeScaleX', 'KFTypeScaleY', 'KFTypePositionX', 'KFTypePositionY'];
const fail = (message, code = 'BAD_SCREEN_MOTION') => { throw new CapcutError(message, { code, exitCode: 2 }); };
const seconds = us => us / 1e6;
const sourceTime = (s, t) => seconds(s.source_timerange.start)
  + (t - seconds(s.target_timerange.start)) * s.source_timerange.duration / s.target_timerange.duration;
const baseValues = s => [s.clip?.scale?.x ?? 1, s.clip?.scale?.y ?? 1, s.clip?.transform?.x ?? 0, s.clip?.transform?.y ?? 0];

// Bounded native ease-in-out: cubic-bezier(.25,0,.35,1). One synchronized
// progress curve keeps source edges and mask seams pinned without overshoot.
export const SCREEN_EASING = Object.freeze({ outX: .25, outY: 0, inX: -.65, inY: 0 });

/** Plan native camera motion. Region times are absolute timeline seconds; focus is source pixels. */
export function planScreenMotion(doc, op = {}) {
  const id = op.segment || op.selector?.id;
  if (typeof id !== 'string' || !id) fail('screen-motion requires an explicit --segment ID.');
  const entry = resolveClip(doc, { id });
  const segment = entry.segment;
  if (entry.track.type !== 'video') fail('Screen motion requires a video overlay.', 'NOT_VIDEO');
  if (/^layout:/.test(segment.desc || '') && segment.desc !== 'layout:screen-recording') {
    fail('Select the screen recording itself, not the face or a layout helper.', 'SCREEN_MOTION_ROLE');
  }
  const zoomIn = op.zoomIn ?? .65, zoomOut = op.zoomOut ?? .7;
  const connectGap = op.connectGap ?? 1.5, glide = op.glide ?? 1;
  if (![zoomIn, zoomOut, connectGap, glide].every(Number.isFinite)
      || zoomIn <= 0 || zoomOut <= 0 || connectGap < 0 || glide <= 0) {
    fail('Use positive zoom-in, zoom-out and glide seconds, and connect-gap >= 0.');
  }
  const regions = op.regions;
  if (!Array.isArray(regions) || !regions.length || regions.length > 1000) fail('Supply 1–1000 ordered focus regions.');
  const owner = segment.screen_recording_id || segment.screenRecordingId || segment.id;
  const frames = allSegments(doc).map(e => e.segment).filter(s => segment.desc === 'layout:screen-recording'
    && s.desc === 'layout:screen-frame' && (s.screen_recording_id || s.screenRecordingId || s.layout_owner_id) === owner);
  const group = [segment, ...frames];
  const W = doc.canvas_config?.width, H = doc.canvas_config?.height;
  if (![W, H].every(n => Number.isFinite(n) && n > 0)) fail('Screen motion requires a valid project canvas.');
  for (const s of group) {
    const st = s.source_timerange, tt = s.target_timerange;
    if (!st || !tt || ![st.start, st.duration, tt.start, tt.duration].every(Number.isSafeInteger)
        || st.start < 0 || tt.start < 0 || st.duration <= 0 || tt.duration <= 0) fail('Invalid source or timeline range.');
    if (s.reverse || (doc.materials?.speeds || []).some(m => (s.extra_material_refs || []).includes(m.id) && m.curve_speed)) {
      fail('Screen motion requires forward constant-speed footage.', 'MOTION_SPEED_CURVE');
    }
    if (!baseValues(s).every(Number.isFinite) || baseValues(s).slice(0, 2).some(x => x <= 0)) fail('Invalid resting camera transform.');
    if (s.clip?.rotation || s.clip?.flip?.horizontal || s.clip?.flip?.vertical) fail('Screen motion requires unrotated, unflipped footage.');
    if (!op.replace && (s.common_keyframes || []).some(k => PROPERTIES.includes(k.property_type))) {
      fail('This recording or its frame already has camera keys; use --replace to replace that camera path.', 'MOTION_OVERLAP');
    }
    const material = doc.materials?.videos?.find(m => m.id === s.material_id);
    if (!material || ![material.width, material.height].every(n => Number.isFinite(n) && n > 0)) fail('Known source dimensions are required.');
    if (material.type && !['video', 'photo'].includes(material.type)) fail('Screen motion requires a video recording or its linked image frame.');
    if (material.duration > 0 && st.start + st.duration > material.duration + 1) fail('Source range exceeds media duration.', 'SOURCE_AFTER_END');
  }
  const start = seconds(segment.target_timerange.start), end = start + seconds(segment.target_timerange.duration);
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i], previous = regions[i - 1];
    if (!r || ![r.start, r.end].every(Number.isFinite) || r.start < start || r.end + zoomOut > end + 1e-9
        || r.end - r.start < zoomIn - 1e-9 || (previous && r.start < previous.end)) {
      fail('Focus regions must be ordered, non-overlapping timeline ranges inside the selected clip, with room for entrance and final exit.');
    }
    if (!r.focus) fail('Every screen-motion region requires a source-pixel focus rectangle.');
  }

  // Reuse the measured focus geometry and its mask/frame guards; no parallel
  // implementation of CapCut coordinates. Probe only copies until ALL regions pass.
  const clean = structuredClone(doc);
  for (const { segment: s } of allSegments(clean)) if (group.some(g => g.id === s.id)) {
    s.common_keyframes = (s.common_keyframes || []).filter(k => !PROPERTIES.includes(k.property_type));
  }
  const targets = regions.map(r => {
    const probe = structuredClone(clean);
    opScaleKeyframe(probe, { selector: { id }, at: r.start, ramp: zoomIn, hold: 0,
      focus: r.focus, viewport: r.viewport, ease: false, __seed: op.__seed });
    return group.map(g => {
      const s = allSegments(probe).find(e => e.segment.id === g.id).segment;
      const values = PROPERTIES.map((p, j) => cameraValue(s, p, Math.round(sourceTime(s, r.start + zoomIn) * 1e6), baseValues(s)[j]));
      if (!(s.common_keyframes || []).some(k => k.property_type === 'KFTypeScaleY')
          && (s.uniform_scale?.on ?? (baseValues(s)[0] === baseValues(s)[1]))) values[1] = values[0];
      const masked = s.enable_video_mask !== false && (doc.materials?.common_mask || []).some(m => (s.extra_material_refs || []).includes(m.id));
      if (!masked && !frames.length) {
        // An edge focus cannot be centered without uncovering the background.
        // Keep the original visible recording footprint covered. These bounds
        // are linear in scale/position, so bounded synchronized native curves stay
        // inside them too. Mask seams and linked frames retain their own guards.
        const m = doc.materials.videos.find(m => m.id === s.material_id);
        const fit = Math.min(W / m.width, H / m.height), hw = m.width * fit / 2, hh = m.height * fit / 2;
        const [sx, sy, tx, ty] = baseValues(s), cx = W / 2 + tx * W / 2, cy = H / 2 - ty * H / 2;
        const left = Math.max(0, cx - hw * sx), right = Math.min(W, cx + hw * sx);
        const top = Math.max(0, cy - hh * sy), bottom = Math.min(H, cy + hh * sy);
        if (right <= left || bottom <= top) fail('The recording has no visible footprint on the canvas.', 'MOTION_HIDDEN');
        const grow = Math.max(1, (right - left) / (2 * hw * values[0]), (bottom - top) / (2 * hh * values[1]));
        values[0] *= grow; values[1] *= grow;
        const targetX = Math.max(right - hw * values[0], Math.min(left + hw * values[0], W / 2 + values[2] * W / 2));
        const targetY = Math.max(bottom - hh * values[1], Math.min(top + hh * values[1], H / 2 - values[3] * H / 2));
        values[2] = (targetX - W / 2) / (W / 2);
        values[3] = (H / 2 - targetY) / (H / 2);
      }
      return values;
    });
  });
  const base = group.map(baseValues), phases = [];
  let connections = 0;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i], previous = regions[i - 1], next = regions[i + 1];
    const connected = previous && r.start - previous.end <= connectGap;
    if (connected) {
      connections++;
      phases.push({ start: previous.end, end: Math.min(previous.end + glide, r.start + zoomIn), from: targets[i - 1], to: targets[i] });
    } else {
      if (previous && previous.end + zoomOut > r.start) fail('Disconnected zooms overlap; increase connect-gap or shorten zoom-out.');
      phases.push({ start: r.start, end: r.start + zoomIn, from: base, to: targets[i] });
    }
    if (!next || next.start - r.end > connectGap) phases.push({ start: r.end, end: r.end + zoomOut, from: targets[i], to: base });
  }

  const paths = group.map((s, index) => {
    // Four poses for one zoom: wide, focus, hold, wide. A connected target adds
    // just two poses. Native curves interpolate between these editable anchors.
    const poses = phases.flatMap(p => [{ t: p.start, v: p.from[index] }, { t: p.end, v: p.to[index] }])
      .map(p => ({ t: Math.round(sourceTime(s, p.t) * 1e6) / 1e6, v: [...p.v] }));
    const path = poses.filter((p, i) => !i || p.t !== poses[i - 1].t || p.v.some((v, j) => v !== poses[i - 1].v[j]));
    if (path.some((p, i) => !Number.isSafeInteger(Math.round(p.t * 1e6)) || (i && p.t <= path[i - 1].t))) {
      fail('Motion keys collapse at source-microsecond precision; lengthen transitions.', 'BAD_MOTION_PATH');
    }
    return { id: s.id, points: path, poses: path.length };
  });
  return { id, regions: regions.length, connections, zoomIn, zoomOut, connectGap, glide,
    timing: 'absolute-timeline-seconds', curve: 'FreeCurveInOut', easing: SCREEN_EASING,
    nativeVerified: false, clips: paths };
}

export function opScreenMotion(doc, op) {
  const plan = planScreenMotion(doc, op);
  if (op.plan) return { changed: 0, ...plan };
  for (const path of plan.clips) {
    const s = allSegments(doc).find(e => e.segment.id === path.id).segment;
    writeCameraPath(s, path.points, { seed: op.__seed, ease: false });
    for (const block of s.common_keyframes) if (PROPERTIES.includes(block.property_type)) {
      block.keyframe_list = applyFreeCurve(block.keyframe_list, SCREEN_EASING);
    }
  }
  return { changed: plan.clips.length, ...plan };
}
