import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allSegments, resolveMediaPath } from './core.mjs';
import { principalTrack } from './polish.mjs';
import { sourceToTimeline } from './signature.mjs';

export const BROLL_TOO_SHORT = 0.8;
export const BROLL_IN_MOTION_SCORE = 0.5;
const S = us => (us || 0) / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;

const SCREEN_RECORDING = 'layout:screen-recording';
const PLATE_EXT = /\.(gif|png|webp|apng|jpe?g|heic)$/i;

export function isBrollSegment(segment, material) {
  const desc = String(segment?.desc || '');
  if (desc === SCREEN_RECORDING) return true;
  if (desc.startsWith('layout:') || desc.startsWith('sig:')) return false;
  if (!material) return false;
  if (material.type && material.type !== 'video') return false;
  const file = String(material.path || '').toLowerCase();
  if (PLATE_EXT.test(file)) return false;
  if (desc.startsWith('broll:') || desc.startsWith('b-roll:') || desc.startsWith('screen:')) return true;
  return /screen_recording|screen-recording|screen\.mp4|gameplay/i.test(file);
}

function onScreenSeconds(segment) {
  const dur = Number(segment?.target_timerange?.duration);
  return Number.isFinite(dur) && dur > 0 ? dur / 1e6 : 0;
}

function scoreAt(moments, t) {
  if (typeof moments === 'function') return Number(moments(t)) || 0;
  if (!Array.isArray(moments)) return 0;
  for (const moment of moments) {
    const start = Number(moment.start), end = Number(moment.end);
    const peak = Number(moment.peak ?? moment.score);
    if (!(start <= t && t <= end)) continue;
    if (peak >= BROLL_IN_MOTION_SCORE) return peak;
  }
  return 0;
}

function wordAt(words, t) {
  if (!Array.isArray(words)) return null;
  for (const word of words) {
    const start = Number(word.start), end = Number(word.end);
    if (Number.isFinite(start) && Number.isFinite(end) && start < t && t < end) return word;
  }
  return null;
}

/**
 * New finding codes only. Existing A-roll lint() thresholds and cut exit behaviour
 * are untouched — this is the B-roll sibling used by doctor/finish.
 *
 * `moments` omitted → skip BROLL_IN_MOTION.
 * `words` omitted → skip BROLL_OUT_MIDWORD.
 * Pass `words: []` / `moments: []` when the index loaded and is empty.
 */
export function lintBroll(segments, { moments, words } = {}) {
  const skipped = [];
  const findings = [];
  const hasChange = moments !== undefined || (segments || []).some(seg => seg.moments !== undefined);
  if (!hasChange) {
    skipped.push({ code: 'BROLL_IN_MOTION', reason: 'no change sidecar' });
  }
  if (words === undefined) {
    skipped.push({ code: 'BROLL_OUT_MIDWORD', reason: 'no transcript' });
  }
  for (const seg of segments || []) {
    const id = seg.id || seg.label || '?';
    const localMoments = seg.moments !== undefined ? seg.moments : moments;
    if (localMoments !== undefined) {
      const srcIn = Number(seg.srcIn);
      const score = scoreAt(localMoments, srcIn);
      if (score >= BROLL_IN_MOTION_SCORE) {
        findings.push({
          code: 'BROLL_IN_MOTION', id, srcIn: r3(srcIn), score: r3(score),
          message: `${id} IN BROLL_IN_MOTION  src ${r3(srcIn)}s score ${r3(score)} (≥ ${BROLL_IN_MOTION_SCORE})`,
        });
      }
    }
    if (words !== undefined) {
      const out = Number(seg.timelineOut);
      const word = wordAt(words, out);
      if (word) {
        findings.push({
          code: 'BROLL_OUT_MIDWORD', id, timelineOut: r3(out),
          word: word.word || word.text || '',
          message: `${id} OUT BROLL_OUT_MIDWORD  ${r3(out)}s falls inside ${JSON.stringify(word.word || word.text || 'word')} `
            + `${r3(word.start)}-${r3(word.end)}s`,
        });
      }
    }
    const held = Number(seg.onScreen);
    if (Number.isFinite(held) && held < BROLL_TOO_SHORT) {
      findings.push({
        code: 'BROLL_TOO_SHORT', id, onScreen: r3(held),
        message: `${id} BROLL_TOO_SHORT  ${r3(held)}s on screen after pace (min ${BROLL_TOO_SHORT}s)`,
      });
    }
  }
  return { findings, skipped };
}

function sidecarDir(mediaPath, projectDir) {
  if (!mediaPath) return null;
  const here = path.dirname(mediaPath);
  if (fs.existsSync(path.join(here, 'change.ndjson'))) return here;
  const name = path.basename(mediaPath);
  const marker = '__screen';
  if (!name.includes(marker)) return null;
  const take = name.split(marker)[0];
  const root = path.join(projectDir || path.dirname(path.dirname(here)), '.capcutctl', 'rl2');
  if (!take || !fs.existsSync(root)) return null;
  try {
    for (const entry of fs.readdirSync(root).sort()) {
      const dir = path.join(root, entry);
      if (entry.startsWith(`${take}__`) && fs.existsSync(path.join(dir, 'change.ndjson'))) return dir;
    }
  } catch { /* missing rl2 folder */ }
  return null;
}

function readNdjson(file) {
  try {
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const row = JSON.parse(text);
        if (row && typeof row === 'object') rows.push(row);
      } catch { /* truncated last line */ }
    }
    return rows;
  } catch {
    return [];
  }
}

export function momentsFromSidecar(mediaPath, projectDir = null, { minScore = BROLL_IN_MOTION_SCORE, mergeGap = 1 } = {}) {
  const dir = sidecarDir(mediaPath, projectDir);
  if (!dir) return null;
  const rows = readNdjson(path.join(dir, 'change.ndjson'));
  const marks = [];
  for (const row of rows) {
    if (typeof row.score !== 'number' || typeof row.vt !== 'number' || row.score < minScore) continue;
    marks.push({ at: row.vt, score: row.score });
  }
  if (!marks.length) return [];
  marks.sort((a, b) => a.at - b.at);
  const runs = [];
  for (const mark of marks) {
    const last = runs.at(-1);
    if (last && mark.at - last.end <= mergeGap) {
      last.end = Math.max(last.end, mark.at);
      last.peak = Math.max(last.peak, mark.score);
    } else {
      runs.push({ start: mark.at, end: mark.at, peak: mark.score });
    }
  }
  return runs;
}

function transcriptWords(data) {
  const words = [];
  for (const seg of data?.segments || []) {
    for (const w of seg.words || []) {
      const start = Number(w.start), end = Number(w.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      words.push({ start, end, word: w.word || w.text || '' });
    }
  }
  return words;
}

function loadWhisperCache(mediaPath) {
  if (!mediaPath) return null;
  // A synthetic or missing path must not pick up an unrelated home-directory transcript.
  if (!fs.existsSync(mediaPath)) return null;
  const cache = path.join(os.homedir(), 'Downloads', '.video-index');
  const stem = path.parse(mediaPath).name;
  let files = [];
  try {
    files = fs.readdirSync(cache).filter(name => name.includes('.whisper') && name.startsWith(stem) && name.endsWith('.json'));
  } catch {
    return null;
  }
  for (const name of files.sort()) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(cache, name), 'utf8'));
      if (Array.isArray(data?.segments)) return data;
    } catch { /* unreadable */ }
  }
  return null;
}

function principalMedia(doc, projectDir) {
  try {
    const { track } = principalTrack(doc);
    const seg = (track.segments || []).find(s => s.material_id);
    const material = (doc.materials?.videos || []).find(m => m.id === seg?.material_id);
    if (isBrollSegment(seg, material)) return null;
    return resolveMediaPath(material?.path, projectDir);
  } catch {
    return null;
  }
}

export function brollClips(doc, projectDir = null) {
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const clips = [];
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video' || track.flag === 0) continue;
    const material = videos.get(segment.material_id);
    if (!isBrollSegment(segment, material)) continue;
    const tt = segment.target_timerange || {};
    const st = segment.source_timerange || {};
    clips.push({
      id: segment.id,
      srcIn: S(st.start),
      timelineOut: S((tt.start || 0) + (tt.duration || 0)),
      onScreen: onScreenSeconds(segment),
      path: resolveMediaPath(material?.path, projectDir) || material?.path || '',
      material,
      segment,
    });
  }
  return clips;
}

/**
 * Project-level B-roll lint. Missing sidecars/transcripts skip their codes and say why.
 */
export function lintProjectBroll(doc, { projectDir = null, moments, words } = {}) {
  const clips = brollClips(doc, projectDir);
  let resolvedMoments = moments;
  let resolvedWords = words;
  if (resolvedMoments === undefined) {
    let anySidecar = false;
    for (const clip of clips) {
      const file = resolveMediaPath(clip.path, projectDir) || clip.path;
      const found = momentsFromSidecar(file, projectDir);
      if (found == null) continue;
      anySidecar = true;
      clip.moments = found;
    }
    if (!anySidecar) resolvedMoments = undefined;
  }
  if (resolvedWords === undefined) {
    const media = principalMedia(doc, projectDir);
    const transcript = loadWhisperCache(media);
    if (transcript) {
      const map = sourceToTimeline(doc);
      resolvedWords = transcriptWords(transcript).flatMap(word => {
        const start = map(word.start), end = map(word.end);
        if (start == null || end == null || end <= start) return [];
        return [{ ...word, start, end }];
      });
    }
  }
  const result = lintBroll(clips, { moments: resolvedMoments, words: resolvedWords });
  const issues = [
    ...result.skipped.map(row => ({
      level: 'warning', code: row.code,
      message: `skipped ${row.code}: ${row.reason}`,
      details: row,
    })),
    ...result.findings.map(row => ({
      level: 'warning', code: row.code, message: row.message, details: row,
    })),
  ];
  return { ...result, clips: clips.length, issues };
}
