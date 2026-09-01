/**
 * The machine-readable CLI contract.
 *
 * The skills repository documents these commands in prose, and the two drifted: the CLI
 * grew `status`, `wait-for-close`, `init-spec`, `layout screen` and the media-origin flags
 * while `capcut-cli/SKILL.md` still described the older surface, and nothing could tell.
 * A skill that names a flag the CLI does not have sends an agent into a parse error; one
 * that misses a command means the agent hand-writes draft_info.json instead.
 *
 * So the CLI owns one machine-readable answer, derived from the help text it already
 * prints rather than hand-maintained beside it. `capcutctl contract --json` emits it,
 * docs/cli-contract.json is the checked-in copy the skills validate against, and
 * test/cli-contract.test.mjs proves the derivation still matches both the help text and
 * the command dispatch in cli.mjs.
 */
import { HELP } from './cli.mjs';

/**
 * The contract revision. Bump this when the *shape* of the emitted document changes —
 * a new field, a renamed key, a different nesting. Consumers pin it; the CLI version
 * moves independently every release and is not a compatibility signal on its own.
 */
export const CONTRACT_VERSION = 1;

/** The only command that dispatches on a positional subcommand (`args._[1]`). */
const SUBCOMMAND_PARENTS = new Set(['layout']);

/**
 * Commands that mutate a project through the transaction machinery. These are the ones
 * `--dry-run` is a real guarantee about: each one takes it, and each one means the same
 * thing by it — resolve, validate, report, write nothing.
 *
 * Deliberately not a list of "everything that touches the disk". `snapshot` writes a
 * snapshot, `init-spec --output` writes a template, `harvest --out` writes a capture, and
 * `review` writes an output directory — none of those are transactional edits to a
 * project, and giving them a no-op `--dry-run` for symmetry would make the flag mean less,
 * not more. See test/cli-contract.test.mjs.
 */
export const TRANSACTIONAL_COMMANDS = Object.freeze([
  'add', 'apply', 'endcard', 'fade', 'keyframe', 'layout', 'localize', 'logo', 'music',
  'new', 'pace', 'polish', 'remove', 'replace-media', 'restore', 'rm', 'shift', 'sync',
  'trim', 'volume', 'wrap', 'zoom', 'finish',
]);

const OPTION = /--[a-z][a-z0-9-]*/g;

/**
 * Options that belong to the Python argparse behind `cut`, `qa`, `find` and `preview`,
 * not to the Node help text.
 *
 * The help text is a summary — it shows the flags a reader needs to get started, not the
 * complete surface. `find --strip`, `qa --ocr` and `qa --out` are real, documented in the
 * skills, and were absent from the contract because they are declared in argparse rather
 * than in HELP. A contract missing them would fail a skill for naming a flag that works.
 *
 * Declared rather than shelled out for, so building the contract stays pure and does not
 * need NumPy installed. test/cli-contract.test.mjs runs each tool's `--help` and fails if
 * this list and argparse disagree, so it cannot rot quietly.
 */
export const TOOL_OPTIONS = Object.freeze({
  cut: Object.freeze([
    '--drop', '--dry-run', '--force', '--fps', '--in-place', '--into', '--keep', '--lang',
    '--model', '--no-repair', '--order', '--project', '--recover-beat', '--reindex',
    '--review', '--selftest', '--trim-beat',
  ]),
  qa: Object.freeze([
    '--allow-missing', '--at-broll', '--at-cuts', '--at-scenes', '--cut-window', '--expect',
    '--fps', '--from', '--guide', '--label', '--languages', '--native', '--no-cache',
    '--ocr', '--out', '--preview', '--project', '--rects-only', '--resolution', '--selftest',
    '--sheet', '--times', '--to', '--width', '--z',
  ]),
  find: Object.freeze(['--context', '--media', '--says', '--settle', '--shows', '--strip']),
});

/** Which tools/*.py each of those commands is a front end for. */
export const TOOL_SCRIPTS = Object.freeze({
  cut: 'aroll.py', qa: 'frame_qa.py', find: 'find.py', preview: 'frame_qa.py',
});

/**
 * Read the help text into structure.
 *
 * Every command entry starts at column 2 with `capcutctl NAME`; its continuation lines are
 * indented further and carry the rest of its options and prose. Anything at column 0 ends
 * the block — those are the section headings ("Layouts are exact…", "Safety defaults:").
 */
export function parseHelp(help = HELP) {
  const lines = help.split('\n');
  const start = /^ {2}capcutctl\s+([a-z][a-z0-9-]*)(?:\s+(\S+))?/;
  const commands = new Map();
  let current = null;

  const ensure = name => {
    if (!commands.has(name)) commands.set(name, { name, options: new Set(), subcommands: new Set() });
    return commands.get(name);
  };

  for (const line of lines) {
    const opened = line.match(start);
    if (opened) {
      const [, name, second] = opened;
      current = ensure(name);
      if (SUBCOMMAND_PARENTS.has(name) && second && !second.startsWith('--')) {
        current.subcommands.add(second);
      }
    } else if (current && (line.startsWith('  ') || line.trim() === '')) {
      // Still inside the current entry, or a blank line between wrapped lines.
      if (line.trim() === '') continue;
    } else if (line.length && !line.startsWith(' ')) {
      // A section heading at column 0 ends the command list for this block.
      current = null;
      continue;
    }
    if (!current) continue;
    for (const option of line.match(OPTION) || []) current.options.add(option);
  }

  return commands;
}

/** Build the full contract document. Pure: same help text in, same JSON out. */
export function buildContract({ help = HELP, version } = {}) {
  const parsed = parseHelp(help);
  const commands = {};
  for (const [name, entry] of [...parsed].sort(([a], [b]) => a.localeCompare(b))) {
    // `preview` is a Node command that forwards to frame_qa, so it keeps its own help-text
    // surface; cut/qa/find are pass-throughs and take argparse's.
    const fromTool = TOOL_OPTIONS[name] || [];
    commands[name] = {
      options: [...new Set([...entry.options, ...fromTool])].sort(),
      ...(entry.subcommands.size ? { subcommands: [...entry.subcommands].sort() } : {}),
      transactional: TRANSACTIONAL_COMMANDS.includes(name),
    };
  }
  // `help` is dispatched but never listed as an entry in its own help text.
  if (!commands.help) commands.help = { options: [], transactional: false };
  return {
    contractVersion: CONTRACT_VERSION,
    cliVersion: version ?? null,
    // What `--dry-run` is a promise about. The skills quote this sentence; the test proves
    // every command named here accepts the flag and no other command is claimed to.
    dryRun: {
      guarantee: 'Every transactional edit command takes --dry-run.',
      commands: [...TRANSACTIONAL_COMMANDS].sort(),
    },
    commands,
  };
}
