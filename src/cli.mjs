import fs from 'node:fs';
import path from 'node:path';
import {
  CapcutError,
  DEFAULT_ROOT,
  applySpec,
  createSnapshot,
  doctor,
  inspectProject,
  listSnapshots,
  listProjects,
  readJson,
  resolveProject,
  restoreProjectSnapshot,
  syncMirrors
} from './core.mjs';

const HELP = `capcutctl — transactional CapCut timeline control

Usage:
  capcutctl projects [--root PATH] [--json]
  capcutctl new --project NAME [--media FILE] [--scenes 0:6,6:12,12:18]
                [--from TEMPLATE] [--blank] [--canvas 1080x1920] [--fps 30] [--dry-run]
  capcutctl inspect --project NAME_OR_PATH [--root PATH] [--json]
  capcutctl doctor --project NAME_OR_PATH [--root PATH] [--json]
  capcutctl snapshot --project NAME_OR_PATH [--label NAME]
  capcutctl history --project NAME_OR_PATH
  capcutctl restore --project NAME_OR_PATH --snapshot NAME [--force-running] [--no-backup]
  capcutctl sync --project NAME_OR_PATH [--dry-run] [--force-running] [--no-backup]
  capcutctl apply --project NAME_OR_PATH --spec FILE [--dry-run] [--force-running] [--no-backup]
  capcutctl init-spec [--output FILE]

  capcutctl scenes --project NAME_OR_PATH [--track N]
  capcutctl layout split-screen --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--dry-run]
  capcutctl layout circle       --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--dry-run]
  capcutctl layout background   --project NAME_OR_PATH [--at SECONDS] [--include-template] [--dry-run]
  capcutctl layout list

Layouts are exact, measured geometry (presets/layouts.json) — not judgement:
  split-screen  subject fills the BOTTOM half from y=960, indigo bar on the seam
  circle        subject as the lower-left circular avatar, inside the white ring
  background    finds every circle scene and builds the blurred backdrop under it

New projects clone "Preset 3" by default: the branded endcard is carried over and
slid to sit immediately after your scenes. Use --blank for an empty timeline.

Safety defaults:
  • refuses writes while CapCut is running
  • snapshots before every committed transaction
  • applies semantic operations to root + active timeline independently
  • atomically synchronizes draft_info.json, .bak, and template-2.tmp
  • validates media, IDs, refs, timing, masks, and mirror drift
`;

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (['json', 'dryRun', 'forceRunning', 'noBackup', 'help', 'noOverlay', 'blank', 'includeTemplate', 'newTimelineId'].includes(key)) result[key] = true;
    else {
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new CapcutError(`Missing value for ${token}.`, { exitCode: 2 });
      result[key] = argv[++i];
    }
  }
  return result;
}

function print(value, asJson = false) {
  if (asJson || typeof value !== 'string') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

function printDoctor(report, asJson) {
  if (asJson) return print(report, true);
  process.stdout.write(`Project: ${report.project}\nActive timeline: ${report.activeTimelineId || 'root only'}\nErrors: ${report.errors}  Warnings: ${report.warnings}\n`);
  for (const item of report.issues) process.stdout.write(`${item.level === 'error' ? 'ERROR' : 'WARN '} ${item.code}: ${item.message}\n`);
  if (!report.issues.length) process.stdout.write('OK: no issues found.\n');
}

const EXAMPLE_SPEC = {
  version: 1,
  name: 'safe-capcut-edit',
  operations: [
    {
      op: 'segment.patch',
      selector: { id: 'SEGMENT-ID' },
      set: {
        clip: {
          scale: { x: 1, y: 1 },
          transform: { x: 0, y: 0 }
        }
      }
    },
    {
      op: 'mask.patch',
      segment: { id: 'SEGMENT-ID' },
      mask: { name: 'Circle' },
      set: { config: { feather: 0, expansion: 0 } }
    }
  ]
};

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || args.help || command === 'help') return print(HELP);
  const root = args.root ? path.resolve(args.root) : DEFAULT_ROOT;

  if (command === 'layout' && args._[1] === 'list') {
    const { presets } = await import('./layouts.mjs');
    const p = presets();
    return print(Object.entries(p.layouts).map(([name, l]) => ({ name, description: l.description }))
      .concat([{ name: 'background', description: p.background.description }]), true);
  }
  if (command === 'new') {
    if (!args.project) throw new CapcutError('new requires --project NAME.', { exitCode: 2 });
    const { createProject } = await import('./create.mjs');
    return print(createProject(args.project, {
      root, from: args.from, media: args.media, scenes: args.scenes,
      canvas: args.canvas, fps: args.fps, blank: Boolean(args.blank),
      width: args.width, height: args.height, duration: args.duration,
      newTimelineId: Boolean(args.newTimelineId),
      dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning)
    }), true);
  }
  if (command === 'projects') return print(listProjects(root), args.json);
  if (command === 'init-spec') {
    const data = `${JSON.stringify(EXAMPLE_SPEC, null, 2)}\n`;
    if (args.output) { fs.writeFileSync(path.resolve(args.output), data); return print(`Wrote ${path.resolve(args.output)}`); }
    return process.stdout.write(data);
  }

  const projectDir = resolveProject(args.project, root);
  if (command === 'inspect') return print(inspectProject(projectDir), true);
  if (command === 'doctor') return printDoctor(doctor(projectDir), args.json);
  if (command === 'snapshot') return print({ snapshot: createSnapshot(projectDir, args.label || 'manual') }, true);
  if (command === 'history') return print(listSnapshots(projectDir), true);
  const options = {
    dryRun: Boolean(args.dryRun),
    forceRunning: Boolean(args.forceRunning),
    backup: !args.noBackup,
    label: args.label
  };
  if (command === 'sync') return print(syncMirrors(projectDir, options), true);
  if (command === 'restore') {
    if (!args.snapshot) throw new CapcutError('restore requires --snapshot NAME.', { exitCode: 2 });
    return print(restoreProjectSnapshot(projectDir, args.snapshot, options), true);
  }
  if (command === 'scenes') {
    const { describeScenes } = await import('./layouts.mjs');
    return print(describeScenes(projectDir, args.track == null ? null : Number(args.track)), true);
  }
  if (command === 'layout') {
    const name = args._[1];
    if (!name) throw new CapcutError('layout requires a name: split-screen | circle | background | list', { exitCode: 2 });
    const { buildLayoutSpec } = await import('./layouts.mjs');
    const spec = buildLayoutSpec(projectDir, name, {
      segments: args.segments ? String(args.segments).split(',').map(s => s.trim()).filter(Boolean) : null,
      at: args.at ? String(args.at).split(',').map(Number) : null,
      track: args.track == null ? null : Number(args.track),
      overlay: args.noOverlay ? false : undefined,
      includeTemplate: Boolean(args.includeTemplate)
    });
    return print(applySpec(projectDir, spec, options), true);
  }
  if (command === 'apply') {
    if (!args.spec) throw new CapcutError('apply requires --spec FILE.', { exitCode: 2 });
    return print(applySpec(projectDir, readJson(path.resolve(args.spec)), options), true);
  }
  throw new CapcutError(`Unknown command: ${command}\n\n${HELP}`, { exitCode: 2 });
}
