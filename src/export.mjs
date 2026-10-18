import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CapcutError, loadProject, capcutStatus } from './core.mjs';
import { reviewContentRange } from './review.mjs';
import { pythonForTool } from './python.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const fail = (message) => { throw new CapcutError(message, { exitCode: 2 }); };
function run(command, args, timeout = 60000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) fail(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout.trim();
}
export function checkExport(probe, expectedDuration) {
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0 || !probe.streams?.some(s => s.codec_type === 'video') || !Number.isFinite(duration)
      || Math.abs(duration - expectedDuration) > .15) fail('EXPORT_DURATION_MISMATCH: exported video does not match the timeline');
  return duration;
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
  const loaded = loadProject(projectDir);
  const doc = loaded.groups.find(g => g.name.startsWith('timeline:'))?.doc || loaded.groups[0]?.doc;
  const expected = reviewContentRange(doc, projectDir).end;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // ponytail: CapCut has no public headless renderer; a bounded native UI bridge uses its real engine.
  const stageName = `capcutctl-${randomUUID()}`;
  const staged = run('swift', [path.join(HERE, 'native', 'export.swift'), path.basename(projectDir), stageName]);
  if (path.basename(staged) !== `${stageName}.mp4` || !path.isAbsolute(staged)) fail('EXPORT_BAD_STAGE_PATH');
  const deadline = Date.now() + 600000;
  let priorSize = -1, stable = 0, probe;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const size = fs.existsSync(staged) ? fs.statSync(staged).size : 0;
    stable = size > 0 && size === priorSize ? stable + 1 : 0; priorSize = size;
    if (stable < 3) continue;
    try {
      probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', staged]));
      checkExport(probe, expected); break;
    } catch { probe = null; }
  }
  if (!probe) fail(`EXPORT_TIMEOUT: existing output preserved; inspect ${staged}`);
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
  return finalGates(result, { projectDir, doc, args });
}

/**
 * The finalization path every export takes: X-ray the file (with its own transcript), gate the
 * draft plus the X-ray, then — only if the gates pass — the Gemini watch-review, folded back in.
 * A FAIL leaves the export in place and sets the verdict; the CLI exits 1 on it.
 */
export async function finalGates(result, { projectDir, doc, args, xray = exportXray, gate = null, review = null }) {
  const { gateReport, foldXray, finaliseReport, writeGateRecord } = await import('./gate.mjs');
  const { loadProfile } = await import('./profile.mjs');
  const profile = loadProfile();
  const xrayDir = typeof args.xray === 'string' ? args.xray : `${result.video.replace(/\.mp4$/i, '')}.xray`;
  result.xray = xray(result.video, projectDir, xrayDir, { speech: true });
  const pauses = [args.pause].flat().filter(v => v != null).flatMap(v => String(v).split(',')).map(Number).filter(Number.isFinite);
  const report = gate ? gate({ doc, projectDir, profile, xrayDir, pauses })
    : foldXray(gateReport(doc, { projectDir, profile }), xrayDir, projectDir, { profile, draft: doc, pauses });
  if (report.verdict !== 'FAIL' && !args.noReview) {
    const { reviewVideo, foldReview } = await import('./review-video.mjs');
    try {
      const record = await (review || reviewVideo)({ media: result.video, projectDir, speech: path.join(xrayDir, 'speech.json'),
        script: args.script ? path.resolve(args.script) : null, model: args.reviewModel || 'sonnet' });
      result.review = { file: record.file, round: record.round, model: record.model, status: record.status,
        blockers: record.issues.filter(i => i.blocker).map(i => `${i.id} ${i.issue}`), notes: record.issues.length };
      foldReview(report, record.file);
    } catch (error) {
      if (error.code === 'REVIEW_ROUNDS_EXHAUSTED') result.review = { skipped: error.message };
      else {
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
