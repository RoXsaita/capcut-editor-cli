import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

/**
 * `npm test` runs the suite through test/run.mjs, which gives it a temp HOME and an
 * allowlisted environment. This file fails when that did not happen — a direct
 * `node --test` from a shell, or a runner change that let the developer's environment back in —
 * because the rest of the suite then reads this machine's ~/Downloads/.video-index and
 * ~/.config/capcutctl and passes or fails on what happens to be there.
 */
const ALLOWED = new Set(['CAPCUTCTL_ASSUME_RUNNING', 'CAPCUTCTL_CHROMIUM', 'CAPCUTCTL_PYTHON']);

test('the suite runs under a temp HOME, not the developer\'s', () => {
  let login = null;
  try { login = os.userInfo().homedir; } catch { /* no passwd entry: nothing to compare */ }
  if (login) assert.notEqual(os.homedir(), login, 'run the suite with `npm test`, which seals HOME (test/run.mjs)');
  assert.equal(process.env.XDG_CONFIG_HOME, '/nonexistent/capcutctl-test');
});

test('no unexpected CAPCUTCTL_* variable reaches the suite', () => {
  const extra = Object.keys(process.env).filter(key => key.startsWith('CAPCUTCTL_') && !ALLOWED.has(key));
  assert.deepEqual(extra, [], 'test/run.mjs allowlists the environment; these leaked in');
  assert.equal(process.env.CAPCUTCTL_ASSUME_RUNNING, '1', 'every write must be tested as if CapCut were open');
});

test('the runner keeps `--flag value` pairs together instead of running the value as a file', async () => {
  const { splitArgs } = await import('./run.mjs');
  assert.deepEqual(splitArgs(['--test-name-pattern', 'foo', 'test/duck.test.mjs']),
    { named: ['test/duck.test.mjs'], flags: ['--test-name-pattern', 'foo'] });
  assert.deepEqual(splitArgs(['--test-name-pattern=foo', '--test-only']),
    { named: [], flags: ['--test-name-pattern=foo', '--test-only'] });
});
