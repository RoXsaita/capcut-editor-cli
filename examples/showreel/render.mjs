#!/usr/bin/env node
/*
 * Render the showreel: headless Chromium draws each frame (showreel.html + reel.js), ffmpeg
 * encodes it, score.mjs supplies the soundtrack.
 *
 *   node render.mjs                         full render → out/showreel.mp4
 *   node render.mjs --stills 0.4,2.1,7.9    PNG stills at those times → out/still-<t>.png
 *   node render.mjs --workers 4 --samples 5 --crf 14
 *
 * The frame range is split across workers (one browser each); every frame is a pure function of
 * its index, so the segments join seamlessly. Needs Playwright (local or global) and an ffmpeg
 * with libx264 + aac on PATH (or FFMPEG=/path/to/ffmpeg).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const workers = Number(opt('workers', Math.max(1, Math.min(4, os.cpus().length))));
const samples = Number(opt('samples', 5));
const crf = Number(opt('crf', 14));
const stills = opt('stills', null);

async function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try { return await import(name); } catch {}
  }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const require = createRequire(path.join(globalRoot, 'noop.js'));
  for (const name of ['playwright', 'playwright-core']) {
    try { return require(name); } catch {}
  }
  throw new Error('Playwright not found: npm i -g playwright');
}

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    const file = path.join(HERE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(HERE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function openPage(playwright, url) {
  const browser = await playwright.chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('page error:', e.message));
  await page.goto(url);
  await page.evaluate(() => window.__reel.ready);
  return { browser, page };
}

function encoder(file) {
  const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-tune', 'grain',
    '-g', '60', '-r', '60', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => child.on('close', code => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve())));
  return { stdin: child.stdin, done };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const playwright = await loadPlaywright();
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/showreel.html`;
  try {
    if (stills) {
      const { browser, page } = await openPage(playwright, url);
      for (const s of stills.split(',')) {
        const i = Math.round(Number(s) * 60);
        await page.evaluate(([i, samples]) => window.__reel.frame(i, { samples }), [i, Number(opt('samples', 1))]);
        const file = path.join(OUT, `still-${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: file, type: 'png' });
        console.log(file);
      }
      await browser.close();
      return;
    }
    const total = 900;
    const per = Math.ceil(total / workers);
    const t0 = Date.now();
    let rendered = 0;
    const jobs = Array.from({ length: workers }, async (_, w) => {
      const from = w * per, to = Math.min(total, from + per);
      const seg = path.join(OUT, `seg-${w}.mp4`);
      const { browser, page } = await openPage(playwright, url);
      const enc = encoder(seg);
      for (let i = from; i < to; i++) {
        await page.evaluate(([i, samples]) => window.__reel.frame(i, { samples }), [i, samples]);
        const png = await page.screenshot({ type: 'png' });
        if (!enc.stdin.write(png)) await new Promise(r => enc.stdin.once('drain', r));
        rendered++;
        if (rendered % 30 === 0) {
          const el = (Date.now() - t0) / 1000;
          process.stdout.write(`\r${rendered}/${total} frames  ${el.toFixed(0)}s  eta ${((el / rendered) * (total - rendered)).toFixed(0)}s   `);
        }
      }
      enc.stdin.end();
      await enc.done;
      await browser.close();
      return seg;
    });
    const segs = await Promise.all(jobs);
    process.stdout.write('\n');
    const list = path.join(OUT, 'segments.txt');
    fs.writeFileSync(list, segs.map(s => `file '${s}'`).join('\n'));
    const audio = path.join(OUT, 'score.wav');
    execFileSync(process.execPath, [path.join(HERE, 'score.mjs'), audio], { stdio: 'inherit' });
    const final = path.join(OUT, 'showreel.mp4');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', final], { stdio: 'inherit' });
    for (const s of segs) fs.unlinkSync(s);
    fs.unlinkSync(list);
    console.log(`${final}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } finally {
    server.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
