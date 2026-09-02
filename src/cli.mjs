import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { pythonForTool } from './python.mjs';
import {
  CapcutError,
  DEFAULT_ROOT,
  applySpec,
  createSnapshot,
  doctor,
  inspectProject,
  listSnapshots,
  preflight,
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
  capcutctl --version
  capcutctl version
  capcutctl cut VIDEO [--keep 0,2-9|--drop 1,7] [--order 0,2,3] [--trim-beat ID:out=-1.16]
                      [--recover-beat ID:out=0.8]
                      [--review decisions.json] [--project NAME] [--into PROJECT|--in-place] [--lang ar]
                      — talking-head cleanup and reviewed A-roll assembly. Use --order
                        for an exact kept-beat permutation, --trim-beat for safe inward
                        acoustic trims, opt-in word/acoustic outward recovery, or --review
                        for a source-tokened decision file.
                        --into recuts an existing project transactionally.
  capcutctl qa --project NAME [--times 3,9,15|--at-cuts|--at-scenes|--at-broll]
               [--guide 960] [--sheet] [--label L] [--cut-window S]
                      — targeted native-resolution pixel QA; --at-cuts samples both
                        sides of each cut. --preview is a separate streamed proxy job
                        and cannot be combined with selectors, --times, --sheet, or --expect.
  capcutctl find "agent running" --media FILE [--shows|--says] [--context]
                      — when is it on screen / when was it said.

  capcutctl preflight [--root PATH] [--json]   — will this work on this machine? deps, assets, tools, disk
  capcutctl projects [--root PATH] [--json]
  capcutctl rm --project NAME [--dry-run] [--force-running]   — to .recycle_bin, registry entry dropped
  capcutctl close [--timeout MS] [--json]      — quit CapCut and wait for it to exit
  capcutctl status [--json] [--wait-for-close [--timeout MS]]
                                report CapCut state; optionally request quit and return a branchable close result
  capcutctl review --project NAME [--out DIR] [--id NAME] [--fps 6] [--width 240]
                      — write outputs/<id>/proxy.mp4, edl.json, and contact-sheet.png (never CapCut export)
  capcutctl new --project NAME [--media FILE] [--scenes 0:6,6:12,12:18]
                [--from TEMPLATE] [--blank] [--canvas 1080x1920] [--fps 30] [--dry-run] [--force-running]
                [--no-localize] [--generated] [--derived-from ORIGINAL [--derived-offset S]] [--allow-ephemeral]
                [--new-timeline-id] [--width W --height H --duration S]   (probe override when ffprobe is missing)
  capcutctl inspect --project NAME_OR_PATH [--root PATH] [--json]
  capcutctl doctor --project NAME_OR_PATH [--root PATH] [--json]
  capcutctl snapshot --project NAME_OR_PATH [--label NAME]
  capcutctl history --project NAME_OR_PATH
  capcutctl restore --project NAME_OR_PATH --snapshot NAME [--force-running] [--no-backup]
  capcutctl sync --project NAME_OR_PATH [--dry-run] [--force-running] [--no-backup]
  capcutctl apply --project NAME_OR_PATH --spec FILE [--dry-run] [--force-running] [--no-backup]
  capcutctl add --project NAME --media FILE --at S --dur S --track NAME|N
                [--src S] [--src-dur S | --cover IN-OUT] [--volume 0] [--desc TEXT] [--no-localize]
                [--generated] [--derived-from ORIGINAL [--derived-offset S]] [--allow-ephemeral]
                [--width W --height H --media-duration S]   (probe override when ffprobe is missing)
  capcutctl replace-media --project NAME --file FILE --at S --track NAME|N | --segments ID
                [--retime] [--no-localize] [--generated] [--derived-from ORIGINAL] [--allow-ephemeral]
                [--width W --height H --media-duration S]
  capcutctl localize --project NAME   — copy outside videos into the project (fixes Link media)
  capcutctl trim --project NAME --at S --track NAME|N | --segments ID  --src IN-OUT | --start S --dur S
  capcutctl shift --project NAME --at S --track NAME|N | --segments ID  --by SECONDS
  capcutctl remove --project NAME --at S --track NAME|N | --segments ID
  capcutctl volume --project NAME --at S --track NAME|N | --segments ID  --level 0
  capcutctl fade --project NAME --at S --track NAME|N | --segments ID  [--in 0.08] [--out 0.12] [--plan]
  capcutctl keyframe --project NAME --at S --track NAME|N | --segments ID  [--to 2.4] [--hold 1.6] [--ramp 0.3] [--plan]
  capcutctl preview --project NAME --out preview.mp4 [--fps 6] [--from S] [--to S]
                    [--resolution 360x640|--native] [--no-cache] [--no-grade]
                      — lightweight streamed proxy; defaults to 360x640 and never writes
                        one PNG per frame. Use qa for bounded seam/pixel evidence.
  capcutctl diff --project NAME --against NAME|--snapshot NAME
  capcutctl harvest [--root PATH] [--projects A,B] [--out FILE] [--plan]
  capcutctl init-spec [--output FILE]
  capcutctl contract [--json]                  — the machine-readable command/option surface
                                                 the skills repo validates its docs against

  capcutctl scenes --project NAME_OR_PATH [--track N] [--transcript] [--name SUBSTR]
  capcutctl layout split-screen --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--no-overlay] [--dry-run]
  capcutctl layout circle       --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--no-overlay] [--dry-run]
  capcutctl layout full-face    --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--dry-run]
  capcutctl layout background   --project NAME_OR_PATH [--at SECONDS] [--include-template] [--dry-run]
  capcutctl layout broll        --project NAME_OR_PATH --at SECONDS --track N --row ROW [--scale S] [--no-seam]
  capcutctl layout screen       --project NAME_OR_PATH --at SECONDS --media FILE
                                [--dur S] [--src S] [--src-dur S] [--track NAME] [--no-localize] [--plan] [--dry-run]
                                [--width W --height H --media-duration S]
                                — add a centred rl2 screen recording through the layout.screen contract
  capcutctl brands              list known brands, their spoken aliases, and which have a logo
  capcutctl logo                --project NAME_OR_PATH --logo FILE[,FILE…]|DIR | --brand NAME[,NAME…] | --auto
                                [--at S[,S…]] [--name N[,N…]] [--scale] [--hold] [--pos x,y] [--words FILE]
                                [--track N] [--plain] [--no-sfx] [--plan]
                                the artwork is the primitive: any image pops; --brand/--auto time
                                themselves off the transcript. Glow reveal by default, --plain for the pop.
  capcutctl endcard             --project NAME_OR_PATH [--text Follow] [--at S] [--hold S] [--scale S] [--no-sfx]
  capcutctl zoom                --project NAME_OR_PATH --at S[,S...] | --auto [--min-length 2.5] [--to 1.15] [--hold 1.6]
                                [--track N] [--plan]
  capcutctl wrap                --project NAME_OR_PATH [--words TRANSCRIPT.json] [--text Follow] [--only BRANDS]
                                [--zoom-at S[,S…]|--no-zoom] [--track N] [--glow] [--no-sfx] [--plan]
                                brand logos from what he says + the endcard + face push-ins, in one pass
  capcutctl pace                --project NAME_OR_PATH [--track N] [--max 100] [--min-gap 5.0]
                                no flags = print the plan; --auto applies it
                                --at T --speed X | --at T --cover IN-OUT for one clip
  capcutctl polish              --project NAME_OR_PATH [--lead 0.14] [--track N] [--motivated] [--dry-run]
                                [--no-transitions] [--no-sfx] [--no-interactions]
                                transitions ride the principal (talking-head) track; it is sliced to fit
                      — his transitions + matching SFX. --motivated: only on picture
                        changes (B-roll shot or layout class), not every A-roll splice.
                        Also clicks every rectangle/arrow/circle callout (Enter / click / select).
                        rl2 click/typing events on the chopped B-roll (Mouse click / Typing).
                        --no-interactions skips that pass.
  capcutctl grade               --project NAME [--measure] [--plan] [--strength 1] [--samples 3]
                                [--apply] [--dry-run]
                                colour. --measure prints each source's scope as numbers
                                (black point, white point, saturation, R-B white balance);
                                --plan solves sliders against one house target so every
                                source matches; --apply writes CapCut's own Adjust materials.
                                --set 'FILE:brightness=0.05,white=0.2' overrides one source.
  capcutctl timeline            --project NAME [--width 64] [--json]   — ASCII dump of the stacked timeline
  capcutctl finish              --project NAME [--plan] [--music] [--polish] [--regen]
                                [--volume 0.08] [--prompt TEXT] [--track N] [--width 64] [--json]
                                scorecard + ASCII. --plan is read-only. --music generates
                                a Lyria bed timed to picture changes and beat-aligned.
                                --polish runs motivated polish. Voice is never recut.
  capcutctl music               --project NAME [--plan] [--regen] [--volume 0.08] [--prompt TEXT] [--json]
                                generate / place the instrumental bed (what finish --music runs)
  capcutctl layout auto         --project NAME_OR_PATH [--plan]   — split-screen where B-roll covers, full face where it does not
  capcutctl layout audit        --project NAME_OR_PATH            — what each clip is vs what it should be
  capcutctl layout list

Layouts are exact, measured geometry (presets/layouts.json) — not judgement:
  split-screen  subject fills the BOTTOM half from y=960, indigo bar on the seam
  circle        subject as the upper-left circular avatar, inside the white ring
  full-face     subject at scale 1, no mask — the whole picture
  background    finds every circle scene and builds the blurred backdrop under it
  screen        a centred rl2 window recording inside the indigo frame (layout screen)

New projects clone "Preset 3" by default: leftover preset clips are parked 30s after
the talking head (a parts bin — do not delete them). Follow/CTA is written on the
talking head, never on that leftover. Use --blank for an empty timeline — it needs no
local draft, so it works on a machine that has never made one.

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

Portability — what is bundled and what is yours:
  The overlay artwork the built-in layouts need ships in assets/, so a fresh clone can run
  split-screen / circle / screen with no setup. The SFX and transition palette cannot: those
  are CapCut's own effect/music cache, minted on the machine where you downloaded the sound.
  polish SKIPS any sound that is not on this machine and names it, instead of writing a
  reference that fails validation. Bring your own with either:
    CAPCUTCTL_ASSET_DIR=DIR    overlay artwork, searched before the bundled assets/
    CAPCUTCTL_PRESET_DIR=DIR   your own sfx.json / brands.json / layouts.json; each file
                               falls back to the bundled preset when absent
  ffmpeg and ffprobe are required (cut, qa, find, preview, music, review).
  Run "capcutctl preflight" to see all of it at once.

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
  const repeatValueKeys = new Set(['trimBeat', 'recoverBeat', 'set']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (['json', 'dryRun', 'forceRunning', 'noBackup', 'help', 'noOverlay', 'blank', 'includeTemplate', 'newTimelineId',
         'transcript', 'noTransitions', 'noSeam', 'auto', 'plan', 'noSfx', 'noZoom', 'retime', 'localize',
         'noLocalize', 'motivated', 'regen', 'music', 'noMusic', 'polish', 'noInteractions',
         'waitForClose', 'force', 'reindex', 'noRepair', 'inPlace',
         'generated', 'allowEphemeral', 'measure', 'apply', 'native', 'noCache', 'noGrade',
         'glow', 'plain'].includes(key)) result[key] = true;
    else {
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new CapcutError(`Missing value for ${token}.`, { exitCode: 2 });
      const value = argv[++i];
      if (repeatValueKeys.has(key)) {
        if (!Array.isArray(result[key])) result[key] = [];
        result[key].push(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Where command output goes. A test that wants to read it must set this rather than
 * monkeypatching `process.stdout.write`: under Node 20's test runner that hook also carries the
 * runner's OWN binary reporting protocol, so a test capturing it got the protocol bytes mixed
 * into the JSON it was trying to parse — green on Node 24, `Unexpected token '\x0f'` on Node 20.
 */
let SINK = null;
export function setOutput(write) {
  const previous = SINK;
  SINK = write;
  return () => { SINK = previous; };
}
const emit = text => (SINK ? SINK(text) : process.stdout.write(text));

function print(value, asJson = false) {
  if (asJson || typeof value !== 'string') emit(`${JSON.stringify(value, null, 2)}\n`);
  else emit(`${value}\n`);
}

function printDoctor(report, asJson) {
  if (asJson) return print(report, true);
  emit(`Project: ${report.project}\nActive timeline: ${report.activeTimelineId || 'root only'}\nErrors: ${report.errors}  Warnings: ${report.warnings}\n`);
  for (const item of report.issues) emit(`${item.level === 'error' ? 'ERROR' : 'WARN '} ${item.code}: ${item.message}\n`);
  if (!report.issues.length) emit('OK: no issues found.\n');
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

const r3 = n => Math.round(n * 1000) / 1000;
const sigRules = sig => sig.sigPresets().rules;

async function findWhisperCache(doc, principalIndex = null) {
  const cache = path.join(os.homedir(), 'Downloads', '.video-index');
  if (!fs.existsSync(cache)) return null;
  const names = fs.readdirSync(cache).filter(n => n.includes('.whisper'));
  if (!names.length) return null;

  // An index file is only the right one if its stem IS the media's stem — `startsWith` alone
  // matched `screen.whisper-*.json` for every `…__screen.mp4`, so a project's B-roll answered
  // for the talking head and detection ran against a transcript with no speech in it.
  const exact = stem => names.filter(n => n.startsWith(`${stem}.`)).sort()[0] || null;
  const stemsFor = file => {
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    const out = [base];
    // `localizeMedia` prefixes the parent folder ("Downloads__F7ED1ECA-…") and may append an
    // 8-hex collision tag; the index is keyed on the ORIGINAL stem.
    const unprefixed = base.replace(/^[^_]+__/, '');
    if (unprefixed !== base && unprefixed.length >= 8) out.push(unprefixed);
    for (const v of [...out]) {
      const bare = v.replace(/__[0-9a-f]{8}$/, '');
      if (bare !== v) out.push(bare);
    }
    return out;
  };

  // The talking head first, always. Brand detection maps HIS words onto the timeline, so a
  // screen recording's transcript is never the right answer even when one exists.
  const ordered = [];
  try {
    const { principalTrack } = await import('./polish.mjs');
    const { track } = principalTrack(doc, principalIndex);
    const byId = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
    for (const seg of track.segments || []) {
      const m = byId.get(seg.material_id);
      if (m?.path) ordered.push(m);
    }
  } catch { /* no principal track — fall through to every video */ }
  for (const m of doc.materials?.videos || []) if (m.path) ordered.push(m);

  for (const m of ordered) {
    if (m.type && m.type !== 'video') continue;
    for (const stem of stemsFor(m.path)) {
      const hit = exact(stem);
      if (hit) return path.join(cache, hit);
    }
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
      ...(Array.isArray(plan.order) ? { order: plan.order } : {}),
      timeline: plan.timeline,
      duration: plan.duration,
      lint: plan.lint || [],
      ...(plan.source_token != null ? { source_token: plan.source_token } : {}),
      ...(plan.sourceToken != null ? { sourceToken: plan.sourceToken } : {}),
      ...(plan.editorial ? { editorial: plan.editorial } : {}),
      ...(plan.adjustments ? { adjustments: plan.adjustments } : {}),
      ...(plan.repairs ? { repairs: plan.repairs } : {}),
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
  const state = capcut?.state || (capcut?.unknown ? 'unknown' : capcut?.running ? 'running' : 'closed');
  const running = state === 'running';
  const closed = state === 'closed';
  const unknown = state === 'unknown';
  const pids = Array.isArray(capcut?.pids) ? capcut.pids.map(String) : [];
  return {
    version: 1,
    state,
    running,
    closed,
    unknown,
    ...(capcut?.probeError ? { probeError: capcut.probeError } : {}),
    pids,
    processes: Array.isArray(capcut?.processes) ? capcut.processes : [],
    openDraft: capcut?.openDraft || null,
    openDraftInfo: capcut?.openDraftInfo || null,
    capcut: { state, running, closed, unknown, pids },
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
  ['order', '--order'],
  ['review', '--review'],
  ['trimBeat', '--trim-beat'],
  ['recoverBeat', '--recover-beat'],
  ['lang', '--lang'],
  ['model', '--model'],
  ['fps', '--fps'],
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
    if (Array.isArray(args?.[key])) {
      for (const value of args[key]) forwarded.push(flag, String(value));
    } else if (args?.[key] != null) {
      forwarded.push(flag, String(args[key]));
    }
  }
  for (const [key, flag] of ARROLL_BOOLEAN_OPTIONS) {
    if (args?.[key]) forwarded.push(flag);
  }
  return forwarded;
}

function runPython(interpreter, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, [script, ...args], { stdio: 'inherit' });
    const forward = signal => { if (child.exitCode == null && child.signalCode == null) child.kill(signal); };
    const onInt = () => forward('SIGINT');
    const onTerm = () => forward('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
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
  const python = pythonForTool('aroll.py');
  const run = spawnSync(python.executable, [script, ...forwarded], { stdio: 'inherit' });
  if (run.error) throw new CapcutError(`could not run ${script}: ${run.error.message}`, { exitCode: 2 });
  if ((run.status ?? 1) !== 0) { process.exitCode = run.status ?? 1; return null; }

  // The first invocation without --keep/--drop is intentionally still the review handout.
  // This preserves the two-stage talking-head decision before any in-place mutation.
  const hasEditorialDecision = Boolean(args.keep || args.drop || args.order || args.review
    || (Array.isArray(args.trimBeat) && args.trimBeat.length));
  if (!hasEditorialDecision) return null;
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
  if (command === '--version' || command === 'version') {
    return print(readJson(path.join(HERE, '..', 'package.json')).version);
  }
  if (command === 'cut' && (argv.includes('--into') || argv.includes('--in-place'))) {
    const cutArgs = parseArgs(argv);
    const cutRoot = cutArgs.root ? path.resolve(cutArgs.root) : DEFAULT_ROOT;
    return runInPlaceCut(cutArgs, cutRoot, dependencies.applySpec || applySpec);
  }
  if (command === 'cut' || command === 'qa' || command === 'find') {
    const tool = { cut: 'aroll.py', qa: 'frame_qa.py', find: 'find.py' }[command];
    const script = path.join(HERE, '..', 'tools', tool);
    // Resolve and verify the interpreter first. A missing runtime is a named CapcutError
    // with an install line, never a ModuleNotFoundError traceback from a child process.
    // The argv goes in because some requirements are flag-triggered: find.py only imports
    // frame_qa, and so only needs NumPy and Pillow, when --strip asks for a contact sheet.
    const python = pythonForTool(tool, { argv: argv.slice(1) });
    let status;
    try { status = await runPython(python.executable, script, argv.slice(1)); }
    catch (error) { throw new CapcutError(`could not run ${script}: ${error.message}`, { exitCode: 2 }); }
    process.exitCode = status;
    return;
  }
  const args = parseArgs(argv);
  if (!command || args.help || command === 'help') return print(HELP);
  const root = args.root ? path.resolve(args.root) : DEFAULT_ROOT;

  if (command === 'layout' && args._[1] === 'list') {
    const { presets } = await import('./layouts.mjs');
    const p = presets();
    const rows = Object.entries(p.layouts).map(([name, l]) => ({ name, description: l.description }))
      .concat([{ name: 'background', description: p.background.description }]);
    // The row is named as `capcutctl layout <name>` accepts it; the preset key is screenRecording.
    if (p.screenRecording) rows.push({ name: 'screen', preset: 'screenRecording', description: p.screenRecording.description });
    return print(rows, true);
  }
  if (command === 'contract') {
    // The machine-readable command/option surface, for the skills repository and anything
    // else that documents this CLI. Always JSON: it exists to be parsed, not read.
    const { buildContract } = await import('./contract.mjs');
    const pkg = readJson(path.join(HERE, '..', 'package.json'));
    return print(buildContract({ version: pkg.version }), true);
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
    const unknown = Object.keys(args).find(key => !['_', 'root', 'project', 'json', 'waitForClose', 'timeout'].includes(key));
    if (unknown) throw new CapcutError(`Unknown status option: --${unknown}.`, { exitCode: 2 });
    if (args._.length !== 1) throw new CapcutError('status does not take positional arguments.', { exitCode: 2 });
    let timeoutMs = 25000;
    if (args.timeout != null) {
      timeoutMs = Number(args.timeout);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new CapcutError('status --timeout requires a non-negative number of milliseconds.', { exitCode: 2 });
      }
      if (!args.waitForClose) throw new CapcutError('status --timeout requires --wait-for-close.', { exitCode: 2 });
    }
    let project = null;
    if (args.project) project = resolveProject(args.project, root);
    let close = null;
    let failure = null;
    if (args.waitForClose) {
      try {
        close = closeCapcut({ timeoutMs });
      } catch (error) {
        failure = serializeCloseFailure(error);
      }
    }
    const payload = statusPayload(capcutStatus({ root }), { project, waitForClose: Boolean(args.waitForClose), close });
    if (failure) {
      payload.ok = false;
      payload.closeFailure = failure;
      process.exitCode = failure.exitCode;
    } else if (payload.unknown) {
      payload.ok = false;
      process.exitCode = 3;
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
      outputRoot: path.resolve(args.out || 'outputs'),
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
  if (command === 'preflight') {
    const unknown = Object.keys(args).find(key => !['_', 'root', 'json'].includes(key));
    if (unknown) throw new CapcutError(`Unknown preflight option: --${unknown}.`, { exitCode: 2 });
    if (args._.length !== 1) {
      throw new CapcutError('preflight does not take positional arguments.', { exitCode: 2 });
    }
    const report = preflight({ root });
    if (!report.ok) process.exitCode = 1;
    if (args.json) return print(report, true);
    const lines = [`capcutctl preflight — ${report.ok ? 'ready' : 'NOT ready'}`, ''];
    for (const c of report.checks) {
      const optional = c.blocking === false ? ' (optional)' : '';
      lines.push(`${c.ok ? '  ok  ' : '  --  '} ${c.name}${optional}: ${c.detail}`);
      if (c.fix) lines.push(`         fix: ${c.fix}`);
    }
    emit(`${lines.join('\n')}\n`);
    return;
  }
  if (command === 'projects') return print(listProjects(root), args.json);
  if (command === 'init-spec') {
    const data = `${JSON.stringify(EXAMPLE_SPEC, null, 2)}\n`;
    if (args.output) { fs.writeFileSync(path.resolve(args.output), data); return print(`Wrote ${path.resolve(args.output)}`); }
    return emit(data);
  }

  const NEEDS_PROJECT = new Set([
    'inspect', 'doctor', 'snapshot', 'history', 'restore', 'sync', 'scenes',
    'pace', 'logo', 'endcard', 'zoom', 'wrap', 'polish', 'layout', 'add',
    'replace-media', 'localize', 'trim', 'shift', 'remove', 'volume', 'fade', 'keyframe',
    'preview', 'diff', 'apply', 'timeline', 'finish', 'music', 'grade'
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
  if (command === 'grade') {
    const g = await import('./grade.mjs');
    const doc = await loadWorking(projectDir);
    if (args.measure) {
      return print({ target: g.TARGET, sources: g.measureSources(doc, projectDir, { samples: 4 }) }, true);
    }
    const plan = g.planGrade(doc, projectDir, {
      strength: args.strength != null ? Number(args.strength) : 1,
      samples: args.samples != null ? Number(args.samples) : 3,
    });
    // --set FILE:slider=v,slider=v  (repeatable) overrides whatever the solver proposed
    for (const raw of [].concat(args.set || [])) {
      const [file, list] = String(raw).split(':');
      const row = plan.sources.find(r => r.source === file || r.source.includes(file));
      if (!row) throw new CapcutError(`--set names "${file}", which is not a source in this project. Try \`capcutctl grade --project NAME --measure\`.`, { exitCode: 2 });
      for (const pair of String(list || '').split(',').filter(Boolean)) {
        const [k, v] = pair.split('=');
        row.sliders[k.trim()] = Number(v);
      }
    }
    if (!args.apply) return print(plan, true);
    const sources = Object.fromEntries(plan.sources
      .filter(r => Object.keys(r.sliders).length)
      .map(r => [r.source, r.sliders]));
    const spec = { version: 1, name: 'grade', operations: [{ op: 'grade.apply', sources }] };
    return print({ plan, applied: applySpec(projectDir, spec, options) }, true);
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
    // `logo` is the "with everything" verb, so the glow reveal is its default; --plain is the
    // measured two-key pop. `wrap` and the rest keep the pop unless --glow is asked for.
    if (command === 'logo') op.glow = !args.plain;
    else if (args.glow) op.glow = true;

    if (command === 'logo') {
      // The ARTWORK is the primitive. A "brand" is only a named lookup for one, so anything
      // that resolves to an image can be popped — a path, a list of paths, a folder of marks,
      // or a registered brand. Keying this on brands.json meant an agent had to register a
      // logo in a preset file before it could put it on screen, which is backwards.
      const brands = sig.brandPresets().brands;
      const list = v => String(v).split(',').map(x => x.trim()).filter(Boolean);
      const IMAGE = /\.(png|webp|gif|jpe?g)$/i;

      const expand = spec => {
        const resolved = path.resolve(spec.replace(/^~(?=$|\/)/, os.homedir()));
        if (!fs.existsSync(resolved)) {
          throw new CapcutError(`no such logo file: ${resolved}`, { code: 'NO_LOGO_ASSET', exitCode: 2 });
        }
        if (!fs.statSync(resolved).isDirectory()) return [resolved];
        const found = fs.readdirSync(resolved).filter(n => IMAGE.test(n)).sort()
          .map(n => path.join(resolved, n));
        if (!found.length) {
          throw new CapcutError(`no images in ${resolved} (looked for png/webp/gif/jpg).`,
            { code: 'NO_LOGO_ASSET', exitCode: 2 });
        }
        return found;
      };

      let marks;
      if (args.logo) {
        const files = list(args.logo).flatMap(expand);
        const names = args.name ? list(args.name) : [];
        if (names.length && names.length !== files.length) {
          throw new CapcutError(`--name has ${names.length} entries for ${files.length} logos; `
            + 'give one per logo or drop it and the filename is used.', { exitCode: 2 });
        }
        marks = files.map((file, i) => ({
          brand: names[i] || path.basename(file).replace(/\.[^.]+$/, ''), logo: file }));
      } else if (args.brand) {
        marks = list(args.brand).map(name => {
          const b = brands[name];
          if (!b) {
            throw new CapcutError(`unknown brand "${name}". Pass --logo PATH to use artwork that `
              + 'is not registered, or see `capcutctl brands`.', { exitCode: 2 });
          }
          return { brand: name, logo: b.logo };
        });
      } else if (!args.auto) {
        throw new CapcutError('logo needs --logo PATH (a file, a comma-separated list, or a '
          + 'folder), --brand NAME[,NAME…], or --auto to read the transcript.', { exitCode: 2 });
      }

      // Timing: explicit --at, else the transcript. Detection only knows about registered
      // brands, so an unregistered mark must carry its own --at.
      const ats = args.at != null ? list(args.at).map(Number) : null;
      if (ats && ats.some(Number.isNaN)) throw new CapcutError('--at wants seconds.', { exitCode: 2 });

      if (marks && ats) {
        if (ats.length !== 1 && ats.length !== marks.length) {
          throw new CapcutError(`--at has ${ats.length} times for ${marks.length} logos; give one `
            + 'each, or a single time to bring them all in together.', { exitCode: 2 });
        }
        marks.forEach((m, i) => { m.at = ats.length === 1 ? ats[0] : ats[i]; });
      } else {
        const doc = await loadWorking(projectDir);
        const principal = await trackIndex(projectDir, args.track);
        const mapper = sig.sourceToTimeline(doc, principal);
        const wordsFile = args.words ? path.resolve(args.words) : await findWhisperCache(doc, principal);
        if (!wordsFile) {
          throw new CapcutError('no word-level transcript for this project, so a logo cannot be '
            + 'timed automatically. Pass --at SECONDS, or --words <stem>.whisper-*.json.',
            { exitCode: 2 });
        }
        const tr = readJson(wordsFile);
        if (!Array.isArray(tr.segments)) {
          throw new CapcutError('--words wants a Whisper transcript with segments[].words, not an '
            + '.aroll.json.', { exitCode: 2 });
        }
        const hits = sig.detectBrands(tr, mapper,
          { only: marks ? marks.map(m => m.brand) : null });
        const at = new Map(hits.map(h => [h.brand, h.at]));
        if (!marks) {
          marks = hits.map(h => ({ brand: h.brand, logo: h.logo, at: h.at }));
        } else {
          const unheard = marks.filter(m => !at.has(m.brand));
          if (unheard.length) {
            throw new CapcutError(`never said, or not registered as a brand: `
              + `${unheard.map(m => m.brand).join(', ')}. Pass --at SECONDS for these, or add `
              + 'aliases in presets/brands.json in the form Whisper actually writes them.',
              { exitCode: 2 });
          }
          marks.forEach(m => { m.at = at.get(m.brand); });
        }
      }

      // One artwork is one mark, whatever it is called. Two registered brands can point at the
      // same file (chatgpt/openai), and a folder can hold the same image twice.
      const byArtwork = new Map();
      for (const m of marks.sort((a, b) => a.at - b.at)) {
        if (!byArtwork.has(m.logo)) byArtwork.set(m.logo, m);
      }
      let logos = [...byArtwork.values()];

      const noArt = logos.filter(l => !l.logo || !fs.existsSync(l.logo));
      logos = logos.filter(l => l.logo && fs.existsSync(l.logo));
      if (!logos.length) {
        throw new CapcutError(noArt.length
          ? `no artwork on disk for ${noArt.map(l => l.brand).join(', ')}.`
          : 'nothing to place: no brand in the transcript was recognised. `--plan` prints the '
            + 'detection; check the aliases match what Whisper actually wrote.', { exitCode: 2 });
      }

      const scales = args.scale ? list(args.scale).map(Number) : null;
      const holds = args.hold ? list(args.hold).map(Number) : null;
      const pos = args.pos ? list(args.pos).map(Number) : null;
      const pick = (arr, i) => (arr == null ? null : (arr.length === 1 ? arr[0] : arr[i]));
      op.logos = logos.map((l, i) => ({ brand: l.brand, at: r3(l.at), logo: l.logo,
        ...(pick(scales, i) != null ? { scale: pick(scales, i) } : {}),
        ...(pick(holds, i) != null ? { hold: pick(holds, i) } : {}),
        ...(pos ? { pos } : {}) }));
      if (!pos) sig.spreadOverlapping(op.logos, sigRules(sig));
      if (args.plan) {
        return print({ logos: op.logos, skippedNoArtwork: noArt.map(l => l.brand),
                       reveal: args.plain ? 'pop' : 'glow' }, true);
      }
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
      const wordsFile = args.words ? path.resolve(args.words) : await findWhisperCache(doc, await trackIndex(projectDir, args.track));
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
    const wantMusic = command === 'music' || (command === 'finish' && Boolean(args.music));
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
    if (!name) throw new CapcutError('layout requires a name: split-screen | circle | full-face | background | broll | screen | auto | audit | list', { exitCode: 2 });
    const layoutsMod = await import('./layouts.mjs');
    const { buildLayoutSpec } = layoutsMod;
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
      : { id: resolveClip(doc, { at: args.at != null ? Number(args.at) : undefined, track: args.track }).segment.id };
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
    const previewArgs = ['--project', projectDir, '--preview', path.resolve(out),
      '--fps', String(fps)];
    if (args.from != null) previewArgs.push('--from', String(args.from));
    if (args.to != null) previewArgs.push('--to', String(args.to));
    if (args.resolution != null) previewArgs.push('--resolution', String(args.resolution));
    if (args.native) previewArgs.push('--native');
    if (args.noCache) previewArgs.push('--no-cache');
    if (args.noGrade) previewArgs.push('--no-grade');
    const python = pythonForTool('frame_qa.py', { argv: previewArgs });
    let status;
    try { status = await runPython(python.executable, script, previewArgs); }
    catch (error) { throw new CapcutError(`could not run ${script}: ${error.message}`, { exitCode: 2 }); }
    process.exitCode = status;
    return;
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
