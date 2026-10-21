import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CapcutError, BUILD_STATE_RELATIVE, allSegments, capcutStatus, loadWorkingDoc } from './core.mjs';
import { reviewContentRange } from './review.mjs';
import { pythonForTool } from './python.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const fail = (message) => { throw new CapcutError(message, { exitCode: 2 }); };
/** The code leads the message too, so a caller matching the text keeps working. */
const failCode = (code, message, details) => { throw new CapcutError(`${code}: ${message}`, { code, exitCode: 2, details }); };
const r3 = n => Math.round(n * 1000) / 1000;
// The export may differ from the edit by this much (container rounding, the last frame).
const DURATION_TOLERANCE_S = 0.15;
function run(command, args, timeout = 60000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) fail(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout.trim();
}
export function checkExport(probe, expectedDuration, staged = null) {
  const duration = Number(probe?.format?.duration);
  const video = probe?.streams?.some(s => s.codec_type === 'video');
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0 || !video || !Number.isFinite(duration)
      || Math.abs(duration - expectedDuration) > DURATION_TOLERANCE_S) {
    const what = !video ? 'has no video stream'
      : !Number.isFinite(duration) ? 'has no readable duration'
        : `is ${r3(duration)}s, the edit is ${r3(expectedDuration)}s`;
    failCode('EXPORT_DURATION_MISMATCH', `exported video does not match the timeline: it ${what}. `
      + (duration > expectedDuration
        ? 'A longer export usually means parked or overhanging clips past the edit (Preset 3 leftovers, a clip running past the ender): remove them, then timeline.set the duration. '
        : '')
      + (staged ? `Staged export kept at ${staged}.` : ''),
    { expected: expectedDuration, actual: Number.isFinite(duration) ? duration : null, staged });
  }
  return duration;
}

const ffprobeJson = file => JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
const fileSize = file => (fs.existsSync(file) ? fs.statSync(file).size : 0);

/**
 * Wait for CapCut to finish writing the staged export: three polls at one size, then one probe.
 * Only a probe that cannot read the file yet (ffprobe or JSON failure) keeps waiting; a file that
 * probes cleanly at the wrong length refuses at once (EXPORT_DURATION_MISMATCH) — it will not
 * change by waiting. EXPORT_TIMEOUT is for a file that never settles or never probes.
 */
export async function waitForStagedExport(staged, expected, {
  probe = ffprobeJson, size = fileSize, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, timeoutMs = 600000, intervalMs = 1000,
} = {}) {
  const deadline = now() + timeoutMs;
  let priorSize = -1, stable = 0;
  while (now() < deadline) {
    await sleep(intervalMs);
    const bytes = size(staged);
    stable = bytes > 0 && bytes === priorSize ? stable + 1 : 0; priorSize = bytes;
    if (stable < 3) continue;
    let probed;
    try { probed = probe(staged); } catch { continue; }
    checkExport(probed, expected, staged);
    return probed;
  }
  return failCode('EXPORT_TIMEOUT', `existing output preserved; inspect ${staged}`, { staged, expected });
}

/**
 * Clips that end past the edit. CapCut exports to the end of the draft, so a parked parts bin
 * (the Preset 3 leftover) or a clip overhanging the ender ships as a dead tail.
 */
export function tailPastContent(doc, expectedSeconds, { toleranceS = DURATION_TOLERANCE_S } = {}) {
  const limitUs = Math.round((expectedSeconds + toleranceS) * 1e6);
  const segments = allSegments(doc || {}).filter(({ segment }) => {
    const t = segment.target_timerange;
    return t && Number.isFinite(t.start) && Number.isFinite(t.duration) && t.start + t.duration > limitUs;
  }).map(({ track, trackIndex, segment }) => ({
    id: segment.id, track: track.name || `#${trackIndex}`, desc: segment.desc || null,
    start: r3(segment.target_timerange.start / 1e6), end: r3((segment.target_timerange.start + segment.target_timerange.duration) / 1e6),
  }));
  const declared = Number.isFinite(doc?.duration) ? doc.duration : 0;
  const lastEnd = Math.max(declared, ...allSegments(doc || {}).map(({ segment }) =>
    (segment.target_timerange?.start || 0) + (segment.target_timerange?.duration || 0)));
  return { past: lastEnd > limitUs, draftEnd: r3(lastEnd / 1e6), expected: expectedSeconds, segments };
}

export function assertNoTailPastContent(doc, expectedSeconds) {
  const tail = tailPastContent(doc, expectedSeconds);
  if (!tail.past) return tail;
  const list = tail.segments.slice(0, 8).map(s => `${s.id} on ${s.track} (${s.start}–${s.end}s)`).join(', ');
  return failCode('EXPORT_TAIL_PAST_CONTENT', `the draft runs to ${tail.draftEnd}s but the edit ends at ${expectedSeconds}s, `
    + `and CapCut would export the tail. ${tail.segments.length ? `Past the end: ${list}${tail.segments.length > 8 ? ', …' : ''}. ` : ''}`
    + 'Remove them (a spec with track.remove {"name": TRACK, "all": true} or segment.remove), then '
    + `timeline.set {"duration": ${expectedSeconds}}, and export again.`, tail);
}

/** Read the build record (profile file, style) the final gate should judge with. */
function readBuildState(projectDir) {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir, BUILD_STATE_RELATIVE), 'utf8')); } catch { return {}; }
}
export function exportGrid(media, out, times) {
  const python = pythonForTool('export_grid.py');
  return JSON.parse(run(python.executable, [path.join(HERE, '..', 'tools', 'export_grid.py'),
    '--media', path.resolve(media), '--out', path.resolve(out), ...(times ? ['--times', String(times)] : [])], 180000));
}
/**
 * X-ray the published export: every frame and sample measured, verdicts against the draft.
 * A FAIL verdict is the X-ray's finding, not an export failure, so its exit 1 is reported
 * back in the result rather than thrown; only exit 2 (the tool could not run) throws.
 */
export function exportXray(video, projectDir, outDir, { speech = false } = {}) {
  const python = pythonForTool('xray.py');
  const argv = [path.join(HERE, '..', 'tools', 'xray.py'), 'scan', path.resolve(video),
    '--project', projectDir, '--json', ...(outDir ? ['--out', path.resolve(outDir)] : []), ...(speech ? ['--speech'] : [])];
  const result = spawnSync(python.executable, argv, { encoding: 'utf8', timeout: 900000 });
  if (result.error || ![0, 1].includes(result.status)) {
    fail(`EXPORT_XRAY_FAILED: ${result.error?.message || String(result.stderr || '').trim().split('\n').pop()}`);
  }
  const report = JSON.parse(result.stdout);
  const count = verdict => report.verdicts.filter(v => v.verdict === verdict).length;
  return { dir: report.out, score: report.score, sheets: report.sheets,
    fail: count('FAIL'), unknown: count('UNKNOWN'), note: count('NOTE'), notChecked: count('NOT CHECKED'), pass: count('PASS') };
}
export async function exportProject(projectDir, args) {
  if (process.platform !== 'darwin') fail('EXPORT_MACOS_ONLY');
  if (!args.out || path.extname(args.out).toLowerCase() !== '.mp4') fail('export requires --out FILE.mp4');
  const out = path.resolve(args.out);
  if (fs.existsSync(out) && !args.overwrite) fail('EXPORT_EXISTS: use --overwrite to replace the requested output');
  const state = capcutStatus();
  if (state.unknown) fail('EXPORT_APP_STATE_UNKNOWN');
  if (state.openDraft && !state.openDraft.startsWith(projectDir + path.sep)) fail('EXPORT_WRONG_PROJECT: another project is open');
  // The ledger-restored copy: a CapCut save strips the follow ender's identity, and the edit's
  // end (what the export must match) would then stop 3s short of the ender.
  const { doc, restored } = loadWorkingDoc(projectDir);
  const expected = reviewContentRange(doc, projectDir).end;
  assertNoTailPastContent(doc, expected);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // ponytail: CapCut has no public headless renderer; a bounded native UI bridge uses its real engine.
  const stageName = `capcutctl-${randomUUID()}`;
  const staged = run('swift', [path.join(HERE, 'native', 'export.swift'), path.basename(projectDir), stageName]);
  if (path.basename(staged) !== `${stageName}.mp4` || !path.isAbsolute(staged)) fail('EXPORT_BAD_STAGE_PATH');
  const probe = await waitForStagedExport(staged, expected);
  run('ffmpeg', ['-v', 'error', '-i', staged, '-f', 'null', '-'], 180000);
  const grid = args.grid ? exportGrid(staged, typeof args.grid === 'string' ? args.grid : `${out}.grid.png`, args.times) : null;
  const temp = path.join(path.dirname(out), `.${stageName}.mp4`);
  fs.copyFileSync(staged, temp, fs.constants.COPYFILE_EXCL);
  if (args.overwrite) fs.renameSync(temp, out);
  else {
    try { fs.linkSync(temp, out); }
    catch (error) { fs.unlinkSync(temp); fail(`EXPORT_PUBLISH_FAILED: ${error.message}; staged export preserved at ${staged}`); }
    fs.unlinkSync(temp);
  }
  fs.unlinkSync(staged);
  const result = { video: out, duration: Number(probe.format.duration), grid: grid?.grid || null, xray: null,
    renderer: 'CapCut native', uiBridge: true };
  if (args.noGate) {
    result.xray = args.xray ? exportXray(out, projectDir, args.xray) : null;
    result.gate = { skipped: '--no-gate: not a final export' };
    return result;
  }
  return finalGates(result, { projectDir, doc, args, metaRestored: restored.length });
}

/**
 * The profile the final gate judges with: the one the build used (build.json profile/style),
 * --profile/--style overriding. A recorded file that is gone, or a style it no longer has,
 * falls back to the default profile with a WARN rather than failing the export.
 */
async function finalProfile(projectDir, args) {
  const { loadProfile, applyStyle } = await import('./profile.mjs');
  const state = projectDir ? readBuildState(projectDir) : {};
  const file = args.profile ? path.resolve(args.profile) : (state.profile || null);
  const style = args.style ?? state.style ?? null;
  try {
    return { profile: applyStyle(loadProfile({ file }), style), file, style, warning: null };
  } catch (error) {
    if (!['PROFILE_MISSING', 'STYLE_UNKNOWN'].includes(error.code)) throw error;
    return { profile: loadProfile(), file, style, warning: `${error.code}: ${error.message} Gated with the default profile.` };
  }
}

const REVIEW_SKIPS = new Set(['REVIEW_ROUNDS_EXHAUSTED', 'REVIEW_DISCARDED_AGAIN']);

/** The last counted review a skip points at (error.lastFile), and that round's accepted blockers. */
function reviewSkip(error) {
  const file = error.lastFile || error.details?.lastFile || null;
  let blockers = [];
  if (file) {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      blockers = (record.issues || []).filter(i => i.blocker && i.decision === 'accepted').map(i => `${i.id} ${i.issue}`);
    } catch { /* named without its blockers */ }
  }
  return { file, blockers };
}

/**
 * The finalization path every export takes: X-ray the file (with its own transcript), gate the
 * draft plus the X-ray, then — only if the gates pass — the Gemini watch-review, folded back in.
 * A FAIL leaves the export in place and sets the verdict; the CLI exits 1 on it.
 */
export async function finalGates(result, { projectDir, doc, args, xray = exportXray, gate = null, review = null, metaRestored = 0 }) {
  const { gateReport, foldXray, finaliseReport, writeGateRecord, noteRestoredMeta } = await import('./gate.mjs');
  const { profile, file: profileFile, style, warning } = await finalProfile(projectDir, args);
  const xrayDir = typeof args.xray === 'string' ? args.xray : `${result.video.replace(/\.mp4$/i, '')}.xray`;
  result.xray = xray(result.video, projectDir, xrayDir, { speech: true });
  // The pauses edit.json declared (build.json records them) plus any --pause given here.
  const recorded = projectDir ? readBuildState(projectDir).pauses : null;
  const pauses = [...new Set([...(Array.isArray(recorded) ? recorded : []),
    ...[args.pause].flat().filter(v => v != null && v !== true).flatMap(v => String(v).split(','))]
    .map(Number).filter(Number.isFinite))];
  const report = gate ? gate({ doc, projectDir, profile, xrayDir, pauses })
    : foldXray(gateReport(doc, { projectDir, profile, pauses }), xrayDir, projectDir, { profile, draft: doc, pauses });
  report.profile = { name: profile.name, file: profileFile, style };
  if (warning) report.checks.push({ id: 'gate-profile', level: 'WARN', ok: false, message: warning, value: null, target: null });
  noteRestoredMeta(report, metaRestored);
  finaliseReport(report);
  if (report.verdict !== 'FAIL' && !args.noReview) {
    const { reviewVideo, foldReview } = await import('./review-video.mjs');
    try {
      const record = await (review || reviewVideo)({ media: result.video, projectDir, speech: path.join(xrayDir, 'speech.json'),
        script: args.script ? path.resolve(args.script) : null, model: args.reviewModel || 'sonnet' });
      result.review = { file: record.file, round: record.round, model: record.model, status: record.status,
        blockers: record.issues.filter(i => i.blocker).map(i => `${i.id} ${i.issue}`), notes: record.issues.length };
      foldReview(report, record.file);
    } catch (error) {
      // Out of review rounds, or Gemini failed the sound check twice: the export has no Gemini
      // review, which the hand-off must say. Neither is a defect in the video, so both warn.
      if (REVIEW_SKIPS.has(error.code)) {
        const last = reviewSkip(error);
        result.review = { skipped: `${error.code}: ${error.message}`, code: error.code, lastFile: last.file, blockers: last.blockers };
        report.checks.push({ id: 'review', level: 'WARN', ok: false, value: null, target: null,
          message: `${error.code}: no Gemini review of this export; last counted review ${last.file || 'none'}`
            + `${last.blockers.length ? `, accepted blockers: ${last.blockers.join('; ')}` : ', no accepted blockers'} — name it in the hand-off` });
      } else {
        result.review = { error: `${error.code || 'REVIEW_FAILED'}: ${error.message}` };
        report.checks.push({ id: 'review', level: 'FAIL', ok: false, message: result.review.error, value: null, target: null });
      }
    }
  } else if (args.noReview) result.review = { skipped: '--no-review' };
  finaliseReport(report);
  report.recorded = writeGateRecord(projectDir, report);
  result.gate = { verdict: report.verdict, failed: report.failed, warned: report.warned, record: report.recorded,
    checks: report.checks.filter(c => !c.ok).map(c => `${c.level} ${c.id}: ${c.message}`) };
  return result;
}
