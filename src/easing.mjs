/**
 * Harvested FreeCurveInOut handle shape.
 *
 * The out-handle runs +17% of the leg in time and +89% of its value change; the
 * in-handle −68% / +27%. Read off the one real eased block in the user's drafts
 * (Higgsfield Refund → presets/harvest.json positionScaleEased / signature.json
 * glowReveal.handles). CapCut also writes left_control/right_control on Line
 * points, so callers must test `curveType`, not the presence of control objects.
 */
export const FREE_CURVE_HANDLES = Object.freeze({
  outX: 0.17, outY: 0.89, inX: -0.68, inY: 0.27,
});

export function freeCurveControls({
  inSpan = 0, outSpan = 0, inDv = 0, outDv = 0, handles = FREE_CURVE_HANDLES,
} = {}) {
  const h = handles || FREE_CURVE_HANDLES;
  return {
    left_control: { x: Math.round(h.inX * inSpan), y: h.inY * inDv },
    right_control: { x: Math.round(h.outX * outSpan), y: h.outY * outDv },
  };
}

/** Stamp FreeCurveInOut + harvested handles on an already-timed keyframe_list. */
export function applyFreeCurve(list, handles = FREE_CURVE_HANDLES) {
  return (list || []).map((point, i, all) => {
    const prev = all[i - 1], next = all[i + 1];
    const controls = freeCurveControls({
      inSpan: prev ? point.time_offset - prev.time_offset : 0,
      outSpan: next ? next.time_offset - point.time_offset : 0,
      inDv: prev ? point.values[0] - prev.values[0] : 0,
      outDv: next ? next.values[0] - point.values[0] : 0,
      handles,
    });
    return {
      ...point,
      curveType: 'FreeCurveInOut',
      left_control: controls.left_control,
      right_control: controls.right_control,
    };
  });
}

/** Native FreeCurveInOut controls are offsets from their own key (9.4.0 UI probe). */
export function keyframeValue(points, time, fallback = 0) {
  if (!points?.length) return fallback;
  if (time <= points[0].time_offset) return points[0].values[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (time > b.time_offset) continue;
    const ax = a.time_offset, bx = b.time_offset, ay = a.values[0], by = b.values[0];
    if (bx === ax) return by;
    if (a.curveType !== 'FreeCurveInOut' && b.curveType !== 'FreeCurveInOut') return ay + (by - ay) * (time - ax) / (bx - ax);
    const ar = a.right_control || { x: 0, y: 0 }, bl = b.left_control || { x: 0, y: 0 };
    const cubic = (u, p, q, r, s) => (1-u)**3*p + 3*(1-u)**2*u*q + 3*(1-u)*u*u*r + u**3*s;
    let lo = 0, hi = 1;
    for (let j = 0; j < 40; j++) {
      const u = (lo + hi) / 2;
      if (cubic(u, ax, ax + ar.x, bx + bl.x, bx) < time) lo = u; else hi = u;
    }
    return cubic((lo + hi) / 2, ay, ay + ar.y, by + bl.y, by);
  }
  return points.at(-1).values[0];
}

/** Time-domain RDP: bound reconstructed position, retaining marked click instants. */
export function simplifyMotion(points, tolerance = 6) {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]);
  points.forEach((p, i) => { if (p.keep) keep.add(i); });
  const anchors = [...keep].sort((a,b) => a-b), stack = anchors.slice(1).map((b,i) => [anchors[i],b]);
  while (stack.length) {
    const [a,b] = stack.pop(); let worst = tolerance, at = -1;
    for (let i = a+1; i < b; i++) {
      const f = (points[i].t-points[a].t)/(points[b].t-points[a].t);
      const e = Math.hypot(...points[i].v.map((v,k) => v-points[a].v[k]-(points[b].v[k]-points[a].v[k])*f));
      if (e > worst) { worst=e; at=i; }
    }
    if (at >= 0) { keep.add(at); stack.push([a,at],[at,b]); }
  }
  return [...keep].sort((a,b)=>a-b).map(i=>points[i]);
}
