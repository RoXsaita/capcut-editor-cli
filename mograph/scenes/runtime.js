/*
 * scene runtime — the contract between a full-frame motion-design scene and the renderer.
 *
 * Templates in ../templates are small overlays (a keyword, a counter, a callout) cropped to their
 * own box. A SCENE is the other kind of motion graphic: a full 1080×1920 insert or transition
 * with its own camera, motion blur, grain and synced sound, the stuff between shots. It is
 * drawn on a <canvas>, not the DOM, because it needs things CSS cannot do deterministically:
 * sub-frame accumulation, particles, pixel-sampled text, blend modes and masks.
 *
 * A scene is mograph/scenes/<id>.js and calls SCENE.define(spec). src/mograph-scene.mjs opens
 * host.html with `window.__SCENE_INPUT__ = { scene, params, tokens, zones, canvas, fps,
 * fontsBase }`, waits for `window.__scene.ready`, then calls `window.__scene.frame(i)` once per
 * frame and screenshots the page (transparent where an `alpha` scene leaves holes).
 *
 * Determinism is the contract, exactly as in ../runtime.js: the picture at time t is a pure
 * function of (params, t). No wall clock, no requestAnimationFrame, and Math.random is seeded.
 * Scenes use K.hash / K.rand instead and never touch Math.random; a test lints that.
 *
 * spec = {
 *   id,                                   // equals the file name
 *   beats(params, K) -> number            // length in beats of tokens.scene.bpm (120 → 0.5 s)
 *   alpha?: boolean | (params) => boolean // true: transparent where the scene draws nothing
 *                                         // (a transition that reveals the footage under it)
 *   handoff: { in, out }                  // what the first/last frame is: a palette role
 *                                         // ('ink', 'hot'…), 'footage' (transparent) or 'dots'.
 *                                         // Scenes chain when one's out equals the next one's in.
 *   setup?(params, K) -> state            // measure text, sample points; runs once after fonts
 *   draw(ctx, t, params, state, K)        // paint time t (seconds). The runtime has already
 *                                         // cleared the frame and applied camera shake.
 *   impacts?(params, K) -> [[t, s], …]    // hits: camera shake + chromatic aberration
 *   cues?(params, K) -> [{ at, kind, …}]  // the paired sound (sound.mjs), times in seconds
 *   still?(params, K) -> seconds          // the representative frame for previews
 * }
 *
 * The kit K (also passed to setup/draw/cues) — everything a scene needs, so scenes never
 * carry their own maths, colours or font names:
 *   W H CX CY FPS BPM BEAT b(n)            canvas, tempo; b(n) = n beats in seconds
 *   clamp lerp prog E spring wobble        timing: E.outExpo, E.inOutCubic, E.outBack(p, s)…
 *   hash(a,b,c) rand(seed) noise1 noise2 fbm cubicBezier
 *   color(role) rgba(role, a) mix(r1, r2, p)   palette ROLES from tokens.scene.palette
 *   font(weight, size, 'display'|'mono')   the profile face (Arabic + Latin) or the mono face
 *   isArabic(text) words(ctx, text) text(ctx, str, x, y, opts) mark(x, y, w, h) textPoints(text, opts)
 *   circle superellipse shape(ctx, type, x, y, s, rot, role) scramble(str, p, t, seed)
 *   camera(ctx, { x, y, zoom, rot })       transform about a focus point
 *   zones                                  forbidden platform-UI rects; `safe` is the info box
 *
 * K.text() is how readable text is drawn: it records the box it painted, and the renderer
 * refuses a scene whose readable text lands in a platform-UI zone. Decorative full-bleed type
 * (a poster pattern) uses ctx.fillText directly and is exempt by design.
 */
(function () {
  'use strict';
  const input = window.__SCENE_INPUT__ || {};
  const tokens = input.tokens || {};
  const ST = tokens.scene || {};
  const canvas = input.canvas || { width: 1080, height: 1920 };
  const W = canvas.width, H = canvas.height, CX = W / 2, CY = H / 2, TAU = Math.PI * 2;
  const FPS = input.fps || 30;
  const BPM = ST.bpm || 120, BEAT = 60 / BPM;

  // ---- determinism -------------------------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Math.random = mulberry32(0x5eed);
  Date.now = () => 0;
  if (window.performance) window.performance.now = () => 0;
  window.requestAnimationFrame = () => 0;

  // ---- maths -------------------------------------------------------------------------------
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, p) => a + (b - a) * p;
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const E = {
    lin: p => p,
    inQuad: p => p * p,
    outQuad: p => 1 - (1 - p) * (1 - p),
    inCubic: p => p * p * p,
    outCubic: p => 1 - (1 - p) ** 3,
    inOutCubic: p => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
    inOutQuart: p => (p < 0.5 ? 8 * p ** 4 : 1 - (-2 * p + 2) ** 4 / 2),
    outQuint: p => 1 - (1 - p) ** 5,
    inExpo: p => (p <= 0 ? 0 : 2 ** (10 * p - 10)),
    outExpo: p => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
    inOutExpo: p => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 2 ** (20 * p - 10) / 2 : (2 - 2 ** (-20 * p + 10)) / 2),
    outBack: (p, s = 1.70158) => 1 + (s + 1) * (p - 1) ** 3 + s * (p - 1) ** 2,
    inBack: (p, s = 1.70158) => (s + 1) * p ** 3 - s * p * p,
    inOutSine: p => -(Math.cos(Math.PI * p) - 1) / 2,
  };
  /** Damped spring step response 0 → 1 (overshoots), t seconds since release. */
  function spring(t, freq = 2.4, damp = 0.38) {
    if (t <= 0) return 0;
    const w = TAU * freq, wd = w * Math.sqrt(1 - damp * damp);
    return 1 - Math.exp(-damp * w * t) * (Math.cos(wd * t) + (damp * w / wd) * Math.sin(wd * t));
  }
  /** Contact wobble: 1 at impact, rings out. Squash = 1 - k·wobble, stretch = 1 + k·wobble. */
  const wobble = (d, decay = 14, freq = 32) => (d < 0 ? 0 : Math.exp(-d * decay) * Math.cos(d * freq));
  function hash(a, b = 0, c = 0) {
    let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function noise1(x, seed = 0) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return lerp(hash(i, seed), hash(i + 1, seed), u) * 2 - 1;
  }
  function noise2(x, y, seed = 0) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
  }
  const fbm = (x, y, seed = 0) => noise2(x, y, seed) * 0.6 + noise2(x * 2.1, y * 2.1, seed + 1) * 0.28 + noise2(x * 4.3, y * 4.3, seed + 2) * 0.12;
  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = s => ((ax * s + bx) * s + cx) * s, sy = s => ((ay * s + by) * s + cy) * s;
    const dx = s => (3 * ax * s + 2 * bx) * s + cx;
    return p => {
      p = clamp(p);
      if (p === 0 || p === 1) return p;
      let s = p;
      for (let i = 0; i < 8; i++) {
        const e = sx(s) - p;
        if (Math.abs(e) < 1e-6) return sy(s);
        const d = dx(s);
        if (Math.abs(d) < 1e-6) break;
        s -= e / d;
      }
      let lo = 0, hi = 1; s = p;
      while (hi - lo > 1e-6) { if (sx(s) < p) lo = s; else hi = s; s = (lo + hi) / 2; }
      return sy(s);
    };
  }

  // ---- palette -----------------------------------------------------------------------------
  const PALETTE = { ...(ST.palette || {}) };
  function color(role) {
    const hex = PALETTE[role];
    if (!hex) throw new Error(`SCENE_COLOR: unknown colour role "${role}" (known: ${Object.keys(PALETTE).join(', ')})`);
    return hex;
  }
  const rgb = role => { const n = parseInt(color(role).slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const rgba = (role, a) => `rgba(${rgb(role).join(',')},${a})`;
  const mix = (r1, r2, p) => { const a = rgb(r1), b = rgb(r2); return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], p))).join(',')})`; };

  // ---- type --------------------------------------------------------------------------------
  const DISPLAY = (tokens.font && tokens.font.family) || 'IBM Plex Sans Arabic';
  const MONO = (ST.mono && ST.mono.family) || 'JetBrains Mono';
  const font = (weight, size, face = 'display') => `${weight} ${size}px "${face === 'mono' ? MONO : DISPLAY}"`;
  const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
  const isArabic = text => ARABIC.test(String(text || ''));
  /**
   * Lay a line out by WORD (Arabic letters join, so a word is the smallest unit that animates).
   * Returns { items, width, rtl }: items in READING order, each with its visual left x (0 at the
   * line's left edge) and width. Stagger by item.index, position by item.x. Draw Arabic words
   * with ctx.direction = 'rtl' (K.dir), or a trailing comma lands on the wrong side.
   */
  function words(ctx, text) {
    const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
    const rtl = isArabic(text);
    const space = ctx.measureText(' ').width;
    const widths = parts.map(w => ctx.measureText(w).width);
    const width = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, parts.length - 1);
    let x = rtl ? width : 0;
    const items = parts.map((word, index) => {
      const w = widths[index];
      let left;
      if (rtl) { x -= w; left = x; x -= space; } else { left = x; x += w + space; }
      return { word, index, x: left, width: w };
    });
    return { items, width, rtl };
  }
  let frameText = [];
  /**
   * Readable text: drawn, and its box recorded (in canvas pixels, through the current transform)
   * so the renderer can prove it stays out of the platform UI. opts: { align, baseline }.
   */
  function text(ctx, str, x, y, opts = {}) {
    ctx.save();
    if (opts.align) ctx.textAlign = opts.align;
    if (opts.baseline) ctx.textBaseline = opts.baseline;
    ctx.direction = isArabic(str) ? 'rtl' : 'ltr';   // neutral punctuation lands on the reading end
    ctx.fillText(str, x, y);
    const m = ctx.measureText(str);
    const x0 = x - m.actualBoundingBoxLeft, x1 = x + m.actualBoundingBoxRight;
    const y0 = y - m.actualBoundingBoxAscent, y1 = y + m.actualBoundingBoxDescent;
    const tf = ctx.getTransform();
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([px, py]) => [tf.a * px + tf.c * py + tf.e, tf.b * px + tf.d * py + tf.f]);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    if (ctx.globalAlpha > 0.5) frameText.push({ text: str, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    ctx.restore();
  }
  /**
   * Points inside rendered text (any script: the browser shapes it, we sample pixels).
   * opts: { size, weight, cx, cy, count, spacing } → exactly `count` [x, y] canvas points,
   * shuffled deterministically. Used by particle scenes.
   */
  function textPoints(str, { size = 300, weight = 700, cx = CX, cy = CY, count = 2000, spacing = '0px' } = {}) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.font = font(weight, size); x.letterSpacing = spacing; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#000'; x.fillText(str, cx, cy);
    const d = x.getImageData(0, 0, W, H).data;
    let pts = [];
    for (let step = 12; step >= 2; step--) {
      pts = [];
      for (let y = 0; y < H; y += step) for (let px = (y / step) % 2 ? step / 2 : 0; px < W; px += step) if (d[(y * W + Math.floor(px)) * 4 + 3] > 128) pts.push([px, y]);
      if (pts.length >= count) break;
    }
    if (!pts.length) throw new Error(`SCENE_TEXT: "${str}" drew no pixels`);
    for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(hash(i, 17) * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
    return Array.from({ length: count }, (_, i) => (i < pts.length ? pts[i]
      : [pts[i % pts.length][0] + (hash(i, 7) - 0.5) * 3, pts[i % pts.length][1] + (hash(i, 8) - 0.5) * 3]));
  }
  /** Register readable content that is not drawn with K.text (particle words, drawn titles). */
  function mark(x, y, w, h, label = '') { frameText.push({ text: label, x, y, w, h }); }
  const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=/<>';
  /** Latin/mono text resolving out of cycling glyphs. Never for Arabic (it would unjoin). */
  function scramble(str, p, t, seed = 0) {
    const n = str.length, done = Math.floor(p * n), tick = Math.floor(t * 30);
    let out = '';
    for (let i = 0; i < n; i++) {
      if (str[i] === ' ' || i < done) out += str[i];
      else if (i < done + 5 && p > 0) out += GLYPHS[Math.floor(hash(i, tick, seed) * GLYPHS.length)];
      else out += ' ';
    }
    return out;
  }

  // ---- shapes ------------------------------------------------------------------------------
  function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, TAU); }
  function superellipse(ctx, x, y, r, n, rot = 0, sx = 1, sy = 1) {
    ctx.beginPath();
    const e = 2 / n;
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * TAU, c = Math.cos(a), s = Math.sin(a);
      const px = r * Math.sign(c) * Math.abs(c) ** e * sx, py = r * Math.sign(s) * Math.abs(s) ** e * sy;
      const X = x + px * Math.cos(rot) - py * Math.sin(rot), Y = y + px * Math.sin(rot) + py * Math.cos(rot);
      if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    }
    ctx.closePath();
  }
  const SHAPES = ['quarter', 'half', 'circle', 'triangle', 'ring', 'plus', 'square'];
  function shape(ctx, type, x, y, s, rot, role) {
    if (s <= 0.2) return;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = color(role); ctx.strokeStyle = color(role);
    switch (type) {
      case 'circle': circle(ctx, 0, 0, s); ctx.fill(); break;
      case 'square': ctx.fillRect(-s, -s, 2 * s, 2 * s); break;
      case 'triangle': ctx.beginPath(); ctx.moveTo(0, -s * 1.1); ctx.lineTo(s * 1.05, s * 0.8); ctx.lineTo(-s * 1.05, s * 0.8); ctx.closePath(); ctx.fill(); break;
      case 'ring': ctx.lineWidth = s * 0.34; circle(ctx, 0, 0, s * 0.83); ctx.stroke(); break;
      case 'plus': { const k = s * 0.34; ctx.fillRect(-s, -k, 2 * s, 2 * k); ctx.fillRect(-k, -s, 2 * k, 2 * s); break; }
      case 'quarter': ctx.beginPath(); ctx.moveTo(-s, -s); ctx.arc(-s, -s, 2 * s, 0, Math.PI / 2); ctx.closePath(); ctx.fill(); break;
      case 'half': ctx.beginPath(); ctx.arc(0, s * 0.35, s, Math.PI, TAU); ctx.closePath(); ctx.fill(); break;
      default: throw new Error(`SCENE_SHAPE: unknown shape "${type}"`);
    }
    ctx.restore();
  }
  /** Camera about a focus point: the focus lands at the frame centre, scaled and rotated. */
  function camera(ctx, { x = CX, y = CY, zoom = 1, rot = 0 } = {}) {
    ctx.translate(CX, CY); ctx.rotate(rot); ctx.scale(zoom, zoom); ctx.translate(-x, -y);
  }

  // ---- zones -------------------------------------------------------------------------------
  const zones = input.zones || {};
  const forbidden = zones.forbidden || [];
  // The info-safe box: the canvas minus the top bar and bottom UI, left of the right rail.
  const top = Math.max(0, ...forbidden.filter(z => z.y === 0).map(z => z.y + z.h));
  const bottom = Math.min(H, ...forbidden.filter(z => z.y + z.h >= H).map(z => z.y));
  const rail = Math.min(W, ...forbidden.filter(z => z.x > W / 2 && z.y > 0 && z.y + z.h < H).map(z => z.x));
  const safe = { x: W - rail, y: top, w: rail - (W - rail), h: bottom - top };

  const K = {
    W, H, CX, CY, TAU, FPS, BPM, BEAT, b: n => n * BEAT,
    clamp, lerp, prog, E, spring, wobble, hash, rand: s => mulberry32(s >>> 0), noise1, noise2, fbm, cubicBezier,
    color, rgba, mix, font, isArabic, dir: t => (isArabic(t) ? 'rtl' : 'ltr'), words, text, mark, textPoints, scramble,
    circle, superellipse, shape, SHAPES, camera, zones: forbidden, safe,
  };

  // ---- fonts -------------------------------------------------------------------------------
  async function loadFonts() {
    const faces = [];
    const add = (family, files) => {
      for (const [weight, list] of Object.entries(files || {})) for (const file of list) faces.push([family, weight, file]);
    };
    add(DISPLAY, tokens.font && tokens.font.files);
    add(MONO, ST.mono && ST.mono.files);
    const css = faces.map(([family, weight, file]) => `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;`
      + `src:url("${input.fontsBase}${file}") format("woff2");font-display:block}`).join('\n');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const weights = [...new Set(faces.map(f => `${f[1]}|${f[0]}`))];
    await Promise.all(weights.map(k => { const [w, fam] = k.split('|'); return document.fonts.load(`${w} 48px "${fam}"`, 'Aa أب 123'); }));
    await document.fonts.ready;
    for (const k of weights) {
      const [w, fam] = k.split('|');
      if (!document.fonts.check(`${w} 48px "${fam}"`, 'Aa')) throw new Error(`SCENE_FONT_FALLBACK: "${fam}" ${w} did not load`);
    }
  }

  // ---- post: motion blur accumulation, aberration, vignette, grain ---------------------------
  const out = document.getElementById('out');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const work = document.createElement('canvas'); work.width = W; work.height = H;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const N = W * H;
  let acc = null, vig = null, grainMap = null;

  let spec = null, params = {}, state = null, duration = 0, alpha = false, impacts = [];
  function impactAt(t, decay) {
    let v = 0;
    for (const [at, s] of impacts) if (t >= at) v += s * Math.exp(-(t - at) * decay);
    return v;
  }
  function drawAt(ctx, t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.letterSpacing = '0px'; ctx.lineCap = 'butt';
    ctx.direction = 'ltr';
    ctx.clearRect(0, 0, W, H);
    if (!alpha) { ctx.fillStyle = color('ink'); ctx.fillRect(0, 0, W, H); }
    const amp = 14 * impactAt(t, 10);
    if (amp > 0.05) {
      ctx.translate(CX + amp * noise1(t * 55, 3), CY + amp * noise1(t * 55, 9));
      ctx.rotate(amp * 0.0007 * noise1(t * 40, 5));
      const z = 1 + amp * 0.0016; ctx.scale(z, z);
      ctx.translate(-CX, -CY);
    }
    frameText = [];
    spec.draw(ctx, t, params, state, K);
  }

  function frame(i, { samples = (ST.blur && ST.blur.samples) || 5, shutter = (ST.blur && ST.blur.shutter) || 0.5, grain = ST.grain == null ? 1 : ST.grain } = {}) {
    const T0 = i / FPS;
    if (!acc) {
      acc = new Float32Array(N * 4);
      vig = new Float32Array(N);
      const k = ST.vignette == null ? 0.3 : ST.vignette;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = (x - CX) / CX, dy = (y - CY) / CY, d = dx * dx * 0.7 + dy * dy * 0.7;
        vig[y * W + x] = 1 - k * Math.min(1, d) ** 1.6;
      }
      grainMap = new Int8Array(N + 4096);
      for (let p = 0; p < grainMap.length; p++) grainMap[p] = Math.round((hash(p, 77) + hash(p, 78) + hash(p, 79) - 1.5) * 16);
    }
    acc.fill(0);
    const n = Math.max(1, samples | 0);
    for (let s = 0; s < n; s++) {
      const t = clamp(T0 + (n > 1 ? ((s + 0.5) / n - 0.5) * shutter / FPS : 0), 0, duration - 1e-4);
      drawAt(wctx, t);
      const d = wctx.getImageData(0, 0, W, H).data;
      // Accumulate PREMULTIPLIED colour so a moving edge over transparency blurs correctly.
      for (let p = 0, q = 0; p < N * 4; p += 4, q += 4) {
        const a = d[p + 3] / 255;
        acc[q] += d[p] * a; acc[q + 1] += d[p + 1] * a; acc[q + 2] += d[p + 2] * a; acc[q + 3] += a;
      }
    }
    const img = octx.createImageData(W, H), o = img.data;
    const ca = Math.round(8 * impactAt(T0, 12));
    const g0 = Math.floor(hash(i, 91) * 4096), gk = grain;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const p = row + x, q = p * 4;
        const a = acc[q + 3];
        if (a <= 0) continue;
        let r, g, b;
        if (ca >= 1) {
          const sh = Math.round(ca * (x - CX) / CX);
          const qr = (row + clamp(x + sh, 0, W - 1)) * 4, qb = (row + clamp(x - sh, 0, W - 1)) * 4;
          r = acc[qr] / Math.max(1e-6, acc[qr + 3]); g = acc[q + 1] / a; b = acc[qb + 2] / Math.max(1e-6, acc[qb + 3]);
        } else { r = acc[q] / a; g = acc[q + 1] / a; b = acc[q + 2] / a; }
        const v = alpha ? 1 : vig[p], nz = grainMap[p + g0] * gk;
        o[q] = r * v + nz; o[q + 1] = g * v + nz; o[q + 2] = b * v + nz; o[q + 3] = Math.round((a / n) * 255);
      }
    }
    octx.putImageData(img, 0, 0);
    return true;
  }

  let resolveDefine;
  const defined = new Promise(r => { resolveDefine = r; });
  window.SCENE = { define(s) { resolveDefine(s); } };

  const api = {
    ready: (async () => {
      if (!input.scene || !/^[a-z0-9-]+$/.test(input.scene)) throw new Error(`SCENE_ID: bad scene id "${input.scene}"`);
      await loadFonts();
      const script = document.createElement('script');
      const failed = new Promise((_, reject) => { script.onerror = () => reject(new Error(`SCENE_ID: no scene "${input.scene}"`)); });
      script.src = `${input.scene}.js`;
      document.body.appendChild(script);
      spec = await Promise.race([defined, failed]);
      if (spec.id !== input.scene) throw new Error(`SCENE_ID: ${input.scene}.js defines "${spec.id}"`);
      params = input.params || {};
      alpha = typeof spec.alpha === 'function' ? Boolean(spec.alpha(params, K)) : Boolean(spec.alpha);
      const beats = spec.beats(params, K);
      if (!(beats > 0) || Math.abs(beats * 2 - Math.round(beats * 2)) > 1e-9) throw new Error(`SCENE_BEATS: ${spec.id} must last a whole number of half beats (got ${beats})`);
      duration = beats * BEAT;
      K.duration = duration;
      state = spec.setup ? (await spec.setup(params, K)) || {} : {};
      impacts = spec.impacts ? spec.impacts(params, K) : [];
      const cues = spec.cues ? spec.cues(params, K) : [];
      const handoff = typeof spec.handoff === 'function' ? spec.handoff(params, K) : spec.handoff;
      drawAt(wctx, 0);
      return {
        id: spec.id, duration, fps: FPS, bpm: BPM, beats, frames: Math.round(duration * FPS), alpha,
        handoff: handoff || null, cues, impacts, still: spec.still ? spec.still(params, K) : duration * 0.6,
        canvas: { width: W, height: H }, safe,
      };
    })(),
    frame,
    /** Readable-text boxes painted at time t (one sample, no post) — for the safe-zone check. */
    textAt(t) { drawAt(wctx, clamp(t, 0, duration - 1e-4)); return frameText.slice(); },
  };
  window.__scene = api;
})();
