/**
 * Sentence → moment matcher (F01).
 *
 * Every spoken sentence is scored against every screen-recording change moment, then
 * assigned globally by monotone dynamic programming. Weak or ambiguous matches stay on
 * the face (`flag` / `none`) — they are never placed wrong. "No B-roll" is a valid answer.
 *
 * Writes only through existing ops: `layout.screen` (and `clip.add`), `pace`, `punch`,
 * `ramp`. No new CapCut fields.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapcutError, applyOperations, resolveMediaPath } from './core.mjs';
import { matchOcrBoxes, loadClicks, shiftOffMotion, CLICK_LEAD } from './punch.mjs';
import { findResultMoment } from './ramp.mjs';
import { lintBroll, momentsFromSidecar, isBrollSegment } from './broll-lint.mjs';
import { peakUpscale, UPSCALE_REFUSE } from './crispness.mjs';
import { sourceToTimeline } from './signature.mjs';
import { loadTranscript } from './stress.mjs';
import { pythonForTool } from './python.mjs';

const r3 = n => Math.round(n * 1000) / 1000;
const r4 = n => Math.round(n * 10000) / 10000;

export const DEFAULT_MIN_MARGIN = 0.15;
/** Skip (stay on face) beats a pairwise score at or below this. */
export const SKIP_SCORE = 0.22;
export const MIN_HOLD = 0.8;
export const ACTION_LEAD = CLICK_LEAD;

/** Ops `--apply` may emit. applyOperations already accepts each of these. */
export const MATCH_WRITER_OPS = Object.freeze([
  'clip.add', 'layout.screen', 'layout.apply', 'pace', 'punch', 'ramp',
]);

/** Same verb set find.py uses for action-vs-description queries. */
export const ACTION_VERBS = new Set([
  'click', 'tap', 'hit', 'press', 'open', 'run', 'type', 'select', 'submit',
  'drag', 'scroll', 'hover', 'focus', 'publish',
]);

const RESULT_RE = /\b(result|appears?|shows?|showed|answer|done|output|lands?|settled|finished)\b/i;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'and', 'in', 'on', 'it', 'is', 'i', 'you', 'we', 'that',
  'this', 'my', 'me', 'for', 'with', 'at', 'as', 'be', 'was', 'are', 'or', 'but', 'so',
  'then', 'just', 'like', 'really', 'um', 'uh', 'there', 'here', 'now', 'can', 'will',
  'would', 'from', 'by', 'about', 'into', 'over', 'up', 'out', 'if', 'do', 'did', 'have',
  'has', 'had', 'not', 'no', 'yes', 'ok', 'okay', 'gonna', 'going', 'let', 'lets', 'i\'m',
  'he', 'she', 'they', 'them', 'his', 'her', 'our', 'your', 'what', 'when', 'where', 'who',
  'how', 'why', 'look', 'see', 'watch', 'right', 'left', 'one', 'two',
]);

const REGION_WEIGHT = Object.freeze({
  canvas: 1.0,
  toolbar: 0.9,
  chat: 0.18,
  unknown: 0.45,
});

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1 && !STOPWORDS.has(token));
}

export function sentenceKind(text) {
  const tokens = tokenize(text);
  if (tokens.some(token => ACTION_VERBS.has(token))) return 'action';
  if (RESULT_RE.test(String(text || ''))) return 'result';
  return 'show';
}

/**
 * Group Whisper words into sentences on terminal punctuation or a ≥0.8s pause.
 * `start`/`end` are source seconds (the transcript clock).
 */
export function sentencesFromWords(words) {
  const items = (words || []).map(word => ({
    text: String(word.word || word.text || '').trim(),
    start: Number(word.start),
    end: Number(word.end),
  })).filter(word => word.text && Number.isFinite(word.start) && Number.isFinite(word.end));
  const sentences = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    sentences.push({
      id: `s${sentences.length}`,
      text: current.map(word => word.text).join(' ').replace(/\s+/g, ' '),
      words: current,
      start: current[0].start,
      end: current.at(-1).end,
    });
    current = [];
  };
  for (let i = 0; i < items.length; i++) {
    current.push(items[i]);
    const next = items[i + 1];
    const punct = /[.!?؟…]+$/.test(items[i].text);
    const gap = next ? next.start - items[i].end : Infinity;
    if (punct || gap > 0.8 || !next) flush();
  }
  return sentences;
}

export function wordsFromTranscript(transcript) {
  if (Array.isArray(transcript)) return transcript;
  const words = [];
  for (const segment of transcript?.segments || []) {
    for (const word of segment.words || []) words.push(word);
    if (!(segment.words || []).length && segment.text) {
      words.push({ word: segment.text, start: Number(segment.start), end: Number(segment.end) });
    }
  }
  return words;
}

/**
 * Map a source-timed sentence onto the recut timeline. Words the cut dropped map to
 * null and the sentence stays on the face (`dropped: true`).
 */
export function timelineSentence(sentence, mapper) {
  if (typeof mapper !== 'function') {
    return {
      ...sentence,
      dropped: false,
      timelineStart: r3(sentence.start),
      timelineEnd: r3(sentence.end),
    };
  }
  const words = (sentence.words || []).map(word => {
    const timelineStart = mapper(word.start);
    const timelineEnd = mapper(word.end);
    return { ...word, timelineStart, timelineEnd };
  });
  const kept = words.filter(word => word.timelineStart != null && word.timelineEnd != null
    && Number.isFinite(word.timelineStart) && Number.isFinite(word.timelineEnd));
  if (!kept.length) {
    return {
      ...sentence, words, dropped: true, timelineStart: null, timelineEnd: null,
    };
  }
  return {
    ...sentence,
    words,
    dropped: false,
    timelineStart: r3(kept[0].timelineStart),
    timelineEnd: r3(Math.max(...kept.map(word => word.timelineEnd))),
  };
}

function regionWeight(box) {
  return REGION_WEIGHT[box?.region] ?? REGION_WEIGHT.unknown;
}

function boxHitsToken(box, token) {
  const text = String(box?.text || '').toLowerCase();
  if (!text || !token) return false;
  return text.includes(token) || token.includes(text.replace(/\s+/g, ''));
}

/**
 * Text match: sentence tokens vs OCR, with canvas/toolbar weighted above chat so a
 * panel that *describes* "gold wave" loses to the canvas that *shows* it.
 */
export function textScore(sentence, boxes) {
  const tokens = tokenize(sentence?.text || sentence);
  if (!tokens.length) return { score: 0, hits: [], chatOnly: false };
  const list = boxes || [];
  const hits = [];
  let chatOnly = true;
  let sum = 0;
  for (const token of tokens) {
    let best = 0;
    let region = null;
    for (const box of list) {
      if (!boxHitsToken(box, token)) continue;
      const weight = regionWeight(box);
      if (weight > best) {
        best = weight;
        region = box.region || 'unknown';
      }
    }
    hits.push({ token, weight: r4(best), region });
    sum += best;
    if (best > 0 && region !== 'chat') chatOnly = false;
  }
  const any = hits.some(hit => hit.weight > 0);
  return { score: r4(sum / tokens.length), hits, chatOnly: any && chatOnly };
}

function clickNear(clicks, t, window = 0.5) {
  return (clicks || []).filter(click => Math.abs(Number(click.vt) - t) <= window);
}

export function momentKind(moment, moments, clicks = []) {
  if (clickNear(clicks, moment.start).length) return 'click';
  const lo = Math.max(0, Number(moment.start) - 8);
  const hi = Number(moment.end) + 1;
  const result = findResultMoment(moments, lo, hi);
  if (result && Math.abs(result.start - moment.start) < 0.05) return 'result';
  return 'change';
}

/**
 * Action sentences prefer click moments; result nouns prefer a settled change after a
 * quiet stretch (`findResultMoment`). A type mismatch is a small penalty, not a veto.
 */
export function typeScore(sentence, moment, { moments = [], clicks = [] } = {}) {
  const kind = sentenceKind(sentence?.text || sentence);
  const mKind = moment.kind || momentKind(moment, moments, clicks);
  if (kind === 'action' && mKind === 'click') return { score: 1, kind, momentKind: mKind };
  if (kind === 'result' && mKind === 'result') return { score: 1, kind, momentKind: mKind };
  if (kind === 'show' && (mKind === 'change' || mKind === 'result')) {
    return { score: 0.7, kind, momentKind: mKind };
  }
  if (kind === 'action' && mKind !== 'click') return { score: 0.25, kind, momentKind: mKind };
  if (kind === 'result' && mKind === 'click') return { score: 0.2, kind, momentKind: mKind };
  return { score: 0.45, kind, momentKind: mKind };
}

export function scorePair(sentence, moment, { moments = [], clicks = [] } = {}) {
  const text = textScore(sentence, moment.boxes || []);
  const type = typeScore(sentence, moment, { moments, clicks });
  // Chat-only hits are "describes", not "shows": keep them below SKIP_SCORE unless type is perfect.
  const textValue = text.chatOnly ? Math.min(text.score, 0.16) : text.score;
  // Chat that only *describes* the thing stays below SKIP_SCORE so DP prefers no B-roll
  // (or a later canvas moment that actually shows it).
  const mixed = r4(0.72 * textValue + 0.28 * type.score);
  const total = text.chatOnly ? r4(Math.min(mixed, SKIP_SCORE - 0.04)) : mixed;
  return { text: text.score, textEffective: textValue, chatOnly: text.chatOnly, type: type.score, typeKind: type.kind, momentKind: type.momentKind, total, hits: text.hits };
}

/**
 * Monotone alignment of sentences × moments with skips. Jumping backwards and reusing a
 * moment are structurally impossible (we only advance). Skipping a sentence (no B-roll)
 * costs `skipScore` so a weak pair loses to "stay on the face".
 */
export function alignMonotone(sentences, moments, pairScores, { skipScore = SKIP_SCORE } = {}) {
  const n = sentences.length;
  const m = moments.length;
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  const bt = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
  for (let i = 1; i <= n; i++) {
    dp[i][0] = dp[i - 1][0] + skipScore;
    bt[i][0] = 'skipS';
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = dp[0][j - 1];
    bt[0][j] = 'skipM';
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const skipS = dp[i - 1][j] + skipScore;
      const skipM = dp[i][j - 1];
      const match = dp[i - 1][j - 1] + Number(pairScores[i - 1][j - 1]?.total || 0);
      if (match >= skipS && match >= skipM) {
        dp[i][j] = match;
        bt[i][j] = 'match';
      } else if (skipS >= skipM) {
        dp[i][j] = skipS;
        bt[i][j] = 'skipS';
      } else {
        dp[i][j] = skipM;
        bt[i][j] = 'skipM';
      }
    }
  }
  const assignment = Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const step = bt[i][j];
    if (step === 'match') {
      assignment[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (step === 'skipS') {
      assignment[i - 1] = null;
      i -= 1;
    } else if (step === 'skipM') {
      j -= 1;
    } else if (i > 0) {
      assignment[i - 1] = null;
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return { assignment, score: dp[n][m] };
}

function runnerUp(pairRow, chosenIndex) {
  let best = 0;
  let index = null;
  for (let j = 0; j < pairRow.length; j++) {
    if (j === chosenIndex) continue;
    const total = Number(pairRow[j]?.total || 0);
    if (total > best) {
      best = total;
      index = j;
    }
  }
  return { score: best, index };
}

function namedElement(sentence, moment) {
  const hits = matchOcrBoxes(moment.boxes || [], sentence.text);
  const shown = (hits.length ? hits : (moment.boxes || []))
    .filter(box => box.region === 'canvas' || box.region === 'toolbar')
    .sort((a, b) => regionWeight(b) - regionWeight(a));
  const tokens = tokenize(sentence.text).filter(token => !ACTION_VERBS.has(token));
  for (const box of shown) {
    const text = String(box.text || '').trim();
    if (tokens.some(token => boxHitsToken(box, token))) return text;
  }
  return shown[0]?.text || null;
}

function planSourceWindow(sentence, moment, { kind } = {}) {
  const lead = kind === 'action' ? ACTION_LEAD : 0.05;
  let srcIn = Math.max(0, Number(moment.start) - lead);
  const shifted = shiftOffMotion([moment], srcIn);
  // Do not slide *into* the burst: opening just before the change is the goal.
  // shiftOffMotion only fires when srcIn sits inside the run (e.g. a moment that
  // starts at 0, so lead cannot back up).
  if (shifted.shiftedFrom != null && srcIn >= Number(moment.start)) srcIn = shifted.t;
  const hold = Math.max(MIN_HOLD, (sentence.timelineEnd ?? sentence.end) - (sentence.timelineStart ?? sentence.start));
  const srcOut = srcIn + hold;
  return { srcIn: r3(srcIn), srcOut: r3(srcOut), onScreen: r3(hold) };
}

function syntheticSegment({ srcIn, srcOut, onScreen, timelineStart, scale = 1, zoomKeys = null }) {
  const US = s => Math.round(s * 1e6);
  return {
    id: 'match-probe',
    desc: 'layout:screen-recording',
    source_timerange: { start: US(srcIn), duration: US(Math.max(0.01, srcOut - srcIn)) },
    target_timerange: { start: US(timelineStart || 0), duration: US(onScreen) },
    clip: { scale: { x: scale, y: scale }, transform: { x: 0, y: 0 }, alpha: 1 },
    ...(zoomKeys ? { common_keyframes: zoomKeys } : {}),
  };
}

/**
 * Build the concrete writer ops that realise a placed shot. `layout.screen` is the
 * primary verb for a screen recording; pace / punch / ramp ride on top when the
 * evidence supports them.
 */
export function planShotOps(shot, {
  screen, width, height, mediaDuration, track = 'screen',
} = {}) {
  if (shot.decision !== 'place' || !shot.moment || !screen) return [];
  const at = shot.timeline.start;
  const duration = shot.onScreen;
  const src = shot.source.in;
  const srcDur = shot.source.out - shot.source.in;
  const ops = [{
    op: 'layout.screen',
    contract: 'layout.screen.v1',
    media: screen,
    at,
    duration,
    src,
    srcDur,
    track,
    preset: 'screenRecording',
    frame: 'screen-frame',
    localize: true,
    volume: 0,
    desc: `match:${shot.id}`,
    ...(width != null ? { width: Number(width) } : {}),
    ...(height != null ? { height: Number(height) } : {}),
    ...(mediaDuration != null ? { mediaDuration: Number(mediaDuration) } : {}),
  }];
  if (srcDur > duration * 1.5 + 0.05) {
    ops.push({
      op: 'pace',
      set: [{ at, cover: [src, shot.source.out] }],
    });
  }
  if (shot.punchOn) {
    ops.push({
      op: 'punch',
      on: shot.punchOn,
      at,
      kind: shot.score?.typeKind === 'result' ? 'result' : 'click',
    });
  }
  if (Number.isFinite(shot.resultAt) && shot.resultAt > src + 1) {
    ops.push({
      op: 'ramp',
      at,
      speed: 20,
      resultAt: shot.resultAt,
    });
  }
  return ops;
}

function demoteReasons(shot, { moments, words, canvas, sourceDims } = {}) {
  const reasons = [];
  if (shot.decision !== 'place') return reasons;
  const lint = lintBroll([{
    id: shot.id,
    srcIn: shot.source.in,
    timelineOut: shot.timeline.end,
    onScreen: shot.onScreen,
  }], { moments: moments || [], words: words || [] });
  for (const finding of lint.findings) reasons.push(finding.code);
  if (sourceDims && canvas) {
    const measured = peakUpscale(
      syntheticSegment({
        srcIn: shot.source.in,
        srcOut: shot.source.out,
        onScreen: shot.onScreen,
        timelineStart: shot.timeline.start,
      }),
      sourceDims,
      canvas,
    );
    if (!measured.exempt && measured.factor != null && measured.factor > UPSCALE_REFUSE) {
      reasons.push('UPSCALE_REFUSE');
    }
  }
  return reasons;
}

/**
 * Align sentences to moments and emit a shot list. Tests inject `transcript`,
 * `moments`, `boxes`, `clicks`, and `mapper` so they never touch a real index.
 */
export function matchShots({
  transcript, words, moments = [], boxes, clicks = [],
  mapper, doc, minMargin = DEFAULT_MIN_MARGIN,
  screen, width, height, mediaDuration, canvas, sourceDims, track = 'screen',
} = {}) {
  const sourceWords = words || wordsFromTranscript(transcript);
  const mapped = sentencesFromWords(sourceWords)
    .map(sentence => timelineSentence(sentence, mapper || (doc ? sourceToTimeline(doc) : null)));
  const enrichedMoments = (moments || []).map((moment, index) => {
    const list = moment.boxes
      || (boxes && (boxes[moment.start] || boxes[String(moment.start)] || boxes[index]))
      || [];
    return {
      start: Number(moment.start),
      end: Number(moment.end ?? moment.start),
      peak: Number(moment.peak ?? moment.score ?? 0),
      boxes: list,
      kind: moment.kind,
      mask: moment.mask,
    };
  }).sort((a, b) => a.start - b.start);

  const live = mapped.filter(sentence => !sentence.dropped);
  const pairScores = live.map(sentence => enrichedMoments.map(moment => (
    scorePair(sentence, moment, { moments: enrichedMoments, clicks })
  )));
  const aligned = alignMonotone(live, enrichedMoments, pairScores, { skipScore: SKIP_SCORE });

  const shots = mapped.map(sentence => {
    if (sentence.dropped) {
      return {
        id: sentence.id,
        sentence: sentence.text,
        timeline: { start: null, end: null },
        source: null,
        moment: null,
        score: { text: 0, type: 0, total: 0, runnerUp: 0, margin: 0 },
        decision: 'none',
        reasons: ['dropped-words'],
        ops: [],
      };
    }
    const liveIndex = live.indexOf(sentence);
    const chosen = aligned.assignment[liveIndex];
    const row = pairScores[liveIndex] || [];
    const scored = chosen == null ? null : row[chosen];
    const runner = chosen == null ? { score: 0, index: null } : runnerUp(row, chosen);
    const margin = scored ? r4(scored.total - runner.score) : 0;
    const timeline = { start: sentence.timelineStart, end: sentence.timelineEnd };
    if (chosen == null || !scored || scored.total < SKIP_SCORE) {
      return {
        id: sentence.id,
        sentence: sentence.text,
        timeline,
        source: null,
        moment: null,
        score: { text: 0, type: 0, total: 0, runnerUp: r4(runner.score), margin: 0 },
        decision: 'none',
        reasons: ['no-broll'],
        ops: [],
      };
    }
    const moment = enrichedMoments[chosen];
    const window = planSourceWindow(sentence, moment, { kind: scored.typeKind });
    const result = findResultMoment(enrichedMoments, window.srcIn, window.srcOut);
    const shot = {
      id: sentence.id,
      sentence: sentence.text,
      timeline,
      source: { in: window.srcIn, out: window.srcOut },
      moment: { start: r3(moment.start), end: r3(moment.end), peak: r3(moment.peak), index: chosen },
      onScreen: window.onScreen,
      punchOn: namedElement(sentence, moment),
      resultAt: result ? r3(result.start) : null,
      score: {
        text: scored.text,
        type: scored.type,
        total: scored.total,
        runnerUp: r4(runner.score),
        margin,
        chatOnly: scored.chatOnly,
        typeKind: scored.typeKind,
        momentKind: scored.momentKind,
      },
      decision: 'place',
      reasons: [],
      ops: [],
    };
    if (margin < minMargin) {
      shot.decision = 'flag';
      shot.reasons = ['low-margin'];
      shot.ops = [];
      return shot;
    }
    const lint = demoteReasons(shot, { moments: enrichedMoments, words: live.flatMap(item => {
      if (item.timelineStart == null) return [];
      return [{ start: item.timelineStart, end: item.timelineEnd, word: item.text }];
    }), canvas, sourceDims });
    if (lint.length) {
      shot.decision = 'flag';
      shot.reasons = lint;
      shot.ops = [];
      return shot;
    }
    shot.ops = planShotOps(shot, { screen, width, height, mediaDuration, track });
    return shot;
  });

  const counts = { place: 0, flag: 0, none: 0 };
  for (const shot of shots) counts[shot.decision] += 1;
  return {
    minMargin: Number(minMargin),
    sentences: shots.length,
    moments: enrichedMoments.length,
    placed: counts.place,
    flagged: counts.flag,
    none: counts.none,
    shots,
    loop: 'match → review flags → match --apply (or hand-edit shots.json then match --apply --shots shots.json)',
  };
}

export function shotsToSpec(result, extras = {}) {
  const operations = [];
  for (const shot of result.shots || []) {
    if (shot.decision !== 'place') continue;
    const ops = shot.ops?.length
      ? shot.ops
      : planShotOps(shot, extras);
    for (const op of ops) operations.push(op);
  }
  return { version: 1, name: 'match', operations };
}

/** True when every op is one applyOperations already dispatches. */
export function writersAccept(operations) {
  const accepted = [];
  const rejected = [];
  for (const op of operations || []) {
    if (!MATCH_WRITER_OPS.includes(op.op)) {
      rejected.push({ op: op.op, code: 'UNSUPPORTED_OPERATION' });
      continue;
    }
    try {
      applyOperations({ materials: { videos: [] }, tracks: [], canvas_config: { width: 1080, height: 1920 } }, [op], {
        dryRun: true, projectDir: null, group: 'root',
      });
      accepted.push(op.op);
    } catch (error) {
      if (error instanceof CapcutError && error.code === 'UNSUPPORTED_OPERATION') {
        rejected.push({ op: op.op, code: error.code });
      } else {
        accepted.push(op.op);
      }
    }
  }
  return { ok: rejected.length === 0, accepted, rejected };
}

export function loadBoxesAtTimes(media, times, { cacheDir } = {}) {
  if (!media || !times?.length) return {};
  const python = pythonForTool('find.py');
  const tools = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools');
  const script = [
    'import json,sys',
    'sys.path.insert(0, sys.argv[1])',
    'import find',
    'media, times, cache = sys.argv[2], json.loads(sys.argv[3]), sys.argv[4] or None',
    'print(json.dumps({str(t): find.ocr_boxes(media, float(t), cache_dir=cache) for t in times}))',
  ].join('; ');
  const result = spawnSync(python.executable, [
    '-c', script, tools, media, JSON.stringify(times), cacheDir || '',
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'ocr_boxes failed').trim();
    throw new CapcutError(
      `match could not read OCR boxes. ${detail} Run \`capcutctl find --media FILE --shows --refresh\`.`,
      { code: 'MATCH_NO_OCR', exitCode: 2 },
    );
  }
  try {
    const parsed = JSON.parse(String(result.stdout || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new CapcutError('match got invalid OCR box JSON from find.ocr_boxes.', {
      code: 'MATCH_NO_OCR', exitCode: 2,
    });
  }
}

function principalMediaPath(doc, projectDir) {
  try {
    const videos = new Map((doc.materials?.videos || []).map(material => [material.id, material]));
    for (const track of doc.tracks || []) {
      if (track.type !== 'video' || track.flag === 0) continue;
      for (const segment of track.segments || []) {
        const material = videos.get(segment.material_id);
        if (!material?.path) continue;
        if (material.type && material.type !== 'video') continue;
        if (isBrollSegment(segment, material)) continue;
        return resolveMediaPath(material.path, projectDir) || material.path;
      }
    }
  } catch { /* no principal */ }
  return null;
}

/**
 * Production loader. Tests pass the indexes on the options object and never reach here
 * for `~/Downloads/.video-index`.
 */
export function loadMatchInputs({
  screen, face, doc, projectDir, transcript, moments, boxes, clicks, words, cacheDir,
} = {}) {
  if (transcript || words) {
    return {
      transcript: transcript || { segments: [{ words }] },
      words,
      moments: moments || [],
      boxes,
      clicks: clicks || [],
    };
  }
  const facePath = face || (doc ? principalMediaPath(doc, projectDir) : null);
  const loadedTranscript = loadTranscript(facePath, { cacheDir, transcript, words });
  if (!loadedTranscript) {
    throw new CapcutError(
      'match needs a Whisper transcript for the talking head. Pass --face FILE or inject words.',
      { code: 'MATCH_NO_TRANSCRIPT', exitCode: 2 },
    );
  }
  const loadedMoments = moments !== undefined
    ? moments
    : (screen ? (momentsFromSidecar(screen, projectDir) || []) : []);
  const loadedClicks = clicks !== undefined
    ? clicks
    : (screen ? loadClicks(screen, projectDir) : []);
  let loadedBoxes = boxes;
  if (loadedBoxes === undefined && screen && loadedMoments.length) {
    loadedBoxes = loadBoxesAtTimes(screen, loadedMoments.map(moment => moment.start), { cacheDir });
  }
  return {
    transcript: loadedTranscript,
    moments: loadedMoments,
    boxes: loadedBoxes,
    clicks: loadedClicks,
  };
}

export function readShotsFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(data)) return { shots: data, loop: null };
  if (data && Array.isArray(data.shots)) return data;
  throw new CapcutError('--shots must be a shot list JSON from `capcutctl match`.', {
    code: 'BAD_SHOTS', exitCode: 2,
  });
}
