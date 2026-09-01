import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MIN_PYTHON,
  MIN_PYTHON_TEXT,
  RUNTIME_IMPORTS,
  TOOL_IMPORTS,
  installHint,
  missingImports,
  preflightPython,
  probeInterpreter,
  pythonCandidates,
  pythonForTool,
  resetPythonCache,
  toolImports,
  resolvePython,
} from '../src/python.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');

/**
 * The Python runtime contract.
 *
 * `cut`, `qa`, `find`, `preview` and `review` all shell out to tools/*.py. Before this, they
 * spawned whatever `python3` PATH offered — so on stock macOS 3.9 the user got
 * `ImportError: cannot import name 'pairwise'` with a line number instead of a fix, and
 * preflight said everything was fine because it never asked about Python at all.
 *
 * These tests pin the three things that has to mean: one declared floor, one resolution
 * order, and a named error rather than a traceback.
 */

/** A fake interpreter: reports `version`, and imports only `has`. No real Python involved. */
function stubProbe(table) {
  return executable => {
    const entry = table[executable];
    if (!entry) return { ok: false, candidate: executable, detail: 'could not start (ENOENT)' };
    const [major, minor] = entry.version;
    if (major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1])) {
      return {
        ok: false, candidate: executable, executable, version: entry.version, tooOld: true,
        detail: `Python ${entry.version.join('.')} is older than the required ${MIN_PYTHON_TEXT}`,
      };
    }
    return { ok: true, candidate: executable, executable, version: entry.version };
  };
}

function stubImports(table) {
  return (executable, modules) => {
    const has = new Set(table[executable]?.has || []);
    return modules.filter(name => !has.has(name));
  };
}

test('the declared floor matches what the shipped scripts actually need', () => {
  // tools/aroll.py imports itertools.pairwise, which is 3.10+. pyproject, ruff's target and
  // CI must not be allowed to drift apart from this number.
  assert.deepEqual(MIN_PYTHON, [3, 11]);

  const aroll = fs.readFileSync(path.join(PACKAGE_ROOT, 'tools', 'aroll.py'), 'utf8');
  assert.match(aroll, /from itertools import pairwise/,
    'if this import goes away the floor should be re-derived, not silently kept');

  const pyproject = fs.readFileSync(path.join(PACKAGE_ROOT, 'pyproject.toml'), 'utf8');
  assert.match(pyproject, new RegExp(`requires-python\\s*=\\s*">=${MIN_PYTHON_TEXT}"`),
    'pyproject must declare the same floor the CLI enforces');
  assert.match(pyproject, /target-version = "py311"/, 'ruff must lint against the declared floor');

  const ci = fs.readFileSync(path.join(PACKAGE_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, new RegExp(`PYTHON_FLOOR: "${MIN_PYTHON_TEXT}"`),
    'CI must exercise the floor, not something newer that hides a 3.11 break');
  // Both jobs must use it, or the linted Python and the run Python are different versions.
  assert.equal((ci.match(/python-version: \$\{\{ env\.PYTHON_FLOOR \}\}/g) || []).length, 2,
    'every setup-python step must take the version from PYTHON_FLOOR');
});

test('every third-party import the shipped tools make at module scope is declared', () => {
  for (const [basename, declared] of Object.entries(TOOL_IMPORTS)) {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'tools', basename), 'utf8');
    // Only module-scope imports are a hard requirement; an indented one is lazy by design.
    const topLevel = source.split('\n')
      .filter(line => /^(import|from) /.test(line))
      .map(line => line.replace(/^(import|from)\s+([A-Za-z_][\w.]*).*/, '$2').split('.')[0]);
    const thirdParty = topLevel.filter(name => RUNTIME_IMPORTS.includes(name));
    for (const name of thirdParty) {
      assert.ok(declared.includes(name),
        `tools/${basename} imports ${name} at module scope but TOOL_IMPORTS does not declare it`);
    }
  }
  // And the declaration is not aspirational in the other direction either.
  const qa = fs.readFileSync(path.join(PACKAGE_ROOT, 'tools', 'frame_qa.py'), 'utf8');
  assert.match(qa, /^import numpy as np$/m);
  assert.match(qa, /^from PIL import/m);
});

test('every declared runtime dependency has an install name', () => {
  for (const name of RUNTIME_IMPORTS) {
    const hint = installHint([name]);
    assert.ok(hint && /pip install/.test(hint), `${name} needs an actionable install line`);
  }
  assert.equal(installHint([]), null, 'nothing missing means nothing to say');
});

test('an explicit CAPCUTCTL_PYTHON wins outright, and its failure is not walked past', () => {
  const env = { CAPCUTCTL_PYTHON: '/opt/chosen/python3' };
  const probe = stubProbe({
    '/opt/chosen/python3': { version: [3, 11, 8], has: [] },
    'python3.13': { version: [3, 13, 0], has: RUNTIME_IMPORTS },
  });
  // Chosen, even though it cannot import the runtime dependencies and a better one exists.
  const resolved = resolvePython({ env, refresh: true, probe, imports: stubImports({}) });
  assert.equal(resolved.executable, '/opt/chosen/python3');
  assert.equal(resolved.source, 'CAPCUTCTL_PYTHON');

  // And when it is unusable, that is an error — not a quiet fallback to something else.
  assert.throws(
    () => resolvePython({
      env: { CAPCUTCTL_PYTHON: '/opt/gone/python3' },
      refresh: true,
      probe,
      imports: stubImports({}),
    }),
    error => {
      assert.equal(error.code, 'PYTHON_NOT_FOUND');
      assert.match(error.message, /CAPCUTCTL_PYTHON=\/opt\/gone\/python3/);
      return true;
    },
  );
});

test('a too-old interpreter is named as too old, not merely missing', () => {
  const probe = stubProbe({ 'python3': { version: [3, 9, 6], has: [] } });
  assert.throws(
    () => resolvePython({ env: {}, refresh: true, probe, imports: stubImports({}) }),
    error => {
      assert.equal(error.code, 'PYTHON_TOO_OLD');
      assert.match(error.message, /3\.11/);
      assert.equal(error.exitCode, 2);
      // The stock-macOS case: say which ones were rejected and why.
      assert.ok(error.details.rejected.some(entry => entry.tooOld));
      return true;
    },
  );
});

test('among ambient interpreters, the one that satisfies the contract beats the newer one', () => {
  // The trap this prevents: `pip install -e .` under python3 (3.11), then a bare python3.13
  // sorts first and reports the dependencies missing on a machine that has them.
  const probe = stubProbe({
    'python3.13': { version: [3, 13, 0] },
    'python3.11': { version: [3, 11, 9] },
    'python3': { version: [3, 11, 9] },
  });
  const imports = stubImports({
    'python3.13': { has: [] },
    'python3.11': { has: RUNTIME_IMPORTS },
    'python3': { has: RUNTIME_IMPORTS },
  });
  const resolved = resolvePython({ env: {}, refresh: true, probe, imports });
  assert.equal(resolved.executable, 'python3.11');

  // But when nothing has them, resolution still succeeds — with the first that clears the
  // floor — so preflight can report the gap instead of the CLI refusing to start at all.
  const barren = resolvePython({
    env: {}, refresh: true, probe, imports: stubImports({}),
  });
  assert.equal(barren.executable, 'python3.13');
});

test('the candidate order puts explicit choices ahead of ambient guesses', () => {
  const venv = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-venv-'));
  try {
    fs.mkdirSync(path.join(venv, '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(venv, '.venv', 'bin', 'python3'), '');
    const candidates = pythonCandidates({
      env: { CAPCUTCTL_PYTHON: '/x/py' }, packageRoot: venv,
    });
    assert.deepEqual(candidates.slice(0, 2).map(c => c.source), ['CAPCUTCTL_PYTHON', 'project .venv']);
    assert.ok(candidates.slice(0, 2).every(c => c.chosen), 'explicit choices are not guesses');
    assert.ok(candidates.slice(2).every(c => c.source === 'PATH' && !c.chosen));
    // Ambient candidates are version-pinned newest-first, then the bare names.
    const path_ = candidates.filter(c => c.source === 'PATH').map(c => c.executable);
    assert.ok(path_.indexOf('python3.11') < path_.indexOf('python3'));
    assert.ok(!path_.includes('python3.10'), 'never offer an interpreter below the floor');
  } finally {
    fs.rmSync(venv, { recursive: true, force: true });
  }
});

test('a missing dependency is a named error carrying the fix, never a traceback', () => {
  const probe = stubProbe({ 'python3': { version: [3, 12, 0] } });
  const imports = stubImports({ 'python3': { has: ['numpy'] } });
  assert.throws(
    () => pythonForTool('frame_qa.py', { env: {}, refresh: true, probe, imports }),
    error => {
      assert.equal(error.code, 'PYTHON_MISSING_DEPENDENCY');
      assert.equal(error.exitCode, 2);
      assert.deepEqual(error.details.missing, ['PIL']);
      assert.match(error.details.fix, /pip install pillow/);
      // The old failure mode, in full: "ModuleNotFoundError: No module named 'numpy'".
      assert.doesNotMatch(error.message, /Traceback|ModuleNotFoundError/);
      return true;
    },
  );

  // cut and find declare no hard third-party imports, so a bare interpreter still runs them.
  const bare = stubImports({ 'python3': { has: [] } });
  assert.doesNotThrow(() => pythonForTool('aroll.py', { env: {}, refresh: true, probe, imports: bare }));
  assert.doesNotThrow(() => pythonForTool('find.py', { env: {}, refresh: true, probe, imports: bare }));
});

test('a lazy import is still checked up front once its flag is on the command line', () => {
  // find.py imports frame_qa only under --strip, and only after the search has printed its
  // hits. Left unchecked that is the worst version of the failure this module exists to
  // remove: the user waits for the whole search and gets a traceback at the end anyway.
  assert.deepEqual(toolImports('find.py'), []);
  assert.deepEqual(toolImports('find.py', ['--media', 'a.mp4', 'query']), []);
  assert.deepEqual(toolImports('find.py', ['--strip']), ['numpy', 'PIL']);
  assert.deepEqual(toolImports('find.py', ['--strip=sheet.png']), ['numpy', 'PIL']);
  assert.deepEqual(toolImports('find.py', ['--strip', 'sheet.png']), ['numpy', 'PIL']);
  // A different flag that merely starts the same way is not --strip.
  assert.deepEqual(toolImports('find.py', ['--strip-audio']), []);

  const probe = stubProbe({ 'python3': { version: [3, 12, 0] } });
  const bare = stubImports({ 'python3': { has: [] } });
  const options = { env: {}, refresh: true, probe, imports: bare };

  // Plain find keeps working on a machine with no NumPy. That is the whole reason these
  // imports are conditional rather than hard.
  assert.doesNotThrow(() => pythonForTool('find.py', { ...options, argv: ['--media', 'a.mp4', 'q'] }));

  assert.throws(
    () => pythonForTool('find.py', { ...options, argv: ['--media', 'a.mp4', '--strip', 'q'] }),
    error => {
      assert.equal(error.code, 'PYTHON_MISSING_DEPENDENCY');
      assert.deepEqual(error.details.missing, ['numpy', 'PIL']);
      // The message has to explain why a command that never needed NumPy suddenly does.
      assert.match(error.message, /needed for --strip/);
      assert.match(error.details.fix, /pip install numpy pillow/);
      assert.doesNotMatch(error.message, /Traceback|ModuleNotFoundError/);
      return true;
    },
  );
});

test('preflight reports the interpreter the commands will actually spawn', () => {
  const probe = stubProbe({ 'python3.12': { version: [3, 12, 4] } });
  const rows = preflightPython({
    env: {}, refresh: true, probe, imports: stubImports({ 'python3.12': { has: RUNTIME_IMPORTS } }),
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.ok));
  assert.equal(rows[0].interpreter, 'python3.12');
  assert.match(rows[0].detail, /3\.12\.4/);

  const broken = preflightPython({
    env: {}, refresh: true, probe, imports: stubImports({ 'python3.12': { has: ['numpy'] } }),
  });
  assert.equal(broken[0].ok, true, 'the interpreter is fine');
  assert.equal(broken[1].ok, false, 'its dependencies are not');
  assert.deepEqual(broken[1].missing, ['PIL']);
  assert.match(broken[1].fix, /pip install pillow/);

  // No interpreter at all: two failing rows, both actionable, neither a stack trace.
  const none = preflightPython({ env: {}, refresh: true, probe: stubProbe({}), imports: stubImports({}) });
  assert.equal(none.length, 2);
  assert.ok(none.every(row => row.ok === false && row.fix));
});

test('the real interpreter on this machine satisfies the contract preflight reports', () => {
  resetPythonCache();
  const resolved = resolvePython({ refresh: true });
  const probed = probeInterpreter(resolved.executable);
  assert.ok(probed.ok, `${resolved.executable} must be runnable: ${probed.detail}`);
  assert.ok(probed.version[0] > 3 || probed.version[1] >= MIN_PYTHON[1],
    `resolved ${probed.version.join('.')}, below the declared floor ${MIN_PYTHON_TEXT}`);

  // missingImports must agree with the interpreter about the standard library, or the
  // pre-spawn check would refuse to run commands that would have worked.
  assert.deepEqual(missingImports(resolved.executable, ['json', 'itertools']), []);
  assert.deepEqual(missingImports(resolved.executable, ['a_module_that_does_not_exist']),
    ['a_module_that_does_not_exist']);
  assert.deepEqual(missingImports(resolved.executable, []), [], 'no modules means no subprocess');
});
