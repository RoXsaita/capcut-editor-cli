/*
 * frame-travel — the house layout frame as one travelling border: the brand stroke around the watched picture changes shape with each cut (seam strip → card → gone on a full-screen shot → back), instead of each layout bringing its own frame.
 * params: { keys: [{ at: seconds into the clip, to: shape, frames?: move length (default 8, 6 when it leaves) }], beats: clip length in beats, stroke?: px (default 8), radius?: px (default 0, the house frame's square corners) }
 *   shape: [x, y, w, h] the picture's rect (the stroke sits just outside it, so a picture or panel on a track above never covers it),
 *   or { box, stroke?, radius? }, or "seam" (the split-screen seam bar: the face panel under the centre seam, as the native layout overlay draws it),
 *   "full" (the canvas: the frame grows to the edges and is gone, since a full-screen shot has no border) or "none" (fades out where it is);
 *   a box after "full"/"none" grows back out of 92 % of itself.
 * beats: as declared (whole half beats); place one clip over the stretch where the native frame is not already drawn
 * handoff: footage → footage
 * use: every edit with boxed or inset shots. Key a move on each cut where the framed picture changes shape: an arrival starts on the cut, a leave 2 frames before it (so the cut lands mid-move and the old box never sits over the full-screen shot); a full-face or full-frame shot gets "full". Put it on a `layout-frame` track above the face and layout tracks and below the overlays on top of the picture, with desc `layout:frame-travel`.
 *
 * Timing: the first key's `to` is the frame on the clip's first frame; every later key moves from
 * the previous shape to its own over `frames` frames, starting at its `at` (SETTLE: the cut has already changed the picture, so the frame arrives with motion spent
 * evenly over the move instead of jumping in its middle frames). Opacity resolves before the movement: leaving for "full"/"none" it is gone by 80 % of the
 * move; arriving from one it is fully in by 60 %. Position, size, stroke and corner radius all
 * move together. A faint whoosh on each move. No grain, so the stroke matches the native artwork.
 * Render it with --samples 16: an edge crossing 700 px in a few frames strobes at the default 5.
 */
const SEAM = { box: [-216.5, 940.8, 1513, 1203.5], stroke: 6, radius: 0 };

function shapeOf(to, p, prev, K) {
  const stroke = p.stroke != null ? Number(p.stroke) : 8, radius = p.radius != null ? Number(p.radius) : 0;
  if (to === 'seam') return { ...SEAM, box: SEAM.box.slice(), a: 1 };
  if (to === 'full') return { box: [0, 0, K.W, K.H], stroke, radius: 0, a: 0 };
  if (to === 'none') {
    if (!prev) throw new Error('SCENE_PARAM: frame-travel "none" needs a shape before it');
    return { ...prev, box: prev.box.slice(), a: 0 };
  }
  const o = Array.isArray(to) ? { box: to } : to;
  if (!o || !Array.isArray(o.box) || o.box.length !== 4 || !o.box.every(Number.isFinite)) {
    throw new Error('SCENE_PARAM: frame-travel shape is [x, y, w, h], { box }, "seam", "full" or "none"');
  }
  return { box: o.box.map(Number), stroke: o.stroke != null ? Number(o.stroke) : stroke, radius: o.radius != null ? Number(o.radius) : radius, a: 1 };
}

const grown = (s, k) => {
  const [x, y, w, h] = s.box;
  return { ...s, box: [x + (w * (1 - k)) / 2, y + (h * (1 - k)) / 2, w * k, h * k], a: 0 };
};
const keysOf = p => (Array.isArray(p.keys) ? p.keys : []);

SCENE.define({
  id: 'frame-travel',
  beats: p => Number(p.beats),
  alpha: true,
  grain: false,
  handoff: { in: 'footage', out: 'footage' },
  still: (p, K) => {
    const s = (K.duration || 1);
    const k = keysOf(p)[0];
    return Math.min(s - 1 / K.FPS, (k ? Number(k.at) || 0 : 0) + 10 / K.FPS);
  },
  cues: (p, K) => keysOf(p).slice(1).filter(k => Number(k.at) < K.b(Number(p.beats)))
    .map(k => ({ at: Number(k.at), kind: 'whoosh', gain: 0.08, dur: 0.22 })),
  setup(p, K) {
    const keys = keysOf(p);
    if (!keys.length) throw new Error('SCENE_PARAM: frame-travel needs keys: [{ at, to }]');
    if (!(Number(p.beats) > 0)) throw new Error('SCENE_PARAM: frame-travel needs beats (the clip length)');
    const SETTLE = K.cubicBezier(0.25, 0.4, 0.35, 1);
    let prev = null, last = -1;
    const moves = keys.map((k, i) => {
      const at = Number(k.at);
      if (!(at >= 0) || at < last) throw new Error('SCENE_PARAM: frame-travel keys need increasing `at` from 0');
      last = at;
      const to = shapeOf(k.to, p, prev, K);
      const leaving = to.a === 0;
      // Back from "full"/"none", the frame grows out of its own box (92 %), never in from the canvas
      // edges across whatever sits around the picture.
      const from = !prev ? to : prev.a === 0 && to.a > 0 ? grown(to, 0.92) : prev;
      const frames = i === 0 ? 0 : (k.frames != null ? Number(k.frames) : leaving ? 6 : 8);
      prev = to;
      return { at, dur: frames / K.FPS, from, to };
    });
    return { moves, ease: SETTLE };
  },
  draw(ctx, t, p, s, K) {
    const { lerp, prog, E } = K;
    let cur = s.moves[0].to;
    for (const m of s.moves.slice(1)) {
      if (t < m.at) break;
      const q = m.dur > 0 ? prog(t, m.at, m.at + m.dur) : 1, e = s.ease(q);
      const a = m.to.a < m.from.a ? 1 - E.outCubic(prog(q, 0, 0.8))
        : m.to.a > m.from.a ? E.outCubic(prog(q, 0, 0.6)) : m.to.a;
      cur = {
        box: m.from.box.map((v, i) => lerp(v, m.to.box[i], e)),
        stroke: lerp(m.from.stroke, m.to.stroke, e), radius: lerp(m.from.radius, m.to.radius, e), a,
      };
    }
    if (cur.a <= 0.002) return;
    const [x, y, w, h] = cur.box, sw = cur.stroke;
    // The stroke's centre line sits half a stroke outside the picture's rect.
    const path = () => {
      ctx.beginPath();
      ctx.roundRect(x - sw / 2, y - sw / 2, w + sw, h + sw, cur.radius > 0 ? cur.radius + sw / 2 : 0);
    };
    ctx.save();
    ctx.globalAlpha = cur.a;
    ctx.strokeStyle = K.color('brand');
    // The house glow, measured off the native frame artwork: ~23 % at the stroke, ~8 % at 20 px,
    // a faint tail to ~60 px, the same on both sides.
    ctx.filter = 'blur(14px)'; ctx.lineWidth = sw * 1.25; ctx.globalAlpha = cur.a * 0.68; path(); ctx.stroke();
    ctx.filter = 'blur(36px)'; ctx.lineWidth = sw * 1.5; ctx.globalAlpha = cur.a * 0.5; path(); ctx.stroke();
    ctx.filter = 'none'; ctx.lineWidth = sw; ctx.globalAlpha = cur.a; path(); ctx.stroke();
    ctx.restore();
  },
});
