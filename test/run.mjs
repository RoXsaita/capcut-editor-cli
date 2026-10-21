#!/usr/bin/env node
/**
 * `npm test`: run the suite in a sealed environment.
 *
 * The suite used to inherit the developer's whole shell. Two things went wrong with that:
 *
 *   - HOME was shared. Tests that look in ~/Downloads/.video-index or ~/.config/capcutctl
 *     passed or failed depending on what this machine had indexed that week.
 *   - Any CAPCUTCTL_* or API key in the shell reached the code under test.
 *
 * So the child gets a fresh temp HOME and an allowlisted environment. Two things have to be
 * resolved from the real environment first, or a sealed run would quietly skip tests:
 * Playwright's browser cache (it lives under the real home) and the variables that point at
 * a Chromium or a Python on purpose.
 *
 * CAPCUTCTL_ASSUME_RUNNING=1 makes every write behave as if CapCut were open. A test that
 * writes without --force-running (or { forceRunning: true }) fails here on every machine,
 * rather than only on the one where CapCut happens to be running.
 *
 * The file list is expanded here, not by `node --test` (Node 20 has no glob support), and
 * it names test files only, so test/helpers and test/fixtures are never run as tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

/** Playwright's default browser cache for a given home directory. */
function playwrightCache(home) {
  if (!home) return null;
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null;
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
}

/** Resolved before HOME is replaced: an explicit setting, then the current home, then the login home. */
function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  let login = null;
  try { login = os.userInfo().homedir; } catch { /* no passwd entry */ }
  for (const home of [os.homedir(), login]) {
    const dir = playwrightCache(home);
    if (dir && fs.existsSync(dir)) return dir;
  }
  return null;
}

const PASS = new Set(['PATH', 'TMPDIR', 'LANG', 'CI', 'GITHUB_ACTIONS', 'CAPCUTCTL_CHROMIUM', 'CAPCUTCTL_PYTHON', 'NODE_PATH']);

export function childEnv(home, source = process.env, browsers = browsersPath()) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value != null && (PASS.has(key) || key.startsWith('LC_'))) env[key] = value;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = '/nonexistent/capcutctl-test';
  env.CAPCUTCTL_ASSUME_RUNNING = '1';
  if (browsers) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  return env;
}

export function testFiles(dir = HERE) {
  return fs.readdirSync(dir)
    .filter(name => /\.test\.(mjs|cjs)$/.test(name))
    .sort()
    .map(name => path.join('test', name));
}

/** `node --test` flags that take a value, which may come as the next argument. */
const VALUE_FLAGS = new Set([
  '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination',
  '--test-concurrency', '--test-timeout', '--test-shard', '--test-coverage-include',
  '--test-coverage-exclude', '--test-coverage-branches', '--test-coverage-functions',
  '--test-coverage-lines', '--test-global-setup',
]);

/**
 * Split runner arguments into node flags and test files. `--flag=value` and `--flag value`
 * both stay flags: without this, `npm test -- --test-name-pattern foo` ran `foo` as a file.
 */
export function splitArgs(args) {
  const named = [];
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { named.push(arg); continue; }
    flags.push(arg);
    if (VALUE_FLAGS.has(arg) && i + 1 < args.length) flags.push(args[++i]);
  }
  return { named, flags };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `npm test -- test/duck.test.mjs` runs just that file; flags pass through to `node --test`.
  const { named, flags } = splitArgs(process.argv.slice(2));
  const files = named.length ? named : testFiles();
  if (!files.length) {
    process.stderr.write('test/run.mjs: no test/*.test.mjs or test/*.test.cjs files found\n');
    process.exit(1);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-test-home-'));
  const env = childEnv(home);
  const cleanup = () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } };
  const child = spawn(process.execPath, ['--test', ...flags, ...files], { cwd: ROOT, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { cleanup(); process.stderr.write(`test/run.mjs: ${error.message}\n`); process.exit(1); });
  child.on('exit', (code, signal) => {
    cleanup();
    process.exit(code ?? (signal ? 1 : 0));
  });
}
