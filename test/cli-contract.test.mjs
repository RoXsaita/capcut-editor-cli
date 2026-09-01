import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELP, main, setOutput } from '../src/cli.mjs';
import { CONTRACT_VERSION, TRANSACTIONAL_COMMANDS, buildContract, parseHelp } from '../src/contract.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const CONTRACT_FILE = 'docs/cli-contract.json';

/**
 * The CLI's side of CLI/skills parity.
 *
 * `capcut-skills` documents these commands in prose, and the two drifted silently: the CLI
 * grew `status`, `wait-for-close`, `init-spec`, `layout screen` and the media-origin flags
 * while the skill's command table still described the older surface. The skills CI checked
 * that four SKILL.md files existed and nothing else.
 *
 * These tests hold up the CLI end: the emitted contract must match the dispatch and the
 * help text, and the checked-in copy the skills validate against must be current.
 */

/** Every command cli.mjs dispatches on, read out of the source rather than trusted. */
function dispatchedCommands() {
  const source = read('src/cli.mjs');
  const names = new Set();
  for (const [, name] of source.matchAll(/command === '([a-z][a-z0-9-]*)'/g)) names.add(name);
  return names;
}

test('the contract covers exactly the commands the CLI dispatches', () => {
  const contract = buildContract();
  const documented = new Set(Object.keys(contract.commands));
  const dispatched = dispatchedCommands();

  const undocumented = [...dispatched].filter(name => !documented.has(name)).sort();
  assert.deepEqual(undocumented, [],
    'these commands exist but the help text never lists them, so the contract cannot see them');

  const phantom = [...documented].filter(name => !dispatched.has(name)).sort();
  assert.deepEqual(phantom, [],
    'the help text advertises commands the CLI does not dispatch');
});

test('every option the contract claims is one the help text actually prints', () => {
  // The contract is derived from HELP, so this guards the derivation rather than the data:
  // a parser bug that invented or dropped options would otherwise ship silently.
  const contract = buildContract();
  for (const [name, entry] of Object.entries(contract.commands)) {
    for (const option of entry.options) {
      assert.ok(HELP.includes(option), `contract claims ${name} ${option}, absent from help`);
    }
  }
  // Spot-check the surface the skills were missing, so a regression in parseHelp that
  // quietly dropped a block would fail here rather than pass with fewer commands.
  assert.ok(contract.commands.status.options.includes('--wait-for-close'));
  assert.ok(contract.commands['init-spec'].options.includes('--output'));
  assert.ok(contract.commands.layout.subcommands.includes('screen'));
  assert.ok(contract.commands.add.options.includes('--generated'));
  assert.ok(contract.commands.add.options.includes('--allow-ephemeral'));
  assert.ok(contract.commands.review.options.includes('--project'));
});

test('the checked-in contract is current', () => {
  // docs/cli-contract.json is what the skills repository validates against. If it is stale,
  // the skills are being checked against a CLI that no longer exists.
  const pkg = JSON.parse(read('package.json'));
  const generated = buildContract({ version: pkg.version });
  const committed = JSON.parse(read(CONTRACT_FILE));
  assert.deepEqual(committed, generated,
    `${CONTRACT_FILE} is stale — regenerate with \`node bin/capcutctl.mjs contract > ${CONTRACT_FILE}\``);
  assert.equal(committed.contractVersion, CONTRACT_VERSION);
  assert.equal(committed.cliVersion, pkg.version, 'the contract must carry the CLI version');
});

test('`capcutctl contract` emits the same document', async () => {
  let stdout = '';
  const restore = setOutput(chunk => { stdout += String(chunk); return true; });
  try { await main(['contract']); } finally { restore(); }
  assert.deepEqual(JSON.parse(stdout), JSON.parse(read(CONTRACT_FILE)));
});

test('the dry-run guarantee names every transactional command and no others', () => {
  // The claim in capcut-cli/SKILL.md used to be "Everything that writes takes --dry-run",
  // which was false: snapshot, init-spec --output, harvest --out and review all write and
  // none of them take it. The guarantee is now scoped to transactional edits, and this is
  // what keeps that scope honest at the source level.
  const source = read('src/cli.mjs');

  // Commands that reach the transaction machinery pass the shared `options` object, which
  // is the single place `dryRun: Boolean(args.dryRun)` is threaded from.
  assert.match(source, /const options = \{\n\s*dryRun: Boolean\(args\.dryRun\),/,
    'the shared options object is how dryRun reaches applySpec; find its new form');

  for (const command of TRANSACTIONAL_COMMANDS) {
    assert.ok(buildContract().commands[command],
      `${command} is claimed transactional but is not a command`);
  }

  // The writing commands that deliberately do NOT take --dry-run. Listing them here is the
  // point: adding a meaningless --dry-run to any of them for symmetry would make the
  // guarantee weaker, so if one moves, that has to be a decision someone typed.
  for (const command of ['snapshot', 'history', 'init-spec', 'harvest', 'review']) {
    assert.ok(!TRANSACTIONAL_COMMANDS.includes(command),
      `${command} writes, but is not a transactional edit; it must stay out of the guarantee`);
  }
});

test('a dry-run of a transactional edit changes nothing on disk', async () => {
  // The behavioural half. The guarantee is worth nothing as a list if the flag does not
  // actually hold the write back, so drive a real project through a real transaction.
  const { default: os } = await import('node:os');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-dryrun-'));
  const root = path.join(temp, 'drafts');
  try {
    let stdout = '';
    const restore = setOutput(chunk => { stdout += String(chunk); return true; });
    try {
      await main(['new', '--blank', '--project', 'Dry Run', '--root', root]);
    } finally { restore(); }
    const project = JSON.parse(stdout).project;

    const fingerprint = () => {
      const entries = [];
      const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(full);
          else entries.push(`${path.relative(project, full)}:${fs.readFileSync(full).toString('base64')}`);
        }
      };
      walk(project);
      return entries.join('\n');
    };

    const before = fingerprint();
    let out = '';
    const restore2 = setOutput(chunk => { out += String(chunk); return true; });
    try {
      // sync is transactional, needs no clip selector, and reports what it would change.
      await main(['sync', '--project', 'Dry Run', '--root', root, '--dry-run', '--force-running']);
    } finally { restore2(); }
    assert.equal(JSON.parse(out).dryRun, true, 'the command must report that it was a dry run');
    assert.equal(fingerprint(), before, 'a --dry-run transaction wrote to the project');

    // And no snapshot was minted either: a dry run is not a write of any kind.
    const history = path.join(project, '.capcutctl', 'history');
    if (fs.existsSync(history)) {
      assert.deepEqual(fs.readdirSync(history), [], 'a dry run must not create a snapshot');
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('parseHelp stops at section headings rather than swallowing the prose', () => {
  // The help text ends with several column-0 sections ("Layouts are exact…", "Safety
  // defaults:"). Those mention flags. If the parser kept accumulating past them, every
  // option in the epilogue would be attributed to whichever command happened to be last.
  const parsed = parseHelp(HELP);
  const last = parsed.get('music');
  assert.ok(last, 'music is the final command entry');
  // parseHelp yields Sets; buildContract is what sorts them into arrays.
  assert.ok(!last.options.has('--force-running'),
    'options from the trailing prose must not attach to the last command listed');
  assert.ok(!parsed.has('preflight"'), 'no punctuation should leak into a command name');
});
