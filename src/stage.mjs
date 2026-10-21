/**
 * Stage-and-swap: do a long series of writes on a copy, swap it in at the end.
 *
 * A multi-step edit (shots, layout, graphics, captions, sound, gate) is dozens of transactions
 * and can take an hour. Every one of them refused while CapCut was open, so CapCut stayed closed
 * for the whole hour. `stage start` copies the draft OUTSIDE CapCut's drafts folder; from then on
 * `resolveProject` hands every command the copy, and writes to it need no closed CapCut because
 * CapCut cannot see or save it. `stage commit` is the one step that needs CapCut closed: a short
 * atomic swap-in through `commitProjectFiles` (lock, snapshot, renames, doctor, rollback).
 *
 * The swap refuses when the live draft changed since staging — the user saved in CapCut in
 * between — and names the files, so the user's CapCut edits are never overwritten. A freshly
 * staged copy is repaired first (repair.mjs): CapCut's last save may have stripped metadata.
 *
 * Copies use copy-on-write clones (APFS clonefile via `cp -c`, see core.cloneOrCopy), so staging
 * a draft with gigabytes of Resources is instant on a Mac and costs no disk until a file diverges.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CapcutError, LIVE_FILE_NAMES, STAGE_MARKER, STAGE_OF, activeStage, commitProjectFiles, copyTree, isStageDir,
  readJson, repairProject, sha256, stableJson,
} from './core.mjs';

const BIG_FILE = 8 * 1024 * 1024;
const COPY_ATTEMPTS = 3;

export function stageRoot() {
  return process.env.CAPCUTCTL_STAGE_DIR
    ? path.resolve(process.env.CAPCUTCTL_STAGE_DIR)
    : path.join(os.homedir(), '.capcutctl', 'stage');
}

const posix = rel => rel.split(path.sep).join('/');

/** Never copied, compared or swapped: capcutctl's own bookkeeping and in-flight temp files. */
function skipped(rel) {
  return rel === '.capcutctl/history' || rel.startsWith('.capcutctl/history/')
    || rel.startsWith('.capcutctl/write.lock')
    || rel === posix(STAGE_MARKER) || rel === posix(STAGE_OF)
    || /\.capcutctl-[^/]*\.tmp$/.test(rel) || /\.capcutctl-staged$/.test(rel);
}

export function listFiles(dir) {
  const out = [];
  const walk = sub => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (skipped(rel)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

/** Bytes for anything small; size + whole-second mtime for media, which capcutctl never edits in place. */
function fingerprint(file) {
  const stat = fs.statSync(file);
  if (stat.size > BIG_FILE) return `size:${stat.size}:mtime:${Math.floor(stat.mtimeMs / 1000)}`;
  return sha256(fs.readFileSync(file));
}

function fingerprints(dir) {
  return Object.fromEntries(listFiles(dir).map(rel => [rel, fingerprint(path.join(dir, rel))]));
}

const sameMap = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** CapCut's own documents: a change to any of these since staging means the user saved. */
function isDocument(rel) {
  const parts = rel.split('/');
  if (parts.length === 1) return LIVE_FILE_NAMES.includes(rel);
  if (rel === 'Timelines/project.json') return true;
  return parts.length === 3 && parts[0] === 'Timelines' && LIVE_FILE_NAMES.includes(parts[2]);
}

export const isText = rel => /\.(json|bak|tmp)$/.test(rel) || LIVE_FILE_NAMES.includes(path.basename(rel));

function stageDirFor(liveDir, root) {
  const name = path.basename(liveDir).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 80) || 'project';
  return path.join(root, `${name}-${crypto.createHash('sha1').update(path.resolve(liveDir)).digest('hex').slice(0, 8)}`);
}

function readMarker(liveDir) {
  const marker = activeStage(liveDir);
  if (!marker) {
    throw new CapcutError(`No active stage for ${liveDir}. Start one with \`capcutctl stage start --project NAME\`.`,
      { code: 'NO_STAGE', exitCode: 2 });
  }
  const of = readJson(path.join(marker.stage, STAGE_OF));
  if (path.resolve(of.live || '') !== path.resolve(liveDir)) {
    throw new CapcutError(`${marker.stage} is not the stage of ${liveDir}.`, { code: 'STAGE_MISMATCH', exitCode: 2 });
  }
  return marker;
}

/**
 * Clone a draft folder without capcutctl's history, locks or stage markers (nor whatever
 * `extraSkip(rel)` also refuses). Timestamps are kept: the stage compares big media by size and
 * mtime, so a copy with fresh mtimes would read as a draft CapCut kept saving.
 */
export function copyDraftTree(from, to, { extraSkip = null } = {}) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  copyTree(from, to, { preserveTimestamps: true, filter: rel => !skipped(rel) && !(extraSkip && extraSkip(rel)) });
}

/**
 * A copy of a draft that is its own draft: the tree (see copyDraftTree), then every path baked
 * into its JSON (localized media, renders, sidecars) moved from the source folder to the copy,
 * so the copy never plays — or loses — the source's media.
 */
export function cloneDraft(from, to, { extraSkip = null } = {}) {
  copyDraftTree(from, to, { extraSkip });
  const rewritten = [];
  for (const rel of listFiles(to).filter(isText)) {
    const file = path.join(to, rel);
    const text = fs.readFileSync(file, 'utf8');
    const moved = rewritePaths(text, from, to);
    if (moved !== text) { fs.writeFileSync(file, moved); rewritten.push(rel); }
  }
  return { rewritten };
}

/** Copy the live draft out of CapCut's folder and point every later command at the copy. */
export function startStage(liveDir, { root = stageRoot(), repair = true } = {}) {
  liveDir = path.resolve(liveDir);
  if (isStageDir(liveDir)) throw new CapcutError(`${liveDir} is itself a stage.`, { code: 'STAGE_NESTED', exitCode: 2 });
  const existing = activeStage(liveDir);
  if (existing) {
    throw new CapcutError(`A stage is already active for this project (${existing.stage}, started ${existing.startedAt}). `
      + '`capcutctl stage status` shows it; commit or discard it first.', { code: 'STAGE_EXISTS', exitCode: 2, details: existing });
  }
  const stage = stageDirFor(liveDir, root);
  if (path.resolve(stage).startsWith(path.dirname(liveDir) + path.sep)) {
    throw new CapcutError('The stage must live outside CapCut\'s drafts folder; set CAPCUTCTL_STAGE_DIR elsewhere.',
      { code: 'STAGE_INSIDE_DRAFTS', exitCode: 2 });
  }
  // CapCut may be open and saving. Fingerprint, copy, fingerprint again: two equal reads around
  // the copy mean the copy is one consistent save, and that save is the base the swap checks.
  let base = null;
  for (let attempt = 0; attempt < COPY_ATTEMPTS && !base; attempt++) {
    fs.rmSync(stage, { recursive: true, force: true });
    const before = fingerprints(liveDir);
    copyDraftTree(liveDir, stage);
    const after = fingerprints(liveDir);
    if (sameMap(before, after) && sameMap(before, fingerprints(stage))) base = before;
  }
  if (!base) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new CapcutError('CapCut kept saving the draft while it was being staged. Try again in a moment.',
      { code: 'STAGE_UNSTABLE', exitCode: 3 });
  }
  const startedAt = new Date().toISOString();
  fs.mkdirSync(path.join(stage, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(stage, STAGE_OF), stableJson({ version: 1, live: liveDir, startedAt }));
  fs.mkdirSync(path.join(liveDir, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(liveDir, STAGE_MARKER), stableJson({ version: 1, stage, startedAt, base }));

  let repaired = null;
  if (repair) {
    try {
      const result = repairProject(stage, { backup: false, label: 'stage-repair' });
      repaired = { ...result.repaired, details: { merged: result.merged, restored: result.restored, clamped: result.clamped, unclamped: result.unclamped } };
    } catch (error) {
      repaired = { error: { code: error.code, message: error.message } };
    }
  }
  return { started: true, live: liveDir, stage, startedAt, files: Object.keys(base).length, repaired,
    next: 'Every command on this project now edits the stage; CapCut can stay open. '
      + 'Close CapCut only for `capcutctl stage commit --project NAME`.' };
}

/** What the stage would write, and what CapCut changed in the live draft since staging. */
export function stagePlan(liveDir) {
  liveDir = path.resolve(liveDir);
  const marker = readMarker(liveDir);
  const { stage, base } = marker;
  const stageFiles = new Set(listFiles(stage));
  const liveFiles = new Set(listFiles(liveDir));
  const changed = [], added = [], removed = [];
  for (const rel of stageFiles) {
    if (!(rel in base)) added.push(rel);
    else if (fingerprint(path.join(stage, rel)) !== base[rel]) changed.push(rel);
  }
  for (const rel of Object.keys(base)) if (!stageFiles.has(rel)) removed.push(rel);
  const liveChanged = [];
  for (const rel of Object.keys(base)) {
    if (!liveFiles.has(rel) || fingerprint(path.join(liveDir, rel)) !== base[rel]) liveChanged.push(rel);
  }
  const liveAdded = [...liveFiles].filter(rel => !(rel in base));
  const touched = new Set([...changed, ...removed]);
  const conflicts = [
    ...liveChanged.filter(rel => isDocument(rel) || touched.has(rel)),
    ...added.filter(rel => liveFiles.has(rel) && fingerprint(path.join(liveDir, rel)) !== fingerprint(path.join(stage, rel))),
  ].sort();
  return { live: liveDir, stage, startedAt: marker.startedAt, changed, added, removed, liveChanged, liveAdded, conflicts };
}

export function stageStatus(liveDir) {
  liveDir = path.resolve(liveDir);
  if (!activeStage(liveDir)) return { active: false, live: liveDir };
  return { active: true, ...stagePlan(liveDir) };
}

/** Paths baked into JSON (localized media, mograph renders, sidecars) move with the draft. */
export function rewritePaths(text, from, to) {
  const variants = new Set([from]);
  try { variants.add(fs.realpathSync.native(from)); } catch { /* the stage still exists here */ }
  for (const variant of variants) {
    for (const end of ['/', '"']) text = text.split(variant + end).join(to + end);
  }
  return text;
}

function conflictError(plan) {
  return new CapcutError(
    `The live draft changed since it was staged at ${plan.startedAt} (CapCut saved: ${plan.conflicts.join(', ')}). `
    + 'Nothing was written, so those CapCut edits are kept. Discard the stage (`capcutctl stage discard`) and redo '
    + 'the capcutctl steps on the saved draft, or undo the CapCut save first.',
    { code: 'STAGE_CONFLICT', exitCode: 5, details: plan });
}

/** The swap: the one step of a staged edit that needs CapCut closed. */
export function commitStage(liveDir, { dryRun = false, forceRunning = false, processProbe = null, backup = true } = {}) {
  liveDir = path.resolve(liveDir);
  const plan = stagePlan(liveDir);
  const writes = [...plan.changed, ...plan.added].sort().map(rel => {
    const source = path.join(plan.stage, rel);
    const file = path.join(liveDir, rel);
    if (!isText(rel)) return { file, source };
    const data = rewritePaths(fs.readFileSync(source, 'utf8'), plan.stage, liveDir);
    let json = false;
    try { JSON.parse(data); json = true; } catch { /* not every .tmp is JSON */ }
    return { file, data, json };
  });
  const removes = plan.removed.map(rel => path.join(liveDir, rel));
  const summary = { live: liveDir, stage: plan.stage, startedAt: plan.startedAt,
    writes: writes.map(w => path.relative(liveDir, w.file)), removes: plan.removed, conflicts: plan.conflicts };
  if (dryRun) return { dryRun: true, committed: false, ...summary };
  if (plan.conflicts.length) throw conflictError(plan);
  let result = { committed: false, snapshot: null };
  if (writes.length || removes.length) {
    result = commitProjectFiles(liveDir, { writes, removes }, {
      forceRunning, processProbe, backup, label: 'before-stage-commit',
      // Re-read under the lock and with CapCut closed: a save in the last seconds still refuses.
      check: () => { const again = stagePlan(liveDir); if (again.conflicts.length) throw conflictError(again); },
    });
  }
  // The stage's snapshots are the undo history of the whole staged session; deleting the
  // stage with them left only the one before-stage-commit snapshot to go back to.
  let historyCarried;
  try {
    historyCarried = carryHistory(plan.stage, liveDir);
  } catch (error) {
    historyCarried = { error: error.message, stage: plan.stage };
  }
  fs.rmSync(path.join(liveDir, STAGE_MARKER), { force: true });
  if (Array.isArray(historyCarried)) fs.rmSync(plan.stage, { recursive: true, force: true });
  return { ...summary, ...result, committed: true, historyCarried };
}

/**
 * Copy every stage snapshot into the live draft's history, as a snapshot OF the live draft: the
 * paths inside point at the live folder, each checksum is recomputed over the rewritten bytes,
 * and the manifest names the live folder. A name already taken gets `-staged`. Returns the names.
 */
export function carryHistory(stage, liveDir) {
  const from = path.join(stage, '.capcutctl', 'history');
  if (!fs.existsSync(from)) return [];
  const to = path.join(liveDir, '.capcutctl', 'history');
  fs.mkdirSync(to, { recursive: true });
  const carried = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const manifestFile = path.join(from, entry.name, 'manifest.json');
    if (!entry.isDirectory() || !fs.existsSync(manifestFile)) continue;
    let name = entry.name;
    for (let n = 1; fs.existsSync(path.join(to, name)); n++) name = `${entry.name}-staged${n > 1 ? `-${n}` : ''}`;
    const target = path.join(to, name);
    const temp = `${target}.capcutctl-staged`;
    fs.rmSync(temp, { recursive: true, force: true });
    try {
      const manifest = readJson(manifestFile);
      for (const item of manifest.files || []) {
        const source = path.join(from, entry.name, item.relative);
        const file = path.join(temp, item.relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const bytes = isText(item.relative)
          ? Buffer.from(rewritePaths(fs.readFileSync(source, 'utf8'), stage, liveDir), 'utf8')
          : fs.readFileSync(source);
        fs.writeFileSync(file, bytes);
        item.sha256 = sha256(bytes);
      }
      manifest.projectDir = liveDir;
      fs.writeFileSync(path.join(temp, 'manifest.json'), stableJson(manifest));
      fs.renameSync(temp, target);
    } catch (error) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw error;
    }
    carried.push(name);
  }
  return carried;
}

export function discardStage(liveDir) {
  liveDir = path.resolve(liveDir);
  const marker = readMarker(liveDir);
  fs.rmSync(marker.stage, { recursive: true, force: true });
  fs.rmSync(path.join(liveDir, STAGE_MARKER), { force: true });
  return { discarded: true, live: liveDir, stage: marker.stage };
}
