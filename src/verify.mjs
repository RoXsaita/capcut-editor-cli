/**
 * Blind shot verifier (F07).
 *
 * Each placed B-roll shot gets a before / action / after strip and a
 * SUPPORTED / CONTRADICTED / INSUFFICIENT verdict from a checker that never
 * sees why the matcher picked it. CONTRADICTED blocks the build; INSUFFICIENT
 * only flags. Never writes the draft.
 *
 * A deterministic baseline runs in-process (no LLM). prompt.md is for a fresh
 * agent in the session to give a second opinion from the strip alone.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapcutError, allSegments, resolveMediaPath } from './core.mjs';
import { isBrollSegment } from './broll-lint.mjs';
import { scoreAt, loadClicks } from './punch.mjs';
import { momentsFromSidecar } from './broll-lint.mjs';
import { ACTION_VERBS, sentenceKind, tokenize, readShotsFile } from './match.mjs';
import { pythonForTool } from './python.mjs';

const r3 = n => Math.round(n * 1000) / 1000;
const S = us => (us || 0) / 1e6;

export const VERDICTS = Object.freeze(['SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT']);

/** Keys a blind checker must never see. `changeScore` is evidence, not a matcher score. */
export const BLIND_FORBIDDEN_KEYS = Object.freeze([
  'score', 'scores', 'runnerUp', 'margin', 'reasons', 'ops', 'punchOn',
  'query', 'decision', 'typeKind', 'momentKind', 'chatOnly', 'textEffective',
  'pairScore', 'assignment', 'hits', 'loop',
]);

const SHOW_REGIONS = new Set(['canvas', 'toolbar']);

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

export function assertBlindBrief(brief) {
  const keys = collectKeys(brief);
  const leaked = [...keys].filter(key => BLIND_FORBIDDEN_KEYS.includes(key));
  if (leaked.length) {
    throw new CapcutError(`brief.json leaked matcher internals: ${leaked.join(', ')}`, {
      code: 'BRIEF_NOT_BLIND', exitCode: 2, details: { leaked },
    });
  }
  return true;
}

function sanitizeOcr(ocr) {
  return (ocr || []).map(box => ({
    text: String(box.text || ''),
    region: box.region || 'unknown',
    conf: Number.isFinite(Number(box.conf)) ? Number(box.conf) : undefined,
  }));
}

export function buildBrief(shot, frames = {}) {
  const srcIn = Number(frames.srcIn ?? shot.source?.in ?? shot.moment?.start ?? 0);
  const brief = {
    sentence: String(shot.sentence || shot.text || ''),
    frames: {
      before: {
        t: r3(frames.before?.t ?? srcIn - 0.5),
        ocr: sanitizeOcr(frames.before?.ocr),
      },
      action: {
        t: r3(frames.action?.t ?? srcIn),
        ocr: sanitizeOcr(frames.action?.ocr),
      },
      after: {
        t: r3(frames.after?.t ?? srcIn + 0.5),
        ocr: sanitizeOcr(frames.after?.ocr),
      },
    },
    changeScore: r3(Number(frames.changeScore ?? 0)),
    clicks: (frames.clicks || []).map(click => ({
      vt: r3(Number(click.vt)),
      type: click.type || 'click',
    })),
  };
  assertBlindBrief(brief);
  return brief;
}

function tokensIn(ocr, tokens, regions = SHOW_REGIONS) {
  const boxes = (ocr || []).filter(box => !regions || regions.has(box.region || 'canvas'));
  return tokens.filter(token => boxes.some(box => String(box.text || '').toLowerCase().includes(token)));
}

function canvasNames(ocr) {
  const names = [];
  for (const box of ocr || []) {
    if (!SHOW_REGIONS.has(box.region || 'canvas')) continue;
    for (const token of tokenize(box.text)) {
      if (token.length >= 3 && !ACTION_VERBS.has(token)) names.push(token);
    }
  }
  return [...new Set(names)];
}

function contentTokens(sentence) {
  return tokenize(sentence).filter(token => !ACTION_VERBS.has(token));
}

function textsDiffer(a, b) {
  const norm = ocr => (ocr || [])
    .filter(box => SHOW_REGIONS.has(box.region || 'canvas'))
    .map(box => String(box.text || '').toLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join('|');
  return norm(a) !== norm(b);
}

export function changeOccurred(brief) {
  if (Number(brief.changeScore) >= 0.15) return true;
  return textsDiffer(brief.frames?.before?.ocr, brief.frames?.after?.ocr);
}

/**
 * Deterministic baseline so the command is useful without an LLM.
 *
 * SUPPORTED: sentence tokens appear in canvas/toolbar of the action or after
 * frame AND change occurred.
 * CONTRADICTED: after shows a clearly different named element/app than the
 * sentence, or an action was spoken but the frames show no change, or the
 * result is on the before frame and gone after (swapped).
 * else INSUFFICIENT.
 */
export function baselineVerdict(brief) {
  const sentence = brief.sentence || '';
  const tokens = tokenize(sentence);
  const content = contentTokens(sentence);
  const before = brief.frames?.before?.ocr || [];
  const action = brief.frames?.action?.ocr || [];
  const after = brief.frames?.after?.ocr || [];
  const shown = new Set([
    ...tokensIn(action, tokens),
    ...tokensIn(after, tokens),
  ]);
  const changed = changeOccurred(brief);
  const kind = sentenceKind(sentence);

  const inBefore = tokensIn(before, content);
  const inAfter = tokensIn(after, content);
  if (inBefore.length && !inAfter.length && changed) return 'CONTRADICTED';

  const wanted = content.filter(token => token.length >= 3);
  const afterNames = canvasNames(after);
  const missing = wanted.filter(token => !shown.has(token) && !afterNames.includes(token));
  const foreign = afterNames.filter(name => !wanted.includes(name) && !tokens.includes(name));
  if (wanted.length && missing.length && foreign.length) return 'CONTRADICTED';

  if (kind === 'action' && !changed) return 'CONTRADICTED';

  const need = Math.max(1, Math.ceil((content.length || tokens.length) * 0.5));
  if (shown.size >= need && changed && (content.length || tokens.length)) return 'SUPPORTED';
  return 'INSUFFICIENT';
}

export function promptMarkdown(brief) {
  return `# Blind shot verifier

You are a **fresh agent in this session**. You have not seen why this B-roll
shot was picked. There is no API billing — read the strip and the brief, then
answer.

## Look only at
- \`strip.png\` — labelled before / action / after frames from the **source**
- \`brief.json\` — the sentence spoken over the shot, OCR text + regions on
  those three frames, the change score at the in-point, and nearby clicks

Do **not** use matcher scores, chosen queries, margins, or placement reasons.
They are not in this folder on purpose.

## Verdict (one of)
- **SUPPORTED** — the sentence's tokens appear on the canvas/toolbar of the
  action or after frame, AND the picture changed.
- **CONTRADICTED** — the after frame shows a clearly different named
  element/app than the sentence, OR an action was spoken but the frames show
  no change, OR before/after look swapped.
- **INSUFFICIENT** — otherwise. Do not guess.

Sentence: ${JSON.stringify(brief.sentence)}
`;
}

function materialFor(doc, id) {
  for (const values of Object.values(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    const found = values.find(item => item && item.id === id);
    if (found) return found;
  }
  return null;
}

export function brollShotsFromDoc(doc, { projectDir = null, words = [] } = {}) {
  const shots = [];
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video' || track.flag === 0) continue;
    const material = materialFor(doc, segment.material_id);
    if (!isBrollSegment(segment, material)) continue;
    const tt = segment.target_timerange || {};
    const st = segment.source_timerange || {};
    const tlStart = S(tt.start);
    const tlEnd = S((tt.start || 0) + (tt.duration || 0));
    const spoken = (words || []).filter(word => {
      const start = Number(word.start), end = Number(word.end);
      return Number.isFinite(start) && Number.isFinite(end) && start < tlEnd && end > tlStart;
    });
    shots.push({
      id: segment.id,
      sentence: spoken.map(word => word.word || word.text || '').join(' ').trim(),
      timeline: { start: r3(tlStart), end: r3(tlEnd) },
      source: { in: r3(S(st.start)), out: r3(S((st.start || 0) + (st.duration || 0))) },
      media: resolveMediaPath(material?.path, projectDir) || material?.path || '',
    });
  }
  return shots;
}

function composeStrip(media, times, labels, out) {
  const python = pythonForTool('verify_shots.py');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'verify_shots.py');
  const result = spawnSync(python.executable, [
    script,
    '--media', media,
    '--out', out,
    '--times', times.join(','),
    '--labels', labels.join(','),
  ], { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new CapcutError(
      `verify-shots could not compose a strip: ${String(result.stderr || result.error?.message || 'failed').trim()}`,
      { code: 'VERIFY_STRIP_FAILED', exitCode: 2 },
    );
  }
  try {
    return JSON.parse(String(result.stdout || '{}'));
  } catch {
    return { strip: out };
  }
}

function nearbyClicks(clicks, t, window = 0.75) {
  return (clicks || []).filter(click => Math.abs(Number(click.vt) - t) <= window);
}

/**
 * Verify placed shots. Tests inject `frames` / `ocr` per shot so they never
 * bind real media or `~/Downloads/.video-index`.
 */
export function verifyShots({
  shots = [], outDir, writeStrip = true, moments, clicks,
} = {}) {
  if (!outDir) {
    throw new CapcutError('verify-shots requires --out DIR.', { code: 'NO_OUT', exitCode: 2 });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const reports = [];
  for (const [index, shot] of shots.entries()) {
    const srcIn = Number(shot.source?.in ?? shot.moment?.start ?? 0);
    const media = shot.media || shot.screen || '';
    const times = [Math.max(0, srcIn - 0.5), srcIn, srcIn + 0.5];
    const labels = [`before ${times[0].toFixed(2)}s`, `action ${times[1].toFixed(2)}s`, `after ${times[2].toFixed(2)}s`];
    const dir = path.join(outDir, shot.id || `shot-${index}`);
    fs.mkdirSync(dir, { recursive: true });
    let strip = null;
    if (writeStrip && media && fs.existsSync(media)) {
      strip = composeStrip(media, times, labels, path.join(dir, 'strip.png'))?.strip || path.join(dir, 'strip.png');
    }
    const frames = shot.frames || {
      srcIn,
      before: { t: times[0], ocr: shot.ocr?.before || [] },
      action: { t: times[1], ocr: shot.ocr?.action || [] },
      after: { t: times[2], ocr: shot.ocr?.after || [] },
      changeScore: shot.changeScore ?? (moments ? scoreAt(moments, srcIn) : 0),
      clicks: shot.clicks || nearbyClicks(clicks, srcIn),
    };
    const brief = buildBrief(shot, frames);
    const verdict = shot.verdict || baselineVerdict(brief);
    const row = {
      id: shot.id || `shot-${index}`,
      sentence: brief.sentence,
      verdict,
      strip,
      dir,
    };
    fs.writeFileSync(path.join(dir, 'brief.json'), `${JSON.stringify(brief, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'prompt.md'), promptMarkdown(brief));
    fs.writeFileSync(path.join(dir, 'verdict.json'), `${JSON.stringify({ verdict, baseline: verdict }, null, 2)}\n`);
    reports.push(row);
  }
  const contradicted = reports.filter(row => row.verdict === 'CONTRADICTED');
  const insufficient = reports.filter(row => row.verdict === 'INSUFFICIENT');
  const supported = reports.filter(row => row.verdict === 'SUPPORTED');
  const summary = {
    out: outDir,
    shots: reports.length,
    supported: supported.length,
    contradicted: contradicted.length,
    insufficient: insufficient.length,
    reports,
    blocked: contradicted.map(row => ({ id: row.id, sentence: row.sentence })),
    flags: insufficient.map(row => ({ id: row.id, sentence: row.sentence })),
    note: 'prompt.md is for a fresh agent in the session (no API billing) to second-guess the strip. CONTRADICTED blocks the build; INSUFFICIENT only flags. Never writes the draft.',
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export function loadVerifyShots({ shots, shotsFile, doc, projectDir, words } = {}) {
  if (Array.isArray(shots) && shots.length) return shots;
  if (shotsFile) {
    const data = readShotsFile(shotsFile);
    return (data.shots || []).filter(shot => shot.decision === 'place');
  }
  if (doc) return brollShotsFromDoc(doc, { projectDir, words });
  return [];
}

export function attachSidecarEvidence(shots, { projectDir, moments, clicks } = {}) {
  return (shots || []).map(shot => {
    const media = shot.media || shot.screen;
    const srcIn = Number(shot.source?.in ?? shot.moment?.start ?? 0);
    const loadedMoments = shot.moments || moments || (media ? momentsFromSidecar(media, projectDir) : null);
    const loadedClicks = shot.clicks || clicks || (media ? loadClicks(media, projectDir) : []);
    return {
      ...shot,
      changeScore: shot.changeScore ?? (loadedMoments ? scoreAt(loadedMoments, srcIn) : 0),
      clicks: nearbyClicks(loadedClicks, srcIn),
    };
  });
}
