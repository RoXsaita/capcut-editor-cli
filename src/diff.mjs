import { allSegments, documentFingerprint, loadProject, materialIndex } from './core.mjs';

const r3 = n => Math.round(n * 1000) / 1000;

function materialPath(doc, id) {
  const hit = materialIndex(doc).get(id);
  return hit?.value?.path || null;
}

export function summarizeDoc(doc) {
  return {
    duration: r3((doc.duration || 0) / 1e6),
    fingerprint: documentFingerprint(doc),
    tracks: (doc.tracks || []).map((t, index) => ({
      index, id: t.id, type: t.type, name: t.name || null, flag: t.flag, segments: (t.segments || []).length
    })),
    segments: allSegments(doc).map(e => ({
      id: e.segment.id,
      track: e.trackIndex,
      trackName: e.track.name || null,
      desc: e.segment.desc || null,
      start: r3((e.segment.target_timerange?.start || 0) / 1e6),
      dur: r3((e.segment.target_timerange?.duration || 0) / 1e6),
      source: e.segment.source_timerange
        ? [r3(e.segment.source_timerange.start / 1e6), r3((e.segment.source_timerange.start + e.segment.source_timerange.duration) / 1e6)]
        : null,
      material: e.segment.material_id,
      path: materialPath(doc, e.segment.material_id),
      volume: e.segment.volume,
      speed: e.segment.speed
    })),
    // material_name is carried for the reader but never compared: it is the field CapCut
    // rewrites as noise when it re-saves a material under an id it already used.
    materials: (doc.materials?.videos || []).map(m => ({
      id: m.id,
      path: m.path || null,
      name: m.name ?? null,
      material_name: m.material_name ?? null,
      type: m.type ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
      duration: m.duration ?? null
    }))
  };
}

export function summarizeProject(dir) {
  const doc = loadProject(dir).groups.find(g => g.name === 'root').doc;
  return summarizeDoc(doc);
}

/**
 * The tolerated set from dedupeMaterials in core.mjs. CapCut legitimately re-saves the
 * same logical material under an id it already used, differing only in noise, so a diff
 * that compared whole objects reported a document as different from itself.
 */
const MATERIAL_FIELDS = ['path', 'width', 'height', 'duration', 'type', 'name'];

/**
 * Key every item by identity, not by position. Ids that repeat (duplicate materials, and
 * tracks that carry no id at all) get an ordinal suffix so two of them never collapse into
 * one Map entry and silently diff against each other.
 */
function keyed(items, keyOf) {
  const seen = new Map();
  const out = new Map();
  for (const item of items) {
    const base = keyOf(item);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.set(n ? `${base}#${n}` : base, item);
  }
  return out;
}

const pick = (value, keys) => JSON.stringify(keys.map(k => value[k] ?? null));
const omit = (value, field) => JSON.stringify(
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== field)));

/**
 * `positionField` names the field that only says WHERE the thing sits. `capcutctl add`
 * inserts overlay tracks routinely, and comparing that field would report every untouched
 * track and segment as changed the moment one track is prepended — so a position shift is
 * reported on its own as `moved`, never as a wholesale change.
 */
function compare(beforeList, afterList, keyOf, { positionField = null, fields = null } = {}) {
  const a = keyed(beforeList, keyOf);
  const b = keyed(afterList, keyOf);
  const body = v => (fields ? pick(v, fields) : omit(v, positionField));
  const changed = [];
  const moved = [];
  for (const [key, before] of a) {
    const after = b.get(key);
    if (!after) continue;
    if (body(before) !== body(after)) changed.push({ before, after });
    if (positionField && before[positionField] !== after[positionField]) {
      moved.push({ id: before.id ?? null, from: before[positionField], to: after[positionField] });
    }
  }
  return {
    added: [...b].filter(([key]) => !a.has(key)).map(([, v]) => v),
    removed: [...a].filter(([key]) => !b.has(key)).map(([, v]) => v),
    changed,
    moved
  };
}

// A track's id is optional in drafts CapCut wrote itself. Fall back to its shape, which
// keyed() then makes unique per occurrence; without ids that is the best identity there is.
const trackKey = t => (t.id ? `id:${t.id}` : `anon:${t.type}/${t.name || ''}/${t.flag ?? ''}`);

export function diffSummaries(before, after) {
  const tracks = compare(before.tracks || [], after.tracks || [], trackKey, { positionField: 'index' });
  const segments = compare(before.segments, after.segments, s => `id:${s.id}`, { positionField: 'track' });
  const mat = compare(before.materials || [], after.materials || [], m => `id:${m.id}`, { fields: MATERIAL_FIELDS });
  const materials = { added: mat.added, removed: mat.removed, changed: mat.changed };
  return {
    duration: { from: before.duration, to: after.duration },
    fingerprint: { from: before.fingerprint, to: after.fingerprint, same: before.fingerprint === after.fingerprint },
    segments,
    tracks,
    materials
  };
}
