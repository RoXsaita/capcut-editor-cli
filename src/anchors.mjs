/**
 * Source-word anchors.
 *
 * A graphic, a logo or an emphasis push belongs to a WORD, not to a timeline second: the
 * transcript is of the raw take and the timeline is a recut of it, so a second is only
 * meaningful until the next recut. An anchor names the words (`say`), which occurrence among
 * the words that SURVIVED the cut, and an optional offset. `sourceToTimeline` maps the word's
 * source time through the principal track's paired ranges — exact, not estimated — so after
 * `cut --into` a rebuild lands every anchor on its word again, or refuses by name when the
 * word itself was cut.
 */
import { CapcutError, readJson } from './core.mjs';
import { INDEX_MISMATCH, findIndexForMaterial, shiftWords } from './video-index.mjs';
import { principalTrack } from './polish.mjs';
import { normalise, sourceToTimeline } from './signature.mjs';
import { wordsFromTranscript } from './match.mjs';

const r3 = n => Math.round(n * 1000) / 1000;
// A word whose Whisper start sits just before a clip's in-point: how far to probe forward,
// in what steps, and how much of the word must still be heard after the probe.
const ANCHOR_SNAP_S = 0.75;
const ANCHOR_SNAP_STEP_S = 0.02;
const ANCHOR_SNAP_MIN_S = 0.08;

/**
 * The word-level Whisper transcript `cut` cached for this project's talking head:
 * { file, offset } (offset: seconds the face file starts into the indexed original), or
 * { file: null, reason }. Only the principal track's media is tried — never every video,
 * since a screen recording's transcript is never the answer for the face — and each one's
 * derived original first, because a denoised or re-encoded face has no index of its own.
 */
export function findWords(doc, principalIndex = null, { projectDir = null, cacheDir = null } = {}) {
  let track;
  try { ({ track } = principalTrack(doc, principalIndex)); } catch { return { file: null, reason: 'no principal track' }; }
  const byId = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const seen = new Set();
  let reason = null;
  for (const seg of track.segments || []) {
    const m = byId.get(seg.material_id);
    if (!m?.path || seen.has(m.id) || (m.type && m.type !== 'video')) continue;
    seen.add(m.id);
    const hit = findIndexForMaterial(m, projectDir, 'whisper', { cacheDir, derivedFirst: true });
    if (hit.file) return { file: hit.file, offset: hit.offset, legacy: hit.legacy };
    if (hit.reason === INDEX_MISMATCH || !reason) reason = hit.reason;
  }
  return { file: null, offset: 0, reason: reason || 'no index file' };
}

/** The transcript file alone (callers that only hash or display it). */
export function findWordsFile(doc, principalIndex = null, options = {}) {
  return findWords(doc, principalIndex, options).file;
}

/** Load the words of a Whisper transcript file as [{ text, start, end }], source seconds. */
export function loadWords(file) {
  const transcript = readJson(file);
  if (!Array.isArray(transcript) && !Array.isArray(transcript.segments)) {
    throw new CapcutError(`${file} is not a Whisper transcript with segments[].words.`, { code: 'WORDS_FORMAT', exitCode: 2 });
  }
  return wordsFromTranscript(transcript)
    .map(w => ({ text: String(w.word ?? w.text ?? '').trim(), start: Number(w.start), end: Number(w.end ?? w.start) }))
    .filter(w => w.text && Number.isFinite(w.start));
}

/**
 * Resolve one anchor against source words and a source→timeline mapper.
 * anchor = { say: 'phrase', occurrence?: 1, offset?: seconds } → { at, end, sourceAt, text } or null.
 * Occurrences are counted among matches that survive the cut, so "the second time he says it"
 * means the second one the viewer hears.
 */
export function resolveAnchor(anchor, words, mapper) {
  const want = normalise(anchor.say).split(' ').filter(Boolean);
  if (!want.length) return null;
  const occurrence = Math.max(1, Number(anchor.occurrence || 1));
  let seen = 0;
  for (let i = 0; i + want.length <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) ok = normalise(words[i + k].text) === want[k];
    if (!ok) continue;
    const first = words[i], last = words[i + want.length - 1];
    let at = mapper(first.start);
    let snapped = false;
    if (at == null) {
      // Whisper often starts a word a few frames before the clip's in-point. Probe forward
      // and keep the word when enough of it survives the cut; a word that was dropped stays
      // an orphan because the probe never passes the word's own end.
      const lastEnd = Number(last.end ?? last.start);
      const limit = Math.min(lastEnd - 0.001, first.start + ANCHOR_SNAP_S);
      for (let k = 1; first.start + k * ANCHOR_SNAP_STEP_S <= limit + 1e-9; k++) {
        const t = first.start + k * ANCHOR_SNAP_STEP_S;
        const mapped = mapper(t);
        if (mapped == null) continue;
        if (lastEnd - t >= ANCHOR_SNAP_MIN_S - 1e-9) { at = mapped; snapped = true; }
        break;
      }
    }
    if (at == null) continue;                  // this utterance was cut out
    seen++;
    if (seen !== occurrence) continue;
    // The phrase end may sit in a later clip; if the very end was trimmed, keep the start.
    const end = mapper(Math.max(first.start, last.end - 0.001)) ?? at;
    return {
      at: r3(at + Number(anchor.offset || 0)), end: r3(Math.max(end, at)),
      sourceAt: r3(first.start), text: words.slice(i, i + want.length).map(w => w.text).join(' '),
      ...(snapped ? { snapped: true } : {}),
    };
  }
  return null;
}

/**
 * Resolve every anchor or refuse naming the orphans. Items without `say` keep their `at`.
 * Returns items with `at` (and `end` when anchored) filled in.
 */
export function resolveAnchors(items, { doc, words = null, wordsFile = null, wordsOffset = 0, principalIndex = null, projectDir = null } = {}) {
  const needs = items.filter(item => item && item.say);
  if (!needs.length) return items.map(item => ({ ...item }));
  let list = words;
  if (!list) {
    const found = wordsFile ? { file: wordsFile, offset: wordsOffset } : findWords(doc, principalIndex, { projectDir });
    if (!found.file) {
      throw new CapcutError('Anchors need the word-level transcript `cut` writes '
        + '(~/Downloads/.video-index/<stem>.whisper-*.json). Pass --words FILE or give `at` seconds.'
        + (found.reason === INDEX_MISMATCH ? ` The cached transcript was refused: ${INDEX_MISMATCH} (re-run cut on this take).` : ''),
      { code: 'ANCHOR_NO_WORDS', exitCode: 2, details: { reason: found.reason } });
    }
    list = shiftWords(loadWords(found.file), Number(found.offset) || 0);
  }
  const mapper = sourceToTimeline(doc, principalIndex);
  const orphans = [];
  const out = items.map(item => {
    if (!item?.say) return { ...item };
    const hit = resolveAnchor(item, list, mapper);
    if (!hit) { orphans.push(`${item.id || item.template || 'item'}: "${item.say}"${item.occurrence ? ` #${item.occurrence}` : ''}`); return null; }
    return { ...item, at: hit.at, end: hit.end, anchor: { say: item.say, occurrence: item.occurrence || 1, sourceAt: hit.sourceAt, heard: hit.text, ...(hit.snapped ? { snapped: true } : {}) } };
  });
  if (orphans.length) {
    throw new CapcutError(`Orphaned anchors — these words are not in the cut (recut dropped them, or `
      + `Whisper wrote them differently): ${orphans.join('; ')}`, { code: 'ANCHOR_ORPHANED', exitCode: 2, details: { orphans } });
  }
  return out;
}
