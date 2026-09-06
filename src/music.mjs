import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CapcutError, clone, seededId, requireBinary, contentEndUs, LOCAL_MEDIA_DIR } from './core.mjs';
import { geminiApiKey, loadEnv } from './env.mjs';
import { audioSegment, ensureAudioTrack, pictureChanges, sfxPresets } from './polish.mjs';

const US = s => Math.round(s * 1e6);
const S = us => us / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;
export const DEFAULT_MUSIC_VOLUME = 0.08;
const MUSIC_MODEL = 'lyria-3-pro-preview';
const MUSIC_BRIEF_REQUIRED = 'music needs a video-specific creative brief: pass --prompt TEXT or choose a local track with --file FILE.';

let SEED = null;
const mint = key => seededId(SEED, key);
const arr = (doc, kind) => (doc.materials[kind] ||= []);

function mmss(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(0).padStart(2, '0');
  return `${m}:${r}`;
}

const cleanBrief = value => {
  if (typeof value !== 'string') return null;
  const brief = value.trim();
  return brief || null;
};

/** The old prompt is safe to migrate only when it contains a real creative choice. */
function isGenericMusicPrompt(value) {
  const text = cleanBrief(value)?.toLowerCase() || '';
  const markers = [
    'vertical tech demo',
    'quiet modern electronic / soft pulse',
    'product-demo reel',
  ].filter(marker => text.includes(marker));
  return markers.length >= 2;
}

function timingContext(doc, { duration = null, hits = null, projectDir = null } = {}) {
  const rawDuration = duration == null ? S(contentEndUs(doc, projectDir)) : Number(duration);
  const dur = Number.isFinite(rawDuration) ? rawDuration : S(contentEndUs(doc, projectDir));
  const changes = (hits || pictureChanges(doc)).filter(hit => {
    const t = Number(hit?.t);
    return Number.isFinite(t) && t >= 0 && t < dur;
  }).map(hit => ({
    t: r3(Number(hit.t)),
    kind: hit.kind,
    from: hit.from,
    to: hit.to,
  }));
  const last = changes.at(-1)?.t ?? dur * 0.9;
  return {
    duration: r3(dur),
    hits: changes,
    cta: r3(Math.max(dur * 0.9, last)),
  };
}

function savedBrief(meta) {
  const explicit = meta.promptProvenance === 'explicit'
    || meta.promptSource === 'explicit'
    || meta.briefSource === 'explicit';
  const candidates = [
    ['saved', meta.brief],
    ['saved', meta.creativeBrief],
  ];
  if (meta.mode !== 'local') candidates.push(['legacy', meta.prompt]);
  for (const [source, value] of candidates) {
    const brief = cleanBrief(value);
    if (!brief) continue;
    if (explicit || !isGenericMusicPrompt(brief)) return { brief, source, provenance: 'explicit' };
  }
  return { brief: null, source: 'missing', provenance: 'missing' };
}

function resolveBrief(override, meta) {
  const explicit = cleanBrief(override);
  if (explicit) return { brief: explicit, source: 'explicit', provenance: 'explicit' };
  return savedBrief(meta);
}

/** Timed prompt: the caller supplies taste; this function supplies picture/voice constraints. */
export function musicPrompt(doc, {
  duration = null,
  hits = null,
  projectDir = null,
  brief = null,
  timing = null,
} = {}) {
  const context = timing || timingContext(doc, { duration, hits, projectDir });
  const dur = context.duration;
  const changes = context.hits;
  const creative = cleanBrief(brief)
    || (projectDir ? savedBrief(readMusicMeta(musicCachePaths(projectDir).meta)).brief : null);
  const lines = [
    creative
      ? `Creative brief:\n${creative}`
      : 'Creative brief required: pass --prompt TEXT or choose a local track with --file FILE.',
    `Create a ${dur.toFixed(1)}-second instrumental-only background bed for this video.`,
    `Use the creative brief for genre, instrumentation, energy, and emotional direction.`,
    `No vocals, no lyrics, no sung words, no drops, no riser that overpowers speech.`,
    `Keep it quiet under the spoken voiceover and leave the CTA clear.`,
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
  lines.push(`[${mmss(context.cta)} - ${mmss(dur)}] Fade to silence for the CTA. No beat after ${mmss(context.cta)}.`);
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

/**
 * Follow/CTA start on the talking head, not the parked leftover.
 * wrap places the card at 93–98% of contentEnd. A mid-timeline overlay that
 * reused `sig:endcard` (a URL, a wrap misfire) must not kill the bed.
 */
export function ctaBoundary(doc, projectDir = null) {
  const end = S(contentEndUs(doc, projectDir));
  const starts = [];
  for (const t of doc.tracks || []) {
    for (const s of t.segments || []) {
      if ((s.desc || '') === 'sig:endcard' || t.name === 'sig-endcard') {
        starts.push(S(s.target_timerange.start));
      }
    }
  }
  if (!starts.length) return end;
  const nearEnd = starts.filter(t => t >= end * 0.9);
  return Math.min(...(nearEnd.length ? nearEnd : starts));
}

/** Copy the bed into the draft under a content-hash name CapCut cannot remap. */
function placeMusicFile(projectDir, source, { dryRun = false } = {}) {
  source = path.resolve(source);
  if (!projectDir) return source;
  const stamp = crypto.createHash('sha1').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
  const dest = path.join(projectDir, LOCAL_MEDIA_DIR, `finish-music-${stamp}${path.extname(source) || '.mp3'}`);
  if (path.resolve(source) === path.resolve(dest)) return dest;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }
  return dest;
}

/** Library identity left on a cloned template makes CapCut swap our file for Hyperpop. */
function detachLibraryIdentity(material) {
  material.effect_id = '';
  material.resource_id = '';
  material.music_id = '';
  material.pgc_id = '';
  material.pgc_name = '';
  material.unique_id = '';
  material.local_material_id = '';
  material.third_resource_id = '';
  material.formula_id = '';
  material.query = '';
  material.search_id = '';
  material.music_source = '';
  material.category_name = 'local';
  material.app_id = 0;
  return material;
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
  const lane = ensureAudioTrack(doc, 'finish-music', mint);
  lane.segments = (lane.segments || []).filter(s => (s.desc || '') !== 'finish:music');
  doc.materials.audios = (doc.materials.audios || []).filter(a => a.name !== 'finish-music');

  const placed = placeMusicFile(context.projectDir, file, { dryRun: context.dryRun });
  const templates = Object.values(sfxPresets().audioTemplates);
  const tpl = templates.find(m => m.type === 'music') || templates[0];
  const material = detachLibraryIdentity(clone(tpl));
  material.id = mint('audio:finish-music');
  material.type = 'music';
  material.name = 'finish-music';
  material.path = placed;
  material.duration = US(durFile);
  arr(doc, 'audios').push(material);

  const seg = audioSegment(doc, material.id, at, play, 'music:0', volume, 'finish:music', mint);
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

function buildMusicState(projectDir, doc, {
  regen = false,
  volume = DEFAULT_MUSIC_VOLUME,
  prompt: override,
  file: selectedFile = null,
} = {}) {
  const paths = musicCachePaths(projectDir);
  if (selectedFile && (cleanBrief(override) || regen)) {
    throw new CapcutError('Choose --file or generation flags (--prompt/--regen), not both.', { code: 'MUSIC_OPTIONS', exitCode: 2 });
  }
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new CapcutError('Music volume must be between 0 and 1.', { code: 'BAD_VOLUME', exitCode: 2 });
  }
  const prev = readMusicMeta(paths.meta);
  const timing = timingContext(doc, { projectDir });
  const resolved = resolveBrief(override, prev);
  const generationRequested = Boolean(cleanBrief(override) || regen);
  const savedLocal = !generationRequested && prev.mode === 'local' ? cleanBrief(prev.file) : null;
  const selectedValue = !generationRequested && (cleanBrief(selectedFile) || savedLocal);
  const selected = selectedValue ? path.resolve(selectedValue) : null;
  if (selected && !fs.existsSync(selected)) {
    throw new CapcutError(`music file missing: ${selected}`, { code: 'MUSIC_MISSING', exitCode: 2 });
  }
  const prompt = musicPrompt(doc, { projectDir, timing, brief: resolved.brief });
  const briefHash = resolved.brief ? promptHash(resolved.brief) : null;
  const timingHash = promptHash(JSON.stringify(timing));
  const hash = resolved.brief ? promptHash(`${briefHash}:${timingHash}`) : null;
  const cached = fs.existsSync(paths.file);
  const stale = !selected && Boolean(resolved.brief)
    && (!cached || prev.mode !== 'generated' || prev.briefHash !== briefHash || prev.timingHash !== timingHash);
  const needsBrief = !selected && !resolved.brief;
  return {
    paths,
    prev,
    selected,
    file: selected || paths.file,
    mode: selected ? 'local' : 'generated',
    timing,
    hits: timing.hits,
    brief: resolved.brief,
    briefHash,
    briefSource: resolved.source,
    promptSource: resolved.source,
    promptProvenance: resolved.provenance,
    prompt,
    timingHash,
    hash,
    cached,
    stale,
    needsBrief,
    wouldGenerate: !selected && Boolean(resolved.brief && (regen || stale)),
    volume,
  };
}

export async function prepareMusic(projectDir, doc, {
  regen = false,
  volume = DEFAULT_MUSIC_VOLUME,
  prompt: override,
  file: selectedFile = null,
  dryRun = false,
  generate = generateLyria,
  probe = probeAudioDuration,
  detect = detectBeats,
} = {}) {
  const state = buildMusicState(projectDir, doc, {
    regen, volume, prompt: override, file: selectedFile,
  });
  const base = {
    hash: state.hash,
    prompt: state.prompt,
    brief: state.brief,
    briefHash: state.briefHash,
    briefSource: state.briefSource,
    promptSource: state.promptSource,
    promptProvenance: state.promptProvenance,
    timing: state.timing,
    timingHash: state.timingHash,
    hits: state.hits,
    volume: state.volume,
    file: state.file,
    mode: state.mode,
    model: MUSIC_MODEL,
    cached: state.cached,
    stale: state.stale,
    needsBrief: state.needsBrief,
    error: state.needsBrief ? MUSIC_BRIEF_REQUIRED : null,
  };

  if (state.needsBrief) {
    if (!dryRun) {
      throw new CapcutError(MUSIC_BRIEF_REQUIRED, {
        code: 'MUSIC_BRIEF_REQUIRED',
        exitCode: 2,
        details: { action: 'provide-brief', ...base },
      });
    }
    return {
      ...base,
      generated: false,
      wouldGenerate: false,
      duration: state.timing.duration,
      beats: [],
      align: beatOffset([], state.hits),
      dryRun: true,
    };
  }

  if (state.selected) {
    if (dryRun) {
      return {
        ...base,
        local: true,
        generated: false,
        wouldGenerate: false,
        duration: null,
        beats: [],
        align: beatOffset([], state.hits),
        dryRun: true,
      };
    }
    const duration = probe(state.selected);
    const beats = detect(state.selected);
    const meta = {
      version: 2,
      ...base,
      mode: 'local',
      local: true,
      generated: false,
      wouldGenerate: false,
      duration,
      beats,
      align: beatOffset(beats, state.hits),
      dryRun: false,
    };
    fs.mkdirSync(state.paths.dir, { recursive: true });
    fs.writeFileSync(state.paths.meta, JSON.stringify(meta, null, 2) + '\n');
    return meta;
  }

  if (dryRun) {
    const usableCache = state.cached && !state.stale;
    const beats = usableCache && Array.isArray(state.prev.beats) ? state.prev.beats : [];
    const duration = usableCache && Number.isFinite(Number(state.prev.duration))
      ? Number(state.prev.duration)
      : state.timing.duration;
    return {
      ...base,
      generated: false,
      wouldGenerate: state.wouldGenerate,
      duration,
      beats,
      align: beatOffset(beats, state.hits),
      dryRun: true,
    };
  }

  const { paths } = state;
  fs.mkdirSync(paths.dir, { recursive: true });
  let generated = false;
  if (state.wouldGenerate) {
    const buf = await generate({ prompt: state.prompt, model: MUSIC_MODEL });
    fs.writeFileSync(paths.file, buf);
    generated = true;
  }
  const duration = probe(paths.file);
  const beats = detect(paths.file);
  const align = beatOffset(beats, state.hits);
  const meta = {
    version: 2,
    ...base,
    generated,
    wouldGenerate: state.wouldGenerate,
    duration,
    beats: beats.slice(0, 80),
    align,
    file: paths.file,
    model: MUSIC_MODEL,
    dryRun: false,
  };
  fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}
