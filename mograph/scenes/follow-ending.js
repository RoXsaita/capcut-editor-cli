/*
 * follow-ending — the captured final frame collapses into an avatar, surrounded by a countdown dial and a follow confirmation.
 * params: { imageData: PNG/JPEG base64 data URI, faceX?: 540, faceY?: 920, faceScale?: 0.46, pill?: 'Next up', headline?: 'Follow', sub?: '', badge?: '2' ('' hides the badge), noSfx?: false }
 * beats: 6 (3.0 s at 120 BPM)
 * handoff: captured frame → follow card
 * use: an ending that continues directly from the supplied final frame; copy and image belong to the caller.
 */
function followGlow(ctx, K, x, y, rx, ry, role, alpha) {
  ctx.save(); ctx.translate(x, y); ctx.scale(rx, ry);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, K.rgba(role, alpha)); g.addColorStop(0.7, K.rgba(role, 0));
  ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
}

function followShock(ctx, f, at, x, y, r0, r1, role, dur, K, out) {
  const p = K.prog(f, at, at + dur);
  if (p <= 0 || p >= 1) return;
  ctx.save(); ctx.globalAlpha *= 1 - p;
  ctx.strokeStyle = K.color(role); ctx.lineWidth = Math.max(1, 8 * (1 - p));
  ctx.shadowColor = K.color(role); ctx.shadowBlur = 40;
  K.circle(ctx, x, y, K.lerp(r0, r1, out(p))); ctx.stroke(); ctx.restore();
}

function followBackground(ctx, f, impact, tap, K, io) {
  ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, K.W, K.H);
  ctx.save(); ctx.globalAlpha = io(K.prog(f, 2, 16));
  const bg = ctx.createLinearGradient(0, 0, 330, K.H);
  bg.addColorStop(0, K.mix('ink', 'brand', 0.08)); bg.addColorStop(0.45, K.color('ink'));
  bg.addColorStop(1, K.mix('ink', 'accent', 0.06));
  ctx.fillStyle = bg; ctx.fillRect(0, 0, K.W, K.H);
  followGlow(ctx, K, 540, 691 + Math.sin(f / 200 * K.TAU) * 19, 410, 461, 'brand', 0.4 + impact * 0.18 + tap * 0.1);
  followGlow(ctx, K, 540 + Math.sin(f / 180 * K.TAU) * 65, 1574, 648, 500, 'accent', 0.22);
  // Canvas wedges and projected grid lines preserve the source's conic rays and floor motif.
  ctx.save(); ctx.translate(540, 700); ctx.scale(1, 0.68); ctx.rotate(f * 0.6 * Math.PI / 180);
  const rays = ctx.createRadialGradient(0, 0, 0, 0, 0, 650);
  rays.addColorStop(0, K.rgba('brand', 0.1)); rays.addColorStop(0.2, K.rgba('brand', 0.07)); rays.addColorStop(1, K.rgba('brand', 0));
  ctx.fillStyle = rays;
  for (let i = 0; i < 24; i++) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 650, i * K.TAU / 24, i * K.TAU / 24 + 4 * Math.PI / 180); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(0, 1180, K.W, K.H - 1180); ctx.clip();
  const floor = ctx.createLinearGradient(0, 1180, 0, 1900);
  floor.addColorStop(0, K.rgba('brand', 0.16)); floor.addColorStop(0.7, K.rgba('brand', 0));
  ctx.strokeStyle = floor; ctx.lineWidth = 2;
  for (let i = -12; i <= 12; i++) {
    ctx.beginPath(); ctx.moveTo(540 + i * 45, 1180); ctx.lineTo(540 + i * 140, K.H); ctx.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const z = (i * 90 + f * 3) % 1080, y = 1180 + z * z / 1400;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(K.W, y); ctx.stroke();
  }
  ctx.restore();
  for (let i = 0; i < 46; i++) {
    const x = K.hash(i, 1) * K.W, speed = 1.2 + K.hash(i, 2) * 3.2;
    const y = ((K.hash(i, 3) * K.H - f * speed) % K.H + K.H) % K.H;
    const size = 2 + K.hash(i, 4) * 5, hot = K.hash(i, 5);
    const role = hot > 0.75 ? 'accent' : hot > 0.4 ? 'brand' : 'text';
    ctx.save(); ctx.globalAlpha *= 0.15 + K.hash(i, 6) * 0.45;
    ctx.fillStyle = K.color(role); ctx.shadowColor = K.color(role); ctx.shadowBlur = size * 3;
    K.circle(ctx, x, y, size / 2); ctx.fill(); ctx.restore();
  }
  ctx.save(); ctx.translate(540, 768); ctx.scale(1188, 1440);
  const vignette = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  vignette.addColorStop(0.45, K.rgba('ink', 0)); vignette.addColorStop(1, K.rgba('ink', 0.7));
  ctx.fillStyle = vignette; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
  ctx.restore();
}

function followDial(ctx, f, tap, K, out, spring) {
  const appear = spring(10, 14, 160), sweep = out(K.prog(f, 12, 36));
  ctx.save(); ctx.globalAlpha = K.clamp(appear);
  for (let i = 0; i < 2; i++) {
    ctx.save(); ctx.translate(540, 700); ctx.rotate((i ? -1 : 1) * f * 0.8 * Math.PI / 180);
    ctx.strokeStyle = K.rgba(i ? 'accent' : 'brand', i ? 0.14 : 0.22); ctx.lineWidth = 2;
    ctx.setLineDash(i ? [40, 18, 4, 18] : [2, 14]);
    K.circle(ctx, 0, 0, (i ? 420 : 330) * (0.9 + 0.1 * appear)); ctx.stroke(); ctx.restore();
  }
  ctx.strokeStyle = K.rgba('text', 0.08); ctx.lineWidth = 10;
  K.circle(ctx, 540, 700, 222); ctx.stroke();
  const g = ctx.createLinearGradient(318, 478, 762, 922);
  g.addColorStop(0, K.color('accent')); g.addColorStop(0.55, K.mix('accent', 'brand', 0.5)); g.addColorStop(1, K.color('brand'));
  if (sweep > 0) {
    ctx.strokeStyle = g; ctx.lineCap = 'round'; ctx.shadowColor = K.color('brand'); ctx.shadowBlur = 20 + tap * 16;
    ctx.beginPath(); ctx.arc(540, 700, 222, -Math.PI / 2, sweep * K.TAU - Math.PI / 2); ctx.stroke();
    ctx.shadowBlur = 0;
  }
  for (let i = 0; i < 60; i++) {
    const a = i / 60 * K.TAU - Math.PI / 2, major = i % 5 === 0;
    const r0 = 244 * appear, r1 = (244 + (major ? 20 : 10)) * appear;
    ctx.strokeStyle = i / 60 <= sweep ? (major ? K.color('text') : K.mix('brand', 'text', 0.65)) : K.rgba('text', 0.13);
    ctx.lineWidth = major ? 4 : 2.5;
    ctx.beginPath(); ctx.moveTo(540 + Math.cos(a) * r0, 700 + Math.sin(a) * r0);
    ctx.lineTo(540 + Math.cos(a) * r1, 700 + Math.sin(a) * r1); ctx.stroke();
  }
  if (sweep > 0.02 && sweep < 0.995) {
    ctx.fillStyle = K.color('text'); ctx.shadowColor = K.color('text'); ctx.shadowBlur = 20;
    K.circle(ctx, 540 + Math.cos(sweep * K.TAU - Math.PI / 2) * 222, 700 + Math.sin(sweep * K.TAU - Math.PI / 2) * 222, 11); ctx.fill();
  }
  ctx.restore();
}

function followButton(ctx, f, K, out, spring) {
  followShock(ctx, f, 46, 540, 922, 20, 120, 'text', 12, K, out);
  followShock(ctx, f, 48, 540, 922, 50, 260, 'accent', 18, K, out);
  const burst = K.prog(f, 47, 67);
  if (burst > 0 && burst < 1) {
    for (let i = 0; i < 18; i++) {
      const a = i / 18 * K.TAU + K.hash(i, 21) * 0.3;
      const dist = (90 + K.hash(i, 22) * 120) * out(burst), len = 26 * (1 - burst) + 4;
      const role = ['accent', 'text', 'brand', 'muted'][i % 4];
      ctx.save(); ctx.globalAlpha = 1 - burst * burst;
      ctx.translate(540 + Math.cos(a) * dist, 922 + Math.sin(a) * dist); ctx.rotate(a);
      ctx.fillStyle = K.color(role); ctx.shadowColor = K.color(role); ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.roundRect(-len / 2, -3, len, 6, 3); ctx.fill(); ctx.restore();
    }
  }
  const enter = spring(24, 9, 180, 0.7), press = 1 - 0.2 * K.prog(f, 43, 46), release = spring(48, 7, 220, 0.6);
  const scale = f < 48 ? enter * press : 0.8 + 0.2 * release + 0.12 * Math.sin(Math.min(1, release) * Math.PI);
  if (scale <= 0) return;
  const idle = f > 34 && f < 43 ? 1 + 0.06 * Math.sin((f - 24) / 6 * Math.PI) : 1;
  const done = K.prog(f, 47, 52), check = out(K.prog(f, 49, 58));
  ctx.save(); ctx.translate(540, 922); ctx.scale(scale * idle, scale * idle);
  ctx.fillStyle = K.color('ink'); K.circle(ctx, 0, 0, 56); ctx.fill();
  ctx.fillStyle = K.mix('accent', 'text', done); ctx.shadowColor = done > 0.5 ? K.color('text') : K.color('accent');
  ctx.shadowBlur = 40 + done * 30; K.circle(ctx, 0, 0, 50); ctx.fill(); ctx.shadowBlur = 0;
  ctx.save(); ctx.rotate(out(K.prog(f, 46, 54)) * 135 * Math.PI / 180); ctx.globalAlpha = 1 - done;
  ctx.fillStyle = K.color('text');
  ctx.beginPath(); ctx.roundRect(-4, -22, 8, 44, 4); ctx.roundRect(-22, -4, 44, 8, 4); ctx.fill(); ctx.restore();
  ctx.strokeStyle = K.color('accent'); ctx.lineWidth = 9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.setLineDash([60 * check, 60]);
  if (check > 0) { ctx.beginPath(); ctx.moveTo(-20, 2); ctx.lineTo(-6, 15); ctx.lineTo(21, -13); ctx.stroke(); }
  ctx.restore();
}

SCENE.define({
  id: 'follow-ending',
  beats: () => 6,
  handoff: { in: 'captured-frame', out: 'follow-card' },
  still: (_, K) => K.duration * 72 / 90,
  cues: (p, K) => {
    if (p.noSfx) return [];
    const at = f => f / 90 * K.duration;
    const cues = [
      { at: 0, kind: 'riser', dur: at(16), gain: 0.45, f0: 120, f1: 1400 },
      { at: at(16), kind: 'impact', gain: 0.45 },
      { at: at(24), kind: 'blip', note: 76, dur: 0.12, gain: 0.45 },
      { at: at(46), kind: 'click', tone: 2600, gain: 0.75 },
      { at: at(46), kind: 'thud', f0: 160, f1: 65, gain: 0.5 },
      { at: at(47), kind: 'sparkle', dur: at(28), density: 24, gain: 0.5 },
    ];
    if (p.badge !== '') cues.push({ at: at(30), kind: 'blip', note: 84, dur: 0.15, gain: 0.65 }, { at: at(30), kind: 'bell', note: 84, dur: 0.65, gain: 0.4 });
    for (let i = 0; i < 15; i++) {
      const p = i / 14;
      cues.push({ at: at(12 + 24 * Math.sqrt(p)), kind: 'click', tone: 1300 + p * 1700, gain: 0.18 + p * 0.1, pan: Math.sin(p * K.TAU) * 0.4 });
    }
    [84, 88, 91, 96].forEach((note, i) => cues.push({ at: at(49 + i * 3), kind: 'bell', note, dur: at(26), gain: 0.45, pan: (i - 1.5) * 0.15 }));
    return cues.sort((a, b) => a.at - b.at);
  },
  async setup(p, K) {
    if (K.W !== 1080 || K.H !== 1920) throw new Error('SCENE_PARAM: follow-ending requires a 1080×1920 canvas');
    if (typeof p.imageData !== 'string'
      || !/^data:image\/(?:png|jpeg);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.imageData)
      || p.imageData.endsWith(',')) {
      throw new Error('SCENE_PARAM: follow-ending imageData must be a PNG/JPEG base64 data URI');
    }
    const image = new Image(); image.src = p.imageData;
    try { await image.decode(); } catch { throw new Error('SCENE_PARAM: follow-ending imageData could not decode as a PNG/JPEG image'); }
    const faceX = p.faceX === undefined ? 540 : p.faceX, faceY = p.faceY === undefined ? 920 : p.faceY;
    const faceScale = p.faceScale === undefined ? 0.46 : p.faceScale;
    if (!Number.isFinite(faceX) || faceX < 0 || faceX > K.W || !Number.isFinite(faceY) || faceY < 0 || faceY > K.H
      || !Number.isFinite(faceScale) || faceScale <= 0 || faceScale > 1) {
      throw new Error('SCENE_PARAM: follow-ending faceX/faceY must be canvas coordinates and faceScale must be in (0, 1]');
    }
    const s = { image, faceX, faceY, faceScale, io: K.cubicBezier(0.7, 0, 0.18, 1), out: K.cubicBezier(0.16, 1, 0.3, 1) };
    const c = document.createElement('canvas').getContext('2d');
    for (const [name, fallback, weight, size, min, maxWidth] of [
      ['pill', 'Next up', 700, 44, 44, Math.min(660, K.safe.w - 130)],
      ['headline', 'Follow', 900, 200, 160, Math.min(760, K.safe.w - 100)],
      ['sub', '', 500, 54, 54, Math.min(800, K.safe.w - 90)],
      ['badge', '2', 700, 104, 72, 92],
    ]) {
      const value = p[name] === undefined ? fallback : p[name];
      if (typeof value !== 'string' || (name !== 'sub' && name !== 'badge' && !value.trim()) || value.length > 100 || /[\r\n]/.test(value)) {
        throw new Error(`SCENE_PARAM: follow-ending ${name} must be a short single-line string`);
      }
      const copy = value.trim(); c.font = K.font(weight, size);
      const fitted = Math.min(size, size * maxWidth / Math.max(1, c.measureText(copy).width));
      if (fitted < min) throw new Error(`SCENE_PARAM: follow-ending ${name} is too wide; shorten the copy`);
      s[name] = copy; s[`${name}Size`] = fitted;
    }
    const cover = Math.max(K.W / image.naturalWidth, K.H / image.naturalHeight);
    s.imageW = image.naturalWidth * cover; s.imageH = image.naturalHeight * cover;
    s.imageX = (K.W - s.imageW) / 2; s.imageY = (K.H - s.imageH) / 2;
    return s;
  },
  draw(ctx, t, p, s, K) {
    const f = t / K.duration * 90;
    // Preserve the captured seam before any decoration, filtering or camera transform.
    if (f <= 0) { ctx.drawImage(s.image, s.imageX, s.imageY, s.imageW, s.imageH); return; }
    const { io, out } = s;
    const spring = (at, damping, stiffness, mass = 1) => K.spring((f - at) / 30, Math.sqrt(stiffness / mass) / K.TAU, damping / (2 * Math.sqrt(stiffness * mass)));
    const progress = io(K.prog(f, 0, 16));
    const impact = f >= 16 ? 1 - K.prog(f, 16, 26) : 0;
    const tap = f >= 46 ? 1 - K.prog(f, 46, 58) : 0;
    const punch = 1 + 0.025 * impact * Math.cos((f - 16) * 1.2) + 0.012 * tap;
    const push = f >= 16 ? 1 + 0.035 * K.prog(f, 16, 90) : 1;
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, K.W, K.H);
    ctx.save(); ctx.translate(540 + Math.sin(f * 7.3) * 7 * impact, 700 + Math.cos(f * 5.1) * 5 * impact);
    ctx.scale(punch * push, punch * push); ctx.translate(-540, -700);
    followBackground(ctx, f, impact, tap, K, io);
    followDial(ctx, f, tap, K, out, spring);
    followShock(ctx, f, 16, 540, 700, 190, 520, 'brand', 18, K, out);

    const scale = K.lerp(1, s.faceScale, progress), px = K.lerp(s.faceX, 540, progress), py = K.lerp(s.faceY, 700, progress);
    ctx.save();
    // The opening radius covers every corner even when the caller's face is off-centre.
    const r0 = Math.max(1250, Math.hypot(Math.max(s.faceX, K.W - s.faceX), Math.max(s.faceY, K.H - s.faceY)));
    K.circle(ctx, px, py, K.lerp(r0, 190, progress)); ctx.clip();
    ctx.save(); ctx.translate(px - scale * s.faceX, py - scale * s.faceY); ctx.scale(scale, scale);
    ctx.filter = `saturate(${1 + 0.1 * progress}) contrast(${1 + 0.06 * progress})`;
    ctx.drawImage(s.image, s.imageX, s.imageY, s.imageW, s.imageH); ctx.restore();
    const shade = ctx.createRadialGradient(px, py, 190 * 0.78, px, py, 190);
    shade.addColorStop(0, K.rgba('ink', 0)); shade.addColorStop(1, K.rgba('ink', 0.55 * progress));
    ctx.fillStyle = shade; ctx.fillRect(0, 0, K.W, K.H); ctx.restore();

    const bx = 540 + Math.cos(-Math.PI / 4) * 222, by = 700 + Math.sin(-Math.PI / 4) * 222;
    if (s.badge) followShock(ctx, f, 32, bx, by, 62, 150, 'brand', 14, K, out);
    const badge = s.badge ? spring(30, 8, 200, 0.7) : 0;
    if (badge > 0) {
      ctx.save(); ctx.translate(bx, by); ctx.scale(badge, badge);
      const wiggle = f > 46 ? Math.sin((f - 46) / 2.2) * 8 * Math.exp(-(f - 46) / 10) : 0;
      ctx.rotate(((1 - badge) * -40 + wiggle) * Math.PI / 180);
      ctx.fillStyle = K.color('ink'); K.circle(ctx, 0, 0, 68); ctx.fill();
      const g = ctx.createRadialGradient(-20, -25, 0, 0, 0, 82);
      g.addColorStop(0, K.mix('brand', 'text', 0.28)); g.addColorStop(0.55, K.color('brand')); g.addColorStop(1, K.mix('brand', 'ink', 0.3));
      ctx.fillStyle = g; ctx.shadowColor = K.color('brand'); ctx.shadowBlur = 50;
      K.circle(ctx, 0, 0, 62); ctx.fill(); ctx.shadowBlur = 18; ctx.shadowColor = K.rgba('text', 0.6);
      ctx.font = `italic ${K.font(700, s.badgeSize)}`; ctx.fillStyle = K.color('text');
      K.text(ctx, s.badge, -3, -4, { align: 'center', baseline: 'middle' }); ctx.restore();
    }
    followButton(ctx, f, K, out, spring);

    const pill = spring(10, 16, 140);
    if (pill > 0) {
      ctx.save(); ctx.globalAlpha = K.clamp(pill); ctx.font = K.font(700, s.pillSize);
      const w = ctx.measureText(s.pill).width + 102, y = 330 - (1 - pill) * 40;
      ctx.fillStyle = K.rgba('ink', 0.65); ctx.strokeStyle = K.rgba('text', 0.16); ctx.lineWidth = 1.5;
      ctx.shadowColor = K.rgba('brand', 0.35); ctx.shadowBlur = 30;
      ctx.beginPath(); ctx.roundRect(540 - w / 2, y, w, 88, 44); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
      const rtl = K.isArabic(s.pill), dotX = 540 + (rtl ? 1 : -1) * (w / 2 - 42);
      ctx.fillStyle = K.rgba('accent', 0.6 + 0.4 * Math.abs(Math.sin(f / 6))); ctx.shadowColor = K.color('accent'); ctx.shadowBlur = 16;
      K.circle(ctx, dotX, y + 44, 8); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = K.color('text'); K.text(ctx, s.pill, 540 + (rtl ? -1 : 1) * 17, y + 44, { align: 'center', baseline: 'middle' }); ctx.restore();
    }
    const head = spring(20, 13, 120, 0.8), wipe = out(K.prog(f, 20, 32));
    if (head > 0 && wipe > 0) {
      ctx.save(); ctx.translate(540, 1130 + (1 - head) * 60); ctx.scale(0.9 + 0.1 * head + 0.03 * tap, 0.9 + 0.1 * head + 0.03 * tap);
      ctx.beginPath(); ctx.rect(-540 + 1080 * (1 - wipe), -150, 1080 * wipe, 330); ctx.clip();
      ctx.font = K.font(900, s.headlineSize);
      const w = ctx.measureText(s.headline).width, shine = K.lerp(-0.4, 1.4, K.prog(f, 48, 66));
      const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
      g.addColorStop(0, K.color('text')); g.addColorStop(K.clamp(shine - 0.12), K.color('text'));
      g.addColorStop(K.clamp(shine), K.color('accent')); g.addColorStop(K.clamp(shine + 0.12), K.color('text')); g.addColorStop(1, K.color('text'));
      ctx.fillStyle = g; ctx.filter = `blur(${(1 - Math.min(1, head)) * 14}px)`;
      ctx.shadowColor = K.rgba('accent', 0.35 + tap * 0.4); ctx.shadowBlur = 24 + tap * 30;
      K.text(ctx, s.headline, 0, 0, { align: 'center', baseline: 'middle' }); ctx.restore();
    }
    const underline = out(K.prog(f, 30, 42));
    if (underline > 0) {
      ctx.save(); const g = ctx.createLinearGradient(760, 0, 320, 0);
      g.addColorStop(0, K.color('accent')); g.addColorStop(1, K.color('brand'));
      ctx.strokeStyle = g; ctx.lineWidth = 12; ctx.lineCap = 'round'; ctx.shadowColor = K.color('accent'); ctx.shadowBlur = 14;
      ctx.setLineDash([450 * underline, 450]); ctx.beginPath(); ctx.moveTo(760, 1275); ctx.bezierCurveTo(640, 1305, 440, 1305, 320, 1281); ctx.stroke(); ctx.restore();
    }
    const sub = spring(30, 18, 120);
    if (s.sub && sub > 0) {
      ctx.save(); ctx.globalAlpha = K.clamp(sub); ctx.font = K.font(500, s.subSize); ctx.fillStyle = K.rgba('text', 0.82);
      K.text(ctx, s.sub, 540, 1353 + (1 - sub) * 30, { align: 'center', baseline: 'middle' }); ctx.restore();
    }
    const flash = f < 16 ? 0.18 * K.prog(f, 15, 16) : 0.18 * (1 - K.prog(f, 16, 20));
    if (flash > 0) { ctx.fillStyle = K.rgba('text', flash); ctx.fillRect(0, 0, K.W, K.H); }
    ctx.restore();
  },
});
