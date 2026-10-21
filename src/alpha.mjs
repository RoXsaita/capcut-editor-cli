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
    '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
  const s = out.streams?.[0] || {};
  const [num, den] = String(s.r_frame_rate || '').split('/').map(Number);
  return { codec: s.codec_name, pixFmt: s.pix_fmt || '', width: Number(s.width), height: Number(s.height),
    duration: Number(out.format?.duration) || 0, fps: den ? num / den : num || 0 };
}

export function isAlphaProres(file) {
  try {
    const p = probe(file);
    return p.codec === 'prores' && /^yuva/.test(p.pixFmt);
  } catch { return false; }
}

/** At most this many frames are read per file; a step of at most 0.25s (d/8 for a short clip). */
const MAX_SAMPLES = 12;

/**
 * The instants an alpha check reads: about 3%..97% of the clip, so an entrance or exit glow (the
 * first and last few frames, where a glow's tail is widest) is seen, not just the middle.
 */
export function alphaSampleTimes(duration) {
  const d = Math.max(0, Number(duration) || 0);
  if (!(d > 0)) return [0];
  const from = 0.03 * d, to = 0.97 * d;
  const step = Math.min(0.25, d / 8);
  let n = Math.floor((to - from) / step + 1e-9) + 1;
  if (to - (from + (n - 1) * step) > 1e-6) n += 1;           // always reach the exit
  n = Math.min(n, MAX_SAMPLES);
  if (n === 1) return [Math.round(from * 1000) / 1000];
  return Array.from({ length: n }, (_, i) => Math.round((from + (to - from) * i / (n - 1)) * 1000) / 1000);
}

/**
 * Pixels whose colour exceeds their alpha, over alphaSampleTimes (or `samples`, fractions of
 * the duration). 0 = premultiplied (safe). `any` stops at the first leaking frame, for callers
 * that only need yes or no. Returns { leak, total, ratio, times }.
 */
export function straightAlphaLeak(file, { samples = null, any = false } = {}) {
  requireBinary('ffmpeg', 'checking an overlay\'s alpha');
  const { width: w, height: h, duration, fps } = probe(file);
  let leak = 0, total = 0;
  // A seek past the last frame's start reads nothing: the latest instant is inside the last frame.
  const last = Math.max(0, duration - 1.5 / (fps > 0 ? fps : 25));
  const times = (samples ? samples.map(f => duration * f) : alphaSampleTimes(duration)).map(t => Math.max(0, Math.min(last, t)));
  const read = [];
  for (const t of times) {
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: w * h * 4 + 1024 });
    if (buf.length < w * h * 4) continue;                       // past the last frame
    read.push(t);
    let here = 0;
    for (let i = 0; i + 3 < buf.length; i += 4) {
      const a = buf[i + 3];
      if (Math.max(buf[i], buf[i + 1], buf[i + 2]) > a + LEAK_MARGIN) here++;
    }
    leak += here;
    total += w * h;
    if (any && here > 0) break;
  }
  return { leak, total, ratio: total ? leak / total : 0, times: read };
}

/**
 * Rewrite an alpha ProRes file premultiplied, in place (atomic rename). Idempotent: a file that
 * already reads premultiplied is left alone, and `force` on one refuses (premultiplying twice
 * darkens every soft edge). Audio and metadata ride along untouched.
 * Returns { file, changed, before, after }.
 */
export function premultiplyFile(file, { force = false } = {}) {
  requireBinary('ffmpeg', 'premultiplying an overlay');
  file = path.resolve(file);
  if (!isAlphaProres(file)) throw new CapcutError(`${path.basename(file)} is not ProRes with alpha.`, { code: 'NOT_ALPHA_PRORES', exitCode: 2 });
  const before = straightAlphaLeak(file);
  if (before.leak === 0) {
    if (force) {
      throw new CapcutError(`${path.basename(file)} is already premultiplied (no leaking pixel in ${before.times.length} frames); `
        + 'premultiplying it again would darken its soft edges.', { code: 'ALREADY_PREMULTIPLIED', exitCode: 2 });
    }
    return { file, changed: false, before, after: before };
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file, path.extname(file))}.premult${path.extname(file)}`);
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a?',
      '-vf', PREMULTIPLY_FILTER, ...PRORES_ALPHA_ARGS, '-c:a', 'copy', '-map_metadata', '0', '-movflags', '+faststart', tmp]);
    const after = straightAlphaLeak(tmp, { any: true });
    if (after.leak > 0) {
      throw new CapcutError(`${path.basename(file)} still leaks colour after premultiplying (${after.leak} px).`, { code: 'ALPHA_LEAK', exitCode: 1 });
    }
    fs.renameSync(tmp, file);
    return { file, changed: true, before, after };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Every alpha ProRes clip on the timeline that would paint its hidden colour in CapCut.
 * Cached per file (size + mtime) in <project>/.capcutctl/alpha-cache.json, so a gate re-run is cheap.
 * Returns { leaks: [{ file, leak, ratio }], unchecked: [{ file, reason }] }: the leaking files,
 * and the used .mov/.mxf files that are missing or could not be read (never a silent pass).
 */
const CACHE_VERSION = 'v2:';

export function projectAlphaLeaks(doc, projectDir, { resolve }) {
  const used = new Set((doc.tracks || []).flatMap(t => (t.segments || []).map(s => s.material_id)));
  const unchecked = [];
  const files = [];
  for (const m of doc.materials?.videos || []) {
    if (!used.has(m.id) || !/\.(mov|mxf)$/i.test(m.path || '')) continue;
    const file = resolve(m.path, projectDir);
    if (!file || !fs.existsSync(file)) { unchecked.push({ file: file || m.path, reason: 'missing' }); continue; }
    if (!files.includes(file)) files.push(file);
  }
  const cacheFile = projectDir ? path.join(projectDir, '.capcutctl', 'alpha-cache.json') : null;
  let cache = {};
  try { cache = cacheFile ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}; } catch { cache = {}; }
  const leaks = [];
  for (const file of files) {
    const st = fs.statSync(file);
    const key = `${CACHE_VERSION}${st.size}:${Math.round(st.mtimeMs)}`;
    let hit = cache[file]?.key === key ? cache[file] : null;
    if (!hit) {
      let p;
      try { p = probe(file); } catch (error) {
        unchecked.push({ file, reason: `unprobeable (${String(error.message || error).split('\n')[0]})` });
        continue;
      }
      hit = { key, leak: 0, ratio: 0 };
      if (p.codec === 'prores' && /^yuva/.test(p.pixFmt)) {
        try { const r = straightAlphaLeak(file, { any: true }); hit.leak = r.leak; hit.ratio = r.ratio; } catch (error) {
          unchecked.push({ file, reason: `unreadable (${String(error.message || error).split('\n')[0]})` });
          continue;
        }
      }
      cache[file] = hit;
    }
    if (hit.leak > 0) leaks.push({ file, leak: hit.leak, ratio: hit.ratio });
  }
  if (cacheFile) { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1)); } catch { /* read-only is fine */ } }
  return { leaks, unchecked };
}
