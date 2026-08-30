import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CapcutError, clone, uuid, requireBinary } from './core.mjs';
import { geminiApiKey, loadEnv } from './env.mjs';
import { pictureChanges, sfxPresets } from './polish.mjs';
import { contentEndUs } from './add.mjs';

const US = s => Math.round(s * 1e6);
const S = us => us / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;
export const DEFAULT_MUSIC_VOLUME = 0.08;

let SEED = null;
function mint(key) {
  if (!SEED) return uuid();
  const h = crypto.createHash('sha256').update(`${SEED}|${key}`).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const arr = (doc, kind) => (doc.materials[kind] ||= []);

function mmss(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(0).padStart(2, '0');
  return `${m}:${r}`;
}

/** Timed instrumental prompt: picture-change hits in the score, quiet under speech, out at the CTA. */
export function musicPrompt(doc, { duration = null, hits = null, projectDir = null } = {}) {
  const dur = duration ?? S(contentEndUs(doc, projectDir));
  const changes = (hits || pictureChanges(doc)).filter(hit => {
    const t = Number(hit?.t);
    return Number.isFinite(t) && t >= 0 && t < dur;
  });
  const last = changes.at(-1)?.t ?? dur * 0.9;
  const cta = Math.max(dur * 0.9, last);
  const lines = [
    `Create a ${dur.toFixed(1)}-second instrumental-only background bed for a vertical tech demo.`,
    `No vocals, no lyrics, no sung words, no drops, no riser that overpowers speech.`,
    `Quiet modern electronic / soft pulse, 95–110 BPM, minor key, pads and muted perc.`,
    `This sits UNDER a spoken voiceover. Percussion is light. Think product-demo Reel, not a trailer.`,
    `[0:00 - ${mmss(Math.min(changes[0]?.t || 4, 6))}] Hook: slightly brighter, still background.`,
  ];
  let cursor = changes[0]?.t || 4;
  for (const [i, hit] of changes.entries()) {
    if (i === 0) continue;
    lines.push(`[${mmss(cursor)} - ${mmss(hit.t)}] Under speech. Soft hit (not a drop) at ${mmss(hit.t)} for a picture change (${hit.kind}: ${String(hit.to || '').slice(0, 40)}).`);
    cursor = hit.t;
  }
  if (changes.length) {
    const names = changes.map(h => mmss(h.t)).join(', ');
    lines.push(`Soft accent hits exactly at: ${names}. Align downbeats to those times.`);
  }
  lines.push(`[${mmss(cta)} - ${mmss(dur)}] Fade to silence for the CTA. No beat after ${mmss(cta)}.`);
  lines.push('Instrumental only.');
  return lines.join('\n');
}

function findAudioB64(node, acc = []) {
  if (node == null) return acc;
  if (typeof node === 'string') return acc;
  if (Array.isArray(node)) {
    for (const x of node) findAudioB64(x, acc);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  const mime = node.mime_type || node.mimeType || '';
  const type = node.type || '';
  if (typeof node.data === 'string' && node.data.length > 800
      && (type === 'audio' || /^audio\//.test(mime) || node.output_audio)) {
    acc.push(node.data);
  }
  if (node.output_audio?.data) acc.push(node.output_audio.data);
  for (const v of Object.values(node)) if (v && typeof v === 'object') findAudioB64(v, acc);
  return acc;
}

export async function generateLyria({ prompt, model = 'lyria-3-pro-preview', timeoutMs = 180000 } = {}) {
  loadEnv();
  const key = geminiApiKey();
  if (!key) {
    throw new CapcutError(
      'no GEMINI_API_KEY. Put it in cli/.env (gitignored) or the environment.',
      { code: 'NO_API_KEY', exitCode: 2 });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        model,
        input: prompt,
        response_format: { type: 'audio' },
      }),
    });
  } catch (e) {
    throw new CapcutError(`Lyria request failed: ${e.message}`, { code: 'LYRIA_HTTP', exitCode: 2 });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch {
    throw new CapcutError(`Lyria returned non-JSON (${res.status}): ${text.slice(0, 240)}`, { code: 'LYRIA_HTTP', exitCode: 2 });
  }
  if (!res.ok) {
    const msg = body.error?.message || body.message || text.slice(0, 300);
    throw new CapcutError(`Lyria ${res.status}: ${msg}`, { code: 'LYRIA_HTTP', exitCode: 2, details: { status: res.status } });
  }
  const chunks = findAudioB64(body);
  if (!chunks.length) {
    throw new CapcutError('Lyria returned no audio. Check the key and model access.', { code: 'LYRIA_EMPTY', exitCode: 2 });
  }
  return Buffer.from(chunks.at(-1), 'base64');
}

export function probeAudioDuration(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ], { encoding: 'utf8' }).trim();
    const n = Number(out);
    if (!n) throw new Error('empty');
    return n;
  } catch {
    throw new CapcutError(`could not probe audio duration of ${path.basename(file)}`, { code: 'PROBE_FAILED', exitCode: 2 });
  }
}

/**
 * Onset peaks from PCM via ffmpeg. Min gap 0.32s (~188 BPM ceiling) so we keep
 * musical beats, not every hi-hat. No extra deps.
 */
export function detectBeats(file, { minGap = 0.32 } = {}) {
  requireBinary('ffmpeg', 'detecting beats in the generated bed');
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-i', file, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-',
  ], { encoding: 'buffer', maxBuffer: 80 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new CapcutError(`ffmpeg could not decode ${path.basename(file)} for beat detection`, { code: 'BEAT_DECODE', exitCode: 2 });
  }
  const buf = r.stdout;
  const n = buf.length / 4;
  const sr = 22050;
  const hop = 512;
  const rms = [];
  for (let i = 0; i + hop < n; i += hop) {
    let e = 0;
    for (let k = 0; k < hop; k++) {
      const v = buf.readFloatLE((i + k) * 4);
      e += v * v;
    }
    rms.push(Math.sqrt(e / hop));
  }
  const flux = [0];
  for (let i = 1; i < rms.length; i++) flux.push(Math.max(0, rms[i] - rms[i - 1]));
  const mean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1);
  const thr = mean * 1.6;
  const gapHops = Math.max(1, Math.round(minGap * sr / hop));
  const beats = [];
  let last = -gapHops;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] < thr) continue;
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    if (i - last < gapHops) continue;
    beats.push(r3(i * hop / sr));
    last = i;
  }
  return beats;
}

/** Shift that puts musical beats onto picture-change times. Never moves the VO. */
export function beatOffset(beats, hits, { clamp = 0.4 } = {}) {
  if (!beats?.length || !hits?.length) return { offset: 0, pairs: [] };
  const pairs = [];
  for (const h of hits) {
    const t = typeof h === 'number' ? h : h.t;
    let best = beats[0], dist = Math.abs(t - beats[0]);
    for (const b of beats) {
      const d = Math.abs(t - b);
      if (d < dist) { best = b; dist = d; }
    }
    pairs.push({ hit: r3(t), beat: r3(best), delta: r3(t - best) });
  }
  const deltas = pairs.map(p => p.delta).sort((a, b) => a - b);
  const mid = deltas[Math.floor(deltas.length / 2)];
  const offset = Math.max(-clamp, Math.min(clamp, mid));
  return { offset: r3(offset), pairs, median: r3(mid) };
}

function cacheDir(projectDir) {
  return path.join(projectDir, '.capcutctl');
}

export function musicCachePaths(projectDir) {
  const dir = cacheDir(projectDir);
  return {
    dir,
    file: path.join(dir, 'music.mp3'),
    meta: path.join(dir, 'music.json'),
  };
}

export function promptHash(prompt) {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function readMusicMeta(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function ensureAudioTrack(doc, name) {
  let track = doc.tracks.find(t => t.type === 'audio' && t.name === name);
  if (track) return track;
  const tpl = doc.tracks.find(t => t.type === 'audio');
  track = clone(tpl || sfxPresets().audioTrackTemplate);
  track.id = mint(`track:${name}`);
  track.name = name;
  track.segments = [];
  track.is_default_name = false;
  doc.tracks.push(track);
  return track;
}

function audioSegment(doc, materialId, startS, durationS, key, volume, desc) {
  const p = sfxPresets();
  const seg = clone(p.audioSegmentTemplate);
  const refs = [];
  for (const [kind, tpl] of Object.entries(p.audioExtraTemplates)) {
    const m = clone(tpl);
    m.id = mint(`${kind}:${key}`);
    if ('bind_segment_id' in m) m.bind_segment_id = '';
    arr(doc, kind).push(m);
    refs.push(m.id);
  }
  seg.id = mint(`seg:${key}`);
  seg.material_id = materialId;
  seg.extra_material_refs = refs;
  seg.target_timerange = { start: US(Math.max(0, startS)), duration: US(durationS) };
  seg.source_timerange = { start: 0, duration: US(durationS) };
  seg.volume = volume;
  seg.last_nonzero_volume = volume;
  seg.desc = desc;
  return seg;
}

/** Earliest Follow/CTA start on the talking head, not the parked leftover. */
export function ctaBoundary(doc, projectDir = null) {
  const starts = [];
  for (const t of doc.tracks || []) {
    for (const s of t.segments || []) {
      if ((s.desc || '') === 'sig:endcard' || t.name === 'sig-endcard') {
        starts.push(S(s.target_timerange.start));
      }
    }
  }
  if (starts.length) return Math.min(...starts);
  return S(contentEndUs(doc, projectDir));
}

/**
 * Place (or replace) the generated bed. Picture stays locked. Optional source
 * offset slides the music so detected beats land on picture changes.
 * The bed stops at the CTA (endcard) so the fade lands before he asks for the comment.
 */
export function opMusic(doc, op, context = {}) {
  SEED = op.__seed || null;
  const file = op.file;
  if (!file || !fs.existsSync(file)) {
    throw new CapcutError(`music file missing: ${file || '(none)'}`, { code: 'MUSIC_MISSING', exitCode: 2 });
  }
  const volume = op.volume ?? DEFAULT_MUSIC_VOLUME;
  const fadeIn = op.fadeIn ?? 0.4;
  const fadeOut = op.fadeOut ?? 1.2;
  const srcOffset = Math.max(0, op.srcOffset ?? 0);
  const at = Math.max(0, op.at ?? 0);
  const until = op.until != null ? Number(op.until) : ctaBoundary(doc, context.projectDir);
  const durFile = op.duration ?? probeAudioDuration(file);
  const play = Math.min(Math.max(0.2, until - at), Math.max(0.2, durFile - srcOffset));

  for (const track of doc.tracks) {
    if (track.type !== 'audio') continue;
    track.segments = (track.segments || []).filter(s => (s.desc || '') !== 'finish:music');
  }
  const lane = ensureAudioTrack(doc, 'finish-music');
  lane.segments = (lane.segments || []).filter(s => (s.desc || '') !== 'finish:music');

  const templates = Object.values(sfxPresets().audioTemplates);
  const tpl = templates.find(m => m.type === 'music') || templates[0];
  const material = clone(tpl);
  material.id = mint('audio:finish-music');
  material.type = 'music';
  material.name = 'finish-music';
  material.path = file;
  material.duration = US(durFile);
  material.category_name = 'local';
  material.effect_id = '';
  material.resource_id = '';
  arr(doc, 'audios').push(material);

  const seg = audioSegment(doc, material.id, at, play, 'music:0', volume, 'finish:music');
  if (srcOffset) {
    seg.source_timerange = { start: US(srcOffset), duration: US(play) };
  }
  lane.segments.push(seg);
  lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);

  // Harvested audio_fade extra (same shape clip.fade writes). Applied here because
  // resolveClip refuses flag=0 audio tracks as "the cover".
  const fade = clone({
    type: 'audio_fade', fade_type: 0, fade_in_duration: 0, fade_out_duration: 0,
  });
  fade.id = mint('fade:music');
  fade.fade_in_duration = US(fadeIn);
  fade.fade_out_duration = US(fadeOut);
  arr(doc, 'audio_fades').push(fade);
  seg.extra_material_refs = [...(seg.extra_material_refs || []), fade.id];

  doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
  return {
    changed: 1,
    track: 'finish-music',
    id: seg.id,
    file,
    volume,
    duration: r3(play),
    srcOffset: r3(srcOffset),
    at: r3(at),
    until: r3(until),
    fade: { in: fadeIn, out: fadeOut, id: fade.id },
  };
}

export async function prepareMusic(projectDir, doc, {
  regen = false,
  volume = DEFAULT_MUSIC_VOLUME,
  prompt: override,
  dryRun = false,
} = {}) {
  const hits = pictureChanges(doc);
  const prompt = override || musicPrompt(doc, { hits, projectDir });
  const hash = promptHash(prompt);
  const paths = musicCachePaths(projectDir);
  const prev = readMusicMeta(paths.meta);
  const cached = fs.existsSync(paths.file);
  const stale = !cached || prev.hash !== hash;
  if (dryRun) {
    const usableCache = cached && !stale;
    const beats = usableCache && Array.isArray(prev.beats) ? prev.beats : [];
    const duration = usableCache && Number.isFinite(Number(prev.duration))
      ? Number(prev.duration)
      : S(contentEndUs(doc, projectDir));
    return {
      hash,
      prompt,
      generated: false,
      wouldGenerate: Boolean(regen || stale),
      duration,
      beats,
      hits: hits.map(h => ({ t: h.t, kind: h.kind })),
      align: beatOffset(beats, hits),
      volume,
      file: paths.file,
      model: 'lyria-3-pro-preview',
      dryRun: true,
    };
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  let generated = false;
  if (regen || stale) {
    const buf = await generateLyria({ prompt });
    fs.writeFileSync(paths.file, buf);
    generated = true;
  }
  const duration = probeAudioDuration(paths.file);
  const beats = detectBeats(paths.file);
  const align = beatOffset(beats, hits);
  const meta = {
    hash, prompt, generated, duration, beats: beats.slice(0, 80),
    hits: hits.map(h => ({ t: h.t, kind: h.kind })),
    align, volume, file: paths.file, model: 'lyria-3-pro-preview',
  };
  fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}
