/**
 * Colour grading — the Adjust panel, written as CapCut writes it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other pass in this tool shapes *time* and *geometry*. Nothing shaped tone, so a
 * project could be perfectly cut and still look like three unrelated videos stacked on one
 * canvas: a warm flat webcam under a dim grey IDE next to a neon-saturated game capture.
 * That mismatch is invisible in `doctor` (the structure is fine) and invisible in `qa`
 * (the picture is *correct*, it is just ugly), and it is the loudest remaining "not
 * premium" tell after pace.
 *
 * WHAT IS HARVESTED AND WHAT IS MODELLED
 * --------------------------------------
 * The JSON is harvested, not invented: `presets/adjust.json` is a real `effects` material
 * lifted out of draft 0411, where CapCut's own Adjust panel wrote it. One material per
 * slider, `value` in -1..+1 (the UI's -100..+100), referenced from the segment's
 * `extra_material_refs`. The per-type `version` strings are the ones CapCut uses, measured
 * consistently across every draft on disk (brightness v2, contrast v3, saturation v1, …).
 *
 * The *forward model* in `applyAdjust` below is CapCut's own fragment shader, read out of
 * the effect cache at
 *   Cache/effect/7501974767453474064/<hash>/AmazingFeature_adjustColor/xshader/colorAdjust.frag
 * and transcribed. It is used for the preview and for solving slider values against a
 * measured target; it never touches the media that goes into the project.
 *
 * Four of the mappings fall straight out of that shader, because the shader tells you
 * where the identity is:
 *   saturation  u = 1 + v      (u=1 is the identity matrix, u=0 is monochrome)
 *   highlight   p = 1 - v/2    (p=1 makes adjustHighlight the identity)
 *   shadow      p = 1 - v/2    (p=1 makes adjustShadow the identity)
 *   brightness  raw v          (the shader derives its own exponent from the slider)
 * The remaining three — contrast, the black/white affine, and the temperature/tint matrix —
 * are computed CPU-side inside CapCut, so their *scale* is a calibrated constant here
 * (CONTRAST_GAIN, BLACK_REACH, WHITE_REACH, TEMP_REACH). Direction and identity are certain;
 * magnitude is a good-faith fit. Preview and CapCut may differ by that factor, so treat the
 * first render as a calibration pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CapcutError, clone, uuid, allSegments, loadPreset, resolveMediaPath } from './core.mjs';
import { principalTrack } from './polish.mjs';

export { resolveMediaPath };

let SEED = null;
function mint(key) {
  if (!SEED) return uuid();
  const h = crypto.createHash('sha256').update(`${SEED}|${key}`).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/* ------------------------------------------------------------------ *
 * 1. The shader, transcribed.  All channels in 0..1.
 * ------------------------------------------------------------------ */

const LUMA = [0.208540, 0.702086, 0.089374];   // SaturationLuminanceFactor, from the shader
const REC709 = [0.2126, 0.7152, 0.0722];       // for measurement only

// Calibrated magnitudes — see the header note. Identity at v=0 in every case.
const CONTRAST_GAIN = 2.0;   // v>0 -> sigmoid xFactor; v<0 -> linear scale toward flat
const BLACK_REACH   = 0.20;  // black slider -1 lifts the input black point to 0.20
const WHITE_REACH   = 0.30;  // white slider +1 pulls the input white point down to 0.70
const TEMP_REACH    = 0.22;  // temperature +-1 shifts R/B by this fraction of luma
const TINT_REACH    = 0.18;

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

function sigmoid(x, k, pivot) { return 1 / (1 + Math.exp(-k * (x - pivot))) + pivot - 0.5; }

/**
 * One pixel through the Adjust chain, in the shader's own order:
 * brightness -> contrast -> saturation -> highlight -> shadow -> black/white -> temp/tint.
 * `g` is a slider map, e.g. { brightness: 0.05, white: 0.2, temperature: -0.1 }.
 */
export function applyAdjust(rgb, g) {
  let [r, gg, b] = rgb;

  if (g.brightness) {
    const v = g.brightness;
    let p;
    if (v > 0) p = 1 + v * 5;
    else { p = 1 / (1 - v * 2.5); const off = -v * 0.01; r -= off; gg -= off; b -= off; }
    r = clamp01(1 - Math.pow(Math.max(0, 1 - r), p));
    gg = clamp01(1 - Math.pow(Math.max(0, 1 - gg), p));
    b = clamp01(1 - Math.pow(Math.max(0, 1 - b), p));
  }

  if (g.contrast) {
    const v = g.contrast;
    const pivot = 0.5;
    if (v <= 0) {                       // linear pull toward the pivot
      const s = 1 + v;
      r = clamp01(s * (r - pivot) + pivot);
      gg = clamp01(s * (gg - pivot) + pivot);
      b = clamp01(s * (b - pivot) + pivot);
    } else {                            // the shader's sigmoid, renormalised through 0 and 1
      const k = 4 + v * CONTRAST_GAIN * 4;
      const lo = sigmoid(0, k, pivot), hi = sigmoid(1, k, pivot);
      const f = x => clamp01((sigmoid(x, k, pivot) - lo) / (hi - lo));
      r = f(r); gg = f(gg); b = f(b);
    }
  }

  if (g.saturation) {
    const u = 1 + g.saturation;                       // u=1 identity, u=0 monochrome
    const base = LUMA.map(l => l * (1 - u));
    const dot = (v0, v1, v2) => r * v0 + gg * v1 + b * v2;
    const nr = dot(base[0] + u, base[1], base[2]);
    const ng = dot(base[0], base[1] + u, base[2]);
    const nb = dot(base[0], base[1], base[2] + u);
    r = clamp01(nr); gg = clamp01(ng); b = clamp01(nb);
  }

  if (g.highlight) {
    const p = 1 - g.highlight * 0.5;                  // p=1 identity
    const f = c => { const t = 1 - c; return clamp01(1 - Math.pow(t, p) - (p - 1) * (t * t - t * t * t)); };
    r = f(r); gg = f(gg); b = f(b);
  }

  if (g.shadow) {
    const p = 1 - g.shadow * 0.5;                     // p=1 identity
    const f = c => clamp01(Math.pow(c, p) + (p - 1) * (c * c - c * c * c));
    r = f(r); gg = f(gg); b = f(b);
  }

  if (g.black || g.white) {
    const lo = -(g.black || 0) * BLACK_REACH;         // black<0 raises the input black point
    const hi = 1 - (g.white || 0) * WHITE_REACH;      // white>0 lowers the input white point
    const slope = 1 / Math.max(1e-3, hi - lo);
    const bias = -lo * slope;
    r = clamp01(slope * r + bias); gg = clamp01(slope * gg + bias); b = clamp01(slope * b + bias);
  }

  if (g.temperature || g.tone) {
    // CapCut multiplies by a full 3x3 (u_temperatureTint*Vec3). The dominant behaviour of any
    // white-balance matrix is a per-channel gain, and that is what is modelled here: warm (+)
    // gains red and loses blue, tint (+) goes magenta by gaining red and blue and losing
    // green. Cross terms are dropped — they matter for extreme values, and this pass does not
    // make extreme values. A luma correction goes back on afterwards so a white-balance move
    // cannot quietly double as an exposure move; that separation is the whole reason the
    // solver can trust one axis at a time.
    const t = (g.temperature || 0) * TEMP_REACH;
    const n = (g.tone || 0) * TINT_REACH;
    const y0 = REC709[0] * r + REC709[1] * gg + REC709[2] * b;
    let nr = r * (1 + t) * (1 + n * 0.5);
    let ng = gg * (1 - n);
    let nb = b * (1 - t) * (1 + n * 0.5);
    const y1 = REC709[0] * nr + REC709[1] * ng + REC709[2] * nb;
    if (y1 > 1e-4) { const k = y0 / y1; nr *= k; ng *= k; nb *= k; }
    r = clamp01(nr); gg = clamp01(ng); b = clamp01(nb);
  }

  return [r, gg, b];
}

/** A 33-step-per-axis LUT is overkill; grade whole frames through a per-channel path. */
export function gradeBuffer(buf, g) {
  const out = Buffer.allocUnsafe(buf.length);
  const cache = new Map();
  for (let i = 0; i < buf.length; i += 3) {
    const key = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
    let v = cache.get(key);
    if (v === undefined) {
      const [r, gg, b] = applyAdjust([buf[i] / 255, buf[i + 1] / 255, buf[i + 2] / 255], g);
      v = [Math.round(r * 255), Math.round(gg * 255), Math.round(b * 255)];
      if (cache.size < 400000) cache.set(key, v);
    }
    out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. Measurement — scopes, as numbers.
 * ------------------------------------------------------------------ */

export function scope(buf) {
  const n = buf.length / 3;
  const Y = new Float32Array(n);
  let sr = 0, sg = 0, sb = 0, ssat = 0;
  for (let i = 0, j = 0; i < buf.length; i += 3, j++) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    Y[j] = REC709[0] * r + REC709[1] * g + REC709[2] * b;
    sr += r; sg += g; sb += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    ssat += mx > 0 ? (mx - mn) / mx : 0;
  }
  const sorted = Float32Array.from(Y).sort();
  const pct = p => sorted[Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))))];
  // white balance is read off the lit part of the frame, not the whole thing
  const cut = pct(60);
  let hr = 0, hg = 0, hb = 0, hn = 0;
  for (let i = 0, j = 0; i < buf.length; i += 3, j++) {
    if (Y[j] > cut) { hr += buf[i]; hg += buf[i + 1]; hb += buf[i + 2]; hn++; }
  }
  hn = Math.max(1, hn);
  return {
    black: +pct(1).toFixed(1),
    shadow: +pct(5).toFixed(1),
    mid: +pct(50).toFixed(1),
    highlight: +pct(95).toFixed(1),
    white: +pct(99).toFixed(1),
    range: +(pct(99) - pct(1)).toFixed(1),
    contrast: +(pct(95) - pct(5)).toFixed(1),
    saturation: +((ssat / n) * 100).toFixed(1),
    warmth: +((hr - hb) / hn).toFixed(1),      // R-B on the lit 40% — the white-balance tell
    tint: +((hg / hn) - (hr + hb) / (2 * hn)).toFixed(1),  // G vs R/B — green(+) / magenta(-)
    crushed: +((sorted.reduce((a, v) => a + (v < 2 ? 1 : 0), 0) / n) * 100).toFixed(2),
    clipped: +((sorted.reduce((a, v) => a + (v > 253 ? 1 : 0), 0) / n) * 100).toFixed(2),
  };
}

function probeSize(file) {
  const out = execFileSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8' });
  const s = JSON.parse(out).streams[0];
  return { width: Number(s.width), height: Number(s.height) };
}

export function grabFrame(file, atSeconds, width = 320) {
  const { width: w, height: h } = probeSize(file);
  const th = Math.max(2, Math.round((h * width) / w / 2) * 2);
  const raw = execFileSync('ffmpeg', ['-v', 'quiet', '-ss', String(atSeconds), '-i', file,
    '-frames:v', '1', '-vf', `scale=${width}:${th}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 28 });
  if (raw.length < width * th * 3) return null;
  return { buf: raw.subarray(0, width * th * 3), width, height: th };
}

function mergeScopes(list) {
  const keys = Object.keys(list[0]);
  const out = {};
  for (const k of keys) out[k] = +(list.reduce((a, s) => a + s[k], 0) / list.length).toFixed(1);
  return out;
}

/**
 * Group the timeline by *source file* and measure each one where it is actually used.
 * A source is graded as a unit: two clips off the same recording must not drift apart.
 */
export function measureSources(doc, projectDir, { samples = 4 } = {}) {
  const videos = Object.fromEntries((doc.materials?.videos || []).map(m => [m.id, m]));
  const bySource = new Map();
  for (const { segment, track, trackIndex } of allSegments(doc)) {
    const mat = videos[segment.material_id];
    if (!mat || mat.type !== 'video') continue;                 // photos/plates carry no grade
    const file = resolveMediaPath(mat.path, projectDir);
    if (!file || !fs.existsSync(file)) continue;
    const key = path.basename(file);
    if (!bySource.has(key)) bySource.set(key, { source: key, file, clips: [], tracks: new Set() });
    const e = bySource.get(key);
    e.tracks.add(track.name || `track ${trackIndex}`);
    e.clips.push({
      id: segment.id,
      at: segment.target_timerange.start / 1e6,
      dur: segment.target_timerange.duration / 1e6,
      srcIn: segment.source_timerange.start / 1e6,
      srcDur: segment.source_timerange.duration / 1e6,
      desc: segment.desc || '',
    });
  }
  const rows = [];
  for (const e of bySource.values()) {
    e.clips.sort((a, b) => a.at - b.at);
    const picks = [];
    const total = e.clips.reduce((a, c) => a + c.srcDur, 0);
    let want = Math.min(samples, e.clips.length * 2);
    for (let i = 0; i < want; i++) {
      const target = (total * (i + 0.5)) / want;
      let acc = 0;
      for (const c of e.clips) {
        if (acc + c.srcDur >= target) { picks.push(c.srcIn + (target - acc)); break; }
        acc += c.srcDur;
      }
    }
    const scopes = [];
    for (const t of picks) {
      const f = grabFrame(e.file, t);
      if (f) scopes.push(scope(f.buf));
    }
    if (!scopes.length) continue;
    rows.push({
      source: e.source,
      file: e.file,
      tracks: [...e.tracks],
      clips: e.clips.length,
      screenSeconds: +e.clips.reduce((a, c) => a + c.dur, 0).toFixed(2),
      sampledAt: picks.map(t => +t.toFixed(1)),
      scope: mergeScopes(scopes),
      spread: scopes.length > 1 ? {
        warmth: +(Math.max(...scopes.map(s => s.warmth)) - Math.min(...scopes.map(s => s.warmth))).toFixed(1),
        mid: +(Math.max(...scopes.map(s => s.mid)) - Math.min(...scopes.map(s => s.mid))).toFixed(1),
      } : null,
    });
  }
  return rows.sort((a, b) => b.screenSeconds - a.screenSeconds);
}

/* ------------------------------------------------------------------ *
 * 3. The plan — solve sliders against a target, do not eyeball them.
 * ------------------------------------------------------------------ */

/**
 * One house target, so every source lands in the same place. These are the numbers a
 * colourist would call "normal" and they are the whole point of the pass: not "warmer",
 * but "black point 4, white point 240, and every source within 8 points of the same
 * white balance".
 */
export const TARGET = {
  black: 4,          // 1st percentile luma — a real black, not a lifted grey
  white: 240,        // 99th percentile — near full range without clipping
  saturation: 34,    // mean HSV saturation, %
  warmth: 16,        // R-B on the lit part: warm enough to read as skin, not orange
  tint: 0,           // G vs R/B: neutral
  maxClipped: 0.5,   // % of pixels at 255 — a hard ceiling, blown highlights never come back
};

/**
 * Two roles, because one target would be wrong for half the timeline.
 *
 * The talking head is a *face*: it has a correct answer. Skin wants a real black under it,
 * near-full whites above it and a warm-but-not-orange cast, and the whole video is graded to
 * that because it is the thing the eye checks.
 *
 * A screen recording is *not* a face. Its colours are the app's, and pushing a dark IDE to
 * "warm skin" would be vandalism. So it gets the range half of the treatment only — set the
 * black, reach the white, which is what makes small UI text legible — plus a saturation
 * ceiling so one neon capture cannot shout over the rest, and a white balance target taken
 * from the other screen sources rather than from skin, so shots stop fighting each other.
 */
export const ROLE_TARGETS = {
  // 26%, not 34%: `saturation` here is the mean over the WHOLE frame, and a talking head is
  // mostly grey wall, white shirt and hair. 34% is what a frame full of colour reads; asking
  // a room for it would mean over-saturating the one thing in it that has to look right.
  face: { ...TARGET, saturation: 26 },
  screen: { black: 2, white: 245, saturation: 38, warmth: null, tint: null, maxClipped: 0.4 },
};

export const ROLE_WEIGHTS = {
  face:   { black: 1.4, white: 1.0, saturation: 0.7, warmth: 0.9, clipped: 12.0 },
  // Range is the whole point on a screen grab; colour is the app's business, so warmth is
  // a nudge (0.25) toward the group, never a correction toward skin.
  screen: { black: 1.2, white: 1.6, saturation: 0.5, warmth: 0.25, clipped: 14.0 },
};

/** Re-measure a frame after a candidate grade, without touching disk. */
function predict(buf, g) { return scope(gradeBuffer(buf, g)); }

/**
 * Coordinate descent over the sliders that matter, scored against TARGET. Small, bounded,
 * and deterministic — the point is a defensible starting grade, not an optimiser.
 */
export function solveGrade(buf, target = TARGET, opts = {}) {
  const bounds = {
    black: [-0.6, 0.3], white: [-0.3, 0.6], contrast: [-0.3, 0.5],
    saturation: [-0.5, 0.5], temperature: [-0.5, 0.5], brightness: [-0.3, 0.3],
    shadow: [-0.4, 0.4], highlight: [-0.4, 0.4],
    ...(opts.bounds || {}),
  };
  // Temperature is solved BEFORE saturation. Both move R-B, and with saturation first the
  // solver would happily fix a warm cast by draining the colour out of a face — cheaper by
  // the cost function, wrong by every other measure.
  const order = opts.order || ['black', 'white', 'brightness', 'contrast', 'temperature', 'saturation', 'shadow', 'highlight'];
  // Prefer doing nothing. Without this the solver spends a 0.4 slider to chase the last two
  // points of a target on a source that was already fine — most visible on short clips,
  // where a big correction buys almost no screen time and costs continuity.
  const lambda = opts.lambda ?? 0.5;
  const w = { black: 1.4, white: 1.0, saturation: 0.7, warmth: 0.5, clipped: 6.0, ...(opts.weights || {}) };

  // A null target means "this source has no correct value for that axis" — a screen
  // recording has no skin to white-balance against — so the axis drops out of the cost
  // rather than being forced somewhere arbitrary.
  const cost = s => {
    let c = 0;
    const term = (key, span, weight) => {
      if (target[key] == null) return;
      c += weight * Math.pow((s[key] - target[key]) / span, 2);
    };
    term('black', 20, w.black);
    term('white', 20, w.white);
    // Saturation is a ceiling, not a setpoint: pulling a muted app UI *up* to 38% would be
    // inventing colour that is not in the recording.
    if (target.saturation != null) {
      const over = s.saturation - target.saturation;
      if (opts.saturationIsCeiling ? over > 0 : true) c += w.saturation * Math.pow(over / 12, 2);
    }
    term('warmth', 14, w.warmth);
    if (s.clipped > target.maxClipped) c += w.clipped * Math.pow(s.clipped - target.maxClipped, 2);
    if (s.crushed > 0.5) c += w.clipped * Math.pow(s.crushed - 0.5, 2);
    return c;
  };
  const penalty = g => lambda * Object.values(g).reduce((a, v) => a + v * v, 0);

  const g = Object.fromEntries(order.map(k => [k, 0]));
  let best = cost(predict(buf, g)) + penalty(g);
  for (let pass = 0; pass < 3; pass++) {
    const step = [0.16, 0.06, 0.02][pass];
    for (const k of order) {
      for (const dir of [1, -1]) {
        for (let i = 0; i < 8; i++) {
          const trial = { ...g, [k]: Math.max(bounds[k][0], Math.min(bounds[k][1], g[k] + dir * step)) };
          if (trial[k] === g[k]) break;
          const c = cost(predict(buf, trial)) + penalty(trial);
          if (c < best - 1e-5) { g[k] = trial[k]; best = c; } else break;
        }
      }
    }
  }
  for (const k of Object.keys(g)) g[k] = +g[k].toFixed(3);
  return { sliders: g, cost: +best.toFixed(4) };
}

export function planGrade(doc, projectDir, options = {}) {
  const rows = measureSources(doc, projectDir, { samples: options.samples || 3 });
  if (!rows.length) return { target: ROLE_TARGETS, sources: [] };

  // The face is whichever source carries the principal track — the one gapless video track
  // that spans the timeline. That is the same definition `polish` uses for where transitions
  // ride, so the two passes can never disagree about which clip is the talking head.
  const principal = principalTrack(doc, options.track ?? null);
  const faceSources = new Set();
  if (principal) {
    const videos = Object.fromEntries((doc.materials?.videos || []).map(m => [m.id, m]));
    for (const seg of principal.track.segments || []) {
      const mat = videos[seg.material_id];
      if (mat?.type === 'video') faceSources.add(path.basename(resolveMediaPath(mat.path, projectDir) || ''));
    }
  }
  for (const r of rows) r.role = faceSources.has(r.source) ? 'face' : 'screen';

  // Screens get their white balance pulled toward each other, not toward skin: the target is
  // the screen-weighted median of what is already there, so nothing moves far and nothing
  // is left fighting its neighbour.
  const screens = rows.filter(r => r.role === 'screen');
  let screenWarmth = null;
  if (screens.length > 1) {
    const w = screens.map(r => r.scope.warmth).sort((a, b) => a - b);
    screenWarmth = +w[Math.floor(w.length / 2)].toFixed(1);
  }

  const strength = options.strength ?? 1;
  const out = [];
  for (const row of rows) {
    const f = grabFrame(row.file, row.sampledAt[Math.floor(row.sampledAt.length / 2)]);
    if (!f) continue;
    const target = {
      ...ROLE_TARGETS[row.role],
      ...(row.role === 'screen' && screenWarmth != null ? { warmth: screenWarmth } : {}),
      ...(options.target || {}),
    };
    const solved = solveGrade(f.buf, target, {
      weights: ROLE_WEIGHTS[row.role],
      saturationIsCeiling: row.role === 'screen',
      // A face is never desaturated to fix a colour cast. Temperature is the tool for that;
      // draining skin is how footage starts looking like a corpse.
      ...(row.role === 'face' ? { bounds: { saturation: [0, 0.4] } } : {}),
    });
    const sliders = Object.fromEntries(Object.entries(solved.sliders)
      .map(([k, v]) => [k, +(v * strength).toFixed(3)])
      .filter(([, v]) => Math.abs(v) >= 0.01));
    out.push({
      source: row.source,
      role: row.role,
      tracks: row.tracks,
      clips: row.clips,
      screenSeconds: row.screenSeconds,
      target,
      before: row.scope,
      sliders,
      after: scope(gradeBuffer(f.buf, sliders)),
    });
  }
  return { roles: ROLE_TARGETS, screenWarmthTarget: screenWarmth, sources: out };
}

/* ------------------------------------------------------------------ *
 * 4. The write — one `effects` material per slider, per segment.
 * ------------------------------------------------------------------ */

const ADJUST_TYPES = new Set(['brightness', 'contrast', 'saturation', 'highlight', 'shadow',
  'white', 'black', 'temperature', 'tone', 'sharpen', 'clear', 'fade', 'light_sensation',
  'vignetting', 'particle']);

/** CapCut's own effect cache moved between machines; rebuild the path from the local one. */
function localEffectPath(fallback) {
  const home = process.env.HOME || '';
  const cache = path.join(home, 'Library/Containers/com.lemon.lvoverseas/Data/Movies/CapCut',
    'User Data/Cache/effect/7501974767453474064');
  if (!fs.existsSync(cache)) return fallback;
  const hashes = fs.readdirSync(cache).filter(n => fs.statSync(path.join(cache, n)).isDirectory());
  if (!hashes.length) return fallback;
  const hit = hashes.find(h => fs.existsSync(path.join(cache, h, 'AmazingFeature_adjustColor'))) || hashes[0];
  return path.join(cache, hit);
}

function makeAdjustMaterial(preset, type, value, key) {
  const m = clone(preset.effectTemplate);
  const base = localEffectPath(m.path);
  m.id = mint(`grade:${key}:${type}`);
  m.type = type;
  m.value = value;
  m.version = preset.versions[type] ?? '';
  m.path = base;
  m.lumi_hub_path = path.join(base, 'lumi_hub_path');
  return m;
}

/**
 * `grade.apply` — owns every adjust material it wrote, the way `polish` owns transitions.
 * Re-running replaces rather than stacks. Hand-made adjust materials on segments the plan
 * does not name are left alone; on segments it does name, they are replaced, because two
 * `brightness` materials on one segment is not something CapCut can show you.
 */
export function opGradeApply(doc, op, context = {}) {
  SEED = op.__seed || null;
  const preset = loadPreset('adjust');
  if (!preset?.effectTemplate) {
    throw new CapcutError('presets/adjust.json is missing its harvested effectTemplate.',
      { code: 'MISSING_PRESET' });
  }
  const videos = Object.fromEntries((doc.materials?.videos || []).map(m => [m.id, m]));
  const effects = (doc.materials.effects ||= []);
  const bySource = new Map(Object.entries(op.sources || {}));
  if (!bySource.size) throw new CapcutError('grade.apply needs `sources`.', { code: 'EMPTY_GRADE' });

  for (const [, sliders] of bySource) {
    for (const k of Object.keys(sliders)) {
      if (!ADJUST_TYPES.has(k)) {
        throw new CapcutError(`Unknown adjust slider "${k}". Known: ${[...ADJUST_TYPES].join(', ')}`,
          { code: 'UNKNOWN_SLIDER' });
      }
    }
  }

  const targets = [];
  for (const { segment } of allSegments(doc)) {
    const mat = videos[segment.material_id];
    if (!mat || mat.type !== 'video') continue;
    const key = path.basename(mat.path || '');
    if (bySource.has(key)) targets.push({ segment, key });
  }

  // Clear what this pass owns on the segments it is about to write.
  const owned = new Set();
  for (const { segment } of targets) {
    for (const ref of segment.extra_material_refs || []) {
      const m = effects.find(e => e.id === ref);
      if (m && ADJUST_TYPES.has(m.type)) owned.add(ref);
    }
  }
  if (owned.size) {
    doc.materials.effects = effects.filter(e => !owned.has(e.id));
    for (const { segment } of targets) {
      segment.extra_material_refs = (segment.extra_material_refs || []).filter(r => !owned.has(r));
    }
  }
  const list = doc.materials.effects;

  let written = 0;
  for (const [i, { segment, key }] of targets.entries()) {
    const sliders = bySource.get(key);
    const ids = [];
    for (const type of preset.order) {
      const v = sliders[type];
      if (v == null || Math.abs(v) < 1e-4) continue;
      const m = makeAdjustMaterial(preset, type, Number(v), `${key}:${i}:${segment.id}`);
      list.push(m);
      ids.push(m.id);
      written++;
    }
    if (!ids.length) continue;
    // Sit where CapCut puts them: after placeholder_info, before canvas_color. Order is
    // cosmetic (CapCut resolves by id) but a familiar file is a debuggable file.
    const refs = segment.extra_material_refs || [];
    const canvasIds = new Set((doc.materials.canvases || []).map(c => c.id));
    const at = refs.findIndex(r => canvasIds.has(r));
    segment.extra_material_refs = at >= 0
      ? [...refs.slice(0, at), ...ids, ...refs.slice(at)]
      : [...refs, ...ids];
    segment.enable_adjust = true;
  }

  return {
    changed: targets.length,
    materials: written,
    replaced: owned.size,
    sources: Object.fromEntries([...bySource].map(([k, v]) => [k, v])),
  };
}
