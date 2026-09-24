import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT, readJson, stableJson } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HARVEST = path.join(HERE, '..', 'presets', 'harvest.json');
/** His usual projects. This is an ORDERING hint, not the list: harvest walks the root. */
export const PREFERRED_SOURCES = ['IKEA Refund', 'Hermes-agent', 'Higgsfield Refund', 'Content System', 'Preset 3'];

/**
 * Read-only. Hardcoding five names meant a draft he made this morning was invisible unless
 * he passed --projects, so enumerate the drafts root and merely sort the known five first.
 */
export function defaultSources(root = DEFAULT_ROOT) {
  let found;
  try {
    found = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch {
    return [...PREFERRED_SOURCES];               // no root here: degrade to the known names
  }
  const known = new Set(PREFERRED_SOURCES);
  return [
    ...PREFERRED_SOURCES.filter(n => found.includes(n)),
    ...found.filter(n => !known.has(n)).sort()
  ];
}

function draftPaths(projectDir) {
  const out = [];
  const root = path.join(projectDir, 'draft_info.json');
  if (fs.existsSync(root)) out.push(root);
  const tl = path.join(projectDir, 'Timelines');
  if (fs.existsSync(tl)) {
    for (const name of fs.readdirSync(tl)) {
      const p = path.join(tl, name, 'draft_info.json');
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

function loadLatest(projectDir) {
  const withMtime = [];
  for (const f of draftPaths(projectDir)) {
    // a dangling symlink under Timelines/ throws on stat; it is not a draft, so drop it
    try { withMtime.push({ f, t: fs.statSync(f).mtimeMs }); } catch { /* unreadable */ }
  }
  if (!withMtime.length) return null;
  withMtime.sort((a, b) => b.t - a.t);
  return readJson(withMtime[0].f);
}

function count(map, key) {
  if (key == null || key === '') return;
  map[key] = (map[key] || 0) + 1;
}

const block = (name, seg, kfs) => ({
  source: name,
  segmentId: seg.id,
  source_timerange: seg.source_timerange,
  target_timerange: seg.target_timerange,
  common_keyframes: kfs
});

// A point with real bezier handles: 68 of these across 10 of his drafts, against 4414 Line
// points — an eased move reads deliberate where a Line one reads like a slide. Test curveType
// and NOT left_control/right_control: CapCut writes those control objects on Line points too.
const eased = k => (k.keyframe_list || []).some(p => p?.curveType === 'FreeCurveInOut');

/**
 * Catalogue only. Walks his drafts for transition / SFX / mask names, one linear and one
 * eased Position+Scale keyframe block, plus a verified audio_fade extra.
 * There is no --apply.
 */
export function harvestDrafts(root = DEFAULT_ROOT, names = defaultSources(root)) {
  const transitions = Object.create(null);
  const sfx = Object.create(null);
  const masks = Object.create(null);
  const keyframeTypes = Object.create(null);
  let audioFade = null;
  let positionScale = null;
  let positionScaleEased = null;
  let easedAny = null;
  const scanned = [];
  const missing = [];
  const failed = [];

  for (const name of names) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) { missing.push(name); continue; }
    let doc;
    try {
      doc = loadLatest(dir);
    } catch (error) {
      // one unparseable draft_info.json used to abort the run and leave every OTHER draft
      // uncatalogued; record it and keep walking
      failed.push({ name, error: error.message });
      continue;
    }
    if (!doc) { missing.push(name); continue; }
    scanned.push(name);
    for (const t of doc.materials?.transitions || []) count(transitions, t.name || t.resource_id || t.type);
    for (const a of doc.materials?.audios || []) count(sfx, a.name || a.material_name || (a.path ? path.basename(a.path) : null));
    for (const m of doc.materials?.common_mask || []) count(masks, m.name || m.resource_type || m.type);
    for (const fade of doc.materials?.audio_fades || []) {
      if (!audioFade && (fade.fade_in_duration || fade.fade_out_duration)) {
        audioFade = { source: name, extra: { type: fade.type, fade_type: fade.fade_type, fade_in_duration: fade.fade_in_duration, fade_out_duration: fade.fade_out_duration } };
      }
    }
    for (const track of doc.tracks || []) {
      for (const seg of track.segments || []) {
        const kfs = seg.common_keyframes || [];
        for (const k of kfs) count(keyframeTypes, k.property_type);
        const types = new Set(kfs.map(k => k.property_type));
        const move = kfs.filter(k => /KFType(PositionX|PositionY|ScaleX)/.test(k.property_type || ''));
        const positionScaled = types.has('KFTypePositionX') && types.has('KFTypeScaleX');
        if (!positionScale && positionScaled) positionScale = block(name, seg, move);
        if (!positionScaleEased && positionScaled && move.some(eased)) positionScaleEased = block(name, seg, move);
        if (!easedAny && kfs.some(eased)) easedAny = block(name, seg, kfs.filter(eased));
      }
    }
  }

  // prefer a Position+Scale block, but any real eased block beats inventing bezier handles
  positionScaleEased ||= easedAny;

  if (!audioFade) {
    audioFade = {
      source: 'Higgsfield Refund (verified shape)',
      extra: { type: 'audio_fade', fade_type: 0, fade_in_duration: 0, fade_out_duration: 166666 }
    };
  }

  return {
    harvestedAt: new Date().toISOString(),
    sources: names,
    scanned,
    missing,
    failed,
    transitions: Object.entries(transitions).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    sfx: Object.entries(sfx).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    masks: Object.entries(masks).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    keyframeTypes: Object.entries(keyframeTypes).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    audioFade,
    positionScale,
    positionScaleEased,
    note: 'Catalogue only. Do not invent Position keyframes — copy positionScale.common_keyframes, or positionScaleEased.common_keyframes for a bezier move. Fade clones audioFade.extra.'
  };
}

export function writeHarvest(catalogue, dest = DEFAULT_HARVEST) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, stableJson(catalogue));
  return dest;
}

const median = values => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const r3 = n => (n == null ? null : Math.round(n * 1000) / 1000);

/**
 * A profile override measured from the user's own drafts — the "harvest their edits" answer to
 * the first-run style question. Only what the drafts actually show is written; everything else
 * falls back to the bundled profile when this file is used as CAPCUTCTL_PRESET_DIR/profile.json
 * or `--profile FILE`. Measurements go under `provenance`, so a human can see what drove it.
 */
export function profileFromDrafts(root = DEFAULT_ROOT, names = defaultSources(root)) {
  const pushes = [];
  const clipLengths = [];
  const transitionsPerProject = [];
  const transitionNames = Object.create(null);
  const scanned = [];
  for (const name of names) {
    let doc = null;
    try { doc = loadLatest(path.join(root, name)); } catch { doc = null; }
    if (!doc) continue;
    scanned.push(name);
    transitionsPerProject.push((doc.materials?.transitions || []).length);
    for (const t of doc.materials?.transitions || []) count(transitionNames, t.name || t.resource_id || 'transition');
    const video = (doc.tracks || []).filter(t => t.type === 'video' && (t.segments || []).length);
    const principal = video.sort((a, b) => (b.segments || []).length - (a.segments || []).length)[0];
    for (const s of principal?.segments || []) clipLengths.push((s.target_timerange?.duration || 0) / 1e6);
    for (const track of video) {
      for (const seg of track.segments || []) {
        const scale = (seg.common_keyframes || []).find(k => k.property_type === 'KFTypeScaleX');
        const values = (scale?.keyframe_list || []).map(k => k.values?.[0]).filter(Number.isFinite);
        if (values.length >= 2 && Math.min(...values) > 0.5) {
          const ratio = Math.max(...values) / Math.min(...values);
          if (ratio > 1.01 && ratio < 3) pushes.push(ratio);
        }
      }
    }
  }
  const withTransitions = transitionsPerProject.filter(n => n > 0).length;
  const totalTransitions = Object.values(transitionNames).reduce((a, b) => a + b, 0);
  const top = Object.entries(transitionNames).sort((a, b) => b[1] - a[1])[0];
  const out = {
    version: 1,
    name: `harvested-${new Date().toISOString().slice(0, 10)}`,
    provenance: {
      _note: 'Measured by `capcutctl harvest --profile` from the drafts listed. Evidence, not targets.',
      drafts: scanned,
      medianCutSeconds: r3(median(clipLengths)),
      facePushRatios: pushes.length,
      projectsWithTransitions: `${withTransitions}/${scanned.length}`,
      topTransition: top ? { name: top[0], share: r3(top[1] / totalTransitions) } : null,
    },
  };
  const push = median(pushes);
  if (push) out.camera = { push: { scale: r3(push) } };
  if (scanned.length) out.seams = { hardCutsByDefault: withTransitions / scanned.length < 0.25 };
  return out;
}
