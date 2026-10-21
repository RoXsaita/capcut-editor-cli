/**
 * The shared speech index: which `~/Downloads/.video-index` file belongs to a piece of media.
 *
 * `cut` writes `<stem>.whisper-<model>.json` (words) and `<stem>.energy10.json` (loudness) for
 * the ORIGINAL take, each carrying the source identity it was built from (`_token` / `token`:
 * inode, size, mtime_ns, a content hash). Every reader used to match on the file name alone,
 * each with its own stem rules, so:
 *   - two takes both named face.mp4 shared one transcript, whichever was indexed last;
 *   - `facecam.whisper-*.json` answered for face.mp4 (a bare `startsWith`);
 *   - a localized copy (`Downloads__face.mp4`, `F7ED__face__1a2b3c4d.mp4`) missed when the
 *     parent folder itself had an underscore, and so did a derived file (denoise, blur)
 *     whose words live under the original it was made from.
 * One lookup now serves anchors, stress, duck, denoise, match and the B-roll lint.
 *
 * A file is accepted only when its recorded size equals the media's. Same inode: the file
 * itself, so mtime_ns must match too. A different inode is a copy (localize, relink), and
 * size is the evidence a copy can carry. The content hash is never recomputed here. Files
 * written before tokens existed are accepted last, marked `legacy`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMediaPath, sanitizeName } from './core.mjs';

export const INDEX_MISMATCH = 'index belongs to another file';

/** The cache `cut` writes to. Read at call time: tests and other users swap HOME. */
export function defaultIndexDir() {
  return path.join(os.homedir(), 'Downloads', '.video-index');
}

/**
 * Every stem the index for `file` may be keyed on, sanitized. `localizeMedia` names a copy
 * `<parent>__<name>[__<8 hex>[_n]]` and the parent may itself contain `__`, so the original
 * name is the suffix after ANY `__`, tried longest first.
 */
export function indexStems(file) {
  const base = sanitizeName(path.basename(String(file || '')).replace(/\.[^.]+$/, ''));
  if (!base) return [];
  const out = [];
  const add = value => { if (value && !out.includes(value)) out.push(value); };
  const bare = base.replace(/__[0-9a-f]{8}(_\d+)?$/, '');
  for (const value of [base, bare]) {
    add(value);
    for (let at = value.indexOf('__'); at >= 0; at = value.indexOf('__', at + 1)) add(value.slice(at + 2));
  }
  return out;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tokenOf(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const token = data._token ?? data.token ?? data.source_token ?? data.media_token ?? null;
  return token && typeof token === 'object' ? token : null;
}

/** 'match' | 'mismatch' | 'legacy' (no token). A token with no media to compare is refused. */
function tokenVerdict(token, media) {
  if (!token || !Number.isFinite(Number(token.size))) return 'legacy';
  let stat;
  try { stat = fs.statSync(media, { bigint: true }); } catch { return 'mismatch'; }
  if (Number(token.size) !== Number(stat.size)) return 'mismatch';
  const ino = token.ino ?? token.inode;
  if (ino != null && Number(ino) === Number(stat.ino)) {
    if (token.mtime_ns != null && Number(token.mtime_ns) !== Number(stat.mtimeNs)) return 'mismatch';
  }
  return 'match';
}

/**
 * The index file of `kind` ('whisper' | 'energy10') for one media path:
 * { file, legacy } when found, { file: null, reason } when not.
 */
export function findIndexFile(media, kind, { cacheDir = null } = {}) {
  if (!media) return { file: null, reason: 'no media path' };
  const root = cacheDir || defaultIndexDir();
  let names;
  try { names = fs.readdirSync(root).filter(name => name.endsWith('.json')).sort(); } catch { return { file: null, reason: 'no index cache' }; }
  const legacy = [];
  let rejected = 0;
  for (const stem of indexStems(media)) {
    const prefix = `${stem}.${kind}`;
    for (const name of names) {
      if (!sanitizeName(name).startsWith(prefix)) continue;
      const file = path.join(root, name);
      const data = readJsonSafe(file);
      if (data == null) continue;
      const verdict = tokenVerdict(tokenOf(data), media);
      if (verdict === 'match') return { file, legacy: false };
      if (verdict === 'mismatch') rejected++;
      else legacy.push(file);
    }
  }
  if (legacy.length) return { file: legacy[0], legacy: true };
  return { file: null, reason: rejected ? INDEX_MISMATCH : 'no index file' };
}

function mediaMapRecord(projectDir, materialId) {
  if (!projectDir || !materialId) return null;
  const map = readJsonSafe(path.join(projectDir, '.capcutctl', 'media-map.json'));
  const record = map?.materials?.[materialId];
  return record && typeof record === 'object' ? record : null;
}

/**
 * Where a material's speech index may live, in order: its own file, the original a derived
 * file was made from (with the offset the derived file starts at, in seconds), and the
 * original media-map.json recorded at import. `derivedFirst` puts the derived original first.
 */
export function indexCandidates(material, projectDir = null, { derivedFirst = false } = {}) {
  if (!material) return [];
  const record = mediaMapRecord(projectDir, material.id);
  const out = [];
  const add = (raw, offset = 0) => {
    const file = typeof raw === 'string' && raw ? (resolveMediaPath(raw, projectDir || '.') || raw) : null;
    if (!file || out.some(c => c.path === file)) return;
    const n = Number(offset);
    out.push({ path: file, offset: Number.isFinite(n) && n > 0 ? n : 0 });
  };
  const derived = material.derived_from_path || record?.derived_from_path || null;
  const derivedOffset = material.derived_from_offset ?? record?.derived_from_offset ?? 0;
  if (derivedFirst && derived) add(derived, derivedOffset);
  add(material.path);
  if (derived) add(derived, derivedOffset);
  add(record?.originalPath || record?.original_path);
  return out;
}

/**
 * The index of `kind` for a material: { file, offset, media, legacy } or { file: null, reason }.
 * A verified file anywhere in the candidates beats a legacy one.
 */
export function findIndexForMaterial(material, projectDir, kind, { cacheDir = null, derivedFirst = false } = {}) {
  let legacy = null, reason = null;
  for (const candidate of indexCandidates(material, projectDir, { derivedFirst })) {
    const hit = findIndexFile(candidate.path, kind, { cacheDir });
    if (hit.file && !hit.legacy) return { file: hit.file, offset: candidate.offset, media: candidate.path, legacy: false };
    if (hit.file) legacy ||= { file: hit.file, offset: candidate.offset, media: candidate.path, legacy: true };
    else if (hit.reason === INDEX_MISMATCH || !reason) reason = hit.reason;
  }
  return legacy || { file: null, reason: reason || 'no index file' };
}

/** Words moved into the derived file's time: subtract the offset, drop what starts before 0. */
export function shiftWords(words, offset) {
  if (!(offset > 0)) return words;
  return (words || []).flatMap(w => {
    const start = Number(w.start) - offset;
    if (!Number.isFinite(start) || start < 0) return [];
    const end = Number(w.end ?? w.start) - offset;
    return [{ ...w, start: Math.round(start * 1e6) / 1e6, end: Math.round(end * 1e6) / 1e6 }];
  });
}

/** A Whisper transcript (segments[].words) moved by `offset` seconds. */
export function shiftTranscript(transcript, offset) {
  if (!(offset > 0) || !transcript) return transcript;
  const rows = Array.isArray(transcript) ? transcript : transcript.segments;
  if (!Array.isArray(rows)) return transcript;
  const shifted = rows.flatMap(seg => {
    if (Array.isArray(seg.words) && seg.words.length) {
      const words = shiftWords(seg.words, offset);
      if (!words.length) return [];
      return [{ ...seg, start: words[0].start, end: Math.max(0, Number(seg.end) - offset), words }];
    }
    const start = Number(seg.start) - offset;
    if (!Number.isFinite(start) || start < 0) return [];
    return [{ ...seg, start, end: Number(seg.end) - offset }];
  });
  return Array.isArray(transcript) ? shifted : { ...transcript, segments: shifted };
}

/** An energy series moved by `offset` seconds: drop round(offset / bin) leading bins. */
export function shiftEnergy(energy, offset) {
  if (!(offset > 0) || !energy || !Array.isArray(energy.db)) return energy;
  const bin = Number(energy.bin ?? 0.01);
  if (!(bin > 0)) return energy;
  return { ...energy, db: energy.db.slice(Math.round(offset / bin)) };
}
