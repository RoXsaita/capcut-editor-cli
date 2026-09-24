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

/**
 * Parse `--allow` into selectors. A bare token is a segment id; `track:NAME` or `track:N`
 * admits every segment on that track, including ones the edit adds, whose ids nobody could
 * have named beforehand.
 */
export function parseAllow(values) {
  const tokens = (Array.isArray(values) ? values : [values])
    .flatMap(value => String(value ?? '').split(','))
    .map(token => token.trim())
    .filter(Boolean);
  const segments = new Set();
  const tracks = new Set();
  for (const token of tokens) {
    if (token.startsWith('track:')) {
      const name = token.slice('track:'.length).trim();
      if (!name) throw new Error(`empty track selector in --allow: ${token}`);
      tracks.add(name);
    } else segments.add(token);
  }
  if (!segments.size && !tracks.size) throw new Error('--allow needs at least one segment id or track:NAME');
  return { segments, tracks, tokens };
}

const onAllowedTrack = (entry, tracks) => entry != null && (
  (entry.trackName != null && tracks.has(entry.trackName)) || (entry.track != null && tracks.has(String(entry.track))));

const trackAllowed = (track, tracks) => track != null && (
  (track.name != null && tracks.has(track.name)) || tracks.has(String(track.index)));

/** Which summary fields differ between two versions of one item, with both values. */
function changedFields(before, after, ignore = []) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = {};
  for (const key of keys) {
    if (ignore.includes(key)) continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      out[key] = { from: before[key] ?? null, to: after[key] ?? null };
    }
  }
  return out;
}

/**
 * Prove an edit stayed inside what it was asked to touch.
 *
 * "Change only the second graphic" is the commonest revision note, and a diff that lists
 * every change still leaves the agent to notice that one of forty rows is a face clip it
 * was never meant to move. This names every difference OUTSIDE the allowed selectors, with
 * both values, and `ok` is false when there is one. Track index shifts (`moved`) are not
 * findings: inserting an overlay track shifts every index below it without touching them.
 * A material is in scope when an allowed segment uses it or no segment uses it at all.
 */
export function scopeCheck(diff, allow, users = null) {
  const { segments: ids, tracks, tokens } = allow;
  const segAllowed = (...entries) => entries.some(e => e && (ids.has(e.id) || onAllowedTrack(e, tracks)));
  const outOfScope = [];
  const touched = new Set();
  for (const s of diff.segments.added) {
    if (segAllowed(s)) touched.add(s.id);
    else outOfScope.push({ kind: 'segment', change: 'added', id: s.id, track: s.track, trackName: s.trackName, value: s });
  }
  for (const s of diff.segments.removed) {
    if (segAllowed(s)) touched.add(s.id);
    else outOfScope.push({ kind: 'segment', change: 'removed', id: s.id, track: s.track, trackName: s.trackName, value: s });
  }
  for (const { before, after } of diff.segments.changed) {
    if (segAllowed(before, after)) { touched.add(after.id); continue; }
    outOfScope.push({ kind: 'segment', change: 'changed', id: after.id, track: after.track, trackName: after.trackName,
      fields: changedFields(before, after, ['track']) });
  }
  for (const t of diff.tracks.added) {
    if (!trackAllowed(t, tracks) && t.segments > 0 && !diff.segments.added.some(s => s.track === t.index && segAllowed(s))) {
      outOfScope.push({ kind: 'track', change: 'added', index: t.index, name: t.name, value: t });
    }
  }
  for (const t of diff.tracks.removed) {
    if (!trackAllowed(t, tracks) && t.segments > 0 && !diff.segments.removed.some(s => s.track === t.index && segAllowed(s))) {
      outOfScope.push({ kind: 'track', change: 'removed', index: t.index, name: t.name, value: t });
    }
  }
  for (const { before, after } of diff.tracks.changed) {
    const fields = changedFields(before, after, ['index', 'segments']);
    if (!Object.keys(fields).length || trackAllowed(before, tracks) || trackAllowed(after, tracks)) continue;
    outOfScope.push({ kind: 'track', change: 'changed', index: after.index, name: after.name, fields });
  }
  const materialInScope = id => {
    if (!users) return true;
    const using = users.get(id) || [];
    return !using.length || using.some(entry => segAllowed(entry));
  };
  for (const change of ['added', 'removed']) {
    for (const m of diff.materials[change]) {
      if (!materialInScope(m.id)) outOfScope.push({ kind: 'material', change, id: m.id, path: m.path });
    }
  }
  for (const { before, after } of diff.materials.changed) {
    if (!materialInScope(after.id)) {
      outOfScope.push({ kind: 'material', change: 'changed', id: after.id, fields: changedFields(before, after, ['material_name']) });
    }
  }
  return { allow: tokens, ok: outOfScope.length === 0, touched: [...touched], outOfScope };
}

/** Every segment (before or after) that references each material id. */
export function materialUsers(before, after) {
  const users = new Map();
  for (const s of [...(before.segments || []), ...(after.segments || [])]) {
    if (!s.material) continue;
    if (!users.has(s.material)) users.set(s.material, []);
    users.get(s.material).push(s);
  }
  return users;
}
