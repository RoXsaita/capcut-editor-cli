/**
 * carousel — the guide-carousel twin of a reel that took off.
 *
 * A reel that beats the account's median reach within about a day has an audience asking
 * "how do I do that?". When the reel is a setup the viewer will repeat (commands, settings,
 * a routine), a numbered photo guide posted the next day collects the saves the reel cannot.
 * When it is a story or an outcome (a refund, a discount), the twin flops, so it is skipped
 * and logged as "story, no twin".
 *
 * Three parts, all plain data in and out so they test without a browser or a network:
 *  - `scan`:  analytics posts → a verdict per recent reel (twin / story-no-twin / unsure /
 *             below-median / too-old), each with its reach margin and classifier cues;
 *  - `steps`: an rl2 take (trace.ndjson + frames.ndjson + screen*.mp4) → one candidate
 *             frame per real click or typing burst, with the click in video pixels and a
 *             crop sized so the UI text lands at ≥36 px on a 1080-wide slide;
 *  - `build`: a pack spec → 1080×1350 PNG slides rendered by headless Chrome
 *             (mograph/carousel/guide.html), a contact sheet, index.html and metadata.json,
 *             then measured: OCR line height inside every step's UI shot, privacy rules on
 *             every slide's OCR text, headline length and slide count. Exit 1 on a fail.
 *  - `stage`: copy the pack to a carousel dashboard, mark it draft, link it to the reel's
 *             item and create one DRAFT publish job. It never calls a publish route.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CapcutError, requireBinary } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.join(HERE, '..');
export const TEMPLATE = path.join(PACKAGE_ROOT, 'mograph', 'carousel', 'guide.html');
export const FONT_DIR = path.join(PACKAGE_ROOT, 'mograph', 'fonts');

export const SLIDE = Object.freeze({ width: 1080, height: 1350 });
/** Step shots must read at this OCR line-box height (px, on the 1080-wide slide) or the build fails. */
export const MIN_TEXT_PX = 36;
export const MAX_HEADLINE_WORDS = 12;
export const SLIDE_COUNT = Object.freeze([6, 8]);
/** A reel is judged on its first ~day: older than this and its reach is lifetime, not momentum. */
export const WINDOW_HOURS = 36;
/** Upscaling a screen capture past this reads soft; `steps` warns instead of silently zooming. */
export const MAX_SHOT_UPSCALE = 2.8;

const fail = (code, message) => { throw new CapcutError(message, { code, exitCode: 2 }); };
const r1 = n => Math.round(n * 10) / 10;
const r3 = n => Math.round(n * 1000) / 1000;

// ─── Trigger ────────────────────────────────────────────────────────────────────────────────

export function median(values) {
  const nums = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = nums.length >> 1;
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

// Levantine and Gulf spellings both occur, with and without shadda; the patterns allow both,
// except where the bare spelling is also a common noun (شغل = work, so only شغّل / شغلوا count).
const SETUP_CUES = [
  ['imperative', /(^|[\s،.:])(اكتب(وا)?|اعمل(وا)?|شغّل(وا)?|شغلوا|ثبّ?ت(وا)?|افتح(وا)?|اربط(وا)?|حطّ?(وا)?|نزّ?ل(وا)?|فعّ?ل(وا)?|اختار(وا)?|انسخ(وا)?|استخدم(وا)?|جهّ?ز(وا)?|روح(وا)?\s+على|اتبع(وا)?|طالب(وا)?)(?=[\s،.:«]|$)/u],
  ['you-can', /(بتقدر(وا)?|تقدر(وا)?|بتقدري)\s/u],
  ['steps', /(خطوات|خطوة|طرق|طريقة|حركات|إعدادات|اعدادات|setup|settings|install|step)/iu],
  ['slash-command', /(^|\s)\/[a-z][a-z-]+/],
  ['numbered', /(^|\s)([١٢٣٤٥٦٧٨٩1-9])\s*(طرق|خطوات|حركات|ways|steps|tips)/iu],
];
const OUTCOME_CUES = [
  ['money', /(دولار|\$\s?\d|\d\s?\$|خصم|استرداد|استرجاع|المصاري|مصاري|refund|discount|cashback)/iu],
];
const STORY_CUES = [
  ['first-person', /(ساعدني|رجّ?علي|رجع لي|رجّع لي|لقى لي|لقالي|فاوض|عنّ?ي\b|بدالي|خلّ?يت|جرّ?بت|وصلني|حصّ?ل لي|نسيت|كنت\s)/u],
];
// The keyword CTA ("اكتبوا «دليل»…بالتعليقات") is an imperative too, but it is not a step.
const CTA_LINE = /(بالتعليقات|بالكومنت|كومنت|comment|اكتبولي|«[^»]+»\s*(إذا|اذا|بالتعليقات))/iu;

/**
 * Setup (a procedure the viewer repeats) vs story (an outcome that happened to the creator).
 * Only an outcome — money back, a discount — is a story, and only when the steps are not
 * explicit (a slash command or two different setup cues). A first-person telling alone is
 * `unsure`, not a story: "I had it apply to jobs for me" is told as a story and its guide twin
 * still won, so a human decides. `unsure` is logged and never auto-built.
 */
export function classifyTopic(...texts) {
  const lines = texts.filter(Boolean).join('\n').split(/\n+/).filter(line => !CTA_LINE.test(line));
  const text = lines.join('\n');
  const hits = list => list.filter(([, rx]) => rx.test(text)).map(([name]) => name);
  const setup = hits(SETUP_CUES);
  const outcome = hits(OUTCOME_CUES);
  const story = hits(STORY_CUES);
  const explicitSteps = setup.includes('slash-command') || setup.length >= 2;
  let kind = 'unsure';
  if (outcome.length && !explicitSteps) kind = 'story';
  else if (setup.length && (explicitSteps || !story.length)) kind = 'setup';
  return { kind, cues: { setup, outcome, story } };
}

const hoursBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3.6e6;

/**
 * One verdict per reel. `posts` are platform posts ({id, timestamp, reach, caption,
 * media_product_type}); `fetchedAt` is when their reach was read; `snapshots` (optional) are
 * dated reads ({post_id, snapshot_ts, reach}) that let a reel found late still be judged on
 * its first day. The baseline is the median reach of the OTHER reels.
 */
export function scanReels({ posts = [], snapshots = [], fetchedAt, windowHours = WINDOW_HOURS, transcripts = {}, now = fetchedAt } = {}) {
  const reels = posts.filter(p => String(p.media_product_type || '').toUpperCase() === 'REELS');
  const asOf = fetchedAt || now || new Date().toISOString();
  return reels
    .map(reel => {
      const base = median(reels.filter(r => r.id !== reel.id).map(r => Number(r.reach)));
      const reads = [{ at: asOf, reach: Number(reel.reach) },
        ...snapshots.filter(s => String(s.post_id) === String(reel.id) && s.reach != null)
          .map(s => ({ at: s.snapshot_ts, reach: Number(s.reach) }))]
        .map(read => ({ ...read, ageHours: hoursBetween(reel.timestamp, read.at) }))
        .filter(read => Number.isFinite(read.ageHours) && read.ageHours >= 0);
      const early = reads.filter(read => read.ageHours <= windowHours).sort((a, b) => b.reach - a.reach)[0] || null;
      const topic = classifyTopic(reel.caption, transcripts[reel.id]);
      const out = {
        postId: String(reel.id), publishedAt: reel.timestamp, permalink: reel.permalink || null,
        title: String(reel.caption || '').split('\n')[0].slice(0, 90),
        reach: early ? early.reach : Number(reel.reach), ageHours: early ? r1(early.ageHours) : r1(hoursBetween(reel.timestamp, asOf)),
        median: base, margin: base && early ? r3(early.reach / base - 1) : null, kind: topic.kind, cues: topic.cues,
      };
      if (!early) return { ...out, verdict: 'too-old', reason: `no reach read within ${windowHours} h of posting` };
      if (base == null || early.reach <= base) return { ...out, verdict: 'below-median', reason: `reach ${early.reach} at ${r1(early.ageHours)} h ≤ median ${base}` };
      if (topic.kind === 'story') return { ...out, verdict: 'story-no-twin', reason: 'story, no twin' };
      if (topic.kind === 'unsure') return { ...out, verdict: 'unsure', reason: 'beat the median, but the topic reads as neither setup nor story: a human decides' };
      return { ...out, verdict: 'twin', reason: `reach ${early.reach} at ${r1(early.ageHours)} h beats median ${base} by ${Math.round(out.margin * 100)}%` };
    })
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

/** Append scan verdicts to a JSONL log, once per (post, verdict). Returns the lines written. */
export function logVerdicts(file, verdicts, { at = new Date().toISOString() } = {}) {
  const seen = new Set();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { const row = JSON.parse(line); seen.add(`${row.postId}:${row.verdict}`); } catch { /* keep going */ }
    }
  }
  const fresh = verdicts.filter(v => ['twin', 'story-no-twin', 'unsure'].includes(v.verdict) && !seen.has(`${v.postId}:${v.verdict}`))
    .map(v => ({ at, postId: v.postId, verdict: v.verdict, reason: v.reason, reach: v.reach, median: v.median, kind: v.kind }));
  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, fresh.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  return fresh;
}

export function defaultLogFile() {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'capcutctl', 'carousel-twins.jsonl');
}

// ─── rl2 takes ──────────────────────────────────────────────────────────────────────────────

function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function probeSize(file) {
  requireBinary('ffprobe', 'carousel');
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [width, height] = String(out.stdout || '').trim().split(',').map(Number);
  if (!width || !height) fail('CAROUSEL_TAKE', `cannot read the video size of ${file}`);
  return { width, height };
}

/** Host clock → video time, interpolated between the recorded frames (rl2 logs both per frame). */
export function hostToVt(frames, host) {
  const points = frames.filter(f => Number.isFinite(f.host) && Number.isFinite(f.vt)).sort((a, b) => a.host - b.host);
  if (!points.length) return null;
  if (host <= points[0].host) return points[0].vt;
  const last = points[points.length - 1];
  if (host >= last.host) return last.vt;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].host <= host) lo = mid; else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  return a.vt + (b.vt - a.vt) * ((host - a.host) / (b.host - a.host || 1));
}

/**
 * The take's step candidates: every click inside the capture and the end of every typing
 * burst. Window titles and click targets are not returned (rl2's `over` is unreliable and
 * titles carry user names). The clean video (no burned cursor) is preferred for frames.
 */
export function readTake(dir, { probe = probeSize } = {}) {
  const root = path.resolve(dir);
  const video = ['screen-clean.mp4', 'screen.mp4'].map(name => path.join(root, name)).find(file => fs.existsSync(file));
  if (!video) fail('CAROUSEL_TAKE', `${root} has no screen-clean.mp4 or screen.mp4`);
  const frames = readNdjson(path.join(root, 'frames.ndjson'));
  const trace = readNdjson(path.join(root, 'trace.ndjson'));
  if (!frames.length) fail('CAROUSEL_TAKE', `${root} has no frames.ndjson: video time cannot be mapped`);
  const size = probe(video);
  const steps = [];
  for (const event of trace) {
    if (event.type === 'click') {
      const at = event.at?.src_px;
      if (!event.in_capture || !at || at.x < 0 || at.y < 0 || at.x >= size.width || at.y >= size.height) continue;
      steps.push({ id: event.id, type: 'click', vt: r3(hostToVt(frames, event.host)), x: Math.round(at.x), y: Math.round(at.y) });
    } else if (event.type === 'typing_burst' && Number(event.keys) > 0) {
      steps.push({ id: event.id, type: 'typing', vt: r3(hostToVt(frames, event.end ?? event.host)), keys: event.keys });
    }
  }
  steps.sort((a, b) => a.vt - b.vt);
  return { dir: root, name: path.basename(root), video, width: size.width, height: size.height, steps };
}

/**
 * A crop around a click, sized for reading (cf. rl2's ClickCrop, which is sized for one label):
 * the width is what fits `textPx`-high source text to MIN_TEXT_PX on a `slideWidth` shot, so
 * a 1x capture (≈18 px lines) gets a ~540 px window and a 2x capture (≈25 px) ~750 px. Taller
 * than ClickCrop, because a step needs its context (the field AND its label). Clamped to the frame.
 */
export function readableCrop({ x, y }, frame, { textPx = 18, slideWidth = SLIDE.width, aspect = 0.62 } = {}) {
  const width = Math.min(frame.width, Math.floor(slideWidth * textPx / MIN_TEXT_PX));
  const height = Math.min(frame.height, Math.round(width * aspect));
  const left = Math.max(0, Math.min(frame.width - width, Math.round(x - width / 2)));
  const top = Math.max(0, Math.min(frame.height - height, Math.round(y - height / 2)));
  return { x: left, y: top, w: width, h: height, scale: r3(slideWidth / width) };
}

// ─── Pack spec ──────────────────────────────────────────────────────────────────────────────

const KINDS = new Set(['cover', 'step', 'prompt', 'cta']);
export const countWords = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;

/** Problems with a spec, as strings; empty when it can be built. */
export function validateSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['spec must be a JSON object'];
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(String(spec.slug || ''))) problems.push('slug must be lower-case letters, digits and dashes');
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  if (slides.length < SLIDE_COUNT[0] || slides.length > SLIDE_COUNT[1]) problems.push(`a guide carousel has ${SLIDE_COUNT[0]}–${SLIDE_COUNT[1]} slides, this has ${slides.length}`);
  if (slides[0]?.kind !== 'cover') problems.push('slide 1 must be the cover (the promise and what you need)');
  if (slides.at(-1)?.kind !== 'cta') problems.push('the last slide must be the CTA');
  if (!slides.some(s => s.kind === 'prompt')) problems.push('a guide carousel needs a "copy this" prompt slide');
  if (!slides.some(s => s.kind === 'cta' && s.keyword)) problems.push('the CTA needs the reel\'s comment keyword');
  slides.forEach((slide, i) => {
    const at = `slide ${i + 1}`;
    if (!KINDS.has(slide.kind)) problems.push(`${at}: kind must be one of ${[...KINDS].join(', ')}`);
    if (!slide.headline) problems.push(`${at}: headline is required`);
    if (countWords(slide.headline) > MAX_HEADLINE_WORDS) problems.push(`${at}: headline is ${countWords(slide.headline)} words (max ${MAX_HEADLINE_WORDS})`);
    if (slide.kind === 'step' && !slide.shot) problems.push(`${at}: a step needs a real UI shot`);
    if (slide.kind === 'cover' && !(slide.needs || []).length) problems.push(`${at}: the cover lists what you need`);
    if (slide.kind === 'prompt' && !(slide.blocks || []).length) problems.push(`${at}: the prompt slide needs at least one block to copy`);
    if (slide.shot) {
      const shot = slide.shot;
      if (!shot.take) problems.push(`${at}: shot.take is required`);
      if (shot.t == null && shot.click == null && shot.typing == null) problems.push(`${at}: shot needs t (seconds), click or typing (trace event ids)`);
      if (!Array.isArray(shot.crop) || shot.crop.length !== 4) problems.push(`${at}: shot.crop is [x, y, w, h] in video pixels`);
    }
  });
  return problems;
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const arabicNumeral = n => String(n).replace(/\d/g, d => ARABIC_DIGITS[Number(d)]);

/**
 * Resolve every shot against its take: time from `t` or the click's trace event, the click
 * marker from the trace (never guessed), and the on-slide geometry. Pure apart from reading
 * the take, so the plan prints before anything renders.
 */
export function planPack(spec, { specDir = process.cwd(), takes = {}, readTakeFn = readTake } = {}) {
  const problems = validateSpec(spec);
  if (problems.length) fail('CAROUSEL_SPEC', `the pack spec is not buildable:\n  - ${problems.join('\n  - ')}`);
  const cache = new Map(Object.entries(takes));
  const take = ref => {
    const dir = path.resolve(specDir, ref);
    if (!cache.has(dir)) cache.set(dir, readTakeFn(dir));
    return cache.get(dir);
  };
  let step = 0;
  const slides = spec.slides.map((slide, i) => {
    const out = { ...slide, index: i + 1 };
    if (slide.kind === 'step') out.number = slide.number ?? ++step;
    if (!slide.shot) return out;
    const shot = slide.shot;
    const source = take(shot.take);
    let t = shot.t;
    let marker = null;
    if (shot.typing != null) {
      const burst = source.steps.find(s => s.type === 'typing' && String(s.id) === String(shot.typing));
      if (!burst) fail('CAROUSEL_SPEC', `slide ${i + 1}: ${source.name} has no typing burst with id ${shot.typing}`);
      // A burst usually ends on Enter, which clears the input: the typed text is on screen just before.
      t ??= burst.vt + (shot.after ?? -0.3);
    }
    if (shot.click != null) {
      const click = source.steps.find(s => s.type === 'click' && String(s.id) === String(shot.click));
      if (!click) fail('CAROUSEL_SPEC', `slide ${i + 1}: ${source.name} has no in-capture click with id ${shot.click}`);
      t ??= click.vt + (shot.after ?? 0.35);
      if (shot.marker !== false) marker = { x: click.x, y: click.y };
    }
    const [cx, cy, cw, ch] = shot.crop.map(Number);
    if (cx < 0 || cy < 0 || cx + cw > source.width || cy + ch > source.height) {
      fail('CAROUSEL_SPEC', `slide ${i + 1}: crop ${shot.crop.join(',')} leaves the ${source.width}×${source.height} frame`);
    }
    const width = shot.width || SLIDE.width;
    const scale = width / cw;
    const toSlide = ([x, y, w, h]) => [(x - cx) * scale, (y - cy) * scale, w * scale, h * scale].map(Math.round);
    out.shot = {
      ...shot, takeName: source.name, video: source.video, t: r3(t), crop: [cx, cy, cw, ch],
      width, height: Math.round(ch * scale), scale: r3(scale),
      marker: marker && marker.x >= cx && marker.x <= cx + cw && marker.y >= cy && marker.y <= cy + ch
        ? { x: Math.round((marker.x - cx) * scale), y: Math.round((marker.y - cy) * scale) } : null,
      highlight: shot.highlight ? toSlide(shot.highlight) : null,
      masks: (shot.masks || []).map(m => ({ rect: toSlide(m.rect || m), color: m.color || null })),
      warnings: scale > MAX_SHOT_UPSCALE ? [`upscaled ${r1(scale)}× from the capture: it will read soft`] : [],
    };
    return out;
  });
  return { ...spec, slides };
}

// ─── Render ─────────────────────────────────────────────────────────────────────────────────

/** Seek one frame (never decode the file), crop it, and scale it to its on-slide size. */
export function extractShot(shot, file) {
  requireBinary('ffmpeg', 'carousel');
  const [x, y, w, h] = shot.crop;
  const filter = `crop=${w}:${h}:${x}:${y},scale=${shot.width}:${shot.height}:flags=lanczos`
    + (shot.scale > 1.2 ? ',unsharp=5:5:0.45:5:5:0' : '');
  const run = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(shot.t), '-i', shot.video, '-frames:v', '1', '-vf', filter, file], { encoding: 'utf8' });
  if (run.status !== 0 || !fs.existsSync(file)) fail('CAROUSEL_FRAME', `ffmpeg could not cut ${shot.takeName} at ${shot.t}s: ${String(run.stderr).trim().split('\n').pop()}`);
  return file;
}

/** The template's fixed words; a spec's `labels` overrides any of them. */
export const DEFAULT_LABELS = Object.freeze({ eyebrow: 'دليل خطوة بخطوة', needs: 'شو بتحتاج:', cta: 'اكتب بالتعليقات' });

export function slideData(slide, { total, handle, tokens, shotUrl, labels }) {
  return {
    kind: slide.kind, index: slide.index, total, number: slide.number != null ? arabicNumeral(slide.number) : null,
    headline: slide.headline, sub: slide.sub || '', needs: slide.needs || [], blocks: slide.blocks || [],
    keyword: slide.keyword || '', after: slide.after || '', handle: handle || '',
    shot: slide.shot ? { url: shotUrl, width: slide.shot.width, height: slide.shot.height, marker: slide.shot.marker,
      highlight: slide.shot.highlight, masks: slide.shot.masks, dark: Boolean(slide.shot.dark) } : null,
    // The bundled profile's neutrals; a creator's own brand comes from their profile layer.
    colors: { brand: tokens?.color?.brand || '#3D3D3D', accent: tokens?.color?.accent || '#FFB020', ink: tokens?.color?.ink || '#0B0B14' },
    labels: { ...DEFAULT_LABELS, ...(labels || {}) },
    fontsBase: `${pathToFileURL(FONT_DIR).href}/`,
  };
}

/** Render every slide to exports/instagram-4x5/slide-NN.png. Returns the slide files and the shot boxes. */
export async function renderSlides(plan, { out, profile, browserFactory } = {}) {
  const exportsDir = path.join(out, 'exports', 'instagram-4x5');
  const shotsDir = path.join(out, 'shots');
  fs.mkdirSync(exportsDir, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const total = plan.slides.length;
  const launchBrowser = browserFactory || (async () => {
    const mograph = await import('./mograph.mjs');
    return mograph.launch(await mograph.loadPlaywright());
  });
  const browser = await launchBrowser();
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { ...SLIDE }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(TEMPLATE).href);
    for (const slide of plan.slides) {
      const name = `slide-${String(slide.index).padStart(2, '0')}`;
      let shotUrl = null;
      if (slide.shot) shotUrl = pathToFileURL(extractShot(slide.shot, path.join(shotsDir, `${name}.png`))).href;
      const data = slideData(slide, { total, handle: plan.handle, tokens: profile?.tokens, shotUrl, labels: plan.labels });
      const box = await page.evaluate(async value => window.renderSlide(value), data);
      if (errors.length) fail('CAROUSEL_RENDER', `${name}: ${errors.join('; ')}`);
      const file = path.join(exportsDir, `${name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, ...SLIDE } });
      results.push({ index: slide.index, kind: slide.kind, file, shotBox: box?.shot || null, displayScale: box?.shotScale ?? null });
    }
  } finally {
    await browser.close();
  }
  return results;
}

// ─── QA ─────────────────────────────────────────────────────────────────────────────────────

/** Vision OCR on one image → [{text, x, y, w, h}] in pixels. */
export function ocrImage(file, { languages = 'en-US' } = {}) {
  const bin = path.join(PACKAGE_ROOT, 'tools', 'vision', 'ocr');
  if (!fs.existsSync(bin)) fail('CAROUSEL_OCR', 'the Vision OCR helper is not built: swiftc -O -o tools/vision/ocr tools/vision/ocr.swift');
  const run = spawnSync(bin, [file, '--languages', languages], { encoding: 'utf8' });
  if (run.status !== 0) fail('CAROUSEL_OCR', `OCR failed on ${file}: ${String(run.stderr).trim()}`);
  return JSON.parse(run.stdout).map(r => ({ text: r.text, x: r.x * SLIDE.width, y: r.y * SLIDE.height, w: r.w * SLIDE.width, h: r.h * SLIDE.height }));
}

/**
 * The text size a step shot reads at: the median OCR line-box height (px) of the lines whose
 * centre falls inside the shot's box on the slide. That is the number MIN_TEXT_PX gates.
 */
export function shotTextPx(lines, box) {
  if (!box) return null;
  const inside = lines.filter(l => {
    const cx = l.x + l.w / 2;
    const cy = l.y + l.h / 2;
    return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h && l.text.trim().length >= 2;
  });
  return inside.length ? r1(median(inside.map(l => l.h))) : null;
}

/** Things a guide must never show, beyond the watcher's denylist (which checkPrivacy also runs). */
export const EXTRA_PRIVACY_RULES = Object.freeze({
  'home-path': /(\/Users\/|\/home\/)[A-Za-z0-9._-]+/,
  'shell-prompt': /\b[a-z0-9._-]+@[a-z0-9._-]+(\s+~|:~)/i,
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
});

/** Rule NAMES that match the text (never the matched text): the watcher's privacy.py rules + EXTRA_PRIVACY_RULES. */
export function checkPrivacy(texts) {
  const names = new Set();
  for (const [name, rx] of Object.entries(EXTRA_PRIVACY_RULES)) if (texts.some(t => rx.test(t))) names.add(name);
  const helper = path.join(PACKAGE_ROOT, 'tools', 'watcher');
  const code = 'import json,sys\nsys.path.insert(0,sys.argv[1])\nimport privacy\n_,rules=privacy.load()\n'
    + 'print(json.dumps(sorted({privacy.check_text(t,rules) for t in json.load(sys.stdin)}-{None})))';
  const run = spawnSync('python3', ['-c', code, helper], { input: JSON.stringify(texts), encoding: 'utf8' });
  if (run.status === 0) for (const name of JSON.parse(run.stdout || '[]')) names.add(name);
  else names.add('privacy-helper-unavailable');
  return [...names].sort();
}

export function qaPack(plan, rendered, { ocr = ocrImage, privacy = checkPrivacy } = {}) {
  const slides = rendered.map(result => {
    const slide = plan.slides.find(s => s.index === result.index);
    const lines = ocr(result.file);
    const textPx = slide.kind === 'step' ? shotTextPx(lines, result.shotBox) : null;
    const rules = privacy(lines.map(l => l.text));
    const problems = [];
    if (slide.kind === 'step' && (textPx == null || textPx < MIN_TEXT_PX)) problems.push(`UI text reads at ${textPx ?? 'no'} px (min ${MIN_TEXT_PX})`);
    if (rules.length) problems.push(`privacy: ${rules.join(', ')}`);
    if (countWords(slide.headline) > MAX_HEADLINE_WORDS) problems.push(`headline over ${MAX_HEADLINE_WORDS} words`);
    return { index: result.index, kind: slide.kind, textPx, privacy: rules, warnings: slide.shot?.warnings || [], verdict: problems.length ? 'FAIL' : 'PASS', problems };
  });
  return { verdict: slides.some(s => s.verdict === 'FAIL') ? 'FAIL' : 'PASS', minTextPx: MIN_TEXT_PX, slides };
}

// ─── Pack files ─────────────────────────────────────────────────────────────────────────────

export function contactSheet(files, out, { columns = 4, width = 360 } = {}) {
  requireBinary('ffmpeg', 'carousel');
  const rows = Math.ceil(files.length / columns);
  const inputs = files.flatMap(file => ['-i', file]);
  const scaled = files.map((_, i) => `[${i}:v]scale=${width}:-1[s${i}]`).join(';');
  const layout = files.map((_, i) => `${(i % columns) * width}_${Math.floor(i / columns) * Math.round(width * SLIDE.height / SLIDE.width)}`).join('|');
  const filter = `${scaled};${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=white[out]`;
  const run = spawnSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-q:v', '3', out], { encoding: 'utf8' });
  if (run.status !== 0) fail('CAROUSEL_SHEET', `contact sheet failed: ${String(run.stderr).trim().split('\n').pop()}`);
  return { file: out, columns, rows };
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The pack's source page: every slide in order, the captions, and the spec it was built from. */
export function indexHtml(plan, files) {
  const imgs = files.map(f => `<img src="exports/instagram-4x5/${path.basename(f)}" alt="" width="360" height="450">`).join('\n  ');
  const spec = JSON.stringify(stripLocal(plan), null, 2).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(plan.title || plan.slug)}</title>
<style>body{margin:24px;background:#f4f4f8;font-family:system-ui,sans-serif;color:#0b0b14}main{display:flex;flex-wrap:wrap;gap:12px}img{border-radius:8px;box-shadow:0 1px 4px #0002}pre{white-space:pre-wrap;direction:ltr;text-align:left;background:#fff;padding:12px;border-radius:8px}</style>
</head><body>
<h1>${escapeHtml(plan.title || plan.slug)}</h1>
<main>
  ${imgs}
</main>
<h2>Instagram</h2><pre>${escapeHtml(plan.caption || '')}</pre>
<h2>TikTok</h2><pre>${escapeHtml(plan.tiktokCaption || plan.caption || '')}</pre>
<script type="application/json" id="carousel-spec">${spec}</script>
</body></html>
`;
}

/** The spec as recorded in the pack: take folder names only, never local absolute paths. */
function stripLocal(plan) {
  return {
    ...plan,
    slides: plan.slides.map(s => (s.shot ? { ...s, shot: { ...s.shot, video: undefined, take: s.shot.takeName } } : s)),
  };
}

export function packMetadata(plan, { qa, sheet, now = new Date().toISOString() }) {
  return {
    title: plan.title || plan.slug,
    slug: plan.slug,
    concept_id: plan.conceptId || plan.slug.replace(/-v\d+$/, ''),
    concept_title: plan.title || plan.slug,
    iteration_label: plan.iterationLabel || 'Guide twin v1',
    format: '4x5',
    output_size: [SLIDE.width, SLIDE.height],
    generator: 'capcutctl carousel build',
    source_item_id: plan.sourceItemId ?? '',
    source_url: plan.sourceUrl || '',
    source_post_id: plan.sourcePostId || '',
    lifecycle: { status: 'draft' },
    lifecycle_status: 'draft',
    archived: false,
    posted: false,
    captions: { instagram: plan.caption || '', tiktok: plan.tiktokCaption || plan.caption || '' },
    qa_notes: `capcutctl carousel QA ${qa.verdict}: ${qa.slides.map(s => `${s.index}:${s.kind}${s.textPx ? ` ${s.textPx}px` : ''}${s.problems.length ? ` (${s.problems.join('; ')})` : ''}`).join(', ')}`,
    qa,
    slide_boxes: plan.slides.map(s => ({ slide: s.index, kind: s.kind, headline: s.headline,
      ...(s.shot ? { take: s.shot.takeName, t: s.shot.t, crop: s.shot.crop, scale: s.shot.scale, marker: Boolean(s.shot.marker) } : {}) })),
    contact_sheet: sheet ? path.relative(path.dirname(path.dirname(sheet.file)), sheet.file) : '',
    created_at: now,
    updated_at: now,
  };
}

export async function buildPack(spec, { out, specDir, profile, browserFactory, ocr, privacy } = {}) {
  const plan = planPack(spec, { specDir });
  const dir = path.resolve(out || plan.slug);
  fs.mkdirSync(dir, { recursive: true });
  const rendered = await renderSlides(plan, { out: dir, profile, browserFactory });
  const files = rendered.map(r => r.file);
  const sheet = contactSheet(files, path.join(dir, 'exports', 'contact-sheet-instagram-4x5.jpg'));
  const qa = qaPack(plan, rendered, { ...(ocr ? { ocr } : {}), ...(privacy ? { privacy } : {}) });
  fs.writeFileSync(path.join(dir, 'index.html'), indexHtml(plan, files));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(packMetadata(plan, { qa, sheet }), null, 2) + '\n');
  return { pack: dir, slides: files, contactSheet: sheet.file, qa };
}

// ─── Stage ──────────────────────────────────────────────────────────────────────────────────

/** The only dashboard routes `stage` may call. Publishing routes are absent on purpose. */
export const STAGE_ROUTES = Object.freeze([
  ['PATCH', /^\/api\/carousels\/[a-z0-9-]+\/metadata$/],
  ['GET', /^\/api\/carousels\/[a-z0-9-]+\/publish\/jobs$/],
  ['POST', /^\/api\/carousels\/[a-z0-9-]+\/publish\/jobs$/],
  ['GET', /^\/api\/carousels$/],
]);

function guardRoute(method, url) {
  const route = new URL(url).pathname;
  if (!STAGE_ROUTES.some(([m, rx]) => m === method && rx.test(route))) {
    fail('CAROUSEL_STAGE_ROUTE', `stage refuses ${method} ${route}: it only stages drafts and never publishes`);
  }
}

/**
 * Stage a built pack as a dashboard draft: copy it (rsync over ssh) into the dashboard's
 * carousels folder, mark it draft and link the reel's item, then create ONE draft publish
 * job for the given platforms. Sending it anywhere (Instagram, a TikTok inbox) stays a
 * separate, human step in the dashboard.
 */
export async function stagePack({ pack, dashboard, remote, item, platforms = 'instagram,tiktok', dryRun = false,
  fetchFn = globalThis.fetch, copyFn = rsyncPack } = {}) {
  if (!dashboard) fail('CAROUSEL_STAGE', 'stage needs --dashboard URL (or CAPCUTCTL_DASHBOARD)');
  if (!remote) fail('CAROUSEL_STAGE', 'stage needs --remote HOST:CAROUSELS_DIR (or CAPCUTCTL_CAROUSELS_REMOTE)');
  const dir = path.resolve(pack);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  if (meta.qa?.verdict !== 'PASS') fail('CAROUSEL_STAGE', `the pack's QA is ${meta.qa?.verdict || 'missing'}: fix it before staging`);
  const slug = meta.slug;
  const base = dashboard.replace(/\/+$/, '');
  const call = async (method, route, body) => {
    const url = `${base}${route}`;
    guardRoute(method, url);
    if (dryRun) return { dryRun: true, method, route, body };
    const res = await fetchFn(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok && res.status !== 409) fail('CAROUSEL_STAGE', `${method} ${route} → ${res.status}: ${String(text).slice(0, 300)}`);
    return { status: res.status, json };
  };
  const copied = dryRun ? { dryRun: true, to: `${remote.replace(/\/+$/, '')}/${slug}/` } : copyFn(dir, remote, slug);
  const metadata = await call('PATCH', `/api/carousels/${slug}/metadata`, {
    lifecycle_status: 'draft', source_item_id: item ?? meta.source_item_id ?? null,
    source_url: meta.source_url || undefined, qa_notes: meta.qa_notes,
  });
  const existing = await call('GET', `/api/carousels/${slug}/publish/jobs`);
  const active = Array.isArray(existing.json) ? existing.json.find(j => ['draft', 'rendering', 'publishing'].includes(j.status)) : null;
  const job = active ? { status: 200, json: active, reused: true } : await call('POST', `/api/carousels/${slug}/publish/jobs`, {
    slug, title: meta.title, caption: meta.captions?.instagram || '', instagram_caption: meta.captions?.instagram || '',
    tiktok_caption: meta.captions?.tiktok || '', platforms,
  });
  const listed = await call('GET', '/api/carousels');
  const found = Array.isArray(listed.json?.packs) ? listed.json.packs.find(p => p.slug === slug) : null;
  return {
    slug, copied, metadata: metadata.status ?? 'dry-run', job: job.json?.id ? { id: job.json.id, status: job.json.status, platforms: job.json.platforms, reused: Boolean(job.reused) } : job,
    listed: found ? { slideCount: found.slide_count, lifecycle: found.lifecycle_status, sourceItemId: found.source_item_id } : (dryRun ? 'dry-run' : 'NOT LISTED'),
    next: 'Nothing was sent anywhere. Posting to Instagram, or sending the TikTok photo draft to the TikTok inbox, is a separate yes in the dashboard.',
  };
}

function rsyncPack(dir, remote, slug) {
  requireBinary('rsync', 'carousel stage');
  const target = `${remote.replace(/\/+$/, '')}/${slug}/`;
  const run = spawnSync('rsync', ['-a', '--exclude', 'shots/', `${dir}/`, target], { encoding: 'utf8' });
  if (run.status !== 0) fail('CAROUSEL_STAGE', `rsync to ${target} failed: ${String(run.stderr).trim()}`);
  return { to: target };
}
