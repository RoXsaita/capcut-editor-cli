/**
 * mograph — rendered motion graphics for the typography CapCut's native tools do badly.
 *
 * Footage, cuts, layouts, camera moves and seams stay CapCut-native. What CapCut cannot do
 * well — kinetic Arabic type, counters, drawn callouts, the CTA card — is authored as a small,
 * deterministic HTML/JS template (mograph/templates/*.html, contract in mograph/runtime.js),
 * rendered frame by frame in headless Chromium, and imported as a `--generated` clip above
 * the picture. The clip is cropped to the union of the graphic's motion, so it is never a
 * full-frame overlay and its canvas position is exact. A sidecar records template, params and
 * anchor, so `mograph rerender` can fix a typo without touching timing or placement.
 *
 * Formats:
 *  - `prores`    ProRes 4444 with PREMULTIPLIED alpha (yuva444p10le) — the default; CapCut reads it premultiplied;
 *  - `png-still` the hold frame as a transparent PNG, for graphics whose motion is only a
 *                pop or a slide: CapCut animates it with native eased keys, fully editable;
 *  - `webm`      VP9 alpha — debugging in a browser only; CapCut import is not supported.
 * Every render is `importVerified: false` until the Mac acceptance checklist in
 * docs/mograph.md passes on the target CapCut build.
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CapcutError, requireBinary } from './core.mjs';
import { PREMULTIPLY_FILTER, PRORES_ALPHA_ARGS } from './alpha.mjs';
import { loadProfile } from './profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOGRAPH_DIR = path.join(HERE, '..', 'mograph');
export const TEMPLATE_DIR = path.join(MOGRAPH_DIR, 'templates');
export const FONT_DIR = path.join(MOGRAPH_DIR, 'fonts');
export const FORMATS = Object.freeze(['prores', 'png-still', 'webm']);
export const IMPORT_VERIFIED = false;

const fail = (code, message) => { throw new CapcutError(message, { code, exitCode: 2 }); };

/** Template ids are their file names; the first comment block is their documentation. */
export function listTemplates() {
  if (!fs.existsSync(TEMPLATE_DIR)) return [];
  return fs.readdirSync(TEMPLATE_DIR).filter(n => n.endsWith('.html')).sort().map(file => {
    const html = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
    const doc = html.match(/\/\*([\s\S]*?)\*\//)?.[1] || '';
    const lines = doc.split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean);
    return {
      id: file.replace(/\.html$/, ''),
      summary: lines[0] || '',
      params: (lines.find(l => l.startsWith('params:')) || '').replace(/^params:\s*/, ''),
      sfx: html.match(/sfx:\s*'([a-z]+)'/)?.[1] || null,
      motion: html.match(/motion:\s*'([a-z-]+)'/)?.[1] || 'rich',
    };
  });
}

export function templatePath(id) {
  if (!/^[a-z0-9-]+$/.test(String(id || ''))) fail('MOGRAPH_TEMPLATE', `bad template id "${id}"`);
  const file = path.join(TEMPLATE_DIR, `${id}.html`);
  if (!fs.existsSync(file)) {
    fail('MOGRAPH_TEMPLATE', `unknown template "${id}". Known: ${listTemplates().map(t => t.id).join(', ')}`);
  }
  return file;
}

/**
 * Playwright is resolved lazily: only mograph needs a browser. Order: the project's own
 * dependency, then a global install (`npm i -g playwright`). CAPCUTCTL_CHROMIUM points at a
 * specific Chromium/Chrome binary; on a Mac without Playwright's browsers, installed Google
 * Chrome is used through the `chrome` channel.
 */
export async function loadPlaywright() {
  const attempts = [];
  for (const name of ['playwright', 'playwright-core']) {
    try { return await import(name); } catch (error) { attempts.push(`${name}: ${error.code || error.message}`); }
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    for (const name of ['playwright', 'playwright-core']) {
      const entry = path.join(root, name);
      if (fs.existsSync(entry)) return createRequire(path.join(root, 'noop.js'))(name);
    }
  } catch (error) { attempts.push(`npm root -g: ${error.message}`); }
  fail('MOGRAPH_BROWSER', 'mograph needs Playwright to drive headless Chromium. Install it once with '
    + '`npm i -g playwright && npx playwright install chromium` (or set CAPCUTCTL_CHROMIUM to a Chrome binary). '
    + `Tried: ${attempts.join('; ')}`);
}

// Raster on the CPU: system Chrome rasters on the GPU (Metal on a Mac), asynchronously and not
// bit-exact, so a screenshot could catch tiles from before the seek and blur() differed run to run.
const LAUNCH_ARGS = ['--font-render-hinting=none', '--disable-lcd-text', '--disable-gpu-rasterization'];

/** Whether Playwright's own Chromium was downloaded (`npx playwright install chromium`). */
function hasBundledChromium(playwright) {
  try { const file = playwright.chromium.executablePath(); return Boolean(file) && fs.existsSync(file); } catch { return false; }
}

export async function launch(playwright) {
  const executablePath = process.env.CAPCUTCTL_CHROMIUM || undefined;
  // A failed launch leaves its temp profile and artifacts directories behind, so a Mac that
  // never downloaded Playwright's Chromium goes straight to installed Chrome instead of
  // failing first on every render.
  if (!executablePath && process.platform === 'darwin' && !hasBundledChromium(playwright)) {
    return playwright.chromium.launch({ channel: 'chrome', args: LAUNCH_ARGS });
  }
  try {
    return await playwright.chromium.launch({ executablePath, args: LAUNCH_ARGS });
  } catch (error) {
    if (executablePath || process.platform !== 'darwin') {
      fail('MOGRAPH_BROWSER', `could not launch Chromium: ${error.message.split('\n')[0]}`);
    }
    return playwright.chromium.launch({ channel: 'chrome', args: LAUNCH_ARGS });
  }
}

/** The page input a template sees: params plus the profile's tokens and safe zones. */
export function templateInput(params, { profile = loadProfile(), fps } = {}) {
  return {
    params: params || {},
    tokens: profile.tokens,
    zones: profile.safeZones,
    canvas: { width: profile.canvas.width, height: profile.canvas.height },
    fps: fps || profile.canvas.fps,
    fontsBase: `${pathToFileURL(FONT_DIR).href}/`,
  };
}

/** Open a template page, wait for fonts, and return { page, meta, box } — shared by every entry point. */
async function openTemplate(browser, template, params, { profile, fps, scale = 1 }) {
  const input = templateInput(params, { profile, fps });
  const context = await browser.newContext({
    viewport: { width: input.canvas.width, height: input.canvas.height },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(value => { window.__MG_INPUT__ = value; }, input);
  await page.goto(pathToFileURL(templatePath(template)).href);
  let meta;
  try {
    meta = await page.evaluate(() => window.__mograph.ready);
  } catch (error) {
    const message = String(error.message || error);
    const code = /MOGRAPH_[A-Z_]+/.exec(message)?.[0] || 'MOGRAPH_TEMPLATE_ERROR';
    fail(code, `${template}: ${message.split('\n')[0].replace(/^.*?Error:\s*/, '')}`);
  }
  if (errors.length) fail('MOGRAPH_TEMPLATE_ERROR', `${template}: ${errors[0]}`);
  const box = await page.evaluate(() => window.__mograph.bounds());
  return { context, page, meta, box };
}

const frameTimes = (duration, fps) => {
  const count = Math.max(1, Math.round(duration * fps));
  return Array.from({ length: count }, (_, i) => i / fps);
};

async function shoot(page, box, t) {
  await page.evaluate(time => window.__mograph.seek(time), t);
  return page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h }, omitBackground: true, type: 'png' });
}

// The muxer is named, not inferred: the encoder writes `<file>.partial` and renames it.
function encoderArgs(format, fps, out) {
  const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-'];
  if (format === 'prores') {
    // Premultiplied: CapCut reads ProRes alpha that way (alpha.mjs). Straight alpha painted glows solid.
    return [...input, '-vf', PREMULTIPLY_FILTER, ...PRORES_ALPHA_ARGS, '-movflags', '+faststart', '-f', 'mov', out];
  }
  return [...input, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '28', '-auto-alt-ref', '0', '-f', 'webm', out];
}

/**
 * Write `file` all at once: `produce(partial)` writes `<file>.partial`, which is renamed over
 * `file` only when it finished. A failed or interrupted render never leaves a truncated file
 * under the name a draft (or a later cache check) trusts.
 */
export async function writeAtomic(file, produce) {
  const partial = `${file}.partial`;
  try {
    await produce(partial);
    fs.renameSync(partial, file);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  return file;
}

/** ffmpeg fed PNG frames on stdin, with backpressure; `end()` resolves once the file is written. */
export function pngPipeEncoder(args, out, code) {
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', exit => (exit === 0 ? resolve() : reject(new CapcutError(
      `ffmpeg could not encode ${path.basename(out)}: ${stderr.trim().split('\n').pop()}`, { code, exitCode: 2 }))));
  });
  done.catch(() => {});   // surfaced through write() or end(), never as an unhandled rejection
  return {
    // Racing `done` means an ffmpeg that dies mid-stream fails the write instead of hanging on 'drain'.
    async write(buf) { if (!child.stdin.write(buf)) await Promise.race([new Promise(r => child.stdin.once('drain', r)), done]); },
    end() { child.stdin.end(); return done; },
  };
}

async function encode(format, fps, out, frames) {
  requireBinary('ffmpeg');
  return writeAtomic(out, async partial => {
    const encoder = pngPipeEncoder(encoderArgs(format, fps, partial), out, 'MOGRAPH_ENCODE');
    try {
      for await (const frame of frames) await encoder.write(frame);
    } catch (error) {
      await encoder.end().catch(() => {});
      throw error;
    }
    await encoder.end();
  });
}

/**
 * The local files a graphic's params point at (a logo: an absolute path or a file:// URL to a
 * file that exists), as { path, size, sha256 }, sorted. The same name with new bytes is a new
 * render; a missing path or any other string is not a stamp.
 */
export function assetStamps(params) {
  const found = new Set();
  const walk = value => {
    if (typeof value === 'string') {
      let file = null;
      if (/^file:\/\//i.test(value)) { try { file = fileURLToPath(value); } catch { file = null; } }
      else if (path.isAbsolute(value)) file = value;
      if (file) { try { if (fs.statSync(file).isFile()) found.add(path.resolve(file)); } catch { /* not a file: no stamp */ } }
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(params);
  return [...found].sort().map(file => {
    const bytes = fs.readFileSync(file);
    return { path: file, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
}

export function fingerprint(template, params, profile) {
  const templateHash = crypto.createHash('sha256').update(fs.readFileSync(templatePath(template))).digest('hex');
  const runtimeHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(MOGRAPH_DIR, 'runtime.js'))).digest('hex');
  const assets = assetStamps(params);
  return crypto.createHash('sha256').update(JSON.stringify({
    template, templateHash, runtimeHash, params, tokens: profile.tokens, zones: profile.safeZones, canvas: profile.canvas,
    ...(assets.length ? { assets } : {}),
  })).digest('hex').slice(0, 16);
}

/**
 * Where a render of graphic `id` lives: `<dir>/<id>-<fingerprint>` (the format adds the
 * extension). A re-render with new params is a new file, so the one the draft uses is never
 * overwritten before the transaction that replaces it.
 */
export const renderOut = (dir, id, print) => path.join(dir, `${id}-${print}`);

/**
 * The render cache, written the moment a render succeeds and before anything is placed:
 * `<dir>/.render/<id>.json`. A build that fails on a later graphic keeps the earlier ones.
 */
export const renderCacheFile = (dir, id) => path.join(dir, '.render', `${id}.json`);

export function writeRenderCache(dir, id, rendered) {
  const file = renderCacheFile(dir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { fingerprint: print, format, file: media, box, meta } = rendered;
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, id, fingerprint: print, format, file: media, box, meta }, null, 2)}\n`);
  return file;
}

export function readRenderCache(dir, id) {
  try { return JSON.parse(fs.readFileSync(renderCacheFile(dir, id), 'utf8')); } catch { return null; }
}

/**
 * Inspect without writing: meta (duration, still, sfx, motion) and the exact canvas box.
 * This is what `--dry-run` and the planner use.
 */
export async function probeMograph({ template, params = {}, profile = loadProfile(), fps } = {}) {
  const playwright = await loadPlaywright();
  const browser = await launch(playwright);
  try {
    const { meta, box } = await openTemplate(browser, template, params, { profile, fps });
    return { template, meta, box };
  } finally { await browser.close(); }
}

/**
 * Render one graphic. Returns { file, format, box, meta, fingerprint, frames }.
 * `out` is the path without extension; the extension follows the format. `checkBox(box, meta)`
 * runs once the page has measured the crop and before any frame is shot or encoded: a refusal
 * there (the safe zones) costs a page load, not a render, and writes nothing.
 */
export async function renderMograph({ template, params = {}, out, format = 'prores', scale = 1, profile = loadProfile(), fps,
  checkBox = null } = {}) {
  if (!FORMATS.includes(format)) fail('MOGRAPH_FORMAT', `format must be one of ${FORMATS.join(', ')}`);
  if (!out) fail('MOGRAPH_OUT', 'renderMograph needs an output path');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const playwright = await loadPlaywright();
  const browser = await launch(playwright);
  try {
    const { page, meta, box } = await openTemplate(browser, template, params, { profile, fps, scale });
    if (format === 'png-still' && meta.motion === 'rich') {
      fail('MOGRAPH_FORMAT', `${template} animates more than a pop or slide; render it as prores.`);
    }
    if (checkBox) await checkBox(box, meta);
    const rate = meta.fps;
    let file;
    let frames = 1;
    if (format === 'png-still') {
      file = `${out}.png`;
      const still = await shoot(page, box, meta.still);
      await writeAtomic(file, async partial => fs.writeFileSync(partial, still));
    } else {
      file = `${out}.${format === 'prores' ? 'mov' : 'webm'}`;
      const times = frameTimes(meta.duration, rate);
      frames = times.length;
      await encode(format, rate, file, (async function* () { for (const t of times) yield await shoot(page, box, t); })());
    }
    return {
      template, params, file, format, box, meta, frames, scale,
      fingerprint: fingerprint(template, params, profile), importVerified: IMPORT_VERIFIED,
    };
  } finally { await browser.close(); }
}

/** Specific frames as PNG buffers, for determinism tests and QA. */
export async function renderFrames({ template, params = {}, times, profile = loadProfile(), fps } = {}) {
  const playwright = await loadPlaywright();
  const browser = await launch(playwright);
  try {
    const { page, meta, box } = await openTemplate(browser, template, params, { profile, fps });
    const list = times || frameTimes(meta.duration, meta.fps);
    const frames = [];
    for (const t of list) frames.push(await shoot(page, box, t));
    return { meta, box, frames };
  } finally { await browser.close(); }
}

/**
 * A QA sheet: the graphic composited on a dark canvas at chosen instants, with the profile's
 * forbidden platform-UI zones tinted, downscaled to 360×640 per frame and tiled left to right.
 */
export async function previewSheet({ template, params = {}, times = null, out, background = null, profile = loadProfile() } = {}) {
  requireBinary('ffmpeg');
  const playwright = await loadPlaywright();
  const browser = await launch(playwright);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mograph-sheet-'));
  try {
    const { page, meta, box } = await openTemplate(browser, template, params, { profile });
    const bg = background ? pathToFileURL(path.resolve(background)).href : null;
    await page.evaluate(({ zones, bg }) => {
      // The runtime forces a transparent page, so the backdrop is its own layer under the graphic.
      const back = document.createElement('div');
      Object.assign(back.style, { position: 'fixed', inset: '0', zIndex: '-1',
        background: bg ? `center/cover url("${bg}")` : 'linear-gradient(160deg,#2a2d38,#12131a)' });
      document.body.prepend(back);
      const layer = document.createElement('div');
      layer.id = 'mg-guides';
      for (const z of zones.forbidden || []) {
        const d = document.createElement('div');
        Object.assign(d.style, { position: 'absolute', left: `${z.x}px`, top: `${z.y}px`, width: `${z.w}px`, height: `${z.h}px`,
          background: 'rgba(255,60,60,0.18)', outline: '2px dashed rgba(255,90,90,0.8)', pointerEvents: 'none' });
        layer.appendChild(d);
      }
      document.body.appendChild(layer);
    }, { zones: profile.safeZones, bg });
    const list = times || [0.1, 0.35, 0.6, 0.9].map(f => Math.min(meta.duration - 1 / meta.fps, f * meta.duration));
    const shots = [];
    for (const [i, t] of list.entries()) {
      await page.evaluate(time => window.__mograph.seek(time), t);
      const file = path.join(tmp, `f${String(i).padStart(3, '0')}.png`);
      await page.screenshot({ path: file, type: 'png' });
      shots.push(file);
    }
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(tmp, 'f%03d.png'),
      '-vf', `scale=360:640,tile=${shots.length}x1:padding=8:color=0x0b0b14`, '-frames:v', '1', out]);
    return { template, out, times: list.map(t => Math.round(t * 1000) / 1000), box, meta };
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export { placementFor, safeZoneAdvice, safeZoneText, safeZoneViolations } from './mograph-geometry.mjs';
