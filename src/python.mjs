/**
 * The Python runtime contract.
 *
 * `cut`, `qa` and `find` are Node front ends over the scripts in tools/. Those scripts are
 * not stdlib-only and they are not version-agnostic: aroll.py uses `itertools.pairwise`
 * (3.10+) and frame_qa.py imports NumPy and Pillow. Spawning whatever `python3` happens to
 * be first on PATH therefore fails on a stock macOS 3.9 with an import traceback that names
 * a line number instead of a fix.
 *
 * This module makes the contract explicit and testable: one declared floor, one declared
 * dependency set per tool, one resolution order, and named errors. Nothing here downloads,
 * installs, or mutates anything — it only looks.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapcutError } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.join(HERE, '..');

/** The floor. Matches pyproject's `requires-python` and ruff's `target-version`. */
export const MIN_PYTHON = Object.freeze([3, 11]);
export const MIN_PYTHON_TEXT = MIN_PYTHON.join('.');

/**
 * Third-party modules each shipped tool imports at module scope, keyed by import name.
 * Standard-library modules are deliberately absent — the version floor already covers them.
 * A module listed here is a hard requirement: the command cannot start without it, so we
 * check it before spawning rather than letting Python raise ModuleNotFoundError.
 *
 * find.py imports frame_qa lazily, and only for --strip. It stays out of the hard set so a
 * plain `find` keeps working on a machine with no NumPy; preflight still reports the gap.
 */
export const TOOL_IMPORTS = Object.freeze({
  'aroll.py': Object.freeze([]),
  'audio_index.py': Object.freeze([]),
  'find.py': Object.freeze([]),
  'frame_qa.py': Object.freeze(['numpy', 'PIL']),
  'rasterize.py': Object.freeze([]),
});

/** Every third-party module the package's Python side can need, and how to install it. */
export const RUNTIME_IMPORTS = Object.freeze(['numpy', 'PIL']);
export const DISTRIBUTION = Object.freeze({ numpy: 'numpy', PIL: 'pillow' });

/** Install line for a set of missing import names. */
export function installHint(missing) {
  const names = [...new Set(missing.map(name => DISTRIBUTION[name] || name))].sort();
  if (!names.length) return null;
  return `install the Python runtime dependencies: python3 -m pip install ${names.join(' ')}`
    + `  (or, from a clone: python3 -m pip install -e .)`;
}

const VERSION_PROBE = 'import json,sys;print(json.dumps({"v":list(sys.version_info[:3]),"x":sys.executable}))';

function atLeastMinimum(version) {
  const [major, minor] = version;
  if (major !== MIN_PYTHON[0]) return major > MIN_PYTHON[0];
  return minor >= MIN_PYTHON[1];
}

/**
 * Run one candidate and read its version back. Never throws: an interpreter that is absent,
 * is not executable, or is a broken shim is a `{ ok: false }` with a reason, so the caller
 * can keep looking and still report every candidate it rejected.
 */
export function probeInterpreter(candidate, { runner = spawnSync } = {}) {
  let result;
  try {
    result = runner(candidate, ['-c', VERSION_PROBE], { encoding: 'utf8', timeout: 15_000 });
  } catch (error) {
    return { ok: false, candidate, detail: `could not start (${error.code || error.message})` };
  }
  if (!result || result.error) {
    return { ok: false, candidate, detail: `could not start (${result?.error?.code || result?.error?.message || 'no result'})` };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().split('\n').pop() || `exited with status ${result.status}`;
    return { ok: false, candidate, detail: stderr };
  }
  let parsed;
  try { parsed = JSON.parse(String(result.stdout || '')); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.v)) {
    return { ok: false, candidate, detail: 'version probe returned no parsable output' };
  }
  const version = parsed.v.map(Number);
  const executable = typeof parsed.x === 'string' && parsed.x ? parsed.x : candidate;
  if (!atLeastMinimum(version)) {
    return {
      ok: false, candidate, executable, version,
      tooOld: true,
      detail: `Python ${version.join('.')} is older than the required ${MIN_PYTHON_TEXT}`,
    };
  }
  return { ok: true, candidate, executable, version };
}

function venvPython(root) {
  const posix = path.join(root, 'bin', 'python3');
  if (fs.existsSync(posix)) return posix;
  const posixAlt = path.join(root, 'bin', 'python');
  if (fs.existsSync(posixAlt)) return posixAlt;
  const windows = path.join(root, 'Scripts', 'python.exe');
  if (fs.existsSync(windows)) return windows;
  return null;
}

/**
 * The resolution order, most explicit first:
 *
 *   1. $CAPCUTCTL_PYTHON            — you said so. If it is unusable that is an error, not
 *                                     a reason to quietly run something else.
 *   2. <package>/.venv              — a project-managed environment, the documented setup.
 *   3. $VIRTUAL_ENV                 — an environment the user has already activated.
 *   4. python3.14 … python3.11      — a named, known-new-enough interpreter on PATH.
 *   5. python3, python              — ambient, and only if it clears the floor.
 */
export function pythonCandidates({ env = process.env, packageRoot = PACKAGE_ROOT } = {}) {
  const out = [];
  const push = (executable, source, chosen) => {
    if (executable) out.push({ executable, source, chosen });
  };
  // `chosen` candidates are a decision someone made; the first usable one wins outright.
  push(env.CAPCUTCTL_PYTHON, 'CAPCUTCTL_PYTHON', true);
  push(venvPython(path.join(packageRoot, '.venv')), 'project .venv', true);
  if (env.VIRTUAL_ENV) push(venvPython(env.VIRTUAL_ENV), '$VIRTUAL_ENV', true);
  // Ambient candidates are a guess, so they get the preference pass in resolvePython.
  for (let minor = 14; minor >= MIN_PYTHON[1]; minor -= 1) push(`python3.${minor}`, 'PATH', false);
  push('python3', 'PATH', false);
  push('python', 'PATH', false);
  return out;
}

let cached = null;

/**
 * Find the interpreter that `cut`, `qa` and `find` will actually use.
 *
 * Throws PYTHON_NOT_FOUND / PYTHON_TOO_OLD rather than returning a half-answer, so a caller
 * that forgets to check cannot spawn a 3.9 by accident.
 */
export function resolvePython({
  env = process.env,
  packageRoot = PACKAGE_ROOT,
  refresh = false,
  probe = probeInterpreter,
  imports = missingImports,
} = {}) {
  if (cached && !refresh) return cached;
  const rejected = [];
  const candidates = pythonCandidates({ env, packageRoot });
  const settle = resolved => {
    if (env === process.env && packageRoot === PACKAGE_ROOT) cached = resolved;
    return resolved;
  };
  const describe = (executable, source, result) => ({
    executable: result.executable || executable,
    invoked: executable,
    version: result.version,
    versionText: result.version.join('.'),
    source,
  });

  // Among the ambient guesses, an interpreter that can already import the runtime
  // dependencies beats a newer one that cannot. Otherwise `pip install -e .` under the
  // python3 you actually use loses to a bare python3.13 that happens to sort first.
  let fallback = null;

  for (const { executable, source, chosen } of candidates) {
    const result = probe(executable);
    if (!result.ok) {
      rejected.push({ executable, source, detail: result.detail, tooOld: Boolean(result.tooOld) });
      // An explicit override is a decision, not a suggestion. Do not walk past it.
      if (source === 'CAPCUTCTL_PYTHON') {
        throw new CapcutError(
          `CAPCUTCTL_PYTHON=${executable} is not usable: ${result.detail}`,
          {
            code: result.tooOld ? 'PYTHON_TOO_OLD' : 'PYTHON_NOT_FOUND',
            exitCode: 2,
            details: { required: `>=${MIN_PYTHON_TEXT}`, rejected },
          },
        );
      }
      continue;
    }

    const described = describe(executable, source, result);
    if (chosen) return settle(described);
    if (!fallback) fallback = described;
    if (imports(described.executable, RUNTIME_IMPORTS).length === 0) return settle(described);
  }

  if (fallback) return settle(fallback);

  const sawOld = rejected.some(entry => entry.tooOld);
  throw new CapcutError(
    sawOld
      ? `no Python >=${MIN_PYTHON_TEXT} found; the interpreters on PATH are too old`
      : `no Python >=${MIN_PYTHON_TEXT} found`,
    {
      code: sawOld ? 'PYTHON_TOO_OLD' : 'PYTHON_NOT_FOUND',
      exitCode: 2,
      details: {
        required: `>=${MIN_PYTHON_TEXT}`,
        rejected,
        fix: `install Python ${MIN_PYTHON_TEXT} or newer, or point CAPCUTCTL_PYTHON at one`,
      },
    },
  );
}

/** Forget the cached interpreter. Tests and `preflight --json` re-resolve from scratch. */
export function resetPythonCache() { cached = null; }

/** Which of `modules` this interpreter cannot import. One subprocess, not one each. */
export function missingImports(executable, modules, { runner = spawnSync } = {}) {
  const wanted = [...modules];
  if (!wanted.length) return [];
  const script = 'import importlib.util as u,json,sys;'
    + 'print(json.dumps([m for m in sys.argv[1:] if u.find_spec(m) is None]))';
  let result;
  try {
    result = runner(executable, ['-c', script, ...wanted], { encoding: 'utf8', timeout: 30_000 });
  } catch {
    return wanted;
  }
  if (!result || result.error || result.status !== 0) return wanted;
  try {
    const parsed = JSON.parse(String(result.stdout || ''));
    return Array.isArray(parsed) ? parsed : wanted;
  } catch {
    return wanted;
  }
}

/**
 * Resolve the interpreter for one tool and prove it can import what that tool needs.
 * This is what stands between a user and a ModuleNotFoundError traceback.
 */
export function pythonForTool(toolBasename, options = {}) {
  const resolved = resolvePython(options);
  const required = TOOL_IMPORTS[toolBasename] || [];
  const imports = options.imports || missingImports;
  const missing = imports(resolved.executable, required, options);
  if (missing.length) {
    throw new CapcutError(
      `${toolBasename} needs ${missing.join(', ')}, which ${resolved.executable} cannot import`,
      {
        code: 'PYTHON_MISSING_DEPENDENCY',
        exitCode: 2,
        details: { interpreter: resolved.executable, missing, fix: installHint(missing) },
      },
    );
  }
  return resolved;
}

/**
 * The preflight rows for the Python side. Kept here, next to the contract they test, so the
 * thing preflight probes is by construction the thing `cut`, `qa` and `find` will spawn —
 * not `python3`, and not a second guess at the resolution order.
 */
export function preflightPython(options = {}) {
  let resolved;
  try {
    resolved = resolvePython({ refresh: true, ...options });
  } catch (error) {
    return [{
      name: 'Python runtime',
      ok: false,
      detail: error.message,
      fix: error.details?.fix
        || `install Python ${MIN_PYTHON_TEXT} or newer, or set CAPCUTCTL_PYTHON to one`,
    }, {
      name: 'Python runtime dependencies',
      ok: false,
      detail: 'skipped because no supported interpreter was found',
      fix: `install Python ${MIN_PYTHON_TEXT}+ first, then ${installHint(RUNTIME_IMPORTS)}`,
    }];
  }

  const imports = options.imports || missingImports;
  const missing = imports(resolved.executable, RUNTIME_IMPORTS, options);
  return [{
    name: 'Python runtime',
    ok: true,
    detail: `Python ${resolved.versionText} at ${resolved.executable} (via ${resolved.source})`,
    interpreter: resolved.executable,
    version: resolved.versionText,
    source: resolved.source,
  }, {
    name: 'Python runtime dependencies',
    ok: missing.length === 0,
    detail: missing.length
      ? `${resolved.executable} cannot import ${missing.join(', ')} — qa, preview, review and \`find --strip\` need them`
      : `${RUNTIME_IMPORTS.join(', ')} importable`,
    fix: missing.length ? installHint(missing) : null,
    missing,
  }];
}
