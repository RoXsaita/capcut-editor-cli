import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapcutError, allSegments, resolveMediaPath } from './core.mjs';
import { opScaleKeyframe, resolveClip } from './add.mjs';
import { peakUpscale, UPSCALE_REFUSE } from './crispness.mjs';
import { momentsFromSidecar } from './broll-lint.mjs';
import { pythonForTool } from './python.mjs';

const US = s => Math.round(s * 1e6);
const S = us => (us || 0) / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;

export const DEFAULT_ZOOM = 1.6;
export const CLICK_LEAD = 0.25;
export const DEFAULT_RAMP = 0.2;
export const DEFAULT_HOLD = 1.6;
/** Same floor as B-roll-in-motion / the change-index merge threshold. */
export const CHANGE_HIGH = 0.5;
const REST_SLACK = 1.02;

function materialFor(doc, id) {
  for (const values of Object.values(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    const found = values.find(item => item && item.id === id);
    if (found) return found;
  }
  return null;
}

export function normaliseQuery(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function speedOf(segment) {
  const st = segment.source_timerange, tt = segment.target_timerange;
  return st && tt?.duration ? st.duration / tt.duration : 1;
}

export function sourceOfTimeline(segment, timelineS) {
  const tt = segment.target_timerange, st = segment.source_timerange;
  if (!st || !tt) return timelineS;
  return S(st.start) + (timelineS - S(tt.start)) * speedOf(segment);
}

export function timelineOfSource(segment, sourceS) {
  const tt = segment.target_timerange, st = segment.source_timerange;
  if (!st || !tt?.duration) return S(tt?.start);
  return S(tt.start) + (sourceS - S(st.start)) / speedOf(segment);
}

export function matchOcrBoxes(boxes, query) {
  const needle = normaliseQuery(query);
  if (!needle) return [];
  const terms = needle.split(' ').filter(Boolean);
  return (boxes || []).filter(box => {
    const text = normaliseQuery(box?.text);
    if (!text) return false;
    if (text.includes(needle) || needle.includes(text)) return true;
    return terms.every(term => text.includes(term));
  });
}

function finitePair(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Click position in normalised 0..1 source space (top-left origin, matching OCR boxes).
 * Accepts nx/ny, a 0..1 x/y, or pixel x/y when source dimensions are known.
 */
export function clickPoint(click, sourceDims = null) {
  if (!click || typeof click !== 'object') return null;
  const norm = finitePair(Number(click.nx ?? click.normX), Number(click.ny ?? click.normY));
  if (norm) return norm;
  const x = Number(click.x), y = Number(click.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x, y };
  const sw = Number(sourceDims?.width), sh = Number(sourceDims?.height);
  if (sw > 0 && sh > 0) return { x: x / sw, y: y / sh };
  return null;
}

function boxCenter(box) {
  return { x: Number(box.x) + Number(box.w) / 2, y: Number(box.y) + Number(box.h) / 2 };
}

function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function pickBox(hits, click = null, sourceDims = null) {
  if (!hits?.length) {
    throw new CapcutError('punch found no OCR box matching --on.', {
      code: 'PUNCH_NOT_FOUND', exitCode: 2,
    });
  }
  if (hits.length === 1) return hits[0];
  const point = clickPoint(click, sourceDims);
  if (!point) {
    throw new CapcutError(
      `punch --on is ambiguous (${hits.length} matches); pass a take with a click near one, or name a unique label.`,
      {
        code: 'PUNCH_AMBIGUOUS',
        exitCode: 2,
        details: { candidates: hits.map(box => ({ text: box.text, x: box.x, y: box.y, w: box.w, h: box.h })) },
      },
    );
  }
  return [...hits].sort((a, b) => distance(boxCenter(a), point) - distance(boxCenter(b), point))[0];
}

/**
 * Source-pixel rectangle that, fed to `keyframe --focus`, yields ~`zoom` centred on the box.
 * Clamped so the framed region stays inside the source — the model never emits a coordinate.
 */
export function focusRectForZoom({ box, sourceW, sourceH, canvasW, canvasH, zoom }) {
  if (!(sourceW > 0 && sourceH > 0 && canvasW > 0 && canvasH > 0 && zoom > 0)) {
    throw new CapcutError('punch needs known source and canvas dimensions.', {
      code: 'BAD_FOCUS', exitCode: 2,
    });
  }
  const fit = Math.min(canvasW / sourceW, canvasH / sourceH);
  const visW = Math.min(sourceW, (canvasW * 0.9) / (zoom * fit));
  const visH = Math.min(sourceH, (canvasH * 0.9) / (zoom * fit));
  const cx = (Number(box.x) + Number(box.w) / 2) * sourceW;
  const cy = (Number(box.y) + Number(box.h) / 2) * sourceH;
  const x = Math.min(Math.max(0, cx - visW / 2), sourceW - visW);
  const y = Math.min(Math.max(0, cy - visH / 2), sourceH - visH);
  return [x, y, visW, visH];
}

export function scoreAt(moments, t) {
  if (!Array.isArray(moments) || !Number.isFinite(t)) return 0;
  let peak = 0;
  for (const moment of moments) {
    const start = Number(moment.start), end = Number(moment.end);
    const value = Number(moment.peak ?? moment.score);
    if (start <= t && t < end && value > peak) peak = value;
  }
  return peak;
}

/** If `t` sits inside a high-score change run, slide to that run's end (the next quiet frame). */
export function shiftOffMotion(moments, t, { high = CHANGE_HIGH } = {}) {
  const ordered = [...(moments || [])]
    .map(moment => ({
      start: Number(moment.start),
      end: Number(moment.end),
      peak: Number(moment.peak ?? moment.score),
    }))
    .filter(moment => Number.isFinite(moment.start) && Number.isFinite(moment.end) && moment.peak >= high)
    .sort((a, b) => a.start - b.start);
  for (const moment of ordered) {
    if (t >= moment.start && t < moment.end) {
      return { t: moment.end, shiftedFrom: t };
    }
  }
  return { t, shiftedFrom: null };
}

function reactionEnd(moments, event, { high = CHANGE_HIGH } = {}) {
  const ordered = [...(moments || [])]
    .map(moment => ({
      start: Number(moment.start),
      end: Number(moment.end),
      peak: Number(moment.peak ?? moment.score),
    }))
    .filter(moment => Number.isFinite(moment.start) && Number.isFinite(moment.end) && moment.peak >= high)
    .sort((a, b) => a.start - b.start);
  const containing = ordered.find(moment => moment.start <= event && event <= moment.end);
  if (containing) return containing.end;
  const next = ordered.find(moment => moment.start >= event);
  return next ? next.end : null;
}

function parseHold(hold) {
  if (hold == null || hold === '' || hold === 'auto') return 'auto';
  const value = Number(hold);
  if (!Number.isFinite(value) || value < 0) {
    throw new CapcutError('--hold expects auto or a nonnegative number of seconds.', {
      code: 'BAD_HOLD', exitCode: 2,
    });
  }
  return value;
}

/**
 * Camera timing in source seconds. `--at` / `--word` name the event; this returns when
 * the push starts (`arrive`), how long to hold on-screen, and whether we slid off a scroll.
 */
export function planPunchTiming({
  kind = 'click',
  eventSource,
  moments = [],
  hold = 'auto',
  ramp = DEFAULT_RAMP,
  speed = 1,
} = {}) {
  if (!Number.isFinite(eventSource)) {
    throw new CapcutError('punch needs --at T or --word TEXT to time the move.', {
      code: 'PUNCH_NO_TIME', exitCode: 2,
    });
  }
  const parsedHold = parseHold(hold);
  const wanted = kind === 'result'
    ? (reactionEnd(moments, eventSource) ?? eventSource)
    : eventSource - CLICK_LEAD;
  const quiet = shiftOffMotion(moments, wanted);
  const arrive = quiet.t;
  let holdSeconds;
  if (parsedHold === 'auto') {
    if (kind === 'result') {
      holdSeconds = DEFAULT_HOLD;
    } else {
      const settle = reactionEnd(moments, eventSource);
      const sourceHold = settle != null ? settle - arrive - ramp * speed : DEFAULT_HOLD * speed;
      holdSeconds = Math.max(0, sourceHold / speed);
    }
  } else {
    holdSeconds = parsedHold;
  }
  return {
    arrive,
    hold: holdSeconds,
    ramp,
    shifted: quiet.shiftedFrom != null,
    shiftedFrom: quiet.shiftedFrom,
  };
}

function restScale(segment) {
  const x = Number(segment?.clip?.scale?.x);
  return Number.isFinite(x) && x > 0 ? x : 1;
}

function scaleKeys(segment) {
  return [...((segment?.common_keyframes || [])
    .find(block => block.property_type === 'KFTypeScaleX')?.keyframe_list || [])]
    .sort((a, b) => a.time_offset - b.time_offset);
}

export function assertNoDoublePunch(segment, startUs, endUs) {
  const keys = scaleKeys(segment);
  if (!keys.length) return;
  const rest = restScale(segment);
  const punched = value => Number(value) > rest * REST_SLACK;
  const overlap = keys.some(key => key.time_offset >= startUs - 1 && key.time_offset <= endUs + 1);
  if (overlap) {
    throw new CapcutError(
      'punch refuses a second punch-in on this clip before it returns to wide. --clear the camera move first.',
      { code: 'DOUBLE_PUNCH', exitCode: 2 },
    );
  }
  const before = keys.filter(key => key.time_offset < startUs);
  if (before.length && punched(before.at(-1).values?.[0])) {
    throw new CapcutError(
      'punch refuses a second punch-in while the clip is still zoomed in. Return to wide first.',
      { code: 'DOUBLE_PUNCH', exitCode: 2 },
    );
  }
}

export function clickNear(clicks, t, window = 1.0) {
  const ranked = (clicks || [])
    .map(click => ({ click, at: Number(click.vt ?? click.t ?? click.start) }))
    .filter(row => Number.isFinite(row.at) && Math.abs(row.at - t) <= window)
    .sort((a, b) => Math.abs(a.at - t) - Math.abs(b.at - t));
  return ranked[0]?.click ?? null;
}

export function wordTime(words, needle) {
  const query = normaliseQuery(needle);
  if (!query) return null;
  for (const word of words || []) {
    const text = normaliseQuery(word.word || word.text);
    if (!text) continue;
    if (text.includes(query) || query.includes(text)) {
      const start = Number(word.start);
      if (Number.isFinite(start)) return start;
    }
  }
  return null;
}

function eventVt(event, session, frames) {
  if (Number.isFinite(event?.vt)) return event.vt;
  const host = [event?.host, event?.input_time, event?.start].find(Number.isFinite);
  if (!Number.isFinite(host)) return null;
  if (frames?.length) {
    let best = frames[0], bestD = Math.abs(frames[0].host - host);
    for (const frame of frames) {
      const d = Math.abs(frame.host - host);
      if (d < bestD) { best = frame; bestD = d; }
    }
    if (Number.isFinite(best.vt)) return best.vt;
  }
  const origin = session?.clock?.first_frame_host ?? session?.start_host;
  return Number.isFinite(origin) ? host - origin : null;
}

function readNdjson(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* truncated last line */ }
  }
  return rows;
}

function sidecarDir(mediaPath, projectDir) {
  if (!mediaPath) return null;
  const here = path.dirname(mediaPath);
  if (fs.existsSync(path.join(here, 'trace.ndjson')) || fs.existsSync(path.join(here, 'change.ndjson'))) {
    return here;
  }
  const name = path.basename(mediaPath);
  const marker = '__screen';
  if (!name.includes(marker)) return null;
  const take = name.split(marker)[0];
  const root = path.join(projectDir || path.dirname(path.dirname(here)), '.capcutctl', 'rl2');
  if (!take || !fs.existsSync(root)) return null;
  try {
    for (const entry of fs.readdirSync(root).sort()) {
      const dir = path.join(root, entry);
      if (entry.startsWith(`${take}__`) && (
        fs.existsSync(path.join(dir, 'trace.ndjson')) || fs.existsSync(path.join(dir, 'change.ndjson'))
      )) return dir;
    }
  } catch { /* missing rl2 folder */ }
  return null;
}

export function loadClicks(mediaPath, projectDir = null) {
  const dir = sidecarDir(mediaPath, projectDir);
  if (!dir) return [];
  let session = {};
  try { session = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); }
  catch { /* optional */ }
  const frames = readNdjson(path.join(dir, 'change.ndjson'))
    .filter(row => Number.isFinite(row.vt) && Number.isFinite(row.host));
  const clicks = [];
  for (const event of readNdjson(path.join(dir, 'trace.ndjson'))) {
    if (event?.type !== 'click' || event.in_capture === false) continue;
    const vt = eventVt(event, session, frames);
    if (!Number.isFinite(vt)) continue;
    clicks.push({ ...event, vt });
  }
  return clicks;
}

/**
 * Per-word OCR boxes at source time `t`. Tests inject `boxes` on the op so they never
 * touch `~/Downloads/.video-index`. Production calls tools/find.py:ocr_boxes().
 */
export function loadOcrBoxes(media, t, { cacheDir } = {}) {
  const python = pythonForTool('find.py');
  const tools = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools');
  const script = [
    'import json,sys',
    'sys.path.insert(0, sys.argv[1])',
    'import find',
    'media, t, cache = sys.argv[2], float(sys.argv[3]), sys.argv[4] or None',
    'print(json.dumps(find.ocr_boxes(media, t, cache_dir=cache)))',
  ].join('; ');
  const result = spawnSync(python.executable, ['-c', script, tools, media, String(t), cacheDir || ''], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'ocr_boxes failed').trim();
    throw new CapcutError(
      `punch could not read OCR boxes for this media. ${detail} Run \`capcutctl find --media FILE --shows --refresh\`.`,
      { code: 'PUNCH_NO_OCR', exitCode: 2 },
    );
  }
  try {
    const parsed = JSON.parse(String(result.stdout || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new CapcutError('punch got invalid OCR box JSON from find.ocr_boxes.', {
      code: 'PUNCH_NO_OCR', exitCode: 2,
    });
  }
}

function locateClip(doc, op) {
  const id = op.segment || op.selector?.id;
  if (id) return resolveClip(doc, { id: String(id), track: op.track });
  if (op.at == null) {
    throw new CapcutError('punch requires --segment ID or --at T.', {
      code: 'SELECTOR_EMPTY', exitCode: 2,
    });
  }
  return resolveClip(doc, { at: Number(op.at), track: op.track });
}

function resolveEventSource(op, segment, clicks) {
  if (op.at != null && Number.isFinite(Number(op.at))) {
    return sourceOfTimeline(segment, Number(op.at));
  }
  if (op.word) {
    const found = wordTime(op.words, op.word);
    if (found != null) return found;
    throw new CapcutError(`punch --word ${JSON.stringify(op.word)} was not in the transcript.`, {
      code: 'PUNCH_NO_TIME', exitCode: 2,
    });
  }
  const st = segment.source_timerange || { start: 0, duration: 0 };
  const inRange = (clicks || []).filter(click => {
    const vt = Number(click.vt);
    return vt >= S(st.start) && vt <= S(st.start + st.duration);
  });
  if (inRange.length === 1) return Number(inRange[0].vt);
  throw new CapcutError('punch needs --at T or --word TEXT to time the move.', {
    code: 'PUNCH_NO_TIME', exitCode: 2,
  });
}

/**
 * Name an on-screen element; compute the focus rectangle; write via keyframe --focus.
 * The model never outputs a coordinate.
 */
export function opPunch(doc, op = {}, context = {}) {
  const on = String(op.on || '').trim();
  if (!on) {
    throw new CapcutError('punch requires --on TEXT naming the on-screen element.', {
      code: 'PUNCH_NO_ELEMENT', exitCode: 2,
    });
  }
  const kind = String(op.kind || 'click').toLowerCase();
  if (kind !== 'click' && kind !== 'result') {
    throw new CapcutError('punch --kind is click or result.', { code: 'BAD_KIND', exitCode: 2 });
  }
  const zoom = op.zoom != null ? Number(op.zoom) : DEFAULT_ZOOM;
  const ramp = op.ramp != null ? Number(op.ramp) : DEFAULT_RAMP;
  if (!(zoom > 0) || !(ramp > 0)) {
    throw new CapcutError('punch --zoom and --ramp must be positive.', { code: 'BAD_SCALE', exitCode: 2 });
  }

  const clip = locateClip(doc, op);
  const segment = clip.segment;
  const material = materialFor(doc, segment.material_id);
  const canvas = doc.canvas_config || { width: 1080, height: 1920 };
  const sourceW = Number(material?.width);
  const sourceH = Number(material?.height);
  if (!(sourceW > 0 && sourceH > 0)) {
    throw new CapcutError('punch needs known source dimensions on the clip material.', {
      code: 'BAD_FOCUS', exitCode: 2,
    });
  }

  const mediaPath = resolveMediaPath(material?.path, context.projectDir) || material?.path || '';
  const clicks = op.clicks !== undefined ? op.clicks : loadClicks(mediaPath, context.projectDir);
  const moments = op.moments !== undefined ? op.moments : (momentsFromSidecar(mediaPath, context.projectDir) || []);
  const eventSource = resolveEventSource(op, segment, clicks);
  const timing = planPunchTiming({
    kind, eventSource, moments, hold: op.hold, ramp, speed: speedOf(segment),
  });

  const st = segment.source_timerange || { start: 0, duration: segment.target_timerange.duration };
  const tt = segment.target_timerange;
  const srcIn = S(st.start), srcOut = S(st.start + st.duration);
  if (timing.arrive < srcIn || timing.arrive >= srcOut) {
    throw new CapcutError('punch arrive time falls outside this clip\'s source window.', {
      code: 'KEYFRAME_CLAMPED', exitCode: 2,
    });
  }

  const ocrAt = Math.max(srcIn, Math.min(eventSource, srcOut - 1e-6));
  const boxes = op.boxes !== undefined ? op.boxes : loadOcrBoxes(mediaPath, ocrAt, { cacheDir: op.cacheDir });
  const hits = matchOcrBoxes(boxes, on);
  const click = clickNear(clicks, eventSource);
  const box = pickBox(hits, click, { width: sourceW, height: sourceH });
  const focus = focusRectForZoom({
    box,
    sourceW,
    sourceH,
    canvasW: Number(canvas.width) || 1080,
    canvasH: Number(canvas.height) || 1920,
    zoom,
  });

  const at = timelineOfSource(segment, timing.arrive);
  const hold = timing.hold;
  const speed = speedOf(segment);
  const startUs = st.start + US((at - S(tt.start)) * speed);
  const endUs = startUs + US((2 * ramp + hold) * speed);
  assertNoDoublePunch(segment, startUs, endUs);

  const keyOp = {
    op: 'keyframe.scale',
    selector: { id: segment.id },
    at,
    hold,
    ramp,
    focus,
    track: clip.trackIndex,
    ...(op.ease != null ? { ease: op.ease } : {}),
    ...(op.easePosition != null ? { easePosition: op.easePosition } : {}),
    ...(op.__seed ? { __seed: op.__seed } : {}),
  };

  const probe = JSON.parse(JSON.stringify({
    canvas_config: doc.canvas_config,
    materials: doc.materials,
    tracks: [{ type: 'video', flag: 2, segments: [JSON.parse(JSON.stringify(segment))] }],
  }));
  const planned = opScaleKeyframe(probe, { ...keyOp, selector: { id: segment.id } });
  const measured = peakUpscale(
    probe.tracks[0].segments[0],
    { width: sourceW, height: sourceH },
    canvas,
    { material },
  );
  if (!measured.exempt && measured.factor != null && measured.factor > UPSCALE_REFUSE) {
    throw new CapcutError(
      `punch would draw source pixels at ${measured.factor}× (limit ${UPSCALE_REFUSE}×). Use a larger on-screen region or a native-resolution take.`,
      { code: 'UPSCALE_REFUSE', exitCode: 2, details: measured },
    );
  }

  const written = opScaleKeyframe(doc, keyOp);
  return {
    ...written,
    on,
    kind,
    zoom,
    box,
    focus: focus.map(r3),
    at: r3(at),
    hold: r3(hold),
    arrive: r3(timing.arrive),
    eventSource: r3(eventSource),
    upscale: measured.factor,
    shifted: timing.shifted || undefined,
    shiftedFrom: timing.shiftedFrom != null ? r3(timing.shiftedFrom) : undefined,
    to: planned.to,
  };
}
