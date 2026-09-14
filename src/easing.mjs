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
