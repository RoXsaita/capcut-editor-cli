/**
 * mograph scenes — full-frame motion design: inserts, transitions, openers and name cards.
 *
 * Templates (src/mograph.mjs) are tight overlays over the picture. A scene is the frame itself
 * for one to three seconds: its own camera, motion blur, grain and synced sound. Scenes are
 * canvas programs in mograph/scenes/<id>.js on the runtime in mograph/scenes/runtime.js, drawn
 * frame by frame in headless Chromium (several browsers in parallel, since every frame is a
 * pure function of its index) and encoded to:
 *
 *  - `prores`  ProRes 4444 + PCM sound, straight alpha — what `mograph add --scene` places.
 *              An `alpha` scene (a transition) is transparent where it reveals the footage.
 *  - `mp4`     H.264 + AAC, for watching and sharing. Alpha is flattened.
 *
 * Readable text is proven safe: the runtime records every box drawn through K.text/K.mark,
 * and a render refuses (`SCENE_SAFE_ZONE`) when one lands in a platform-UI zone.
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CapcutError, requireBinary } from './core.mjs';
import { loadProfile } from './profile.mjs';
import { FONT_DIR, MOGRAPH_DIR, launch, loadPlaywright } from './mograph.mjs';

export const SCENE_DIR = path.join(MOGRAPH_DIR, 'scenes');
export const SCENE_FORMATS = Object.freeze(['prores', 'mp4']);
const NOT_SCENES = new Set(['runtime.js']);

const fail = (code, message) => { throw new CapcutError(message, { code, exitCode: 2 }); };

/** Scene ids are file names; the first comment block is the catalog entry. */
export function listScenes() {
  if (!fs.existsSync(SCENE_DIR)) return [];
  return fs.readdirSync(SCENE_DIR).filter(n => n.endsWith('.js') && !NOT_SCENES.has(n)).sort().map(file => {
    const src = fs.readFileSync(path.join(SCENE_DIR, file), 'utf8');
    const doc = src.match(/\/\*([\s\S]*?)\*\//)?.[1] || '';
    const lines = doc.split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean);
    const field = name => (lines.find(l => l.startsWith(`${name}:`)) || '').replace(new RegExp(`^${name}:\\s*`), '');
    return {
      id: file.replace(/\.js$/, ''),
      summary: (lines[0] || '').replace(/^[a-z0-9-]+\s+—\s+/, ''),
      params: field('params'),
      beats: field('beats'),
      handoff: field('handoff'),
      use: field('use'),
    };
  });
}

export function scenePath(id) {
  if (!/^[a-z0-9-]+$/.test(String(id || ''))) fail('SCENE_ID', `bad scene id "${id}"`);
  const file = path.join(SCENE_DIR, `${id}.js`);
  if (!fs.existsSync(file) || NOT_SCENES.has(`${id}.js`)) {
    fail('SCENE_ID', `unknown scene "${id}". Known: ${listScenes().map(s => s.id).join(', ')}`);
  }
  return file;
}

export function sceneInput(scene, params, { profile = loadProfile(), fps } = {}) {
  return {
    scene, params: params || {}, tokens: profile.tokens, zones: profile.safeZones,
    canvas: { width: profile.canvas.width, height: profile.canvas.height },
    fps: fps || profile.canvas.fps, fontsBase: `${pathToFileURL(FONT_DIR).href}/`,
  };
}

export function sceneFingerprint(scene, params, profile = loadProfile()) {
  const h = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return crypto.createHash('sha256').update(JSON.stringify({
    scene, sceneHash: h(scenePath(scene)), runtime: h(path.join(SCENE_DIR, 'runtime.js')),
    sound: h(path.join(SCENE_DIR, 'sound.mjs')), params, tokens: profile.tokens, zones: profile.safeZones, canvas: profile.canvas,
  })).digest('hex').slice(0, 16);
}

async function openScene(browser, scene, params, { profile, fps }) {
  scenePath(scene);
  const input = sceneInput(scene, params, { profile, fps });
  const context = await browser.newContext({ viewport: { width: input.canvas.width, height: input.canvas.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(value => { window.__SCENE_INPUT__ = value; }, input);
  await page.goto(pathToFileURL(path.join(SCENE_DIR, 'host.html')).href);
  let meta;
  try {
    meta = await page.evaluate(() => window.__scene.ready);
  } catch (error) {
    const message = String(error.message || error);
    const code = /SCENE_[A-Z_]+/.exec(message)?.[0] || 'SCENE_ERROR';
    fail(code, `${scene}: ${message.split('\n')[0].replace(/^.*?Error:\s*/, '')}`);
  }
  if (errors.length) fail('SCENE_ERROR', `${scene}: ${errors[0]}`);
  return { context, page, meta };
}

/** Readable text boxes that intersect a forbidden zone, sampled every half beat and at the still. */
async function unsafeText(page, meta, profile) {
  const zones = profile.safeZones.forbidden || [];
  const times = [];
  for (let t = 0; t < meta.duration; t += meta.duration / Math.max(4, Math.round(meta.beats * 2))) times.push(t);
  times.push(meta.still);
  const hits = [];
  for (const t of times) {
    const boxes = await page.evaluate(time => window.__scene.textAt(time), t);
    for (const b of boxes) {
      for (const z of zones) {
        if (b.x < z.x + z.w && b.x + b.w > z.x && b.y < z.y + z.h && b.y + b.h > z.y) {
          hits.push({ t: Math.round(t * 1000) / 1000, text: b.text, zone: z.name, box: [b.x, b.y, b.w, b.h].map(Math.round) });
        }
      }
    }
  }
  return hits;
}

/** Inspect without rendering: meta (duration, beats, cues, handoff) and any unsafe text. */
export async function probeScene({ scene, params = {}, profile = loadProfile(), fps } = {}) {
  const playwright = await loadPlaywright();
  const browser = await launch(playwright);
  try {
    const { page, meta } = await openScene(browser, scene, params, { profile, fps });
    return { scene, meta, unsafe: await unsafeText(page, meta, profile) };
  } finally { await browser.close(); }
}

function encoderArgs(format, fps, out) {
  const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-'];
  if (format === 'prores') {
    return [...input, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16',
      '-vendor', 'apl0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', out];
  }
  return [...input, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', out];
}

function spawnEncoder(format, fps, out) {
  const child = spawn('ffmpeg', encoderArgs(format, fps, out), { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new CapcutError(
      `ffmpeg could not encode ${path.basename(out)}: ${stderr.trim().split('\n').pop()}`, { code: 'SCENE_ENCODE', exitCode: 2 }))));
  });
  return {
    async write(buf) { if (!child.stdin.write(buf)) await new Promise(r => child.stdin.once('drain', r)); },
    end() { child.stdin.end(); return done; },
  };
}

/**
 * Render a scene. Returns { scene, file, format, meta, frames, fingerprint, unsafe }.
 * `out` is the path without extension. Refuses unsafe readable text unless allowUnsafe.
 */
export async function renderScene({ scene, params = {}, out, format = 'prores', profile = loadProfile(), fps,
  workers = null, samples = null, allowUnsafe = false, onProgress = null } = {}) {
  if (!SCENE_FORMATS.includes(format)) fail('SCENE_FORMAT', `format must be one of ${SCENE_FORMATS.join(', ')}`);
  if (!out) fail('SCENE_OUT', 'renderScene needs an output path');
  requireBinary('ffmpeg', 'rendering a scene');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const playwright = await loadPlaywright();
  const probe = await launch(playwright);
  let meta, unsafe;
  try {
    const opened = await openScene(probe, scene, params, { profile, fps });
    meta = opened.meta;
    unsafe = await unsafeText(opened.page, meta, profile);
  } finally { await probe.close(); }
  if (unsafe.length && !allowUnsafe) {
    const first = unsafe[0];
    fail('SCENE_SAFE_ZONE', `${scene}: "${first.text}" is in the ${first.zone} zone at ${first.t}s `
      + `(${unsafe.length} hit${unsafe.length > 1 ? 's' : ''}); shorten or resize the text, or pass --allow-unsafe.`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-'));
  const total = meta.frames;
  const n = Math.max(1, Math.min(total, workers || Math.min(4, os.cpus().length)));
  const per = Math.ceil(total / n);
  const segExt = format === 'prores' ? 'mov' : 'mp4';
  let done = 0;
  try {
    const segments = await Promise.all(Array.from({ length: n }, async (_, w) => {
      const from = w * per, to = Math.min(total, from + per);
      const seg = path.join(tmp, `seg-${w}.${segExt}`);
      if (from >= to) return null;
      const browser = await launch(playwright);
      try {
        const { page } = await openScene(browser, scene, params, { profile, fps });
        const enc = spawnEncoder(format, meta.fps, seg);
        for (let i = from; i < to; i++) {
          await page.evaluate(([i, samples]) => window.__scene.frame(i, samples ? { samples } : undefined), [i, samples]);
          await enc.write(await page.screenshot({ type: 'png', omitBackground: true }));
          done++;
          if (onProgress) onProgress(done, total);
        }
        await enc.end();
        return seg;
      } finally { await browser.close(); }
    }));
    const list = path.join(tmp, 'segments.txt');
    fs.writeFileSync(list, segments.filter(Boolean).map(s => `file '${s}'`).join('\n'));
    const { synthesize } = await import(pathToFileURL(path.join(SCENE_DIR, 'sound.mjs')).href);
    const wav = path.join(tmp, 'sound.wav');
    fs.writeFileSync(wav, synthesize(meta.cues, { duration: meta.duration }));
    const file = `${out}.${segExt}`;
    const audio = format === 'prores' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '256k'];
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', wav,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...audio, '-t', String(meta.duration), '-movflags', '+faststart', file]);
    return { scene, params, file, format, meta, frames: total, unsafe,
      fingerprint: sceneFingerprint(scene, params, profile) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A QA sheet: `count` frames (or `times`) with the platform-UI zones outlined, 270×480 each,
 * tiled in rows of four. Motion blur is on (`samples`), so the sheet shows what ships.
 */
export async function previewScene({ scene, params = {}, out, times = null, count = 8, samples = 3,
  profile = loadProfile(), fps } = {}) {
  if (!out) fail('SCENE_OUT', 'previewScene needs --out');
  requireBinary('ffmpeg', 'a scene preview');
  const playwright = await loadPlaywright();
  const browser = await launch(playwright);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-sheet-'));
  try {
    const { page, meta } = await openScene(browser, scene, params, { profile, fps });
    const unsafe = await unsafeText(page, meta, profile);
    await page.evaluate(zones => {
      const layer = document.createElement('div');
      for (const z of zones.forbidden || []) {
        const d = document.createElement('div');
        Object.assign(d.style, { position: 'absolute', left: `${z.x}px`, top: `${z.y}px`, width: `${z.w}px`, height: `${z.h}px`,
          outline: '3px dashed rgba(255,70,70,0.9)', background: 'rgba(255,60,60,0.10)', pointerEvents: 'none' });
        layer.appendChild(d);
      }
      document.body.appendChild(layer);
      document.body.style.background = '#26262e';
    }, profile.safeZones);
    const list = times || Array.from({ length: count }, (_, i) => Math.min(meta.duration - 1 / meta.fps, ((i + 0.5) / count) * meta.duration));
    for (const [i, t] of list.entries()) {
      await page.evaluate(([f, samples]) => window.__scene.frame(f, { samples }), [Math.round(t * meta.fps), samples]);
      await page.screenshot({ path: path.join(tmp, `f${String(i).padStart(3, '0')}.png`), type: 'png' });
    }
    const cols = Math.min(4, list.length), rows = Math.ceil(list.length / cols);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(tmp, 'f%03d.png'),
      '-vf', `scale=270:480,tile=${cols}x${rows}:padding=6:color=0x0b0b14`, '-frames:v', '1', out]);
    return { scene, out, times: list.map(t => Math.round(t * 1000) / 1000), meta, unsafe };
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
