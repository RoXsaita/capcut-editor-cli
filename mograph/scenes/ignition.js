/*
 * ignition — a dot winds up, snaps into a line, the line grows a grid, and a slab takes the frame.
 * params: { to?: palette role the slab fills with (default hot), label?: short Latin mono readout (default none) }
 * beats: 3 (1.5 s)
 * handoff: ink → params.to (a full frame of that colour, ready for a word-slam or a hard cut)
 * use: the opener, or a section break before a big claim. Pair with word-slam (bg = the same role).
 *
 * Timing (beats of 0.5 s): the dot springs in and squashes in anticipation (0–1), releases into
 * a vertical line on beat 1 (expo out), grid lines grow from the centre outward with 1-frame
 * stagger (1.4–2), a shockwave passes on beat 2, and the line swells into the slab, landing
 * exactly on the last frame (inOutExpo) so the next scene's downbeat is the hit.
 */
SCENE.define({
  id: 'ignition',
  beats: () => 3,
  handoff: p => ({ in: 'ink', out: p.to || 'hot' }),
  impacts: () => [[1.0, 0.3]],
  still: () => 1.1,
  cues: (p, K) => {
    const c = [
      { at: 0.03, kind: 'blip', f: 1760, dur: 0.25, gain: 0.9 },
      { at: 0.22, kind: 'tone', f0: 220, f1: 1100, dur: 0.28 },
      { at: 0.48, kind: 'whoosh', dur: 0.32, from: 9000, to: 1200, q: 0.25, shape: 'down', pan0: 0, pan1: 0, gain: 1.1 },
      { at: 0.5, kind: 'blip', f: 880, dur: 0.3, gain: 0.8 },
      { at: 1.0, kind: 'thud', f0: 90, f1: 40, gain: 0.6 },
      { at: 1.0, kind: 'blip', f: 440, dur: 0.6, gain: 0.6 },
      { at: 0.85, kind: 'riser', dur: 0.65, gain: 1.2 },
    ];
    for (let k = 1; k <= 7; k++) for (const s of [-1, 1]) c.push({ at: 0.7 + k * 0.03, kind: 'click', gain: 0.45, pan: s * k / 7, tone: 2500 + k * 300 });
    return c;
  },
  draw(ctx, t, p, s, K) {
    const { W, H, CX, CY, E, prog, spring } = K;
    const to = p.to || 'hot';
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, W, H);
    const GS = 120;
    ctx.lineWidth = 1.5;
    // Rows grow sideways from the centre line, columns grow up and down.
    for (let k = -8; k <= 8; k++) {
      if (!k) continue;
      const st = 0.7 + Math.abs(k) * 0.03, q = E.outExpo(prog(t, st, st + 0.45));
      if (q <= 0) continue;
      const y = CY + k * GS, len = q * (W / 2 + 20);
      ctx.strokeStyle = K.rgba('paper', 0.13);
      ctx.beginPath(); ctx.moveTo(CX - len, y); ctx.lineTo(CX + len, y); ctx.stroke();
      if (q < 0.98) { ctx.fillStyle = K.rgba('paper', 0.9 * (1 - q)); ctx.fillRect(CX - len - 2, y - 2, 4, 4); ctx.fillRect(CX + len - 2, y - 2, 4, 4); }
    }
    for (let k = -4; k <= 4; k++) {
      if (!k) continue;
      const st = 0.84 + Math.abs(k) * 0.04, q = E.outExpo(prog(t, st, st + 0.5));
      if (q <= 0) continue;
      const x = CX + k * GS, len = q * (H / 2 + 20);
      ctx.strokeStyle = K.rgba('paper', 0.13);
      ctx.beginPath(); ctx.moveTo(x, CY - len); ctx.lineTo(x, CY + len); ctx.stroke();
    }
    for (let i = -4; i <= 3; i++) for (let j = -8; j <= 7; j++) {
      const st = 1.0 + K.hash(i + 20, j + 20, 3) * 0.2, a = prog(t, st, st + 0.08) * 0.5;
      if (a <= 0) continue;
      ctx.fillStyle = K.rgba('paper', a);
      const x = CX + i * GS + GS / 2, y = CY + j * GS + GS / 2;
      ctx.fillRect(x - 6, y - 0.75, 12, 1.5); ctx.fillRect(x - 0.75, y - 6, 1.5, 12);
    }
    // The dot: appear, anticipate (flatten), release into a vertical line.
    ctx.fillStyle = K.color('paper');
    if (t < 0.5) {
      const r = 12 * spring(t - 0.03, 2.2, 0.42), a = E.inOutCubic(prog(t, 0.26, 0.5));
      ctx.beginPath(); ctx.ellipse(CX, CY, Math.max(0, r * (1 + 0.6 * a)), Math.max(0, r * (1 - 0.55 * a)), 0, 0, K.TAU); ctx.fill();
    } else {
      const q = E.outExpo(prog(t, 0.5, 0.86)), half = K.lerp(12, H * 0.56, q);
      const th = K.lerp(12, 3, E.outCubic(prog(t, 0.5, 0.72)));
      ctx.beginPath(); ctx.roundRect(CX - th / 2, CY - half, th, half * 2, th / 2); ctx.fill();
    }
    for (const [st, role, w] of [[1.0, 'paper', 7], [1.07, to === 'ink' ? 'hot' : to, 4]]) {
      const q = prog(t, st, st + 0.45);
      if (q <= 0 || q >= 1) continue;
      ctx.strokeStyle = K.rgba(role, 1 - q); ctx.lineWidth = w * (1 - q) + 0.5;
      K.circle(ctx, CX, CY, E.outExpo(q) * 900); ctx.stroke();
    }
    // Readouts riding the line.
    const ra = prog(t, 0.6, 0.72) * (1 - prog(t, 1.12, 1.2));
    if (ra > 0) {
      ctx.font = K.font(400, 22, 'mono'); ctx.fillStyle = K.rgba('paper', 0.6 * ra);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left'; ctx.fillText(`T+${t.toFixed(3)}s`, CX + 26, CY - 60);
      ctx.fillText(`${K.BPM} BPM`, CX + 26, CY + 80);
      ctx.textAlign = 'right'; ctx.fillText(`F${String(Math.floor(t * K.FPS)).padStart(3, '0')}`, CX - 26, CY - 60);
      if (p.label) ctx.fillText(K.scramble(String(p.label).toUpperCase(), prog(t, 0.6, 0.95), t, 3), CX - 26, CY + 80);
    }
    // The line swells into the slab, landing on the last frame.
    const q = E.inOutExpo(prog(t, 1.16, 1.5));
    if (q > 0) { ctx.fillStyle = K.color(to); ctx.fillRect(CX - (q * W) / 2 - 2, 0, q * W + 4, H); }
  },
});
