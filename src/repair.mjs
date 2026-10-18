/**
 * Undo what a CapCut save does to a capcutctl draft, without undoing what the user did.
 *
 * A native save (1) re-saves materials under an id it already used, (2) drops every key it does
 * not know — `capcutctl_origin`, `capcutctl_mograph` (the seam-wipe / slab-super / follow-ending
 * identity), the provenance fields — and (3) can leave a B-roll clip reading past the end of its
 * source. Agents used to repair this by hand with a "restore-capcutctl-meta" spec and `sync`.
 *
 * The record of what capcutctl wrote is `.capcutctl/meta-ledger.json`, refreshed by every
 * committed transaction (core.mjs). Older projects have no ledger yet, so the history snapshots
 * and media-map.json fill the gaps. The repair only ever:
 *   - merges duplicate materials that are the same logical file (dedupeMaterials);
 *   - puts a recorded key back where it is MISSING — never overwrites a value, never re-creates
 *     a material or segment the user deleted, and skips a material relinked to another file;
 *   - shortens a non-principal clip that reads past the end of its source, at its own speed.
 * Timing, levels and deletions the user made in CapCut are left exactly as they are.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_RELATIVE = path.join('.capcutctl', 'meta-ledger.json');

const MATERIAL_KEYS = new Set(['derived_from_path', 'derived_from_offset', 'source_take_id', 'source_path', 'original_path']);
const SEGMENT_KEYS = new Set(['desc', 'source_take_id']);
const isMaterialKey = key => key.startsWith('capcutctl_') || MATERIAL_KEYS.has(key);
const isSegmentKey = key => key.startsWith('capcutctl_') || SEGMENT_KEYS.has(key);
const present = value => value != null && value !== '';
const SNAPSHOT_FALLBACK_LIMIT = 20;

/** The capcutctl-owned fields of one document, keyed by material and segment id. */
export function metaRecord(docs) {
  const record = { version: 1, materials: {}, segments: {} };
  for (const doc of docs) {
    for (const [kind, values] of Object.entries(doc?.materials || {})) {
      if (!Array.isArray(values)) continue;
      for (const m of values) {
        if (!m?.id) continue;
        const fields = Object.fromEntries(Object.entries(m).filter(([k, v]) => isMaterialKey(k) && present(v)));
        if (!Object.keys(fields).length) continue;
        const entry = record.materials[m.id] ||= { kind, path: m.path ? path.basename(String(m.path)) : null, fields: {} };
        Object.assign(entry.fields, fields);
      }
    }
    for (const track of doc?.tracks || []) {
      for (const s of track?.segments || []) {
        if (!s?.id) continue;
        const fields = Object.fromEntries(Object.entries(s).filter(([k, v]) => isSegmentKey(k) && present(v)));
        if (!Object.keys(fields).length) continue;
        const entry = record.segments[s.id] ||= { material_id: s.material_id || null, fields: {} };
        Object.assign(entry.fields, fields);
      }
    }
  }
  return record;
}

const isEmpty = record => !Object.keys(record.materials).length && !Object.keys(record.segments).length;

/** Fill `into` from `from` for ids and keys `into` does not have yet. */
function fillRecord(into, from) {
  for (const section of ['materials', 'segments']) {
    for (const [id, entry] of Object.entries(from?.[section] || {})) {
      const have = into[section][id];
      if (!have) { into[section][id] = structuredClone(entry); continue; }
      for (const [key, value] of Object.entries(entry.fields || {})) if (!(key in have.fields)) have.fields[key] = value;
    }
  }
  return into;
}

/**
 * The ledger a commit writes: what the docs carry now, plus what the previous ledger knew about
 * ids that still exist (so one transaction on a stripped draft does not forget the rest).
 */
export function nextLedger(previous, docs) {
  const record = metaRecord(docs);
  const live = metaRecord([]);
  const ids = { materials: new Set(), segments: new Set() };
  for (const doc of docs) {
    for (const values of Object.values(doc?.materials || {})) if (Array.isArray(values)) for (const m of values) if (m?.id) ids.materials.add(m.id);
    for (const track of doc?.tracks || []) for (const s of track?.segments || []) if (s?.id) ids.segments.add(s.id);
  }
  for (const section of ['materials', 'segments']) {
    for (const [id, entry] of Object.entries(previous?.[section] || {})) if (ids[section].has(id)) live[section][id] = entry;
  }
  fillRecord(record, live);
  return isEmpty(record) ? null : record;
}

function readJsonOr(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readLedgerFile(projectDir) {
  const value = readJsonOr(path.join(projectDir, LEDGER_RELATIVE), null);
  return value?.version === 1 ? value : null;
}

/**
 * Everything capcutctl knows it wrote: the ledger first, then the newest history snapshots (a
 * snapshot holds the draft as capcutctl last saw it, metadata included), then media-map.json's
 * origins. Earlier sources win; later ones only fill ids and keys still missing.
 */
export function readMetaRecord(projectDir) {
  const record = fillRecord(metaRecord([]), readLedgerFile(projectDir));
  const history = path.join(projectDir, '.capcutctl', 'history');
  let snapshots = [];
  try { snapshots = fs.readdirSync(history).sort().reverse().slice(0, SNAPSHOT_FALLBACK_LIMIT); } catch { /* no history */ }
  for (const name of snapshots) {
    const docs = [];
    const root = readJsonOr(path.join(history, name, 'draft_info.json'), null);
    if (root) docs.push(root);
    try {
      for (const id of fs.readdirSync(path.join(history, name, 'Timelines'))) {
        const doc = readJsonOr(path.join(history, name, 'Timelines', id, 'draft_info.json'), null);
        if (doc) docs.push(doc);
      }
    } catch { /* root-only snapshot */ }
    fillRecord(record, metaRecord(docs));
  }
  const map = readJsonOr(path.join(projectDir, '.capcutctl', 'media-map.json'), {});
  for (const [id, item] of Object.entries(map?.materials || {})) {
    const fields = {};
    if (item?.origin) fields.capcutctl_origin = item.origin;
    if (item?.derivedFromPath || item?.derived_from_path) fields.derived_from_path = item.derivedFromPath || item.derived_from_path;
    if (item?.sourceTakeId) fields.source_take_id = item.sourceTakeId;
    if (Object.keys(fields).length) fillRecord(record, { materials: { [id]: { kind: 'videos', path: null, fields } } });
  }
  return record;
}

/** Restore recorded keys that are missing. Returns one row per restored key. */
export function restoreMeta(doc, record) {
  const restored = [];
  for (const values of Object.values(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const m of values) {
      const entry = record.materials[m?.id];
      if (!entry) continue;
      // Relinked in CapCut to another file: the recorded provenance is about the old one.
      if (entry.path && m.path && path.basename(String(m.path)) !== entry.path) continue;
      for (const [key, value] of Object.entries(entry.fields)) {
        if (present(m[key])) continue;
        m[key] = structuredClone(value);
        restored.push({ material: m.id, key });
      }
    }
  }
  for (const track of doc.tracks || []) {
    for (const s of track.segments || []) {
      const entry = record.segments[s?.id];
      if (!entry || (entry.material_id && s.material_id !== entry.material_id)) continue;
      for (const [key, value] of Object.entries(entry.fields)) {
        if (present(s[key])) continue;
        s[key] = structuredClone(value);
        restored.push({ segment: s.id, key });
      }
    }
  }
  return restored;
}

/**
 * Shorten a clip that reads past the end of its source so it ends where the source does, at its
 * own speed. Stills (photos) are skipped: CapCut gives them a nominal duration. The principal
 * track is reported, never shortened — that would open a gap in the cut.
 */
export function clampOverruns(doc, { principalIndex = null } = {}) {
  const byId = new Map();
  for (const kind of ['videos', 'audios']) for (const m of doc.materials?.[kind] || []) if (m?.id) byId.set(m.id, m);
  const clamped = [], left = [];
  for (const [index, track] of (doc.tracks || []).entries()) {
    for (const s of track.segments || []) {
      const src = s.source_timerange, tgt = s.target_timerange, m = byId.get(s.material_id);
      if (!src || !tgt || !m || m.type === 'photo' || !(m.duration > 0)) continue;
      const over = src.start + src.duration - m.duration;
      if (over <= 1) continue;
      const room = m.duration - src.start;
      if (index === principalIndex || room <= 0) { left.push({ segment: s.id, overUs: over, principal: index === principalIndex }); continue; }
      const speed = s.speed > 0 ? s.speed : (tgt.duration > 0 ? src.duration / tgt.duration : 1);
      const before = tgt.duration;
      src.duration = room;
      tgt.duration = Math.max(1, Math.round(room / speed));
      if (s.render_timerange?.duration) s.render_timerange.duration = tgt.duration;
      clamped.push({ segment: s.id, track: track.name || track.type, byUs: before - tgt.duration });
    }
  }
  return { clamped, left };
}
