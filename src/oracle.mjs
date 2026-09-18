/**
 * Round-trip sanitation oracle (QI1).
 *
 * JSON that parses can still be a no-op in CapCut. `doctor` validates structure and
 * `qa` looks at pixels, but neither answers the question a new field actually poses:
 * *what does CapCut do to this record when it opens and saves the project?* A field can
 * survive our write, survive `doctor`, and be silently thrown away — or kept with its
 * values put back — the first time the app touches the draft. Shipping on "the JSON is
 * there" is shipping theatre.
 *
 * This is a dev-only harness. It writes nothing into a draft: `capture` copies a whole
 * project directory somewhere else, and `diff` only reads. There is deliberately no
 * automation of the CapCut UI — a human (or a later native-bridge session) drives the
 * app and captures the directories. See `docs/oracle.md` for the manual steps.
 *
 * The taxonomy is the point. Only `preserved`, `normalized` and `materialized-cache`
 * are success; everything else means the field is not production-safe.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CapcutError } from './core.mjs';

/** The whole taxonomy, and which verdicts may be read as "the write survived". */
export const VERDICTS = Object.freeze({
  preserved: 'structure survived byte-for-byte',
  normalized: 'rewritten, behaviour survived',
  'materialized-cache': 'app added analysis files we never wrote',
  pruned: 'record discarded',
  reset: 'record kept, our values did not survive',
  'authority-miss': 'documents disagree — we wrote a mirror, not the authority',
  'resource-noop': 'structure survived, pixels did not change',
});
export const SUCCESS_VERDICTS = Object.freeze(new Set(['preserved', 'normalized', 'materialized-cache']));

/** Our own bookkeeping is not part of the draft and must never be captured or compared. */
const EXCLUDED_DIRS = new Set(['.capcutctl']);

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

/** Every file under `dir`, as project-relative POSIX paths, with our own dot-dir skipped. */
export function walkTree(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;                 // never follow a link out of the tree
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkTree(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Capture a whole project directory. Not `createSnapshot`: that copies the curated set of
 * files the CLI manages, and the interesting part of a round trip is exactly the files it
 * does NOT manage — the analysis caches and sidecars CapCut materialises on open.
 */
export function captureProject(projectDir, { out, label = 'capture' } = {}) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new CapcutError(`Not a project directory: ${projectDir}`, { code: 'ORACLE_NO_PROJECT', exitCode: 2 });
  }
  const slug = String(label).replace(/[^a-zA-Z0-9._-]/g, '_') || 'capture';
  const root = out ? path.resolve(out) : path.join(projectDir, '.capcutctl', 'oracle', slug);
  if (fs.existsSync(root) && walkTree(root).length) {
    throw new CapcutError(`Capture directory already holds files: ${root}. Use a new --label or --out.`,
      { code: 'ORACLE_CAPTURE_EXISTS', exitCode: 2 });
  }
  const files = walkTree(projectDir);
  const manifest = { version: 1, label: slug, capturedAt: new Date().toISOString(), projectDir, files: [] };
  for (const relative of files) {
    const source = path.join(projectDir, relative);
    const destination = path.join(root, 'tree', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    const data = fs.readFileSync(source);
    manifest.files.push({ relative, bytes: data.length, sha256: sha256(data) });
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'oracle.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { capture: root, label: slug, files: manifest.files.length };
}

/** A capture directory, or a bare project directory, read as a tree of relative paths. */
function treeRoot(dir) {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) throw new CapcutError(`No such directory: ${resolved}`, { code: 'ORACLE_NO_DIR', exitCode: 2 });
  const inner = path.join(resolved, 'tree');
  return fs.existsSync(path.join(resolved, 'oracle.json')) && fs.existsSync(inner) ? inner : resolved;
}

/**
 * Sort keys and round floats so that "CapCut rewrote the file" and "CapCut changed the
 * value" stop looking the same. Reserialising 0.5 as 0.500000, or emitting the same object
 * with its keys in a different order, is `normalized`; changing 0.5 to 0.08 is not.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  // 1e-9 is far below anything CapCut exposes (scales, normalised transforms, microseconds)
  // and far above float reserialisation noise.
  if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
    return Math.round(value * 1e9) / 1e9;
  }
  return value;
}

const canonicalText = value => JSON.stringify(canonicalize(value));

/**
 * Every object carrying a string `id`, keyed by that id. Keyframe points, keyframe blocks,
 * segments, materials and masks all carry one, which makes the id the natural unit: it is
 * what survives a rewrite and what disappears on a prune.
 */
export function indexRecords(value, at = '$', into = new Map()) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => indexRecords(item, `${at}[${i}]`, into));
    return into;
  }
  if (!value || typeof value !== 'object') return into;
  if (typeof value.id === 'string' && value.id) {
    // Store the record without its children's identity noise: compare the record itself.
    into.set(value.id, { path: at, value, kind: value.property_type || value.type || value.resource_type || null });
  }
  for (const [key, child] of Object.entries(value)) indexRecords(child, `${at}.${key}`, into);
  return into;
}

const readJsonOrNull = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/**
 * Classify one record across the round trip.
 *
 * `baseline` is the pre-write capture (A in the documented A/B/C flow). It only sharpens a
 * `reset`: with it we can say the value was put back to what it was before we wrote, rather
 * than merely that ours did not survive. A record whose values changed is a `reset` either
 * way — that is the failure this harness exists to catch, and it is never success.
 */
export function classifyRecord({ before, after, baseline = null, beforeText = null, afterText = null }) {
  if (before && !after) return { verdict: 'pruned' };
  if (!before && after) return { verdict: 'materialized-cache' };
  const b = canonicalText(before.value), a = canonicalText(after.value);
  if (b === a) {
    if (beforeText != null && afterText != null && beforeText !== afterText) return { verdict: 'normalized' };
    return { verdict: 'preserved' };
  }
  const restoredToBaseline = baseline ? canonicalText(baseline.value) === a : null;
  return { verdict: 'reset', ...(restoredToBaseline != null ? { restoredToBaseline } : {}) };
}

/**
 * Compare two captures. `before` is what we wrote (B); `after` is what came back out of
 * CapCut (C). Everything here is read-only.
 */
export function diffCaptures({ before, after, baseline = null, resourceNoop = [] } = {}) {
  const beforeDir = treeRoot(before), afterDir = treeRoot(after);
  const baselineDir = baseline ? treeRoot(baseline) : null;
  const beforeFiles = new Set(walkTree(beforeDir)), afterFiles = new Set(walkTree(afterDir));
  const findings = [];
  const noop = new Set(resourceNoop.map(String));

  // Which JSON documents carried a given record before the round trip. A record that
  // survives in one document and is pruned from another means the two disagree, and one of
  // them was not the authority we thought we were writing.
  const presenceBefore = new Map(), presenceAfter = new Map();
  const note = (map, id, file) => {
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(file);
  };

  for (const relative of [...new Set([...beforeFiles, ...afterFiles])].sort()) {
    const inBefore = beforeFiles.has(relative), inAfter = afterFiles.has(relative);
    if (!inBefore) { findings.push({ file: relative, verdict: 'materialized-cache', detail: 'file appeared during the round trip' }); continue; }
    if (!inAfter) { findings.push({ file: relative, verdict: 'pruned', detail: 'file removed during the round trip' }); continue; }

    const beforePath = path.join(beforeDir, relative), afterPath = path.join(afterDir, relative);
    const beforeRaw = fs.readFileSync(beforePath, 'utf8'), afterRaw = fs.readFileSync(afterPath, 'utf8');
    const beforeDoc = readJsonOrNull(beforePath), afterDoc = readJsonOrNull(afterPath);
    if (!beforeDoc || !afterDoc) {
      // Not JSON (or no longer parses): all we can honestly say is whether the bytes moved.
      if (beforeRaw !== afterRaw) findings.push({ file: relative, verdict: 'reset', detail: 'non-JSON file rewritten' });
      continue;
    }
    const beforeRecords = indexRecords(beforeDoc), afterRecords = indexRecords(afterDoc);
    const baselineRecords = baselineDir && fs.existsSync(path.join(baselineDir, relative))
      ? indexRecords(readJsonOrNull(path.join(baselineDir, relative)) || {}) : null;

    for (const id of beforeRecords.keys()) note(presenceBefore, id, relative);
    for (const id of afterRecords.keys()) note(presenceAfter, id, relative);

    for (const id of new Set([...beforeRecords.keys(), ...afterRecords.keys()])) {
      const b = beforeRecords.get(id) || null, a = afterRecords.get(id) || null;
      const result = classifyRecord({
        before: b, after: a, baseline: baselineRecords?.get(id) || null,
        beforeText: b && a ? beforeRaw : null, afterText: b && a ? afterRaw : null,
      });
      if (result.verdict === 'preserved') continue;        // the quiet, expected case
      findings.push({ file: relative, id, kind: (a || b).kind, path: (a || b).path, ...result });
    }
  }

  // Documents that disagree about a record outrank the per-file verdict: a prune in the
  // canonical while a mirror keeps the record is the signature of writing the wrong file.
  for (const [id, files] of presenceBefore) {
    const survived = presenceAfter.get(id) || new Set();
    const lost = [...files].filter(file => !survived.has(file));
    if (!lost.length || !survived.size) continue;
    for (const finding of findings) {
      if (finding.id === id && lost.includes(finding.file)) {
        finding.verdict = 'authority-miss';
        finding.detail = `kept in ${[...survived].join(', ')}; dropped from ${finding.file}`;
      }
    }
  }

  // Pixels are not visible from here. A resource-noop is a `qa` verdict a human hands in.
  for (const id of noop) {
    findings.push({ id, verdict: 'resource-noop', detail: 'asserted by the caller from qa; not visible in JSON' });
  }

  const counts = Object.fromEntries(Object.keys(VERDICTS).map(v => [v, 0]));
  for (const finding of findings) counts[finding.verdict] = (counts[finding.verdict] || 0) + 1;
  const failing = findings.filter(finding => !SUCCESS_VERDICTS.has(finding.verdict));
  return {
    before: beforeDir, after: afterDir, ...(baselineDir ? { baseline: baselineDir } : {}),
    counts,
    ok: failing.length === 0,
    verdict: failing.length === 0 ? 'round-trip safe' : 'NOT production-safe',
    findings,
  };
}
