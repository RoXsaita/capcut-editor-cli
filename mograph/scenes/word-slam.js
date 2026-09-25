/*
 * word-slam — a claim slams up through its baseline, glitches, a second line lands and shoves it, and the camera dives through the full stop.
 * params: { text: 1–3 words, then?: 1–3 words that land under it, caption?: a short line, bg?: hot|brand|ink|paper|accent (default hot), to?: palette role | "footage" (default paper) }
 * beats: 5 (2.5 s)
 * handoff: params.bg → params.to ("footage" makes the dive a transparent hole: the scene is an alpha transition into the next shot)
 * use: the hook or the one claim a video is about. After ignition (to = the same role as bg). Once per video.
 *
 * Timing: words spring up through a mask by WORD in reading order (never by letter: Arabic
 * joins), 0.06 s stagger (beat 0–1). Slice glitch with a two-colour split on beat 1, stepping at
 * 24 fps. `then` falls on gravity and lands on beat 2 with squash; its impact knocks the first
 * line up. The full stop pops on beat 2. Outline echoes of the last line spring out on beat 3.
 * Beat 4: the stop squashes (anticipation), then the camera dives into it (inExpo, ×60).
 */
const ON = { hot: 'ink', brand: 'text', ink: 'text', paper: 'ink', accent: 'ink' };
const SPLIT = { hot: ['brand', 'paper'], brand: ['hot', 'accent'], ink: ['hot', 'brand'], paper: ['hot', 'brand'], accent: ['brand', 'hot'] };

SCENE.define({
  id: 'word-slam',
  beats: () => 5,
  alpha: p => p.to === 'footage',
  handoff: p => ({ in: p.bg || 'hot', out: p.to || 'paper' }),
  impacts: p => [[0.0, 0.9], [0.5, 0.6], ...(p.then ? [[1.0, 0.45]] : [])],
  still: () => 1.7,
  setup(p, K) {
    if (!String(p.text || '').trim()) throw new Error('SCENE_PARAM: word-slam needs params.text');
    const bg = p.bg || 'hot';
    if (!ON[bg]) throw new Error(`SCENE_PARAM: word-slam bg must be one of ${Object.keys(ON).join(', ')}`);
    const c = document.createElement('canvas').getContext('2d');
    const fit = (str, base, max) => {
      c.font = K.font(700, base);
      const w = K.words(c, str).width;
      return Math.floor(Math.min(base, (base * max) / Math.max(1, w)));
    };
    // A line that would shrink below ~62% of the base size wraps into two balanced lines.
    const wrap = (str, base, cap) => {
      const one = Math.min(cap, fit(str, base, K.safe.w - 40));
      const parts = String(str).trim().split(/\s+/);
      if (one >= base * 0.62 || parts.length < 2) return [{ str: parts.join(' '), size: one }];
      let best = null;
      for (let i = 1; i < parts.length; i++) {
        const a = parts.slice(0, i).join(' '), b = parts.slice(i).join(' ');
        const size = Math.min(cap, fit(a, base, K.safe.w - 40), fit(b, base, K.safe.w - 40));
        if (!best || size > best.size) best = { size, a, b };
      }
      return [{ str: best.a, size: best.size }, { str: best.b, size: best.size }];
    };
    const A = wrap(p.text, 250, 250).map(L => ({ ...L, g: 0 }));
    const B = p.then ? wrap(p.then, 270, Math.round(A[0].size * 1.08)).map(L => ({ ...L, g: 1 })) : [];
    const lines = [...A, ...B];
    let n = 0;
    for (const L of lines) {
      c.font = K.font(700, L.size);
      L.layout = K.words(c, L.str);
      L.x0 = K.CX - L.layout.width / 2;
      if (L.g === 0) { L.first = n; n += L.layout.items.length; }
    }
    // The block sits on the optical centre of the safe box; `then` lines stack under the text.
    const lh = L => L.size * 1.08;
    let y = K.safe.y + K.safe.h * 0.52 - lines.reduce((a, L) => a + lh(L), 0) / 2;
    for (const L of lines) { L.bl = y + L.size * 0.82; y += lh(L); }
    const shiftA = B.reduce((a, L) => a + lh(L), 0) / 2;
    const last = lines[lines.length - 1];
    const r = Math.max(14, last.size * 0.085);
    const dot = { r, x: last.layout.rtl ? last.x0 - r * 2.2 : last.x0 + last.layout.width + r * 2.2, y: last.bl - r };
    return { bg, on: ON[bg], split: SPLIT[bg], lines, lastA: A[A.length - 1], dot, shiftA };
  },
  cues(p, K) {
    const n = String(p.text || '').trim().split(/\s+/).length;
    const c = [{ at: 0, kind: 'impact', gain: 1 }];
    for (let i = 0; i < n; i++) c.push({ at: 0.02 + i * 0.06, kind: 'thud', f0: 200 - i * 10, f1: 70, gain: 0.5 }, { at: 0.02 + i * 0.06, kind: 'click', tone: 2200, gain: 0.6, pan: (i - n / 2) / 3 });
    c.push({ at: 0.5, kind: 'glitch', dur: 0.34 });
    if (p.then) c.push({ at: 0.72, kind: 'tone', f0: 1500, f1: 200, dur: 0.28 }, { at: 1.0, kind: 'thud', f0: 160, f1: 50, gain: 0.9 }, { at: 1.0, kind: 'click', tone: 1200, gain: 0.8 });
    c.push({ at: 1.0, kind: 'blip', note: 84, dur: 0.4, gain: 0.5 });
    if (p.caption) c.push({ at: 1.05, kind: 'blip', note: 91, dur: 0.12, gain: 0.3 });
    c.push({ at: 1.45, kind: 'whoosh', dur: 0.35, from: 600, to: 4000, shape: 'bell', gain: 0.7 });
    c.push({ at: 1.9, kind: 'riser', dur: 0.6, f0: 120, f1: 2200, gain: 1.1 });
    c.push({ at: 2.0, kind: 'whoosh', dur: 0.5, from: 200, to: 12000, q: 0.3, pan0: 0, pan1: 0, gain: 1.4 });
    return c;
  },
  draw(ctx, t, p, s, K) {
    const { W, H, CX, E, prog, spring, lerp } = K;
    const { lines, dot } = s;
    const to = p.to || 'paper';
    const footage = to === 'footage';
    ctx.fillStyle = K.color(s.bg); ctx.fillRect(0, 0, W, H);

    // Camera: slow push, then the dive into the full stop.
    const dive = E.inExpo(prog(t, 2.0, 2.5));
    const zoom = (1 + 0.03 * t) * Math.exp(Math.log(60) * dive);
    const fp = E.inOutCubic(prog(t, 1.85, 2.25));
    ctx.save();
    K.camera(ctx, { x: lerp(CX, dot.x, fp), y: lerp(K.CY, dot.y, fp), zoom });
    const readable = zoom < 1.08;

    // The text group sits centred alone, then rises when `then` lands, and takes the knock.
    const two = s.shiftA > 0;
    const lift = two ? E.inOutExpo(prog(t, 0.66, 0.96)) : 0;
    const knock = two && t >= 1.0 ? K.wobble(t - 1.0, 9, 26) : 0;
    const blOf = L => (L.g === 0 ? L.bl + (1 - lift) * s.shiftA - 22 * knock : L.bl);
    const last = lines[lines.length - 1];

    // Guides.
    const ga = 1 - prog(t, 1.8, 2.0);
    lines.forEach((L, li) => {
      const g = E.outExpo(prog(t, 0.05 + li * 0.1, 0.55 + li * 0.1)) * ga;
      if (g <= 0) return;
      ctx.fillStyle = K.rgba(s.on, 0.25 * g);
      ctx.fillRect(0, blOf(L) - 0.75, W * g, 1.5);
      ctx.font = K.font(400, 18, 'mono'); ctx.fillStyle = K.rgba(s.on, 0.55 * g);
      ctx.fillText(`BASELINE ${Math.round(blOf(L))}`, 40, blOf(L) - 12);
    });

    // Outline echoes: the first line repeats upward, the last line downward, scrolling in
    // alternating directions. Decorative, so drawn with strokeText (not K.text).
    if (t > 1.45) {
      ctx.strokeStyle = K.color(s.on); ctx.lineWidth = 2.5;
      for (const [L, sg] of [[lines[0], -1], [last, 1]]) {
        ctx.font = K.font(700, L.size); ctx.direction = K.dir(L.str);
        for (let k = 1; k <= 3; k++) {
          const sp = spring(t - 1.48 - k * 0.05, 1.9, 0.55);
          const y = blOf(L) + sg * (k + (p.caption && sg > 0 ? 0.45 : 0)) * L.size * 1.08 * sp;
          const x = L.x0 + (k % 2 ? 1 : -1) * sg * (t - 1.45) * 260 * (0.6 + 0.4 * k);
          ctx.globalAlpha = K.clamp(sp) * (1 - (k - 1) * 0.22);
          ctx.strokeText(L.str, x, y);
        }
      }
      ctx.globalAlpha = 1; ctx.direction = 'ltr';
    }

    // Words.
    const drawn = [];
    for (const L of lines) {
      for (const it of L.layout.items) {
        let y, sx = 1, sy = 1, rot = 0;
        if (L.g === 0) {
          const k = L.first + it.index, st = 0.02 + k * 0.06, sp = spring(t - st, 2.0, 0.5);
          y = blOf(L) + (1 - sp) * L.size * 1.15; rot = (1 - sp) * 0.18 * (k % 2 ? 1 : -1);
        } else {
          const st = 0.7 + it.index * 0.04, fall = E.inQuad(prog(t, st, 1.0));
          if (t < st) continue;
          const sq = t > 1.0 ? K.wobble(t - 1.0, 9, 30) : 0;
          y = lerp(L.bl - H, L.bl, fall);
          sx = t < 1.0 ? 1 - 0.1 * fall : 1 + 0.16 * sq; sy = t < 1.0 ? 1 + 0.25 * fall : 1 - 0.24 * sq;
        }
        drawn.push({ L, it, y, sx, sy, rot });
      }
    }
    const g = t >= 0.5 ? Math.exp(-(t - 0.5) * 6.5) : 0;
    const strips = g > 0.015 ? 11 : 1;
    const top = blOf(lines[0]) - lines[0].size * 1.1, bandH = blOf(last) - top + last.size * 0.5;
    const maskBottom = blOf(s.lastA) + s.lastA.size * 0.45;
    const paint = (role, dx) => {
      ctx.fillStyle = K.color(role);
      for (const d of drawn) {
        ctx.save();
        ctx.font = K.font(700, d.L.size);
        const cx = d.L.x0 + d.it.x + d.it.width / 2;
        ctx.translate(cx + dx, d.y); ctx.rotate(d.rot); ctx.scale(d.sx, d.sy);
        ctx.textAlign = 'center'; ctx.direction = K.dir(d.it.word);
        ctx.fillText(d.it.word, 0, 0);
        ctx.restore();
      }
    };
    for (let k = 0; k < strips; k++) {
      ctx.save();
      if (t < 0.62) { ctx.beginPath(); ctx.rect(-W, top, W * 3, maskBottom - top); ctx.clip(); }
      let dx = 0;
      if (strips > 1) {
        const y0 = top + (bandH * k) / strips;
        ctx.beginPath(); ctx.rect(-W, k === 0 ? -H : y0, W * 3, k === strips - 1 ? H * 3 : bandH / strips + 0.5); ctx.clip();
        const q = Math.floor(t * 24), r = K.hash(k, q, 5) * 2 - 1;
        dx = g * r * 220 * (K.hash(k, q, 6) > 0.4 ? 1 : 0.15);
        paint(s.split[0], dx * 1.35 + 10 * g);
        paint(s.split[1], dx * 0.7 - 10 * g);
      }
      paint(s.on, dx);
      ctx.restore();
    }
    if (readable && t > 0.3) {
      for (const L of lines) {
        if (L.g === 1 && t < 1.0) continue;
        K.mark(L.x0, blOf(L) - L.size * 0.85, L.layout.width, L.size * 1.2, L.str);
      }
    }

    // Caption, by word in reading order.
    if (p.caption) {
      ctx.font = K.font(600, 46);
      const cap = K.words(ctx, String(p.caption));
      const cx0 = CX - cap.width / 2, cy = blOf(last) + last.size * 0.55 + 46;
      const fade = 1 - prog(t, 1.85, 2.0);
      ctx.fillStyle = K.color(s.on); ctx.direction = K.dir(p.caption);
      cap.items.forEach(it => {
        const q = E.outCubic(prog(t, 1.05 + it.index * 0.05, 1.3 + it.index * 0.05)) * fade;
        if (q <= 0) return;
        ctx.globalAlpha = q;
        ctx.fillText(it.word, cx0 + it.x, cy + (1 - q) * 14);
      });
      ctx.globalAlpha = 1; ctx.direction = 'ltr';
      if (readable && t > 1.3 && fade > 0.5) K.mark(cx0, cy - 46, cap.width, 60, p.caption);
    }

    // The full stop: pops on the landing, squashes before the dive, then is the dive.
    const pop = spring(t - 1.0, 2.6, 0.45);
    const antic = 1 - 0.25 * Math.sin(Math.PI * prog(t, 1.82, 2.02));
    const rr = dot.r * pop * antic;
    if (rr > 0.2) {
      if (footage) {
        ctx.fillStyle = K.color(s.on); K.circle(ctx, dot.x, dot.y, rr); ctx.fill();
        if (dive > 0) { ctx.globalCompositeOperation = 'destination-out'; K.circle(ctx, dot.x, dot.y, rr * K.clamp(dive * 40, 0, 0.92)); ctx.fill(); ctx.globalCompositeOperation = 'source-over'; }
      } else {
        ctx.fillStyle = K.color(to); K.circle(ctx, dot.x, dot.y, rr); ctx.fill();
      }
    }
    ctx.restore();
    // The last frames are exactly the hand-off.
    if (t > 2.47) {
      if (footage) ctx.clearRect(0, 0, W, H);
      else { ctx.fillStyle = K.color(to); ctx.fillRect(0, 0, W, H); }
    }
  },
});
