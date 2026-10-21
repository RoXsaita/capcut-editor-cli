/**
 * What a native CapCut save does to a capcutctl draft: every key it does not know is dropped
 * (capcutctl_* on materials, `desc` on segments) and the first video material is written twice
 * under one id, one frame apart (its re-probe). Tests layer the user's own edits on top.
 */
export function capcutResave(doc) {
  const out = structuredClone(doc);
  for (const values of Object.values(out.materials)) {
    if (!Array.isArray(values)) continue;
    for (const m of values) for (const key of Object.keys(m)) if (key.startsWith('capcutctl_')) delete m[key];
  }
  for (const s of out.tracks.flatMap(t => t.segments || [])) delete s.desc;
  const dup = structuredClone(out.materials.videos[0]);
  dup.duration += 33_333;                                   // CapCut's one-frame re-probe
  out.materials.videos.push(dup);
  return out;
}
