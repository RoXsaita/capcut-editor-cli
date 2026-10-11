/*
 * claude-brief — a clean first phrase lands upright, then a personal reply appears in a brand slab; overlay presentation keeps both plaques transparent outside their bounds.
 * params: { text: short first phrase, then: short second phrase, presentation?: "full" | "overlay" (default "full") }
 * beats: 5 (2.5 s at 120 BPM)
 * handoff: full: seam → seam; overlay: footage → footage
 * use: a reference-to-personal-result brief with two concise phrases. Once per video.
 *
 * Timing: full presentation opens from the centre seam over 0.3 seconds (outExpo). Overlay
 * plaques settle onto the same phrase hits in x70–930/y230–600, then clear before the last frame.
 * The first phrase
 * resolves on beat 0.6; the second lands on beat 1.4, as whole joined words with a restrained
 * vertical settle. The final 0.26-second inExpo collapse reveals the footage again.
 */
SCENE.define({
  id: 'claude-brief',
  beats: () => 5,
  alpha: true,
  handoff: p => p.presentation === 'overlay'
    ? { in: 'footage', out: 'footage' } : { in: 'seam', out: 'seam' },
  still: (_, K) => K.b(3.4),
  cues: (_, K) => [0.6, 1.4].map((beat, i) => ({ at: K.b(beat), kind: 'click', tone: 1100 + i * 240, dur: 0.035, gain: 0.18 })),
  setup(p, K) {
    const presentation = p.presentation === undefined ? 'full' : p.presentation;
    if (!['full', 'overlay'].includes(presentation)) {
      throw new Error('SCENE_PARAM: claude-brief presentation must be "full" or "overlay"');
    }
    const c = document.createElement('canvas').getContext('2d');
    for (const [key, size] of [['text', 180], ['then', 140]]) {
      c.font = K.font(700, size);
      if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > 20
        || c.measureText(p[key].trim()).width > K.safe.w - 140) {
        throw new Error(`SCENE_PARAM: claude-brief ${key} needs a short readable phrase`);
      }
    }
    c.font = K.font(700, 140);
    const slabW = c.measureText(p.then.trim()).width + 100;
    let transition = 'brand';
    try { K.color('transition'); transition = 'transition'; } catch { /* Neutral profiles use their brand role. */ }
    const text = p.text.trim(), then = p.then.trim();
    c.font = K.font(700, 82);
    const overlayWidths = [text, then].map(value => Math.max(300, c.measureText(value).width + 64));
    if (presentation === 'overlay' && overlayWidths.some(width => width > 820)) {
      throw new Error('SCENE_PARAM: claude-brief overlay phrase is too wide; shorten the copy');
    }
    return { text, then, slabW, transition, presentation, overlayWidths };
  },
  draw(ctx, t, p, s, K) {
    const { W, H, E, prog, b } = K;
    if (s.presentation === 'overlay') {
      const cx = 500;
      const end = K.duration - 3 / K.FPS;
      const clear = E.outExpo(prog(t, end - b(0.5), end));
      for (const [i, item] of [
        { text: s.text, y: 340, at: b(0.3), hit: b(0.6), fill: 'paper', fg: 'ink' },
        { text: s.then, y: 500, at: b(1.1), hit: b(1.4), fill: 'brand', fg: 'text' },
      ].entries()) {
        const arrive = E.outBack(prog(t, item.at, item.hit));
        const alpha = E.outExpo(prog(t, item.at, item.hit)) * (1 - clear);
        if (alpha <= 0) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(cx, item.y + (1 - arrive) * 16);
        ctx.scale(0.94 + arrive * 0.06, 0.94 + arrive * 0.06);
        ctx.fillStyle = K.color(item.fill);
        ctx.fillRect(-s.overlayWidths[i] / 2, -56, s.overlayWidths[i], 112);
        ctx.font = K.font(700, 82); ctx.fillStyle = K.color(item.fg);
        K.text(ctx, item.text, 0, 0, { align: 'center', baseline: 'middle' });
        ctx.restore();
      }
      return;
    }
    const seam = H / 2, end = K.duration - 1.5 / K.FPS;
    const open = E.outExpo(prog(t, 0, b(0.6)));
    const close = E.inExpo(prog(t, end - b(0.52), end));
    const half = t <= 0.5 / K.FPS || t >= end ? 0 : seam * open * (1 - close);
    const cx = K.safe.x + K.safe.w / 2;
    const firstY = K.safe.y + K.safe.h * 0.42;
    const secondY = firstY + 270;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, seam - half, W, half * 2); ctx.clip();
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, W, H);
    const first = E.outExpo(prog(t, b(0.6), b(1.1)));
    ctx.globalAlpha = first;
    ctx.font = K.font(700, 180); ctx.fillStyle = K.color('text');
    K.text(ctx, s.text, cx, firstY + (1 - first) * 28, { align: 'center' });

    const second = E.outExpo(prog(t, b(1.4), b(1.94)));
    const settle = secondY + (1 - second) * 28;
    ctx.globalAlpha = second;
    ctx.fillStyle = K.color('brand');
    ctx.fillRect(cx - s.slabW / 2, settle - 142, s.slabW, 204);
    ctx.font = K.font(700, 140); ctx.fillStyle = K.color('text');
    K.text(ctx, s.then, cx, settle, { align: 'center' });
    ctx.restore();

    const lineA = K.clamp(1 - E.outExpo(prog(t, b(0.1), b(0.7)))
      + E.outExpo(prog(t, K.duration - b(0.66), K.duration - b(0.26))) + (half < 4 ? 1 : 0));
    if (lineA > 0.01) {
      ctx.fillStyle = K.rgba(s.transition, lineA); ctx.fillRect(0, seam - 6, W, 12);
    }
    if (half > 1 && half < seam - 1) {
      ctx.fillStyle = K.color(s.transition);
      ctx.fillRect(0, seam - half - 3, W, 6); ctx.fillRect(0, seam + half - 3, W, 6);
    }
  },
});
