/*
 * seam-wipe — the house chapter transition: an ink band opens out of the 12px centre seam, optionally lands one chapter word on a brand slab, and collapses back into the seam, revealing the next shot.
 * params: { text?: 1–3 word chapter label, beats?: 1–4 in half steps (default 1 without text, 3 with) }
 * beats: 1 (0.5 s) bare, 3 (1.5 s) with a label
 * handoff: seam → seam
 * use: a meaningful chapter change between two shots, never every cut; at most two per video.
 *
 * Timing: the band opens from the seam over 0.3 seconds (outExpo, K.aperture) with 6px moving
 * edges, and the last 0.26 seconds collapse back into the seam (inExpo). Place it across the cut
 * so the cut lands while the band is fully open: bare, the band covers the frame 0.17–0.24 s in, so
 * `at` = cut − 0.2; with a label it stays open 0.25–1.2 s in. A label slab grows from its reading-start edge
 * over 0.34 s (outExpo) once the band is open, its word rising inside it (0.36 s, enter), and
 * retracts toward the reading end 0.2 s before the collapse. A whoosh under the open, a click on
 * the label.
 */
const words = p => String(p.text || '').trim().split(/\s+/).filter(Boolean);
const length = p => (p.beats != null ? Number(p.beats) : words(p).length ? 3 : 1);

SCENE.define({
  id: 'seam-wipe',
  beats: p => length(p),
  alpha: true,
  handoff: { in: 'seam', out: 'seam' },
  still: (p, K) => (words(p).length ? K.b(1.6) : K.b(0.5)),
  cues: (p, K) => [{ at: 0, kind: 'whoosh', gain: 0.22 },
    ...(words(p).length ? [{ at: K.b(0.7), kind: 'click', tone: 1100, dur: 0.035, gain: 0.18 }] : [])],
  setup(p, K) {
    const n = length(p);
    if (!(n >= 1 && n <= 4)) throw new Error('SCENE_PARAM: seam-wipe beats must be 1–4');
    const text = words(p).join(' ');
    if (words(p).length > 3) throw new Error('SCENE_PARAM: seam-wipe text takes 1–3 words');
    if (text && n < 2.5) throw new Error('SCENE_PARAM: seam-wipe needs beats ≥ 2.5 to land a label');
    let transition = 'brand';
    try { K.color('transition'); transition = 'transition'; } catch { /* Neutral profiles use their brand role. */ }
    const c = document.createElement('canvas').getContext('2d');
    c.font = K.font(700, 96);
    const w = text ? c.measureText(text).width + 120 : 0;
    if (w > K.safe.w) throw new Error('SCENE_PARAM: seam-wipe text is too wide; shorten the label');
    return { text, w, transition };
  },
  draw(ctx, t, p, s, K) {
    const { W, H, E, prog, b } = K;
    const seam = H / 2;
    const half = K.aperture(t);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, seam - half, W, half * 2); ctx.clip();
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, W, H);
    if (s.text) {
      const h = 150, x = K.CX - s.w / 2, y = seam - h / 2;
      const rtl = K.isArabic(s.text);
      const out = K.duration - b(0.52) - 0.2;
      const grow = E.outExpo(prog(t, b(0.6), b(0.6) + 0.34));
      const rise = E.outCubic(prog(t, b(0.6) + 0.06, b(0.6) + 0.42));
      const close = E.inCubic(prog(t, out - 0.2, out));
      // Open from the reading start, retract toward the reading end.
      let L = rtl ? x + s.w * (1 - grow) : x, R = rtl ? x + s.w : x + s.w * grow;
      if (rtl) R -= (R - x) * close; else L += (x + s.w - L) * close;
      if (R - L > 0.5) {
        ctx.save();
        ctx.fillStyle = K.color('brand'); ctx.fillRect(L, y, R - L, h);
        ctx.beginPath(); ctx.rect(L, y, R - L, h); ctx.clip();
        ctx.font = K.font(700, 96); ctx.fillStyle = K.color('text');
        K.text(ctx, s.text, K.CX, y + h / 2 + (1 - rise) * h * 0.9, { align: 'center', baseline: 'middle' });
        ctx.restore();
      }
    }
    ctx.restore();
    K.seamMarks(ctx, t, half, s.transition);
  },
});
