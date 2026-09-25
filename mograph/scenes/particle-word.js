/*
 * particle-word — 2,400 particles form a sphere, twist into a trefoil knot, and resolve into a word (any script: sampled from the rendered text), then explode toward the camera.
 * params: { text: 1–2 words, caption?: a short line, from?: "dots" | "void" (default void), exit?: "explode" | "hold" (default explode) }
 * beats: 6 (3.0 s)
 * handoff: ink (or dots with from "dots") → ink (explode) / the word (hold)
 * use: the reveal of a name — a product, a tool, a number said out loud. After shape-grid, set from to "dots".
 *
 * Timing: particles leave their start (the dot grid, or a single point) for a Fibonacci sphere
 * over beat 0–1 with per-particle delay; the sphere morphs into a trefoil knot (1.6–2.6) with a
 * radial pulse on beat 2; the knot resolves into the word (2.8–4.0, expo) while the rotation
 * unwinds to face the camera; the caption reads on beat 4; on beat 5 the word explodes past the
 * camera (inExpo), or holds and breathes with exit "hold".
 */
SCENE.define({
  id: 'particle-word',
  beats: () => 6,
  handoff: p => ({ in: p.from === 'dots' ? 'dots' : 'ink', out: p.exit === 'hold' ? 'ink' : 'ink' }),
  impacts: () => [[0.0, 0.5], [1.0, 0.45]],
  still: () => 2.45,
  setup(p, K) {
    if (!String(p.text || '').trim()) throw new Error('SCENE_PARAM: particle-word needs params.text');
    const N = 2400;
    const c = document.createElement('canvas').getContext('2d');
    c.font = K.font(700, 330);
    const size = Math.min(330, Math.floor((330 * (K.safe.w - 40)) / Math.max(1, c.measureText(String(p.text)).width)));
    const cy = K.safe.y + K.safe.h * 0.44;
    const pts = K.textPoints(String(p.text), { size, weight: 700, cx: K.CX, cy, count: N });
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const P = { N, start: [], sphere: [], knot: [], text: [], delay: [], dir: [], size: [], tint: [] };
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      if (p.from === 'dots') {
        const cell = i % 144, col = cell % 9, row = Math.floor(cell / 9);
        const ja = K.hash(i, 1) * K.TAU, jr = Math.sqrt(K.hash(i, 2)) * 5;
        P.start.push([60 + 120 * col - K.CX + Math.cos(ja) * jr, 60 + 120 * row - K.CY + Math.sin(ja) * jr, 0]);
      } else {
        P.start.push([(K.hash(i, 1) - 0.5) * 6, (K.hash(i, 2) - 0.5) * 6, 0]);
      }
      const y = 1 - 2 * (i + 0.5) / N, rr = Math.sqrt(1 - y * y), th = i * golden;
      P.sphere.push([Math.cos(th) * rr * 340, y * 340, Math.sin(th) * rr * 340]);
      const u = K.hash(i, 3) * K.TAU;
      const kx = Math.sin(u) + 2 * Math.sin(2 * u), ky = Math.cos(u) - 2 * Math.cos(2 * u), kz = -Math.sin(3 * u);
      const tr = 36 * Math.sqrt(K.hash(i, 4)), ta = K.hash(i, 5) * K.TAU, tb = Math.acos(2 * K.hash(i, 6) - 1);
      P.knot.push([kx * 110 + tr * Math.sin(tb) * Math.cos(ta), ky * 110 + tr * Math.sin(tb) * Math.sin(ta), kz * 110 + tr * Math.cos(tb)]);
      P.text.push([pts[i][0] - K.CX, pts[i][1] - K.CY, 0]);
      P.delay.push(K.hash(i, 9));
      const da = K.hash(i, 10) * K.TAU, db = Math.acos(2 * K.hash(i, 11) - 1);
      P.dir.push([Math.sin(db) * Math.cos(da), Math.sin(db) * Math.sin(da), Math.cos(db)]);
      P.size.push(1.9 + K.hash(i, 12) * 1.7);
      P.tint.push(K.hash(i, 13) < 0.12 ? 2 : K.hash(i, 14) < 0.5 ? 1 : 0);
    }
    return { P, box, cy, size };
  },
  cues(p) {
    const c = [
      { at: 0, kind: 'impact', gain: 0.6 },
      { at: 0.05, kind: 'sparkle', dur: 2.4, density: 60 },
      { at: 0.8, kind: 'whoosh', dur: 0.5, from: 500, to: 3000, shape: 'bell', pan0: -0.8, pan1: 0.8, gain: 0.7 },
      { at: 1.0, kind: 'thud', f0: 80, f1: 35, gain: 0.9 },
      { at: 1.4, kind: 'whoosh', dur: 0.6, from: 3000, to: 600, shape: 'bell', gain: 0.5 },
    ];
    [65, 68, 72, 77].forEach((n, i) => c.push({ at: 1.95 + i * 0.03, kind: 'bell', note: n + 12, gain: 0.7, pan: (i - 1.5) / 2, dur: 1.6 }));
    if (p.caption) c.push({ at: 2.0, kind: 'blip', note: 91, dur: 0.15, gain: 0.3 });
    if (p.exit !== 'hold') c.push({ at: 2.5, kind: 'riser', dur: 0.5, f0: 300, f1: 3000, gain: 1.2 });
    return c;
  },
  draw(ctx, t, p, s, K) {
    const { W, H, CX, CY, E, prog, lerp, clamp } = K;
    const { P } = s;
    const hold = p.exit === 'hold';
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, W, H);
    const glow = prog(t, 0.2, 0.8) * (hold ? 1 : 1 - prog(t, 2.6, 2.9));
    if (glow > 0) {
      const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, 900);
      g.addColorStop(0, K.rgba('brand', 0.32 * glow)); g.addColorStop(1, K.rgba('brand', 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    const f = 1500;
    const ry = t * 1.25 + 0.4, rx = 0.38 + 0.12 * Math.sin(t * 1.7);
    const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
    const pulse = t >= 1.0 ? Math.exp(-(t - 1.0) * 5) : 0;
    const boom = hold ? 0 : E.inExpo(prog(t, 2.55, 3.0));
    const breathe = hold ? 0.012 * Math.sin(Math.PI * prog(t, 2.2, 3.0)) : 0;
    const tr = (1 - E.outCubic(prog(t, 1.6, 2.3))) * 0.9, tcy = Math.cos(tr), tsy = Math.sin(tr);
    const buckets = new Map();
    for (let i = 0; i < P.N; i++) {
      const d = P.delay[i];
      const m1 = E.inOutCubic(prog(t, d * 0.25, 0.55 + d * 0.25));
      const m2 = E.inOutCubic(prog(t, 0.82 + d * 0.2, 1.3 + d * 0.2));
      const m3 = E.inOutExpo(prog(t, 1.42 + d * 0.25, 1.98 + d * 0.15));
      const sp = P.sphere[i], kn = P.knot[i];
      let x = lerp(sp[0], kn[0], m2), y = lerp(sp[1], kn[1], m2), z = lerp(sp[2], kn[2], m2);
      const pz = 1 + 0.3 * pulse * (0.4 + d);
      x *= pz; y *= pz; z *= pz;
      let x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      const y1 = y * cx - z1 * sx; z1 = y * sx + z1 * cx;
      const st = P.start[i];
      x = lerp(st[0], x1, m1); y = lerp(st[1], y1, m1); z = lerp(0, z1, m1);
      const tx = P.text[i];
      x = lerp(x, tx[0] * tcy * (1 + breathe), m3); y = lerp(y, (tx[1]) * (1 + breathe), m3); z = lerp(z, -tx[0] * tsy, m3);
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
      arr.push(X, Y, P.size[i] * sc * (1 + boom * 2));
    }
    ctx.globalCompositeOperation = 'lighter';
    const TINT = ['text', 'brand', 'hot'];
    for (const [key, arr] of buckets) {
      const tint = Math.floor(key / 8), lvl = key % 8;
      ctx.fillStyle = tint === 1 ? K.rgba('brand', 0.35 + lvl * 0.16) : K.rgba(TINT[tint], 0.2 + lvl * 0.16);
      ctx.beginPath();
      for (let j = 0; j < arr.length; j += 3) { ctx.moveTo(arr[j] + arr[j + 2], arr[j + 1]); ctx.arc(arr[j], arr[j + 1], arr[j + 2], 0, K.TAU); }
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (t > 2.0 && boom < 0.05) K.mark(s.box.x, s.box.y, s.box.w, s.box.h, p.text);
    if (p.caption) {
      const ca = prog(t, 1.95, 2.15) * (hold ? 1 : 1 - prog(t, 2.5, 2.62));
      if (ca > 0) {
        ctx.font = K.font(600, 50); ctx.fillStyle = K.color('text'); ctx.globalAlpha = ca;
        K.text(ctx, String(p.caption), CX, s.box.y + s.box.h + 110 + (1 - E.outCubic(ca)) * 14, { align: 'center' });
        ctx.globalAlpha = 1;
      }
    }
  },
});
