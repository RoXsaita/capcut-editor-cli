import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapcutError, DEFAULT_ROOT, readJson, stableJson } from './core.mjs';

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
  const transitions = {};
  const sfx = {};
  const masks = {};
  const keyframeTypes = {};
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

export function loadHarvest(file = DEFAULT_HARVEST) {
  if (!fs.existsSync(file)) throw new CapcutError(`harvest file missing: ${file}`, { code: 'NO_HARVEST', exitCode: 2 });
  return readJson(file);
}
