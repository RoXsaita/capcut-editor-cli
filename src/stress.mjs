/**
 * Punch-in on stressed words — `zoom --stress`.
 *
 * A full-face talking-head scene gets at most one 1.08× push every 8 s, landing on
 * the word whose energy10 peak is ≥ +6 dB above its sentence median. Writes through
 * the existing keyframe path (`opScaleKeyframe`) and honours `DOUBLE_PUNCH`.
 *
 * Indexes are injected on the op in tests (`op.transcript` / `op.words` + `op.energy`).
 * Production loads Whisper + energy10 from the same cache `cut` writes; it never
 * binds to a hardcoded drafts path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CapcutError, resolveMediaPath } from './core.mjs';
import { opScaleKeyframe } from './add.mjs';
import { assertNoDoublePunch } from './punch.mjs';
import { principalTrack } from './polish.mjs';
import { isBrollSegment } from './broll-lint.mjs';
import { sourceToTimeline, talkingHeadScenes } from './signature.mjs';

const US = s => Math.round(s * 1e6);
const S = us => (us || 0) / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;

export const STRESS_SCALE = 1.08;
export const STRESS_MARGIN_DB = 6;
export const STRESS_SPACING_S = 8;
export const STRESS_RAMP = 0.23;
export const STRESS_HOLD = 1.6;
export const DEFAULT_ENERGY_BIN = 0.01;

function materialFor(doc, id) {
  for (const values of Object.values(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    const found = values.find(item => item && item.id === id);
    if (found) return found;
  }
  return null;
}

function masksOn(doc, segment) {
  const masks = doc.materials?.common_mask || [];
  if (segment.enable_video_mask === false) return [];
  const refs = new Set(segment.extra_material_refs || []);
  return masks.filter(mask => refs.has(mask.id));
}

/** Circle / rotated / inverted masks — the same gate `keyframe --focus` uses. */
export function isUnsupportedMotionMask(mask) {
  if (!mask) return false;
  return mask.resource_type !== 'line'
    || mask.config?.invert
    || ![0, 180].includes(Number(mask.config?.rotation || 0));
}

function isMaskedInset(doc, segment) {
  const masks = masksOn(doc, segment);
  return masks.length > 0 && !masks.some(isUnsupportedMotionMask);
}

function isCircleLayout(doc, segment) {
  return masksOn(doc, segment).some(isUnsupportedMotionMask);
}

export function energyAt(energy, t) {
  const bin = Number(energy?.bin) || DEFAULT_ENERGY_BIN;
  const db = Array.isArray(energy?.db) ? energy.db : [];
  if (!(bin > 0) || !db.length) return -99;
  const i = Math.floor(Number(t) / bin);
  return i >= 0 && i < db.length && Number.isFinite(db[i]) ? db[i] : -99;
}

function binsInRange(energy, start, end) {
  const bin = Number(energy?.bin) || DEFAULT_ENERGY_BIN;
  const db = Array.isArray(energy?.db) ? energy.db : [];
  if (!(bin > 0) || !db.length) return [];
  const lo = Math.max(0, Math.floor(Number(start) / bin));
  const hi = Math.min(db.length, Math.max(lo + 1, Math.ceil(Number(end) / bin)));
  return db.slice(lo, hi).filter(Number.isFinite);
}

export function wordPeakDb(energy, word) {
  const start = Number(word?.start);
  const end = Number(word?.end);
  if (!Number.isFinite(start)) return -99;
  const until = Number.isFinite(end) && end > start ? end : start + DEFAULT_ENERGY_BIN;
  const bins = binsInRange(energy, start, until);
  return bins.length ? Math.max(...bins) : energyAt(energy, start);
}

export function median(values) {
  const list = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Median energy10 of the sentence's time span (not the median of its word peaks). */
export function sentenceMedianDb(energy, sentence) {
  const start = Number(sentence?.start);
  const end = Number(sentence?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return median(binsInRange(energy, start, end));
}

export function isStressed(peakDb, sentenceMedian, marginDb = STRESS_MARGIN_DB) {
  if (!Number.isFinite(peakDb) || !Number.isFinite(sentenceMedian)) return false;
  return peakDb - sentenceMedian >= marginDb;
}

function wordText(word) {
  return String(word?.word || word?.text || '').trim();
}

/**
 * Whisper `segments[].words` or a flat `words` list. A flat list is one sentence
 * unless entries carry `sentence` / `segment` ids.
 */
export function sentencesFromTranscript(transcript, words = null) {
  if (Array.isArray(transcript?.segments)) {
    return transcript.segments.map((segment, i) => {
      const list = (segment.words || []).map(word => ({
        word: wordText(word),
        start: Number(word.start),
        end: Number(word.end ?? word.start),
      })).filter(word => Number.isFinite(word.start));
      const start = Number.isFinite(Number(segment.start))
        ? Number(segment.start)
        : (list[0]?.start ?? 0);
      const end = Number.isFinite(Number(segment.end))
        ? Number(segment.end)
        : (list.at(-1)?.end ?? start);
      return { id: i, start, end, words: list };
    }).filter(sentence => sentence.words.length);
  }
  const flat = Array.isArray(words) ? words : (Array.isArray(transcript) ? transcript : []);
  const groups = new Map();
  for (const [i, raw] of flat.entries()) {
    const start = Number(raw.start);
    if (!Number.isFinite(start)) continue;
    const key = raw.sentence ?? raw.segment ?? 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      word: wordText(raw) || `w${i}`,
      start,
      end: Number.isFinite(Number(raw.end)) ? Number(raw.end) : start,
    });
  }
  return [...groups.entries()].map(([id, list]) => {
    list.sort((a, b) => a.start - b.start);
    return { id, start: list[0].start, end: list.at(-1).end, words: list };
  });
}

/**
 * Stressed words, hardest first, then 8 s spacing on the timeline.
 * `mapper(sourceSeconds) → timelineSeconds | null` (null = cut out of the take).
 */
export function planStressPunches({
  transcript = null,
  words = null,
  energy,
  mapper = t => t,
  scenes = null,
  marginDb = STRESS_MARGIN_DB,
  spacing = STRESS_SPACING_S,
} = {}) {
  if (!energy || !Array.isArray(energy.db) || !energy.db.length) {
    throw new CapcutError('zoom --stress needs an energy10 series (inject op.energy in tests, or run cut first).', {
      code: 'STRESS_NO_ENERGY', exitCode: 2,
    });
  }
  const sentences = sentencesFromTranscript(transcript, words);
  if (!sentences.length) {
    throw new CapcutError('zoom --stress needs Whisper words (inject op.transcript / op.words, or pass --words).', {
      code: 'STRESS_NO_WORDS', exitCode: 2,
    });
  }

  const stressed = [];
  for (const sentence of sentences) {
    const sentenceMedian = sentenceMedianDb(energy, sentence);
    if (!Number.isFinite(sentenceMedian)) continue;
    for (const word of sentence.words) {
      const peakDb = wordPeakDb(energy, word);
      const margin = peakDb - sentenceMedian;
      const at = mapper(word.start);
      if (at == null || !Number.isFinite(at)) continue;
      if (scenes?.length && !scenes.some(scene => at >= scene.start && at < scene.end)) continue;
      if (!isStressed(peakDb, sentenceMedian, marginDb)) continue;
      stressed.push({
        word: word.word,
        sourceAt: r3(word.start),
        sourceEnd: r3(word.end),
        at: r3(at),
        peakDb: r3(peakDb),
        sentenceMedian: r3(sentenceMedian),
        marginDb: r3(margin),
      });
    }
  }

  stressed.sort((a, b) => b.peakDb - a.peakDb || a.at - b.at);
  const chosen = [];
  for (const candidate of stressed) {
    if (chosen.some(pick => Math.abs(candidate.at - pick.at) < spacing)) continue;
    chosen.push(candidate);
  }
  chosen.sort((a, b) => a.at - b.at);
  return {
    punches: chosen,
    stressed: stressed.length,
    marginDb,
    spacing,
  };
}

function defaultCacheDir() {
  return path.join(os.homedir(), 'Downloads', '.video-index');
}

function stemsFor(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const out = [base];
  const unprefixed = base.replace(/^[^_]+__/, '');
  if (unprefixed !== base && unprefixed.length >= 8) out.push(unprefixed);
  for (const value of [...out]) {
    const bare = value.replace(/__[0-9a-f]{8}$/, '');
    if (bare !== value) out.push(bare);
  }
  return [...new Set(out)];
}

export function loadEnergy10(mediaPath, { cacheDir, energy } = {}) {
  if (energy && Array.isArray(energy.db)) return energy;
  if (!mediaPath) return null;
  const root = cacheDir || defaultCacheDir();
  if (!fs.existsSync(root)) return null;
  const names = fs.readdirSync(root).filter(name => name.includes('.energy10'));
  for (const stem of stemsFor(mediaPath)) {
    const hit = names.filter(name => name.startsWith(`${stem}.`)).sort()[0];
    if (!hit) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, hit), 'utf8'));
      if (Array.isArray(parsed?.db) && parsed.db.length) return parsed;
    } catch { /* next stem */ }
  }
  return null;
}

export function loadTranscript(mediaPath, { cacheDir, transcript, words, wordsFile } = {}) {
  if (transcript && (Array.isArray(transcript.segments) || Array.isArray(transcript))) return transcript;
  if (Array.isArray(words) && words.length) return { segments: [{ words }] };
  if (wordsFile && fs.existsSync(wordsFile)) {
    return JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
  }
  if (!mediaPath) return null;
  const root = cacheDir || defaultCacheDir();
  if (!fs.existsSync(root)) return null;
  const names = fs.readdirSync(root).filter(name => name.includes('.whisper'));
  for (const stem of stemsFor(mediaPath)) {
    const hit = names.filter(name => name.startsWith(`${stem}.`)).sort()[0];
    if (!hit) continue;
    try {
      return JSON.parse(fs.readFileSync(path.join(root, hit), 'utf8'));
    } catch { /* next stem */ }
  }
  return null;
}

function principalMediaPath(doc, projectDir, trackIndex = null) {
  const { track } = principalTrack(doc, trackIndex);
  const videos = new Map((doc.materials?.videos || []).map(material => [material.id, material]));
  for (const segment of track.segments || []) {
    const material = videos.get(segment.material_id);
    if (!material?.path) continue;
    if (material.type && material.type !== 'video') continue;
    return resolveMediaPath(material.path, projectDir) || material.path;
  }
  return null;
}

function clipAt(track, at) {
  return (track.segments || []).find(segment => {
    const start = S(segment.target_timerange.start);
    const end = start + S(segment.target_timerange.duration);
    return start <= at && at < end;
  }) || null;
}

/**
 * Full-face talking-head only. Circle is refused (MOTION_MASK_UNSUPPORTED);
 * masked insets and B-roll overlays are skipped; non-face clips are never written.
 */
export function opStressZoom(doc, op = {}, context = {}) {
  const { track, index: trackIndex } = principalTrack(doc, op.track ?? null);
  const videos = new Map((doc.materials?.videos || []).map(material => [material.id, material]));
  const minLength = op.minLength != null ? Number(op.minLength) : 2.5;
  const scenes = talkingHeadScenes(doc, trackIndex, minLength);
  const circle = (track.segments || []).filter(segment => isCircleLayout(doc, segment));
  if (circle.length && !scenes.length) {
    throw new CapcutError(
      'Camera motion on a circle or rotated mask moves its border. Use a full-face scene or select the screen recording.',
      { code: 'MOTION_MASK_UNSUPPORTED', exitCode: 2 },
    );
  }
  if (!scenes.length) {
    throw new CapcutError('no full-face scenes found (every principal clip carries a mask).', { exitCode: 2 });
  }

  const mediaPath = principalMediaPath(doc, context.projectDir, trackIndex);
  const energy = loadEnergy10(mediaPath, { cacheDir: op.cacheDir, energy: op.energy });
  const transcript = loadTranscript(mediaPath, {
    cacheDir: op.cacheDir,
    transcript: op.transcript,
    words: op.words,
    wordsFile: op.wordsFile,
  });
  const mapper = sourceToTimeline(doc, trackIndex);
  const planned = planStressPunches({
    transcript,
    words: op.words,
    energy,
    mapper,
    scenes,
    marginDb: op.marginDb != null ? Number(op.marginDb) : STRESS_MARGIN_DB,
    spacing: op.spacing != null ? Number(op.spacing) : STRESS_SPACING_S,
  });

  const ramp = op.ramp != null ? Number(op.ramp) : STRESS_RAMP;
  const scale = op.to != null ? Number(op.to) : STRESS_SCALE;
  const toIsAbsolute = op.to != null;
  const skipped = [];
  const punches = [];

  for (const hit of planned.punches) {
    const segment = clipAt(track, hit.at);
    if (!segment) {
      skipped.push({ ...hit, skipped: 'no clip on the principal track' });
      continue;
    }
    const material = videos.get(segment.material_id);
    if (isBrollSegment(segment, material)) {
      skipped.push({ ...hit, skipped: 'b-roll / screen recording' });
      continue;
    }
    if (isCircleLayout(doc, segment)) {
      throw new CapcutError(
        'Camera motion on a circle or rotated mask moves its border. Use a full-face scene or select the screen recording.',
        { code: 'MOTION_MASK_UNSUPPORTED', exitCode: 2 },
      );
    }
    if (isMaskedInset(doc, segment)) {
      skipped.push({ ...hit, skipped: 'masked face; choose a full-face scene' });
      continue;
    }
    if ((segment.clip?.alpha ?? 1) <= 0) {
      skipped.push({ ...hit, skipped: 'hidden face' });
      continue;
    }
    const moveAt = Math.max(S(segment.target_timerange.start), hit.at - ramp);
    const remaining = S(segment.target_timerange.start + segment.target_timerange.duration) - moveAt;
    if (remaining < 2 * ramp) {
      skipped.push({ ...hit, skipped: 'too short for a push and return' });
      continue;
    }
    const hold = op.hold != null
      ? Number(op.hold)
      : Math.min(STRESS_HOLD, Math.max(0, remaining - 2 * ramp));
    const speed = (segment.source_timerange?.duration || segment.target_timerange.duration)
      / segment.target_timerange.duration;
    const st = segment.source_timerange || { start: 0, duration: segment.target_timerange.duration };
    const tt = segment.target_timerange;
    const startUs = st.start + US((moveAt - S(tt.start)) * speed);
    const endUs = startUs + US((2 * ramp + hold) * speed);
    try {
      assertNoDoublePunch(segment, startUs, endUs);
    } catch (error) {
      if (error?.code === 'DOUBLE_PUNCH') {
        skipped.push({ ...hit, skipped: 'DOUBLE_PUNCH' });
        continue;
      }
      throw error;
    }
    const from = segment.clip?.scale?.x ?? 1;
    const to = toIsAbsolute ? scale : from * STRESS_SCALE;
    const written = opScaleKeyframe(doc, {
      selector: { id: segment.id },
      at: moveAt,
      ramp,
      to,
      hold,
      track: trackIndex,
      ...(op.ease ? { ease: true } : {}),
      ...(op.__seed ? { __seed: op.__seed } : {}),
    });
    punches.push({
      ...hit,
      segment: segment.id,
      moveAt: r3(moveAt),
      arrivesAt: r3(moveAt + ramp),
      to: written.to,
      hold: written.hold,
      shape: written.shape,
      ease: Boolean(op.ease),
    });
  }

  return {
    mode: 'stress',
    scale: STRESS_SCALE,
    marginDb: planned.marginDb,
    spacing: planned.spacing,
    punches,
    skipped,
    stressed: planned.stressed,
  };
}
