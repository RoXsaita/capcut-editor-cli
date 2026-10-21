import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BOOLEAN_FLAGS, HELP, main, parseArgs, setOutput } from '../src/cli.mjs';
import {
  CONTRACT_VERSION, TOOL_OPTIONS, TOOL_SCRIPTS, TRANSACTIONAL_COMMANDS, buildContract, parseHelp,
} from '../src/contract.mjs';
import { projectFingerprint, writeCliProject } from './helpers/cli-project.mjs';

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

test('every option the contract claims comes from the help text or from argparse', () => {
  // The contract has exactly two sources: the help text this CLI prints, and the declared
  // argparse surface of the tools cut/qa/find pass through to. A parser bug that invented
  // an option would otherwise ship silently.
  const contract = buildContract();
  for (const [name, entry] of Object.entries(contract.commands)) {
    const fromTool = new Set(TOOL_OPTIONS[name] || []);
    for (const option of entry.options) {
      assert.ok(HELP.includes(option) || fromTool.has(option),
        `contract claims ${name} ${option}, which is in neither the help text nor argparse`);
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

test('misspelled or misplaced options fail before a project can be edited', async () => {
  for (const args of [
    ['remove', '--project', 'missing', '--dryrun', 'true'],
    ['trim', '--project', 'missing', '--plan'],
    ['cut', 'missing.mp4', '--into', 'missing', '--kep', '1,2'],
  ]) {
    await assert.rejects(main(args), error => error.code === 'UNKNOWN_OPTION');
  }
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
      // This fixture lives outside CapCut's registry, even if the user's editor is open.
      await main(['new', '--blank', '--project', 'Dry Run', '--root', root, '--force-running']);
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

test('the declared Python option surface matches what argparse actually accepts', async t => {
  // TOOL_OPTIONS is hand-declared so that building the contract needs no Python. That is a
  // thing that can rot, so ask argparse itself. Skipped, with a reason, when the runtime
  // dependencies are absent — frame_qa.py cannot even print --help without NumPy.
  const { execFileSync } = await import('node:child_process');
  const { resolvePython, missingImports, TOOL_IMPORTS } = await import('../src/python.mjs');
  let python;
  try { python = resolvePython({ refresh: true }); }
  catch (error) { return t.skip(`no supported Python interpreter: ${error.message}`); }

  for (const [command, options] of Object.entries(TOOL_OPTIONS)) {
    const script = TOOL_SCRIPTS[command];
    const missing = missingImports(python.executable, TOOL_IMPORTS[script] || []);
    if (missing.length) {
      t.diagnostic(`skipping ${command}: ${script} cannot import ${missing.join(', ')}`);
      continue;
    }
    const help = execFileSync(python.executable, [path.join(ROOT, 'tools', script), '--help'],
      { encoding: 'utf8', timeout: 60_000 });
    const actual = [...new Set((help.match(/--[a-z][a-z0-9-]*/g) || []))]
      .filter(option => option !== '--help').sort();
    assert.deepEqual([...options].sort(), actual,
      `tools/${script} argparse and TOOL_OPTIONS.${command} disagree`);
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

test('the command-docs table, HELP and the dispatcher name exactly the same commands', async () => {
  // One table owns summary, group, example and "transactional". It must cover every command
  // HELP advertises and the CLI dispatches, and nothing else — in both directions.
  const { COMMAND_DOCS, GROUPS } = await import('../src/command-docs.mjs');
  const inHelp = new Set([...parseHelp().keys(), 'help']);
  const inDocs = new Set(Object.keys(COMMAND_DOCS));
  assert.deepEqual([...inHelp].filter(n => !inDocs.has(n)).sort(), [], 'commands in HELP with no docs row');
  assert.deepEqual([...inDocs].filter(n => !inHelp.has(n)).sort(), [], 'docs rows for commands HELP does not list');
  const groups = new Set(GROUPS.map(([id]) => id));
  for (const [name, row] of Object.entries(COMMAND_DOCS)) {
    assert.ok(groups.has(row.group), `${name} has unknown group ${row.group}`);
    assert.ok(row.summary && row.summary.length <= 120, `${name} needs a one-line summary`);
  }
});

test('every documented example uses its own command and only options the contract lists', async () => {
  const { COMMAND_DOCS } = await import('../src/command-docs.mjs');
  const contract = buildContract();
  for (const [name, row] of Object.entries(COMMAND_DOCS)) {
    const words = row.example.split(/\s+/);
    assert.equal(words[0], 'capcutctl', `${name} example must start with capcutctl`);
    assert.equal(words[1], name, `${name} example runs ${words[1]}`);
    for (const flag of row.example.match(/(?<=\s)--[a-z][a-z0-9-]*/g) || []) {
      assert.ok(contract.commands[name].options.includes(flag), `${name} example uses ${flag}, which the contract does not list`);
    }
  }
});

test('the markdown reference is generated from the contract and names every command', async () => {
  const { renderReference } = await import('../src/command-docs.mjs');
  const contract = buildContract({ version: '0.0.0' });
  const md = renderReference(contract);
  for (const name of Object.keys(contract.commands)) assert.ok(md.includes(`\`${name}\``), `reference misses ${name}`);
  assert.match(md, /GENERATED by `capcutctl contract --markdown`/);
});

test('every command documented with --project reaches project resolution, not "Unknown command"', async () => {
  // cli.mjs keeps a hand list of project commands; a command missing from it dispatches
  // nowhere. Drive each documented project command at a missing project and require the
  // project lookup to be what fails.
  const { COMMAND_DOCS } = await import('../src/command-docs.mjs');
  const { default: os } = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-dispatch-'));
  try {
    for (const [name, row] of Object.entries(COMMAND_DOCS)) {
      if (!/--project\b/.test(row.example)) continue;
      if (Object.hasOwn(TOOL_SCRIPTS, name)) continue;      // python pass-throughs parse their own args
      const words = row.example.split(/\s+/);
      const argv = [name];
      if (words[2] && /^[a-z][a-z-]*$/.test(words[2])) argv.push(words[2]);
      argv.push('--project', 'No Such Project', '--root', root);
      const restore = setOutput(() => true);
      const exitCode = process.exitCode;
      try {
        await main(argv);
      } catch (error) {
        assert.doesNotMatch(String(error.message), /^Unknown command/, `${name} is documented but not dispatched`);
      } finally { restore(); process.exitCode = exitCode; }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


/** Run main() on a throwaway two-clip project; returns { out, error, changed }. */
async function onFixture(t, segments = ['A', 'B']) {
  const { default: os } = await import('node:os');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-b2-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const media = path.join(temp, 'face.mp4');
  fs.writeFileSync(media, 'fixture media');
  const project = writeCliProject(temp, media, { segments });
  const draft = () => JSON.parse(fs.readFileSync(path.join(project, 'draft_info.json'), 'utf8'));
  const history = () => {
    const dir = path.join(project, '.capcutctl', 'history');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  const run = async (argv, { forceRunning = true } = {}) => {
    const before = projectFingerprint(project);
    let out = '';
    let error = null;
    const restore = setOutput(chunk => { out += String(chunk); return true; });
    const exitCode = process.exitCode;
    try {
      // The fixture lives outside CapCut's registry, so --force-running is safe even when the
      // user's editor is open; without it a refused write would hide a real one.
      const mapped = argv.map(a => (a === 'P' ? project : a.replace(/^T\//, `${temp}/`)));
      await main(forceRunning ? mapped.concat('--force-running') : mapped);
    } catch (caught) { error = caught; } finally { restore(); process.exitCode = exitCode; }
    return { out, error, changed: projectFingerprint(project) !== before };
  };
  return { temp, project, draft, history, run };
}

test('--plan never writes: zoom --at and layout circle/full-face are dry runs', async t => {
  // --plan used to be ignored by every command that did not print its own plan, so these
  // committed a real edit (and a snapshot) while the agent believed it was only looking.
  const fx = await onFixture(t, ['SEGMENT']);
  for (const argv of [
    ['zoom', '--project', 'P', '--at', '1', '--plan'],
    ['layout', 'circle', '--project', 'P', '--at', '1', '--plan'],
    ['layout', 'full-face', '--project', 'P', '--at', '1', '--plan'],
  ]) {
    const { out, error, changed } = await fx.run(argv);
    assert.equal(error, null, `${argv.join(' ')}: ${error?.message}`);
    assert.equal(JSON.parse(out).dryRun, true, `${argv.join(' ')} must report a dry run`);
    assert.equal(changed, false, `${argv.join(' ')} wrote to the project`);
  }
  assert.deepEqual(fx.history(), [], 'a --plan must not mint a snapshot');
});

test('prose in an entry does not lend its flags to the command', () => {
  const contract = buildContract();
  assert.ok(!contract.commands.stage.options.includes('--fix'), 'stage --fix is doctor --fix mentioned in prose');
  assert.ok(!contract.commands.wrap.options.includes('--stress'), 'wrap --stress is zoom --stress mentioned in prose');
  assert.ok(contract.commands.doctor.options.includes('--fix'));
  assert.ok(contract.commands.zoom.options.includes('--stress'));
  // Flags on continuation lines before any prose still count.
  assert.ok(contract.commands.music.options.includes('--under-db'));
  assert.ok(contract.commands.mograph.options.includes('--scene'));
  assert.ok(contract.commands.pace.options.includes('--cover'));
});

test('a number that is not a number fails with BAD_NUMBER and writes nothing', async t => {
  const fx = await onFixture(t);
  for (const argv of [
    ['volume', '--project', 'P', '--segments', 'A', '--level', '0,5'],
    ['add', '--project', 'P', '--media', 'T/face.mp4', '--at', '3s', '--dur', '1', '--track', 'broll'],
    ['fade', '--project', 'P', '--segments', 'A', '--in', '8ms'],
    ['keyframe', '--project', 'P', '--segments', 'A', '--to', '1,3'],
    ['loudness', '--project', 'P', '--target', '-14LUFS'],
    ['zoom', '--project', 'P', '--at', '1,x'],
    ['layout', 'screen', '--project', 'P', '--media', 'T/face.mp4', '--at', '1,5',
      '--width', '1920', '--height', '1080', '--media-duration', '3'],
    ['layout', 'screen', '--project', 'P', '--media', 'T/face.mp4', '--at', '1',
      '--width', '1920', '--height', '1080', '--media-duration', '3s'],
    ['pace', '--project', 'P', '--at', '1', '--cover', '1-x'],
    ['pace', '--project', 'P', '--auto', '--min-gap', '5s'],
  ]) {
    const { error, changed } = await fx.run(argv);
    assert.equal(error?.code, 'BAD_NUMBER', `${argv.join(' ')}: ${error?.message}`);
    assert.equal(error.exitCode, 2);
    assert.equal(changed, false, `${argv.join(' ')} wrote to the project`);
  }
  const { error } = await fx.run(['volume', '--project', 'P', '--segments', 'A', '--level', '0,5']);
  assert.match(error.message, /use 0\.5/);
});

test('--segments A,B acts on every id in one transaction', async t => {
  const fx = await onFixture(t);
  const ids = () => fx.draft().tracks[1].segments.map(segment => segment.id);

  let result = await fx.run(['volume', '--project', 'P', '--segments', 'A,B', '--level', '0']);
  assert.equal(result.error, null, result.error?.message);
  assert.deepEqual(fx.draft().tracks[1].segments.map(segment => segment.volume), [0, 0]);

  result = await fx.run(['remove', '--project', 'P', '--segments', 'A,missing']);
  assert.equal(result.error?.code, 'SELECTOR_EMPTY');
  assert.equal(result.changed, false, 'one unknown id fails the whole list');
  assert.deepEqual(ids(), ['A', 'B']);

  const snapshots = fx.history().length;
  result = await fx.run(['remove', '--project', 'P', '--segments', 'A, B']);
  assert.equal(result.error, null, result.error?.message);
  assert.deepEqual(ids(), []);
  assert.equal(fx.history().length, snapshots + 1, 'one list is one snapshot');
});

test('single-clip commands refuse a list; a repeated --segments is refused', async t => {
  const fx = await onFixture(t);
  for (const argv of [
    ['trim', '--project', 'P', '--segments', 'A,B', '--src', '0-1'],
    ['shift', '--project', 'P', '--segments', 'A,B', '--by', '0.2'],
    ['keyframe', '--project', 'P', '--segments', 'A,B', '--to', '1.2'],
    ['punch', '--project', 'P', '--segments', 'A,B', '--on', 'Publish'],
    ['punch', '--project', 'P', '--segment', 'A', '--segments', 'A', '--on', 'Publish'],
  ]) {
    const { error, changed } = await fx.run(argv);
    assert.equal(error?.code, 'MULTIPLE_SEGMENTS', `${argv.join(' ')}: ${error?.message}`);
    assert.equal(error.exitCode, 2);
    assert.equal(changed, false);
  }
  assert.throws(() => parseArgs(['remove', '--segments', 'A', '--segments', 'B']),
    error => error.code === 'DUPLICATE_FLAG' && error.exitCode === 2);
  // A single id still behaves as before.
  const { error } = await fx.run(['shift', '--project', 'P', '--segments', 'B', '--by', '0.5']);
  assert.equal(error, null, error?.message);
  assert.equal(fx.draft().tracks[1].segments.find(segment => segment.id === 'B').target_timerange.start, 2_000_000);
});

test('replace-media --segments ID --all relinks every clip on that media, keeping their windows', async t => {
  const fx = await onFixture(t);
  fs.writeFileSync(path.join(fx.temp, 'room.mp4'), 'room plate');
  const before = fx.draft().tracks[1].segments.map(segment => segment.source_timerange);
  const { error } = await fx.run(['replace-media', '--project', 'P', '--segments', 'A', '--all',
    '--file', 'T/room.mp4', '--width', '1080', '--height', '1920', '--media-duration', '3', '--allow-ephemeral']);
  assert.equal(error, null, error?.message);
  const doc = fx.draft();
  const videos = new Map(doc.materials.videos.map(material => [material.id, material]));
  for (const segment of doc.tracks[1].segments) {
    assert.match(videos.get(segment.material_id).path, /room\.mp4$/, `${segment.id} still plays the old media`);
  }
  assert.deepEqual(doc.tracks[1].segments.map(segment => segment.source_timerange), before);
  const twice = await fx.run(['replace-media', '--project', 'P', '--segments', 'A,B', '--all', '--file', 'T/room.mp4']);
  assert.equal(twice.error?.code, 'MULTIPLE_SEGMENTS');
});

test('an unknown command is a short pointed refusal, not the whole help', async t => {
  const fx = await onFixture(t, ['SEGMENT']);
  const { error } = await fx.run(['list']);
  assert.match(error.message, /^Unknown command: list\./);
  assert.match(error.message, /projects/);
  assert.ok(error.message.length < 1024, `message is ${error.message.length} bytes`);
  const typo = await fx.run(['timelin', '--project', 'P']);
  assert.match(typo.error.message, /Did you mean: timeline/);
});

test('`<command> --help` prints that command only', async () => {
  let out = '';
  const restore = setOutput(chunk => { out += String(chunk); return true; });
  try { await main(['notes', '--help']); } finally { restore(); }
  assert.ok(out.length < 2048, `notes --help is ${out.length} bytes`);
  assert.match(out, /--decide/);
  assert.doesNotMatch(out, /capcutctl layout/);
});

test('an unknown option names the nearest flag or the options there are', async t => {
  const fx = await onFixture(t, ['SEGMENT']);
  const gate = await fx.run(['gate', '--project', 'P', '--bogus', '1']);
  assert.equal(gate.error?.code, 'UNKNOWN_OPTION');
  assert.match(gate.error.message, /Did you mean|takes:/);
  const close = await fx.run(['gate', '--project', 'P', '--xrya', 'dir']);
  assert.match(close.error.message, /Did you mean --xray/);
  const preflight = await fx.run(['preflight', '--root', 'T/drafts', '--project', 'x', '--json'], { forceRunning: false });
  assert.notEqual(preflight.error?.code, 'UNKNOWN_OPTION', preflight.error?.message);
  const bogus = await fx.run(['preflight', '--root', 'T/drafts', '--bogus', '1'], { forceRunning: false });
  assert.equal(bogus.error?.code, 'UNKNOWN_OPTION');
});

test('notes takes the flag names agents guess: --decision is --decide', async t => {
  const fx = await onFixture(t, ['SEGMENT']);
  const { error } = await fx.run(['notes', '--project', 'P', '--decision', 'keep the indigo frame'], { forceRunning: false });
  assert.equal(error, null, error?.message);
  const notes = JSON.parse(fs.readFileSync(path.join(fx.project, '.capcutctl', 'notes.json'), 'utf8'));
  assert.equal(notes.decisions.at(-1).what, 'keep the indigo frame');
  const todo = await fx.run(['notes', '--project', 'P', '--outstanding', 'fix the seam at 12s'], { forceRunning: false });
  assert.equal(todo.error, null, todo.error?.message);
  const both = await fx.run(['notes', '--project', 'P', '--decision', 'a', '--decide', 'b'], { forceRunning: false });
  assert.equal(both.error?.code, 'NOTES_ARGS');
});

test('no boolean flag swallows a value another command documents', () => {
  // One list of booleans serves every command. If `--name` is boolean here but some command
  // documents `--name VALUE`, the value lands in the positionals and the flag reads true.
  const camel = flag => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const valued = new Set();
  for (const [, flag] of HELP.matchAll(/--([a-z][a-z0-9-]*)[ =](?=[A-Z0-9"'{]|-[0-9])/g)) valued.add(camel(flag));
  const collisions = [...valued].filter(key => BOOLEAN_FLAGS.has(key));
  assert.deepEqual(collisions, [], 'boolean flags that HELP also documents with a value');

  const documented = new Set(Object.values(buildContract().commands)
    .flatMap(entry => entry.options).map(option => camel(option.slice(2))));
  const undocumented = [...BOOLEAN_FLAGS].filter(key => key !== 'help' && !documented.has(key));
  assert.deepEqual(undocumented, [], 'boolean flags no command documents');
});
