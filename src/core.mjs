import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  opLayoutApply, opLayoutBackground, opLayoutBroll, opLayoutScreen, SCREEN_LAYOUT_OPERATION, renumberTracks
} from './layouts.mjs';
import { opPolish, opCalloutSfx, opInteractions, principalTrack } from './polish.mjs';
import { opGradeApply } from './grade.mjs';
import { opPace } from './pace.mjs';
import { opSignature } from './signature.mjs';
import {
  opClipAdd, opReplaceMedia, opScaleKeyframe,
  opClipShift, opClipTrim, opClipFade, opLocalizeAll
} from './add.mjs';
import { opMusic } from './music.mjs';
import { isPreframed } from './origin.mjs';
import { preflightPython } from './python.mjs';

export const DEFAULT_ROOT = path.join(
  process.env.HOME || '',
  'Movies/CapCut/User Data/Projects/com.lveditor.draft'
);

export const LIVE_FILE_NAMES = ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp'];

/** Empty timeline between the real edit and the cloned Preset 3 leftover. The leftover is a parts bin, not the ending. */
export const PRESET_PARK_GAP_US = 30_000_000;

/** Microseconds are CapCut's native timeline unit. Keep all semantic duration APIs in it. */
export const CAPCUT_TIME_UNIT = 'microseconds';
const DURATION_TOLERANCE_US = 1;

/**
 * These are the two material identities known to be duplicated by the Preset 3 clone.
 * `unique_id` survives CapCut's localized path/name changes; the id is retained as a
 * compatibility fallback for older drafts that do not have a unique_id field.
 *
 * This is deliberately a small identity baseline, not a rule that all duplicate material
 * ids are harmless. Any other identical duplicate remains a doctor warning and any
 * conflicting duplicate remains an error.
 */
export const PRESET3_DUPLICATE_BASELINE = Object.freeze([
  Object.freeze({
    kind: 'videos',
    id: '8CAD5C16-4D3A-4F36-9F3B-9C0597AC280C',
    unique_id: '2e5dbc668950cfc24c11ce95f38fdefb',
    type: 'photo',
    width: 1080,
    height: 1920,
    duration: 10_800_000_000,
  }),
  Object.freeze({
    kind: 'videos',
    id: 'F42A3503-4585-4EDB-AFC6-EE1D7A8DBC71',
    unique_id: '5a9f67ef216d717484d98e4fbf2574ed',
    type: 'photo',
    width: 1080,
    height: 1920,
    duration: 10_800_000_000,
  }),
]);

// Names kept explicit for consumers that want to describe the baseline in their own output.
export const KNOWN_PRESET3_DUPLICATES = PRESET3_DUPLICATE_BASELINE;
export const PRESET3_DUPLICATE_MATERIALS = PRESET3_DUPLICATE_BASELINE;

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESET_DIR = path.join(PACKAGE_ROOT, 'presets');

/**
 * Overlay artwork that ships WITH the tool, so a fresh clone can run the three headline
 * layouts without the user first recreating one person's ~/Downloads. The measured geometry in
 * `presets/layouts.json` was calibrated against these exact pixels — replace a file here and the
 * numbers stop meaning what they say, which is why they are versioned rather than regenerated.
 */
export const BUNDLED_ASSET_DIR = path.join(PACKAGE_ROOT, 'assets');

/**
 * Where to look for a named overlay asset, nearest-wins:
 *   1. $CAPCUTCTL_ASSET_DIR  — colon-separated; your own artwork overrides the bundle
 *   2. the bundled assets/   — always present, so nothing is required of a new machine
 *   3. presets.assetSearchPaths — the original ~/Downloads locations, kept last so an
 *      existing machine keeps resolving the files it already has.
 * Callers prepend the project's own materials and its Resources/ dir.
 */
export function assetSearchRoots(extra = []) {
  const fromEnv = String(process.env.CAPCUTCTL_ASSET_DIR || '')
    .split(path.delimiter).map(v => v.trim()).filter(Boolean).map(expandHome);
  const roots = [...fromEnv, BUNDLED_ASSET_DIR, ...extra.map(expandHome)];
  return [...new Set(roots.map(v => path.resolve(v)))];
}

/**
 * Presets ship with `~/…` paths, never `/Users/<someone>/…`, so the repo works on
 * any Mac. CapCut itself needs a real absolute path inside draft_info.json, so the
 * tilde is expanded here — at load — and nothing downstream has to remember to.
 */
export const expandHome = p =>
  typeof p === 'string' && (p === '~' || p.startsWith('~/'))
    ? path.join(os.homedir(), p.slice(1))
    : p;

/**
 * CapCut also stores JSON *inside* a string (a text segment's `content` carries a
 * nested `{"font":{"path":"…"}}`), so a tilde can appear mid-string, quoted.
 */
const expandNested = s => s.replaceAll('"~/', `"${os.homedir()}/`);

const expandTree = value => {
  if (typeof value === 'string') return expandNested(expandHome(value));
  if (Array.isArray(value)) return value.map(expandTree);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandTree(v);
    return out;
  }
  return value;
};

const PRESET_CACHE = new Map();

/**
 * Where `<name>.json` is read from. `$CAPCUTCTL_PRESET_DIR` wins when it holds that file.
 *
 * This is the supported way to bring your own palette. The bundled `sfx.json` and
 * `layouts.json` point into CapCut's effect/music cache, and those paths are minted on the
 * machine where the sound was downloaded — they are not portable and cannot be shipped. Rather
 * than telling a new user to download the same twenty-five effects, let them drop their own
 * `sfx.json` in a directory and name it here. Falls back to the bundled preset per file, so an
 * override directory only has to contain the presets it actually changes.
 */
export function presetFile(name) {
  const override = expandHome(String(process.env.CAPCUTCTL_PRESET_DIR || '').trim());
  if (override) {
    const candidate = path.join(path.resolve(override), `${name}.json`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(PRESET_DIR, `${name}.json`);
}

/** Read `presets/<name>.json` with every `~/…` string expanded for this machine. */
export function loadPreset(name) {
  const file = presetFile(name);
  const key = `${name}\u0000${file}`;
  if (!PRESET_CACHE.has(key)) PRESET_CACHE.set(key, expandTree(readJson(file)));
  return PRESET_CACHE.get(key);
}

/**
 * ffmpeg / ffprobe are a real dependency, not an optional extra: `cut`, `qa`, `find`,
 * `preview`, `music` and `review` all shell out. Node reports a missing binary as
 * `spawnSync ffmpeg ENOENT`, which tells a new user nothing. Ask first, and say what to do.
 */
const BINARY_CACHE = new Map();
export function hasBinary(name, { refresh = false } = {}) {
  if (refresh || !BINARY_CACHE.has(name)) {
    const suffixes = process.platform === 'win32'
      ? ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];
    const direct = String(name).includes('/') || String(name).includes('\\');
    const candidates = direct
      ? [String(name)]
      : String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
        .flatMap(directory => suffixes.map(suffix => path.join(directory, `${name}${suffix}`)));
    BINARY_CACHE.set(name, candidates.some(file => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch { return false; }
    }));
  }
  return BINARY_CACHE.get(name);
}

const INSTALL_HINT = {
  darwin: 'brew install ffmpeg',
  linux: 'sudo apt-get install ffmpeg   (or your distro\'s package manager)',
};

export function requireBinary(name, what) {
  if (hasBinary(name)) return true;
  const hint = INSTALL_HINT[process.platform] || `install ${name} and put it on PATH`;
  throw new CapcutError(
    `${name} is not on PATH, and ${what} needs it.\n  ${hint}`,
    { code: 'MISSING_DEPENDENCY', exitCode: 2 });
}

const PREFLIGHT_COMMAND_TIMEOUT_MS = 5_000;
const PREFLIGHT_MIN_FREE_BYTES = 1 * 1024 ** 3;
const DEFAULT_WHISPER_MODEL = 'mlx-community/whisper-large-v3-turbo';

/**
 * Run a small, bounded command for preflight.  A binary being discoverable on PATH does
 * not mean it can start (a broken interpreter, a bad dylib, and a stuck wrapper all look fine
 * in PATH), so preflight always executes the tools it says are ready.  Keep this helper free of
 * a shell: PATH entries and error text are environment data, never command syntax.
 */
function runPreflightCommand(command, args, {
  timeoutMs = PREFLIGHT_COMMAND_TIMEOUT_MS,
  runner = spawnSync,
} = {}) {
  let result;
  try {
    result = runner(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    return {
      ok: false,
      detail: `could not start (${error.code || error.message})`,
      error,
    };
  }

  const rawStdout = String(result?.stdout || '');
  const stderr = String(result?.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 240);
  const stdout = rawStdout.trim().replace(/\s+/g, ' ').slice(0, 240);
  if (result?.status === 0 && !result?.error) {
    return { ok: true, detail: 'probe passed', stdout: rawStdout };
  }

  if (result?.error?.code === 'ETIMEDOUT' || result?.signal) {
    return {
      ok: false,
      detail: `timed out after ${timeoutMs}ms${result.signal ? ` (${result.signal})` : ''}`,
      error: result.error,
    };
  }

  const reason = result?.error?.message || `exited with status ${result?.status ?? 'unknown'}`;
  const output = stderr || stdout;
  return {
    ok: false,
    detail: `${reason}${output ? `: ${output}` : ''}`,
    error: result?.error,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(decimals)} ${units[unit]}`;
}

function existingDirectory(file) {
  let candidate = path.resolve(file);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
  } catch {
    return null;
  }
}

function preflightDisk(directory, {
  statfs = fs.statfsSync,
  minimumBytes = PREFLIGHT_MIN_FREE_BYTES,
} = {}) {
  const target = existingDirectory(directory);
  if (!target) return { ok: false, detail: `could not find a filesystem for ${directory}` };
  try {
    const stats = statfs(target);
    const blockSize = Number(stats?.bsize);
    const availableBlocks = Number(stats?.bavail != null ? stats.bavail : stats?.bfree);
    const available = blockSize > 0 && Number.isFinite(availableBlocks)
      ? blockSize * availableBlocks : NaN;
    if (!Number.isFinite(available) || available < 0) {
      return { ok: false, detail: `filesystem statistics for ${target} are incomplete` };
    }
    const required = Number(minimumBytes);
    const threshold = Number.isFinite(required) && required >= 0 ? required : PREFLIGHT_MIN_FREE_BYTES;
    return {
      ok: available >= threshold,
      detail: `${formatBytes(available)} available at ${target} (minimum ${formatBytes(threshold)})`,
      available,
      target,
      threshold,
    };
  } catch (error) {
    return { ok: false, detail: `could not read filesystem statistics for ${target}: ${error.message}` };
  }
}

function preflightWrite(directory, { writer = null } = {}) {
  if (!fs.existsSync(directory)) return { ok: false, detail: `${directory} does not exist` };
  try {
    if (!fs.statSync(directory).isDirectory()) return { ok: false, detail: `${directory} is not a directory` };
  } catch (error) {
    return { ok: false, detail: `could not inspect ${directory}: ${error.message}` };
  }

  // A mode-bit/access check is not enough on ACLs, read-only mounts, or network filesystems.
  // Create one uniquely named probe file and remove it immediately; never overwrite a user file.
  if (typeof writer === 'function') {
    try {
      const result = writer(directory);
      return result && typeof result === 'object' ? result : { ok: Boolean(result), detail: 'write probe passed' };
    } catch (error) {
      return { ok: false, detail: `write probe failed: ${error.message}` };
    }
  }
  const probe = path.join(directory, `.capcutctl-preflight-${process.pid}-${crypto.randomUUID()}`);
  let fd = null;
  try {
    fd = fs.openSync(probe, 'wx', 0o600);
    fs.writeSync(fd, 'capcutctl preflight\n');
    return { ok: true, detail: 'temporary write probe passed' };
  } catch (error) {
    return { ok: false, detail: `write probe failed: ${error.code || error.message}` };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* report the write result; cleanup is best effort */ }
    }
    try { fs.rmSync(probe, { force: true }); } catch { /* do not hide the permission result */ }
  }
}

function preflightAssetPath(layouts, basename) {
  const roots = assetSearchRoots(layouts.assetSearchPaths || []);
  return roots.map(root => path.join(root, basename)).find(file => fs.existsSync(file)) || null;
}

function preflightWhisper({ binaryCheck, commandRunner, interpreter = null }) {
  const mlxOnPath = binaryCheck('mlx_whisper');
  const mlx = mlxOnPath
    ? commandRunner('mlx_whisper', ['--help'])
    : { ok: false, detail: 'mlx_whisper is not on PATH' };
  // Ask the interpreter `cut` will actually spawn. Importing whisper under a different
  // python3 is how "transcription is ready" and "No module named 'whisper'" coexist.
  const whisper = interpreter
    ? commandRunner(interpreter, ['-c', 'import whisper'])
    : { ok: false, detail: 'no supported Python interpreter was resolved' };
  const mlxReady = Boolean(mlx.ok);
  const whisperReady = Boolean(whisper.ok);
  let detail;
  if (!interpreter) {
    detail = 'no supported Python interpreter was resolved';
  } else if (mlxReady) {
    detail = `mlx_whisper is runnable (default ${DEFAULT_WHISPER_MODEL} model path)`;
    if (whisperReady) detail += '; openai-whisper fallback is also importable';
  } else if (whisperReady) {
    detail = 'openai-whisper is importable; use a supported local/official --model because the default MLX model is unavailable';
  } else {
    detail = `mlx_whisper: ${mlx.detail}; openai-whisper: ${whisper.detail}`;
  }
  return {
    // tools/aroll.py's default is the Hugging Face `mlx-community/...` id.  The Python
    // fallback accepts official plain model names (for example `base`), but cannot load that
    // MLX repository id, so an importable fallback alone must not make the default cut look ready.
    ok: Boolean(interpreter) && mlxReady,
    detail,
    fix: !interpreter ? 'install Python 3.11 or newer, or set CAPCUTCTL_PYTHON to one'
      : mlxReady ? null
      : whisperReady
        ? 'install mlx-whisper (`uv tool install mlx-whisper`) for the default model, or pass an official plain --model such as `base`'
        : 'install mlx-whisper (`uv tool install mlx-whisper`) or openai-whisper, then retry',
    mlxReady,
    whisperReady,
  };
}

function preflightOcr({ binaryCheck, commandRunner, helperPath, sourcePath, samplePath }) {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      detail: `Apple Vision OCR is macOS-only (running on ${process.platform})`,
      fix: 'run on macOS and build the helper with `swiftc -O -o tools/vision/ocr tools/vision/ocr.swift`',
    };
  }
  if (!fs.existsSync(sourcePath)) {
    return {
      ok: false,
      detail: `source not found: ${sourcePath}`,
      fix: 'restore tools/vision/ocr.swift from the package',
    };
  }
  const swift = binaryCheck('swiftc')
    ? commandRunner('swiftc', ['-version'])
    : { ok: false, detail: 'swiftc is not on PATH' };
  if (!swift.ok) {
    return {
      ok: false,
      detail: `Swift toolchain unavailable: ${swift.detail}`,
      fix: 'install Xcode Command Line Tools (`xcode-select --install`)',
    };
  }
  if (!fs.existsSync(helperPath)) {
    return {
      ok: false,
      detail: 'Vision OCR helper is not built',
      fix: 'swiftc -O -o tools/vision/ocr tools/vision/ocr.swift',
    };
  }
  try {
    if (!fs.statSync(helperPath).isFile()) throw new Error('helper path is not a file');
    fs.accessSync(helperPath, fs.constants.X_OK);
  } catch (error) {
    return {
      ok: false,
      detail: `Vision OCR helper is not executable: ${error.message}`,
      fix: 'swiftc -O -o tools/vision/ocr tools/vision/ocr.swift',
    };
  }
  if (!samplePath || !fs.existsSync(samplePath)) {
    return {
      ok: false,
      detail: 'no readable image is available for a Vision OCR probe',
      fix: 'restore the bundled assets, then retry',
    };
  }
  const probe = commandRunner(helperPath, [samplePath, '--languages', 'en-US,ar']);
  let output;
  try { output = JSON.parse(String(probe.stdout || '')); } catch { output = null; }
  if (!probe.ok || !Array.isArray(output)) {
    return {
      ok: false,
      detail: `Vision OCR helper probe failed: ${probe.ok ? 'invalid JSON output' : probe.detail}`,
      fix: 'rebuild the helper with `swiftc -O -o tools/vision/ocr tools/vision/ocr.swift`',
    };
  }
  return { ok: true, detail: 'swiftc and the Vision OCR helper probe passed' };
}

/**
 * A path inside CapCut's own effect/music cache. These are CapCut's resources, not the user's
 * media: the id is minted per machine when the app downloads the asset, and CapCut re-fetches
 * one that is missing. Treating an absent cache file as a hard error meant a mask — which every
 * split-screen and circle layout needs — could not be applied on any machine but the one the
 * preset was harvested from. It is reported, not fatal.
 */
export const isCapCutCachePath = p =>
  typeof p === 'string' && /\/CapCut\/User Data\/Cache\//.test(p);

export class CapcutError extends Error {
  constructor(message, { code = 'CAPCUTCTL_ERROR', exitCode = 1, details } = {}) {
    super(message);
    this.name = 'CapcutError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const clone = value => JSON.parse(JSON.stringify(value));
export const uuid = () => crypto.randomUUID().toUpperCase();
/** A UUID derived from an op's seed, so both mirror documents mint the same one. */
export const seededId = (seed, key) => {
  if (!seed) return uuid();
  const h = crypto.createHash('sha256').update(`${seed}|${key}`).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CapcutError(`Invalid JSON: ${file}\n${error.message}`, {
      code: 'INVALID_JSON',
      details: { file }
    });
  }
}

/** Read the capcutctl sidecar without making a missing or old sidecar fatal to a read. */
export function createdMetadata(projectDir) {
  if (!projectDir) return null;
  try {
    const value = readJson(path.join(projectDir, '.capcutctl', 'created.json'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The parts-bin window recorded by `new`/the add operations. This is the one shared source
 * of truth for all duration-aware readers; callers receive a fresh object they may mutate.
 */
export function preservedRange(projectDir) {
  const value = createdMetadata(projectDir)?.preserved;
  const start = Number(value?.start);
  const end = Number(value?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
  return { start, end };
}

export const getPreservedRange = preservedRange;
export const parkedRange = preservedRange;

function parseProcessLines(stdout) {
  return String(stdout || '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match ? [{ pid: match[1], command: match[2].trim() }] : [];
  });
}

function capcutProcessEntries(pids, spawn = spawnSync) {
  const numeric = (pids || []).filter(pid => /^\d+$/.test(String(pid)));
  if (!numeric.length) return [];
  const result = spawn('ps', ['-p', numeric.join(','), '-o', 'pid=,command='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  return parseProcessLines(result.stdout);
}

function processRecord(entry) {
  if (!entry) return null;
  const pid = entry.pid ?? entry.id;
  const command = entry.command ?? entry.cmd ?? entry.args;
  if (pid == null && command == null) return null;
  return { pid: pid == null ? null : String(pid), command: String(command || '') };
}

function processRecords(entries) {
  return (Array.isArray(entries) ? entries : [entries]).map(processRecord).filter(Boolean);
}

function normalizeProcessPath(value) {
  let candidate = String(value || '').trim();
  if (!candidate) return null;
  if ((candidate.startsWith('"') && candidate.endsWith('"'))
      || (candidate.startsWith("'") && candidate.endsWith("'"))) {
    candidate = candidate.slice(1, -1);
  }
  candidate = candidate
    .replaceAll('\\ ', ' ')
    .replaceAll('\\"', '"')
    .replaceAll("\\'", "'")
    .replaceAll('\\\\', '\\');
  return expandHome(candidate);
}

function processPathCandidates(command) {
  const candidates = [];
  const add = value => {
    const normalized = normalizeProcessPath(value);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  const explicit = /(?:--(?:draft|project)(?:[-_]path)?|--path)\s*(?:=|\s)\s*("(?:\\.|[^"\\])*"|'[^']*'|[^\s]+)/gi;
  for (const match of String(command || '').matchAll(explicit)) add(match[1]);
  // Some CapCut versions put the draft path in a quoted launch argument without a flag.
  const quoted = /(["'])(~?\/.*?)(?:\1)/g;
  for (const match of String(command || '').matchAll(quoted)) add(match[2]);
  return candidates;
}

function projectFromProcessPath(candidate, root) {
  if (!candidate) return null;
  let projectDir = candidate;
  if (path.basename(projectDir) === 'draft_info.json') projectDir = path.dirname(projectDir);
  if (path.basename(projectDir) === '.capcutctl') projectDir = path.dirname(projectDir);
  if (!path.isAbsolute(projectDir) && root) projectDir = path.join(root, projectDir);
  projectDir = path.resolve(projectDir);
  return fs.existsSync(path.join(projectDir, 'draft_info.json')) ? projectDir : null;
}

/**
 * Return process/path evidence for a draft CapCut appears to have open, or null when the
 * platform does not expose a draft path. Discovery is intentionally best-effort: a running
 * CapCut process is still a valid status result even when its command line is opaque.
 */
export function discoverOpenDraftInfo({ root = DEFAULT_ROOT, processes = undefined, processState = null } = {}) {
  const suppliedState = processState != null;
  const state = processState || capcutProcess();
  if (!state.running && processes === undefined) return null;
  const records = processes !== undefined
    ? processRecords(processes)
    : state.processes?.length
      ? processRecords(state.processes)
      : suppliedState
        ? []
        : processRecords(capcutProcessEntries(state.pids));
  for (const record of records) {
    for (const candidate of processPathCandidates(record.command)) {
      const projectDir = projectFromProcessPath(candidate, root);
      if (projectDir) return { path: projectDir, pid: record.pid, source: 'process-command' };
    }
    // A few launchers pass only the project name. Limit this fallback to actual projects in
    // the requested root so a random command-line word cannot become an open draft.
    if (root && fs.existsSync(root)) {
      for (const project of listProjects(root)) {
        if (record.command.includes(project.path) || record.command.includes(project.name)) {
          return { path: project.path, pid: record.pid, source: 'project-name' };
        }
      }
    }
  }
  return null;
}

/** Return only the discovered draft path for callers that do not need process evidence. */
export function discoverOpenDraft(options = {}) {
  return discoverOpenDraftInfo(options)?.path || null;
}

/** Machine-readable CapCut/process state used by status and by other agents. */
export function capcutStatus({ root = DEFAULT_ROOT, processState = null, processes = undefined } = {}) {
  const state = processState || capcutProcess();
  const openDraftInfo = discoverOpenDraftInfo({
    root,
    processState: state,
    processes: processes !== undefined ? processes : state.processes,
  });
  const unknown = state.running == null || state.verified === false;
  return {
    state: unknown ? 'unknown' : state.running ? 'running' : 'closed',
    running: state.running === true,
    closed: !unknown && state.running === false,
    unknown,
    ...(state.probeError ? { probeError: state.probeError } : {}),
    pids: Array.isArray(state.pids) ? state.pids : [],
    processes: processRecords(state.processes),
    openDraft: openDraftInfo?.path || null,
    openDraftInfo,
  };
}

export const getCapcutStatus = capcutStatus;

export function capcutProcess({ spawn = spawnSync } = {}) {
  if (process.env.CAPCUTCTL_ASSUME_RUNNING === '1') {
    return { running: true, verified: true, pids: ['test'], processes: [{ pid: 'test', command: 'CapCut' }] };
  }
  let result;
  try {
    result = spawn('pgrep', ['-x', 'CapCut'], { encoding: 'utf8' });
  } catch (error) {
    return { running: null, verified: false, pids: [], processes: [], probeError: { message: error.message, code: error.code } };
  }
  // pgrep's status 1 is the only trustworthy "no process" result. An unavailable
  // binary, permission error, signal, or any other status must not become "closed".
  if (result?.error || ![0, 1].includes(result?.status)) {
    return {
      running: null,
      verified: false,
      pids: [],
      processes: [],
      probeError: {
        message: result?.error?.message || `pgrep exited with status ${result?.status}`,
        code: result?.error?.code,
        status: result?.status,
      },
    };
  }
  const pids = result.status === 0 ? String(result.stdout || '').trim().split(/\s+/).filter(Boolean) : [];
  return {
    running: pids.length > 0,
    verified: true,
    pids,
    processes: capcutProcessEntries(pids, spawn),
  };
}

const defaultSleep = milliseconds => {
  if (!(milliseconds > 0)) return;
  spawnSync('sleep', [String(milliseconds / 1000)], { stdio: 'ignore' });
};

function normalizedProcessState(state) {
  const unknown = state?.running == null || state?.unknown === true || state?.verified === false;
  return {
    running: unknown ? null : state.running === true,
    unknown,
    pids: Array.isArray(state?.pids) ? state.pids.map(String) : [],
    ...(state?.probeError ? { probeError: state.probeError } : {}),
  };
}

const closeReason = Object.freeze({
  alreadyClosed: 'already_closed',
  closed: 'closed',
  timeout: 'timeout',
  refused: 'quit_refused',
  cancelled: 'quit_cancelled',
  commandFailed: 'quit_command_failed',
});

/** Stable reason strings for callers that need to branch without parsing messages. */
export const CAPCUT_CLOSE_FAILURE_REASONS = closeReason;

/**
 * Poll CapCut until it is gone. The probe and clock/sleep hooks make this deterministic in
 * tests and let a host adapter use its own process backend without changing the contract.
 */
export function waitForCapcutClosed({
  timeoutMs = 25_000,
  intervalMs = 400,
  probe = capcutProcess,
  processProbe = null,
  sleep = defaultSleep,
  now = Date.now,
  throwOnTimeout = false,
} = {}) {
  const check = processProbe || probe;
  const startedAt = now();
  const initial = normalizedProcessState(check());
  if (initial.running === null) {
    const result = {
      wasRunning: null,
      closed: false,
      unknown: true,
      reason: 'probe_unknown',
      pids: initial.pids,
      elapsedMs: 0,
      probeError: initial.probeError,
    };
    if (!throwOnTimeout) return result;
    throw new CapcutError('CapCut process state could not be verified.', {
      code: 'CAPCUT_PROCESS_UNKNOWN',
      exitCode: 3,
      details: result,
    });
  }
  if (!initial.running) {
    return { wasRunning: false, closed: true, reason: closeReason.alreadyClosed, pids: [], elapsedMs: 0 };
  }

  const timeout = Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(0, Number(intervalMs) || 0);
  const deadline = startedAt + timeout;
  let latest = initial;
  while (true) {
    latest = normalizedProcessState(check());
    if (latest.running === null) {
      const result = {
        wasRunning: true,
        closed: false,
        unknown: true,
        reason: 'probe_unknown',
        pids: latest.pids,
        previousPids: initial.pids,
        elapsedMs: Math.max(0, now() - startedAt),
        probeError: latest.probeError,
      };
      if (!throwOnTimeout) return result;
      throw new CapcutError('CapCut process state could not be verified while waiting for close.', {
        code: 'CAPCUT_PROCESS_UNKNOWN',
        exitCode: 3,
        details: result,
      });
    }
    if (!latest.running) {
      return {
        wasRunning: true,
        closed: true,
        reason: closeReason.closed,
        pids: [],
        previousPids: initial.pids,
        elapsedMs: Math.max(0, now() - startedAt),
      };
    }
    const current = now();
    if (current >= deadline) break;
    const waitMs = Math.min(interval, deadline - current);
    if (!(waitMs > 0)) break;
    sleep(waitMs);
  }
  const result = {
    wasRunning: true,
    closed: false,
    timedOut: true,
    reason: closeReason.timeout,
    pids: latest.pids,
    previousPids: initial.pids,
    elapsedMs: Math.max(0, now() - startedAt),
    errorCode: 'CLOSE_TIMEOUT',
  };
  if (!throwOnTimeout) return result;
  const error = new CapcutError(
    `CapCut did not close within ${timeout / 1000}s (pids ${latest.pids.join(', ')}).`,
    {
      code: 'CLOSE_TIMEOUT',
      exitCode: 2,
      details: result,
    }
  );
  error.reason = closeReason.timeout;
  throw error;
}

export const waitForClose = waitForCapcutClosed;

function closeFailureCause(error) {
  return {
    name: error?.name,
    message: error?.message || String(error),
    ...(error?.code != null ? { code: error.code } : {}),
    ...(error?.status != null ? { status: error.status } : {}),
  };
}

/**
 * Request a CapCut quit and wait for the process to disappear. A host may inject
 * `requestQuit`/`processProbe`; the default uses macOS AppleScript and the shared poller.
 */
export function closeCapcut({
  timeoutMs = 25_000,
  intervalMs = 400,
  probe = capcutProcess,
  processProbe = null,
  requestQuit = null,
  quit = null,
  executeQuit = null,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const check = processProbe || probe;
  const before = normalizedProcessState(check());
  if (before.running === null) {
    throw new CapcutError('CapCut process state could not be verified; refusing to request quit.', {
      code: 'CAPCUT_PROCESS_UNKNOWN',
      exitCode: 3,
      details: before,
    });
  }
  if (!before.running) {
    return { wasRunning: false, closed: true, reason: closeReason.alreadyClosed, pids: [], elapsedMs: 0 };
  }

  const quitFn = requestQuit || quit;
  try {
    if (quitFn) {
      if (quitFn(before) === false) {
        const refused = new Error('CapCut refused the quit request.');
        refused.reason = closeReason.refused;
        throw refused;
      }
    } else if (executeQuit) {
      executeQuit(before);
    } else {
      execFileSync('osascript', ['-e', 'tell application "CapCut" to quit'], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });
    }
  } catch (error) {
    const after = normalizedProcessState(check());
    if (after.running === null) {
      throw new CapcutError('CapCut process state could not be verified after the quit request.', {
        code: 'CAPCUT_PROCESS_UNKNOWN',
        exitCode: 3,
        details: { before, after, cause: closeFailureCause(error) },
      });
    }
    if (!after.running) {
      return { wasRunning: true, closed: true, reason: closeReason.closed, pids: [], previousPids: before.pids };
    }
    const cancelled = error?.reason === closeReason.cancelled
      || error?.code === 'CLOSE_CANCELLED'
      || error?.status === -128
      || /cancel/i.test(error?.message || '');
    const commandFailed = error?.reason === closeReason.commandFailed
      || error?.code === 'ENOENT'
      || error?.code === 'EACCES';
    const reason = cancelled ? closeReason.cancelled : commandFailed ? closeReason.commandFailed : closeReason.refused;
    const code = cancelled ? 'CLOSE_CANCELLED' : commandFailed ? 'CLOSE_COMMAND_FAILED' : 'CLOSE_REFUSED';
    const failure = new CapcutError(
      `CapCut is still running (${after.pids.join(', ')}); quit failed (${reason}).`,
      { code, exitCode: 2, details: { reason, pids: after.pids, previousPids: before.pids, cause: closeFailureCause(error) } }
    );
    failure.reason = reason;
    throw failure;
  }

  const waited = waitForCapcutClosed({ timeoutMs, intervalMs, processProbe: check, sleep, now });
  if (waited.closed) return waited;
  const failure = new CapcutError(
    `CapCut did not close within ${Number(timeoutMs) / 1000}s (pids ${waited.pids.join(', ')}).`,
    { code: 'CLOSE_TIMEOUT', exitCode: 2, details: waited }
  );
  failure.reason = closeReason.timeout;
  throw failure;
}

export function assertCapcutClosed({ forceRunning = false, probe = capcutProcess } = {}) {
  const state = probe();
  if ((state.running !== false || state.verified === false) && !forceRunning) {
    const unknown = state.running == null || state.verified === false;
    throw new CapcutError(
      unknown
        ? 'CapCut process state could not be verified; refusing to write. Retry the probe or pass --force-running if you accept the risk.'
        : `CapCut is running (PID ${state.pids.join(', ')}). Close it before writing, or pass --force-running if you accept auto-save races.`,
      { code: unknown ? 'CAPCUT_PROCESS_UNKNOWN' : 'CAPCUT_RUNNING', exitCode: 3, details: state }
    );
  }
  return state;
}

/** End of the actual editable content (normally the gapless talking-head track). */
export function contentEndUs(doc, projectDir = null) {
  const parked = preservedRange(projectDir);
  let end = 0;
  try {
    const { track } = principalTrack(doc);
    for (const segment of track.segments || []) {
      const target = segment.target_timerange;
      if (!target || !Number.isFinite(target.start) || !Number.isFinite(target.duration)) continue;
      if (parked && target.start >= parked.start - DURATION_TOLERANCE_US) continue;
      end = Math.max(end, target.start + target.duration);
    }
  } catch {
    // A malformed/partial draft may not have a principal track. Its declared duration is
    // still a useful read result, and validation will report the structural problem.
  }
  if (end > 0) return parked ? Math.min(end, parked.start) : end;
  if (parked) return parked.start;
  return Number.isFinite(doc?.duration) ? doc.duration : 0;
}

/** Last target end on any track, excluding the top-level declared duration. */
export function maxSegmentEndUs(doc) {
  let end = 0;
  for (const { segment } of allSegments(doc || {})) {
    const target = segment.target_timerange;
    if (!target || !Number.isFinite(target.start) || !Number.isFinite(target.duration)) continue;
    end = Math.max(end, target.start + target.duration);
  }
  return end;
}

/**
 * Full draft/parts-bin end. The declared duration is the floor; a parked range and actual
 * segment ends are included because CapCut can retain/rearrange material beyond the edit end.
 */
export function draftEndUs(doc, projectDir = null, { includeSegments = true } = {}) {
  const declared = Number.isFinite(doc?.duration) ? doc.duration : 0;
  const parked = preservedRange(projectDir);
  const segments = includeSegments ? maxSegmentEndUs(doc) : 0;
  return Math.max(declared, parked?.end || 0, segments);
}

export const draftDurationUs = draftEndUs;

/** Shared edit-vs-draft duration contract for readers, validators, and CLI adapters. */
export function durationInfo(doc, projectDir = null) {
  const editEnd = contentEndUs(doc, projectDir);
  const draftEnd = draftEndUs(doc, projectDir);
  const declared = Number.isFinite(doc?.duration) ? doc.duration : null;
  return {
    unit: CAPCUT_TIME_UNIT,
    // `content` names the timeline concept; `edit` names the same value for callers that
    // think in terms of an editing workflow. Keep both so adapters need no guesswork.
    contentEndUs: editEnd,
    contentDurationUs: editEnd,
    editEndUs: editEnd,
    editDurationUs: editEnd,
    draftEndUs: draftEnd,
    draftDurationUs: draftEnd,
    declaredDraftDurationUs: declared,
    parkedRange: preservedRange(projectDir),
  };
}

export const projectDurations = durationInfo;
export const durationSemantics = durationInfo;

export function listProjects(root = DEFAULT_ROOT) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const projectDir = path.join(root, dirent.name);
    const infoPath = path.join(projectDir, 'draft_info.json');
    if (!fs.existsSync(infoPath)) continue;
    let info = null;
    let error = null;
    try { info = readJson(infoPath); } catch (caught) { error = caught.message; }
    const durations = info ? durationInfo(info, projectDir) : null;
    entries.push({
      name: dirent.name,
      path: projectDir,
      duration: info?.duration ?? null,
      contentDuration: durations?.contentDurationUs ?? null,
      editDuration: durations?.editDurationUs ?? null,
      draftDuration: durations?.draftDurationUs ?? null,
      durations,
      fps: info?.fps ?? null,
      tracks: info?.tracks?.length ?? null,
      error
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveProject(input, root = DEFAULT_ROOT) {
  if (!input) throw new CapcutError('Missing --project <name-or-path>.', { code: 'MISSING_PROJECT', exitCode: 2 });
  const direct = path.resolve(input);
  const projectDir = fs.existsSync(path.join(direct, 'draft_info.json')) ? direct : path.join(root, input);
  if (!fs.existsSync(path.join(projectDir, 'draft_info.json'))) {
    throw new CapcutError(`CapCut project not found: ${input}`, { code: 'PROJECT_NOT_FOUND', exitCode: 2 });
  }
  return projectDir;
}

export function activeTimelineId(projectDir) {
  const projectJson = path.join(projectDir, 'Timelines/project.json');
  if (!fs.existsSync(projectJson)) return null;
  return readJson(projectJson).main_timeline_id || null;
}

export function documentGroups(projectDir) {
  const groups = [{
    name: 'root',
    dir: projectDir,
    canonical: path.join(projectDir, 'draft_info.json'),
    mirrors: LIVE_FILE_NAMES.map(name => path.join(projectDir, name))
  }];
  const timelineId = activeTimelineId(projectDir);
  if (timelineId) {
    const timelineDir = path.join(projectDir, 'Timelines', timelineId);
    const canonical = path.join(timelineDir, 'draft_info.json');
    if (fs.existsSync(canonical)) {
      groups.push({
        name: `timeline:${timelineId}`,
        dir: timelineDir,
        canonical,
        mirrors: LIVE_FILE_NAMES.map(name => path.join(timelineDir, name))
      });
    }
  }
  return groups;
}

export function loadProject(projectDir) {
  const groups = documentGroups(projectDir).map(group => {
    const doc = readJson(group.canonical);
    return { ...group, doc, durations: durationInfo(doc, projectDir) };
  });
  return { projectDir, groups, activeTimelineId: activeTimelineId(projectDir) };
}

export function materialIndex(doc) {
  const index = new Map();
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (value?.id) index.set(value.id, { kind, value });
  }
  return index;
}

/** CapCut stores in-draft media as `##_draftpath_placeholder_<uuid>_##/Resources/...`. */
export function resolveMediaPath(raw, projectDir) {
  const p = typeof raw === 'string' ? raw : '';
  if (!p) return null;
  const marker = '##/';
  const at = p.indexOf(marker);
  if (p.startsWith('##_draftpath_placeholder') && at >= 0) {
    return path.join(projectDir, p.slice(at + marker.length));
  }
  return p.startsWith('/') ? p : path.join(projectDir, p);
}

export function allSegments(doc) {
  return (doc.tracks || []).flatMap((track, trackIndex) =>
    (track.segments || []).map((segment, segmentIndex) => ({ track, trackIndex, segment, segmentIndex }))
  );
}

function issue(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function normalizedAssetName(value) {
  return path.basename(String(value?.path || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function materialMatchesBaseline(kind, value, baseline) {
  if (!baseline || (baseline.kind && baseline.kind !== kind)) return false;
  const ids = [baseline.id, ...(Array.isArray(baseline.ids) ? baseline.ids : [])]
    .filter(Boolean).map(String).map(id => id.toUpperCase());
  const idMatches = ids.includes(String(value?.id || '').toUpperCase());
  const uniqueIdMatches = baseline.unique_id != null
    && String(value?.unique_id || '').toLowerCase() === String(baseline.unique_id).toLowerCase();
  const assetMatches = baseline.assetName != null
    && normalizedAssetName(value) === String(baseline.assetName).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!idMatches && !uniqueIdMatches && !assetMatches) return false;
  for (const key of ['type', 'width', 'height', 'duration']) {
    if (baseline[key] != null && value?.[key] !== baseline[key]) return false;
  }
  return true;
}

/** Whether this material is one of the explicitly known Preset 3 duplicate identities. */
export function isKnownPreset3Duplicate(kind, value, baseline = PRESET3_DUPLICATE_BASELINE) {
  return (Array.isArray(baseline) ? baseline : []).some(item => materialMatchesBaseline(kind, value, item));
}

export function knownPreset3DuplicateBaseline(projectDir) {
  const name = path.basename(path.resolve(projectDir || ''));
  const template = createdMetadata(projectDir)?.template;
  const fromPreset3 = name.toLowerCase() === 'preset 3'
    || String(template || '').trim().toLowerCase() === 'preset 3';
  return fromPreset3 ? PRESET3_DUPLICATE_BASELINE : [];
}

function baselineDuplicateMatches(doc, baseline) {
  const matches = [];
  const seen = new Map();
  for (const [kind, values] of Object.entries(doc?.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!value?.id) continue;
      const previous = seen.get(value.id);
      if (previous && previous.kind === kind
          && JSON.stringify(previous.value) === JSON.stringify(value)
          && isKnownPreset3Duplicate(kind, value, baseline)) {
        matches.push({ kind, id: value.id });
      } else if (!previous) {
        seen.set(value.id, { kind, value });
      }
    }
  }
  return matches;
}

export function validateDocument(doc, {
  file = '<memory>',
  checkFiles = true,
  projectDir = null,
  parked = null,
  duplicateBaseline = [],
} = {}) {
  const issues = [];
  if (!doc || typeof doc !== 'object') return [issue('error', 'DOC_TYPE', 'Draft must be an object.', { file })];
  if (!Array.isArray(doc.tracks)) issues.push(issue('error', 'TRACKS_TYPE', 'tracks must be an array.', { file }));
  if (!doc.materials || typeof doc.materials !== 'object') issues.push(issue('error', 'MATERIALS_TYPE', 'materials must be an object.', { file }));
  const materials = materialIndex(doc);
  const parkedWindow = parked || preservedRange(projectDir);
  // one line per distinct path; 48 materials for one file is CapCut's shape, not 48 faults
  const reportedOutsideMedia = new Set();
  const declaredDraftEndUs = Number.isFinite(doc.duration) ? doc.duration : null;
  const durationGuard = {
    declaredDraftEndUs,
    effectiveDraftEndUs: declaredDraftEndUs == null
      ? (parkedWindow?.end ?? null)
      : Math.max(declaredDraftEndUs, parkedWindow?.end || 0),
    parkedRange: parkedWindow,
  };
  const seenSegmentIds = new Set();
  const seenMaterialIds = new Map();
  const seenTrackIds = new Set();
  const videoBasenames = new Map();
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!value?.id) continue;
      if (seenMaterialIds.has(value.id)) {
        const previous = seenMaterialIds.get(value.id);
        if (JSON.stringify(previous.value) !== JSON.stringify(value)) {
          issues.push(issue('error', 'CONFLICTING_MATERIAL_ID', `Material id ${value.id} is reused with conflicting data.`, { file, id: value.id, kind, previousKind: previous.kind }));
        } else if (!previous.reported) {
          if (!isKnownPreset3Duplicate(kind, value, duplicateBaseline)) {
            issues.push(issue('warning', 'DUPLICATE_MATERIAL_ID', `CapCut repeats identical material id ${value.id}; it is treated as one logical material.`, { file, id: value.id, kind }));
          }
          previous.reported = true;
        }
      } else seenMaterialIds.set(value.id, { kind, value, reported: false });
      const mediaPath = value.path;
      if (checkFiles && typeof mediaPath === 'string' && mediaPath.startsWith('/') && !fs.existsSync(mediaPath)) {
        issues.push(isCapCutCachePath(mediaPath)
          ? issue('warning', 'MISSING_CAPCUT_RESOURCE',
            `CapCut resource not cached on this machine: ${mediaPath}. CapCut re-downloads its own `
            + 'effects, masks and stock audio on demand, so this is not a broken project — but the '
            + 'look will not render until it does. `capcutctl harvest` re-captures your machine\'s ids.',
            { file, id: value.id, path: mediaPath })
          : issue('error', 'MISSING_MEDIA', `Missing media file: ${mediaPath}`, { file, id: value.id, path: mediaPath }));
      }
      // A path can exist on disk and still be unopenable: CapCut is sandboxed and refuses
      // files it did not pick itself, which surfaces as the "Link media" dialog on open.
      // `doctor` only stat'd the path, so it passed a project CapCut could not open —
      // structurally perfect, practically broken, and invisible to `qa` too because qa
      // reads media with its own ffmpeg. Anything not inside the draft is a real risk.
      if (checkFiles && projectDir && (kind === 'videos' || kind === 'audios')
          && typeof mediaPath === 'string' && mediaPath.startsWith('/')
          && fs.existsSync(mediaPath) && !isCapCutCachePath(mediaPath)
          && !isLocalMedia(projectDir, mediaPath)) {
        if (!reportedOutsideMedia.has(mediaPath)) {
        reportedOutsideMedia.add(mediaPath);
        issues.push(issue('warning', 'MEDIA_NOT_LOCALIZED',
          `Media lives outside the draft: ${mediaPath}. CapCut is sandboxed and may refuse to `
          + 'open it ("Link media"). Run `capcutctl localize --project NAME` to copy it in.',
          { file, id: value.id, kind, path: mediaPath }));
        }
      }
      if (kind === 'videos' && typeof mediaPath === 'string' && mediaPath.startsWith('/')) {
        const name = path.basename(mediaPath);
        if (!videoBasenames.has(name)) videoBasenames.set(name, new Set());
        videoBasenames.get(name).add(mediaPath);
      }
    }
  }
  for (const [name, paths] of videoBasenames) {
    if (paths.size < 2) continue;
    issues.push(issue('warning', 'MEDIA_BASENAME_COLLISION',
      `CapCut cannot tell ${paths.size} files all named ${name} apart. Run capcutctl localize --project NAME.`,
      { file, name, paths: [...paths] }));
  }

  for (const entry of allSegments(doc)) {
    const { segment, trackIndex } = entry;
    if (!segment.id) issues.push(issue('error', 'SEGMENT_ID', `Segment without id on track ${trackIndex}.`, { file, trackIndex }));
    else if (seenSegmentIds.has(segment.id)) issues.push(issue('error', 'DUPLICATE_SEGMENT_ID', `Duplicate segment id ${segment.id}.`, { file, id: segment.id }));
    else seenSegmentIds.add(segment.id);
    if (segment.material_id && !materials.has(segment.material_id)) {
      issues.push(issue('error', 'MISSING_MATERIAL_REF', `Segment ${segment.id} references missing material ${segment.material_id}.`, { file, id: segment.id }));
    }
    for (const ref of segment.extra_material_refs || []) {
      if (!materials.has(ref)) issues.push(issue('error', 'MISSING_EXTRA_REF', `Segment ${segment.id} references missing extra material ${ref}.`, { file, id: segment.id, ref }));
    }
    for (const key of ['target_timerange', 'source_timerange']) {
      const range = segment[key];
      if (range == null && key === 'source_timerange') continue;
      if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.duration)) {
        issues.push(issue('error', 'BAD_TIMERANGE', `${segment.id}.${key} is invalid.`, { file, id: segment.id, key }));
      } else if (range.start < 0 || range.duration < 0) {
        issues.push(issue('error', 'NEGATIVE_TIMERANGE', `${segment.id}.${key} is negative.`, { file, id: segment.id, key }));
      }
    }
    const target = segment.target_timerange;
    if (target && Number.isFinite(durationGuard.declaredDraftEndUs)
        && target.start + target.duration > durationGuard.declaredDraftEndUs + DURATION_TOLERANCE_US) {
      const targetEnd = target.start + target.duration;
      const insidePark = Boolean(parkedWindow
        && target.start >= parkedWindow.start - DURATION_TOLERANCE_US
        && targetEnd <= parkedWindow.end + DURATION_TOLERANCE_US);
      if (!insidePark) {
        issues.push(issue('error', 'SEGMENT_AFTER_END', `Segment ${segment.id} extends beyond draft duration.`, {
          file,
          id: segment.id,
          durationGuard,
          targetEndUs: targetEnd,
        }));
      }
    }
    const source = segment.source_timerange;
    const material = materials.get(segment.material_id)?.value;
    if (source && Number.isFinite(material?.duration) && source.start + source.duration > material.duration + 1) {
      issues.push(issue('error', 'SOURCE_AFTER_END', `Segment ${segment.id} exceeds source material duration.`, { file, id: segment.id, materialId: segment.material_id }));
    }
    // source = target × speed. 1ms of slack: CapCut's own rounding drifts a microsecond
    // or two, which is not a ramp bug. A 10% miss is.
    if (source && target && Number.isFinite(segment.speed) && segment.speed > 0 && target.duration > 0) {
      const expected = target.duration * segment.speed;
      if (Math.abs(source.duration - expected) > 1000) {
        issues.push(issue('warning', 'SPEED_INVARIANT',
          `${segment.id}: source ${source.duration}us ≠ target ${target.duration}us × speed ${segment.speed}.`,
          { file, id: segment.id }));
      }
    }
    const numericLeaves = [];
    walk(segment.clip, (value, keyPath) => { if (typeof value === 'number') numericLeaves.push([keyPath, value]); });
    for (const [keyPath, value] of numericLeaves) if (!Number.isFinite(value)) {
      issues.push(issue('error', 'NONFINITE_CLIP', `${segment.id}.${keyPath} is non-finite.`, { file, id: segment.id }));
    }
  }
  for (const [trackIndex, track] of (doc.tracks || []).entries()) {
    if (track.id) {
      if (seenTrackIds.has(track.id)) issues.push(issue('error', 'DUPLICATE_TRACK_ID', `Duplicate track id ${track.id}.`, { file, id: track.id, trackIndex }));
      seenTrackIds.add(track.id);
    }
    const ordered = [...(track.segments || [])].filter(segment => segment.target_timerange).sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 1; i < ordered.length; i++) {
      const previousEnd = ordered[i - 1].target_timerange.start + ordered[i - 1].target_timerange.duration;
      if (ordered[i].target_timerange.start < previousEnd) {
        issues.push(issue('warning', 'TRACK_OVERLAP', `Track ${trackIndex} has overlapping segments ${ordered[i - 1].id} and ${ordered[i].id}.`, { file, trackIndex }));
      }
    }
  }
  return issues;
}

export function documentFingerprint(doc) {
  return sha256(JSON.stringify({
    duration: doc.duration,
    fps: doc.fps,
    canvas: doc.canvas_config,
    tracks: (doc.tracks || []).map(track => ({
      type: track.type,
      segments: (track.segments || []).map(segment => ({
        id: segment.id,
        material_id: segment.material_id,
        target_timerange: segment.target_timerange,
        source_timerange: segment.source_timerange,
        clip: segment.clip,
        volume: segment.volume,
        speed: segment.speed,
        enable_video_mask: segment.enable_video_mask
      }))
    }))
  }));
}

/**
 * Report media the human can no longer change. Both faults are invisible to every other check:
 * the picture is correct, the JSON is valid, and the project opens — the loss is that a
 * decision which should still be a CapCut property was flattened into the pixels, or the path
 * back to the footage it came from is gone.
 *
 * Warnings, never errors. These are the projects built before `add` enforced the contract;
 * refusing to load them would help nobody, and the repair (relink the original, re-express the
 * framing with `layout broll --row`) is a judgement call the human has to make.
 */
function auditMediaOrigins(projectDir, state) {
  const issues = [];
  const group = state.groups.find(item => item.name === 'root') || state.groups[0];
  if (!group?.doc) return issues;
  let map = {};
  try { map = JSON.parse(fs.readFileSync(path.join(projectDir, '.capcutctl', 'media-map.json'), 'utf8')) || {}; } catch { /* no map: fall back to the material's own fields */ }
  const records = (map.materials && typeof map.materials === 'object') ? map.materials : {};
  const cc = group.doc.canvas_config || {};
  const canvas = [cc.width || 1080, cc.height || 1920];
  const seen = new Set();
  for (const material of group.doc.materials?.videos || []) {
    if (!material?.id || material.type !== 'video' || seen.has(material.id)) continue;
    seen.add(material.id);
    const record = records[material.id] || null;
    const declared = material.capcutctl_origin || record?.origin || null;
    if (declared === 'generated') continue;              // a render has no original to lose
    const name = material.material_name || path.basename(material.path || '<unknown>');

    const region = isPreframed({ width: material.width, height: material.height, canvas });
    if (region) {
      issues.push(issue('warning', 'MEDIA_PREFRAMED',
        `${name} is ${material.width}x${material.height} — exactly the ${region.region} of the `
        + `${canvas[0]}x${canvas[1]} canvas, so its framing was cropped in before import and cannot be `
        + 'changed in CapCut. Relink the full-frame original and re-frame with `capcutctl layout broll '
        + '--row` (or `layout screen`). If it is a rendered graphic, re-add it with --generated.',
        { id: material.id, name, width: material.width, height: material.height }));
    }

    const origin = material.derived_from_path || record?.derived_from_path
      || material.original_path || record?.originalPath || material.source_path || null;
    if (origin && !fs.existsSync(origin)) {
      issues.push(issue('warning', 'MEDIA_ORIGIN_LOST',
        `${name} was imported from ${origin}, which no longer exists. The copy in Resources still `
        + 'plays, but there is no way back to the footage it was cut from. Re-add it from a durable '
        + 'path, or record the real source with --derived-from.',
        { id: material.id, name, origin }));
    }
  }
  return issues;
}

/**
 * "Will this work on my machine?" — answered without needing a project.
 *
 * Three things are environment, not code, and all three used to fail as something unhelpful:
 * a missing ffmpeg surfaced as `spawnSync ENOENT`; a missing overlay PNG as ASSET_NOT_FOUND
 * halfway through a layout; and a missing CapCut effect cache as `Transaction failed
 * validation with 12 error(s)` at the end of a polish. Report all of it up front, with the
 * command that fixes each one.
 */
export function preflight({
  root = DEFAULT_ROOT,
  binaryCheck = name => hasBinary(name, { refresh: true }),
  commandRunner = (command, args) => runPreflightCommand(command, args),
  statfs = fs.statfsSync,
  writeProbe = null,
  pythonCheck = preflightPython,
  minimumFreeBytes = process.env.CAPCUTCTL_MIN_FREE_BYTES || PREFLIGHT_MIN_FREE_BYTES,
} = {}) {
  const checks = [];
  const add = (name, ok, detail, fix = null, { blocking = true, ...extra } = {}) => checks.push({
    name,
    ok: Boolean(ok),
    detail: detail || (ok ? 'passed' : 'failed'),
    ...(fix ? { fix } : {}),
    ...(blocking ? {} : { blocking: false }),
    ...extra,
  });

  const binaryResults = new Map();
  const available = name => {
    if (!binaryResults.has(name)) {
      let ok = false;
      try { ok = Boolean(binaryCheck(name)); } catch { /* report as unavailable below */ }
      binaryResults.set(name, ok);
    }
    return binaryResults.get(name);
  };

  const command = (name, args) => {
    try {
      const result = commandRunner(name, args);
      if (result && typeof result === 'object') return result;
      return { ok: Boolean(result), detail: Boolean(result) ? 'probe passed' : 'probe failed' };
    } catch (error) {
      return { ok: false, detail: `could not start (${error.code || error.message})` };
    }
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('Node.js', nodeMajor >= 20, `v${process.versions.node}`,
    nodeMajor >= 20 ? null : 'install Node.js 20 or newer');

  for (const binary of ['ffmpeg', 'ffprobe']) {
    const ok = available(binary);
    add(binary, ok, ok ? 'on PATH' : 'not on PATH',
      ok ? null : (INSTALL_HINT[process.platform] || `install ${binary}`));
  }

  const ffmpegProbe = available('ffmpeg')
    ? command('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=black:s=2x2:r=1:d=0.1', '-frames:v', '1', '-f', 'null', '-',
    ])
    : { ok: false, detail: 'skipped because ffmpeg is not on PATH' };
  add('ffmpeg probe', ffmpegProbe.ok, ffmpegProbe.ok ? 'executed a synthetic frame probe' : ffmpegProbe.detail,
      ffmpegProbe.ok ? null : 'repair or reinstall ffmpeg, then retry `capcutctl preflight`');

  let layouts = { assetSearchPaths: [] };
  try {
    layouts = loadPreset('layouts');
    if (!layouts?.layouts || typeof layouts.layouts !== 'object') throw new Error('missing layouts object');
    add('layouts preset', true, presetFile('layouts'));
  } catch (error) {
    add('layouts preset', false, `could not load ${presetFile('layouts')}: ${error.message}`,
      'restore a valid layouts.json or remove the broken CAPCUTCTL_PRESET_DIR override');
  }
  const probeAsset = preflightAssetPath(layouts, 'suheilai-rect-indigo-1080x1920 (2).png');
  const ffprobeArgs = probeAsset
    ? ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '--', probeAsset]
    : ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=2x2:r=1:d=0.1', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'];
  const ffprobeProbe = available('ffprobe')
    ? command('ffprobe', ffprobeArgs)
    : { ok: false, detail: 'skipped because ffprobe is not on PATH' };
  const ffprobeOutput = String(ffprobeProbe.stdout || '').trim();
  const ffprobeOk = Boolean(ffprobeProbe.ok && /^\d+\s*,\s*\d+$/.test(ffprobeOutput));
  const ffprobeFailure = ffprobeProbe.ok && !ffprobeOk
    ? 'probe returned no valid stream dimensions'
    : ffprobeProbe.detail;
  const ffprobeDetail = ffprobeOk
    ? `executed a media probe${probeAsset ? ` on ${probeAsset}` : ''}`
    : ffprobeFailure;
  add('ffprobe probe', ffprobeOk, ffprobeDetail,
      ffprobeOk ? null : 'repair or reinstall ffprobe, then retry `capcutctl preflight`');

  // The interpreter cut/qa/find will actually spawn, and the imports they will actually make.
  // Probing `python3` here while the commands resolve something else is how a green preflight
  // and a ModuleNotFoundError end up in the same session.
  const pythonRows = pythonCheck();
  for (const row of pythonRows) {
    const { name, ok, detail, fix, ...extra } = row;
    add(name, ok, detail, fix, extra);
  }

  const resolvedInterpreter = pythonRows.find(row => row.interpreter)?.interpreter || null;
  const whisper = preflightWhisper({
    binaryCheck: available, commandRunner: command, interpreter: resolvedInterpreter,
  });
  add('Whisper/MLX transcription', whisper.ok, whisper.detail, whisper.fix,
      { mlxReady: whisper.mlxReady, whisperReady: whisper.whisperReady });

  const ocr = preflightOcr({
    binaryCheck: available,
    commandRunner: command,
    helperPath: path.join(PACKAGE_ROOT, 'tools', 'vision', 'ocr'),
    sourcePath: path.join(PACKAGE_ROOT, 'tools', 'vision', 'ocr.swift'),
    samplePath: probeAsset,
  });
  // OCR is deliberately non-blocking: frame QA remains useful without `--ocr`; the command
  // itself reports the same build instruction when a user requests OCR specifically.
  add('OCR tooling', ocr.ok, ocr.detail, ocr.fix, { blocking: false });

  const assets = ['suheilai-rect-indigo-1080x1920 (2).png', 'suheilai-circle-white-1080x1920.png'];
  for (const basename of assets) {
    const roots = assetSearchRoots(layouts.assetSearchPaths || []);
    const found = roots.map(assetRoot => path.join(assetRoot, basename)).find(file => fs.existsSync(file));
    add(`asset: ${basename}`, Boolean(found), found || `not found in ${roots.join(', ')}`,
      found ? null : 'reinstall, or set CAPCUTCTL_ASSET_DIR to a directory holding your own overlay');
  }

  // The SFX palette is CapCut's own effect/music cache. Those paths are minted on the machine
  // where the sound was downloaded, so a fresh install has none of them: polish still runs, it
  // just places nothing. Report the ratio rather than pretending it is pass/fail.
  try {
    const sfx = loadPreset('sfx');
    if (!sfx || typeof sfx !== 'object') throw new Error('expected an object');
    const entries = [
      ...Object.entries(sfx.audioTemplates || {}),
      ...Object.entries(sfx.transitionTemplates || {}),
    ].filter(([, tpl]) => tpl?.path);
    const present = entries.filter(([, tpl]) => fs.existsSync(tpl.path));
    add('sfx palette', present.length > 0,
      `${present.length}/${entries.length} sounds and transitions available` +
      (present.length ? '' : ' — polish will place none'),
      present.length === entries.length ? null
        : 'download the sounds you want in CapCut, then run `capcutctl harvest`, or point '
          + '$CAPCUTCTL_PRESET_DIR at a directory with your own sfx.json',
      { blocking: false });
  } catch (error) {
    add('sfx palette', false, `could not load ${presetFile('sfx')}: ${error.message}`,
      'restore a valid sfx.json or remove the broken CAPCUTCTL_PRESET_DIR override',
      { blocking: false });
  }

  const draftsFolder = fs.existsSync(root) && (() => {
    try { return fs.statSync(root).isDirectory(); } catch { return false; }
  })();
  add('CapCut drafts folder', draftsFolder,
    draftsFolder ? path.resolve(root) : `${root} does not exist or is not a directory`,
    draftsFolder ? null : 'install CapCut and open it once, or pass --root PATH');

  const write = preflightWrite(root, { writer: writeProbe });
  add('CapCut drafts folder write permission', write.ok, write.detail,
      write.ok ? null : 'grant write permission to the CapCut drafts folder, or pass --root PATH');

  const disk = preflightDisk(root, { statfs, minimumBytes: minimumFreeBytes });
  add('free disk space', disk.ok, disk.detail,
      disk.ok ? null : `free at least ${formatBytes(disk.threshold || Number(minimumFreeBytes) || PREFLIGHT_MIN_FREE_BYTES)} on the drafts volume, then retry`);

  const blocking = checks.filter(c => c.blocking !== false && !c.ok);
  return {
    ok: blocking.length === 0,
    draftsRoot: path.resolve(root),
    presetDir: presetFile('sfx'),
    assetDirs: assetSearchRoots(layouts.assetSearchPaths || []),
    checks,
  };
}

export function doctor(projectDir, { checkFiles = true, duplicateBaseline = null } = {}) {
  const state = loadProject(projectDir);
  const issues = [];
  const requestedBaseline = duplicateBaseline === null
    ? knownPreset3DuplicateBaseline(projectDir)
    : duplicateBaseline === false ? [] : duplicateBaseline;
  const baseline = Array.isArray(requestedBaseline) ? requestedBaseline : [];
  const baselineDuplicates = [];
  for (const group of state.groups) {
    issues.push(...validateDocument(group.doc, {
      file: group.canonical,
      checkFiles,
      projectDir,
      duplicateBaseline: baseline,
    }));
    for (const match of baselineDuplicateMatches(group.doc, baseline)) {
      baselineDuplicates.push({ ...match, group: group.name, file: group.canonical });
    }
    const canonicalHash = sha256(fs.readFileSync(group.canonical));
    for (const mirror of group.mirrors) {
      if (!fs.existsSync(mirror)) {
        issues.push(issue('warning', 'MISSING_MIRROR', `Missing live mirror ${mirror}.`, { file: mirror, group: group.name }));
        continue;
      }
      let mirrorHash;
      try { mirrorHash = sha256(fs.readFileSync(mirror)); readJson(mirror); }
      catch (error) { issues.push(issue('error', 'INVALID_MIRROR', error.message, { file: mirror, group: group.name })); continue; }
      if (mirrorHash !== canonicalHash) issues.push(issue('warning', 'MIRROR_DRIFT', `Mirror differs from canonical: ${mirror}`, { file: mirror, group: group.name }));
    }
  }
  if (state.groups.length > 1) {
    const fingerprints = state.groups.map(group => ({ name: group.name, value: documentFingerprint(group.doc) }));
    if (new Set(fingerprints.map(item => item.value)).size > 1) {
      issues.push(issue('warning', 'DOCUMENT_DRIFT', 'Root draft and active timeline differ structurally. Semantic edits will be applied to both documents independently.', { fingerprints }));
    }
  }
  // CapCut resolves a draft's timeline by draft_info.json's top-level `id`. When it
  // does not match the active timeline, every structural check still passes and the
  // project simply will not open.
  if (state.activeTimelineId) {
    for (const group of state.groups) {
      if (group.doc?.id && group.doc.id !== state.activeTimelineId) {
        issues.push(issue('error', 'TIMELINE_ID_MISMATCH',
          `${group.name}: draft_info.json id "${group.doc.id}" does not match the active timeline "${state.activeTimelineId}". CapCut will not open this project.`,
          { file: group.canonical, group: group.name }));
      }
    }
  }
  // A transition needs a clip on BOTH sides. CapCut silently discards one attached to a
  // segment with nothing after it on its own track, so the edit looks applied on disk and
  // is gone the moment the project is opened. And a transition below the talking head
  // wipes the B-roll while the face hard-cuts — the layer, not just the timing, is wrong.
  for (const group of state.groups) {
    const doc = group.doc;
    if (!doc || !Array.isArray(doc.tracks)) continue;
    const transitionIds = new Set((doc.materials?.transitions || []).map(m => m.id));
    if (!transitionIds.size) continue;
    const videoTracks = doc.tracks
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.type === 'video' && (t.segments || []).length);
    const carriers = [];
    for (const { t, i } of videoTracks) {
      const segs = [...t.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
      for (const [n, seg] of segs.entries()) {
        if (!(seg.extra_material_refs || []).some(r => transitionIds.has(r))) continue;
        const end = seg.target_timerange.start + seg.target_timerange.duration;
        carriers.push({ i, at: end });
        const next = segs[n + 1];
        if (!next || next.target_timerange.start - end > 20000) {
          issues.push(issue('error', 'TRANSITION_ORPHANED',
            `${group.name}: a transition at ${(end / 1e6).toFixed(2)}s sits on track ${i} with no clip after it. CapCut will drop it on load.`,
            { file: group.canonical, track: i, at: end / 1e6 }));
        }
      }
    }
    // Hermes-agent puts all nine of its transitions on one track — the talking head — and
    // none anywhere else. Split across layers, each wipe only affects its own layer while
    // the others cut straight through, which is the difference between a polished cut and
    // a B-roll that dissolves under a face that jumps.
    let principal = null;
    try { principal = principalTrack(doc).index; } catch { /* no continuous track; skip */ }
    if (principal != null) {
      const strays = [...new Set(carriers.filter(c => c.i !== principal).map(c => c.i))];
      if (strays.length) {
        const n = carriers.filter(c => c.i !== principal).length;
        issues.push(issue('warning', 'TRANSITION_OFF_PRINCIPAL',
          `${group.name}: ${n} transition(s) sit on track(s) ${strays.join(', ')} instead of the principal track ${principal} (the gapless talking head). Re-run \`capcutctl polish\` to move them.`,
          { file: group.canonical, strays, principal }));
      }
    }

    // A frame plate above the cut is fine: a PNG or GIF swapping when the layout changes is
    // the frame following the scene, and Hermes-agent — the reference — does exactly that at
    // four of its nine cuts. The fault is a higher track of MOVING PICTURE that cuts at the
    // same instant with no transition of its own: that layer hard-cuts through the wipe.
    const plates = new Set((doc.materials?.videos || [])
      .filter(m => m.type && m.type !== 'video').map(m => m.id));
    for (const { i, at } of carriers) {
      for (const { i: j, t } of videoTracks) {
        if (j <= i) continue;
        const bare = (t.segments || []).find(s =>
          Math.abs(s.target_timerange.start + s.target_timerange.duration - at) < 20000
          && !plates.has(s.material_id)
          && !(s.desc || '').startsWith('layout:')
          && !(s.extra_material_refs || []).some(r => transitionIds.has(r)));
        if (!bare) continue;
        issues.push(issue('warning', 'TRANSITION_BELOW_TOP',
          `${group.name}: the transition at ${(at / 1e6).toFixed(2)}s is on track ${i}, but track ${j} cuts at the same instant with no transition and renders above it — the upper layer hard-cuts through the wipe. Put transitions on the principal (talking-head) track.`,
          { file: group.canonical, track: i, cutAlsoOn: j, at: at / 1e6 }));
        break;
      }
    }
  }

  issues.push(...auditMediaOrigins(projectDir, state));

  const capcut = capcutStatus({ root: path.dirname(projectDir) });
  if (capcut.running) issues.push(issue('warning', 'CAPCUT_RUNNING', `CapCut is running (PID ${capcut.pids.join(', ')}). Writes are blocked by default.`, { pids: capcut.pids }));
  return {
    project: projectDir,
    activeTimelineId: state.activeTimelineId,
    documents: state.groups.map(group => ({
      name: group.name,
      file: group.canonical,
      duration: group.doc.duration ?? null,
      contentDuration: group.durations.contentDurationUs,
      editDuration: group.durations.editDurationUs,
      draftDuration: group.durations.draftDurationUs,
      durations: group.durations,
    })),
    durations: state.groups.map(group => ({ name: group.name, ...group.durations })),
    capcut,
    duplicateBaseline: {
      enabled: baseline.length > 0,
      source: baseline.length > 0 ? 'Preset 3' : null,
      known: baseline.map(({ kind, id, unique_id, type, width, height, duration }) => ({
        kind, id, unique_id, type, width, height, duration,
      })),
      matches: baselineDuplicates,
    },
    errors: issues.filter(item => item.level === 'error').length,
    warnings: issues.filter(item => item.level === 'warning').length,
    issues
  };
}

function walk(value, visitor, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    visitor(child, keyPath);
    walk(child, visitor, keyPath);
  }
}

export function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      deepMerge(target[key], value);
    } else target[key] = clone(value);
  }
  return target;
}

export function unsetPath(target, dotted) {
  const keys = dotted.split('.');
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cursor || typeof cursor !== 'object') return;
    cursor = cursor[keys[i]];
  }
  if (cursor && typeof cursor === 'object') delete cursor[keys.at(-1)];
}

function matches(value, selector = {}) {
  if (selector.id && value.id !== selector.id) return false;
  if (selector.name && value.name !== selector.name) return false;
  if (selector.desc && value.desc !== selector.desc) return false;
  if (selector.material_id && value.material_id !== selector.material_id) return false;
  if (selector.path && value.path !== selector.path) return false;
  if (selector.pathEndsWith && !value.path?.endsWith(selector.pathEndsWith)) return false;
  return true;
}

export function selectSegments(doc, selector = {}) {
  return allSegments(doc).filter(entry => {
    if (selector.trackIndex != null && entry.trackIndex !== selector.trackIndex) return false;
    if (selector.trackType && entry.track.type !== selector.trackType) return false;
    return matches(entry.segment, selector);
  });
}

export function selectMaterials(doc, selector = {}) {
  const result = [];
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (matches(value, selector)) result.push({ kind, value });
  }
  return result;
}

function equivalentMaterialMatches(found) {
  if (!found.length) return false;
  const first = found[0];
  return found.every(entry => entry.kind === first.kind && entry.value.id === first.value.id && JSON.stringify(entry.value) === JSON.stringify(first.value));
}

function requireMatches(matchesList, op, label) {
  if (!matchesList.length && op.optional === true) return false;
  if (!matchesList.length) throw new CapcutError(`${op.op}: no ${label} matched ${JSON.stringify(op.selector || op.segment || op.from)}.`, { code: 'SELECTOR_EMPTY' });
  if (matchesList.length > 1 && op.all !== true) {
    throw new CapcutError(`${op.op}: selector matched ${matchesList.length} ${label}; add \"all\": true or use a unique id.`, { code: 'SELECTOR_AMBIGUOUS' });
  }
  return true;
}

function ensureMaterialArray(doc, kind) {
  if (!Array.isArray(doc.materials[kind])) doc.materials[kind] = [];
  return doc.materials[kind];
}

/**
 * `seed` is required: applyOperations runs once per mirror document, so a raw uuid() here gave
 * root and the timeline DIFFERENT ids for the same cloned extras. Each document stayed
 * internally consistent, so doctor passed and the drift was invisible — the same failure the
 * op-level __seed was introduced to stop, just one level down.
 */
function cloneExtraRefs(doc, template, segmentId, seed) {
  const index = materialIndex(doc);
  const refs = [];
  for (const [i, oldId] of (template.extra_material_refs || []).entries()) {
    const indexed = index.get(oldId);
    if (!indexed) continue;
    const copied = clone(indexed.value);
    copied.id = seededId(seed, `extra:${i}:${oldId}:${segmentId}`);
    if (copied.bind_segment_id === template.id || copied.bind_segment_id === '') copied.bind_segment_id = segmentId;
    ensureMaterialArray(doc, indexed.kind).push(copied);
    refs.push(copied.id);
  }
  return refs;
}

function removeUnreferencedMaterials(doc, ids) {
  const live = new Set();
  for (const { segment } of allSegments(doc)) {
    if (segment.material_id) live.add(segment.material_id);
    for (const ref of segment.extra_material_refs || []) live.add(ref);
  }
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    doc.materials[kind] = values.filter(value => !ids.has(value?.id) || live.has(value.id));
  }
}

function normalizeUs(value, field) {
  if (value == null) return null;
  if (Number.isInteger(value) && Math.abs(value) > 100000) return value;
  if (!Number.isFinite(value)) throw new CapcutError(`${field} must be finite.`, { code: 'BAD_TIME' });
  return Math.round(value * 1_000_000);
}

function opSegmentPatch(doc, op) {
  const found = selectSegments(doc, op.selector);
  if (!requireMatches(found, op, 'segments')) return { changed: 0, skipped: true };
  for (const entry of op.all ? found : found.slice(0, 1)) {
    deepMerge(entry.segment, op.set || {});
    for (const key of op.unset || []) unsetPath(entry.segment, key);
  }
  return { changed: op.all ? found.length : 1 };
}

function opSegmentRemove(doc, op) {
  const found = selectSegments(doc, op.selector);
  if (!requireMatches(found, op, 'segments')) return { changed: 0, skipped: true };
  const selected = op.all ? found : found.slice(0, 1);
  const refIds = new Set();
  for (const entry of selected) for (const ref of entry.segment.extra_material_refs || []) refIds.add(ref);
  for (const track of doc.tracks || []) {
    track.segments = (track.segments || []).filter(segment => !selected.some(entry => entry.segment === segment));
  }
  if (op.pruneRefs !== false) removeUnreferencedMaterials(doc, refIds);
  return { changed: selected.length };
}

function resolveTrack(doc, selector = {}) {
  const tracks = (doc.tracks || []).map((track, index) => ({ track, index })).filter(entry => {
    if (selector.index != null && entry.index !== selector.index) return false;
    if (selector.id && entry.track.id !== selector.id) return false;
    if (selector.type && entry.track.type !== selector.type) return false;
    return true;
  });
  if (tracks.length !== 1) throw new CapcutError(`Track selector matched ${tracks.length} tracks: ${JSON.stringify(selector)}`, { code: 'TRACK_SELECTOR' });
  return tracks[0];
}

function opSegmentClone(doc, op) {
  const templates = selectSegments(doc, op.from || {});
  if (!requireMatches(templates, { ...op, selector: op.from }, 'template segments')) return { changed: 0, skipped: true };
  const template = templates[0].segment;
  const destination = resolveTrack(doc, op.track || { index: templates[0].trackIndex });
  const copied = clone(template);
  copied.id = op.id || uuid();
  copied.extra_material_refs = cloneExtraRefs(doc, template, copied.id, op.__seed);
  copied.keyframe_refs = [];
  copied.common_keyframes = [];
  if (op.material) {
    const materials = selectMaterials(doc, op.material);
    if (materials.length !== 1 && !equivalentMaterialMatches(materials)) throw new CapcutError(`Material selector matched ${materials.length} distinct materials: ${JSON.stringify(op.material)}`, { code: 'MATERIAL_SELECTOR' });
    copied.material_id = materials[0].value.id;
  }
  if (op.target) copied.target_timerange = { start: normalizeUs(op.target.start, 'target.start'), duration: normalizeUs(op.target.duration, 'target.duration') };
  if (op.source === null) copied.source_timerange = null;
  else if (op.source) copied.source_timerange = { start: normalizeUs(op.source.start, 'source.start'), duration: normalizeUs(op.source.duration, 'source.duration') };
  if (op.set) deepMerge(copied, op.set);
  destination.track.segments.push(copied);
  destination.track.segments.sort((a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0));
  return { changed: 1, id: copied.id };
}

function opMaskPatch(doc, op) {
  const segments = selectSegments(doc, op.segment || op.selector || {});
  if (!requireMatches(segments, { ...op, selector: op.segment || op.selector }, 'segments')) return { changed: 0, skipped: true };
  let changed = 0;
  for (const entry of op.all ? segments : segments.slice(0, 1)) {
    const index = materialIndex(doc);
    const masks = (entry.segment.extra_material_refs || []).map(id => index.get(id)).filter(item => item?.kind === 'common_mask' || item?.value?.type === 'mask');
    if (!masks.length) throw new CapcutError(`mask.patch: segment ${entry.segment.id} has no bound mask.`, { code: 'MASK_NOT_FOUND' });
    if (masks.length > 1 && !op.mask?.id && !op.mask?.name) throw new CapcutError(`mask.patch: segment ${entry.segment.id} has multiple masks; select one.`, { code: 'MASK_AMBIGUOUS' });
    const mask = masks.find(item => matches(item.value, op.mask || {})) || masks[0];
    deepMerge(mask.value, op.set || {});
    entry.segment.enable_video_mask = op.enable ?? true;
    changed++;
  }
  return { changed };
}

export const LOCAL_MEDIA_DIR = path.join('Resources', 'CapcutctlMedia');

const sanitizeName = s => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'media';

export function isLocalMedia(projectDir, mediaPath) {
  if (!projectDir || typeof mediaPath !== 'string') return false;
  const root = path.resolve(projectDir);
  const resolved = path.resolve(mediaPath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function fileHash(file) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = fs.openSync(file, 'r');
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * The same bytes, not merely the same byte count.
 *
 * Byte size alone decided whether a colliding destination could be REUSED, and the copy
 * then went ahead regardless: two genuinely different takes sharing a parent-folder name,
 * a basename and a size resolved to one file, the second silently overwrote the first, and
 * every material already pointing there played the wrong footage. Size stays the cheap
 * gate; the hash is the answer. Only reached on a name collision, which is rare.
 */
function sameContents(a, b) {
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  return fileHash(a) === fileHash(b);
}

export function localizeMedia(projectDir, source, fileName, { dryRun = false } = {}) {
  source = path.resolve(source);
  if (!fs.existsSync(source)) throw new CapcutError(`Source media does not exist: ${source}`, { code: 'MISSING_SOURCE' });
  const mediaDir = path.join(projectDir, LOCAL_MEDIA_DIR);
  if (isLocalMedia(projectDir, source)) return source;

  const base = sanitizeName(fileName || path.basename(source));
  const parent = sanitizeName(path.basename(path.dirname(source)));
  // rl2 writes every take as screen.mp4 — basename alone would collide and CapCut
  // then cannot tell three files named screen.mp4 apart in its "Link media" dialog.
  let safe = parent && parent !== '_' ? `${parent}__${base}` : base;
  let destination = path.join(mediaDir, safe);
  // The tag is derived from the SOURCE PATH, so localizing the same file twice keeps
  // resolving to the same destination instead of piling up copies.
  if (fs.existsSync(destination) && path.resolve(destination) !== source
      && !sameContents(source, destination)) {
    const tag = crypto.createHash('sha1').update(source).digest('hex').slice(0, 8);
    const ext = path.extname(base);
    safe = `${parent}__${path.basename(base, ext)}__${tag}${ext}`;
    destination = path.join(mediaDir, safe);
  }
  if (!dryRun) {
    fs.mkdirSync(mediaDir, { recursive: true });
    if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
    persistRl2Sidecar(projectDir, source);
  }
  return destination;
}

const RL2_SIDECARS = ['trace.ndjson', 'session.json', 'frames.ndjson', 'change.ndjson'];

/**
 * Keep the rl2 take's event trace next to the draft. Localized screen.mp4 lives in
 * Resources/ and polish.interactions maps clicks/typing through chopped B-roll from
 * this sidecar — without it the trace stays on Desktop and the edit has no events.
 */
export function persistRl2Sidecar(projectDir, source) {
  const takeDir = path.dirname(path.resolve(source));
  if (!fs.existsSync(path.join(takeDir, 'trace.ndjson'))) return null;
  const dest = path.join(projectDir, '.capcutctl', 'rl2', path.basename(takeDir));
  fs.mkdirSync(dest, { recursive: true });
  for (const name of RL2_SIDECARS) {
    const from = path.join(takeDir, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dest, name));
  }
  return dest;
}

function opMaterialRelink(doc, op, context) {
  const found = selectMaterials(doc, op.selector || {});
  if (!found.length && op.optional === true) return { changed: 0, skipped: true };
  if (!found.length) throw new CapcutError(`${op.op}: no materials matched ${JSON.stringify(op.selector || {})}.`, { code: 'SELECTOR_EMPTY' });
  if (found.length > 1 && op.all !== true && !equivalentMaterialMatches(found)) {
    throw new CapcutError(`${op.op}: selector matched ${found.length} distinct materials; add "all": true or use a unique id.`, { code: 'SELECTOR_AMBIGUOUS' });
  }
  let destination = path.resolve(op.path);
  if (op.localize) destination = localizeMedia(context.projectDir, destination, op.fileName, { dryRun: context.dryRun });
  if (!context.dryRun && !fs.existsSync(destination)) throw new CapcutError(`Relink target does not exist: ${destination}`, { code: 'MISSING_RELINK_TARGET' });
  const selected = op.all || equivalentMaterialMatches(found) ? found : found.slice(0, 1);
  for (const entry of selected) {
    entry.value.path = destination;
    if ('media_path' in entry.value) entry.value.media_path = '';
    if (op.name) entry.value.material_name = op.name;
    if (op.set) deepMerge(entry.value, op.set);
  }
  return { changed: selected.length, logicalMaterials: equivalentMaterialMatches(found) ? 1 : selected.length, path: destination };
}

function opMaterialClone(doc, op, context) {
  const found = selectMaterials(doc, op.from || {});
  if (!found.length && op.optional === true) return { changed: 0, skipped: true };
  if (!found.length) throw new CapcutError(`${op.op}: no template materials matched ${JSON.stringify(op.from || {})}.`, { code: 'SELECTOR_EMPTY' });
  if (found.length > 1 && !equivalentMaterialMatches(found)) throw new CapcutError(`${op.op}: template selector matched ${found.length} distinct materials.`, { code: 'SELECTOR_AMBIGUOUS' });
  const template = found[0];
  const copied = clone(template.value);
  copied.id = op.id;
  if (op.path) {
    let destination = path.resolve(op.path);
    if (op.localize) destination = localizeMedia(context.projectDir, destination, op.fileName, { dryRun: context.dryRun });
    if (!context.dryRun && !fs.existsSync(destination)) throw new CapcutError(`Material source does not exist: ${destination}`, { code: 'MISSING_MATERIAL_SOURCE' });
    copied.path = destination;
    if ('media_path' in copied) copied.media_path = '';
  }
  if (op.name) copied.material_name = op.name;
  if (op.set) deepMerge(copied, op.set);
  for (const key of op.unset || []) unsetPath(copied, key);
  ensureMaterialArray(doc, op.kind || template.kind).push(copied);
  return { changed: 1, id: copied.id, kind: op.kind || template.kind, path: copied.path };
}

function opTrackClone(doc, op) {
  const template = resolveTrack(doc, op.from || {});
  const copied = clone(template.track);
  copied.id = op.id;
  copied.segments = [];
  if (op.set) deepMerge(copied, op.set);
  for (const key of op.unset || []) unsetPath(copied, key);
  const at = op.at == null ? doc.tracks.length : Number(op.at);
  if (!Number.isInteger(at) || at < 0 || at > doc.tracks.length) throw new CapcutError(`track.clone: invalid insertion index ${op.at}.`, { code: 'TRACK_INDEX' });
  doc.tracks.splice(at, 0, copied);
  return { changed: 1, id: copied.id, index: at };
}

function opTimelineSet(doc, op) {
  if (op.duration != null) doc.duration = normalizeUs(op.duration, 'duration');
  if (op.fps != null) doc.fps = op.fps;
  if (op.canvas) doc.canvas_config = clone(op.canvas);
  if (op.name) doc.name = op.name;
  return { changed: 1 };
}

const RECUT_FPS = 30;
const RECUT_TOLERANCE_US = 4;
const RECUT_GAP_TOLERANCE_US = 20_000;
const FPS_TOLERANCE = 1e-6;

function recutFail(message, code = 'CUT_PLAN_INVALID', details = {}) {
  throw new CapcutError('cut.recut: ' + message, { code, exitCode: 2, details });
}

function recutSeconds(value, field, { positive = false } = {}) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || (positive ? seconds <= 0 : seconds < 0)) {
    recutFail(field + ' must be ' + (positive ? 'finite and positive' : 'finite and non-negative') + '.');
  }
  return Math.round(seconds * 1_000_000);
}

function recutFrameTime(value, field, fps = RECUT_FPS) {
  const us = recutSeconds(value, field);
  const frame = 1_000_000 / fps;
  if (Math.abs(us - Math.round(us / frame) * frame) > RECUT_TOLERANCE_US) {
    recutFail(field + ' is not frame-quantized at ' + fps + 'fps.', 'CUT_PLAN_UNQUANTIZED', { value, fps });
  }
  return us;
}

function canonicalMediaPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); }
  catch { return resolved; }
}

function materialMediaPaths(material) {
  return [material?.path, material?.original_path, material?.media_path]
    .filter(value => typeof value === 'string' && value.trim())
    .map(canonicalMediaPath)
    .filter(Boolean);
}

/** Resolve a recut source by stable id first, then by canonical/original media path. */
function recutMaterial(doc, identity) {
  const index = materialIndex(doc);
  const exact = index.get(identity)?.value;
  if (exact) return exact;
  const desired = canonicalMediaPath(identity);
  if (!desired) return null;
  for (const value of doc.materials?.videos || []) {
    if (materialMediaPaths(value).includes(desired)) return value;
  }
  return null;
}

function recutProbeDuration(media, context = {}) {
  if (typeof context.mediaDurationProbe === 'function') {
    const value = Number(context.mediaDurationProbe(media));
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  try {
    const output = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', media
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const seconds = Number(String(output).trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000_000) : null;
  } catch {
    return null;
  }
}

function recutIsPrincipalContent(doc, segment) {
  if (!segment || String(segment.desc || '').startsWith('layout:')) return false;
  const material = recutMaterial(doc, segment.material_id);
  return !material || !material.type || material.type === 'video';
}

function recutResolveTrack(doc, selector) {
  if (selector == null || selector === '') {
    const principal = principalTrack(doc);
    if (principal.track.flag === 0) recutFail('the principal track is the main/cover track.', 'MAIN_TRACK');
    return principal;
  }
  const text = String(selector);
  let found;
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    found = doc.tracks?.[index] ? { index, track: doc.tracks[index] } : null;
  } else {
    const matches = (doc.tracks || []).map((track, index) => ({ track, index }))
      .filter(entry => entry.track.name === text || entry.track.id === text);
    if (matches.length !== 1) recutFail('track selector matched ' + matches.length + ' tracks: ' + text, 'CUT_TRACK_AMBIGUOUS');
    found = matches[0];
  }
  if (!found || found.track.type !== 'video') recutFail('track ' + text + ' is not a video track.', 'BAD_TRACK');
  if (found.track.flag === 0) recutFail('the principal track cannot be the main/cover track.', 'MAIN_TRACK');
  return found;
}

function recutNormalizePlan(op, documentFps = null) {
  if (op.contract !== 'cut.recut.v1') recutFail('requires contract cut.recut.v1.', 'CUT_CONTRACT');
  if (!op.media || typeof op.media !== 'string') recutFail('media is required.', 'CUT_MEDIA_MISSING');
  if (!op.plan || typeof op.plan !== 'object' || !Array.isArray(op.plan.timeline)) {
    recutFail('plan.timeline is required.', 'CUT_PLAN_EMPTY');
  }
  if (!op.plan.timeline.length) recutFail('plan.timeline must not be empty.', 'CUT_PLAN_EMPTY');
  if (op.retimeAnchored !== true) recutFail('retimeAnchored must be true.', 'CUT_ANCHOR_POLICY');
  const preserve = new Set(op.preserve || []);
  for (const kind of ['broll', 'layout', 'sfx', 'music']) {
    if (!preserve.has(kind)) recutFail('preserve must include ' + kind + '.', 'CUT_PRESERVE_POLICY');
  }
  const media = path.resolve(op.media);
  if (op.plan.media && path.resolve(String(op.plan.media)) !== media) {
    recutFail('plan.media does not match media.', 'CUT_MEDIA_MISMATCH');
  }
  const requestedFps = op.plan.fps ?? op.fps ?? documentFps ?? RECUT_FPS;
  const fps = Number(requestedFps);
  if (!Number.isFinite(fps) || fps <= 0) recutFail('plan fps must be finite and positive.', 'CUT_PLAN_INVALID');
  if (documentFps != null && (!Number.isFinite(Number(documentFps))
      || Math.abs(fps - Number(documentFps)) > FPS_TOLERANCE)) {
    recutFail(`plan fps ${fps} does not match the project fps ${documentFps}.`, 'CUT_FPS_MISMATCH', {
      planFps: fps, projectFps: Number(documentFps)
    });
  }
  const timeline = [];
  const beats = new Set();
  for (const [index, item] of op.plan.timeline.entries()) {
    if (!item || typeof item !== 'object') recutFail('timeline entry ' + index + ' is not an object.');
    const beat = item.beat == null ? index : Number(item.beat);
    const itemBeats = item.beats == null ? [beat] : (Array.isArray(item.beats) ? item.beats.map(Number) : []);
    if (!Number.isInteger(beat) || !itemBeats.length || itemBeats[0] !== beat
        || itemBeats.some(value => !Number.isInteger(value) || value < 0 || beats.has(value))
        || new Set(itemBeats).size !== itemBeats.length) {
      recutFail('timeline beat ' + index + ' is missing or duplicated.', 'CUT_PLAN_AMBIGUOUS');
    }
    for (const value of itemBeats) beats.add(value);
    const targetStart = recutFrameTime(item.tl_in, 'timeline[' + index + '].tl_in', fps);
    const targetEnd = recutFrameTime(item.tl_out, 'timeline[' + index + '].tl_out', fps);
    const targetDuration = targetEnd - targetStart;
    const declaredDuration = recutFrameTime(item.dur, 'timeline[' + index + '].dur', fps);
    const sourceStart = recutFrameTime(item.src_in, 'timeline[' + index + '].src_in', fps);
    const sourceDuration = recutFrameTime(item.src_dur ?? item.source_duration ?? item.dur,
      'timeline[' + index + '].source duration', fps);
    if (!(targetDuration > 0) || Math.abs(targetDuration - declaredDuration) > RECUT_TOLERANCE_US) {
      recutFail('timeline[' + index + '] has inconsistent target duration.', 'CUT_PLAN_INVALID');
    }
    if (Math.abs(sourceDuration - targetDuration) > RECUT_TOLERANCE_US) {
      recutFail('timeline[' + index + '] is not 1x.', 'CUT_PRINCIPAL_SPEED', {
        targetDuration, sourceDuration
      });
    }
    const sourceEnd = sourceStart + sourceDuration;
    timeline.push({
      index, beat, beats: itemBeats, targetStart, targetEnd, targetDuration,
      sourceStart, sourceEnd, sourceDuration, text: item.text || ''
    });
  }
  const validateDeclaredBeatList = (value, field) => {
    if (!Array.isArray(value)) recutFail(field + ' must be an array of integer beat ids.', 'CUT_PLAN_INVALID');
    const seen = new Set();
    for (const beat of value) {
      if (!Number.isInteger(beat) || beat < 0 || seen.has(beat)) {
        recutFail(field + ' contains a duplicate or invalid beat id.', 'CUT_PLAN_AMBIGUOUS', { field, beat });
      }
      seen.add(beat);
    }
    return value;
  };
  const declaredKept = op.plan.kept == null ? null : validateDeclaredBeatList(op.plan.kept, 'plan.kept');
  const declaredOrder = op.plan.order == null ? null : validateDeclaredBeatList(op.plan.order, 'plan.order');
  const sameBeatSet = (left, right) => left.length === right.length
    && left.every(beat => right.includes(beat));
  const timelineBeats = timeline.flatMap(item => item.beats);
  if (declaredKept && !sameBeatSet(declaredKept, timelineBeats)) {
    recutFail('plan.kept must match the beats present in plan.timeline.', 'CUT_PLAN_AMBIGUOUS', {
      kept: declaredKept, timeline: timelineBeats
    });
  }
  if (declaredOrder && (!sameBeatSet(declaredOrder, timelineBeats)
      || declaredOrder.some((beat, index) => beat !== timelineBeats[index]))) {
    recutFail('plan.order must be an exact permutation in the same order as plan.timeline.', 'CUT_PLAN_AMBIGUOUS', {
      order: declaredOrder, timeline: timelineBeats
    });
  }
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (i && item.targetStart < timeline[i - 1].targetEnd - RECUT_TOLERANCE_US) {
      recutFail('timeline target ranges overlap or are out of order.', 'CUT_PLAN_AMBIGUOUS');
    }
    if (i && Math.abs(item.targetStart - timeline[i - 1].targetEnd) > RECUT_TOLERANCE_US) {
      recutFail('timeline target ranges must be packed from zero.', 'CUT_PLAN_GAP');
    }
    if (!i && item.targetStart > RECUT_TOLERANCE_US) recutFail('timeline must start at zero.', 'CUT_PLAN_GAP');
  }
  const sourceOrder = [...timeline].sort((a, b) => a.sourceStart - b.sourceStart);
  for (let i = 1; i < sourceOrder.length; i++) {
    if (sourceOrder[i].sourceStart < sourceOrder[i - 1].sourceEnd - RECUT_TOLERANCE_US) {
      recutFail('timeline source ranges overlap.', 'CUT_PLAN_AMBIGUOUS');
    }
  }
  const duration = recutFrameTime(op.plan.duration, 'plan.duration', fps);
  const end = timeline.at(-1).targetEnd;
  if (Math.abs(duration - end) > RECUT_TOLERANCE_US) recutFail('plan.duration does not match timeline.', 'CUT_PLAN_INVALID');

  const blocking = [
    ...(Array.isArray(op.plan.blocking_lint) ? op.plan.blocking_lint : []),
    ...(Array.isArray(op.plan.lint) ? op.plan.lint.filter(item => item?.code === 'FIRST_WORD_CLIPPED') : [])
  ];
  if (blocking.length) recutFail('the supplied plan has blocking lint findings.', 'CUT_PLAN_BLOCKED', { findings: blocking });
  if (Array.isArray(op.plan.lint) && op.plan.lint.length && !op.force) {
    recutFail('the supplied plan has lint findings; pass --force to apply it.', 'CUT_PLAN_LINT', { findings: op.plan.lint });
  }
  const ramps = Array.isArray(op.audioRamps) ? op.audioRamps : [];
  for (const [index, ramp] of ramps.entries()) {
    if (!ramp || !Number.isFinite(Number(ramp.in)) || !Number.isFinite(Number(ramp.out))
        || Number(ramp.in) < 0 || Number(ramp.out) < 0) {
      recutFail('audioRamps[' + index + '] has invalid in/out values.', 'CUT_AUDIO_RAMP');
    }
  }
  return { media, fps, timeline, duration, ramps };
}

function recutOldMap(doc, principal) {
  const entries = (principal.track.segments || [])
    .filter(segment => recutIsPrincipalContent(doc, segment))
    .map(segment => {
      const target = segment.target_timerange;
      const source = segment.source_timerange;
      if (!target || !source || !(target.duration > 0) || !(source.duration > 0)) {
        recutFail('principal segment ' + (segment.id || '<unknown>') + ' has no usable source/target window.', 'CUT_PRINCIPAL_INVALID');
      }
      return {
        segment,
        targetStart: target.start,
        targetEnd: target.start + target.duration,
        targetDuration: target.duration,
        sourceStart: source.start,
        sourceEnd: source.start + source.duration,
        sourceDuration: source.duration
      };
    })
    .sort((a, b) => a.targetStart - b.targetStart);
  if (!entries.length) recutFail('principal track has no A-roll segments.', 'CUT_PRINCIPAL_EMPTY');
  if (entries[0].targetStart > RECUT_GAP_TOLERANCE_US) recutFail('principal A-roll does not start at zero.', 'CUT_PRINCIPAL_INVALID');
  if (entries[0].targetStart < -RECUT_TOLERANCE_US) recutFail('principal A-roll starts before zero.', 'CUT_PRINCIPAL_INVALID');
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].targetStart < entries[i - 1].targetEnd - RECUT_TOLERANCE_US) {
      recutFail('principal A-roll target ranges overlap.', 'CUT_PRINCIPAL_AMBIGUOUS');
    }
    if (entries[i].targetStart - entries[i - 1].targetEnd > RECUT_GAP_TOLERANCE_US) {
      recutFail('principal A-roll has an unmapped timeline gap.', 'CUT_PRINCIPAL_INVALID');
    }
  }
  const sourceOrder = [...entries].sort((a, b) => a.sourceStart - b.sourceStart);
  for (let i = 1; i < sourceOrder.length; i++) {
    if (sourceOrder[i].sourceStart < sourceOrder[i - 1].sourceEnd - RECUT_TOLERANCE_US) {
      recutFail('principal A-roll source ranges overlap.', 'CUT_PRINCIPAL_AMBIGUOUS');
    }
  }
  if (entries.some(item => item.sourceStart < 0 || item.targetStart < 0)) {
    recutFail('principal A-roll has a negative source or target window.', 'CUT_PRINCIPAL_INVALID');
  }
  return entries;
}

function recutSourceAt(old, timelineTime) {
  return old.sourceStart + (timelineTime - old.targetStart) * old.sourceDuration / old.targetDuration;
}

function recutTargetAt(next, sourceTime) {
  return next.targetStart + (sourceTime - next.sourceStart) * next.targetDuration / next.sourceDuration;
}

function recutFindTarget(oldMap, value) {
  return oldMap.find(item => value >= item.targetStart - RECUT_TOLERANCE_US
    && value < item.targetEnd - RECUT_TOLERANCE_US);
}

function recutFindSource(plan, value) {
  return plan.find((item, index) => value >= item.sourceStart - RECUT_TOLERANCE_US
    && (value < item.sourceEnd - RECUT_TOLERANCE_US || (index === plan.length - 1 && value <= item.sourceEnd + RECUT_TOLERANCE_US)));
}

function recutAnchorPieces(segment, oldMap, nextPlan) {
  const target = segment.target_timerange;
  if (!target || !(target.duration > 0)) recutFail('anchor ' + (segment.id || '<unknown>') + ' has no target window.', 'CUT_ANCHOR_INVALID');
  const source = segment.source_timerange;
  if (source && (!Number.isFinite(source.start) || !Number.isFinite(source.duration)
      || source.start < 0 || source.duration <= 0)) {
    recutFail('anchor ' + (segment.id || '<unknown>') + ' has an invalid source window.', 'CUT_ANCHOR_INVALID');
  }
  const start = target.start;
  const end = target.start + target.duration;
  const boundaries = [start, end];
  for (const old of oldMap) {
    if (old.targetStart > start && old.targetStart < end) boundaries.push(old.targetStart);
    if (old.targetEnd > start && old.targetEnd < end) boundaries.push(old.targetEnd);
    for (const next of nextPlan) {
      for (const sourceBoundary of [next.sourceStart, next.sourceEnd]) {
        const mapped = old.targetStart + (sourceBoundary - old.sourceStart) * old.targetDuration / old.sourceDuration;
        if (mapped > start && mapped < end) boundaries.push(mapped);
      }
    }
  }
  const cuts = [...new Set(boundaries.map(value => Math.round(value)))].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const oldStart = cuts[i], oldEnd = cuts[i + 1];
    if (!(oldEnd > oldStart)) continue;
    const midpoint = oldStart + (oldEnd - oldStart) / 2;
    const old = recutFindTarget(oldMap, midpoint);
    if (!old) {
      pieces.push({ oldStart, oldEnd, newStart: oldStart, newEnd: oldEnd, mapped: false });
      continue;
    }
    const sourceMid = recutSourceAt(old, midpoint);
    const next = recutFindSource(nextPlan, sourceMid);
    if (!next) continue;
    const sourceStart = recutSourceAt(old, oldStart);
    const sourceEnd = recutSourceAt(old, oldEnd);
    pieces.push({
      oldStart, oldEnd,
      newStart: recutTargetAt(next, sourceStart),
      newEnd: recutTargetAt(next, sourceEnd),
      mapped: true
    });
  }
  const merged = [];
  for (const piece of pieces) {
    const previous = merged.at(-1);
    if (previous && previous.mapped === piece.mapped
        && previous.oldEnd === piece.oldStart
        && Math.abs(previous.newEnd - piece.newStart) <= RECUT_TOLERANCE_US) {
      previous.oldEnd = piece.oldEnd;
      previous.newEnd = piece.newEnd;
    } else merged.push({ ...piece });
  }
  return merged;
}

function recutChooseTemplate(planItem, oldMap) {
  const matches = oldMap
    .map(old => ({ old, overlap: Math.max(0, Math.min(old.sourceEnd, planItem.sourceEnd) - Math.max(old.sourceStart, planItem.sourceStart)) }))
    .filter(item => item.overlap > RECUT_TOLERANCE_US);
  if (!matches.length) recutFail('plan source window has no corresponding principal source.', 'CUT_SOURCE_UNMAPPED', { sourceStart: planItem.sourceStart, sourceEnd: planItem.sourceEnd });
  const best = Math.max(...matches.map(item => item.overlap));
  const winners = matches.filter(item => best - item.overlap <= RECUT_TOLERANCE_US);
  if (winners.length !== 1 || matches.length !== 1) {
    recutFail('a plan beat crosses multiple principal source windows.', 'CUT_PRINCIPAL_AMBIGUOUS', {
      sourceStart: planItem.sourceStart, sourceEnd: planItem.sourceEnd
    });
  }
  return winners[0].old;
}

function recutExplicitlyTiedToPrincipal(segment) {
  return segment?.source_tied_to_principal === true
    || segment?.tied_to_principal === true
    || segment?.principal_source === true
    || segment?.anchor_source === 'principal'
    || segment?.anchor_source === 'a-roll'
    || segment?.recut_source === 'a-roll'
    || segment?.source_map === 'principal';
}

function recutIsParked(segment, projectDir) {
  const range = preservedRange(projectDir);
  const target = segment?.target_timerange;
  return Boolean(range && target && Number.isFinite(target.start)
    && target.start >= range.start - RECUT_TOLERANCE_US);
}

function recutValidateAnchors(doc, principal, oldMap, plan, projectDir = null) {
  const mapped = [];
  for (const [trackIndex, track] of (doc.tracks || []).entries()) {
    for (const segment of track.segments || []) {
      if (track === principal.track && recutIsPrincipalContent(doc, segment)) continue;
      // Audio beds, SFX, and music are timeline assets by default. Mapping them through the
      // A-roll source map silently deletes or retimes unrelated sound; only an explicit
      // source_tied_to_principal marker opts them into source mapping. Parked template parts
      // are likewise kept on the timeline so recutPark can move them as a unit afterward.
      const material = recutMaterial(doc, segment.material_id);
      const audioLike = track.type === 'audio'
        || material?.type === 'audio'
        || /(?:^|[-_])(sfx|music)(?:$|[-_])/i.test(String(track.name || ''));
      const timelineAnchored = (audioLike && !recutExplicitlyTiedToPrincipal(segment))
        || recutIsParked(segment, projectDir);
      if (timelineAnchored) {
        mapped.push({ trackIndex, track, segment, pieces: null, timelineAnchored: true });
        continue;
      }
      const pieces = recutAnchorPieces(segment, oldMap, plan);
      mapped.push({ trackIndex, track, segment, pieces });
    }
  }
  return mapped;
}

function recutValidateRefs(doc, oldMap, anchors) {
  const index = materialIndex(doc);
  const segments = [
    ...oldMap.map(item => item.segment),
    ...anchors.map(item => item.segment)
  ];
  for (const segment of segments) {
    for (const ref of segment.extra_material_refs || []) {
      if (!index.has(ref)) recutFail('segment ' + segment.id + ' references missing extra ' + ref + '.', 'CUT_EXTRA_REF');
    }
  }
}

function recutStableSeed(op, plan) {
  if (op.__seed) return op.__seed;
  return 'cut.recut.v1|' + path.resolve(op.media || '') + '|'
    + plan.timeline.map(item => [(item.beats || [item.beat]).join(','), item.tl_in, item.tl_out, item.src_in, item.dur].join(':')).join('|');
}

function recutPushMaterial(doc, kind, value) {
  const values = ensureMaterialArray(doc, kind);
  const existing = values.find(item => item.id === value.id);
  if (existing) {
    if (stableJson(existing) !== stableJson(value)) {
      recutFail('generated material id ' + value.id + ' conflicts with existing data.', 'CUT_MATERIAL_CONFLICT');
    }
    return existing;
  }
  values.push(value);
  return value;
}

function recutCloneExtras(doc, template, segmentId, seed) {
  const index = materialIndex(doc);
  const refs = [];
  for (const [position, oldId] of (template.extra_material_refs || []).entries()) {
    const found = index.get(oldId);
    if (!found) recutFail('segment ' + template.id + ' references missing extra ' + oldId + '.', 'CUT_EXTRA_REF');
    const copied = clone(found.value);
    // The output segment/position is the stable logical identity. Including oldId here made
    // a retry clone the clone (A -> cut:extra:A -> cut:extra:cut:extra:A), accumulating refs
    // and eventually mutating a shared speed material. Every retimed/split output gets its
    // own copy, including speed, mask, and fade extras.
    copied.id = found.value?.type === 'audio_fade'
      ? seededId(seed, 'fade:' + segmentId)
      : seededId(seed, 'cut:extra:' + segmentId + ':' + position);
    if ('bind_segment_id' in copied && (copied.bind_segment_id === template.id || copied.bind_segment_id === '')) {
      copied.bind_segment_id = segmentId;
    }
    refs.push(recutPushMaterial(doc, found.kind, copied).id);
  }
  return refs;
}

function recutSetSpeed(doc, segment, speed) {
  segment.speed = speed;
  for (const ref of segment.extra_material_refs || []) {
    for (const values of Object.values(doc.materials || {})) {
      if (!Array.isArray(values)) continue;
      const material = values.find(item => item?.id === ref && item.type === 'speed');
      if (material) {
        material.speed = speed;
        material.mode = 0;
        material.curve_speed = null;
      }
    }
  }
}

function recutDetachSpeedMaterials(doc, original, segment, seed) {
  const index = materialIndex(doc);
  const refs = clone(segment.extra_material_refs || []);
  for (const [position, ref] of refs.entries()) {
    const found = index.get(ref);
    if (!found || found.value?.type !== 'speed') continue;
    const copied = clone(found.value);
    // Do not key this by the old ref: the first recut replaces that ref, and a retry must
    // resolve to the same detached material instead of accumulating one speed per retry.
    copied.id = seededId(seed, 'cut:speed:' + segment.id + ':' + position);
    refs[position] = recutPushMaterial(doc, found.kind, copied).id;
  }
  segment.extra_material_refs = refs;
}

function recutFilterRebaseKeyframes(segment, oldSource, newSource, keepSource = null) {
  segment.keyframe_refs = clone(segment.keyframe_refs || []);
  if (!oldSource || !newSource || !(oldSource.duration > 0)) {
    segment.common_keyframes = clone(segment.common_keyframes || []);
    return;
  }
  const keepStart = Math.max(oldSource.start, keepSource?.start ?? oldSource.start);
  const keepEnd = Math.min(oldSource.start + oldSource.duration,
    (keepSource?.start ?? oldSource.start) + (keepSource?.duration ?? oldSource.duration));
  const keepDuration = keepEnd - keepStart;
  if (!(keepDuration > 0)) {
    segment.common_keyframes = [];
    return;
  }
  const nextGroups = [];
  for (const group of segment.common_keyframes || []) {
    const sourceList = Array.isArray(group.keyframe_list) ? group.keyframe_list : [];
    const timed = sourceList.filter(keyframe => Number.isFinite(Number(keyframe?.time_offset)));
    // Unknown keyframe shapes are preserved as cloned data. Known timed points are filtered
    // to the piece and rebased into its new absolute source window.
    const keyframeList = timed.length
      ? timed.filter(keyframe => Number(keyframe.time_offset) >= keepStart - RECUT_TOLERANCE_US
          && Number(keyframe.time_offset) <= keepEnd + RECUT_TOLERANCE_US)
        .map(keyframe => ({
          ...clone(keyframe),
          time_offset: Math.max(newSource.start,
            Math.min(newSource.start + newSource.duration,
              newSource.start + Math.round((Number(keyframe.time_offset) - keepStart)
                * newSource.duration / keepDuration)))
        }))
      : clone(sourceList);
    if (keyframeList.length) nextGroups.push({ ...clone(group), keyframe_list: keyframeList });
  }
  segment.common_keyframes = nextGroups;
}

function recutBuildPrincipal(doc, old, planItem, material, seed, usedIds) {
  const segment = clone(old.segment);
  let id = old.segment.id;
  if (usedIds.has(id)) id = seededId(seed, 'cut:principal:' + planItem.index + ':' + planItem.beat);
  usedIds.add(id);
  segment.id = id;
  segment.material_id = material.id;
  segment.target_timerange = { start: planItem.targetStart, duration: planItem.targetDuration };
  segment.source_timerange = { start: planItem.sourceStart, duration: planItem.sourceDuration };
  segment.render_timerange = segment.render_timerange
    ? { ...segment.render_timerange, start: planItem.targetStart, duration: planItem.targetDuration }
    : segment.render_timerange;
  segment.extra_material_refs = recutCloneExtras(doc, old.segment, id, seed);
  segment.common_keyframes = clone(old.segment.common_keyframes || []);
  recutFilterRebaseKeyframes(segment, old.segment.source_timerange, segment.source_timerange, {
    start: planItem.sourceStart,
    duration: planItem.sourceDuration,
  });
  recutSetSpeed(doc, segment, 1);
  return segment;
}

function recutRewriteAnchor(doc, original, piece, pieceIndex, seed) {
  const segment = clone(original);
  const target = original.target_timerange;
  const source = original.source_timerange;
  const targetDuration = piece.newEnd - piece.newStart;
  segment.id = pieceIndex === 0 ? original.id : seededId(seed, 'cut:anchor:' + original.id + ':' + pieceIndex);
  segment.target_timerange = { start: Math.round(piece.newStart), duration: Math.round(targetDuration) };
  if (source && target?.duration > 0) {
    const from = (piece.oldStart - target.start) / target.duration;
    const to = (piece.oldEnd - target.start) / target.duration;
    const sourceStart = source.start + Math.round(source.duration * from);
    const sourceEnd = source.start + Math.round(source.duration * to);
    segment.source_timerange = { start: sourceStart, duration: Math.max(0, sourceEnd - sourceStart) };
    segment.speed = segment.target_timerange.duration > 0
      ? segment.source_timerange.duration / segment.target_timerange.duration : 1;
    recutFilterRebaseKeyframes(segment, source, segment.source_timerange, segment.source_timerange);
  } else {
    segment.keyframe_refs = clone(segment.keyframe_refs || []);
    segment.common_keyframes = clone(segment.common_keyframes || []);
  }
  if (segment.render_timerange?.duration) {
    segment.render_timerange.start = segment.target_timerange.start;
    segment.render_timerange.duration = segment.target_timerange.duration;
  }
  // Every retimed piece gets cloned extras, including piece zero. This prevents a split
  // segment from retaining a shared speed/fade/mask ref while still keeping the clone
  // deterministic across root/timeline mirrors and retries.
  segment.extra_material_refs = recutCloneExtras(doc, original, segment.id, seed);
  recutSetSpeed(doc, segment, segment.speed ?? 1);
  return segment;
}

function recutRamp(planItem, index, ramps, fps) {
  const matching = ramps.find(item => item?.at != null
    && Math.abs(Number(item.at) * 1_000_000 - planItem.targetStart) <= 1_000_000 / fps);
  const source = matching || ramps[index] || {};
  const fallback = 2 / fps;
  const fadeIn = source.in == null ? (source.in_frames == null ? fallback : Number(source.in_frames) / fps) : Number(source.in);
  const fadeOut = source.out == null ? (source.out_frames == null ? fallback : Number(source.out_frames) / fps) : Number(source.out);
  if (!Number.isFinite(fadeIn) || !Number.isFinite(fadeOut) || fadeIn < 0 || fadeOut < 0) {
    recutFail('invalid audio ramp for beat ' + planItem.beat + '.', 'CUT_AUDIO_RAMP');
  }
  return { in: fadeIn, out: fadeOut };
}

function recutPark(doc, context, contentEnd, originalParkedIds = null) {
  const projectDir = context.projectDir;
  const range = preservedRange(projectDir);
  if (!range || !context.shared) return 0;
  if (!context.shared.preserved) {
    context.shared.preserved = {
      file: path.join(projectDir, SIDECAR_RELATIVE),
      created: createdMetadata(projectDir),
      window: range,
      total: 0,
      parkedIds: originalParkedIds ? [...originalParkedIds] : null,
    };
  }
  const state = context.shared.preserved;
  if (!state.created || !state.window) return 0;
  if (state.parkedIds == null && originalParkedIds) state.parkedIds = [...originalParkedIds];
  if (state.recutDelta === undefined) {
    const currentStart = state.window.start + (state.total || 0);
    const desiredStart = contentEnd + PRESET_PARK_GAP_US;
    state.recutDelta = desiredStart > currentStart + RECUT_TOLERANCE_US ? desiredStart - currentStart : 0;
    if (state.recutDelta) {
      state.total = (state.total || 0) + state.recutDelta;
      state.next = {
        start: state.window.start + state.total,
        end: state.window.end + state.total
      };
    }
    state.contentEnd = contentEnd;
  }
  const delta = state.recutDelta;
  if (delta) {
    const from = state.window.start + (state.total || 0) - delta;
    const parkedIds = new Set(state.parkedIds || []);
    const shifted = new Set();
    for (const track of doc.tracks || []) {
      for (const segment of track.segments || []) {
        if (parkedIds.size
          ? parkedIds.has(segment.id)
          : (segment.target_timerange?.start || 0) >= from) {
          segment.target_timerange.start += delta;
          if (segment.render_timerange?.duration) segment.render_timerange.start += delta;
          shifted.add(segment.id);
        }
      }
    }
    if (parkedIds.size) {
      const missing = [...parkedIds].filter(id => !shifted.has(id));
      if (missing.length) {
        recutFail('parked timeline no longer contains the preserved segment(s): ' + missing.join(', '), 'PARKED_TIMELINE_MISMATCH', { missing });
      }
      const misplaced = [...parkedIds].filter(id => {
        const entry = allSegments(doc).find(item => item.segment.id === id);
        return !entry || entry.segment.target_timerange.start < state.next.start - RECUT_TOLERANCE_US;
      });
      if (misplaced.length) {
        recutFail('parked timeline does not agree with its sidecar range.', 'PARKED_TIMELINE_MISMATCH', {
          ids: misplaced, expectedStart: state.next.start
        });
      }
    }
    doc.duration = Math.max(doc.duration || 0, maxSegmentEndUs(doc), state.next.end);
  }
  return delta;
}

function opCutRecut(doc, op, context = {}) {
  if (op.into && context.projectDir && path.resolve(op.into) !== path.resolve(context.projectDir)) {
    recutFail('into does not match the target project.', 'CUT_PROJECT_MISMATCH');
  }
  const normalized = recutNormalizePlan(op, doc.fps);
  const explicitTrack = op.track ?? op.plan.track;
  const principal = recutResolveTrack(doc, explicitTrack);
  const oldMap = recutOldMap(doc, principal);
  const templates = normalized.timeline.map(item => recutChooseTemplate(item, oldMap));
  const anchors = recutValidateAnchors(doc, principal, oldMap, normalized.timeline, context.projectDir);
  recutValidateRefs(doc, oldMap, anchors);
  const seed = recutStableSeed(op, normalized);
  const material = recutMaterial(doc, normalized.media);
  if (!context.dryRun && !fs.existsSync(normalized.media)) recutFail('media does not exist: ' + normalized.media, 'MISSING_SOURCE');
  const requiredSourceEnd = Math.max(...normalized.timeline.map(item => item.sourceEnd));
  const probedDuration = fs.existsSync(normalized.media) ? recutProbeDuration(normalized.media, context) : null;
  if (!context.dryRun && probedDuration == null) {
    recutFail('could not verify the duration of source media: ' + normalized.media, 'MEDIA_DURATION_UNKNOWN');
  }
  const sourceDuration = probedDuration ?? Number(material?.duration);
  if (!(sourceDuration > 0)) recutFail('source media has no verified duration.', 'MEDIA_DURATION_UNKNOWN');
  if (requiredSourceEnd > sourceDuration + RECUT_TOLERANCE_US) {
    recutFail('plan source exceeds the actual media duration.', 'SOURCE_AFTER_END', {
      requiredSourceEnd, mediaDuration: sourceDuration
    });
  }

  let sourceMaterial = material;
  let sourceMaterialNeedsPush = false;
  if (!sourceMaterial) {
    const templateMaterial = recutMaterial(doc, oldMap[0].segment.material_id);
    if (!templateMaterial) recutFail('principal material is missing.', 'MISSING_MATERIAL_SOURCE');
    sourceMaterial = clone(templateMaterial);
    sourceMaterial.id = seededId(seed, 'cut:material:' + normalized.media);
    sourceMaterial.type = 'video';
    sourceMaterial.path = normalized.media;
    sourceMaterial.material_name = path.basename(normalized.media);
    sourceMaterial.duration = sourceDuration;
    sourceMaterialNeedsPush = true;
  } else {
    if (sourceMaterial.type && sourceMaterial.type !== 'video') recutFail('media material is not video.', 'CUT_MEDIA_TYPE');
    // A localized/original material may already exist under the path, but its draft metadata
    // can be stale after replacing the file in place. Detach a verified-duration copy instead
    // of mutating a material shared by anchors or unrelated clips.
    if (probedDuration != null && (!Number.isFinite(sourceMaterial.duration)
        || Math.abs(sourceMaterial.duration - probedDuration) > RECUT_TOLERANCE_US)) {
      sourceMaterial = clone(sourceMaterial);
      sourceMaterial.id = seededId(seed, 'cut:material:' + normalized.media);
      sourceMaterial.path = normalized.media;
      sourceMaterial.material_name = path.basename(normalized.media);
      sourceMaterial.duration = probedDuration;
      sourceMaterialNeedsPush = true;
    }
  }

  const originalParkedIds = new Set();
  const parkedWindow = preservedRange(context.projectDir);
  if (parkedWindow) {
    for (const { segment } of allSegments(doc)) {
      if (segment.target_timerange?.start >= parkedWindow.start - RECUT_TOLERANCE_US) {
        originalParkedIds.add(segment.id);
      }
    }
  }
  const before = new Map((doc.tracks || []).map(track => [track, clone(track.segments || [])]));
  const usedIds = new Set();
  const principalSegments = [];
  for (let i = 0; i < normalized.timeline.length; i++) {
    principalSegments.push(recutBuildPrincipal(doc, templates[i], normalized.timeline[i], sourceMaterial, seed, usedIds));
  }

  if (sourceMaterialNeedsPush) recutPushMaterial(doc, 'videos', sourceMaterial);
  const dropped = [];
  const partialDropped = [];
  let retimed = 0;
  let split = 0;
  const replacementById = new Map();
  for (const anchor of anchors) {
    if (anchor.timelineAnchored) {
      replacementById.set(anchor.segment.id, [clone(anchor.segment)]);
      continue;
    }
    const pieces = anchor.pieces || [];
    const kept = pieces.filter(piece => piece.newEnd > piece.newStart);
    if (!kept.length) {
      dropped.push(anchor.segment.id);
      replacementById.set(anchor.segment.id, []);
      continue;
    }
    if (kept.length > 1) split++;
    if (pieces.some(piece => !piece.mapped)) partialDropped.push(anchor.segment.id);
    const rewritten = kept.map((piece, index) => {
      if (piece.newStart !== piece.oldStart || piece.newEnd - piece.newStart !== piece.oldEnd - piece.oldStart) retimed++;
      return recutRewriteAnchor(doc, anchor.segment, piece, index, seed);
    });
    replacementById.set(anchor.segment.id, rewritten);
  }
  const contentEnd = normalized.duration;
  for (const track of doc.tracks || []) {
    const original = before.get(track) || [];
    if (track === principal.track) {
      const preserved = original.filter(segment => !recutIsPrincipalContent(doc, segment))
        .flatMap(segment => replacementById.get(segment.id) || []);
      track.segments = [...principalSegments, ...preserved];
    } else {
      track.segments = original.flatMap(segment => {
        const replacement = replacementById.get(segment.id);
        return replacement || [segment];
      });
    }
    track.segments.sort((a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0));
  }
  // Parking must be the final positional operation. Running it against the pre-reconstruction
  // clone and then assigning that clone back was the source of the sidecar/timeline split.
  const parkedDeltaUs = recutPark(doc, context, contentEnd, originalParkedIds);
  for (const segment of principalSegments) {
    const ramp = recutRamp(normalized.timeline[principalSegments.indexOf(segment)], principalSegments.indexOf(segment),
      normalized.ramps, normalized.fps);
    opClipFade(doc, { op: 'clip.fade', selector: { id: segment.id }, in: ramp.in, out: ramp.out, __seed: seed });
  }
  renumberTracks(doc);
  doc.duration = Math.max(doc.duration || 0, normalized.duration, maxSegmentEndUs(doc));
  return {
    changed: principalSegments.length + retimed + split + dropped.length,
    operation: 'cut.recut',
    contract: 'cut.recut.v1',
    track: principal.index,
    trackId: principal.track.id,
    principal: {
      before: oldMap.length,
      after: principalSegments.length,
      durationUs: normalized.duration,
      speed: 1
    },
    anchors: { retimed, split, dropped, partialDropped },
    audioRamps: principalSegments.length,
    parkedDeltaUs
  };
}

export function applyOperations(doc, operations, context) {
  const results = [];
  for (const [index, op] of (operations || []).entries()) {
    if (!op?.op) throw new CapcutError(`Operation ${index} is missing \"op\".`, { code: 'BAD_OPERATION' });
    if (Array.isArray(op.documents)) {
      const kind = context.group.startsWith('timeline:') ? 'timeline' : context.group;
      if (!op.documents.includes(context.group) && !op.documents.includes(kind)) {
        results.push({ index, op: op.op, changed: 0, skipped: true, reason: 'document_scope' });
        continue;
      }
    }
    let result;
    if (op.op === 'segment.patch') result = opSegmentPatch(doc, op);
    else if (op.op === 'segment.remove') result = opSegmentRemove(doc, op);
    else if (op.op === 'segment.clone') result = opSegmentClone(doc, op);
    else if (op.op === 'mask.patch') result = opMaskPatch(doc, op);
    else if (op.op === 'material.relink') result = opMaterialRelink(doc, op, context);
    else if (op.op === 'material.clone') result = opMaterialClone(doc, op, context);
    else if (op.op === 'track.clone') result = opTrackClone(doc, op);
    else if (op.op === 'timeline.set') result = opTimelineSet(doc, op);
    else if (op.op === 'layout.apply') result = opLayoutApply(doc, op, context);
    else if (op.op === 'layout.background') result = opLayoutBackground(doc, op, context);
    else if (op.op === 'layout.broll') result = opLayoutBroll(doc, op, context);
    else if (op.op === SCREEN_LAYOUT_OPERATION) result = opLayoutScreen(doc, op, context);
    else if (op.op === 'cut.recut') result = opCutRecut(doc, op, context);
    else if (op.op === 'polish') result = opPolish(doc, op, context);
    else if (op.op === 'polish.callouts') result = opCalloutSfx(doc, op);
    else if (op.op === 'polish.interactions') result = opInteractions(doc, op, context);
    else if (op.op === 'pace') result = opPace(doc, op, context);
    else if (op.op === 'signature') result = opSignature(doc, op, context);
    else if (op.op === 'clip.add') result = opClipAdd(doc, op, context);
    else if (op.op === 'replace.media') result = opReplaceMedia(doc, op, context);
    else if (op.op === 'media.localize') result = opLocalizeAll(doc, op, context);
    else if (op.op === 'keyframe.scale') result = opScaleKeyframe(doc, op, context);
    else if (op.op === 'clip.shift') result = opClipShift(doc, op, context);
    else if (op.op === 'clip.trim') result = opClipTrim(doc, op, context);
    else if (op.op === 'clip.fade') result = opClipFade(doc, op, context);
    else if (op.op === 'music') result = opMusic(doc, op, context);
    else if (op.op === 'grade.apply') result = opGradeApply(doc, op, context);
    else throw new CapcutError(`Unsupported operation: ${op.op}`, { code: 'UNSUPPORTED_OPERATION' });
    results.push({ index, op: op.op, ...result });
  }
  return results;
}

const SIDECAR_RELATIVE = path.join('.capcutctl', 'created.json');

function snapshotFiles(projectDir) {
  const files = new Set();
  for (const group of documentGroups(projectDir)) for (const file of group.mirrors) if (fs.existsSync(file)) files.add(file);
  for (const relative of ['draft_meta_info.json', 'draft_virtual_store.json', 'Timelines/project.json', SIDECAR_RELATIVE]) {
    const file = path.join(projectDir, relative);
    if (fs.existsSync(file)) files.add(file);
  }
  return [...files];
}

export function createSnapshot(projectDir, label = 'snapshot') {
  const root = path.join(projectDir, '.capcutctl', 'history', `${nowStamp()}-${label.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  fs.mkdirSync(root, { recursive: true });
  const managed = documentGroups(projectDir).flatMap(group => group.mirrors);
  const sidecar = path.join(projectDir, SIDECAR_RELATIVE);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    projectDir,
    files: [],
    absent: [
      ...managed.filter(file => !fs.existsSync(file)).map(file => path.relative(projectDir, file)),
      ...(!fs.existsSync(sidecar) ? [SIDECAR_RELATIVE] : [])
    ]
  };
  for (const file of snapshotFiles(projectDir)) {
    const relative = path.relative(projectDir, file);
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
    manifest.files.push({ relative, sha256: sha256(fs.readFileSync(file)) });
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), stableJson(manifest));
  return root;
}

function restoreSnapshot(snapshotDir, destRoot = null) {
  const manifest = readJson(path.join(snapshotDir, 'manifest.json'));
  const root = destRoot || manifest.projectDir;
  for (const relative of manifest.absent || []) {
    const destination = path.join(root, relative);
    try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch {}
  }
  for (const item of manifest.files) {
    const source = path.join(snapshotDir, item.relative);
    const destination = path.join(root, item.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

export function listSnapshots(projectDir) {
  const history = path.join(projectDir, '.capcutctl', 'history');
  if (!fs.existsSync(history)) return [];
  return fs.readdirSync(history, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(history, entry.name, 'manifest.json')))
    .map(entry => {
      const snapshot = path.join(history, entry.name);
      const manifest = readJson(path.join(snapshot, 'manifest.json'));
      return { name: entry.name, path: snapshot, createdAt: manifest.createdAt, files: manifest.files?.length || 0 };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function fileIdentity(fileOrFd) {
  try {
    const stat = typeof fileOrFd === 'number' ? fs.fstatSync(fileOrFd) : fs.statSync(fileOrFd);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameFileIdentity(a, b) {
  const left = typeof a === 'object' ? a : fileIdentity(a);
  const right = typeof b === 'object' ? b : fileIdentity(b);
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

/**
 * Inspect capcutctl's project write lock without taking it. `stale` means the lock can be
 * safely reclaimed by the transactional writer; `locked` means another live owner remains.
 */
export function projectLockStatus(projectDir, { pidProbe = pidAlive } = {}) {
  const file = path.resolve(projectDir, '.capcutctl', 'write.lock');
  const base = {
    path: file,
    owner: null,
    ownerPid: null,
    ownerToken: null,
    startedAt: null,
    identity: fileIdentity(file),
    stale: false,
    ownedByCurrentProcess: false,
  };
  if (!fs.existsSync(file)) return { ...base, locked: false, status: 'unlocked' };

  let value;
  try {
    value = readJson(file);
  } catch (error) {
    return {
      ...base,
      // A partially written lock is not evidence that the owner is dead. Treat it as
      // live/unknown so a concurrent writer cannot reclaim it while its owner is starting.
      locked: true,
      stale: false,
      status: 'invalid',
      error: error.message,
    };
  }
  const pid = Number(value?.pid);
  const validPid = Number.isInteger(pid) && pid > 0;
  let alive = false;
  try {
    alive = validPid && Boolean(pidProbe(pid));
  } catch (error) {
    return {
      ...base,
      locked: true,
      stale: false,
      status: 'unknown',
      owner: { pid: validPid ? pid : value?.pid ?? null, startedAt: value?.startedAt ?? null, alive: null },
      ownerPid: validPid ? pid : value?.pid ?? null,
      ownerToken: value?.ownerToken ?? null,
      startedAt: value?.startedAt ?? null,
      error: error.message,
    };
  }
  if (!validPid) {
    return {
      ...base,
      locked: true,
      stale: false,
      status: 'invalid',
      owner: { pid: value?.pid ?? null, startedAt: value?.startedAt ?? null, alive: null },
      ownerPid: value?.pid ?? null,
      ownerToken: value?.ownerToken ?? null,
      startedAt: value?.startedAt ?? null,
    };
  }
  const owner = {
    pid: validPid ? pid : value?.pid ?? null,
    startedAt: value?.startedAt ?? null,
    alive,
  };
  const ownedByCurrentProcess = validPid && pid === process.pid;
  const stale = !alive;
  return {
    path: file,
    identity: base.identity,
    locked: !stale,
    status: stale ? 'stale' : ownedByCurrentProcess ? 'owned' : 'locked',
    owner,
    ownerPid: owner.pid,
    ownerToken: value?.ownerToken ?? null,
    startedAt: owner.startedAt,
    alive,
    stale,
    ownedByCurrentProcess,
  };
}

export const getProjectLockStatus = projectLockStatus;
export const lockStatus = projectLockStatus;

function lockOwner(token = uuid()) {
  return { pid: process.pid, ownerToken: token, startedAt: new Date().toISOString() };
}

function writeLockOwner(fd, owner) {
  const data = Buffer.from(stableJson(owner));
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, data, 0, data.length, 0);
  fs.fsyncSync(fd);
}

function lockHandle(file, fd, owner, reclaim = null) {
  return {
    file,
    fd,
    token: owner.ownerToken,
    identity: fileIdentity(fd),
    reclaim,
  };
}

function releaseReclaimGate(gate) {
  if (!gate) return;
  try { fs.closeSync(gate.fd); } catch {}
  if (sameFileIdentity(gate.file, gate.identity)) {
    try { fs.unlinkSync(gate.file); } catch {}
  }
}

function lockError(file, status) {
  return new CapcutError(`Another capcutctl write is active: ${file}`, {
    code: 'LOCKED',
    exitCode: 4,
    details: status,
  });
}

/**
 * Take over a stale lock without unlinking its pathname. The reclaim gate serializes
 * reclaimers; the lock file itself is rewritten through the already-existing inode while
 * normal contenders are still excluded by O_EXCL. This closes the stale-check/unlink race.
 */
function reclaimStaleLock(projectDir, file, staleStatus) {
  const gateFile = `${file}.reclaim`;
  let gateFd;
  try {
    gateFd = fs.openSync(gateFile, 'wx');
    const gateOwner = lockOwner();
    writeLockOwner(gateFd, gateOwner);
    const gate = { file: gateFile, fd: gateFd, identity: fileIdentity(gateFd) };
    let lockFd = null;
    let acquired = false;
    try {
      lockFd = fs.openSync(file, 'r+');
      const identity = fileIdentity(lockFd);
      if (!sameFileIdentity(identity, staleStatus.identity)) {
        throw lockError(file, { ...staleStatus, status: 'replaced' });
      }
      let latest;
      try {
        latest = JSON.parse(fs.readFileSync(lockFd, 'utf8'));
      } catch (error) {
        throw lockError(file, { ...staleStatus, status: 'invalid', stale: false, error: error.message });
      }
      const pid = Number(latest?.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        throw lockError(file, { ...staleStatus, status: 'invalid', stale: false });
      }
      let alive;
      try { alive = pidAlive(pid); }
      catch (error) { throw lockError(file, { ...staleStatus, status: 'unknown', stale: false, error: error.message }); }
      if (alive) throw lockError(file, { ...staleStatus, status: 'locked', stale: false, ownerPid: pid });

      const owner = lockOwner();
      writeLockOwner(lockFd, owner);
      acquired = true;
      return lockHandle(file, lockFd, owner, gate);
    } catch (error) {
      if (lockFd != null && !acquired) try { fs.closeSync(lockFd); } catch {}
      throw error;
    } finally {
      if (!acquired) releaseReclaimGate(gate);
    }
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw lockError(file, { ...staleStatus, status: 'reclaiming', locked: true, stale: false });
    }
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function acquireLock(projectDir, retried = false) {
  const dir = path.join(projectDir, '.capcutctl');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'write.lock');
  const owner = lockOwner();
  try {
    const fd = fs.openSync(file, 'wx');
    const identity = fileIdentity(fd);
    try {
      writeLockOwner(fd, owner);
      return lockHandle(file, fd, owner);
    } catch (error) {
      try { fs.closeSync(fd); } catch {}
      if (sameFileIdentity(file, identity)) try { fs.unlinkSync(file); } catch {}
      throw error;
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const status = projectLockStatus(projectDir);
    if (status.stale && !retried) {
      const reclaimed = reclaimStaleLock(projectDir, file, status);
      if (reclaimed) return reclaimed;
      return acquireLock(projectDir, true);
    }
    throw lockError(file, status);
  }
}

function releaseLock(lock) {
  // Remove the reclaim gate while the lock inode is still ours. A future writer cannot
  // mistake a live replacement lock for the gate owned by this transaction.
  releaseReclaimGate(lock?.reclaim);
  let sameOwner = false;
  const sameIdentity = sameFileIdentity(lock.file, lock.identity);
  if (sameIdentity) {
    try { sameOwner = readJson(lock.file).ownerToken === lock.token; } catch {}
    if (sameOwner) try { fs.unlinkSync(lock.file); } catch {}
  }
  try { fs.closeSync(lock.fd); } catch {}
}

function stageWrites(writes, transactionId) {
  const staged = [];
  for (const write of writes) {
    fs.mkdirSync(path.dirname(write.file), { recursive: true });
    const temp = `${write.file}.capcutctl-${transactionId}.tmp`;
    const fd = fs.openSync(temp, 'w');
    fs.writeFileSync(fd, write.data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    readJson(temp);
    staged.push({ ...write, temp });
  }
  return staged;
}

function commitStaged(staged) {
  let writes = 0;
  for (const item of staged) {
    fs.renameSync(item.temp, item.file);
    writes++;
    if (process.env.CAPCUTCTL_FAIL_AFTER_WRITES && writes >= Number(process.env.CAPCUTCTL_FAIL_AFTER_WRITES)) {
      throw new Error('Injected transaction failure.');
    }
  }
}

function cleanStaged(staged) {
  for (const item of staged || []) try { if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp); } catch {}
}

/**
 * Capture the exact bytes at every commit destination. This is deliberately independent of
 * the durable history snapshot: `--no-backup` still needs to recover if the second mirror
 * rename or a sidecar rename fails halfway through a transaction.
 */
function captureRollbackJournal(files) {
  const seen = new Set();
  return [...(files || [])].filter(file => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  }).map(file => {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) return { file: resolved, existed: false, data: null };
    return { file: resolved, existed: true, data: fs.readFileSync(resolved) };
  });
}

function restoreRollbackJournal(journal) {
  for (const item of journal || []) {
    if (item.existed) {
      fs.mkdirSync(path.dirname(item.file), { recursive: true });
      fs.writeFileSync(item.file, item.data);
    } else if (fs.existsSync(item.file)) {
      fs.unlinkSync(item.file);
    }
  }
}

function pendingSidecarRange(sidecarWrite, projectDir) {
  if (!sidecarWrite) return preservedRange(projectDir);
  try {
    const value = JSON.parse(String(sidecarWrite.data));
    const range = value?.preserved;
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
    return { start, end };
  } catch {
    return null;
  }
}

export function executeTransaction(projectDir, mutator, {
  dryRun = false,
  forceRunning = false,
  backup = true,
  label = 'edit',
  forceWriteAll = false,
  processProbe = null,
  extraWrites = null,
} = {}) {
  // A dry run writes nothing, so refusing it while CapCut is open cost a quit-and-relaunch
  // just to see a plan — and his loop is "look in CapCut, then edit". Reads can be torn by an
  // auto-save; that yields a parse error or a stale plan, never a damaged project.
  assertCapcutClosed({ forceRunning: forceRunning || dryRun, probe: processProbe || capcutProcess });
  // Dry runs intentionally remain write-free, including the lock directory. Real writes
  // acquire the project lock before the first project read and keep it through post-doctor.
  const lock = dryRun ? null : acquireLock(projectDir);
  let snapshot = null;
  let journal = null;
  let staged = [];
  let commitAttempted = false;
  try {
    const state = loadProject(projectDir);
    const working = state.groups.map(group => ({ ...group, doc: clone(group.doc) }));
    const result = mutator(working);
    const pendingWrites = typeof extraWrites === 'function'
      ? (extraWrites({ projectDir, state, working, result }) || [])
      : [];
    const sidecarWrite = pendingWrites.find(item => path.resolve(item.file) === path.resolve(projectDir, SIDECAR_RELATIVE));
    const parked = pendingSidecarRange(sidecarWrite, projectDir);
    const validation = working.flatMap(group => validateDocument(group.doc, {
      file: group.canonical,
      checkFiles: !dryRun,
      projectDir,
      parked,
      duplicateBaseline: knownPreset3DuplicateBaseline(projectDir),
    }));
    const errors = validation.filter(item => item.level === 'error');
    if (errors.length) throw new CapcutError(`Transaction failed validation with ${errors.length} error(s).`, { code: 'VALIDATION_FAILED', details: errors });
    const changedGroups = working.filter((group, index) => forceWriteAll || stableJson(group.doc) !== stableJson(state.groups[index].doc));
    const writes = [];
    for (const group of changedGroups) {
      const data = stableJson(group.doc);
      for (const file of group.mirrors) writes.push({ file, data });
    }
    for (const write of pendingWrites) {
      if (!write?.file || typeof write.data !== 'string') throw new CapcutError('Transaction extra write is invalid.', { code: 'BAD_TRANSACTION_WRITE' });
      const file = path.resolve(write.file);
      const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const data = Buffer.from(write.data);
      if (!current || !current.equals(data)) writes.push({ file, data: write.data });
    }
    const preview = {
      dryRun,
      project: projectDir,
      changedGroups: changedGroups.map(group => group.name),
      documents: changedGroups.map(group => group.canonical),
      changedFiles: writes.map(write => path.resolve(write.file)),
      durations: working.map(group => ({ name: group.name, ...durationInfo(group.doc, projectDir) })),
      result,
      validation
    };
    if (dryRun || !writes.length) return { ...preview, committed: false, snapshot: null };

    journal = captureRollbackJournal(writes.map(write => write.file));
    if (backup) snapshot = createSnapshot(projectDir, label);
    const transactionId = uuid();
    staged = stageWrites(writes, transactionId);
    commitAttempted = true;
    commitStaged(staged);
    const post = doctor(projectDir, { checkFiles: true });
    if (post.errors) throw new CapcutError(`Post-write validation found ${post.errors} errors.`, { code: 'POST_WRITE_VALIDATION', details: post.issues });
    return { ...preview, committed: true, snapshot, postDoctor: post };
  } catch (error) {
    let rollbackError = null;
    if (commitAttempted || snapshot) {
      if (snapshot) {
        try { restoreSnapshot(snapshot, projectDir); }
        catch (caught) { rollbackError = caught; }
      }
      if (journal) {
        try { restoreRollbackJournal(journal); }
        catch (caught) { rollbackError = rollbackError || caught; }
      }
    }
    if (!commitAttempted && !snapshot) throw error;
    const cause = error instanceof CapcutError
      ? { code: error.code, message: error.message, details: error.details }
      : { message: error?.message || String(error) };
    throw new CapcutError(`Transaction rolled back: ${error.message}`, {
      code: 'ROLLED_BACK',
      details: { snapshot, cause, ...(rollbackError ? { rollbackError: rollbackError.message } : {}) }
    });
  } finally {
    cleanStaged(staged);
    if (lock) releaseLock(lock);
  }
}

export function applySpec(projectDir, spec, options = {}) {
  if (spec.version !== 1) throw new CapcutError(`Unsupported spec version: ${spec.version}`, { code: 'SPEC_VERSION' });
  const operations = clone(spec.operations || []);
  for (const op of operations) {
    if (['segment.clone', 'material.clone', 'track.clone', 'clip.add'].includes(op.op) && !op.id) op.id = uuid();
    // Every op gets one, not a whitelist of ops. Each document in the group is edited
    // independently, so an op that mints ids must mint the SAME ids in each pass or the
    // mirrors drift apart. This was a per-op list and adding `signature` without adding it
    // here produced exactly that drift — silently, until doctor caught it.
    if (!op.__seed) {
      // These two operations are safe to retry only when their generated ids are stable.
      // Their CLI contracts carry no caller-generated id, and applyOperations runs once per
      // mirror, so a fresh UUID here would make a second identical invocation churn the draft.
      if (op.op === 'layout.screen') {
        op.__seed = ['layout.screen', op.media, op.at, op.duration, op.src, op.srcDur,
          JSON.stringify(op.selector || op.recordingSelector || null),
          JSON.stringify(op.pipSelector || null)].join('|');
      } else if (op.op === 'cut.recut') {
        op.__seed = ['cut.recut.v1', op.media,
          (op.plan?.timeline || []).map(item => [item.beat, item.tl_in, item.tl_out, item.src_in, item.dur].join(':')).join('|')].join('|');
      } else op.__seed = uuid();
    }
  }
  // One object shared by every op AND by both document passes. Endcard sliding needs it:
  // each op used to re-read created.json and measure from the ORIGINAL window, so two ops in
  // one spec slid the endcard twice.
  const shared = {};
  const tx = executeTransaction(projectDir, groups => groups.map(group => ({
    group: group.name,
    operations: applyOperations(group.doc, operations, {
      projectDir,
      group: group.name,
      shared,
      dryRun: Boolean(options.dryRun),
      mediaDurationProbe: options.mediaDurationProbe,
    })
  })), {
    ...options,
    label: options.label || spec.name || 'apply',
    extraWrites: () => {
      const state = shared?.preserved;
      if (!state?.file || !state.created || (!state.next && state.contentEnd == null)) return [];
      const created = clone(state.created);
      if (state.next) created.preserved = state.next;
      if (state.contentEnd != null) created.contentEnd = state.contentEnd;
      return [{ file: state.file, data: stableJson(created) }];
    },
  });
  return tx;
}

export function restoreProjectSnapshot(projectDir, snapshotNameOrPath, options = {}) {
  assertCapcutClosed({ forceRunning: options.forceRunning });
  const history = path.resolve(projectDir, '.capcutctl', 'history');
  const snapshotDir = path.resolve(snapshotNameOrPath.includes(path.sep) ? snapshotNameOrPath : path.join(history, snapshotNameOrPath));
  const relative = path.relative(history, snapshotDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CapcutError('Snapshot must be a named entry inside this project\'s .capcutctl/history directory.', { code: 'SNAPSHOT_SCOPE', exitCode: 2 });
  }
  const manifestFile = path.join(snapshotDir, 'manifest.json');
  const lock = acquireLock(projectDir);
  let rescue = null;
  let journal = null;
  try {
    // Do not inspect or load the snapshot until the project lock is held. A restore is a
    // write transaction too; otherwise a concurrent apply could read/change the same
    // mirrors between the preflight and this restore.
    if (!fs.existsSync(manifestFile)) {
      throw new CapcutError(`Snapshot not found: ${snapshotNameOrPath}`, { code: 'SNAPSHOT_NOT_FOUND', exitCode: 2 });
    }
    const manifest = readJson(manifestFile);
    journal = captureRollbackJournal([
      ...(manifest.files || []).map(item => path.join(projectDir, item.relative)),
      ...(manifest.absent || []).map(item => path.join(projectDir, item)),
    ]);
    if (options.backup !== false) rescue = createSnapshot(projectDir, options.label || 'before-restore');
    // Restore into THIS projectDir, not the absolute path baked into the manifest.
    // CapCut (and `mv`) rename draft folders; the snapshot already lives inside
    // `.capcutctl/history`, so pinning to the original path made every snapshot
    // unrestorable after a rename.
    restoreSnapshot(snapshotDir, projectDir);
    const post = doctor(projectDir, { checkFiles: true });
    if (post.errors) throw new CapcutError(`Restored snapshot has ${post.errors} validation error(s).`, { code: 'RESTORE_VALIDATION', details: post.issues });
    return { restored: snapshotDir, rescue, postDoctor: post };
  } catch (error) {
    if (rescue) restoreSnapshot(rescue, projectDir);
    if (journal) restoreRollbackJournal(journal);
    const cause = error instanceof CapcutError
      ? { code: error.code, message: error.message, details: error.details }
      : { message: error?.message || String(error) };
    throw new CapcutError(`Restore rolled back: ${error.message}`, { code: 'RESTORE_ROLLED_BACK', details: { rescue, cause } });
  } finally {
    releaseLock(lock);
  }
}

/**
 * CapCut re-saves a material under an id it already used, differing only in noise
 * (an audio_fade object, a crop corner of 0.9999999999999997). Structurally that is a
 * CONFLICTING_MATERIAL_ID error even though every copy points at the same file. Collapse
 * them — but only when they are the same LOGICAL material, so a genuine id collision
 * between two different clips is still reported rather than silently merged.
 */
function dedupeMaterials(doc) {
  const merged = [];
  for (const [kind, values] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    const seen = new Map();
    const keep = [];
    for (const value of values) {
      if (!value?.id) { keep.push(value); continue; }
      const prev = seen.get(value.id);
      if (!prev) { seen.set(value.id, value); keep.push(value); continue; }
      const same = ['path', 'width', 'height', 'duration', 'type', 'name']
        .every(k => JSON.stringify(prev[k]) === JSON.stringify(value[k]));
      if (same) merged.push({ kind, id: value.id });
      else keep.push(value);                       // a real collision: leave it for doctor
    }
    doc.materials[kind] = keep;
  }
  return merged;
}

export function syncMirrors(projectDir, options = {}) {
  const merged = [];
  const result = executeTransaction(projectDir, groups => {
    for (const group of groups) {
      group.doc = clone(group.doc);
      if (options.dedupe !== false) merged.push(...dedupeMaterials(group.doc).map(m => ({ ...m, group: group.name })));
    }
    return groups.map(group => ({ group: group.name, mirrors: group.mirrors }));
  }, { ...options, forceWriteAll: true, label: options.label || 'sync' });
  return { ...result, mergedDuplicateMaterials: merged.length, merged };
}

export function inspectProject(projectDir) {
  const state = loadProject(projectDir);
  const capcut = capcutStatus({ root: path.dirname(projectDir) });
  return {
    project: projectDir,
    activeTimelineId: state.activeTimelineId,
    capcut,
    groups: state.groups.map(group => ({
      name: group.name,
      file: group.canonical,
      duration: group.doc.duration,
      contentDuration: group.durations.contentDurationUs,
      editDuration: group.durations.editDurationUs,
      draftDuration: group.durations.draftDurationUs,
      durations: group.durations,
      fps: group.doc.fps,
      canvas: group.doc.canvas_config,
      tracks: (group.doc.tracks || []).map((track, index) => ({
        index, id: track.id, name: track.name || null, type: track.type,
        flag: track.flag ?? null, segments: track.segments?.length || 0
      })),
      materials: Object.fromEntries(Object.entries(group.doc.materials || {}).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]))
    }))
  };
}
