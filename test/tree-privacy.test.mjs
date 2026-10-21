import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * This repository is public. Nothing tracked may carry a real home directory, a personal
 * address, a link into someone's Claude sessions, or a share-tracking parameter.
 *
 * The patterns are general on purpose; personal terms (a login, a draft title) do not belong
 * in a public test file, so an optional, gitignored scripts/.privacy-denylist adds them on the
 * machine that has them: one term per line, `#` comments, matched case-insensitively.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Placeholder logins that docs and tests use on purpose.
const MAC_LOGINS = new Set(['x', 'you', 'me', 'user', 'username', 'name', 'example', 'shared']);
const LINUX_LOGINS = new Set(['runner', 'user', 'you', 'me', 'x', 'example']);

/** Inline allowlist: `${file}:${exact match}` for a hit that is genuinely fine. Keep it short. */
const ALLOW = new Set([]);

const RULES = [
  { name: 'real macOS home', re: /\/Users\/([A-Za-z0-9._-]+)/g, ok: m => MAC_LOGINS.has(m[1].toLowerCase()) },
  { name: 'real Linux home', re: /\/home\/([A-Za-z0-9._-]+)/g, ok: m => LINUX_LOGINS.has(m[1].toLowerCase()) },
  { name: 'personal address', re: /[A-Za-z0-9._%+-]+@gmail\.com/gi },
  { name: 'Claude session link', re: /claude\.ai\/(?:chat|share|project|code\/session)s?\/[\w-]{8,}/g },
  { name: 'tracking parameter', re: /https?:\/\/[^\s)"'<>]*[?&](?:si|is)=[^\s)"'<>&]*/g },
];

function denylist(root) {
  const file = path.join(root, 'scripts', '.privacy-denylist');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(line => line.replace(/#.*/, '').trim()).filter(Boolean);
}

/** Every finding as `file:line: rule: match`. Binary files (a NUL in the first 8 KB) are skipped. */
export function scan(root, files, extra = denylist(root)) {
  const terms = extra.map(term => term.toLowerCase());
  const findings = [];
  for (const rel of files) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(root, rel)); } catch { continue; }
    if (bytes.subarray(0, 8192).includes(0)) continue;
    const lines = bytes.toString('utf8').split('\n');
    lines.forEach((line, index) => {
      const where = `${rel}:${index + 1}`;
      for (const rule of RULES) {
        for (const match of line.matchAll(rule.re)) {
          if (rule.ok?.(match) || ALLOW.has(`${rel}:${match[0]}`)) continue;
          findings.push(`${where}: ${rule.name}: ${match[0]}`);
        }
      }
      const lower = line.toLowerCase();
      for (const term of terms) if (lower.includes(term)) findings.push(`${where}: denylisted term`);
    });
  }
  return findings;
}

test('no tracked file carries a home path, personal address, session link or tracking parameter', t => {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    t.skip('not a git checkout (an archive or npm pack); nothing tracked to scan');
    return;
  }
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 0, 'git ls-files listed nothing');
  assert.deepEqual(scan(ROOT, files), []);
});

test('the scan catches a planted home path and a denylisted term', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const login = ['real', 'name'].join('');
  fs.writeFileSync(path.join(root, 'planted.md'), `see ${path.posix.join('/Users', login, 'Movies')}\n`);
  fs.writeFileSync(path.join(root, 'fine.md'), `${path.posix.join('/Users', 'x', 'Movies')} and ~/Movies\n`);
  fs.writeFileSync(path.join(root, 'title.md'), 'draft: Secret Draft Title\n');
  assert.deepEqual(scan(root, ['planted.md', 'fine.md'], []), [`planted.md:1: real macOS home: /Users/${login}`]);
  assert.equal(scan(root, ['title.md'], ['secret draft']).length, 1);
  assert.equal(scan(root, ['title.md'], []).length, 0);
});
