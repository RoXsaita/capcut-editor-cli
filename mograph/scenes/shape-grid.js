/*
 * shape-grid — a ball bounces with squash and stretch, morphs into a square that bursts into a shape family, a Bauhaus grid ripples in, turns on the beat and collapses into dots.
 * params: { ball?: palette role of the ball (default brand) }
 * beats: 5 (2.5 s)
 * handoff: paper → dots (ink with a 9×16 dot grid: particle-word with from "dots" picks up every dot)
 * use: a textless breather between two sections, or the set-up for particle-word. Not twice in a video.
 *
 * Timing: the ball falls and lands on beat 1, arcs and lands on beat 2 (contact squash, shadow
 * that grows as it nears the floor), rises into a superellipse square (n 2 → 10) with a spring
 * turn, and four shapes burst out of it on springs. From beat 2.8 the grid ripples in from the
 * centre (distance-staggered), every cell turns 90° as a wave passes on beats 3 and 4, and on
 * the last half beat each cell is eaten by ink from the edge inward, leaving one dot.
 */
const CELL_BG = ['paper', 'paper', 'ink', 'brand', 'hot', 'paper'];
const CELL_FG = { paper: ['ink', 'brand', 'hot'], ink: ['accent', 'paper', 'hot'], brand: ['paper', 'accent'], hot: ['ink', 'paper'] };

SCENE.define({
  id: 'shape-grid',
  beats: () => 5,
  handoff: { in: 'paper', out: 'dots' },
  impacts: () => [[0.5, 0.3], [1.0, 0.45], [2.0, 0.25]],
  still: () => 1.9,
  cues(p, K) {
    const c = [
      { at: 0.02, kind: 'blip', note: 96, dur: 0.5, gain: 0.6 },
      { at: 0.0, kind: 'tone', f0: 900, f1: 200, dur: 0.5, gain: 0.8 },
      { at: 0.5, kind: 'thud', f0: 170, f1: 55, gain: 1 }, { at: 0.5, kind: 'click', tone: 900, gain: 0.5 },
      { at: 0.52, kind: 'tone', f0: 300, f1: 800, dur: 0.46, gain: 0.6 },
      { at: 1.0, kind: 'thud', f0: 190, f1: 50, gain: 1.1 }, { at: 1.0, kind: 'click', tone: 900, gain: 0.6 },
      { at: 1.45, kind: 'whoosh', dur: 0.3, from: 800, to: 5000, shape: 'bell', gain: 0.6 },
      { at: 1.95, kind: 'whoosh', dur: 0.3, from: 800, to: 5000, shape: 'bell', gain: 0.6, pan0: 0.6, pan1: -0.6 },
      { at: 2.1, kind: 'whoosh', dur: 0.4, from: 5000, to: 300, shape: 'down', gain: 0.9 },
    ];
    [72, 75, 77, 80, 84].forEach((n, i) => c.push({ at: 1.07 + i * 0.04, kind: 'blip', note: n, dur: 0.25, gain: 0.6, pan: (i - 2) / 2 }));
    for (let k = 0; k < 16; k++) c.push({ at: 1.42 + k * 0.025, kind: 'pluck', note: [68, 72, 75, 80][k % 4] + 12 * Math.floor(k / 8), gain: 0.8, pan: (k % 5 - 2) / 2.5 });
    for (let k = 0; k < 12; k++) c.push({ at: 2.18 + k * 0.025, kind: 'pluck', note: [79, 75, 72, 67][k % 4] - 12 * Math.floor(k / 6), gain: 0.6, pan: (2 - k % 5) / 2.5 });
    return c;
  },
  draw(ctx, t, p, s, K) {
    const { W, H, CX, CY, E, prog, spring, lerp, clamp } = K;
    const ball = p.ball || 'brand';
    ctx.fillStyle = K.color('paper'); ctx.fillRect(0, 0, W, H);
    const GY = 1300, R = 70, CELL = 120;
    const tilt = E.inOutSine(prog(t, 1.35, 1.85)) * (1 - E.inOutSine(prog(t, 1.95, 2.35)));
    ctx.save();
    K.camera(ctx, { rot: -0.04 * tilt, zoom: 1 + 0.12 * tilt });

    if (t > 1.4) {
      const dmax = Math.hypot(CX, CY);
      for (let r = -1; r <= 16; r++) for (let c = -1; c <= 9; c++) {
        const x = CELL / 2 + CELL * c, y = CELL / 2 + CELL * r, d = Math.hypot(x - CX, y - CY);
        const a = 1.42 + (d / dmax) * 0.4, ap = E.outExpo(prog(t, a, a + 0.3));
        if (ap <= 0) continue;
        const bg = CELL_BG[Math.floor(K.hash(c + 5, r + 5, 21) * CELL_BG.length)];
        const fgs = CELL_FG[bg], fg = fgs[Math.floor(K.hash(c + 5, r + 5, 22) * fgs.length)];
        const type = K.SHAPES[Math.floor(K.hash(c + 5, r + 5, 23) * K.SHAPES.length)];
        const w1 = 2.0 + d / 2600, w2 = 1.5 + d / 2600;
        const rot = Math.floor(K.hash(c + 5, r + 5, 24) * 4) * Math.PI / 2
          + (Math.PI / 2) * (E.outBack(prog(t, w1, w1 + 0.26), 2) + E.outBack(prog(t, w2, w2 + 0.26), 2));
        const col = E.inOutCubic(prog(t, 2.16 + (1 - d / dmax) * 0.12, 2.4 + (1 - d / dmax) * 0.08));
        const hs = (CELL / 2) * ap;
        ctx.fillStyle = K.color(bg); ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
        K.shape(ctx, type, x, y, 38 * spring(t - a - 0.04, 2.4, 0.45) * (1 - col), rot, fg);
        if (col > 0) {
          const k = (CELL / 2) * E.outCubic(col);
          ctx.fillStyle = K.color('ink'); ctx.fillRect(x - k, y - k, 2 * k, 2 * k);
          ctx.fillStyle = K.color('paper'); K.circle(ctx, x, y, 5 * E.outBack(col, 3)); ctx.fill();
        }
      }
    }

    // Floor.
    const gIn = E.outExpo(prog(t, 0.04, 0.4)), gOut = E.inOutCubic(prog(t, 1.08, 1.35));
    if (gIn > gOut) {
      ctx.fillStyle = K.color('ink');
      const L = 720 * gIn * (1 - gOut);
      ctx.fillRect(CX - 120 - L * 0.5 + 120 * gOut, GY, L, 4);
    }
    const heroFade = 1 - E.inBack(prog(t, 1.45, 1.62));
    if (heroFade > 0) {
      if (t < 1.0) {
        const x = lerp(220, CX, t / 1.0);
        let y, vy;
        if (t < 0.5) { const u = t / 0.5; y = lerp(-160, GY - R, u * u); vy = (2 * (GY - R + 160) * u) / 0.5; }
        else { const u = (t - 0.5) / 0.5, hA = 420; y = GY - R - 4 * hA * u * (1 - u); vy = (-4 * hA * (1 - 2 * u)) / 0.5; }
        const st = clamp(Math.abs(vy) / 3200, 0, 0.42), c = K.wobble(t - 0.5, 16, 34);
        const sy = (1 + st) * (1 - 0.4 * Math.max(0, c)), sx = (1 - st * 0.45) * (1 + 0.32 * Math.max(0, c));
        const hgt = GY - R - y;
        ctx.fillStyle = K.rgba('ink', 0.16 * clamp(1 - hgt / 900));
        ctx.beginPath(); ctx.ellipse(x, GY + 8, R * (0.5 + 0.6 * clamp(1 - hgt / 900)), 8, 0, 0, K.TAU); ctx.fill();
        ctx.save(); ctx.translate(x, y + R); ctx.scale(sx, sy);
        ctx.fillStyle = K.color(ball); K.circle(ctx, 0, -R, R); ctx.fill();
        ctx.restore();
      } else {
        const c = K.wobble(t - 1.0, 12, 30);
        const y = lerp(GY - R, CY, E.outBack(prog(t, 1.06, 1.42), 2.0));
        const n = lerp(2, 10, E.inOutCubic(prog(t, 1.05, 1.32)));
        K.superellipse(ctx, CX, y, R * 1.02 * heroFade, n, (Math.PI / 2) * spring(t - 1.05, 1.6, 0.4), 1 + 0.3 * c, 1 - 0.34 * c);
        ctx.fillStyle = K.color(ball); ctx.fill();
        const heroes = [['ring', 0, -260, 'ink'], ['triangle', -250, 0, 'hot'], ['half', 250, 0, 'ink'], ['plus', 0, 260, 'hot']];
        heroes.forEach(([type, dx, dy, role], i) => {
          const q = spring(t - 1.07 - i * 0.04, 2.3, 0.45);
          K.shape(ctx, type, lerp(CX, CX + dx, q), lerp(GY - R, CY + dy, q), 62 * clamp(q, 0, 1.3) * heroFade, (1 - q) * 3 * (i % 2 ? 1 : -1), role);
        });
      }
    }
    ctx.restore();
  },
});
