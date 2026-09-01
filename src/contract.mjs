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
    commands[name] = {
      options: [...entry.options].sort(),
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
