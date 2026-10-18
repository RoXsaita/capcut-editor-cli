/*
 * format-morph — one viewport reshapes from a widescreen video into a phone and then a website, carrying its content across each change.
 * params: { labels?: [three short labels] (default [Video, App, Website]), actions?: [three app actions] (default [Choose, Build, Share]), hero?: [two website headline lines] (default [Your idea, Made real]), presentation?: "full" | "overlay" (default "full"), imageData?: PNG/JPEG base64 data URI for the overlay result }
 * beats: 6 (3.0 s at 120 BPM)
 * handoff: full: seam → seam; overlay: footage → footage
 * use: a spoken list of output formats or capabilities, as one continuous transformation. Once per video.
 *
 * Timing: full presentation opens the centre seam; overlay presentation uses a bounded brand-and-paper viewport in x70–930/y230–600. The video frame expands from its centre (outExpo) and its label lands at beat 0.6.
 * Anticipation narrows the frame before it morphs to the phone at beat 2, then expands into
 * the browser at beat 3.6 (inOutCubic, restrained overshoot). Labels reveal as whole words;
 * each format lands with a soft click. In full presentation, ink opens from the centre seam over
 * 0.3 seconds; the last 0.26 seconds collapse back into the seam. Transition colour is a profile role.
 */
function drawOverlay(ctx, t, s, K) {
  const { E, prog, lerp, b } = K;
  const cx = 500, cy = 414;
  const a = E.inOutCubic(prog(t, b(1.7), b(2)));
  const z = E.inOutCubic(prog(t, b(3.3), b(3.6)));
  const shapes = [
    { w: 840, h: 260, r: 18, ix: 18, iy: 16, iw: 804, ih: 174 },
    { w: 320, h: 360, r: 38, ix: 18, iy: 104, iw: 284, ih: 100 },
    { w: 840, h: 300, r: 18, ix: 464, iy: 76, iw: 354, ih: 202 },
  ];
  const shape = {};
  for (const key of Object.keys(shapes[0])) {
    shape[key] = lerp(lerp(shapes[0][key], shapes[1][key], a), shapes[2][key], z);
  }

  const hits = [b(0.6), b(2), b(3.6)];
  // Switch before the cue's shutter opens: no old format ghosts on an impact frame.
  const stage = t >= hits[2] - 0.5 / K.FPS ? 2 : t >= hits[1] - 0.5 / K.FPS ? 1 : 0;
  const enter = E.outExpo(prog(t, b(0.3), hits[0]));
  const end = K.duration - 4 / K.FPS;
  const exit = E.outExpo(prog(t, end - b(0.4), end));
  const land = E.outBack(prog(t, b(0.3), hits[0]));
  const visible = enter * (1 - exit);
  if (visible <= 0) return;

  const w = shape.w, h = shape.h, x = cx - w / 2, y = cy - h / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(70, 230, 860, 370); ctx.clip();
  ctx.globalAlpha = visible;
  ctx.translate(cx, cy + (1 - land) * 10);
  const scale = 0.98 + 0.02 * land - 0.02 * exit;
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  ctx.fillStyle = K.color('paper');
  ctx.beginPath(); ctx.roundRect(x, y, w, h, shape.r); ctx.fill(); ctx.clip();

  // The same captured result stays in the viewport while its container and crop reflow.
  const ix = x + shape.ix, iy = y + shape.iy;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(ix, iy, shape.iw, shape.ih, 10); ctx.clip();
  if (s.image) {
    const cover = Math.max(shape.iw / s.image.naturalWidth, shape.ih / s.image.naturalHeight);
    const dw = s.image.naturalWidth * cover, dh = s.image.naturalHeight * cover;
    ctx.drawImage(s.image, ix + (shape.iw - dw) / 2, iy + (shape.ih - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = K.color('brand'); ctx.fillRect(ix, iy, shape.iw, shape.ih);
  }
  ctx.restore();

  ctx.fillStyle = K.color('ink');
  if (stage === 0) {
    // Playback controls belong to the picture, rather than becoming another card.
    ctx.fillStyle = K.color('brand');
    K.circle(ctx, cx, iy + shape.ih / 2, 30); ctx.fill();
    ctx.fillStyle = K.color('paper');
    ctx.beginPath(); ctx.moveTo(cx - 7, iy + shape.ih / 2 - 14);
    ctx.lineTo(cx + 16, iy + shape.ih / 2); ctx.lineTo(cx - 7, iy + shape.ih / 2 + 14);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = K.color('brand'); ctx.fillRect(x + 24, y + 198, (w - 48) * prog(t, hits[0], b(1.7)), 5);
    ctx.font = K.font(700, 58); ctx.fillStyle = K.color('ink');
    K.text(ctx, s.labels[0], cx, y + h - 17, { align: 'center' });
  } else if (stage === 1) {
    // Speaker/camera, app title, selectable actions and home indicator make this a phone.
    ctx.fillStyle = K.color('ink');
    ctx.beginPath(); ctx.roundRect(cx - 33, y + 14, 66, 10, 5); ctx.fill();
    K.circle(ctx, cx + 47, y + 19, 5); ctx.fill();
    ctx.font = K.font(700, 52);
    K.text(ctx, s.labels[1], cx, y + 85, { align: 'center' });
    for (let i = 0; i < 3; i++) {
      const rowY = y + 215 + i * 40;
      ctx.fillStyle = i === 0 ? K.color('brand') : K.rgba('ink', 0.06);
      ctx.beginPath(); ctx.roundRect(x + 18, rowY, w - 36, 35, 9); ctx.fill();
      ctx.font = K.font(700, 36); ctx.fillStyle = K.color(i === 0 ? 'paper' : 'ink');
      K.text(ctx, s.actions[i], cx, rowY + 17.5, { align: 'center', baseline: 'middle' });
    }
    ctx.fillStyle = K.color('ink');
    ctx.beginPath(); ctx.roundRect(cx - 42, y + h - 14, 84, 5, 3); ctx.fill();
  } else {
    // Browser chrome is one readable tab with an address field, then an actual result hero.
    ctx.fillStyle = K.rgba('ink', 0.07); ctx.fillRect(x, y, w, 58);
    ctx.fillStyle = K.color('muted');
    for (let i = 0; i < 3; i++) { K.circle(ctx, x + 25 + i * 20, y + 29, 5); ctx.fill(); }
    ctx.fillStyle = K.color('paper');
    ctx.beginPath(); ctx.roundRect(x + 112, y + 9, w - 140, 40, 10); ctx.fill();
    ctx.font = K.font(700, 38); ctx.fillStyle = K.color('ink');
    K.text(ctx, s.labels[2], cx, y + 38, { align: 'center' });
    ctx.font = K.font(700, 54);
    s.hero.forEach((line, i) => K.text(ctx, line, x + 230, y + 145 + i * 66, { align: 'center' }));
    ctx.fillStyle = K.color('brand');
    ctx.beginPath(); ctx.roundRect(x + 140, y + 232, 180, 46, 12); ctx.fill();
    ctx.font = K.font(700, 36); ctx.fillStyle = K.color('paper');
    K.text(ctx, s.actions[1], x + 230, y + 255, { align: 'center', baseline: 'middle' });
  }
  ctx.restore();
}

SCENE.define({
  id: 'format-morph',
  beats: () => 6,
  alpha: true,
  handoff: p => p.presentation === 'overlay'
    ? { in: 'footage', out: 'footage' } : { in: 'seam', out: 'seam' },
  still: (_, K) => K.b(4.3),
  cues: (_, K) => [0.6, 2, 3.6].map((beat, i) => ({
    at: K.b(beat), kind: 'click', tone: 1100 + i * 160, dur: 0.035, gain: 0.18,
  })),
  async setup(p, K) {
    const presentation = p.presentation === undefined ? 'full' : p.presentation;
    if (!['full', 'overlay'].includes(presentation)) {
      throw new Error('SCENE_PARAM: format-morph presentation must be "full" or "overlay"');
    }
    const labels = p.labels === undefined ? ['Video', 'App', 'Website'] : p.labels;
    if (!Array.isArray(labels) || labels.length !== 3
      || labels.some(label => typeof label !== 'string' || !label.trim() || label.trim().length > 16)) {
      throw new Error('SCENE_PARAM: format-morph labels must contain three short non-empty strings (max 16 characters)');
    }
    const c = document.createElement('canvas').getContext('2d');
    c.font = K.font(700, 120);
    if (labels.some(label => c.measureText(label.trim()).width > K.safe.w - 100)) {
      throw new Error('SCENE_PARAM: format-morph label is too wide; shorten the copy');
    }
    const actions = p.actions === undefined ? ['Choose', 'Build', 'Share'] : p.actions;
    const hero = p.hero === undefined ? ['Your idea', 'Made real'] : p.hero;
    for (const [values, count, size, max, name] of [[actions, 3, 44, 190, 'actions'], [hero, 2, 70, 370, 'hero']]) {
      c.font = K.font(700, size);
      if (!Array.isArray(values) || values.length !== count || values.some(value => typeof value !== 'string'
        || !value.trim() || value.length > 20 || c.measureText(value.trim()).width > max)) {
        throw new Error(`SCENE_PARAM: format-morph ${name} needs ${count} short readable strings`);
      }
    }
    c.font = K.font(700, 72);
    if (presentation === 'overlay' && labels.some(label => c.measureText(label.trim()).width > 260)) {
      throw new Error('SCENE_PARAM: format-morph overlay labels must fit the phone viewport at full size');
    }
    let image = null;
    if (p.imageData !== undefined) {
      if (typeof p.imageData !== 'string'
        || !/^data:image\/(?:png|jpeg);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.imageData)
        || p.imageData.endsWith(',')) {
        throw new Error('SCENE_PARAM: format-morph imageData must be a PNG/JPEG base64 data URI');
      }
      image = new Image();
      image.src = p.imageData;
      try { await image.decode(); } catch {
        throw new Error('SCENE_PARAM: format-morph imageData could not decode as a PNG/JPEG image');
      }
    }
    let transition = 'brand';
    try { K.color('transition'); transition = 'transition'; } catch { /* Neutral profiles use their brand role. */ }
    return { labels: labels.map(label => label.trim()), actions: actions.map(v => v.trim()), hero: hero.map(v => v.trim()), transition, presentation, image };
  },
  draw(ctx, t, p, s, K) {
    if (s.presentation === 'overlay') {
      drawOverlay(ctx, t, s, K);
      return;
    }
    const { W, H, E, prog, lerp, b } = K;
    const seam = H / 2;
    const half = K.aperture(t);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, seam - half, W, half * 2); ctx.clip();
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, W, H);

    const cx = K.safe.x + K.safe.w / 2;
    const cy = K.safe.y + K.safe.h * 0.57;
    const width = K.safe.w - 60;
    const shapes = [
      { w: width, h: width * 9 / 16, r: 14, header: 22, gap: 22 },
      { w: width * 0.43, h: width * 0.93, r: 44, header: 54, gap: 18 },
      { w: width, h: width * 0.66, r: 14, header: 60, gap: 22 },
    ];
    const a = E.inOutCubic(prog(t, b(1.36), b(2)));
    const z = E.inOutCubic(prog(t, b(2.96), b(3.6)));
    const shape = {};
    for (const key of Object.keys(shapes[0])) {
      shape[key] = lerp(lerp(shapes[0][key], shapes[1][key], a), shapes[2][key], z);
    }
    const enter = E.outExpo(prog(t, b(0.08), b(0.6)));
    const exit = E.inExpo(prog(t, b(5.3), b(5.9)));
    const windup = Math.sin(Math.PI * prog(t, b(1.2), b(1.36)))
      + Math.sin(Math.PI * prog(t, b(2.8), b(2.96)));
    const settle = t >= b(3.6) ? K.wobble(t - b(3.6), 16, 25)
      : t >= b(2) ? K.wobble(t - b(2), 16, 25) : 0;
    const w = shape.w * (1 - 0.025 * windup + 0.018 * settle);
    const h = shape.h * enter * (1 - exit);
    const x = cx - w / 2, y = cy - h / 2;
    const radius = Math.min(shape.r, h / 2);

    ctx.save();
    ctx.globalAlpha = 1 - exit;
    ctx.strokeStyle = K.color('text'); ctx.lineWidth = 6;
    ctx.beginPath(); ctx.roundRect(x, y, w, Math.max(0, h), radius); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(x + 3, y + 3, w - 6, Math.max(0, h - 6), Math.max(0, radius - 3)); ctx.clip();
    ctx.fillStyle = K.color('brand');
    ctx.fillRect(x + 18, y + 18, w - 36, shape.header * enter);

    // Timeline clips become app actions, then editorial cards: the content reflows with the frame.
    const gap = shape.gap, pad = 26, contentY = y + shape.header + 42;
    const contentH = Math.max(0, h - shape.header - 70);
    const phone = a * (1 - z);
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 1 - exit;
      const wideW = (w - pad * 2 - gap * 2) / 3;
      const blockW = lerp(wideW, w - pad * 2, phone);
      const blockH = lerp(lerp(contentH * 0.17, contentH * 0.28, z), contentH * 0.19, phone);
      const bx = lerp(x + pad + i * (wideW + gap), x + pad, phone);
      const by = lerp(contentY + contentH - blockH, contentY + 78 + i * (contentH * 0.19 + gap), phone);
      ctx.fillStyle = i === 1 ? K.color('brand') : K.rgba('text', 0.14);
      if (blockH > 0) ctx.fillRect(bx, by, blockW, blockH);
      ctx.globalAlpha = phone * (1 - exit);
      ctx.font = K.font(700, 44); ctx.fillStyle = K.color('text');
      K.text(ctx, s.actions[i], bx + blockW / 2, by + blockH / 2 + 15, { align: 'center' });
      ctx.globalAlpha = (1 - z) * (1 - phone) * (1 - exit);
      ctx.fillStyle = K.rgba('text', 0.8);
      ctx.fillRect(bx + 10, by + 10, Math.max(0, blockW - 20), 4);
      ctx.globalAlpha = z * (1 - exit);
      ctx.fillStyle = K.rgba('text', 0.8);
      ctx.fillRect(bx + 12, by + blockH - 14, blockW * 0.58, 4);
    }
    // A real playback composition: picture area, play marker, clipped timeline and moving playhead.
    ctx.globalAlpha = (1 - a) * (1 - exit);
    ctx.fillStyle = K.rgba('text', 0.06);
    ctx.fillRect(x + pad, contentY, w - pad * 2, contentH * 0.72);
    ctx.fillStyle = K.color('text');
    ctx.beginPath(); ctx.moveTo(cx - 24, contentY + contentH * 0.22);
    ctx.lineTo(cx + 35, contentY + contentH * 0.36); ctx.lineTo(cx - 24, contentY + contentH * 0.5); ctx.closePath(); ctx.fill();
    const playhead = x + pad + (w - pad * 2) * prog(t, b(0.6), b(1.36));
    ctx.fillRect(playhead - 2, contentY + contentH * 0.78, 4, contentH * 0.22);

    // The phone is a short action flow, and the browser carries a headline with an editorial image.
    ctx.globalAlpha = phone * (1 - exit); ctx.fillStyle = K.color('text');
    ctx.fillRect(x + pad, contentY + 10, (w - pad * 2) * 0.7, 8);
    ctx.fillRect(x + pad, contentY + 32, (w - pad * 2) * 0.4, 4);
    ctx.globalAlpha = z * (1 - exit);
    ctx.font = K.font(700, 70); ctx.fillStyle = K.color('text');
    s.hero.forEach((line, i) => K.text(ctx, line, x + pad + 180, contentY + 76 + i * 80, { align: 'center' }));
    ctx.fillStyle = K.color('brand');
    ctx.fillRect(x + w * 0.63, contentY + 4, w * 0.32, contentH * 0.56);
    ctx.strokeStyle = K.color('text'); ctx.lineWidth = 8;
    const artworkX = x + w * 0.79, artworkY = contentY + contentH * 0.29;
    K.circle(ctx, artworkX, artworkY, contentH * 0.14); ctx.stroke();
    ctx.globalAlpha = 1 - exit;
    ctx.restore();

    const hits = [b(0.6), b(2), b(3.6)];
    const stage = t >= hits[2] ? 2 : t >= hits[1] ? 1 : 0;
    const show = E.outExpo(prog(t, hits[stage], hits[stage] + b(0.28)));
    ctx.globalAlpha = show * (1 - E.inExpo(prog(t, b(5.05), b(5.35))));
    ctx.fillStyle = K.color('text'); ctx.font = K.font(700, 120);
    K.text(ctx, s.labels[stage], cx, K.safe.y + 290 + (1 - show) * 22, { align: 'center' });
    ctx.globalAlpha = 1;
    ctx.restore();

    K.seamMarks(ctx, t, half, s.transition);
  },
});
