/*
 * Motion showreel — 15 s, 1920×1080, 60 fps, cut to a 120 BPM grid (one beat = 0.5 s).
 *
 * Same contract as mograph/runtime.js: the picture at time T is a pure function of T. There is
 * no wall clock, no Math.random and no requestAnimationFrame; every "random" value is a hash of
 * integers, so a frame renders identically on every machine and in any order (render.mjs splits
 * the frame range across workers).
 *
 *   window.__reel.ready          fonts loaded, glyph metrics measured
 *   window.__reel.frame(i, opts) draw frame i into #out: `samples` sub-frames across a 180°
 *                                shutter (real motion blur), then chromatic aberration on impacts,
 *                                vignette and film grain
 *
 * Scenes (each hands off to the next on a beat, with a motivated transition):
 *   0.0  01 IGNITION        a dot anticipates, snaps into a line, the line grows a grid
 *   1.5  02 TYPOGRAPHY      MOTION slams up through a mask, glitches, gains an E → EMOTION,
 *                           then the camera dives through the counter of its O
 *   4.0  03 SHAPE LANGUAGE  squash-and-stretch bounce, superellipse morph, a Bauhaus grid ripple
 *   6.5  04 PARTICLES       the grid's dots become 2,400 particles: sphere → trefoil knot → CRAFT
 *   9.0  05 TIMING          a live cubic-bezier editor with spacing charts; the curve becomes a wipe
 *  11.5  06 STYLE FRAMES    eight looks, one per eighth note
 *  13.5  07 SIGNATURE       the opening dot returns as the full stop of the name card
 */
'use strict';
(function () {
  const W = 1920, H = 1080, FPS = 60, DURATION = 15;
  const CX = W / 2, CY = H / 2, TAU = Math.PI * 2;
  const C = {
    ink: '#0B0B0F', ink2: '#0F0F15', cream: '#F1ECE2', orange: '#FF4D1A', blue: '#2F4BFF',
    lime: '#D6FF3C', pink: '#FF8AC4', grey: '#8B8794',
  };
  const INTER = '"Inter"', MONO = '"JetBrains Mono"', SERIF = '"Instrument Serif"';

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
  /** Damped spring step response (0 → 1 with overshoot), t in seconds since release. */
  function spring(t, freq = 2.4, damp = 0.38) {
    if (t <= 0) return 0;
    const w = TAU * freq, wd = w * Math.sqrt(1 - damp * damp);
    return 1 - Math.exp(-damp * w * t) * (Math.cos(wd * t) + (damp * w / wd) * Math.sin(wd * t));
  }
  /** Decaying wobble for contact squash: 1 at impact, rings out. */
  const wobble = (d, decay = 14, freq = 32) => (d < 0 ? 0 : Math.exp(-d * decay) * Math.cos(d * freq));
  /** Integer hash → [0, 1). */
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
  /** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. */
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
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const mix = (h1, h2, p) => {
    const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
    const ch = s => Math.round(lerp((a >> s) & 255, (b >> s) & 255, p));
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  };

  // ---- drawing helpers -----------------------------------------------------------------------
  const font = (weight, size, family = INTER, style = '') => `${style} ${weight} ${size}px ${family}`.trim();
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
  /** One of the shape-language primitives, centred at (x, y) with half-size s. */
  function shape(ctx, type, x, y, s, rot, color) {
    if (s <= 0.2) return;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = color; ctx.strokeStyle = color;
    switch (type) {
      case 'circle': circle(ctx, 0, 0, s); ctx.fill(); break;
      case 'square': ctx.fillRect(-s, -s, 2 * s, 2 * s); break;
      case 'triangle':
        ctx.beginPath(); ctx.moveTo(0, -s * 1.1); ctx.lineTo(s * 1.05, s * 0.8); ctx.lineTo(-s * 1.05, s * 0.8); ctx.closePath(); ctx.fill(); break;
      case 'ring': ctx.lineWidth = s * 0.34; circle(ctx, 0, 0, s * 0.83); ctx.stroke(); break;
      case 'plus': { const k = s * 0.34; ctx.fillRect(-s, -k, 2 * s, 2 * k); ctx.fillRect(-k, -s, 2 * k, 2 * s); break; }
      case 'quarter': ctx.beginPath(); ctx.moveTo(-s, -s); ctx.arc(-s, -s, 2 * s, 0, Math.PI / 2); ctx.closePath(); ctx.fill(); break;
      case 'half': ctx.beginPath(); ctx.arc(0, s * 0.35, s, Math.PI, TAU); ctx.closePath(); ctx.fill(); break;
      default: break;
    }
    ctx.restore();
  }
  /** x offsets of every prefix of `word` (includes kerning), with the current ctx font/spacing. */
  function prefixes(ctx, word) {
    const xs = [];
    for (let i = 0; i <= word.length; i++) xs.push(ctx.measureText(word.slice(0, i)).width);
    return xs;
  }
  const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=/<>';
  /** Text that resolves left→right out of cycling glyphs (deterministic per frame). */
  function scramble(str, p, T, seed = 0) {
    const n = str.length, done = Math.floor(p * n), tick = Math.floor(T * 30);
    let out = '';
    for (let i = 0; i < n; i++) {
      if (str[i] === ' ' || i < done) out += str[i];
      else if (i < done + 5 && p > 0) out += GLYPHS[Math.floor(hash(i, tick, seed) * GLYPHS.length)];
      else out += ' ';
    }
    return out;
  }

  // ---- impacts: camera shake, chromatic aberration and flashes all come from one list ------------
  const IMPACTS = [[1.5, 1], [2.0, 0.75], [2.5, 0.35], [4.5, 0.3], [5.0, 0.45], [6.0, 0.25], [6.5, 0.55],
    [7.5, 0.45], [9.0, 0.7], [11.5, 0.8], [12.0, 0.35], [12.5, 0.45], [13.0, 0.35], [13.5, 1]];
  function impact(T, decay) {
    let v = 0;
    for (const [t, s] of IMPACTS) if (T >= t) v += s * Math.exp(-(T - t) * decay);
    return v;
  }

  // ---- measured once, after fonts load ---------------------------------------------------------
  const M = {};
  function measure() {
    const c = document.createElement('canvas').getContext('2d');
    // Scene 1 word layouts.
    M.F = 300; M.ls = -14;
    c.font = font(900, M.F); c.letterSpacing = `${M.ls}px`;
    M.A = prefixes(c, 'MOTION'); M.B = prefixes(c, 'EMOTION');
    M.x0A = CX - (M.A[6] - M.ls) / 2; M.x0B = CX - (M.B[7] - M.ls) / 2;
    c.letterSpacing = '0px';
    const cap = c.measureText('H').actualBoundingBoxAscent;
    M.cap = cap; M.BL = CY + cap / 2;
    // The counter of the Inter Black "O", measured from pixels (the camera dives through it).
    const oc = document.createElement('canvas'); oc.width = 500; oc.height = 500;
    const o = oc.getContext('2d', { willReadFrequently: true });
    o.font = font(900, M.F); o.fillStyle = '#000'; o.fillText('O', 100, 400);
    const px = o.getImageData(0, 0, 500, 500).data, a = (x, y) => px[(y * 500 + x) * 4 + 3];
    let x0 = 500, x1 = 0, y0 = 500, y1 = 0;
    for (let y = 0; y < 500; y++) for (let x = 0; x < 500; x++) if (a(x, y) > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const ocx = Math.round((x0 + x1) / 2), ocy = Math.round((y0 + y1) / 2);
    let rx = 0, ry = 0;
    while (ocx + rx < 499 && a(ocx + rx, ocy) < 128) rx++;
    while (ocy - ry > 0 && a(ocx, ocy - ry) < 128) ry++;
    M.O = { dx: ocx - 100, dy: ocy - 400, rx, ry };
    // Scene 3 particles: sphere, trefoil knot, and the word CRAFT sampled from pixels.
    const N = 2400;
    const tc = document.createElement('canvas'); tc.width = W; tc.height = H;
    const tx = tc.getContext('2d', { willReadFrequently: true });
    tx.font = font(900, 330); tx.letterSpacing = '-6px'; tx.textAlign = 'center'; tx.textBaseline = 'middle';
    tx.fillStyle = '#000'; tx.fillText('CRAFT', CX, CY - 30);
    const td = tx.getImageData(0, 0, W, H).data;
    let pts = [];
    for (let step = 9; step >= 3; step--) {
      pts = [];
      for (let y = 0; y < H; y += step) for (let x = (y / step) % 2 ? step / 2 : 0; x < W; x += step) if (td[(y * W + Math.floor(x)) * 4 + 3] > 128) pts.push([x, y]);
      if (pts.length >= N) break;
    }
    for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(hash(i, 17) * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
    const P = { N, start: [], sphere: [], knot: [], text: [], delay: [], dir: [], size: [], tint: [] };
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const cell = i % 144, c16 = cell % 16, r9 = Math.floor(cell / 16);
      const ja = hash(i, 1) * TAU, jr = Math.sqrt(hash(i, 2)) * 5;
      P.start.push([60 + 120 * c16 - CX + Math.cos(ja) * jr, 60 + 120 * r9 - CY + Math.sin(ja) * jr, 0]);
      const y = 1 - 2 * (i + 0.5) / N, rr = Math.sqrt(1 - y * y), th = i * golden;
      P.sphere.push([Math.cos(th) * rr * 330, y * 330, Math.sin(th) * rr * 330]);
      const u = hash(i, 3) * TAU;
      const kx = Math.sin(u) + 2 * Math.sin(2 * u), ky = Math.cos(u) - 2 * Math.cos(2 * u), kz = -Math.sin(3 * u);
      const tr = 34 * Math.sqrt(hash(i, 4)), ta = hash(i, 5) * TAU, tb = Math.acos(2 * hash(i, 6) - 1);
      P.knot.push([kx * 105 + tr * Math.sin(tb) * Math.cos(ta), ky * 105 + tr * Math.sin(tb) * Math.sin(ta), kz * 105 + tr * Math.cos(tb)]);
      const p = pts[i % pts.length], rep = i >= pts.length ? 1 : 0;
      P.text.push([p[0] - CX + rep * (hash(i, 7) - 0.5) * 3, p[1] - CY + rep * (hash(i, 8) - 0.5) * 3, 0]);
      P.delay.push(hash(i, 9));
      const da = hash(i, 10) * TAU, db = Math.acos(2 * hash(i, 11) - 1);
      P.dir.push([Math.sin(db) * Math.cos(da), Math.sin(db) * Math.sin(da), Math.cos(db)]);
      P.size.push(1.7 + hash(i, 12) * 1.6);
      P.tint.push(hash(i, 13) < 0.12 ? 2 : hash(i, 14) < 0.5 ? 1 : 0);
    }
    M.P = P;
    // Scene 7 name card.
    c.font = font(400, 250, SERIF); c.letterSpacing = '-4px';
    M.name = 'Claude';
    M.nameXs = prefixes(c, M.name);
    c.letterSpacing = '0px';
  }

  // ==============================================================================================
  // 01 IGNITION  0.0 – 1.5
  // ==============================================================================================
  function scene0(ctx, t) {
    ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
    const GS = 120;
    ctx.lineWidth = 1.5;
    for (let k = -8; k <= 8; k++) {
      if (!k) continue;
      const s = 0.7 + Math.abs(k) * 0.028, p = E.outExpo(prog(t, s, s + 0.45));
      if (p <= 0) continue;
      const x = CX + k * GS, len = p * (H / 2 + 20);
      ctx.strokeStyle = rgba(C.cream, 0.13);
      ctx.beginPath(); ctx.moveTo(x, CY - len); ctx.lineTo(x, CY + len); ctx.stroke();
      if (p < 0.98) { ctx.fillStyle = rgba(C.cream, 0.9 * (1 - p)); ctx.fillRect(x - 2, CY - len - 2, 4, 4); ctx.fillRect(x - 2, CY + len - 2, 4, 4); }
    }
    for (let k = -4; k <= 4; k++) {
      if (!k) continue;
      const s = 0.84 + Math.abs(k) * 0.04, p = E.outExpo(prog(t, s, s + 0.5));
      if (p <= 0) continue;
      const y = CY + k * GS, len = p * (W / 2 + 20);
      ctx.strokeStyle = rgba(C.cream, 0.13);
      ctx.beginPath(); ctx.moveTo(CX - len, y); ctx.lineTo(CX + len, y); ctx.stroke();
    }
    // Registration marks on the intersections.
    for (let i = -7; i <= 7; i++) for (let j = -3; j <= 3; j++) {
      const s = 1.0 + hash(i + 20, j + 20, 3) * 0.2, a = prog(t, s, s + 0.08) * 0.5;
      if (a <= 0) continue;
      ctx.fillStyle = rgba(C.cream, a);
      const x = CX + i * GS + GS / 2, y = CY + j * GS + GS / 2;
      ctx.fillRect(x - 6, y - 0.75, 12, 1.5); ctx.fillRect(x - 0.75, y - 6, 1.5, 12);
    }
    // The dot: appear, anticipate (squash), release into a line.
    ctx.fillStyle = C.cream;
    if (t < 0.5) {
      const r = 11 * spring(t - 0.03, 2.2, 0.42), a = E.inOutCubic(prog(t, 0.26, 0.5));
      ctx.beginPath(); ctx.ellipse(CX, CY, Math.max(0, r * (1 + 0.6 * a)), Math.max(0, r * (1 - 0.55 * a)), 0, 0, TAU); ctx.fill();
    } else {
      const p = E.outExpo(prog(t, 0.5, 0.86)), half = lerp(12, W * 0.56, p);
      const th = lerp(12, 3, E.outCubic(prog(t, 0.5, 0.72)));
      ctx.beginPath(); ctx.roundRect(CX - half, CY - th / 2, half * 2, th, th / 2); ctx.fill();
    }
    // Shockwaves.
    for (const [s, col, w] of [[1.0, C.cream, 7], [1.07, C.orange, 4]]) {
      const p = prog(t, s, s + 0.45);
      if (p <= 0 || p >= 1) continue;
      ctx.strokeStyle = rgba(col, 1 - p); ctx.lineWidth = w * (1 - p) + 0.5;
      circle(ctx, CX, CY, E.outExpo(p) * 760); ctx.stroke();
    }
    // Readouts riding the line.
    const ra = prog(t, 0.6, 0.72) * (1 - prog(t, 1.12, 1.2));
    if (ra > 0) {
      ctx.font = font(400, 15, MONO); ctx.fillStyle = rgba(C.cream, 0.55 * ra);
      ctx.textAlign = 'left'; ctx.fillText(`T+${t.toFixed(3)}s`, CX + 24, CY - 16);
      ctx.textAlign = 'right'; ctx.fillText(`F${String(Math.floor(t * FPS)).padStart(3, '0')}`, CX - 24, CY - 16);
      ctx.fillText('x 960  y 540', CX - 24, CY + 28);
      ctx.textAlign = 'left'; ctx.fillText('120 BPM', CX + 24, CY + 28);
    }
    // The line swells into an orange slab that takes the frame on the downbeat.
    const q = E.inOutExpo(prog(t, 1.16, 1.5));
    if (q > 0) { ctx.fillStyle = C.orange; ctx.fillRect(0, CY - (q * H) / 2 - 2, W, q * H + 4); }
  }

  // ==============================================================================================
  // 02 TYPOGRAPHY  1.5 – 4.0
  // ==============================================================================================
  function scene1(ctx, t, T) {
    ctx.fillStyle = C.orange; ctx.fillRect(0, 0, W, H);
    const { F, ls, A, B, x0A, x0B, BL, cap, O } = M;
    const move = E.inOutExpo(prog(t, 0.64, 0.96));
    const Ox = x0B + B[2] + O.dx, Oy = BL + O.dy;
    // Camera: slow push, then a dive through the counter of the O.
    const zoom = (1 + 0.035 * t) * Math.exp(Math.log(46) * E.inExpo(prog(t, 2.0, 2.5)));
    const fp = E.inOutCubic(prog(t, 1.9, 2.3));
    const fx = lerp(CX, Ox, fp), fy = lerp(CY, Oy, fp);
    ctx.save();
    ctx.translate(CX, CY); ctx.scale(zoom, zoom); ctx.translate(-fx, -fy);

    // Typographic guides.
    const ga = 1 - prog(t, 1.8, 2.0);
    for (const [y, label, s] of [[BL, 'BASELINE', 0.05], [BL - cap, 'CAP HEIGHT', 0.12], [BL - cap * 0.75, 'X-HEIGHT', 0.19]]) {
      const p = E.outExpo(prog(t, s, s + 0.5));
      if (p <= 0 || ga <= 0) continue;
      ctx.fillStyle = rgba(C.ink, 0.28 * ga);
      ctx.fillRect(0, y - 0.75, W * p, 1.5);
      ctx.font = font(400, 14, MONO); ctx.textAlign = 'left';
      ctx.fillStyle = rgba(C.ink, 0.6 * ga * p);
      ctx.fillText(`${label}  ${Math.round(y)}`, 72, y - 10);
    }

    // Echo outlines (behind the solid word).
    if (t > 1.4) {
      ctx.font = font(900, F); ctx.letterSpacing = `${ls}px`; ctx.textAlign = 'left';
      ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5;
      for (let k = 1; k <= 3; k++) for (const sgn of [-1, 1]) {
        const sp = spring(t - 1.42 - k * 0.05, 1.9, 0.55);
        const y = BL + sgn * k * F * 0.86 * sp;
        const x = x0B + (k % 2 ? 1 : -1) * sgn * (t - 1.4) * 320 * (0.6 + 0.4 * k);
        ctx.globalAlpha = clamp(sp) * (1 - (k - 1) * 0.22);
        ctx.strokeText('EMOTION', x, y);
      }
      ctx.globalAlpha = 1; ctx.letterSpacing = '0px';
    }

    // Iris: the counter of the O fills with cream (drawn behind the letters, oversized, so the
    // glyph itself is the mask), then the camera flies through it.
    const ip = prog(t, 1.98, 2.16);
    if (ip > 0) {
      const k = E.outBack(ip, 2.2);
      ctx.fillStyle = C.cream;
      ctx.beginPath(); ctx.ellipse(Ox, Oy, Math.max(0, O.rx * 1.3 * k), Math.max(0, O.ry * 1.12 * k), 0, 0, TAU); ctx.fill();
    }
    // Letters.
    const letters = [];
    'MOTION'.split('').forEach((ch, i) => {
      const s = 0.02 + i * 0.05, sp = spring(t - s, 2.0, 0.5);
      letters.push({ ch, x: lerp(x0A + A[i], x0B + B[i + 1], move), y: BL + (1 - sp) * F * 1.08,
        rot: (1 - sp) * 0.22 * (i % 2 ? 1 : -1), sx: 1, sy: 1 });
    });
    if (t > 0.7) {
      const p = prog(t, 0.7, 1.0), fall = E.inQuad(p);
      const sq = t > 1.0 ? wobble(t - 1.0, 9, 30) : 0;
      letters.unshift({ ch: 'E', x: x0B + B[0], y: lerp(BL - H * 0.95, BL, fall), rot: 0,
        sx: t < 1.0 ? 1 - 0.12 * fall : 1 + 0.2 * sq, sy: t < 1.0 ? 1 + 0.28 * fall : 1 - 0.3 * sq });
    }
    // Slice glitch on the second downbeat; strips step at 24 fps for the proper broken feel.
    const g = t >= 0.5 ? Math.exp(-(t - 0.5) * 6.5) : 0;
    const strips = g > 0.015 ? 11 : 1;
    const top = BL - F * 0.86, bandH = F * 0.9;
    const drawLetters = (color, dx) => {
      ctx.fillStyle = color;
      for (const L of letters) {
        ctx.save();
        ctx.translate(L.x + dx + M.F * 0.3, L.y); ctx.rotate(L.rot); ctx.scale(L.sx, L.sy);
        ctx.fillText(L.ch, -M.F * 0.3, 0);
        ctx.restore();
      }
    };
    ctx.font = font(900, F); ctx.textAlign = 'left';
    for (let k = 0; k < strips; k++) {
      ctx.save();
      if (t < 0.62) { ctx.beginPath(); ctx.rect(-W, top, W * 3, bandH + 12); ctx.clip(); }
      let dx = 0;
      if (strips > 1) {
        const y0 = top + (bandH * k) / strips;
        ctx.beginPath(); ctx.rect(-W, k === 0 ? -H : y0, W * 3, k === strips - 1 ? H * 3 : bandH / strips + 0.5); ctx.clip();
        const q = Math.floor(t * 24), r = hash(k, q, 5) * 2 - 1;
        dx = g * r * 240 * (hash(k, q, 6) > 0.4 ? 1 : 0.15);
        drawLetters(C.blue, dx * 1.35 + 10 * g);
        drawLetters(C.cream, dx * 0.7 - 10 * g);
      }
      drawLetters(C.ink, dx);
      ctx.restore();
    }

    // Caption.
    const ca = prog(t, 1.05, 1.3) * (1 - prog(t, 1.85, 2.0));
    if (ca > 0) {
      ctx.font = font(400, 50, SERIF, 'italic'); ctx.textAlign = 'center'; ctx.fillStyle = rgba(C.ink, ca);
      ctx.fillText('— with a little feeling', CX, BL + 88 - (1 - E.outCubic(ca)) * 14);
    }
    ctx.restore();
  }

  // ==============================================================================================
  // 03 SHAPE LANGUAGE  4.0 – 6.5
  // ==============================================================================================
  const CELL_BG = [C.cream, C.cream, C.ink, C.blue, C.orange, C.cream];
  const CELL_FG = { [C.cream]: [C.ink, C.blue, C.orange], [C.ink]: [C.lime, C.cream, C.orange], [C.blue]: [C.cream, C.lime], [C.orange]: [C.ink, C.cream] };
  const TYPES = ['quarter', 'half', 'circle', 'triangle', 'ring', 'plus', 'square'];
  function scene2(ctx, t) {
    ctx.fillStyle = C.cream; ctx.fillRect(0, 0, W, H);
    const GY = 820, R = 62;
    const tilt = E.inOutSine(prog(t, 1.35, 1.85)) * (1 - E.inOutSine(prog(t, 1.95, 2.35)));
    ctx.save();
    ctx.translate(CX, CY); ctx.rotate(-0.04 * tilt); ctx.scale(1 + 0.1 * tilt, 1 + 0.1 * tilt); ctx.translate(-CX, -CY);

    // Grid (appears as a ripple from the centre, turns on the beat, collapses to dots).
    if (t > 1.4) {
      const dmax = Math.hypot(CX, CY);
      for (let r = -1; r <= 9; r++) for (let c = -1; c <= 16; c++) {
        const x = 60 + 120 * c, y = 60 + 120 * r, d = Math.hypot(x - CX, y - CY);
        const a = 1.42 + (d / dmax) * 0.4, ap = E.outExpo(prog(t, a, a + 0.3));
        if (ap <= 0) continue;
        const bg = CELL_BG[Math.floor(hash(c + 5, r + 5, 21) * CELL_BG.length)];
        const fgs = CELL_FG[bg], fg = fgs[Math.floor(hash(c + 5, r + 5, 22) * fgs.length)];
        const type = TYPES[Math.floor(hash(c + 5, r + 5, 23) * TYPES.length)];
        const w1 = 2.0 + d / 2600, w2 = 1.5 + d / 2600;
        const rot = Math.floor(hash(c + 5, r + 5, 24) * 4) * Math.PI / 2
          + (Math.PI / 2) * (E.outBack(prog(t, w1, w1 + 0.26), 2) + E.outBack(prog(t, w2, w2 + 0.26), 2));
        const col = E.inOutCubic(prog(t, 2.16 + (1 - d / dmax) * 0.12, 2.4 + (1 - d / dmax) * 0.08));
        const hs = 60 * ap;
        ctx.fillStyle = bg; ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
        shape(ctx, type, x, y, 38 * spring(t - a - 0.04, 2.4, 0.45) * (1 - col), rot, fg);
        if (col > 0) {
          const k = 60 * E.outCubic(col);
          ctx.fillStyle = C.ink; ctx.fillRect(x - k, y - k, 2 * k, 2 * k);
          ctx.fillStyle = C.cream; circle(ctx, x, y, 5 * E.outBack(col, 3)); ctx.fill();
        }
      }
    }

    // Ground line.
    const gIn = E.outExpo(prog(t, 0.04, 0.4)), gOut = E.inOutCubic(prog(t, 1.08, 1.35));
    if (gIn > gOut) {
      ctx.fillStyle = C.ink;
      const L = 760 * gIn * (1 - gOut);
      ctx.fillRect(CX - 200 - L * 0.5 + 200 * gOut, GY, L, 3);
    }
    const heroFade = 1 - E.inBack(prog(t, 1.45, 1.62));
    if (heroFade > 0) {
      if (t < 1.0) {
        // Bounce: fall, land on the beat, one arc, land on the next beat.
        const x = lerp(430, CX, t / 1.0);
        let y, vy;
        if (t < 0.5) { const u = t / 0.5; y = lerp(-140, GY - R, u * u); vy = (2 * (GY - R + 140) * u) / 0.5; }
        else { const u = (t - 0.5) / 0.5, hA = 300; y = GY - R - 4 * hA * u * (1 - u); vy = (-4 * hA * (1 - 2 * u)) / 0.5; }
        const st = clamp(Math.abs(vy) / 2800, 0, 0.42), c = wobble(t - 0.5, 16, 34);
        const sy = (1 + st) * (1 - 0.4 * Math.max(0, c)), sx = (1 - st * 0.45) * (1 + 0.32 * Math.max(0, c));
        const hgt = GY - R - y;
        ctx.fillStyle = rgba(C.ink, 0.16 * clamp(1 - hgt / 700));
        ctx.beginPath(); ctx.ellipse(x, GY + 6, R * (0.5 + 0.6 * clamp(1 - hgt / 700)), 7, 0, 0, TAU); ctx.fill();
        ctx.save(); ctx.translate(x, y + R); ctx.scale(sx, sy);
        ctx.fillStyle = C.blue; circle(ctx, 0, -R, R); ctx.fill();
        ctx.restore();
      } else {
        const k = t - 1.0, c = wobble(k, 12, 30);
        const rise = E.outBack(prog(t, 1.06, 1.42), 2.0);
        const y = lerp(GY - R, CY, rise);
        const n = lerp(2, 10, E.inOutCubic(prog(t, 1.05, 1.32)));
        const rot = (Math.PI / 2) * spring(t - 1.05, 1.6, 0.4);
        superellipse(ctx, CX, y, R * 1.02 * heroFade, n, rot, 1 + 0.3 * c, 1 - 0.34 * c);
        ctx.fillStyle = C.blue; ctx.fill();
        const heroes = [['ring', -440, C.ink], ['triangle', -220, C.orange], ['half', 220, C.ink], ['plus', 440, C.orange]];
        heroes.forEach(([type, dx, col], i) => {
          const p = spring(t - 1.07 - Math.abs(dx) / 220 * 0.04, 2.3, 0.45);
          shape(ctx, type, lerp(CX, CX + dx, p), lerp(GY - R, CY, p), 56 * clamp(p, 0, 1.3) * heroFade, (1 - p) * 3 * (i % 2 ? 1 : -1), col);
        });
      }
    }
    ctx.restore();
  }

  // ==============================================================================================
  // 04 PARTICLES  6.5 – 9.0
  // ==============================================================================================
  function scene3(ctx, t) {
    ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
    const glow = prog(t, 0.2, 0.8) * (1 - prog(t, 2.15, 2.4));
    if (glow > 0) {
      const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, 720);
      g.addColorStop(0, rgba(C.blue, 0.28 * glow)); g.addColorStop(1, rgba(C.blue, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    const P = M.P, f = 1500;
    const ry = t * 1.25 + 0.4, rx = 0.38 + 0.12 * Math.sin(t * 1.7);
    const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
    const pulse = t >= 1.0 ? Math.exp(-(t - 1.0) * 5) : 0;
    const boom = E.inExpo(prog(t, 2.16, 2.5));
    const tr = (1 - E.outCubic(prog(t, 1.5, 2.2))) * 0.9, tcy = Math.cos(tr), tsy = Math.sin(tr);
    const buckets = new Map();
    for (let i = 0; i < P.N; i++) {
      const d = P.delay[i];
      const m1 = E.inOutCubic(prog(t, d * 0.25, 0.55 + d * 0.25));
      const m2 = E.inOutCubic(prog(t, 0.82 + d * 0.2, 1.3 + d * 0.2));
      const m3 = E.inOutExpo(prog(t, 1.42 + d * 0.25, 1.98 + d * 0.15));
      const s = P.sphere[i], k = P.knot[i];
      let x = lerp(s[0], k[0], m2), y = lerp(s[1], k[1], m2), z = lerp(s[2], k[2], m2);
      const pz = 1 + 0.3 * pulse * (0.4 + P.delay[i]);
      x *= pz; y *= pz; z *= pz;
      // rotate the solid: yaw then pitch
      let x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      let y1 = y * cx - z1 * sx; z1 = y * sx + z1 * cx;
      const st = P.start[i];
      x = lerp(st[0], x1, m1); y = lerp(st[1], y1, m1); z = lerp(0, z1, m1);
      const tx = P.text[i];
      const txx = tx[0] * tcy, txz = -tx[0] * tsy;
      x = lerp(x, txx, m3); y = lerp(y, tx[1], m3); z = lerp(z, txz, m3);
      if (boom > 0) { const dd = P.dir[i]; x += dd[0] * boom * 1700; y += dd[1] * boom * 1700; z += (dd[2] * 600 - 1300) * boom; }
      const zz = f + z;
      if (zz < 60) continue;
      const sc = f / zz, X = CX + x * sc, Y = CY + y * sc;
      if (X < -20 || X > W + 20 || Y < -20 || Y > H + 20) continue;
      const depth = clamp((z + 380) / 760);
      const lvl = Math.round(lerp(4, 1, depth * (1 - m3)));
      const key = P.tint[i] * 8 + lvl;
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      const r = P.size[i] * sc * (1 + boom * 2);
      arr.push(X, Y, r);
    }
    ctx.globalCompositeOperation = 'lighter';
    const TINT = [C.cream, C.blue, C.orange];
    for (const [key, arr] of buckets) {
      const tint = Math.floor(key / 8), lvl = key % 8;
      ctx.fillStyle = rgba(tint === 1 ? '#6F86FF' : TINT[tint], 0.2 + lvl * 0.16);
      ctx.beginPath();
      for (let j = 0; j < arr.length; j += 3) { ctx.moveTo(arr[j] + arr[j + 2], arr[j + 1]); ctx.arc(arr[j], arr[j + 1], arr[j + 2], 0, TAU); }
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    const ca = prog(t, 1.9, 2.1) * (1 - prog(t, 2.16, 2.3));
    if (ca > 0) {
      ctx.font = font(400, 52, SERIF, 'italic'); ctx.textAlign = 'center';
      ctx.fillStyle = rgba(C.cream, ca);
      ctx.fillText('every frame, on purpose.', CX, CY + 205 + (1 - E.outCubic(ca)) * 12);
    }
  }

  // ==============================================================================================
  // 05 TIMING  9.0 – 11.5
  // ==============================================================================================
  function scene4(ctx, t, T) {
    ctx.fillStyle = C.ink2; ctx.fillRect(0, 0, W, H);
    const ui = 1 - E.inCubic(prog(t, 1.7, 1.92));
    const gp = prog(t, 0, 0.3) * ui;
    if (gp > 0) {
      ctx.fillStyle = rgba(C.cream, 0.045 * gp);
      for (let x = 0; x < W; x += 40) ctx.fillRect(x, 0, 1, H);
      for (let y = 0; y < H; y += 40) ctx.fillRect(0, y, W, 1);
    }
    const a = spring(t - 0.32, 1.7, 0.4), b = spring(t - 1.02, 2.0, 0.5);
    const H0 = [0.33, 0.33, 0.67, 0.67], H1 = [0.16, 1, 0.3, 1], H2 = [0.87, 0, 0.13, 1];
    const hn = H0.map((v, i) => v + (H1[i] - v) * a + (H2[i] - H1[i]) * b);
    const ease = cubicBezier(clamp(hn[0]), hn[1], clamp(hn[2]), hn[3]);
    const gx = 250, gy = 250, gs = 580;
    const map = (u, v) => [gx + u * gs, gy + gs - v * gs];
    const P0 = map(0, 0), P1 = map(hn[0], hn[1]), P2 = map(hn[2], hn[3]), P3 = map(1, 1);

    // Ribbon zoom: the curve becomes the wipe into the montage.
    const rib = E.inExpo(prog(t, 1.72, 2.5));
    const mid = map(0.5, ease(0.5));
    const z = 1 + 0.6 * E.inCubic(prog(t, 1.72, 2.5));
    ctx.save();
    ctx.translate(mid[0], mid[1]); ctx.scale(z, z); ctx.translate(-mid[0], -mid[1]);

    if (ui > 0) {
      ctx.globalAlpha = ui;
      // Box, ticks and labels.
      const bp = E.outExpo(prog(t, 0, 0.45));
      ctx.strokeStyle = rgba(C.cream, 0.5); ctx.lineWidth = 1.5;
      ctx.setLineDash([gs * 4 * bp, gs * 4]); ctx.strokeRect(gx, gy, gs, gs); ctx.setLineDash([]);
      ctx.fillStyle = rgba(C.cream, 0.35 * bp);
      for (let i = 1; i < 10; i++) { ctx.fillRect(gx + (gs * i) / 10, gy + gs, 1, 8); ctx.fillRect(gx - 8, gy + (gs * i) / 10, 8, 1); }
      ctx.setLineDash([6, 8]); ctx.strokeStyle = rgba(C.cream, 0.18 * bp);
      ctx.beginPath(); ctx.moveTo(...P0); ctx.lineTo(...P3); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = font(400, 14, MONO); ctx.fillStyle = rgba(C.cream, 0.5 * bp);
      ctx.textAlign = 'left'; ctx.fillText('TIME →', gx, gy + gs + 34);
      ctx.save(); ctx.translate(gx - 26, gy + gs); ctx.rotate(-Math.PI / 2); ctx.fillText('VALUE →', 0, 0); ctx.restore();
      // Readout.
      ctx.font = font(400, 21, MONO); ctx.fillStyle = rgba(C.cream, 0.85 * prog(t, 0.2, 0.4));
      ctx.fillText(`cubic-bezier(${hn.map(v => v.toFixed(2)).join(', ')})`, gx, gy - 64);
      // Handles.
      const hp = clamp(spring(t - 0.22, 2.6, 0.5), 0, 1.2);
      ctx.strokeStyle = rgba(C.cream, 0.55); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(...P0); ctx.lineTo(...P1); ctx.moveTo(...P3); ctx.lineTo(...P2); ctx.stroke();
      for (const Pn of [P1, P2]) {
        ctx.fillStyle = C.cream; circle(ctx, Pn[0], Pn[1], 11 * hp); ctx.fill();
        ctx.strokeStyle = C.ink2; ctx.lineWidth = 3; circle(ctx, Pn[0], Pn[1], 5 * hp); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // The curve (and later the ribbon).
    const cp = E.outCubic(prog(t, 0.12, 0.55));
    ctx.strokeStyle = C.orange; ctx.lineCap = 'round'; ctx.lineWidth = lerp(5, 3300, rib);
    ctx.setLineDash(cp < 1 ? [1400 * cp, 3000] : []);
    ctx.beginPath(); ctx.moveTo(...P0); ctx.bezierCurveTo(...P1, ...P2, ...P3); ctx.stroke();
    ctx.setLineDash([]); ctx.lineCap = 'butt';

    if (ui > 0) {
      ctx.globalAlpha = ui;
      // Playhead: one move per beat, 0.4 s travel and a 0.1 s hold.
      const lp = t < 0.5 ? 0 : clamp(((t - 0.5) % 0.5) / 0.4);
      const u = lp, v = ease(u), D = map(u, v);
      ctx.setLineDash([3, 5]); ctx.strokeStyle = rgba(C.orange, 0.5); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(D[0], gy + gs); ctx.lineTo(D[0], D[1]); ctx.lineTo(gx, D[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = C.cream; circle(ctx, D[0], D[1], 9 * prog(t, 0.45, 0.55)); ctx.fill();

      // Headline.
      const hx = 1000;
      const h1 = E.outExpo(prog(t, 0.15, 0.6)), h2 = E.outExpo(prog(t, 0.28, 0.72));
      ctx.save(); ctx.beginPath(); ctx.rect(hx - 10, 120, 900, 180); ctx.clip();
      ctx.textAlign = 'left'; ctx.fillStyle = C.cream;
      ctx.font = font(800, 76); ctx.letterSpacing = '-3px';
      ctx.fillText('Timing is', hx, 206 + (1 - h1) * 110);
      ctx.letterSpacing = '0px';
      ctx.font = font(400, 92, SERIF, 'italic'); ctx.fillStyle = C.orange;
      ctx.fillText('everything.', hx + 360, 206 + (1 - h2) * 110);
      ctx.restore();

      // Spacing charts: the same move, eased and linear.
      const x0 = 1000, x1 = 1660;
      const rows = [[440, ease, b > 0.5 ? 'EASE-IN-OUT' : 'EASE-OUT', C.orange], [700, p => p, 'LINEAR', C.grey]];
      rows.forEach(([y, fn, label, col], ri) => {
        const rp = E.outExpo(prog(t, 0.3 + ri * 0.08, 0.8 + ri * 0.08));
        if (rp <= 0) return;
        ctx.fillStyle = rgba(C.cream, 0.25); ctx.fillRect(x0 - 24, y + 44, (x1 - x0 + 48) * rp, 1.5);
        ctx.font = font(500, 14, MONO); ctx.fillStyle = rgba(C.cream, 0.6 * rp); ctx.textAlign = 'left';
        ctx.fillText(label, x0 - 24, y - 50);
        ctx.textAlign = 'right'; ctx.fillText('SPACING', x1 + 24, y - 50);
        for (let k = 0; k <= 10; k++) {
          const gxp = lerp(x0, x1, fn(k / 10));
          const ga = prog(t, 0.45 + k * 0.03, 0.6 + k * 0.03);
          ctx.strokeStyle = rgba(C.cream, 0.22 * ga); ctx.lineWidth = 1.5;
          circle(ctx, gxp, y, 24); ctx.stroke();
          ctx.fillStyle = rgba(C.cream, 0.5 * ga); ctx.fillRect(gxp - 0.75, y + 36, 1.5, 16);
        }
        ctx.fillStyle = col; circle(ctx, lerp(x0, x1, fn(lp)), y, 24 * prog(t, 0.45, 0.55)); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ==============================================================================================
  // 06 STYLE FRAMES  11.5 – 13.5, one look per eighth note
  // ==============================================================================================
  const LOOKS = ['HALFTONE', 'RHYTHM', 'ISOMETRIC', 'LIQUID', 'PHYLLOTAXIS', 'KINETIC POSTER', 'OP ART', 'RIDGELINES'];
  const look = [
    function halftone(ctx, u, T) {
      ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
      const ox = CX + Math.sin(T * 5) * 260, oy = CY + Math.cos(T * 4) * 90;
      ctx.fillStyle = C.orange; ctx.beginPath();
      for (let y = 15; y < H; y += 30) for (let x = 15 + ((y / 30) % 2) * 15; x < W; x += 30) {
        const d = Math.hypot(x - ox, y - oy);
        const r = 13.5 * (0.5 + 0.5 * Math.sin(d * 0.022 - T * 22)) * clamp(1.25 - d / 1200);
        if (r > 0.6) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
      }
      ctx.fill();
    },
    function rhythm(ctx, u, T) {
      ctx.fillStyle = C.blue; ctx.fillRect(0, 0, W, H);
      ctx.save(); ctx.translate(CX, CY); ctx.rotate(-0.5);
      ctx.fillStyle = rgba(C.cream, 0.13);
      const off = (T * 900) % 110;
      for (let x = -1600 + off; x < 1600; x += 110) ctx.fillRect(x, -1400, 44, 2800);
      ctx.restore();
      ctx.font = font(400, 340, SERIF, 'italic'); ctx.textAlign = 'center'; ctx.fillStyle = C.cream;
      ctx.save(); ctx.translate(CX, CY + 110); const s = 1.12 - 0.12 * E.outExpo(u / 0.25); ctx.scale(s, s);
      ctx.fillText('Rhythm', 0, 0); ctx.restore();
      ctx.fillStyle = C.lime; circle(ctx, CX + 470, CY - 140 - Math.abs(Math.sin(T * 12.566)) * 90, 30); ctx.fill();
    },
    function iso(ctx, u, T) {
      ctx.fillStyle = C.cream; ctx.fillRect(0, 0, W, H);
      const n = 8, w = 92, hx = w * 0.866, hy = w * 0.5;
      const ox = CX, oy = CY - n * hy + 80;
      for (let s = 0; s < 2 * n - 1; s++) for (let i = 0; i < n; i++) {
        const j = s - i; if (j < 0 || j >= n) continue;
        const h = 30 + 150 * (0.5 + 0.5 * Math.sin(T * 10 - (i + j) * 0.55 + i * 0.3));
        const x = ox + (i - j) * hx, y = oy + (i + j) * hy;
        ctx.fillStyle = C.blue; ctx.beginPath(); ctx.moveTo(x - hx, y); ctx.lineTo(x, y + hy); ctx.lineTo(x, y + hy - h); ctx.lineTo(x - hx, y - h); ctx.fill();
        ctx.fillStyle = C.ink; ctx.beginPath(); ctx.moveTo(x + hx, y); ctx.lineTo(x, y + hy); ctx.lineTo(x, y + hy - h); ctx.lineTo(x + hx, y - h); ctx.fill();
        ctx.fillStyle = (i + j) % 5 === 0 ? C.orange : C.lime;
        ctx.beginPath(); ctx.moveTo(x, y - hy - h); ctx.lineTo(x + hx, y - h); ctx.lineTo(x, y + hy - h); ctx.lineTo(x - hx, y - h); ctx.fill();
      }
    },
    function liquid(ctx, u, T) {
      ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
      const blob = (bx, by, R, amp, seed, c1, c2) => {
        ctx.beginPath();
        for (let i = 0; i <= 120; i++) {
          const a = (i / 120) * TAU;
          const r = R + amp * fbm(Math.cos(a) * 1.4 + T * 2.2, Math.sin(a) * 1.4 + T * 1.7, seed);
          const X = bx + Math.cos(a) * r, Y = by + Math.sin(a) * r;
          if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
        }
        const g = ctx.createLinearGradient(bx - R, by - R, bx + R, by + R);
        g.addColorStop(0, c1); g.addColorStop(1, c2); ctx.fillStyle = g; ctx.fill();
      };
      blob(CX - 60, CY, 300, 110, 31, C.orange, C.pink);
      blob(CX + 330 + Math.sin(T * 6) * 40, CY - 170, 105, 40, 32, C.lime, C.cream);
      blob(CX - 420, CY + 230, 60, 25, 33, C.blue, '#6F86FF');
    },
    function phyllotaxis(ctx, u, T) {
      ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
      for (let i = 1; i < 520; i++) {
        const a = i * 2.39996323 + T * 1.8, r = 22 * Math.sqrt(i);
        const x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r, s = 3 + i * 0.03;
        ctx.save(); ctx.translate(x, y); ctx.rotate(a + T * 4);
        ctx.fillStyle = i % 13 === 0 ? C.orange : rgba(C.lime, 0.35 + 0.65 * (1 - i / 520));
        ctx.fillRect(-s, -s, 2 * s, 2 * s); ctx.restore();
      }
    },
    function poster(ctx, u, T) {
      ctx.fillStyle = C.orange; ctx.fillRect(0, 0, W, H);
      ctx.font = font(900, 176); ctx.letterSpacing = '-6px'; ctx.textAlign = 'left';
      const line = 'SHAPE TYPE TIME ', lw = ctx.measureText(line).width;
      for (let r = 0; r < 7; r++) {
        const y = 60 + r * 170, dir = r % 2 ? 1 : -1, off = ((T * 1500 * dir) % lw + lw) % lw;
        ctx.fillStyle = r === 3 ? C.cream : C.ink;
        for (let x = -off - lw; x < W + lw; x += lw) ctx.fillText(line, x, y + 60);
      }
      ctx.letterSpacing = '0px';
    },
    function opart(ctx, u, T) {
      ctx.fillStyle = C.cream; ctx.fillRect(0, 0, W, H);
      ctx.lineWidth = 10; ctx.strokeStyle = C.ink;
      const ax = CX - Math.cos(T * 7) * 140, ay = CY + Math.sin(T * 5) * 30;
      ctx.beginPath(); for (let r = 14; r < 1300; r += 28) { ctx.moveTo(ax + r, ay); ctx.arc(ax, ay, r, 0, TAU); } ctx.stroke();
      ctx.globalCompositeOperation = 'difference'; ctx.strokeStyle = '#fff';
      const bx = CX + Math.cos(T * 7) * 140, by = CY - Math.sin(T * 5) * 30;
      ctx.beginPath(); for (let r = 14; r < 1300; r += 28) { ctx.moveTo(bx + r, by); ctx.arc(bx, by, r, 0, TAU); } ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    },
    function ridges(ctx, u, T) {
      ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
      ctx.lineWidth = 2.2; ctx.strokeStyle = C.cream; ctx.fillStyle = C.ink;
      for (let l = 0; l < 30; l++) {
        const base = 250 + l * 23;
        ctx.beginPath(); ctx.moveTo(340, base);
        for (let x = 340; x <= W - 340; x += 10) {
          const env = Math.exp(-(((x - CX) / 260) ** 2));
          const n = Math.max(0, fbm(x * 0.012, l * 0.45 + T * 3, 41) + 0.35);
          ctx.lineTo(x, base - env * n * n * 260 - 3 * noise1(x * 0.1 + l * 7));
        }
        ctx.lineTo(W - 340, base + 40); ctx.lineTo(340, base + 40); ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, 0); // keep state tidy
    },
  ];
  function scene5(ctx, t, T) {
    const k = Math.min(7, Math.floor(t / 0.25)), u = t - k * 0.25;
    const z = 1.07 - 0.07 * E.outExpo(u / 0.25);
    ctx.save(); ctx.translate(CX, CY); ctx.scale(z, z); ctx.translate(-CX, -CY);
    look[k](ctx, u, T);
    ctx.restore();
    // One white frame on each downbeat cut.
    if (k % 2 === 0 && u < 1 / FPS) { ctx.fillStyle = rgba(C.cream, 0.85); ctx.fillRect(0, 0, W, H); }
  }

  // ==============================================================================================
  // 07 SIGNATURE  13.5 – 15.0
  // ==============================================================================================
  function scene6(ctx, t, T) {
    ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
    const push = 1 + 0.03 * E.outCubic(prog(t, 0, 1.5));
    ctx.save(); ctx.translate(CX, CY); ctx.scale(push, push); ctx.translate(-CX, -CY);
    const r = 17, gap = 14, xs = M.nameXs, wW = xs[xs.length - 1];
    const total = wW + gap + 2 * r, x0 = CX - total / 2, BL = CY + 50;
    const xEnd = x0 + wW + gap + r, yDot = BL - r;
    // Dot path: appear at centre, slide to the start of the word, then write it.
    const pA = E.inOutCubic(prog(t, 0.16, 0.36)), pB = E.inOutQuart(prog(t, 0.36, 0.86));
    const dotX = t < 0.36 ? lerp(CX, x0 - r, pA) : lerp(x0 - r, xEnd, pB);
    const vel = t < 0.36 ? Math.abs(E.inOutCubic(prog(t + 0.01, 0.16, 0.36)) - pA) : Math.abs(E.inOutQuart(prog(t + 0.01, 0.36, 0.86)) - pB);
    const stretch = clamp(vel * (t < 0.36 ? 20 : 45), 0, 1.4);
    // Ripple from the dot's arrival.
    const rp = prog(t, 0.02, 0.5);
    if (rp > 0 && rp < 1) { ctx.strokeStyle = rgba(C.orange, 0.8 * (1 - rp)); ctx.lineWidth = 3 * (1 - rp) + 0.5; circle(ctx, CX, yDot, E.outExpo(rp) * 240); ctx.stroke(); }
    // The name, revealed behind the dot.
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, t < 0.36 ? 0 : dotX - r * 0.2, H); ctx.clip();
    ctx.font = font(400, 250, SERIF); ctx.textAlign = 'left'; ctx.fillStyle = C.cream;
    for (let i = 0; i < M.name.length; i++) {
      const lx = x0 + xs[i], rt = t < 0.36 ? 99 : 0.36 + prog(lx, x0, xEnd) * 0.4;
      const p = E.outCubic(prog(t, rt, rt + 0.3));
      ctx.globalAlpha = clamp(0.2 + p * 1.2);
      ctx.fillText(M.name[i], lx, BL + (1 - p) * 30);
    }
    ctx.globalAlpha = 1; ctx.restore();
    // Dot, with squash on landing and a heartbeat on the final hit.
    const land = t > 0.86 ? wobble(t - 0.86, 12, 34) : 0;
    const beat = Math.sin(Math.PI * prog(t, 1.25, 1.45)) ** 2;
    const sc = spring(t - 0.02, 2.4, 0.4) * (1 + 0.35 * beat);
    ctx.fillStyle = C.orange;
    ctx.beginPath();
    ctx.ellipse(dotX, yDot + r * 0.3 * land, Math.max(0, r * sc * (1 + stretch * 0.9 + 0.25 * land)), Math.max(0, r * sc * (1 - stretch * 0.3 - 0.3 * land)), 0, 0, TAU);
    ctx.fill();
    // Rule, role and footer.
    const lp = E.outExpo(prog(t, 0.62, 1.0));
    ctx.fillStyle = rgba(C.cream, 0.28); ctx.fillRect(CX - 300 * lp, BL + 58, 600 * lp, 1.5);
    ctx.font = font(500, 24); ctx.letterSpacing = '11px'; ctx.textAlign = 'center';
    ctx.fillStyle = rgba(C.cream, 0.85);
    ctx.fillText(scramble('MOTION DESIGNER', prog(t, 0.7, 1.08), T, 7), CX + 5, BL + 112);
    ctx.letterSpacing = '0px';
    const fa = prog(t, 0.9, 1.2);
    ctx.font = font(400, 14, MONO); ctx.fillStyle = rgba(C.grey, 0.9 * fa);
    ctx.fillText('SHOWREEL 2026   ·   1920×1080 @ 60   ·   EVERY FRAME RENDERED FROM CODE', CX, H - 118);
    ctx.restore();
  }

  // ==============================================================================================
  // HUD — drawn in difference mode so it reads on every background.
  // ==============================================================================================
  const SCENES = [[0, 'IGNITION'], [1.5, 'TYPOGRAPHY'], [4.0, 'SHAPE LANGUAGE'], [6.5, 'PARTICLES'], [9.0, 'TIMING'], [11.5, 'STYLE FRAMES'], [13.5, 'SIGNATURE']];
  function hud(ctx, T) {
    const a = prog(T, 1.6, 1.9) * (1 - prog(T, 13.42, 13.5));
    if (a <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.globalAlpha = a; ctx.fillStyle = '#fff';
    const m = 48, L = 26;
    for (const [x, y, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) {
      ctx.fillRect(x, y, L * sx, 2 * sy); ctx.fillRect(x, y, 2 * sx, L * sy);
    }
    ctx.font = font(500, 15, MONO); ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; ctx.fillText('CLAUDE — MOTION REEL ’26', m + 40, m + 12);
    const fr = Math.floor(T * FPS + 1e-6);
    const tc = `00:00:${String(Math.floor(fr / FPS)).padStart(2, '0')}:${String(fr % FPS).padStart(2, '0')}`;
    ctx.textAlign = 'right'; ctx.fillText(`TC ${tc}`, W - m - 40, m + 12);
    let si = 0; for (let i = 0; i < SCENES.length; i++) if (T >= SCENES[i][0]) si = i;
    let name = SCENES[si][1];
    if (si === 5) name += ` / ${LOOKS[Math.min(7, Math.floor((T - 11.5) / 0.25))]}`;
    const label = `${String(si + 1).padStart(2, '0')} ${name}`;
    ctx.textAlign = 'left';
    ctx.fillText(scramble(label, prog(T, SCENES[si][0], SCENES[si][0] + 0.3), T, si), m + 40, H - m - 12);
    // Beat meter.
    const beat = Math.floor(T / 0.5) % 4, bp = (T % 0.5) / 0.5;
    for (let i = 0; i < 4; i++) {
      const x = W - m - 40 - (3 - i) * 20 - 12, on = i === beat;
      if (on) ctx.fillRect(x, H - m - 18, 12, 12);
      else { ctx.globalAlpha = a * 0.4; ctx.fillRect(x, H - m - 18, 12, 12); ctx.globalAlpha = a; }
    }
    ctx.globalAlpha = a * (1 - bp);
    ctx.fillRect(W - m - 40 - 72 - 26, H - m - 14, 4, 4);
    ctx.restore();
  }

  // ==============================================================================================
  // Frame
  // ==============================================================================================
  function draw(ctx, T) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.letterSpacing = '0px'; ctx.lineCap = 'butt';
    ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
    const amp = 15 * impact(T, 10);
    ctx.translate(CX + amp * noise1(T * 55, 3), CY + amp * noise1(T * 55, 9));
    ctx.rotate(amp * 0.0007 * noise1(T * 40, 5));
    const zk = 1 + amp * 0.0016;
    ctx.scale(zk, zk);
    ctx.translate(-CX, -CY);
    if (T < 1.5) scene0(ctx, T);
    else if (T < 4.0) scene1(ctx, T - 1.5, T);
    else if (T < 6.5) scene2(ctx, T - 4.0, T);
    else if (T < 9.0) scene3(ctx, T - 6.5, T);
    else if (T < 11.5) scene4(ctx, T - 9.0, T);
    else if (T < 13.5) scene5(ctx, T - 11.5, T);
    else scene6(ctx, T - 13.5, T);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    hud(ctx, T);
  }

  // ---- post: motion blur accumulation, chromatic aberration, vignette, grain ---------------------
  const work = document.createElement('canvas'); work.width = W; work.height = H;
  const wctx = work.getContext('2d', { willReadFrequently: true, alpha: false });
  const out = document.getElementById('out');
  const octx = out.getContext('2d', { alpha: false });
  const N = W * H;
  const acc = new Uint16Array(N * 3);
  const vig = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x - CX) / CX, dy = (y - CY) / CY, d = dx * dx * 0.8 + dy * dy * 0.6;
    vig[y * W + x] = 1 - 0.32 * Math.min(1, d) ** 1.6;
  }
  const GRAIN = new Int8Array(N + 4096);
  for (let i = 0; i < GRAIN.length; i++) GRAIN[i] = Math.round((hash(i, 77) + hash(i, 78) + hash(i, 79) - 1.5) * 16);

  function frame(i, { samples = 5, shutter = 0.5, grain = 1 } = {}) {
    const T0 = i / FPS;
    acc.fill(0);
    for (let s = 0; s < samples; s++) {
      const T = Math.max(0, Math.min(DURATION - 1e-4, T0 + (samples > 1 ? ((s + 0.5) / samples - 0.5) * shutter / FPS : 0)));
      draw(wctx, T);
      const d = wctx.getImageData(0, 0, W, H).data;
      for (let p = 0, q = 0; p < N * 4; p += 4, q += 3) { acc[q] += d[p]; acc[q + 1] += d[p + 1]; acc[q + 2] += d[p + 2]; }
    }
    const img = octx.createImageData(W, H), o = img.data;
    const ca = 9 * impact(T0, 12) + (T0 >= 11.5 && T0 < 13.5 ? 3 : 0);
    const g0 = (Math.floor(hash(i, 91) * 4096)) | 0, gk = grain;
    const inv = 1 / samples;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const p = row + x, q = p * 3;
        let r, g, b;
        if (ca >= 0.5) {
          const sh = Math.round(ca * (x - CX) / CX);
          const xr = Math.min(W - 1, Math.max(0, x + sh)), xb = Math.min(W - 1, Math.max(0, x - sh));
          r = acc[(row + xr) * 3] * inv; g = acc[q + 1] * inv; b = acc[(row + xb) * 3 + 2] * inv;
        } else { r = acc[q] * inv; g = acc[q + 1] * inv; b = acc[q + 2] * inv; }
        const v = vig[p], n = GRAIN[p + g0] * gk;
        const o4 = p * 4;
        o[o4] = r * v + n; o[o4 + 1] = g * v + n; o[o4 + 2] = b * v + n; o[o4 + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return true;
  }

  async function loadFonts() {
    const base = 'fonts/';
    const faces = [
      ['Inter', 'inter-latin-400-normal', '400'], ['Inter', 'inter-latin-500-normal', '500'],
      ['Inter', 'inter-latin-800-normal', '800'], ['Inter', 'inter-latin-900-normal', '900'],
      ['JetBrains Mono', 'jetbrains-mono-latin-400-normal', '400'], ['JetBrains Mono', 'jetbrains-mono-latin-700-normal', '700'],
      ['Instrument Serif', 'instrument-serif-latin-400-normal', '400', 'normal'],
      ['Instrument Serif', 'instrument-serif-latin-400-italic', '400', 'italic'],
    ];
    for (const [family, file, weight, style = 'normal'] of faces) {
      const ff = new FontFace(family, `url(${base}${file}.woff2)`, { weight, style });
      document.fonts.add(await ff.load());
    }
    await document.fonts.ready;
  }

  window.__reel = {
    fps: FPS, duration: DURATION, frames: DURATION * FPS, width: W, height: H,
    ready: loadFonts().then(() => { measure(); return true; }),
    frame,
  };
})();
