import { CapcutError, clone, loadPreset, resolveMediaPath, seededId, contentEndUs } from './core.mjs';
import { principalTrack } from './polish.mjs';
import { classifyLoudnessRole, isMusicSegment } from './loudness.mjs';
import { loadEnergy10, loadTranscript } from './stress.mjs';

const US = s => Math.round(s * 1e6);
const HOLD = 0.125;
// Same soft-speech floor as tools/audio_index.py. Not a voice classifier.
const SPEECH_DB = -45;
const fail = (message, code = 'BAD_DUCK') => { throw new CapcutError(message, { code, exitCode: 2 }); };

function settings(op) {
  const result = {};
  for (const [key, fallback, max] of [['underDb', 12, 60], ['attackMs', 120, 10000],
    ['releaseMs', 380, 10000], ['minGapMs', 450, 60000]]) {
    const n = Number(op[key] ?? fallback);
    if (!Number.isFinite(n) || n <= 0 || n > max) fail(`${key} must be greater than 0 and at most ${max}.`);
    result[key] = n;
  }
  return { ...result, holdMs: HOLD * 1000, speechThresholdDb: SPEECH_DB };
}

function sourceRegions(mediaPath, op) {
  const energy = loadEnergy10(mediaPath, op);
  if (energy) {
    const bin = Number(energy.bin ?? 0.01);
    if (!(bin > 0) || !Number.isFinite(bin) || !energy.db.every(Number.isFinite)) fail('Invalid energy10 index.');
    const spans = [];
    for (let i = 0; i < energy.db.length; i++) {
      if (energy.db[i] < SPEECH_DB) continue;
      const start = i * bin, end = (i + 1) * bin;
      if (spans.length && Math.abs(spans.at(-1).end - start) < 1e-8) spans.at(-1).end = end;
      else spans.push({ start, end });
    }
    return { source: 'energy10', spans };
  }
  const transcript = loadTranscript(mediaPath, op);
  if (!transcript) fail('music --duck needs a speech index. Run cut first or pass --words FILE.', 'DUCK_NO_SPEECH_INDEX');
  const rows = Array.isArray(transcript) ? transcript : transcript.segments || [];
  const spans = rows.flatMap(row => row.words?.length ? row.words : [row])
    .map(({ start, end }) => ({ start: Number(start), end: Number(end) }));
  if (!spans.length || spans.some(s => !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start)) {
    fail('music --duck needs valid source-time speech intervals.', 'DUCK_NO_SPEECH_INDEX');
  }
  return { source: 'transcript', spans };
}

function validateRange(segment) {
  const a = segment.source_timerange, b = segment.target_timerange;
  if (!a || !b || ![a.start, a.duration, b.start, b.duration].every(Number.isSafeInteger)
      || a.start < 0 || b.start < 0 || a.duration <= 0 || b.duration <= 0) {
    fail(`Invalid source/timeline range on ${segment.id}.`);
  }
}

function assertConstantSpeed(doc, segment) {
  if (segment.reverse || (doc.materials?.speeds || []).some(m =>
    (segment.extra_material_refs || []).includes(m.id) && m.curve_speed)) {
    fail('music --duck requires forward, constant-speed clips.', 'DUCK_SPEED_UNSUPPORTED');
  }
}

/** Map intersections per clip, so trims, repeats, multiple takes and speed all survive. */
function speechRegions(doc, op, context, opts) {
  const { track } = principalTrack(doc, op.track ?? null);
  const materials = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const clips = (track.segments || []).filter(s => s.volume !== 0
    && classifyLoudnessRole(track, s, materials.get(s.material_id)) === 'speech');
  if (new Set(clips.map(s => s.material_id)).size > 1 && (op.energy || op.transcript || op.words || op.wordsFile)) {
    fail('An explicit speech index needs a single source take; use per-source cut caches for multiple takes.');
  }
  const cache = new Map(), intervals = [], sources = [];
  const contentEnd = contentEndUs(doc, context.projectDir) / 1e6;
  for (const segment of clips) {
    validateRange(segment);
    assertConstantSpeed(doc, segment);
    const media = materials.get(segment.material_id);
    if (!cache.has(segment.material_id)) {
      const file = resolveMediaPath(media?.path, context.projectDir) || media?.path;
      cache.set(segment.material_id, sourceRegions(file, op));
      sources.push({ material: segment.material_id, source: cache.get(segment.material_id).source });
    }
    const st = segment.source_timerange, tt = segment.target_timerange;
    const speed = st.duration / tt.duration;
    for (const span of cache.get(segment.material_id).spans) {
      const lo = Math.max(span.start, st.start / 1e6);
      const hi = Math.min(span.end, (st.start + st.duration) / 1e6);
      const start = tt.start / 1e6 + (lo - st.start / 1e6) / speed;
      const end = Math.min(contentEnd, tt.start / 1e6 + (hi - st.start / 1e6) / speed);
      if (hi > lo && end > start) intervals.push({ start, end });
    }
  }
  const regions = [], mergedGaps = [];
  for (const span of intervals.sort((a, b) => a.start - b.start)) {
    const previous = regions.at(-1);
    const gap = previous ? span.start - previous.end : Infinity;
    if (previous && US(gap) < US(Math.max(opts.minGapMs / 1000, HOLD))) {
      if (gap > 1e-9) mergedGaps.push({ start: previous.end, end: span.start, duration: gap });
      previous.end = Math.max(previous.end, span.end);
    } else regions.push({ ...span });
  }
  return { regions, mergedGaps, sources };
}

/** Linear attack/release, with partial recovery when a pause cannot fit a full release. */
function envelope(regions, base, opts) {
  const low = base * 10 ** (-opts.underDb / 20);
  const attack = opts.attackMs / 1000, release = opts.releaseMs / 1000;
  const points = [[regions[0].start - attack, base]];
  for (const [i, region] of regions.entries()) {
    points.push([region.start, low], [region.end + HOLD, low]);
    const next = regions[i + 1];
    const recoveryAt = Math.min(region.end + HOLD + release, next ? next.start - attack : Infinity);
    // A hold can meet the next attack: keep the bed down until the next sentence.
    const end = Math.max(region.end + HOLD, recoveryAt);
    const recovered = low + (base - low) * Math.min(1, (end - region.end - HOLD) / release);
    points.push([end, recovered]);
    if (next && next.start - attack > end) points.push([next.start - attack, recovered]);
  }
  return points;
}

function gainAt(points, time) {
  if (time <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [a, av] = points[i - 1], [b, bv] = points[i];
    if (time <= b) return b === a ? bv : av + (bv - av) * (time - a) / (b - a);
  }
  return points.at(-1)[1];
}

export function planDuckMusic(doc, op = {}, context = {}) {
  const opts = settings(op);
  const materials = new Map((doc.materials?.audios || []).map(m => [m.id, m]));
  const music = (doc.tracks || []).flatMap(t => t.type === 'audio'
    ? (t.segments || []).filter(s => isMusicSegment(t, s, materials.get(s.material_id))) : []);
  if (!music.length) fail('music --duck needs an existing music bed.', 'DUCK_NO_MUSIC');
  for (const segment of music) {
    validateRange(segment);
    assertConstantSpeed(doc, segment);
    if ((segment.common_keyframes || []).some(b => b.property_type === 'KFTypeVolume')) {
      fail('The music already has volume automation. Keep it, or remove it in CapCut before ducking.', 'DUCK_EXISTING_AUTOMATION');
    }
    if (!Number.isFinite(segment.volume ?? 1) || (segment.volume ?? 1) < 0 || (segment.volume ?? 1) > 1) {
      fail('music --duck requires a reviewed music gain between 0 and 1.');
    }
  }
  const speech = speechRegions(doc, op, context, opts);
  const segments = music.map(segment => {
    const base = segment.volume ?? 1;
    const tt = segment.target_timerange, st = segment.source_timerange;
    const start = tt.start / 1e6, end = (tt.start + tt.duration) / 1e6;
    const row = { id: segment.id, beforeGain: base, underGain: Math.fround(base * 10 ** (-opts.underDb / 20)), keys: [] };
    if (!base || !speech.regions.some(r => r.start - opts.attackMs / 1000 < end && r.end + HOLD + opts.releaseMs / 1000 > start)) return row;
    const points = envelope(speech.regions, base, opts);
    const times = [start, ...points.map(p => p[0]).filter(t => t > start && t < end), end];
    // Source microseconds, including trims and speed; one key per rounded instant.
    row.keys = [...new Map(times.map(t => {
      const time = st.start + Math.round((US(t) - tt.start) * st.duration / tt.duration);
      return [time, { time_offset: time, value: Math.fround(gainAt(points, t)) }];
    })).values()];
    return row;
  });
  return { ...opts, ...speech, segments, changed: segments.filter(s => s.keys.length).length };
}

export function opDuckMusic(doc, op = {}, context = {}) {
  const plan = planDuckMusic(doc, op, context);
  if (op.plan || !plan.changed) return plan;
  const template = op.keyframeTemplate || loadPreset('volume-keyframes').block;
  if (template?.property_type !== 'KFTypeVolume' || !template.keyframe_list?.length) fail('Missing harvested volume keyframe template.');
  const rows = new Map(plan.segments.filter(s => s.keys.length).map(s => [s.id, s]));
  const fades = JSON.stringify(doc.materials?.audio_fades);
  for (const track of doc.tracks) for (const segment of track.segments || []) {
    const row = rows.get(segment.id);
    if (!row) continue;
    const block = clone(template);
    block.id = seededId(op.__seed, `duck:${segment.id}`);
    block.keyframe_list = row.keys.map(({ time_offset, value }) => ({
      ...clone(template.keyframe_list[0]), id: seededId(op.__seed, `duck:${segment.id}:${time_offset}`),
      time_offset, values: [value],
    }));
    segment.common_keyframes = [...(segment.common_keyframes || []), block];
  }
  if (JSON.stringify(doc.materials?.audio_fades) !== fades) fail('Ducking changed clip fades.');
  return plan;
}
