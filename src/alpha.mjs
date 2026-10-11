import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CapcutError, requireBinary } from './core.mjs';

/**
 * CapCut composites ProRes 4444 alpha as PREMULTIPLIED: on screen = rgb + (1 - a) * background.
 * A straight-alpha file keeps full colour under near-zero alpha (a glow's tail: 255,255,0 at
 * a = 1/255), and CapCut adds that colour to everything behind it — a callout's interior turned
 * solid yellow over a dark terminal (a real edit, 2026-10-11). Every alpha overlay we write
 * goes through here, so the file is premultiplied and reads the same in CapCut and in qa.
 */

/** ffmpeg filter chain that premultiplies an RGBA stream (ProRes encode follows). */
export const PREMULTIPLY_FILTER = 'format=rgba,premultiply=inplace=1';

/** prores_ks args shared by every alpha overlay we write. */
export const PRORES_ALPHA_ARGS = Object.freeze(['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
  '-alpha_bits', '16', '-vendor', 'apl0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']);

/** Tolerance in 8-bit levels: premultiplied colour never exceeds its alpha. */
const LEAK_MARGIN = 3;

function probe(file) {
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
  const s = out.streams?.[0] || {};
  return { codec: s.codec_name, pixFmt: s.pix_fmt || '', width: Number(s.width), height: Number(s.height),
    duration: Number(out.format?.duration) || 0 };
}

export function isAlphaProres(file) {
  try {
    const p = probe(file);
    return p.codec === 'prores' && /^yuva/.test(p.pixFmt);
  } catch { return false; }
}

/**
 * Pixels whose colour exceeds their alpha, sampled at three instants. 0 = premultiplied (safe).
 * Returns { leak, total, ratio, times }.
 */
export function straightAlphaLeak(file, { samples = [0.2, 0.5, 0.8] } = {}) {
  requireBinary('ffmpeg', 'checking an overlay\'s alpha');
  const { width: w, height: h, duration } = probe(file);
  let leak = 0, total = 0;
  const times = samples.map(f => Math.max(0, Math.min(duration - 0.05, duration * f)));
  for (const t of times) {
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: w * h * 4 + 1024 });
    for (let i = 0; i + 3 < buf.length; i += 4) {
      const a = buf[i + 3];
      if (Math.max(buf[i], buf[i + 1], buf[i + 2]) > a + LEAK_MARGIN) leak++;
    }
    total += w * h;
  }
  return { leak, total, ratio: total ? leak / total : 0, times };
}

/**
 * Rewrite an alpha ProRes file premultiplied, in place (atomic rename). Idempotent: a file that
 * already reads premultiplied is left alone. Returns { file, changed, before, after }.
 */
export function premultiplyFile(file, { force = false } = {}) {
  requireBinary('ffmpeg', 'premultiplying an overlay');
  file = path.resolve(file);
  if (!isAlphaProres(file)) throw new CapcutError(`${path.basename(file)} is not ProRes with alpha.`, { code: 'NOT_ALPHA_PRORES', exitCode: 2 });
  const before = straightAlphaLeak(file);
  if (!force && before.leak === 0) return { file, changed: false, before, after: before };
  const tmp = path.join(path.dirname(file), `.${path.basename(file, path.extname(file))}.premult${path.extname(file)}`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0',
    '-vf', PREMULTIPLY_FILTER, ...PRORES_ALPHA_ARGS, tmp]);
  const after = straightAlphaLeak(tmp);
  if (after.leak > 0) {
    fs.rmSync(tmp, { force: true });
    throw new CapcutError(`${path.basename(file)} still leaks colour after premultiplying (${after.leak} px).`, { code: 'ALPHA_LEAK', exitCode: 1 });
  }
  fs.renameSync(tmp, file);
  return { file, changed: true, before, after };
}

/**
 * Every alpha ProRes clip on the timeline that would paint its hidden colour in CapCut.
 * Cached per file (size + mtime) in <project>/.capcutctl/alpha-cache.json, so a gate re-run is cheap.
 * Returns [{ file, leak, ratio }] for the leaking ones only.
 */
export function projectAlphaLeaks(doc, projectDir, { resolve }) {
  const used = new Set((doc.tracks || []).flatMap(t => (t.segments || []).map(s => s.material_id)));
  const files = [...new Set((doc.materials?.videos || []).filter(m => used.has(m.id) && /\.(mov|mxf)$/i.test(m.path || ''))
    .map(m => resolve(m.path, projectDir)).filter(f => f && fs.existsSync(f)))];
  const cacheFile = projectDir ? path.join(projectDir, '.capcutctl', 'alpha-cache.json') : null;
  let cache = {};
  try { cache = cacheFile ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}; } catch { cache = {}; }
  const out = [];
  for (const file of files) {
    const st = fs.statSync(file);
    const key = `${st.size}:${Math.round(st.mtimeMs)}`;
    let hit = cache[file]?.key === key ? cache[file] : null;
    if (!hit) {
      hit = { key, leak: 0, ratio: 0 };
      if (isAlphaProres(file)) { const r = straightAlphaLeak(file); hit.leak = r.leak; hit.ratio = r.ratio; }
      cache[file] = hit;
    }
    if (hit.leak > 0) out.push({ file, leak: hit.leak, ratio: hit.ratio });
  }
  if (cacheFile) { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1)); } catch { /* read-only is fine */ } }
  return out;
}
