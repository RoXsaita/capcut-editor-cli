/*
 * style-stinger — a burst of style frames, one per eighth note: halftone, rhythm, isometric, liquid, phyllotaxis, kinetic poster, op art, ridgelines.
 * params: { count?: 4 | 8 (default 8), looks?: [names] (order/subset), word?: one word for the rhythm frame, words?: [2–4 words] for the poster frame }
 * beats: count / 2 (2.0 s at 8, 1.0 s at 4)
 * handoff: cut → cut (every frame is its own world; it sits between two hard cuts)
 * use: energy between sections, a "montage" beat, the moment before a reveal. At most once per video.
 *
 * Timing: each look holds a quarter beat (0.25 s) and punches in 1.07 → 1.0 (expo) so every cut
 * lands with a push; a single white frame flashes on each downbeat cut; each look moves on
 * the global clock so motion never resets to a pose.
 */
const LOOKS = {
  halftone(ctx, u, t, p, K) {
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, K.W, K.H);
    const ox = K.CX + Math.sin(t * 5) * 180, oy = K.CY + Math.cos(t * 4) * 260;
    ctx.fillStyle = K.color('hot'); ctx.beginPath();
    for (let y = 15; y < K.H; y += 30) for (let x = 15 + ((y / 30) % 2) * 15; x < K.W; x += 30) {
      const d = Math.hypot(x - ox, y - oy);
      const r = 13.5 * (0.5 + 0.5 * Math.sin(d * 0.022 - t * 22)) * K.clamp(1.25 - d / 1300);
      if (r > 0.6) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, K.TAU); }
    }
    ctx.fill();
  },
  rhythm(ctx, u, t, p, K) {
    ctx.fillStyle = K.color('brand'); ctx.fillRect(0, 0, K.W, K.H);
    ctx.save(); ctx.translate(K.CX, K.CY); ctx.rotate(-0.5);
    ctx.fillStyle = K.rgba('paper', 0.13);
    const off = (t * 900) % 110;
    for (let x = -1800 + off; x < 1800; x += 110) ctx.fillRect(x, -1600, 44, 3200);
    ctx.restore();
    const word = String(p.word || 'Rhythm');
    ctx.font = K.font(700, 240); const w = ctx.measureText(word).width;
    const size = Math.min(240, Math.floor(240 * 860 / w));
    ctx.font = K.font(700, size); ctx.textAlign = 'center'; ctx.direction = K.dir(word); ctx.fillStyle = K.color('text');
    ctx.save(); ctx.translate(K.CX, K.CY + size * 0.3); const s = 1.12 - 0.12 * K.E.outExpo(u / 0.25); ctx.scale(s, s);
    ctx.fillText(word, 0, 0); ctx.restore();
    ctx.fillStyle = K.color('accent'); K.circle(ctx, K.CX + 300, K.CY - size * 0.9 - Math.abs(Math.sin(t * 12.566)) * 120, 30); ctx.fill();
  },
  isometric(ctx, u, t, p, K) {
    ctx.fillStyle = K.color('paper'); ctx.fillRect(0, 0, K.W, K.H);
    const n = 7, w = 96, hx = w * 0.866, hy = w * 0.5;
    const ox = K.CX, oy = K.CY - n * hy + 60;
    for (let s = 0; s < 2 * n - 1; s++) for (let i = 0; i < n; i++) {
      const j = s - i; if (j < 0 || j >= n) continue;
      const h = 40 + 220 * (0.5 + 0.5 * Math.sin(t * 10 - (i + j) * 0.55 + i * 0.3));
      const x = ox + (i - j) * hx, y = oy + (i + j) * hy;
      ctx.fillStyle = K.color('brand'); ctx.beginPath(); ctx.moveTo(x - hx, y); ctx.lineTo(x, y + hy); ctx.lineTo(x, y + hy - h); ctx.lineTo(x - hx, y - h); ctx.fill();
      ctx.fillStyle = K.color('ink'); ctx.beginPath(); ctx.moveTo(x + hx, y); ctx.lineTo(x, y + hy); ctx.lineTo(x, y + hy - h); ctx.lineTo(x + hx, y - h); ctx.fill();
      ctx.fillStyle = K.color((i + j) % 5 === 0 ? 'hot' : 'accent');
      ctx.beginPath(); ctx.moveTo(x, y - hy - h); ctx.lineTo(x + hx, y - h); ctx.lineTo(x, y + hy - h); ctx.lineTo(x - hx, y - h); ctx.fill();
    }
  },
  liquid(ctx, u, t, p, K) {
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, K.W, K.H);
    const blob = (bx, by, R, amp, seed, r1, r2) => {
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * K.TAU;
        const r = R + amp * K.fbm(Math.cos(a) * 1.4 + t * 2.2, Math.sin(a) * 1.4 + t * 1.7, seed);
        const X = bx + Math.cos(a) * r, Y = by + Math.sin(a) * r;
        if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      }
      const g = ctx.createLinearGradient(bx - R, by - R, bx + R, by + R);
      g.addColorStop(0, K.color(r1)); g.addColorStop(1, K.color(r2)); ctx.fillStyle = g; ctx.fill();
    };
    blob(K.CX, K.CY + 40, 330, 120, 31, 'hot', 'accent');
    blob(K.CX + 180 + Math.sin(t * 6) * 40, K.CY - 400, 110, 40, 32, 'brand', 'paper');
    blob(K.CX - 250, K.CY + 480, 70, 25, 33, 'paper', 'brand');
  },
  phyllotaxis(ctx, u, t, p, K) {
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, K.W, K.H);
    for (let i = 1; i < 620; i++) {
      const a = i * 2.39996323 + t * 1.8, r = 21 * Math.sqrt(i);
      const x = K.CX + Math.cos(a) * r, y = K.CY + Math.sin(a) * r, s = 3 + i * 0.028;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a + t * 4);
      ctx.fillStyle = i % 13 === 0 ? K.color('hot') : K.rgba('accent', 0.35 + 0.65 * (1 - i / 620));
      ctx.fillRect(-s, -s, 2 * s, 2 * s); ctx.restore();
    }
  },
  poster(ctx, u, t, p, K) {
    ctx.fillStyle = K.color('hot'); ctx.fillRect(0, 0, K.W, K.H);
    const words = (Array.isArray(p.words) && p.words.length ? p.words : ['SHAPE', 'TYPE', 'TIME']).map(String);
    const line = `${words.join('  ·  ')}  ·  `;
    ctx.font = K.font(700, 170); ctx.textAlign = 'left'; ctx.direction = K.dir(line);
    const lw = ctx.measureText(line).width;
    for (let r = 0; r < 11; r++) {
      const y = 150 + r * 175, dir = r % 2 ? 1 : -1, off = ((t * 1400 * dir) % lw + lw) % lw;
      ctx.fillStyle = K.color(r === 5 ? 'paper' : 'ink');
      for (let x = -off - lw; x < K.W + lw; x += lw) ctx.fillText(line, x, y);
    }
    ctx.direction = 'ltr';
  },
  opart(ctx, u, t, p, K) {
    ctx.fillStyle = K.color('paper'); ctx.fillRect(0, 0, K.W, K.H);
    ctx.lineWidth = 10; ctx.strokeStyle = K.color('ink');
    const ax = K.CX - Math.cos(t * 7) * 60, ay = K.CY + Math.sin(t * 5) * 140;
    ctx.beginPath(); for (let r = 14; r < 1500; r += 28) { ctx.moveTo(ax + r, ay); ctx.arc(ax, ay, r, 0, K.TAU); } ctx.stroke();
    ctx.globalCompositeOperation = 'difference'; ctx.strokeStyle = K.color('text');
    const bx = K.CX + Math.cos(t * 7) * 60, by = K.CY - Math.sin(t * 5) * 140;
    ctx.beginPath(); for (let r = 14; r < 1500; r += 28) { ctx.moveTo(bx + r, by); ctx.arc(bx, by, r, 0, K.TAU); } ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  },
  ridgelines(ctx, u, t, p, K) {
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, K.W, K.H);
    ctx.lineWidth = 2.4; ctx.strokeStyle = K.color('paper'); ctx.fillStyle = K.color('ink');
    for (let l = 0; l < 44; l++) {
      const base = 420 + l * 26, x0 = 110, x1 = K.W - 110;
      ctx.beginPath(); ctx.moveTo(x0, base);
      for (let x = x0; x <= x1; x += 10) {
        const env = Math.exp(-(((x - K.CX) / 200) ** 2));
        const n = Math.max(0, K.fbm(x * 0.014, l * 0.45 + t * 3, 41) + 0.35);
        ctx.lineTo(x, base - env * n * n * 280 - 3 * K.noise1(x * 0.1 + l * 7));
      }
      ctx.lineTo(x1, base + 40); ctx.lineTo(x0, base + 40); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
  },
};
const ORDER = ['halftone', 'rhythm', 'isometric', 'liquid', 'phyllotaxis', 'poster', 'opart', 'ridgelines'];
const pick = p => {
  const count = p.count === 4 ? 4 : 8;
  const list = Array.isArray(p.looks) && p.looks.length ? p.looks : count === 4 ? ['halftone', 'rhythm', 'liquid', 'poster'] : ORDER;
  for (const name of list) if (!LOOKS[name]) throw new Error(`SCENE_PARAM: style-stinger has no look "${name}" (${ORDER.join(', ')})`);
  return list.slice(0, count);
};

SCENE.define({
  id: 'style-stinger',
  beats: p => pick(p).length / 2,
  handoff: { in: 'cut', out: 'cut' },
  impacts: p => pick(p).map((_, k) => [k * 0.25, k % 2 ? 0.25 : 0.4]),
  still: () => 0.37,
  cues(p) {
    const STABS = [[65, 68, 72], [61, 65, 68], [63, 68, 72], [61, 65, 68], [63, 67, 70], [63, 67, 70], [65, 68, 72], [67, 70, 74]];
    const c = [{ at: 0, kind: 'impact', gain: 0.7 }];
    pick(p).forEach((_, k) => {
      c.push({ at: k * 0.25, kind: 'stab', notes: STABS[k].map(n => n + (k >= 6 ? 12 : 0)) });
      c.push({ at: k * 0.25, kind: 'click', tone: 5000, gain: 0.5, pan: (k % 2 ? 1 : -1) * 0.6 });
      c.push({ at: k * 0.25, kind: 'kick', gain: k % 2 ? 0.5 : 0.8 });
    });
    return c;
  },
  setup(p) { return { looks: pick(p) }; },
  draw(ctx, t, p, s, K) {
    const k = Math.min(s.looks.length - 1, Math.floor(t / 0.25)), u = t - k * 0.25;
    const z = 1.07 - 0.07 * K.E.outExpo(u / 0.25);
    ctx.save(); K.camera(ctx, { zoom: z });
    LOOKS[s.looks[k]](ctx, u, t, p, K);
    ctx.restore();
    if (k % 2 === 0 && u < 1 / K.FPS) { ctx.fillStyle = K.rgba('paper', 0.85); ctx.fillRect(0, 0, K.W, K.H); }
  },
});
