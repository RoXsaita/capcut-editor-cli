import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the local gate fails when a tool exits unsuccessfully despite reassuring output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-gates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(new URL('../scripts/check.sh', import.meta.url), path.join(root, 'scripts/check.sh'));
  fs.mkdirSync(path.join(root, '.venv'));
  fs.writeFileSync(path.join(root, '.gitignore'), '.venv/\n');
  for (const name of ['dependency.sh', 'tracked.sh']) fs.writeFileSync(path.join(root, '.venv', name), '#!/bin/sh\n');
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'add', '-f', '.venv/tracked.sh']).status, 0);
  const shim = (name, body) => fs.writeFileSync(path.join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  shim('npm', 'printf "# pass 1\\n# fail 0\\n# skipped 0\\n"');
  shim('node', 'command -v python');
  shim('python', 'if [ "$1" = tools/aroll.py ]; then echo "all passed"; exit "${AROLL_STATUS:-0}"; fi');
  shim('vulture', 'exit "${VULTURE_STATUS:-0}"');
  shim('ruff', 'exit 0');
  shim('shellcheck', 'printf "%s\\n" "$@" > "$SHELLCHECK_LOG"; exit "${SHELLCHECK_STATUS:-0}"');
  shim('uname', 'echo Linux');
  for (const env of [{}, { AROLL_STATUS: '9' }, { VULTURE_STATUS: '9' }, { SHELLCHECK_STATUS: '9' }]) {
    const run = spawnSync('/bin/bash', [path.join(root, 'scripts/check.sh'), '--strict'], {
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, AROLL_STATUS: '0', VULTURE_STATUS: '0',
        SHELLCHECK_STATUS: '0', SHELLCHECK_LOG: path.join(root, 'shellcheck.log'), ...env },
      encoding: 'utf8',
    });
    assert.equal(run.status, Object.keys(env).length ? 1 : 0, run.stdout + run.stderr);
    assert.deepEqual(fs.readFileSync(path.join(root, 'shellcheck.log'), 'utf8').trim().split('\n').sort(),
      ['.venv/tracked.sh', 'scripts/check.sh']);
  }
});
