import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from '../scripts/render-docs.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The README's command overview and docs/commands.md are generated from docs/cli-contract.json
 * by scripts/render-docs.mjs. cli-contract.test.mjs keeps the contract fresh; this keeps the
 * two documents fresh against the contract, so a new command shows up without anyone
 * remembering to type it.
 */
test('the README command overview and docs/commands.md match the contract', () => {
  for (const [file, expected] of Object.entries(render())) {
    const current = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(current, expected, `${file} is stale: run node scripts/render-docs.mjs`);
  }
});

test('every relative link in the README, the guide and the landing page resolves', () => {
  // The README moved most of its reference into docs/; a link left pointing at the old
  // place costs a stranger a 404 on the first page they read.
  const pages = ['README.md', 'docs/guide.md', 'site/index.html'];
  for (const page of pages) {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const targets = [
      ...text.matchAll(/\]\(([^)\s]+)\)/g),
      ...text.matchAll(/\b(?:src|href)="([^"]+)"/g),
    ].map(match => match[1]).filter(url => !/^(?:[a-z]+:|#|\/\/)/i.test(url));
    for (const target of targets) {
      const file = decodeURIComponent(target.split('#')[0]);
      if (!file) continue;
      const resolved = path.join(ROOT, path.dirname(page), file);
      assert.ok(fs.existsSync(resolved), `${page} links to ${target}, which does not exist`);
    }
  }
});

test('render-docs runs its CLI when reached through a symlinked path', t => {
  // argv[1] is the path as typed and import.meta.url is resolved; a guard comparing the two
  // raw made a symlinked clone skip the CLI, so --check passed on stale docs.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-render-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copy = path.join(root, 'repo');
  for (const file of ['scripts/render-docs.mjs', 'src/command-docs.mjs', 'docs/cli-contract.json', 'docs/commands.md', 'README.md']) {
    fs.mkdirSync(path.join(copy, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(copy, file));
  }
  fs.appendFileSync(path.join(copy, 'docs/commands.md'), '\nstale\n');
  const link = path.join(root, 'link');
  fs.symlinkSync(copy, link, 'dir');
  const script = path.join(link, 'scripts/render-docs.mjs');

  const check = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 1, `--check through a symlink should fail on stale docs: ${check.stderr}`);
  assert.match(check.stderr, /stale: docs\/commands\.md/);

  const write = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  assert.equal(spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' }).status, 0);
});
