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
  return { video: out, duration: Number(probe.format.duration), grid: grid?.grid || null, renderer: 'CapCut native', uiBridge: true };
}
