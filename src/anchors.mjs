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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CapcutError, readJson } from './core.mjs';
import { principalTrack } from './polish.mjs';
import { normalise, sourceToTimeline } from './signature.mjs';
import { wordsFromTranscript } from './match.mjs';

const r3 = n => Math.round(n * 1000) / 1000;

/** The word-level Whisper transcript `cut` cached for this project's talking head, or null. */
export function findWordsFile(doc, principalIndex = null) {
  const cache = path.join(os.homedir(), 'Downloads', '.video-index');
  if (!fs.existsSync(cache)) return null;
  const names = fs.readdirSync(cache).filter(n => n.includes('.whisper'));
  if (!names.length) return null;

  // An index file is only the right one if its stem IS the media's stem — `startsWith` alone
  // matched `screen.whisper-*.json` for every `…__screen.mp4`, so a project's B-roll answered
  // for the talking head and detection ran against a transcript with no speech in it.
  const exact = stem => names.filter(n => n.startsWith(`${stem}.`)).sort()[0] || null;
  const stemsFor = file => {
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    const out = [base];
    // `localizeMedia` prefixes the parent folder ("Downloads__F7ED1ECA-…") and may append an
    // 8-hex collision tag; the index is keyed on the ORIGINAL stem.
    const unprefixed = base.replace(/^[^_]+__/, '');
    if (unprefixed !== base && unprefixed.length >= 8) out.push(unprefixed);
    for (const v of [...out]) {
      const bare = v.replace(/__[0-9a-f]{8}$/, '');
      if (bare !== v) out.push(bare);
    }
    return out;
  };

  // The talking head first, always. Brand detection maps HIS words onto the timeline, so a
  // screen recording's transcript is never the right answer even when one exists.
  const ordered = [];
  try {
    const { track } = principalTrack(doc, principalIndex);
    const byId = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
    for (const seg of track.segments || []) {
      const m = byId.get(seg.material_id);
      if (m?.path) ordered.push(m);
    }
  } catch { /* no principal track — fall through to every video */ }
  for (const m of doc.materials?.videos || []) if (m.path) ordered.push(m);

  for (const m of ordered) {
    if (m.type && m.type !== 'video') continue;
    for (const stem of stemsFor(m.path)) {
      const hit = exact(stem);
      if (hit) return path.join(cache, hit);
    }
  }
  return null;
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
    const at = mapper(first.start);
    if (at == null) continue;                  // this utterance was cut out
    seen++;
    if (seen !== occurrence) continue;
    // The phrase end may sit in a later clip; if the very end was trimmed, keep the start.
    const end = mapper(Math.max(first.start, last.end - 0.001)) ?? at;
    return {
      at: r3(at + Number(anchor.offset || 0)), end: r3(Math.max(end, at)),
      sourceAt: r3(first.start), text: words.slice(i, i + want.length).map(w => w.text).join(' '),
    };
  }
  return null;
}

/**
 * Resolve every anchor or refuse naming the orphans. Items without `say` keep their `at`.
 * Returns items with `at` (and `end` when anchored) filled in.
 */
export function resolveAnchors(items, { doc, words = null, wordsFile = null, principalIndex = null } = {}) {
  const needs = items.filter(item => item && item.say);
  if (!needs.length) return items.map(item => ({ ...item }));
  let list = words;
  if (!list) {
    const file = wordsFile || findWordsFile(doc, principalIndex);
    if (!file) {
      throw new CapcutError('Anchors need the word-level transcript `cut` writes '
        + '(~/Downloads/.video-index/<stem>.whisper-*.json). Pass --words FILE or give `at` seconds.',
      { code: 'ANCHOR_NO_WORDS', exitCode: 2 });
    }
    list = loadWords(file);
  }
  const mapper = sourceToTimeline(doc, principalIndex);
  const orphans = [];
  const out = items.map(item => {
    if (!item?.say) return { ...item };
    const hit = resolveAnchor(item, list, mapper);
    if (!hit) { orphans.push(`${item.id || item.template || 'item'}: "${item.say}"${item.occurrence ? ` #${item.occurrence}` : ''}`); return null; }
    return { ...item, at: hit.at, end: hit.end, anchor: { say: item.say, occurrence: item.occurrence || 1, sourceAt: hit.sourceAt, heard: hit.text } };
  });
  if (orphans.length) {
    throw new CapcutError(`Orphaned anchors — these words are not in the cut (recut dropped them, or `
      + `Whisper wrote them differently): ${orphans.join('; ')}`, { code: 'ANCHOR_ORPHANED', exitCode: 2, details: { orphans } });
  }
  return out;
}
