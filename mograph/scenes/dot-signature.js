/*
 * dot-signature — a dot arrives, travels to the start of a name and writes it in reading direction, landing as its full stop; a rule draws and the role resolves under it.
 * params: { name: the name or handle, role?: a short line under it, footer?: a Latin mono line near the bottom, hold?: extra beats to hold (default 2) }
 * beats: 3 + hold (2.5 s by default)
 * handoff: ink → ink (the name card itself; end the video on it)
 * use: the sign-off. The dot is the same motif as ignition's and word-slam's, so a video that opens with a dot closes on one.
 *
 * Timing: the dot springs in with a ripple (0–0.3 beat), travels to the start of the name
 * (inOutCubic, stretched by its speed), then writes it: the name is masked to the side the dot
 * has passed, and each word rises a little as it is revealed (inOutQuart over one beat). The
 * dot lands with squash; the rule draws from the centre, the role reads in, and the dot gives
 * one heartbeat on the last beat of the hold.
 */
SCENE.define({
  id: 'dot-signature',
  beats: p => 3 + (p.hold == null ? 2 : Math.max(0, Math.round(Number(p.hold) * 2) / 2)),
  handoff: { in: 'ink', out: 'ink' },
  impacts: () => [[0, 0.8]],
  still: p => Math.min(1.4, (3 + (p.hold == null ? 2 : Number(p.hold))) * 0.5 - 0.1),
  setup(p, K) {
    if (!String(p.name || '').trim()) throw new Error('SCENE_PARAM: dot-signature needs params.name');
    const name = String(p.name).trim();
    const c = document.createElement('canvas').getContext('2d');
    c.font = K.font(700, 200);
    const size = Math.min(200, Math.floor((200 * (K.safe.w - 120)) / Math.max(1, c.measureText(name).width)));
    c.font = K.font(700, size);
    const layout = K.words(c, name);
    const rtl = layout.rtl, r = Math.max(12, size * 0.085), gap = size * 0.08;
    const total = layout.width + gap + 2 * r;
    const left = K.CX - total / 2 + (rtl ? gap + 2 * r : 0);
    const bl = K.safe.y + K.safe.h * 0.47;
    const start = rtl ? left + layout.width + r : left - r;               // where writing begins
    const end = rtl ? left - gap - r : left + layout.width + gap + r;     // the full stop
    return { name, size, layout, rtl, r, left, bl, start, end };
  },
  cues(p, K) {
    const c = [
      { at: 0, kind: 'impact', gain: 1.1 },
      { at: 0.03, kind: 'blip', f: 1760, dur: 0.3, gain: 0.9 },
      { at: 0.16, kind: 'whoosh', dur: 0.22, from: 3000, to: 900, shape: 'bell', pan0: 0.2, pan1: -0.5, gain: 0.6 },
      { at: 0.36, kind: 'whoosh', dur: 0.5, from: 1500, to: 6000, shape: 'bell', q: 0.8, gain: 0.55 },
      { at: 0.86, kind: 'thud', f0: 220, f1: 90, gain: 0.6 },
      { at: 0.86, kind: 'blip', f: 880, dur: 0.4, gain: 0.7 },
    ];
    [53, 60, 65, 68, 72].forEach((n, i) => c.push({ at: 0.86 + i * 0.045, kind: 'bell', note: n + 12, gain: 0.9 - i * 0.1, pan: (i - 2) / 3, dur: 1.2 }));
    if (p.role) for (let k = 0; k < 10; k++) c.push({ at: 0.7 + k * 0.035, kind: 'click', gain: 0.25, pan: (k % 3 - 1) * 0.3, tone: 6000 });
    const end = K.duration;
    c.push({ at: end - 0.25, kind: 'thud', f0: 70, f1: 38, gain: 0.5 }, { at: end - 0.25, kind: 'bell', note: 89, gain: 0.5, dur: 0.8 });
    return c;
  },
  draw(ctx, t, p, s, K) {
    const { W, H, CX, E, prog, lerp, clamp } = K;
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, W, H);
    const push = 1 + 0.03 * E.outCubic(prog(t, 0, K.duration));
    ctx.save(); K.camera(ctx, { zoom: push });
    const { r, bl, start, end, rtl } = s;
    const yDot = bl - r;
    const pA = E.inOutCubic(prog(t, 0.16, 0.36)), pB = E.inOutQuart(prog(t, 0.36, 0.86));
    const dotX = t < 0.36 ? lerp(CX, start, pA) : lerp(start, end, pB);
    const ahead = t < 0.36 ? E.inOutCubic(prog(t + 0.01, 0.16, 0.36)) - pA : E.inOutQuart(prog(t + 0.01, 0.36, 0.86)) - pB;
    const stretch = clamp(Math.abs(ahead) * (t < 0.36 ? 20 : 45), 0, 1.4);
    const rp = prog(t, 0.02, 0.5);
    if (rp > 0 && rp < 1) { ctx.strokeStyle = K.rgba('hot', 0.8 * (1 - rp)); ctx.lineWidth = 3 * (1 - rp) + 0.5; K.circle(ctx, CX, yDot, E.outExpo(rp) * 260); ctx.stroke(); }

    // The name, revealed on the side the dot has passed.
    ctx.save(); ctx.beginPath();
    if (t < 0.36) ctx.rect(0, 0, 0, 0);
    else if (rtl) ctx.rect(dotX + r * 0.2, 0, W, H);
    else ctx.rect(0, 0, dotX - r * 0.2, H);
    ctx.clip();
    ctx.font = K.font(700, s.size); ctx.fillStyle = K.color('text');
    for (const it of s.layout.items) {
      const edge = rtl ? s.left + it.x + it.width : s.left + it.x;
      const rt = t < 0.36 ? 99 : 0.36 + prog(Math.abs(edge - start), 0, Math.abs(end - start)) * 0.45;
      const q = E.outCubic(prog(t, rt, rt + 0.3));
      ctx.globalAlpha = clamp(0.2 + q * 1.2);
      ctx.direction = K.dir(it.word);
      ctx.fillText(it.word, s.left + it.x, bl + (1 - q) * 30);
    }
    ctx.globalAlpha = 1; ctx.direction = 'ltr'; ctx.restore();
    if (t > 0.95) K.mark(s.left, bl - s.size * 0.85, s.layout.width, s.size * 1.2, s.name);

    // The dot: squash on landing, one heartbeat at the end.
    const land = t > 0.86 ? K.wobble(t - 0.86, 12, 34) : 0;
    const beat = Math.sin(Math.PI * prog(t, K.duration - 0.3, K.duration - 0.05)) ** 2;
    const sc = K.spring(t - 0.02, 2.4, 0.4) * (1 + 0.35 * beat);
    ctx.fillStyle = K.color('hot');
    ctx.beginPath();
    ctx.ellipse(dotX, yDot + r * 0.3 * land, Math.max(0, r * sc * (1 + stretch * 0.9 + 0.25 * land)), Math.max(0, r * sc * (1 - stretch * 0.3 - 0.3 * land)), 0, 0, K.TAU);
    ctx.fill();

    // Rule, role, footer.
    const lp = E.outExpo(prog(t, 0.62, 1.0));
    ctx.fillStyle = K.rgba('text', 0.28); ctx.fillRect(CX - 300 * lp, bl + s.size * 0.3, 600 * lp, 1.5);
    if (p.role) {
      const role = String(p.role), q = prog(t, 0.7, 1.08);
      ctx.fillStyle = K.rgba('text', 0.85);
      if (K.isArabic(role)) {
        ctx.font = K.font(600, 44); ctx.globalAlpha = E.outCubic(q);
        K.text(ctx, role, CX, bl + s.size * 0.3 + 78 + (1 - E.outCubic(q)) * 12, { align: 'center' });
        ctx.globalAlpha = 1;
      } else {
        ctx.font = K.font(600, 30); ctx.letterSpacing = '12px';
        if (q > 0) K.text(ctx, K.scramble(role.toUpperCase(), q, t, 7), CX + 6, bl + s.size * 0.3 + 72, { align: 'center' });
        ctx.letterSpacing = '0px';
      }
    }
    if (p.footer) {
      const fa = prog(t, 0.9, 1.2);
      ctx.font = K.font(400, 20, 'mono'); ctx.fillStyle = K.rgba('muted', 0.95); ctx.globalAlpha = fa;
      K.text(ctx, String(p.footer).toUpperCase(), CX, K.safe.y + K.safe.h - 60, { align: 'center' });
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  },
});
