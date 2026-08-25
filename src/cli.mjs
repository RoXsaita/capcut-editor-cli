import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  capcutctl cut VIDEO [--keep 0,2-9] [--project NAME] [--lang ar]
                      — talking-head cleanup: transcribe, energy-sync, strip dead
                        air, review table. Re-run with --keep to build.
  capcutctl qa --project NAME --times 3,9,15 [--guide 960] [--sheet] [--label L]
                      — composite real frames (+ a labelled contact sheet).
  capcutctl find "agent running" --media FILE [--shows|--says] [--context]
                      — when is it on screen / when was it said.

  capcutctl projects [--root PATH] [--json]
  capcutctl rm --project NAME [--dry-run]      — to .recycle_bin, registry entry dropped
  capcutctl close                              — quit CapCut and wait for it to exit
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

  capcutctl scenes --project NAME_OR_PATH [--track N] [--transcript]
  capcutctl layout split-screen --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--dry-run]
  capcutctl layout circle       --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--dry-run]
  capcutctl layout background   --project NAME_OR_PATH [--at SECONDS] [--include-template] [--dry-run]
  capcutctl layout broll        --project NAME_OR_PATH --at SECONDS --track N --row ROW [--scale S]
  capcutctl brands              list known brands, their spoken aliases, and which have a logo
  capcutctl logo                --project NAME_OR_PATH --at S --brand NAME [--scale] [--hold] [--pos x,y]
  capcutctl endcard             --project NAME_OR_PATH [--text Follow] [--at S]
  capcutctl zoom                --project NAME_OR_PATH --at S[,S...] | --auto  [--to 1.15] [--hold 1.6]
  capcutctl wrap                --project NAME_OR_PATH --words TRANSCRIPT.json [--text Follow] [--plan]
                                brand logos from what he says + the endcard, in one pass
  capcutctl pace                --project NAME_OR_PATH [--track N] [--max 100]
                                no flags = print the plan; --auto applies it
                                --at T --speed X | --at T --cover IN-OUT for one clip
  capcutctl polish              --project NAME_OR_PATH [--lead 0.14] [--track N] [--dry-run]
                                transitions ride the principal (talking-head) track; it is sliced to fit
                      — his transitions + matching SFX on every cut, measured from
                        Hermes-agent / Higgsfield Refund / Content System / IKEA Refund
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

const r2 = n => Math.round(n * 100) / 100;

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (['json', 'dryRun', 'forceRunning', 'noBackup', 'help', 'noOverlay', 'blank', 'includeTemplate', 'newTimelineId',
         'transcript', 'noTransitions', 'noSeam', 'auto', 'plan', 'noSfx', 'noZoom'].includes(key)) result[key] = true;
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

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function main(argv) {
  const command = argv[0];
  if (command === 'cut' || command === 'qa' || command === 'find') {
    const tool = { cut: 'aroll.py', qa: 'frame_qa.py', find: 'find.py' }[command];
    const script = path.join(HERE, '..', 'tools', tool);
    const r = spawnSync('python3', [script, ...argv.slice(1)], { stdio: 'inherit' });
    if (r.error) throw new CapcutError(`could not run ${script}: ${r.error.message}`, { exitCode: 2 });
    process.exit(r.status ?? 1);
  }
  const args = parseArgs(argv);
  if (!command || args.help || command === 'help') return print(HELP);
  const root = args.root ? path.resolve(args.root) : DEFAULT_ROOT;

  if (command === 'layout' && args._[1] === 'list') {
    const { presets } = await import('./layouts.mjs');
    const p = presets();
    return print(Object.entries(p.layouts).map(([name, l]) => ({ name, description: l.description }))
      .concat([{ name: 'background', description: p.background.description }]), true);
  }
  if (command === 'brands') {
    const { brandPresets } = await import('./signature.mjs');
    const rows = Object.entries(brandPresets().brands).map(([name, b]) => ({
      brand: name, aliases: b.aliases,
      logo: b.logo || null, usable: Boolean(b.logo && fs.existsSync(b.logo)),
    }));
    return print({ usable: rows.filter(r => r.usable).map(r => r.brand),
                   needsATransparentPng: rows.filter(r => !r.usable).map(r => r.brand),
                   brands: rows }, true);
  }
  if (command === 'close') {
    const { closeCapcut } = await import('./create.mjs');
    return print(closeCapcut(), true);
  }
  if (command === 'rm') {
    if (!args.project) throw new CapcutError('rm requires --project NAME.', { exitCode: 2 });
    const { removeProject } = await import('./create.mjs');
    return print(removeProject(args.project, { root, dryRun: Boolean(args.dryRun),
                                               forceRunning: Boolean(args.forceRunning) }), true);
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
    return print(describeScenes(projectDir, args.track == null ? null : Number(args.track),
                                Boolean(args.transcript)), true);
  }
  if (command === 'pace') {
    const { pacePlan } = await import('./pace.mjs');
    const hasAction = args.auto || args.at != null;
    if (!hasAction) {                                     // read-only: the plan
      const { loadProject } = await import('./core.mjs');
      const state = loadProject(projectDir);
      const doc = state.groups.find(g => g.name === 'root').doc;
      const rows = pacePlan(doc, { track: args.track == null ? null : Number(args.track),
                                   max: args.max ? Number(args.max) : 100,
                                   minGap: args.minGap ? Number(args.minGap) : 5.0 });
      return print({ plan: rows.map(({ __seg, ...r }) => r) }, true);
    }
    const set = [];
    if (args.at != null) {
      if (args.cover) {
        const [a, b] = String(args.cover).split(/[-:,]/).map(Number);
        if (!(b > a)) throw new CapcutError('--cover expects IN-OUT in source seconds, e.g. --cover 178.6-190.5', { exitCode: 2 });
        set.push({ at: Number(args.at), cover: [a, b] });
      } else if (args.speed != null) {
        set.push({ at: Number(args.at), speed: Number(args.speed) });
      } else {
        throw new CapcutError('--at needs either --speed X or --cover IN-OUT', { exitCode: 2 });
      }
    }
    const spec = { version: 1, name: 'pace', operations: [{ op: 'pace',
      ...(set.length ? { set } : {}), ...(args.auto ? { auto: true } : {}),
      ...(args.track != null ? { track: Number(args.track) } : {}),
      ...(args.max ? { max: Number(args.max) } : {}),
      ...(args.minGap ? { minGap: Number(args.minGap) } : {}) }] };
    return print(applySpec(projectDir, spec, options), true);
  }
  if (command === 'logo' || command === 'endcard' || command === 'zoom' || command === 'wrap') {
    const sig = await import('./signature.mjs');
    const op = { op: 'signature', ...(args.noSfx ? { noSfx: true } : {}) };

    if (command === 'logo') {
      if (args.at == null || !args.brand) throw new CapcutError('logo requires --at SECONDS and --brand NAME (see `capcutctl brands`).', { exitCode: 2 });
      const b = sig.brandPresets().brands[args.brand];
      if (!b) throw new CapcutError(`unknown brand "${args.brand}". See \`capcutctl brands\`.`, { exitCode: 2 });
      op.logos = [{ brand: args.brand, at: Number(args.at), logo: args.logo || b.logo,
                    ...(args.scale ? { scale: Number(args.scale) } : {}),
                    ...(args.hold ? { hold: Number(args.hold) } : {}),
                    ...(args.pos ? { pos: String(args.pos).split(',').map(Number) } : {}) }];
    }
    if (command === 'endcard') {
      op.endcard = { ...(args.text ? { text: args.text } : {}),
                     ...(args.at != null ? { at: Number(args.at) } : {}),
                     ...(args.hold ? { hold: Number(args.hold) } : {}),
                     ...(args.scale ? { scale: Number(args.scale) } : {}) };
    }
    if (command === 'zoom') {
      if (args.auto) {
        const { loadProject } = await import('./core.mjs');
        const doc = loadProject(projectDir).groups.find(g => g.name === 'root').doc;
        const scenes = sig.talkingHeadScenes(doc, args.track == null ? null : Number(args.track),
                                             args.minLength ? Number(args.minLength) : 2.5);
        if (!scenes.length) throw new CapcutError('no full-face scenes found (every principal clip carries a mask).', { exitCode: 2 });
        // fire a little after the cut, so the push reads as a move and not as the cut itself
        args.at = scenes.map(s => (s.start + 0.4).toFixed(2)).join(',');
        if (args.plan) return print({ talkingHeadScenes: scenes, zoomAt: args.at.split(',').map(Number) }, true);
      }
      if (args.at == null) throw new CapcutError('zoom requires --at SECONDS (comma-separated), or --auto.', { exitCode: 2 });
      op.zooms = String(args.at).split(',').map(Number).map(at => ({ at,
        ...(args.to ? { to: Number(args.to) } : {}),
        ...(args.hold != null ? { hold: Number(args.hold) } : {}) }));
    }

    if (command === 'wrap') {
      const { loadProject } = await import('./core.mjs');
      const state = loadProject(projectDir);
      const doc = state.groups.find(g => g.name === 'root').doc;
      const mapper = sig.sourceToTimeline(doc, args.track == null ? null : Number(args.track));
      let hits = [];
      if (args.transcript === true) {
        throw new CapcutError('wrap takes --words FILE (a word-level transcript json), not a bare --transcript.', { exitCode: 2 });
      }
      if (args.words) {
        const tr = readJson(path.resolve(args.words));
        hits = sig.detectBrands(tr, mapper, { only: args.only ? String(args.only).split(',') : null });
      }
      const missing = hits.filter(h => !h.logo || !fs.existsSync(h.logo));
      hits = hits.filter(h => h.logo && fs.existsSync(h.logo));
      op.logos = hits;
      op.endcard = { ...(args.text ? { text: args.text } : {}) };
      if (args.noZoom) op.zooms = [];
      else if (args.zoomAt) op.zooms = String(args.zoomAt).split(',').map(Number).map(at => ({ at }));
      else op.zooms = sig.talkingHeadScenes(doc).map(s => ({ at: r2(s.start + 0.4) }));
      if (args.plan) return print({ detected: hits, skippedNoLogo: missing.map(m => m.brand),
                                    endcard: op.endcard, zooms: op.zooms || [] }, true);
      if (missing.length) process.stderr.write(`note: no logo asset for ${missing.map(m => m.brand).join(', ')} — skipped\n`);
    }
    return print(applySpec(projectDir, { version: 1, name: command, operations: [op] }, options), true);
  }
  if (command === 'polish') {
    const spec = { version: 1, name: 'polish',
                   operations: [{ op: 'polish', ...(args.lead ? { lead: Number(args.lead) } : {}),
                                  ...(args.track != null ? { track: Number(args.track) } : {}),
                                  ...(args.noTransitions ? { noTransitions: true } : {}) }] };
    return print(applySpec(projectDir, spec, options), true);
  }
  if (command === 'layout') {
    const name = args._[1];
    if (!name) throw new CapcutError('layout requires a name: split-screen | circle | background | list', { exitCode: 2 });
    const { buildLayoutSpec } = await import('./layouts.mjs');
    const spec = buildLayoutSpec(projectDir, name, {
      segments: args.segments ? String(args.segments).split(',').map(s => s.trim()).filter(Boolean) : null,
      at: args.at ? String(args.at).split(',').map(Number) : null,
      track: args.track == null ? null : Number(args.track),
      row: args.row, scale: args.scale, seam: args.noSeam ? false : undefined,
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
