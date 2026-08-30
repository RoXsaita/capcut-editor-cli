import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import {
  CapcutError,
  DEFAULT_ROOT,
  applySpec,
  createSnapshot,
  doctor,
  inspectProject,
  listSnapshots,
  listProjects,
  capcutStatus,
  closeCapcut,
  readJson,
  resolveProject,
  restoreProjectSnapshot,
  syncMirrors
} from './core.mjs';

export const HELP = `capcutctl — transactional CapCut timeline control

Usage:
  capcutctl cut VIDEO [--keep 0,2-9] [--project NAME] [--into PROJECT] [--lang ar]
                      — talking-head cleanup: transcribe, energy-sync, strip dead
                        air, review table. Re-run with --keep to build; --into recuts
                        an existing project through the anchored cut.recut contract.
  capcutctl qa --project NAME [--times 3,9,15|--at-cuts|--at-scenes|--at-broll]
               [--guide 960] [--sheet] [--label L]
                      — composite real frames (+ a labelled contact sheet); automatic
                        sampling can target visual cuts, principal scenes, or B-roll.
  capcutctl find "agent running" --media FILE [--shows|--says] [--context]
                      — when is it on screen / when was it said.

  capcutctl projects [--root PATH] [--json]
  capcutctl rm --project NAME [--dry-run]      — to .recycle_bin, registry entry dropped
  capcutctl close                              — quit CapCut and wait for it to exit
  capcutctl status [--json] [--wait-for-close] — report CapCut state; optionally request quit and return a branchable close result
  capcutctl review --project NAME              — write outputs/<id>/proxy.mp4, edl.json, and contact-sheet.png (never CapCut export)
  capcutctl new --project NAME [--media FILE] [--scenes 0:6,6:12,12:18]
                [--from TEMPLATE] [--blank] [--canvas 1080x1920] [--fps 30] [--dry-run]
  capcutctl inspect --project NAME_OR_PATH [--root PATH] [--json]
  capcutctl doctor --project NAME_OR_PATH [--root PATH] [--json]
  capcutctl snapshot --project NAME_OR_PATH [--label NAME]
  capcutctl history --project NAME_OR_PATH
  capcutctl restore --project NAME_OR_PATH --snapshot NAME [--force-running] [--no-backup]
  capcutctl sync --project NAME_OR_PATH [--dry-run] [--force-running] [--no-backup]
  capcutctl apply --project NAME_OR_PATH --spec FILE [--dry-run] [--force-running] [--no-backup]
  capcutctl add --project NAME --media FILE --at S --dur S --track NAME|N
                [--src S] [--cover IN-OUT] [--volume 0] [--desc TEXT] [--no-localize]
                [--generated] [--derived-from ORIGINAL [--derived-offset S]] [--allow-ephemeral]
  capcutctl replace-media --project NAME --file FILE --at S --track NAME|N [--retime] [--no-localize]
  capcutctl localize --project NAME   — copy outside videos into the project (fixes Link media)
  capcutctl trim --project NAME --at S --track NAME|N --src IN-OUT | --start S --dur S
  capcutctl shift --project NAME --at S --track NAME|N --by SECONDS
  capcutctl remove --project NAME --at S --track NAME|N
  capcutctl volume --project NAME --at S --track NAME|N --level 0
  capcutctl fade --project NAME --at S --track NAME|N [--in 0.08] [--out 0.12]
  capcutctl keyframe --project NAME --at S --track NAME|N [--to 2.4] [--hold 1.6] [--plan]
  capcutctl preview --project NAME --out preview.mp4 [--fps 6] [--from S] [--to S]
  capcutctl diff --project NAME --against NAME|--snapshot NAME
  capcutctl harvest [--root PATH] [--projects A,B] [--out FILE]
  capcutctl init-spec [--output FILE]

  capcutctl scenes --project NAME_OR_PATH [--track N] [--transcript] [--name SUBSTR]
  capcutctl layout split-screen --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--dry-run]
  capcutctl layout circle       --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--dry-run]
  capcutctl layout background   --project NAME_OR_PATH [--at SECONDS] [--include-template] [--dry-run]
  capcutctl layout broll        --project NAME_OR_PATH --at SECONDS --track N --row ROW [--scale S]
  capcutctl layout screen       --project NAME_OR_PATH --at SECONDS --media FILE
                                [--dur S] [--src S] [--src-dur S] [--track NAME] [--no-localize] [--dry-run]
                                — add a centred rl2 screen recording through the layout.screen contract
  capcutctl brands              list known brands, their spoken aliases, and which have a logo
  capcutctl logo                --project NAME_OR_PATH --at S --brand NAME [--scale] [--hold] [--pos x,y]
  capcutctl endcard             --project NAME_OR_PATH [--text Follow] [--at S]
  capcutctl zoom                --project NAME_OR_PATH --at S[,S...] | --auto  [--to 1.15] [--hold 1.6]
  capcutctl wrap                --project NAME_OR_PATH --words TRANSCRIPT.json [--text Follow] [--plan]
                                brand logos from what he says + the endcard, in one pass
  capcutctl pace                --project NAME_OR_PATH [--track N] [--max 100]
                                no flags = print the plan; --auto applies it
                                --at T --speed X | --at T --cover IN-OUT for one clip
  capcutctl polish              --project NAME_OR_PATH [--lead 0.14] [--track N] [--motivated] [--dry-run]
                                transitions ride the principal (talking-head) track; it is sliced to fit
                      — his transitions + matching SFX. --motivated: only on picture
                        changes (B-roll shot or layout class), not every A-roll splice.
                        Also clicks every rectangle/arrow/circle callout (Enter / click / select).
                        rl2 click/typing events on the chopped B-roll (Mouse click / Typing).
                        --no-interactions skips that pass.
  capcutctl timeline            --project NAME [--width 64]   — ASCII dump of the stacked timeline
  capcutctl finish              --project NAME [--plan] [--music] [--polish] [--regen]
                                scorecard + ASCII. --plan is read-only. --music generates
                                a Lyria bed timed to picture changes and beat-aligned.
                                --polish runs motivated polish. Voice is never recut.
  capcutctl music               --project NAME [--plan] [--regen] [--volume 0.08]
                                generate / place the instrumental bed (used by finish --music)
  capcutctl layout auto         --project NAME_OR_PATH [--plan]   — split-screen where B-roll covers, full face where it does not
  capcutctl layout audit        --project NAME_OR_PATH            — what each clip is vs what it should be
  capcutctl layout list

Layouts are exact, measured geometry (presets/layouts.json) — not judgement:
  split-screen  subject fills the BOTTOM half from y=960, indigo bar on the seam
  circle        subject as the upper-left circular avatar, inside the white ring
  background    finds every circle scene and builds the blurred backdrop under it

New projects clone "Preset 3" by default: leftover preset clips are parked 30s after
the talking head (a parts bin — do not delete them). Follow/CTA is written on the
talking head, never on that leftover. Use --blank for an empty timeline.

The origin contract — every frame stays editable in CapCut:
  Enforced by add, replace-media, layout screen, and new --media.
  Media is refused when its framing was baked in before import (a file exactly half the
  canvas is a crop, not a capture) or when it comes from a temp/scratchpad directory (the
  origin recorded in media-map.json would be a dead link). Crop, pan and zoom with
  "layout broll --row" / "layout screen" on the FULL-frame source instead — those write
  clip.scale + clip.transform, which the human can still drag.
    --generated              a rendered asset with no editable original (Remotion, AE)
    --derived-from ORIGINAL  you pre-processed anyway; record where the real source is
  "doctor" reports MEDIA_PREFRAMED / MEDIA_ORIGIN_LOST for projects built before this.

Safety defaults:
  • refuses writes while CapCut is running
  • snapshots before every committed transaction
  • applies semantic operations to root + active timeline independently
  • atomically synchronizes draft_info.json, .bak, and template-2.tmp
  • validates media, IDs, refs, timing, masks, and mirror drift
`;

const r2 = n => Math.round(n * 100) / 100;

export function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (['json', 'dryRun', 'forceRunning', 'noBackup', 'help', 'noOverlay', 'blank', 'includeTemplate', 'newTimelineId',
         'transcript', 'noTransitions', 'noSeam', 'auto', 'plan', 'noSfx', 'noZoom', 'retime', 'localize',
         'noLocalize', 'motivated', 'regen', 'music', 'noMusic', 'polish', 'noInteractions',
         'waitForClose', 'force', 'reindex', 'noRepair', 'inPlace',
         'generated', 'allowEphemeral'].includes(key)) result[key] = true;
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


/**
 * `--track` is a name or an index everywhere. `layout` parsed it with Number(), so the
 * `layout broll --track broll` line that `add` prints as the next step resolved to NaN and
 * matched nothing — and `add`'s primary form is the named one.
 */
async function loadWorking(projectDir) {
  const { loadProject } = await import('./core.mjs');
  const state = loadProject(projectDir);
  const group = state.groups.find(g => g.name.startsWith('timeline:')) || state.groups[0];
  return group.doc;
}

function findWhisperCache(doc) {
  const videos = doc.materials?.videos || [];
  const cache = path.join(os.homedir(), 'Downloads', '.video-index');
  if (!fs.existsSync(cache)) return null;
  const names = fs.readdirSync(cache);
  for (const m of videos) {
    if (!m.path || (m.type && m.type !== 'video')) continue;
    const stem = path.basename(m.path).replace(/\.[^.]+$/, '');
    const hit = names.filter(n => n.startsWith(stem) && n.includes('.whisper')).sort()[0];
    if (hit) return path.join(cache, hit);
  }
  return null;
}

async function trackIndex(projectDir, spec) {
  if (spec == null || spec === '') return null;
  if (/^\d+$/.test(String(spec))) return Number(spec);
  const doc = await loadWorking(projectDir);
  const index = (doc.tracks || []).findIndex(t => t.type === 'video' && t.name === String(spec));
  if (index < 0) {
    throw new CapcutError(`no video track named "${spec}". Run \`capcutctl inspect\` to list them.`,
      { code: 'TRACK_MISSING', exitCode: 2 });
  }
  return index;
}

export const FIELD_REPORT_OPERATIONS = Object.freeze({
  screenLayout: 'layout.screen',
  cutRecut: 'cut.recut',
});

/**
 * Builder B contract for `layout screen`. Core owns the native segment/material/frame
 * construction; the CLI owns validation, media probing, and the transactional spec.
 */
export function buildScreenLayoutSpec({
  media,
  at,
  duration,
  sourceStart = 0,
  sourceDuration = duration,
  width,
  height,
  mediaDuration,
  track = 'screen',
  localize = true,
} = {}) {
  if (!media) throw new CapcutError('layout screen requires --media FILE.', { exitCode: 2 });
  const target = Number(at);
  const dur = Number(duration);
  const src = Number(sourceStart);
  const srcDur = Number(sourceDuration);
  if (!Number.isFinite(target) || target < 0) throw new CapcutError('layout screen requires --at SECONDS >= 0.', { code: 'BAD_TIME', exitCode: 2 });
  if (!Number.isFinite(dur) || dur <= 0) throw new CapcutError('layout screen requires media with a positive duration.', { code: 'BAD_TIME', exitCode: 2 });
  if (!Number.isFinite(src) || src < 0 || !Number.isFinite(srcDur) || srcDur <= 0) {
    throw new CapcutError('layout screen has an invalid source window.', { code: 'BAD_SOURCE_WINDOW', exitCode: 2 });
  }
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (value != null && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
      throw new CapcutError(`layout screen has an invalid ${name}.`, { code: 'BAD_DIMENSIONS', exitCode: 2 });
    }
  }
  if (mediaDuration != null && (!Number.isFinite(Number(mediaDuration)) || Number(mediaDuration) <= 0)) {
    throw new CapcutError('layout screen has an invalid media duration.', { code: 'BAD_MEDIA_DURATION', exitCode: 2 });
  }
  if (mediaDuration != null && src + srcDur > Number(mediaDuration) / 1e6 + 1e-6) {
    throw new CapcutError('layout screen source window exceeds the probed media duration.', {
      code: 'BAD_SOURCE_WINDOW', exitCode: 2,
      details: { sourceStart: src, sourceDuration: srcDur, mediaDuration: Number(mediaDuration) / 1e6 }
    });
  }
  if (track == null || String(track).trim() === '') {
    throw new CapcutError('layout screen requires a destination track name.', { code: 'TRACK_REQUIRED', exitCode: 2 });
  }
  const operation = {
    op: FIELD_REPORT_OPERATIONS.screenLayout,
    contract: 'layout.screen.v1',
    media: path.resolve(media),
    at: target,
    duration: dur,
    src,
    srcDur,
    track,
    preset: 'screenRecording',
    frame: 'screen-frame',
    localize: Boolean(localize),
    ...(width != null ? { width: Number(width) } : {}),
    ...(height != null ? { height: Number(height) } : {}),
    ...(mediaDuration != null ? { mediaDuration: Number(mediaDuration) } : {}),
  };
  return { version: 1, name: 'layout-screen', operations: [operation] };
}

/**
 * Builder A/core contract for in-place A-roll recutting. `plan` is the normal arroll.py
 * plan, while `preserve` tells core to source-map anchored B-roll, layout, SFX, and music.
 */
export function buildCutRecutSpec({ projectDir, plan, planFile = null, media = null, force = false } = {}) {
  if (!projectDir) throw new CapcutError('cut --into requires a target project.', { exitCode: 2 });
  if (!plan || !Array.isArray(plan.timeline) || !plan.timeline.length) {
    throw new CapcutError('cut --into requires a non-empty arroll plan.', { code: 'CUT_PLAN_EMPTY', exitCode: 2 });
  }
  if (!media && !plan.media) {
    throw new CapcutError('cut --into requires the source media in the arroll plan.', { code: 'CUT_MEDIA_MISSING', exitCode: 2 });
  }
  const sourceMedia = path.resolve(media || plan.media);
  const operation = {
    op: FIELD_REPORT_OPERATIONS.cutRecut,
    contract: 'cut.recut.v1',
    into: path.resolve(projectDir),
    media: sourceMedia,
    plan: {
      media: sourceMedia,
      kept: plan.kept || [],
      timeline: plan.timeline,
      duration: plan.duration,
      lint: plan.lint || [],
      ...(plan.fps != null ? { fps: plan.fps } : {}),
      ...(plan.blocking_lint ? { blocking_lint: plan.blocking_lint } : {}),
    },
    audioRamps: (plan.handoff?.operations || []).filter(item => item?.op === 'clip.fade'),
    preserve: ['broll', 'layout', 'sfx', 'music'],
    retimeAnchored: true,
    force: Boolean(force),
    ...(planFile ? { planFile: path.resolve(planFile) } : {}),
  };
  return { version: 1, name: 'cut-recut', operations: [operation] };
}

export function statusPayload(capcut = capcutStatus(), { project = null, waitForClose = false, close = null } = {}) {
  const running = Boolean(capcut?.running);
  const pids = Array.isArray(capcut?.pids) ? capcut.pids.map(String) : [];
  return {
    version: 1,
    state: running ? 'running' : 'closed',
    running,
    closed: !running,
    pids,
    processes: Array.isArray(capcut?.processes) ? capcut.processes : [],
    openDraft: capcut?.openDraft || null,
    openDraftInfo: capcut?.openDraftInfo || null,
    capcut: { running, pids },
    waitForClose: Boolean(waitForClose),
    ...(project ? { project } : {}),
    ...(close ? { close } : {}),
  };
}

export function serializeCloseFailure(error) {
  const reason = error?.reason || error?.details?.reason;
  return {
    code: error?.code || 'CAPCUT_CLOSE_FAILED',
    exitCode: error?.exitCode ?? 2,
    message: error?.message || String(error),
    ...(reason ? { reason } : {}),
    ...(error?.details != null ? { details: error.details } : {}),
  };
}

function statusText(payload) {
  const pids = payload.pids.length ? ` (PID ${payload.pids.join(', ')})` : '';
  const line = `CapCut: ${payload.state}${pids}`;
  if (payload.closeFailure) return `${line}\nclose failed [${payload.closeFailure.code}]: ${payload.closeFailure.message}`;
  if (payload.waitForClose) return `${line}\nwait-for-close: ${payload.closed ? 'closed' : 'still running'}`;
  return line;
}

// Keep the Python handoff deliberately explicit. These are the only arroll.py options that
// belong to the analysis/plan step; --into/--in-place/--root and transaction-only flags stay
// in this Node process and must never leak into argparse.
const ARROLL_VALUE_OPTIONS = Object.freeze([
  ['keep', '--keep'],
  ['drop', '--drop'],
  ['lang', '--lang'],
  ['model', '--model'],
]);
const ARROLL_BOOLEAN_OPTIONS = Object.freeze([
  ['reindex', '--reindex'],
  ['noRepair', '--no-repair'],
  ['force', '--force'],
  ['dryRun', '--dry-run'],
]);

export function buildArrollArgs(args, media) {
  const forwarded = [String(media)];
  for (const [key, flag] of ARROLL_VALUE_OPTIONS) {
    if (args?.[key] != null) forwarded.push(flag, String(args[key]));
  }
  for (const [key, flag] of ARROLL_BOOLEAN_OPTIONS) {
    if (args?.[key]) forwarded.push(flag);
  }
  return forwarded;
}

async function runInPlaceCut(args, root, apply = applySpec) {
  if (args.inPlace) {
    if (args.into) throw new CapcutError('cut accepts either --into PROJECT or --in-place, not both.', { code: 'CUT_TARGET_CONFLICT', exitCode: 2 });
    args.into = '.';
  }
  if (!args.into) throw new CapcutError('cut --into requires PROJECT.', { code: 'MISSING_PROJECT', exitCode: 2 });
  if (args.project) throw new CapcutError('cut accepts either --project (new build) or --into (in-place recut), not both.', { code: 'CUT_TARGET_CONFLICT', exitCode: 2 });
  const media = args._[1];
  if (!media) throw new CapcutError('cut requires VIDEO.', { exitCode: 2 });
  const projectDir = resolveProject(args.into, root);
  const script = path.join(HERE, '..', 'tools', 'aroll.py');
  const forwarded = buildArrollArgs(args, media);
  const run = spawnSync('python3', [script, ...forwarded], { stdio: 'inherit' });
  if (run.error) throw new CapcutError(`could not run ${script}: ${run.error.message}`, { exitCode: 2 });
  if ((run.status ?? 1) !== 0) { process.exitCode = run.status ?? 1; return null; }

  // The first invocation without --keep/--drop is intentionally still the review handout.
  // This preserves the two-stage talking-head decision before any in-place mutation.
  if (!args.keep && !args.drop) return null;
  const mediaPath = path.resolve(media);
  const planPath = path.join(path.dirname(mediaPath), `${path.basename(mediaPath).replace(/\.[^.]+$/, '')}.plan.json`);
  if (!fs.existsSync(planPath)) {
    throw new CapcutError(`aroll.py did not write its plan: ${planPath}`, { code: 'CUT_PLAN_MISSING', exitCode: 2 });
  }
  const plan = readJson(planPath);
  const spec = buildCutRecutSpec({
    projectDir,
    plan,
    planFile: planPath,
    media: mediaPath,
    force: Boolean(args.force),
  });
  return print({ plan: planPath, result: apply(projectDir, spec, {
    dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning),
    backup: !args.noBackup, label: 'cut-recut'
  }) }, true);
}

export async function main(argv, dependencies = {}) {
  loadEnv();
  const command = argv[0];
  if (command === 'cut' && (argv.includes('--into') || argv.includes('--in-place'))) {
    const cutArgs = parseArgs(argv);
    const cutRoot = cutArgs.root ? path.resolve(cutArgs.root) : DEFAULT_ROOT;
    return runInPlaceCut(cutArgs, cutRoot, dependencies.applySpec || applySpec);
  }
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
    const rows = Object.entries(p.layouts).map(([name, l]) => ({ name, description: l.description }))
      .concat([{ name: 'background', description: p.background.description }]);
    if (p.screenRecording) rows.push({ name: 'screenRecording', description: p.screenRecording.description });
    return print(rows, true);
  }
  if (command === 'harvest') {
    const { harvestDrafts, writeHarvest, DEFAULT_HARVEST } = await import('./harvest.mjs');
    const names = args.projects ? String(args.projects).split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const catalogue = harvestDrafts(root, names);
    const dest = args.out ? path.resolve(args.out) : DEFAULT_HARVEST;
    if (!args.plan) writeHarvest(catalogue, dest);
    return print({ wrote: args.plan ? null : dest, ...catalogue }, true);
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
    try {
      return print(closeCapcut({ timeoutMs: args.timeout ? Number(args.timeout) : 25000 }), true);
    } catch (error) {
      if (!args.json) throw error;
      const payload = statusPayload(capcutStatus({ root }), { waitForClose: true });
      payload.closeFailure = serializeCloseFailure(error);
      payload.ok = false;
      process.exitCode = payload.closeFailure.exitCode;
      return print(payload, true);
    }
  }
  if (command === 'status') {
    let project = null;
    if (args.project) project = resolveProject(args.project, root);
    let close = null;
    let failure = null;
    if (args.waitForClose) {
      try {
        close = closeCapcut({ timeoutMs: args.timeout ? Number(args.timeout) : 25000 });
      } catch (error) {
        failure = serializeCloseFailure(error);
      }
    }
    const payload = statusPayload(capcutStatus({ root }), { project, waitForClose: Boolean(args.waitForClose), close });
    if (failure) {
      payload.ok = false;
      payload.closeFailure = failure;
      process.exitCode = failure.exitCode;
    } else {
      payload.ok = true;
    }
    return args.json || args.waitForClose ? print(payload, true) : print(statusText(payload));
  }
  if (command === 'review') {
    if (!args.project) throw new CapcutError('review requires --project NAME.', { exitCode: 2 });
    const projectDir = resolveProject(args.project, root);
    const { reviewProject } = await import('./review.mjs');
    return print(reviewProject(projectDir, {
      outputRoot: path.resolve(args.outputRoot || args.out || 'outputs'),
      id: args.id,
      fps: args.fps != null ? Number(args.fps) : 6,
      width: args.width != null ? Number(args.width) : 240,
    }), true);
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
      localize: !args.noLocalize,
      generated: Boolean(args.generated),
      derivedFrom: args.derivedFrom ? path.resolve(args.derivedFrom) : null,
      derivedOffset: args.derivedOffset != null ? Number(args.derivedOffset) : null,
      allowEphemeral: Boolean(args.allowEphemeral),
      dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning)
    }), true);
  }
  if (command === 'projects') return print(listProjects(root), args.json);
  if (command === 'init-spec') {
    const data = `${JSON.stringify(EXAMPLE_SPEC, null, 2)}\n`;
    if (args.output) { fs.writeFileSync(path.resolve(args.output), data); return print(`Wrote ${path.resolve(args.output)}`); }
    return process.stdout.write(data);
  }

  const NEEDS_PROJECT = new Set([
    'inspect', 'doctor', 'snapshot', 'history', 'restore', 'sync', 'scenes',
    'pace', 'logo', 'endcard', 'zoom', 'wrap', 'polish', 'layout', 'add',
    'replace-media', 'localize', 'trim', 'shift', 'remove', 'volume', 'fade', 'keyframe',
    'preview', 'diff', 'apply', 'timeline', 'finish', 'music'
  ]);
  if (!NEEDS_PROJECT.has(command)) throw new CapcutError(`Unknown command: ${command}\n\n${HELP}`, { exitCode: 2 });
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
    let rows = describeScenes(projectDir, await trackIndex(projectDir, args.track),
                              Boolean(args.transcript));
    if (args.name) {
      const needle = String(args.name).toLowerCase();
      rows = rows.filter(r => (r.desc || '').toLowerCase().includes(needle)
        || (r.media || '').toLowerCase().includes(needle)
        || (r.id || '').toLowerCase().includes(needle));
    }
    return print(rows, true);
  }
  if (command === 'pace') {
    const { pacePlan } = await import('./pace.mjs');
    const hasAction = args.auto || args.at != null;
    if (!hasAction) {                                     // read-only: the plan
      const doc = await loadWorking(projectDir);
      const rows = pacePlan(doc, { track: await trackIndex(projectDir, args.track),
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
    const paceTrack = await trackIndex(projectDir, args.track);
    const spec = { version: 1, name: 'pace', operations: [{ op: 'pace',
      ...(set.length ? { set } : {}), ...(args.auto ? { auto: true } : {}),
      ...(paceTrack != null ? { track: paceTrack } : {}),
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
        const doc = await loadWorking(projectDir);
        const scenes = sig.talkingHeadScenes(doc, await trackIndex(projectDir, args.track),
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
      const doc = await loadWorking(projectDir);
      const mapper = sig.sourceToTimeline(doc, await trackIndex(projectDir, args.track));
      let hits = [];
      if (args.transcript === true) {
        throw new CapcutError('wrap takes --words FILE (a word-level transcript json), not a bare --transcript.', { exitCode: 2 });
      }
      const wordsFile = args.words ? path.resolve(args.words) : findWhisperCache(doc);
      if (wordsFile) {
        const tr = readJson(wordsFile);
        if (!Array.isArray(tr.segments)) {
          throw new CapcutError(
            'wrap --words wants a Whisper transcript with segments[].words, not an .aroll.json. '
            + 'The cache is ~/Downloads/.video-index/<stem>.whisper-*.json (written by `capcutctl cut`).',
            { exitCode: 2 });
        }
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
    const { assertFirstPictureProof } = await import('./finish.mjs');
    assertFirstPictureProof(await loadWorking(projectDir));
    const polishTrack = await trackIndex(projectDir, args.track);
    const spec = { version: 1, name: 'polish',
                   operations: [{ op: 'polish', ...(args.lead ? { lead: Number(args.lead) } : {}),
                                  ...(polishTrack != null ? { track: polishTrack } : {}),
                                  ...(args.noTransitions ? { noTransitions: true } : {}),
                                  ...(args.motivated ? { motivated: true } : {}),
                                  ...(args.noInteractions ? { noInteractions: true } : {}) }] };
    return print(applySpec(projectDir, spec, options), true);
  }
  if (command === 'timeline') {
    const { renderTimeline } = await import('./timeline.mjs');
    const doc = await loadWorking(projectDir);
    const view = renderTimeline(doc, { width: args.width ? Number(args.width) : 64 });
    if (args.json) return print(view, true);
    return print(view.text);
  }
  if (command === 'finish' || command === 'music') {
    const { assertFirstPictureProof, finishScorecard, finishText } = await import('./finish.mjs');
    const doc = await loadWorking(projectDir);
    const score = finishScorecard(doc, { projectDir, width: args.width ? Number(args.width) : 64 });
    const wantMusic = command === 'music' || (command === 'finish' && args.music && !args.noMusic);
    const wantPolish = command === 'finish' && args.polish;
    if ((wantMusic || wantPolish) && !args.plan) assertFirstPictureProof(doc);
    if (args.plan || (!wantMusic && !wantPolish && command === 'finish')) {
      if (args.json) return print(score, true);
      return print(finishText(score));
    }
    const ops = [];
    if (wantMusic) {
      const { prepareMusic, DEFAULT_MUSIC_VOLUME } = await import('./music.mjs');
      const prepared = await prepareMusic(projectDir, doc, {
        regen: Boolean(args.regen),
        volume: args.volume != null ? Number(args.volume) : DEFAULT_MUSIC_VOLUME,
        prompt: args.prompt || undefined,
        dryRun: Boolean(args.dryRun),
      });
      const off = prepared.align?.offset || 0;
      score.musicPrepared = {
        generated: prepared.generated,
        wouldGenerate: prepared.wouldGenerate,
        dryRun: Boolean(args.dryRun),
        file: prepared.file,
        beats: prepared.beats.length,
        align: prepared.align,
      };
      if (!args.dryRun) {
        ops.push({
          op: 'music',
          file: prepared.file,
          duration: prepared.duration,
          volume: prepared.volume,
          srcOffset: off < 0 ? -off : 0,
          at: off > 0 ? off : 0,
          fadeIn: 0.4,
          fadeOut: 1.2,
        });
      }
    }
    if (wantPolish) {
      const polishTrack = await trackIndex(projectDir, args.track);
      ops.push({ op: 'polish', motivated: true, ...(polishTrack != null ? { track: polishTrack } : {}) });
    }
    if (!ops.length) {
      if (args.dryRun && wantMusic) return print({ dryRun: true, score, result: null }, true);
      if (args.json) return print(score, true);
      return print(finishText(score));
    }
    const result = applySpec(projectDir, { version: 1, name: command, operations: ops }, options);
    if (args.json) return print({ score, result }, true);
    return print(JSON.stringify({ ...result, music: score.musicPrepared || score.music }, null, 2));
  }
  if (command === 'layout') {
    const name = args._[1];
    if (!name) throw new CapcutError('layout requires a name: split-screen | circle | background | broll | screen | auto | audit | list', { exitCode: 2 });
    const layoutsMod = await import('./layouts.mjs');
    const { buildLayoutSpec } = layoutsMod;
    layoutsMod.setCoreLoader(await import('./core.mjs'));
    if (name === 'audit' || (name === 'auto' && args.plan)) {
      const doc = await loadWorking(projectDir);
      return print(layoutsMod.layoutAudit(doc, await trackIndex(projectDir, args.track)), true);
    }
    if (name === 'screen') {
      if (args.at == null || !args.media) {
        throw new CapcutError('layout screen requires --at SECONDS and --media FILE.', { exitCode: 2 });
      }
      const { probeMedia } = await import('./create.mjs');
      const media = path.resolve(args.media);
      let probe;
      try {
        probe = probeMedia(media);
      } catch (error) {
        if (args.width && args.height && args.mediaDuration != null) {
          probe = { width: Number(args.width), height: Number(args.height), duration: Math.round(Number(args.mediaDuration) * 1e6) };
        } else throw error;
      }
      const duration = args.dur != null ? Number(args.dur) : Number(probe.duration) / 1e6;
      const spec = buildScreenLayoutSpec({
        media,
        at: Number(args.at),
        duration,
        sourceStart: args.src != null ? Number(args.src) : 0,
        sourceDuration: args.srcDur != null ? Number(args.srcDur) : duration,
        width: probe.width,
        height: probe.height,
        mediaDuration: probe.duration,
        track: args.track ?? 'screen',
        localize: !args.noLocalize,
      });
      if (args.plan) return print(spec, true);
      return print(applySpec(projectDir, spec, options), true);
    }
    const spec = buildLayoutSpec(projectDir, name, {
      segments: args.segments ? String(args.segments).split(',').map(s => s.trim()).filter(Boolean) : null,
      at: args.at ? String(args.at).split(',').map(Number) : null,
      track: await trackIndex(projectDir, args.track),
      row: args.row, scale: args.scale, seam: args.noSeam ? false : undefined,
      overlay: args.noOverlay ? false : undefined,
      includeTemplate: Boolean(args.includeTemplate)
    });
    if (name === 'auto' && !(spec.operations || []).length) {
      return print({ changed: 0, note: 'every principal clip already has the layout its B-roll implies.', audit: spec.__audit }, true);
    }
    return print(applySpec(projectDir, spec, options), true);
  }
  if (command === 'add') {
    if (!args.media) throw new CapcutError('add requires --media FILE.', { exitCode: 2 });
    if (args.at == null || args.dur == null) throw new CapcutError('add requires --at SECONDS and --dur SECONDS.', { exitCode: 2 });
    if (args.track == null) throw new CapcutError('add requires --track NAME (creates) or --track N (existing).', { exitCode: 2 });
    const { probeMedia } = await import('./create.mjs');
    let probe;
    try {
      probe = probeMedia(path.resolve(args.media));
    } catch (e) {
      if (args.width && args.height && args.mediaDuration != null) {
        probe = { width: Number(args.width), height: Number(args.height), duration: Math.round(Number(args.mediaDuration) * 1e6) };
      } else throw e;
    }
    let cover = null;
    if (args.cover) {
      const [a, b] = String(args.cover).split(/[-:,]/).map(Number);
      if (!(b > a)) throw new CapcutError('--cover expects IN-OUT in source seconds.', { exitCode: 2 });
      cover = [a, b];
    }
    const op = {
      op: 'clip.add',
      media: path.resolve(args.media),
      at: Number(args.at),
      duration: Number(args.dur),
      // default to the START of the media, not the timeline position — `add --at 30`
      // used to begin 30s into a file the user had just picked.
      src: args.src != null ? Number(args.src) : (cover ? cover[0] : 0),
      srcDur: args.srcDur != null ? Number(args.srcDur) : undefined,
      cover,
      track: args.track,
      volume: args.volume != null ? Number(args.volume) : 1,
      desc: args.desc || '',
      width: probe.width,
      height: probe.height,
      mediaDuration: probe.duration,
      localize: !args.noLocalize,
      generated: Boolean(args.generated),
      derivedFrom: args.derivedFrom ? path.resolve(args.derivedFrom) : null,
      derivedOffset: args.derivedOffset != null ? Number(args.derivedOffset) : null,
      allowEphemeral: Boolean(args.allowEphemeral)
    };
    const result = applySpec(projectDir, { version: 1, name: 'add', operations: [op] }, options);
    const added = (result.result || []).find(g => g.group === 'root')?.operations?.[0];
    if (added?.id) {
      added.layout = `capcutctl layout broll --project ${args.project} --at ${added.at} --track ${added.track}`;
    }
    return print(result, true);
  }
  if (command === 'replace-media') {
    const file = args.file || args.media;
    if (!file) throw new CapcutError('replace-media requires --file FILE.', { exitCode: 2 });
    if (args.at == null && !args.segments) throw new CapcutError('replace-media requires --at SECONDS or --segments ID.', { exitCode: 2 });
    const { probeMedia } = await import('./create.mjs');
    const { loadProject } = await import('./core.mjs');
    let selector;
    if (args.segments) selector = { id: String(args.segments).split(',')[0].trim() };
    else {
      const doc = loadProject(projectDir).groups.find(g => g.name === 'root').doc;
      const us = Math.round(Number(args.at) * 1e6);
      const hits = [];
      for (const [ti, track] of (doc.tracks || []).entries()) {
        if (track.type !== 'video') continue;
        if (track.flag === 0) continue;
        if (/^\d+$/.test(String(args.track || '')) && ti !== Number(args.track)) continue;
        if (args.track && !/^\d+$/.test(String(args.track)) && track.name !== String(args.track)) continue;
        for (const s of track.segments || []) {
          const tr = s.target_timerange;
          if (tr && tr.start <= us && us < tr.start + tr.duration) hits.push(s);
        }
      }
      if (hits.length !== 1) {
        throw new CapcutError(`replace-media: ${hits.length} clips cover ${args.at}s. Pass --track NAME|N or --segments ID.`, { exitCode: 2 });
      }
      selector = { id: hits[0].id };
    }
    let probe;
    try {
      probe = probeMedia(path.resolve(file));
    } catch (e) {
      if (args.width && args.height && args.mediaDuration != null) {
        probe = { width: Number(args.width), height: Number(args.height), duration: Math.round(Number(args.mediaDuration) * 1e6) };
      } else throw e;
    }
    const op = {
      op: 'replace.media',
      selector,
      path: path.resolve(file),
      retime: Boolean(args.retime),
      localize: !args.noLocalize,
      width: probe.width,
      height: probe.height,
      mediaDuration: probe.duration,
      generated: Boolean(args.generated),
      derivedFrom: args.derivedFrom ? path.resolve(args.derivedFrom) : null,
      derivedOffset: args.derivedOffset != null ? Number(args.derivedOffset) : null,
      allowEphemeral: Boolean(args.allowEphemeral)
    };
    return print(applySpec(projectDir, { version: 1, name: 'replace-media', operations: [op] }, options), true);
  }
  if (command === 'localize') {
    return print(applySpec(projectDir, { version: 1, name: 'localize', operations: [{ op: 'media.localize' }] }, options), true);
  }
  if (command === 'trim' || command === 'shift' || command === 'remove' || command === 'volume' || command === 'keyframe' || command === 'fade') {
    const { loadProject } = await import('./core.mjs');
    const { resolveClip } = await import('./add.mjs');
    const doc = loadProject(projectDir).groups.find(g => g.name === 'root').doc;
    const selector = args.segments
      ? { id: String(args.segments).split(',')[0].trim() }
      : { id: resolveClip(doc, { at: args.at != null ? Number(args.at) : undefined, track: args.track, id: args.id }).segment.id };
    if (command === 'remove') {
      return print(applySpec(projectDir, { version: 1, name: 'remove', operations: [{ op: 'segment.remove', selector }] }, options), true);
    }
    if (command === 'volume') {
      if (args.level == null) throw new CapcutError('volume requires --level 0..1', { exitCode: 2 });
      return print(applySpec(projectDir, { version: 1, name: 'volume', operations: [{ op: 'segment.patch', selector, set: { volume: Number(args.level) } }] }, options), true);
    }
    if (command === 'trim') {
      let src = null;
      if (args.src) {
        const [a, b] = String(args.src).split(/[-:,]/).map(Number);
        if (!(b > a)) throw new CapcutError('--src expects IN-OUT in source seconds', { exitCode: 2 });
        src = [a, b];
      } else if (args.start != null && args.dur != null) {
        src = [Number(args.start), Number(args.start) + Number(args.dur)];
      } else {
        throw new CapcutError('trim requires --src IN-OUT or --start S --dur S', { exitCode: 2 });
      }
      return print(applySpec(projectDir, { version: 1, name: 'trim', operations: [{ op: 'clip.trim', selector, src }] }, options), true);
    }
    if (command === 'shift') {
      if (args.by == null) throw new CapcutError('shift requires --by SECONDS', { exitCode: 2 });
      return print(applySpec(projectDir, { version: 1, name: 'shift', operations: [{
        op: 'clip.shift', selector, by: Number(args.by)
      }] }, options), true);
    }
    if (command === 'fade') {
      const op = { op: 'clip.fade', selector,
        in: args.in != null ? Number(args.in) : 0,
        out: args.out != null ? Number(args.out) : 0 };
      if (args.plan) return print(op, true);
      return print(applySpec(projectDir, { version: 1, name: 'fade', operations: [op] }, options), true);
    }
    if (command === 'keyframe') {
      const op = { op: 'keyframe.scale', selector, at: args.at != null ? Number(args.at) : undefined,
        to: args.to != null ? Number(args.to) : undefined, hold: args.hold != null ? Number(args.hold) : undefined,
        ramp: args.ramp != null ? Number(args.ramp) : undefined, track: args.track };
      if (args.plan) {
        return print(op, true);
      }
      return print(applySpec(projectDir, { version: 1, name: 'keyframe', operations: [op] }, options), true);
    }
  }
  if (command === 'preview') {
    const out = args.out || 'preview.mp4';
    const script = path.join(HERE, '..', 'tools', 'frame_qa.py');
    const fps = args.fps == null ? 6 : Number(args.fps);
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new CapcutError('preview requires --fps greater than zero.', { code: 'BAD_FPS', exitCode: 2 });
    }
    const previewArgs = [script, '--project', projectDir, '--preview', path.resolve(out),
      '--fps', String(fps)];
    if (args.from != null) previewArgs.push('--from', String(args.from));
    if (args.to != null) previewArgs.push('--to', String(args.to));
    const r = spawnSync('python3', previewArgs, { stdio: 'inherit' });
    if (r.error) throw new CapcutError(`could not run ${script}: ${r.error.message}`, { exitCode: 2 });
    process.exit(r.status ?? 1);
  }
  if (command === 'diff') {
    const { listSnapshots } = await import('./core.mjs');
    const { summarizeProject, diffSummaries } = await import('./diff.mjs');
    let otherDir = args.against ? resolveProject(args.against, root) : null;
    if (args.snapshot && !otherDir) {
      const snaps = listSnapshots(projectDir);
      const hit = snaps.find(s => (s.name || s).includes(String(args.snapshot)));
      if (!hit) throw new CapcutError(`no snapshot matching ${args.snapshot}`, { exitCode: 2 });
      otherDir = hit.path || hit;
    }
    if (!otherDir) throw new CapcutError('diff requires --against NAME or --snapshot NAME', { exitCode: 2 });
    return print(diffSummaries(summarizeProject(otherDir), summarizeProject(projectDir)), true);
  }
  if (command === 'apply') {
    if (!args.spec) throw new CapcutError('apply requires --spec FILE.', { exitCode: 2 });
    return print(applySpec(projectDir, readJson(path.resolve(args.spec)), options), true);
  }
  throw new CapcutError(`Unknown command: ${command}\n\n${HELP}`, { exitCode: 2 });
}
