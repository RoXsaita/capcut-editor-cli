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
 *  - `build`: a pack spec (docs/carousel-spec.md) → static PNG slides, 1080×1440 by default,
 *             rendered by headless Chrome through a theme folder (mograph/carousel/themes/), a contact sheet,
 *             index.html and metadata.json, then measured: OCR line height inside every step's
 *             UI shot, how much of the slide the shot fills, text cut at the shot's edge, text
 *             outside the safe zone, privacy rules, headline length and slide count. The
 *             thresholds are the spec's `rules`, the look is its `theme`: taste is data, not code.
 *             Exit 1 on a fail. The reel twin is one feeder; any slide spec builds the same way.
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
/** Theme folders: each holds theme.json (fonts, type scale, grid vars) and the template it names. */
export const THEMES_DIR = path.join(PACKAGE_ROOT, 'mograph', 'carousel', 'themes');
export const DEFAULT_THEME_NAME = 'plain';

/** Canvases a pack renders at. 3:4 is the feed's own ratio; 4:5 stays for ads and old packs. */
export const CANVASES = Object.freeze({
  '3x4': Object.freeze({ width: 1080, height: 1440 }),
  '4x5': Object.freeze({ width: 1080, height: 1350 }),
});
export const SLIDE = CANVASES['3x4'];
/** Step shots must read at this OCR line-box height (px, on the 1080-wide slide) or the build fails. */
export const MIN_TEXT_PX = 36;
export const SLIDE_COUNT = Object.freeze([6, 10]);

/**
 * What QA enforces, overridable per spec (`rules`). Defaults are the carousel skill's floors.
 * Type sizes, insets and word counts are measured on the rendered page (the theme reports every
 * text's role, size and box), so they hold whichever theme draws the slides; UI text inside a
 * shot is measured by OCR. `inset` is the margin every text and card keeps on all four edges;
 * `bottomClear` is the share of the canvas bottom kept free of anything but the footer (TikTok
 * draws its caption and buttons there).
 */
export const DEFAULT_RULES = Object.freeze({
  canvas: '3x4',
  inset: 100,
  bottomClear: 0.10,
  minTextPx: MIN_TEXT_PX,
  minPx: Object.freeze({ coverHeadline: 96, headline: 72, sub: 44, body: 44, code: 40, terminal: 40, any: 28 }),
  maxWords: Object.freeze({ coverHeadline: 8, headline: 7 }),
  slideWords: Object.freeze([8, 22]),
  maxSlideWords: 30,
  slideCount: SLIDE_COUNT,
  minShotFill: 0.55,
  edgePadPx: 20,
  maxUpscale: 2.8,
  requirePrompt: true,
  // A comment keyword only where something real answers it; a save CTA otherwise.
  requireKeyword: false,
});

export function resolveRules(spec = {}) {
  const own = spec.rules || {};
  const rules = { ...DEFAULT_RULES, ...own };
  rules.canvas = spec.canvas || rules.canvas;
  if (!CANVASES[rules.canvas]) fail('CAROUSEL_SPEC', `canvas must be one of ${Object.keys(CANVASES).join(', ')}`);
  rules.minPx = { ...DEFAULT_RULES.minPx, ...(own.minPx || {}) };
  rules.maxWords = { ...DEFAULT_RULES.maxWords, ...(own.maxWords || {}) };
  return rules;
}

/**
 * The theme a spec names: `"plain"`, a path to a theme folder (relative to the spec), or
 * `{ name, ...vars }` to override the folder's vars. → { name, dir, template, fonts, vars }.
 */
export function resolveTheme(spec = {}, { specDir = process.cwd() } = {}) {
  const ref = typeof spec.theme === 'string' ? spec.theme : (spec.theme?.name || DEFAULT_THEME_NAME);
  const dir = /[\\/]/.test(ref) ? path.resolve(specDir, ref) : path.join(THEMES_DIR, ref);
  const file = path.join(dir, 'theme.json');
  if (!fs.existsSync(file)) {
    const known = fs.existsSync(THEMES_DIR) ? fs.readdirSync(THEMES_DIR).join(', ') : 'none';
    fail('CAROUSEL_THEME', `no carousel theme at ${dir} (theme.json missing). Bundled: ${known}`);
  }
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  const overrides = spec.theme && typeof spec.theme === 'object' ? Object.fromEntries(Object.entries(spec.theme).filter(([k]) => k !== 'name')) : {};
  return {
    name: meta.name || path.basename(dir), dir,
    template: path.join(dir, meta.template || 'template.html'),
    fonts: (meta.fonts || []).map(f => ({ ...f, url: pathToFileURL(path.resolve(dir, f.file)).href })),
    vars: { ...(meta.vars || {}), ...overrides },
  };
}

/** The pixel width a shot image is cut at: the card's inner width on the canvas. */
export function shotWidth(vars, canvas) {
  return canvas.width - 2 * ((vars.cardMargin ?? 100) + (vars.cardBorder ?? 0));
}
/** A reel is judged on its first ~day: older than this and its reach is lifetime, not momentum. */
export const WINDOW_HOURS = 36;
/** Upscaling a screen capture past this reads soft; `steps` warns instead of silently zooming. */
export const MAX_SHOT_UPSCALE = DEFAULT_RULES.maxUpscale;

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

/** A still image (a screenshot, an exported frame) as a shot source: no trace, no steps. */
export function readStill(file, { probe = probeSize } = {}) {
  const image = path.resolve(file);
  if (!fs.existsSync(image)) fail('CAROUSEL_SPEC', `shot image ${image} does not exist`);
  const size = probe(image);
  return { dir: path.dirname(image), name: path.basename(image), video: image, still: true, width: size.width, height: size.height, steps: [] };
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

const KINDS = new Set(['cover', 'step', 'terminal', 'proof', 'compare', 'note', 'text', 'prompt', 'cta']);
const SHOT_KINDS = new Set(['step', 'proof']);
/** Kinds that count as a numbered move. */
const STEP_KINDS = new Set(['step', 'terminal']);
export const countWords = text => String(text || '').replace(/`/g, '').trim().split(/\s+/).filter(Boolean).length;

/** Problems with a spec, as strings; empty when it can be built. */
export function validateSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['spec must be a JSON object'];
  const rules = resolveRules(spec);
  const [minSlides, maxSlides] = rules.slideCount;
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(String(spec.slug || ''))) problems.push('slug must be lower-case letters, digits and dashes');
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  if (slides.length < minSlides || slides.length > maxSlides) problems.push(`a carousel here has ${minSlides}–${maxSlides} slides, this has ${slides.length}`);
  if (slides[0]?.kind !== 'cover') problems.push('slide 1 must be the cover (the promise)');
  if (slides.at(-1)?.kind !== 'cta') problems.push('the last slide must be the CTA');
  if (rules.requirePrompt && !slides.some(s => s.kind === 'prompt')) problems.push('this carousel needs a "copy this" prompt slide (rules.requirePrompt)');
  if (rules.requireKeyword && !slides.some(s => s.kind === 'cta' && s.keyword)) problems.push('the CTA needs a comment keyword (rules.requireKeyword)');
  const checkShot = (shot, at) => {
    if (!shot.take && !shot.image) problems.push(`${at}: shot needs take (an rl2 folder) or image (a still)`);
    if (shot.take && shot.t == null && shot.click == null && shot.typing == null) problems.push(`${at}: a take shot needs t (seconds), click or typing (trace event ids)`);
    if (!Array.isArray(shot.crop) || shot.crop.length !== 4) problems.push(`${at}: shot.crop is [x, y, w, h] in source pixels`);
  };
  slides.forEach((slide, i) => {
    const at = `slide ${i + 1}`;
    if (!KINDS.has(slide.kind)) problems.push(`${at}: kind must be one of ${[...KINDS].join(', ')}`);
    if (!slide.headline) problems.push(`${at}: headline is required`);
    const role = slide.kind === 'cover' ? 'coverHeadline' : 'headline';
    const max = rules.maxWords[role];
    if (max && countWords(slide.headline) > max) problems.push(`${at}: headline is ${countWords(slide.headline)} words (max ${max})`);
    if (SHOT_KINDS.has(slide.kind) && !slide.shot) problems.push(`${at}: a ${slide.kind} slide needs a real shot`);
    if (slide.kind === 'compare' && (!Array.isArray(slide.shots) || slide.shots.length !== 2 || slide.shots.some(sh => !sh.label))) {
      problems.push(`${at}: a compare slide has shots: [two shots, each with a label]`);
    }
    if (slide.kind === 'terminal') {
      const term = slide.terminal;
      if (!term || typeof term !== 'object') problems.push(`${at}: a terminal slide needs terminal: {take or image, t, crop}`);
      else {
        checkShot(term, `${at} terminal`);
        if (term.lines != null && (!Array.isArray(term.lines) || !term.lines.length || term.lines.some(l => typeof l !== 'string'))) problems.push(`${at}: terminal.lines is a list of the frame's lines, verbatim`);
        if (term.header != null && !(Number.isInteger(term.header) && term.header >= 0)) problems.push(`${at}: terminal.header is how many top lines are the small header`);
        if (term.highlight != null && (!Array.isArray(term.highlight) || term.highlight.some(n => !Number.isInteger(n) || n < 0))) problems.push(`${at}: terminal.highlight is a list of line indexes (0 = the first line)`);
      }
    }
    if (slide.kind === 'prompt' && !(slide.blocks || []).length) problems.push(`${at}: the prompt slide needs at least one block to copy`);
    for (const [n, shot] of (slide.shots || (slide.shot ? [slide.shot] : [])).entries()) checkShot(shot, slide.shots ? `${at} shot ${n + 1}` : at);
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
export function planPack(spec, { specDir = process.cwd(), takes = {}, readTakeFn = readTake, readStillFn = readStill } = {}) {
  const problems = validateSpec(spec);
  if (problems.length) fail('CAROUSEL_SPEC', `the pack spec is not buildable:\n  - ${problems.join('\n  - ')}`);
  const rules = resolveRules(spec);
  const theme = resolveTheme(spec, { specDir });
  const canvas = CANVASES[rules.canvas];
  const cache = new Map(Object.entries(takes));
  const source = shot => {
    const file = path.resolve(specDir, shot.take || shot.image);
    if (!cache.has(file)) cache.set(file, shot.take ? readTakeFn(file) : readStillFn(file));
    return cache.get(file);
  };
  let step = 0;
  const numbered = spec.slides.map(slide => (STEP_KINDS.has(slide.kind) ? (slide.number ?? ++step) : null));
  const moves = Math.max(0, ...numbered.filter(n => n != null));
  const slides = spec.slides.map((slide, i) => {
    const out = { ...slide, kind: slide.kind === 'text' ? 'note' : slide.kind, index: i + 1 };
    if (STEP_KINDS.has(slide.kind)) { out.number = numbered[i]; out.moves = moves; }
    const given = slide.shots || (slide.shot ? [slide.shot] : []);
    out.shots = given.map(shot => planShot(shot, i));
    delete out.shot;
    if (slide.kind === 'terminal') {
      // The frame is cut large for OCR only; the slide retypes its lines (see readTerminal).
      const term = slide.terminal;
      const read = planShot({ ...term, highlight: null, masks: [], marker: false, width: Math.round(term.crop[2] * TERMINAL_OCR_SCALES[0]) }, i);
      out.terminal = { ...read, warnings: [], highlight: term.highlight || [], header: term.header ?? 0, lines: term.lines || null };
    }
    return out;
  });
  return { ...spec, rules, theme, canvas: { name: rules.canvas, ...canvas }, slides };

  function planShot(shot, i) {
    const src = source(shot);
    let t = src.still ? 0 : shot.t;
    let marker = null;
    if (shot.typing != null) {
      const burst = src.steps.find(s => s.type === 'typing' && String(s.id) === String(shot.typing));
      if (!burst) fail('CAROUSEL_SPEC', `slide ${i + 1}: ${src.name} has no typing burst with id ${shot.typing}`);
      // A burst usually ends on Enter, which clears the input: the typed text is on screen just before.
      t ??= burst.vt + (shot.after ?? -0.3);
    }
    if (shot.click != null) {
      const click = src.steps.find(s => s.type === 'click' && String(s.id) === String(shot.click));
      if (!click) fail('CAROUSEL_SPEC', `slide ${i + 1}: ${src.name} has no in-capture click with id ${shot.click}`);
      t ??= click.vt + (shot.after ?? 0.35);
      if (shot.marker !== false) marker = { x: click.x, y: click.y };
    }
    const [cx, cy, cw, ch] = shot.crop.map(Number);
    if (cx < 0 || cy < 0 || cx + cw > src.width || cy + ch > src.height) {
      fail('CAROUSEL_SPEC', `slide ${i + 1}: crop ${shot.crop.join(',')} leaves the ${src.width}×${src.height} frame`);
    }
    const width = shot.width || shotWidth(theme.vars, canvas);
    const scale = width / cw;
    const toSlide = ([x, y, w, h]) => [(x - cx) * scale, (y - cy) * scale, w * scale, h * scale].map(Math.round);
    return {
      ...shot, takeName: src.name, video: src.video, still: Boolean(src.still), t: r3(t), crop: [cx, cy, cw, ch],
      width, height: Math.round(ch * scale), scale: r3(scale),
      marker: marker && marker.x >= cx && marker.x <= cx + cw && marker.y >= cy && marker.y <= cy + ch
        ? { x: Math.round((marker.x - cx) * scale), y: Math.round((marker.y - cy) * scale) } : null,
      highlight: shot.highlight ? toSlide(shot.highlight) : null,
      masks: (shot.masks || []).map(m => ({ rect: toSlide(m.rect || m), color: m.color || null })),
      warnings: scale > rules.maxUpscale ? [`upscaled ${r1(scale)}× from the capture: it will read soft`] : [],
    };
  }
}

// ─── Render ─────────────────────────────────────────────────────────────────────────────────

/** Seek one frame (never decode the file), crop it, and scale it to its on-slide size. */
export function extractShot(shot, file) {
  requireBinary('ffmpeg', 'carousel');
  const [x, y, w, h] = shot.crop;
  const filter = `crop=${w}:${h}:${x}:${y},scale=${shot.width}:${shot.height}:flags=lanczos`
    + (shot.scale > 1.2 ? ',unsharp=5:5:0.45:5:5:0' : '');
  const seek = shot.still ? [] : ['-ss', String(shot.t)];
  const run = spawnSync('ffmpeg', ['-v', 'error', '-y', ...seek, '-i', shot.video, '-frames:v', '1', '-vf', filter, file], { encoding: 'utf8' });
  if (run.status !== 0 || !fs.existsSync(file)) fail('CAROUSEL_FRAME', `ffmpeg could not cut ${shot.takeName} at ${shot.t}s: ${String(run.stderr).trim().split('\n').pop()}`);
  return file;
}

// ─── Terminal slides ────────────────────────────────────────────────────────────────────────
//
// A terminal at a normal font size never reaches the 36 px floor as a screenshot (an 80-column
// line is ~800 source px wide on an ~870 px card). A `terminal` slide retypes the frame's lines
// instead, verbatim: the frame is read twice by OCR (at two upscales) and every line is checked
// character by character, against the spec's locked `lines` when it has them.

/** The upscales the frame is read at; the first is the one compared against locked lines. */
export const TERMINAL_OCR_SCALES = Object.freeze([3, 2]);

/** Vision observations → the terminal's rows, top to bottom (fragments on one row joined in x order). */
export function ocrRows(observations) {
  const rows = [];
  for (const o of [...observations].filter(o => String(o.text).trim()).sort((p, q) => (p.y + p.h / 2) - (q.y + q.h / 2))) {
    const cy = o.y + o.h / 2;
    const row = rows.find(r => Math.abs(r.cy - cy) < Math.max(r.h, o.h) * 0.5);
    if (row) row.parts.push(o);
    else rows.push({ cy, h: o.h, parts: [o] });
  }
  return rows.map(r => r.parts.sort((p, q) => p.x - q.x).map(p => String(p.text).trim()).join(' '));
}

// Only what OCR confuses and a reader would not: dot-like glyphs, prompt chevrons, typographic
// quotes and dashes, odd spaces. Never l/I/1 or O/0: that is where real misreads hide.
const foldTerminal = text => String(text).normalize('NFKC')
  .replace(/[•·∙‧⋅]/g, '.').replace(/[›❯»]/g, '>').replace(/[‘’´`]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
// A TUI's border, tree branch or prompt chevron (│ ⎿ ❯ …) leads a line as decoration, and OCR
// reads it as anything: I, l, L, 2, ), ≥. When the locked line starts with one, any single
// character there is accepted. Whitespace is not compared (OCR drops and adds spaces in a
// monospace grid); every visible character after the lead glyph is.
const LEAD_GLYPH = /^[│|┃▌▎⎿└├╰>›❯»]\s*/;
const stripBorder = text => text.replace(LEAD_GLYPH, '');
const squash = text => text.replace(/\s+/g, '');
const readCores = read => {
  const b = foldTerminal(read);
  return [b, stripBorder(b), ...(/^\S /.test(b) ? [b.slice(2)] : [])].map(squash);
};

/** Whether a locked line and an OCR read of it are the same text. */
export function sameTerminalLine(locked, read) {
  const a = foldTerminal(locked);
  const cores = readCores(read);
  if (cores[0] === squash(a)) return true;
  return LEAD_GLYPH.test(a) && cores.includes(squash(stripBorder(a)));
}

const firstDiff = (locked, read) => {
  const x = squash(stripBorder(foldTerminal(locked)));
  return Math.max(...readCores(read).map(y => {
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    return i + 1;
  }));
};
const clip = text => `"${String(text).slice(0, 60)}"`;

/**
 * The verbatim check. With locked `lines` (blank strings are spacer rows, not compared) each
 * line must match the frame's read; without them the two reads must agree line for line, and
 * the slide carries a warning until someone locks them.
 */
export function checkTerminal([read, second], { lines = null } = {}) {
  const problems = [];
  const warnings = [];
  if (lines) {
    const text = lines.filter(l => l.trim());
    const rows = [read, second].find(r => r.length === text.length);
    if (!rows) {
      problems.push(`terminal: the frame reads ${read.length} lines, terminal.lines has ${text.length} (frame: ${read.map(clip).join(', ')})`);
    } else {
      text.forEach((line, i) => {
        if (sameTerminalLine(line, read[i] ?? '') || sameTerminalLine(line, second[i] ?? '')) return;
        const [at, seen] = [read[i], second[i]].filter(r => r != null).map(r => [firstDiff(line, r), r]).sort((p, q) => q[0] - p[0])[0];
        problems.push(`terminal line ${i + 1}: ${clip(line)} is not the frame's ${clip(seen)} (character ${at}, spaces not counted)`);
      });
    }
    return { lines, locked: true, problems, warnings };
  }
  if (read.length !== second.length) problems.push(`terminal: the two OCR reads find ${read.length} and ${second.length} lines; lock terminal.lines`);
  else read.forEach((row, i) => {
    if (!sameTerminalLine(row, second[i])) problems.push(`terminal line ${i + 1}: the OCR reads disagree (${clip(row)} / ${clip(second[i])}); lock terminal.lines`);
  });
  warnings.push('terminal lines are read by OCR, not locked: check them against the frame and copy them into terminal.lines');
  return { lines: read, locked: false, problems, warnings };
}

/** Cut the frame at each OCR scale, read it, and check the lines. */
export function readTerminalFrame(term, base, { ocr = ocrImage } = {}) {
  const [, , cw, ch] = term.crop;
  const reads = TERMINAL_OCR_SCALES.map(k => {
    const shot = { ...term, width: Math.round(cw * k), height: Math.round(ch * k), scale: k };
    const file = extractShot(shot, `${base}-terminal-${k}x.png`);
    return ocrRows(ocr(file, { size: { width: shot.width, height: shot.height } }));
  });
  return checkTerminal(reads, term);
}

/** What the template gets for a terminal slide: the header cue lines, then the body lines. */
export function terminalData(term) {
  const lines = term.read?.lines || term.lines || [];
  const header = Math.min(term.header || 0, lines.length);
  const marked = new Set(term.highlight || []);
  return {
    header: lines.slice(0, header),
    lines: lines.slice(header).map((text, i) => ({ text, highlight: marked.has(i + header) })),
    dark: term.dark !== false,
  };
}

/** The template's fixed words; a spec's `labels` overrides any of them. */
export const DEFAULT_LABELS = Object.freeze({
  eyebrow: 'دليل خطوة بخطوة', needs: 'شو بتحتاج:', cta: 'اكتب بالتعليقات', stepOf: 'الحركة {n} من {total}',
  save: 'احفظه، وارجعله وقت ما تحتاجه', swipe: 'اسحب',
});

const kicker = (template, n, total) => (n == null || !template ? '' : template.replace('{n}', arabicNumeral(n)).replace('{total}', arabicNumeral(total)));

/** Everything a theme template needs for one slide (its contract is in docs/carousel-spec.md). */
export function slideData(slide, { total, handle, tokens, shotUrls = [], labels, theme = null, canvas = SLIDE, inset = DEFAULT_RULES.inset }) {
  const words = { ...DEFAULT_LABELS, ...(labels || {}) };
  return {
    kind: slide.kind, index: slide.index, total, number: slide.number != null ? arabicNumeral(slide.number) : null,
    kicker: STEP_KINDS.has(slide.kind) ? (slide.kicker ?? kicker(words.stepOf, slide.number, slide.moves || slide.number)) : (slide.kicker || ''),
    headline: slide.headline, sub: slide.sub || '', body: slide.body || '', items: slide.items || [], figure: slide.figure || '',
    needs: slide.needs || [], blocks: slide.blocks || [], keyword: slide.keyword || '', after: slide.after || '', handle: handle || '',
    canvas: { width: canvas.width, height: canvas.height }, inset, vars: theme?.vars || {}, fonts: theme?.fonts || [],
    shots: (slide.shots || []).map((shot, i) => ({ url: shotUrls[i], label: shot.label || '', width: shot.width, height: shot.height,
      marker: shot.marker, highlight: shot.highlight, masks: shot.masks, dark: Boolean(shot.dark) })),
    terminal: slide.terminal?.read ? terminalData(slide.terminal) : null,
    // The bundled profile's neutrals; a creator's own brand comes from their profile layer.
    colors: { brand: tokens?.color?.brand || '#3D3D3D', accent: tokens?.color?.accent || '#FFB020', ink: tokens?.color?.ink || '#0B0B14' },
    labels: words,
  };
}

/** Where a canvas's slides go: exports/instagram-3x4 or exports/instagram-4x5. */
export const exportDirName = canvasName => `instagram-${canvasName}`;

/** Render every slide to exports/instagram-<canvas>/slide-NN.png. Returns the slide files and the boxes QA measures. */
export async function renderSlides(plan, { out, profile, browserFactory, ocr = ocrImage } = {}) {
  const canvas = plan.canvas || { name: '3x4', ...SLIDE };
  const exportsDir = path.join(out, 'exports', exportDirName(canvas.name));
  const shotsDir = path.join(out, 'shots');
  for (const stale of fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).filter(f => /^slide-\d+\.png$/.test(f)) : []) fs.rmSync(path.join(exportsDir, stale));
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
    const context = await browser.newContext({ viewport: { width: canvas.width, height: canvas.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(plan.theme.template).href);
    for (const slide of plan.slides) {
      const name = `slide-${String(slide.index).padStart(2, '0')}`;
      if (slide.terminal) slide.terminal.read = readTerminalFrame(slide.terminal, path.join(shotsDir, name), { ocr });
      const shotUrls = slide.shots.map((shot, i) => pathToFileURL(extractShot(shot, path.join(shotsDir, `${name}${slide.shots.length > 1 ? `-${i + 1}` : ''}.png`))).href);
      const data = slideData(slide, { total, handle: plan.handle, tokens: profile?.tokens, shotUrls, labels: plan.labels,
        theme: plan.theme, canvas, inset: (plan.rules || DEFAULT_RULES).inset });
      const box = await page.evaluate(async value => window.renderSlide(value), data);
      if (errors.length) fail('CAROUSEL_RENDER', `${name}: ${errors.join('; ')}`);
      const file = path.join(exportsDir, `${name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: canvas.width, height: canvas.height } });
      results.push({ index: slide.index, kind: slide.kind, file, shotBoxes: box?.shots || [], cardBoxes: box?.cards || [], texts: box?.texts || [],
        ...(slide.terminal ? { terminal: slide.terminal.read } : {}) });
    }
  } finally {
    await browser.close();
  }
  return results;
}

// ─── QA ─────────────────────────────────────────────────────────────────────────────────────

/** Vision OCR on one image → [{text, x, y, w, h}] in pixels. */
export function ocrImage(file, { languages = 'en-US', size = SLIDE } = {}) {
  const bin = path.join(PACKAGE_ROOT, 'tools', 'vision', 'ocr');
  if (!fs.existsSync(bin)) fail('CAROUSEL_OCR', 'the Vision OCR helper is not built: swiftc -O -o tools/vision/ocr tools/vision/ocr.swift');
  const run = spawnSync(bin, [file, '--languages', languages], { encoding: 'utf8' });
  if (run.status !== 0) fail('CAROUSEL_OCR', `OCR failed on ${file}: ${String(run.stderr).trim()}`);
  return JSON.parse(run.stdout).map(r => ({ text: r.text, x: r.x * size.width, y: r.y * size.height, w: r.w * size.width, h: r.h * size.height }));
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

/** OCR lines (3+ visible characters) inside the shot box that come within `pad` px of its left or right edge. */
export function edgeCut(lines, box, pad) {
  if (!box) return [];
  return lines.filter(l => String(l.text || '').replace(/[^\p{L}\p{N}]/gu, '').length >= 3)
    .filter(l => {
      const cy = l.y + l.h / 2;
      return cy >= box.y && cy <= box.y + box.h && l.x + l.w > box.x && l.x < box.x + box.w;
    })
    .filter(l => l.x < box.x + pad || l.x + l.w > box.x + box.w - pad)
    .map(l => l.text);
}

/**
 * The theme-measured checks (sizes, insets, the bottom band, words) for one rendered slide.
 * `texts` and `cards` are what the theme reported, in canvas px.
 */
const NOT_COPY = new Set(['footer', 'swipe', 'terminal', 'termHeader']);

export function layoutProblems(slide, { texts = [], cards = [] }, rules, canvas) {
  const problems = [];
  const warnings = [];
  for (const t of texts) {
    const floor = rules.minPx[t.role] ?? rules.minPx.any;
    if (t.px + 0.5 < floor || t.px + 0.5 < rules.minPx.any) problems.push(`${t.role} text at ${r1(t.px)} px (min ${Math.max(floor, rules.minPx.any)})`);
  }
  const inset = rules.inset;
  const outside = [...texts.map(t => ({ what: `${t.role} "${String(t.text).slice(0, 24)}"`, r: t.rect })), ...cards.map((r, i) => ({ what: `card ${i + 1}`, r }))]
    .filter(({ r }) => r.w > 0 && (r.x < inset - 1 || r.y < inset - 1 || r.x + r.w > canvas.width - inset + 1 || r.y + r.h > canvas.height - inset + 1));
  if (outside.length) problems.push(`inside the ${inset} px inset: ${outside.map(o => o.what).join(', ')}`);
  const band = canvas.height * (1 - rules.bottomClear);
  const low = [...texts.filter(t => !['footer', 'swipe'].includes(t.role)).map(t => ({ what: t.role, r: t.rect })), ...cards.map((r, i) => ({ what: `card ${i + 1}`, r }))]
    .filter(({ r }) => r.y + r.h > band + 1);
  if (low.length) problems.push(`in the bottom ${Math.round(rules.bottomClear * 100)}%: ${[...new Set(low.map(o => o.what))].join(', ')}`);
  // Retyped terminal output is evidence, like a screenshot: its words are not the slide's copy.
  const words = texts.filter(t => !NOT_COPY.has(t.role)).reduce((n, t) => n + countWords(t.text), 0);
  const dense = slide.dense ?? slide.kind === 'prompt';
  if (words > rules.maxSlideWords && !dense) problems.push(`${words} words on the slide (review anything over ${rules.maxSlideWords}; mark a reference slide dense)`);
  else if (words < rules.slideWords[0] || words > rules.slideWords[1]) warnings.push(`${words} words (aim ${rules.slideWords[0]}–${rules.slideWords[1]})`);
  return { problems, warnings, words };
}

export function qaPack(plan, rendered, { ocr = ocrImage, privacy = checkPrivacy } = {}) {
  const rules = plan.rules || DEFAULT_RULES;
  const canvas = plan.canvas || SLIDE;
  const slides = rendered.map(result => {
    const slide = plan.slides.find(s => s.index === result.index);
    const lines = ocr(result.file, { size: canvas });
    const shotBoxes = result.shotBoxes || [];
    const perShot = shotBoxes.map(box => shotTextPx(lines, box));
    const measured = perShot.filter(v => v != null);
    const textPx = shotBoxes.length ? (measured.length ? Math.min(...measured) : null) : null;
    const fill = (result.cardBoxes || []).length ? r3(result.cardBoxes.reduce((h, b) => h + b.h, 0) / canvas.height) : null;
    const cut = shotBoxes.flatMap(box => edgeCut(lines, box, rules.edgePadPx));
    const names = [...new Set(privacy([...lines.map(l => l.text), ...(result.terminal?.lines || [])]))];
    const layout = layoutProblems(slide, { texts: result.texts || [], cards: result.cardBoxes || [] }, rules, canvas);
    const problems = [];
    if (shotBoxes.length && slide.kind !== 'cover' && (textPx == null || textPx < rules.minTextPx)) problems.push(`UI text reads at ${textPx ?? 'no'} px (min ${rules.minTextPx})`);
    if (slide.kind === 'step' && fill != null && fill < rules.minShotFill) problems.push(`the shot fills ${Math.round(fill * 100)}% of the slide (min ${Math.round(rules.minShotFill * 100)}%)`);
    if (cut.length) problems.push(`text cut at the shot's edge: ${cut.map(t => `"${String(t).slice(0, 32)}"`).join(', ')}`);
    problems.push(...layout.problems, ...(result.terminal?.problems || []));
    if (names.length) problems.push(`privacy: ${names.join(', ')}`);
    const warnings = [...slide.shots.flatMap(s => s.warnings || []), ...(result.terminal?.warnings || []), ...layout.warnings];
    return { index: result.index, kind: slide.kind, textPx, fill, words: layout.words, privacy: names, warnings, verdict: problems.length ? 'FAIL' : 'PASS', problems };
  });
  return { verdict: slides.some(s => s.verdict === 'FAIL') ? 'FAIL' : 'PASS', minTextPx: rules.minTextPx, minShotFill: rules.minShotFill, slides };
}

// ─── Pack files ─────────────────────────────────────────────────────────────────────────────

export function contactSheet(files, out, { columns = 4, width = 360, canvas = SLIDE } = {}) {
  requireBinary('ffmpeg', 'carousel');
  const rows = Math.ceil(files.length / columns);
  const inputs = files.flatMap(file => ['-i', file]);
  const scaled = files.map((_, i) => `[${i}:v]scale=${width}:-1[s${i}]`).join(';');
  const layout = files.map((_, i) => `${(i % columns) * width}_${Math.floor(i / columns) * Math.round(width * canvas.height / canvas.width)}`).join('|');
  const filter = `${scaled};${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=white[out]`;
  const run = spawnSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-q:v', '3', out], { encoding: 'utf8' });
  if (run.status !== 0) fail('CAROUSEL_SHEET', `contact sheet failed: ${String(run.stderr).trim().split('\n').pop()}`);
  return { file: out, columns, rows };
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The pack's source page: every slide in order, the captions, and the spec it was built from. */
export function indexHtml(plan, files) {
  const canvas = plan.canvas || { name: '3x4', ...SLIDE };
  const imgs = files.map(f => `<img src="exports/${exportDirName(canvas.name)}/${path.basename(f)}" alt="" width="360" height="${Math.round(360 * canvas.height / canvas.width)}">`).join('\n  ');
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

const localFree = shot => ({ ...shot, video: undefined, take: shot.still ? undefined : shot.takeName, image: shot.still ? shot.takeName : undefined });

/** The spec as recorded in the pack: take folder names only, never local absolute paths. */
function stripLocal(plan) {
  return {
    ...plan,
    theme: { name: plan.theme?.name, vars: plan.theme?.vars },
    slides: plan.slides.map(s => ({ ...s, shots: s.shots.map(localFree),
      ...(s.terminal ? { terminal: { ...localFree(s.terminal), read: s.terminal.read ? { lines: s.terminal.read.lines, locked: s.terminal.read.locked } : undefined } } : {}) })),
  };
}

/** Alt text per slide: the spec's `alt`, else the headline plus what each shot shows (`shot.alt`). */
export function altText(slide) {
  if (slide.alt) return slide.alt;
  const plain = s => String(s || '').replace(/`/g, '');
  const term = slide.terminal ? [slide.terminal.alt || (slide.terminal.read?.lines || slide.terminal.lines || []).join(' / ')] : [];
  return [plain(slide.headline), ...(slide.shots || []).map(shot => plain(shot.alt)), ...term.map(plain)].filter(Boolean).join(' — ');
}

export function packMetadata(plan, { qa, sheet, now = new Date().toISOString() }) {
  return {
    title: plan.title || plan.slug,
    slug: plan.slug,
    concept_id: plan.conceptId || plan.slug.replace(/-v\d+$/, ''),
    concept_title: plan.title || plan.slug,
    iteration_label: plan.iterationLabel || 'Guide twin v1',
    format: plan.canvas?.name || '3x4',
    output_size: [plan.canvas?.width || SLIDE.width, plan.canvas?.height || SLIDE.height],
    generator: 'capcutctl carousel build',
    source_item_id: plan.sourceItemId ?? '',
    source_url: plan.sourceUrl || '',
    source_post_id: plan.sourcePostId || '',
    lifecycle: { status: 'draft' },
    lifecycle_status: 'draft',
    archived: false,
    posted: false,
    captions: { instagram: plan.caption || '', tiktok: plan.tiktokCaption || plan.caption || '' },
    qa_notes: `capcutctl carousel QA ${qa.verdict}: ${qa.slides.map(s => `${s.index}:${s.kind}${s.textPx ? ` ${s.textPx}px` : ''}${s.fill != null ? ` fill ${Math.round(s.fill * 100)}%` : ''}${s.problems.length ? ` (${s.problems.join('; ')})` : ''}`).join(', ')}`,
    qa,
    theme: plan.theme?.name || DEFAULT_THEME_NAME,
    slide_boxes: plan.slides.map(s => ({ slide: s.index, kind: s.kind, headline: s.headline,
      shots: s.shots.map(shot => ({ source: shot.takeName, t: shot.t, crop: shot.crop, scale: shot.scale, marker: Boolean(shot.marker) })),
      ...(s.terminal ? { terminal: { source: s.terminal.takeName, t: s.terminal.t, crop: s.terminal.crop, lines: s.terminal.read?.lines || s.terminal.lines, locked: Boolean(s.terminal.read?.locked) } } : {}) })),
    alt_text: plan.slides.map(s => ({ slide: s.index, text: altText(s) })),
    exports: { slides: `exports/${exportDirName(plan.canvas?.name || '3x4')}`, tiktok: `exports/${TIKTOK_DIR}` },
    contact_sheet: sheet ? path.relative(path.dirname(path.dirname(sheet.file)), sheet.file) : '',
    created_at: now,
    updated_at: now,
  };
}

export async function buildPack(spec, { out, specDir, profile, browserFactory, ocr, privacy } = {}) {
  const plan = planPack(spec, { specDir });
  const dir = path.resolve(out || plan.slug);
  fs.mkdirSync(dir, { recursive: true });
  const rendered = await renderSlides(plan, { out: dir, profile, browserFactory, ...(ocr ? { ocr } : {}) });
  const files = rendered.map(r => r.file);
  const sheet = contactSheet(files, path.join(dir, 'exports', `contact-sheet-${exportDirName(plan.canvas.name)}.jpg`), { canvas: plan.canvas });
  mirrorForDashboard(dir, plan.canvas.name, files, sheet.file);
  tiktokExport(dir, files, plan.canvas, plan.theme?.vars?.bg);
  const qa = qaPack(plan, rendered, { ...(ocr ? { ocr } : {}), ...(privacy ? { privacy } : {}) });
  fs.writeFileSync(path.join(dir, 'index.html'), indexHtml(plan, files));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(packMetadata(plan, { qa, sheet }), null, 2) + '\n');
  return { pack: dir, slides: files, contactSheet: sheet.file, qa };
}

export const TIKTOK_DIR = 'tiktok-9x16';
export const TIKTOK_CANVAS = Object.freeze({ width: 1080, height: 1920 });

/**
 * The same slides on TikTok's 9:16 canvas: the slide sits centred in the top 90 %, so the bottom
 * tenth (where TikTok draws the caption and buttons) holds only background.
 */
export function tiktokExport(dir, files, canvas, bg = '#FFFFFF') {
  requireBinary('ffmpeg', 'carousel');
  const out = path.join(dir, 'exports', TIKTOK_DIR);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const top = Math.floor((TIKTOK_CANVAS.height * 0.9 - canvas.height) / 2);
  const color = /^#[0-9a-f]{6}$/i.test(bg) ? `0x${bg.slice(1)}` : 'white';
  for (const file of files) {
    const target = path.join(out, path.basename(file));
    const run = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `pad=${TIKTOK_CANVAS.width}:${TIKTOK_CANVAS.height}:${Math.floor((TIKTOK_CANVAS.width - canvas.width) / 2)}:${top}:color=${color}`, target], { encoding: 'utf8' });
    if (run.status !== 0) fail('CAROUSEL_TIKTOK', `9:16 export of ${path.basename(file)} failed: ${String(run.stderr).trim()}`);
  }
  return { dir: out, top };
}

/**
 * The dashboard publishes from exports/instagram-4x5 and shows contact-sheet-instagram-4x5.jpg
 * first, whatever their size; its own 3:4 packs mirror their 1080×1440 slides there and keep
 * metadata `format: "3x4"`. Do the same, and drop stale slides a longer earlier build left.
 */
function mirrorForDashboard(dir, canvasName, files, sheetFile) {
  if (canvasName === '4x5') return;
  const mirror = path.join(dir, 'exports', exportDirName('4x5'));
  fs.rmSync(mirror, { recursive: true, force: true });
  fs.mkdirSync(mirror, { recursive: true });
  for (const file of files) fs.copyFileSync(file, path.join(mirror, path.basename(file)));
  fs.copyFileSync(sheetFile, path.join(dir, 'exports', 'contact-sheet-instagram-4x5.jpg'));
}

// ─── Stage ──────────────────────────────────────────────────────────────────────────────────

/** The only dashboard routes `stage` may call. Publishing routes are absent on purpose. */
export const STAGE_ROUTES = Object.freeze([
  ['PATCH', /^\/api\/carousels\/[a-z0-9-]+\/metadata$/],
  ['GET', /^\/api\/carousels\/[a-z0-9-]+\/publish\/jobs$/],
  ['POST', /^\/api\/carousels\/[a-z0-9-]+\/publish\/jobs$/],
  // Edits a draft job's captions in place; sending is /tiktok, /instagram, /youtube, never listed.
  ['PATCH', /^\/api\/carousels\/publish\/jobs\/\d+$/],
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
  const captions = {
    title: meta.title, caption: meta.captions?.instagram || '', instagram_caption: meta.captions?.instagram || '',
    tiktok_caption: meta.captions?.tiktok || '',
  };
  let job;
  if (active) {
    // Restaging updates the same draft job: its captions follow the pack, nothing new is created.
    const patched = active.status === 'draft' ? await call('PATCH', `/api/carousels/publish/jobs/${active.id}`, captions) : null;
    job = { status: 200, json: patched?.json?.id ? patched.json : active, reused: true, captionsUpdated: Boolean(patched && !patched.dryRun) };
  } else {
    job = await call('POST', `/api/carousels/${slug}/publish/jobs`, { slug, ...captions, platforms });
  }
  const listed = await call('GET', '/api/carousels');
  const found = Array.isArray(listed.json?.packs) ? listed.json.packs.find(p => p.slug === slug) : null;
  return {
    slug, copied, metadata: metadata.status ?? 'dry-run', job: job.json?.id ? { id: job.json.id, status: job.json.status, platforms: job.json.platforms, reused: Boolean(job.reused), captionsUpdated: Boolean(job.captionsUpdated) } : job,
    listed: found ? { slideCount: found.slide_count, lifecycle: found.lifecycle_status, sourceItemId: found.source_item_id } : (dryRun ? 'dry-run' : 'NOT LISTED'),
    next: 'Nothing was sent anywhere. Posting to Instagram, or sending the TikTok photo draft to the TikTok inbox, is a separate yes in the dashboard.',
  };
}

function rsyncPack(dir, remote, slug) {
  requireBinary('rsync', 'carousel stage');
  const target = `${remote.replace(/\/+$/, '')}/${slug}/`;
  const run = spawnSync('rsync', ['-a', '--exclude', 'shots/', `${dir}/`, target], { encoding: 'utf8' });
  if (run.status !== 0) fail('CAROUSEL_STAGE', `rsync to ${target} failed: ${String(run.stderr).trim()}`);
  // The slide folders are this pack's own: mirror them exactly, so a shorter rebuild leaves no
  // stale slide behind. Everything else in the remote folder (the dashboard's publish files) stays.
  for (const sub of fs.readdirSync(path.join(dir, 'exports')).filter(name => /^instagram-\dx\d$/.test(name))) {
    const exact = spawnSync('rsync', ['-a', '--delete', `${dir}/exports/${sub}/`, `${target}exports/${sub}/`], { encoding: 'utf8' });
    if (exact.status !== 0) fail('CAROUSEL_STAGE', `rsync of exports/${sub} failed: ${String(exact.stderr).trim()}`);
  }
  return { to: target };
}
