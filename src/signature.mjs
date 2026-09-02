import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CapcutError, clone, seededId, loadPreset, localizeMedia, contentEndUs } from './core.mjs';
import { principalTrack, sfxPresets } from './polish.mjs';
import { parkPresetLeftover } from './add.mjs';

const US = s => Math.round(s * 1e6);
const S = us => us / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;

/**
 * Real pixel dimensions, or null. CapCut lays out from material width/height, not the file,
 * so getting this wrong renders the logo at the template's aspect (the 1280x276 speck).
 *
 * Reads PNG / JPEG / GIF / WebP headers directly, then falls back to `sips`. Checking only
 * four signature bytes and trusting offsets 16/20 was not enough: a truncated or non-PNG file
 * that merely starts with the magic yielded {width: 0, height: 0}, and a 0x0 material commits
 * cleanly because validateDocument does not check dimensions. `brands.json` ships a .webp,
 * so "PNG only" was never sufficient either.
 */
export function imageSize(file) {
  if (!file || !fs.existsSync(file)) return null;
  const size = headerSize(file) || sipsSize(file);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

function headerSize(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length < 24) return null;
  const png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (png.every((b, i) => buf[i] === b) && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return null;                                       // VP8L and friends: let sips answer
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {            // JPEG: walk to the first SOF marker
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function sipsSize(file) {
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
    const width = Number(out.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(out.match(/pixelHeight:\s*(\d+)/)?.[1]);
    return width && height ? { width, height } : null;
  } catch { return null; }
}

/**
 * 0.36 was tuned against logoMaterialTemplate 1280×276, which FIT-fills canvas
 * width. Keep that on-canvas WIDTH for any asset so old --scale numbers still
 * mean "36% of the fitted box". Square logos get their real height (the speck
 * was the template's 276px height, not the scale).
 */
export function logoScaleFor(sw, sh, requested, canvas = { width: 1080, height: 1920 }, template = { width: 1280, height: 276 }) {
  const fitW = (w, h) => w * Math.min(canvas.width / w, canvas.height / h);
  const ref = fitW(template.width, template.height);
  const fit = fitW(sw, sh);
  if (!fit) return requested;
  return requested * (ref / fit);
}

export function sigPresets() {
  return loadPreset('signature');
}
export function brandPresets() {
  return loadPreset('brands');
}

let SEED = null;
const mint = key => seededId(SEED, key);
const arr = (doc, kind) => (doc.materials[kind] ||= []);

/* ------------------------------------------------------------------ *
 * Source time -> timeline time.
 *
 * The transcript is of the RAW take; the timeline is a recut of it with
 * dead air removed and clips sped up. "Put a logo where he says Claude"
 * is meaningless until you can map one to the other. Every principal-track
 * segment carries both ranges, so the map is exact — no estimation.
 * ------------------------------------------------------------------ */
export function sourceToTimeline(doc, trackIndex = null) {
  const { track } = principalTrack(doc, trackIndex);
  const spans = [...track.segments]
    .filter(s => s.source_timerange)
    .map(s => ({
      srcIn: S(s.source_timerange.start),
      srcOut: S(s.source_timerange.start + s.source_timerange.duration),
      tgtIn: S(s.target_timerange.start),
      speed: s.source_timerange.duration / s.target_timerange.duration || 1,
      material: s.material_id,
    }))
    .sort((a, b) => a.tgtIn - b.tgtIn);
  return t => {
    for (const sp of spans) {
      if (t >= sp.srcIn && t < sp.srcOut) return r3(sp.tgtIn + (t - sp.srcIn) / sp.speed);
    }
    return null;                                    // this moment was cut out
  };
}

/* ---------------- brand detection ---------------- */

// Whisper transliterates inconsistently — جروك and قروك in the same file — so fold the
// Arabic letters that differ only by dots or hamza before comparing.
function normalise(s) {
  return (s || '').toLowerCase()
    .replace(/[ً-ْـ]/g, '')          // diacritics, tatweel
    .replace(/[إأآا]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه')
    .replace(/[جقغ]/g, 'ج')                          // g/q/gh all render "g"
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * First mention of each brand, as a timeline second. Only the FIRST — he pops a logo when
 * he introduces a thing, not every time he says it (11 projects, never twice for one brand).
 */
export function detectBrands(transcript, mapper, { only = null, brands = null } = {}) {
  const table = brands || brandPresets().brands;
  const words = [];
  for (const seg of transcript.segments || []) {
    for (const w of seg.words || []) words.push({ t: w.start, text: w.word || w.text || '' });
    if (!(seg.words || []).length && seg.text) words.push({ t: seg.start, text: seg.text });
  }
  const hits = [];
  for (const [name, info] of Object.entries(table)) {
    if (only && !only.includes(name)) continue;
    const aliases = (info.aliases || []).map(normalise).filter(Boolean);
    // The FIRST mention that survives the cut — not the first in the raw take. He records
    // several takes; the earliest "Grok" is usually in one that was thrown away, and a
    // logo keyed to it would map to nothing at all.
    let found = null, at = null;
    for (let i = 0; i < words.length && at == null; i++) {
      for (const a of aliases) {
        const span = a.split(' ').length;
        const phrase = normalise(words.slice(i, i + span).map(w => w.text).join(' '));
        if (phrase === a || (span === 1 && normalise(words[i].text) === a)) {
          found = words[i].t;
          at = mapper(found);
          break;
        }
      }
    }
    if (at == null) continue;
    hits.push({ brand: name, sourceAt: r3(found), at, logo: info.logo || null });
  }
  hits.sort((a, b) => a.at - b.at);
  // Several brands can share one mark — chatgpt and openai point at the same file, and both
  // fire on the same sentence, so `wrap` put the identical glyph on screen twice on one beat.
  // One artwork is one logo; the earliest mention wins.
  const seenArtwork = new Set();
  return hits.filter(h => {
    const key = h.logo || `brand:${h.brand}`;
    if (seenArtwork.has(key)) return false;
    seenArtwork.add(key);
    return true;
  });
}

/**
 * Lay out marks whose holds overlap.
 *
 * A single logo sits at his measured house position. Two that are on screen together would
 * sit exactly on top of each other there — which is what happens in a versus video, because
 * he names both contenders in one breath. Spread the group across x at a shared y, widest
 * mark getting the most room, and keep the whole row inside the frame.
 *
 * Transform is in half-canvas units, x positive RIGHT. Marks are measured by their real
 * aspect so a square glyph and a long wordmark get proportional slots rather than equal ones.
 */
export function spreadOverlapping(logos, rules, canvas = { width: 1080, height: 1920 }) {
  const hold = l => l.hold ?? rules.logoHoldSeconds;
  const groups = [];
  for (const l of [...logos].sort((a, b) => a.at - b.at)) {
    const last = groups[groups.length - 1];
    if (last && l.at < Math.max(...last.map(x => x.at + hold(x)))) last.push(l);
    else groups.push([l]);
  }
  for (const group of groups) {
    if (group.length < 2) continue;
    const widths = group.map(l => {
      const px = imageSize(l.logo);
      const requested = l.scale ?? rules.logoDefaultScale;
      if (!px) return 2 * requested;
      // CapCut fits the image to the canvas, THEN multiplies by clip.scale. logoScaleFor
      // already returns that effective scale, so the on-canvas width is fitted × effective —
      // multiplying by `requested` again here made every row half its true width.
      const fitted = px.width * Math.min(canvas.width / px.width, canvas.height / px.height);
      const effective = logoScaleFor(px.width, px.height, requested, canvas);
      return (fitted * effective) / (canvas.width / 2);   // half-canvas units
    });
    const gap = 0.12;
    const total = widths.reduce((a, b) => a + b, 0) + gap * (group.length - 1);
    // never wider than the frame; shrink the row as one so relative sizes are preserved
    const fit = total > 1.94 ? 1.94 / total : 1;
    let x = -(total * fit) / 2;
    group.forEach((l, i) => {
      const w = widths[i] * fit;
      if (fit < 1) l.scale = (l.scale ?? rules.logoDefaultScale) * fit;
      l.pos = [r3(x + w / 2), rules.logoRowY ?? 0.167];
      x += w + gap * fit;
    });
  }
  return logos;
}

/**
 * "A scene with me only talking" — a principal-track clip carrying NO mask. A Split or
 * Circle mask means he is sharing the frame with a screen recording; without one he is the
 * whole picture, and that is where the push-in belongs. Verified against grok-build-final:
 * exactly the two full-face beats come back, and none of the eight split-screen ones.
 */
export function talkingHeadScenes(doc, trackIndex = null, minSeconds = 2.5) {
  const { track } = principalTrack(doc, trackIndex);
  const masks = new Set((doc.materials.common_mask || []).map(m => m.id));
  return [...track.segments]
    .filter(s => !(s.extra_material_refs || []).some(r => masks.has(r)))
    .filter(s => S(s.target_timerange.duration) >= minSeconds)
    .sort((a, b) => a.target_timerange.start - b.target_timerange.start)
    .map(s => ({ start: r3(S(s.target_timerange.start)),
                 end: r3(S(s.target_timerange.start + s.target_timerange.duration)),
                 duration: r3(S(s.target_timerange.duration)) }));
}

/* ---------------- writers ---------------- */

function popKeyframes(from, to, rampSeconds, key) {
  return [{
    id: mint(`kf:${key}`), material_id: '', property_type: 'KFTypeScaleX',
    keyframe_list: [
      { id: mint(`kfa:${key}`), curveType: 'Line', time_offset: 0, left_control: { x: 0, y: 0 },
        right_control: { x: 0, y: 0 }, values: [from], string_value: '', graphID: '' },
      { id: mint(`kfb:${key}`), curveType: 'Line', time_offset: US(rampSeconds), left_control: { x: 0, y: 0 },
        right_control: { x: 0, y: 0 }, values: [to], string_value: '', graphID: '' },
    ],
  }];
}

/**
 * A multi-point eased keyframe block.
 *
 * `popKeyframes` above is the measured two-key linear pop and stays the default. This is the
 * overshoot reveal: the SHAPE of every handle is read off the one real `FreeCurveInOut` block
 * in his projects (Higgsfield Refund, `presets/harvest.json` -> positionScaleEased), where the
 * out-handle runs +17% of the leg in time and +89% of its value change, and the in-handle
 * -68% / +27%. Nothing here is invented; only the point list differs.
 *
 * `points` is [[tSeconds | null, value], ...]; a null t means "the end of the hold".
 */
function easedBlock(property, points, key, holdSeconds, h) {
  const pts = points
    .map(([t, v]) => [t == null ? holdSeconds : t, v])
    .filter(([t]) => t <= holdSeconds + 1e-9)
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return null;
  const list = pts.map(([t, v], i) => {
    const prev = pts[i - 1], next = pts[i + 1];
    const outSpan = next ? US(next[0] - t) : 0;
    const inSpan = prev ? US(t - prev[0]) : 0;
    const outDv = next ? next[1] - v : 0;
    const inDv = prev ? v - prev[1] : 0;
    return {
      id: mint(`kf:${key}:${property}:${i}`),
      curveType: 'FreeCurveInOut',
      time_offset: Math.round(US(t)),
      left_control: { x: Math.round(h.inX * inSpan), y: h.inY * inDv },
      right_control: { x: Math.round(h.outX * outSpan), y: h.outY * outDv },
      values: [v],
      string_value: '',
      graphID: i === 0 ? '' : mint(`graph:${key}:${property}:${i}`),
    };
  });
  return { id: mint(`kfb:${key}:${property}`), material_id: '', property_type: property, keyframe_list: list };
}

/** Clip-attached video effect, written the way `layout background` writes its Blur plate. */
function attachEffect(doc, template, segmentId, key, adjust = null) {
  const effect = clone(template);
  delete effect._source;
  effect.id = mint(`fx:${key}`);
  if ('bind_segment_id' in effect) effect.bind_segment_id = segmentId;
  if (adjust) {
    effect.adjust_params = (effect.adjust_params || []).map(a =>
      a.name in adjust ? { ...a, value: adjust[a.name] } : a);
  }
  arr(doc, 'video_effects').push(effect);
  return effect.id;
}

function instantiateExtras(doc, templates, key) {
  const refs = [];
  for (const [kind, tpl] of Object.entries(templates)) {
    const m = clone(tpl);
    m.id = mint(`${kind}:${key}`);
    if ('bind_segment_id' in m) m.bind_segment_id = '';
    arr(doc, kind).push(m);
    refs.push(m.id);
  }
  return refs;
}

/** A new top track, so a plate never lands under the picture it is meant to sit on. */
function addTrack(doc, template, name) {
  const t = clone(template);
  t.id = mint(`track:${name}`);
  t.segments = [];
  t.name = name;
  doc.tracks.push(t);
  return t;
}

function ensureSfx(doc, which, atSeconds, key) {
  const p = sigPresets();
  const tpl = p.audioTemplates[which];
  if (!tpl) return null;
  let mat = (doc.materials.audios || []).find(m => m.name === tpl.name);
  if (!mat) { mat = clone(tpl); mat.id = mint(`audio:${which}`); arr(doc, 'audios').push(mat); }
  // reuse polish's audio segment shape — it was captured from a real CapCut clip
  return { materialId: mat.id, at: atSeconds, key, duration: Math.min(S(tpl.duration || US(0.5)), 1.2) };
}

export function opSignature(doc, op, context = {}) {
  SEED = op.__seed || null;
  const p = sigPresets();
  const rules = p.rules;
  const result = { logos: [], endcard: null, zooms: [], sfx: 0 };

  // Start clean — but ONLY for the kinds this op actually writes. Wiping all three
  // unconditionally meant `capcutctl zoom` (which writes neither a logo nor an endcard)
  // deleted the endcard and its Culin cue and never put them back: 11 tracks in, 9 out,
  // silently, with `doctor` clean. SFX are attributed to their owner so clearing logos
  // cannot take the endcard's cue with it.
  const writesLogos = Array.isArray(op.logos) && op.logos.length > 0;
  const writesEndcard = !!op.endcard;
  const TAGS = [];
  if (writesLogos) TAGS.push('sig:logo', 'sig:sfx:logo');
  if (writesEndcard) TAGS.push('sig:endcard', 'sig:sfx:endcard');
  // untagged legacy cues predate the attribution; only a pass that rewrites BOTH owners
  // (i.e. `wrap`) can safely claim them.
  if (writesLogos && writesEndcard) TAGS.push('sig:sfx');
  if (TAGS.length) {
    // Everything the outgoing segments own, so the sweep can take the materials with them.
    const orphaned = new Set();
    for (const t of doc.tracks) {
      for (const s of t.segments || []) {
        if (!TAGS.includes(s.desc || '')) continue;
        if (s.material_id) orphaned.add(s.material_id);
        for (const r of s.extra_material_refs || []) orphaned.add(r);
      }
    }
    for (const t of doc.tracks) t.segments = (t.segments || []).filter(s => !TAGS.includes(s.desc || ''));
    doc.tracks = doc.tracks.filter(t => !(t.name || '').startsWith('sig-') || (t.segments || []).length);

    // Dropping the segments alone is not enough. A stale logo VIDEO material left behind
    // still carries a path, and CapCut scans materials — not tracks — when it decides
    // whether media is missing, so a re-run that relocated the artwork greeted the next
    // open with the "Link media" dialog even though every surviving segment was fine.
    // video_effects have the matching problem: they bind to a segment id that is gone.
    const live = new Set();
    for (const t of doc.tracks) {
      for (const s of t.segments || []) {
        if (s.material_id) live.add(s.material_id);
        for (const r of s.extra_material_refs || []) live.add(r);
      }
    }
    for (const kind of ['videos', 'video_effects', 'effects']) {
      if (!doc.materials?.[kind]) continue;
      doc.materials[kind] = doc.materials[kind].filter(m => !orphaned.has(m.id) || live.has(m.id));
    }
  }

  // Preset 3 leftover is a parts bin. Park it after a gap, then place Follow on the talking head.
  if (context.projectDir) parkPresetLeftover(doc, context, op);

  const pending = [];
  const editUs = contentEndUs(doc, context.projectDir);

  /* ---- logos ---- */
  for (const [i, l] of (op.logos || []).entries()) {
    if (!l.logo || !fs.existsSync(l.logo)) {
      throw new CapcutError(`no logo file for "${l.brand}"${l.logo ? ` at ${l.logo}` : ''}. `
        + `Run \`capcutctl brands\` to see which brands still need a transparent PNG.`,
        { code: 'NO_LOGO_ASSET', exitCode: 2 });
    }
    const key = `logo:${i}:${l.brand}`;
    const mat = clone(p.logoMaterialTemplate);
    mat.id = mint(`mat:${key}`);
    // CapCut is sandboxed: it cannot open a file it did not pick itself, and a logo left
    // pointing outside the draft raises the "Link media" dialog on the next open — the
    // project is correct on disk and unusable in the app. `add` has always copied its media
    // in; this did not, so every brand pop from a folder CapCut lacks access to was broken.
    const logoPath = (l.localize === false || !context.projectDir)
      ? l.logo
      : localizeMedia(context.projectDir, path.resolve(l.logo), undefined, { dryRun: context.dryRun });
    mat.path = logoPath;
    mat.material_name = path.basename(logoPath);
    mat.local_material_id = mint(`lm:${key}`);
    const px = imageSize(l.logo) || imageSize(logoPath);
    const tplW = p.logoMaterialTemplate.width || 1280;
    const tplH = p.logoMaterialTemplate.height || 276;
    // Falling back to the template's 1280x276 is the exact bug this probe exists to fix, and
    // it fails silently — the logo just renders as a squashed strip. Refuse instead.
    if (!px) {
      throw new CapcutError(
        `Could not read the pixel size of ${path.basename(l.logo)}. CapCut lays out from the `
        + 'material dimensions, so guessing them renders the logo at the wrong aspect. '
        + 'Convert it to PNG, or check the file is a real image.',
        { code: 'LOGO_SIZE_UNKNOWN', exitCode: 2 });
    }
    mat.width = px.width;
    mat.height = px.height;
    arr(doc, 'videos').push(mat);

    const requested = l.scale ?? rules.logoDefaultScale;
    const scale = logoScaleFor(px.width, px.height, requested,
      doc.canvas_config || { width: 1080, height: 1920 }, { width: tplW, height: tplH });
    const remaining = S(editUs) - (l.at ?? 0);
    if (!(remaining > 0.35)) {
      result.logos.push({ brand: l.brand, at: l.at, skipped: 'past-end' });
      continue;
    }
    const hold = Math.min(l.hold ?? rules.logoHoldSeconds, remaining);
    const seg = clone(p.logoSegmentTemplate);
    seg.id = mint(`seg:${key}`);
    seg.material_id = mat.id;
    seg.extra_material_refs = instantiateExtras(doc, p.logoExtraTemplates, key);
    seg.target_timerange = { start: US(l.at), duration: US(hold) };
    if (seg.source_timerange) seg.source_timerange = { start: 0, duration: US(hold) };
    seg.clip = clone(seg.clip);
    seg.clip.scale = { x: rules.logoPop.from, y: rules.logoPop.from };
    if (l.pos) seg.clip.transform = { ...seg.clip.transform, x: l.pos[0], y: l.pos[1] };
    seg.desc = 'sig:logo';

    // Two reveals. The default is the measured two-key linear pop. `glow` is the overshoot
    // reveal: the same mark on two stacked tracks, the lower one blown up, blurred and lit,
    // its alpha bursting on the overshoot frame and decaying to an ambient halo.
    const glow = l.glow ?? op.glow ?? false;
    if (!glow) {
      seg.common_keyframes = popKeyframes(rules.logoPop.from, scale, l.ramp ?? rules.logoPop.rampSeconds, key);
      const track = addTrack(doc, p.logoTrackTemplate, `sig-logo-${i}`);
      track.segments.push(seg);
      result.logos.push({ brand: l.brand, at: l.at, scale, hold, logo: logoPath, reveal: 'pop' });
    } else {
      const g = rules.logoGlow;
      const h = g.handles;
      const baseY = seg.clip.transform?.y ?? 0;

      // --- glow underlay: cloned first so its track sits BELOW the core mark ---
      const uKey = `${key}:glow`;
      const under = clone(seg);
      under.id = mint(`seg:${uKey}`);
      under.extra_material_refs = instantiateExtras(doc, p.logoExtraTemplates, uKey);
      under.clip = clone(seg.clip);
      // Base clip values are the RESTING state, not the first keyframe. CapCut animates from
      // the keyframes and ignores these, but everything that does not read keyframes — the
      // `qa` compositor, thumbnailers — falls back to them, and a base of alpha 0 / scale 0.15
      // makes the mark invisible in every one of those. Resting values fail visible.
      under.clip.scale = { x: scale * g.underlay.scale[2][1], y: scale * g.underlay.scale[2][1] };
      under.clip.alpha = g.underlay.alpha.at(-1)[1];
      under.common_keyframes = [
        easedBlock('KFTypeScaleX', g.underlay.scale.map(([t, v]) => [t, scale * v]), uKey, hold, h),
        easedBlock('KFTypeAlpha', g.underlay.alpha, uKey, hold, h),
      ].filter(Boolean);
      under.extra_material_refs.push(
        attachEffect(doc, p.glowEffect, under.id, `${uKey}:glow`),
        attachEffect(doc, p.blurEffect, under.id, `${uKey}:blur`,
          { effects_adjust_blur: g.underlay.blur }));
      // Screen, so the halo ADDS light instead of laying a pale copy over the picture.
      // CapCut writes a blend mode as a materials.effects record of type "mix_mode" — this
      // one was set by hand in CapCut and harvested, never invented.
      if (g.underlay.blend !== false && p.mixModeScreen) {
        const blend = clone(p.mixModeScreen);
        delete blend._source; delete blend._note;
        blend.id = mint(`mix:${uKey}`);
        arr(doc, 'effects').push(blend);
        under.extra_material_refs.push(blend.id);
      }
      under.desc = 'sig:logo';
      addTrack(doc, p.logoTrackTemplate, `sig-logo-glow-${i}`).segments.push(under);

      // --- core mark: overshoot, settle, ambient drift ---
      seg.clip.scale = { x: scale * g.core.scale[2][1], y: scale * g.core.scale[2][1] };
      seg.clip.alpha = 1;
      seg.common_keyframes = [
        easedBlock('KFTypeScaleX', g.core.scale.map(([t, v]) => [t, scale * v]), key, hold, h),
        easedBlock('KFTypeAlpha', g.core.alpha, key, hold, h),
        easedBlock('KFTypePositionY', g.core.riseY.map(([t, v]) => [t, baseY + v]), key, hold, h),
      ].filter(Boolean);
      addTrack(doc, p.logoTrackTemplate, `sig-logo-${i}`).segments.push(seg);
      result.logos.push({ brand: l.brand, at: l.at, scale, hold, logo: logoPath, reveal: 'glow',
                          overshoot: g.core.scale[1][1], underlayAlpha: g.underlay.alpha.at(-1)[1] });
    }
    if (!op.noSfx) {
      const cue = ensureSfx(doc, rules.logoSfx, l.at - rules.logoSfxLeadSeconds, key);
      if (cue) { cue.owner = 'logo'; cue.duration = Math.min(cue.duration, S(editUs) - cue.at); pending.push(cue); }
    }
  }

  /* ---- endcard ---- */
  if (op.endcard) {
    const e = op.endcard;
    // Follow sits on the talking head, never on the parked Preset 3 leftover.
    // 96% of 52.366666s rounded to 3dp used to land 334us past the end; stay in microseconds.
    const durUs = editUs || doc.duration || 0;
    const atUs = e.at != null ? US(e.at) : Math.round(durUs * rules.endcard.atFractionOfDuration);
    const holdUs = e.hold != null ? US(e.hold) : Math.max(US(0.8), durUs - atUs);
    const at = S(atUs);
    const hold = S(Math.min(holdUs, Math.max(US(0.4), durUs - atUs)));
    const key = 'endcard';
    const mat = clone(p.textMaterialTemplate);
    mat.id = mint(`mat:${key}`);
    const style = JSON.parse(mat.content);
    style.text = e.text ?? rules.endcardDefaultText;
    if (style.styles?.[0]) style.styles[0].range = [0, style.text.length];
    mat.content = JSON.stringify(style);
    arr(doc, 'texts').push(mat);

    const seg = clone(p.textSegmentTemplate);
    seg.id = mint(`seg:${key}`);
    seg.material_id = mat.id;
    seg.extra_material_refs = instantiateExtras(doc, p.textExtraTemplates, key);
    seg.target_timerange = { start: US(at), duration: US(hold) };
    seg.clip = clone(seg.clip);
    seg.clip.scale = { x: rules.endcard.from, y: rules.endcard.from };
    seg.common_keyframes = popKeyframes(rules.endcard.from, e.scale ?? rules.endcard.to,
                                        e.ramp ?? rules.endcard.rampSeconds, key);
    seg.desc = 'sig:endcard';
    const track = addTrack(doc, p.textTrackTemplate, 'sig-endcard');
    track.segments.push(seg);
    if (!op.noSfx) {
      const cue = ensureSfx(doc, rules.endcardSfx, at - rules.endcardSfxLeadSeconds, key);
      if (cue) { cue.owner = 'endcard'; cue.duration = Math.min(cue.duration, S(durUs) - cue.at); pending.push(cue); }
    }
    result.endcard = { text: style.text, at, hold };
  }

  /* ---- face push-ins ---- */
  if ((op.zooms || []).length) {
    const { track } = principalTrack(doc, op.track ?? null);
    for (const [i, z] of op.zooms.entries()) {
      const seg = track.segments.find(s =>
        S(s.target_timerange.start) <= z.at + 0.02
        && S(s.target_timerange.start + s.target_timerange.duration) > z.at + 0.02);
      if (!seg) throw new CapcutError(`no clip on the principal track covers ${z.at}s`, { code: 'NO_CLIP_AT', exitCode: 2 });
      if ((seg.common_keyframes || []).some(k => (k.keyframe_list || []).length)) {
        result.zooms.push({ at: z.at, skipped: 'already keyframed' });
        continue;
      }
      const srcStart = seg.source_timerange ? seg.source_timerange.start : 0;
      const speed = seg.source_timerange
        ? seg.source_timerange.duration / seg.target_timerange.duration : 1;
      // keyframe offsets on a video segment are absolute SOURCE positions
      const into = (z.at - S(seg.target_timerange.start)) * speed;
      const ramp = (z.ramp ?? rules.faceZoom.rampSeconds) * speed;
      const to = z.to ?? rules.faceZoom.to;
      const kf = popKeyframes(rules.faceZoom.from, to, 0, `zoom:${i}`)[0];
      kf.keyframe_list[0].time_offset = Math.round(srcStart + US(into));
      kf.keyframe_list[1].time_offset = Math.round(srcStart + US(into + ramp));
      if (z.hold !== 0) {
        const holdS = (z.hold ?? rules.faceZoomHoldSeconds) * speed;
        const endSrc = srcStart + seg.source_timerange?.duration;
        const outAt = Math.round(srcStart + US(into + ramp + holdS));
        const backAt = Math.round(outAt + US(ramp));
        if (!endSrc || backAt <= endSrc) {
          kf.keyframe_list.push(
            { ...clone(kf.keyframe_list[1]), id: mint(`kfc:${i}`), time_offset: outAt, values: [to] },
            { ...clone(kf.keyframe_list[0]), id: mint(`kfd:${i}`), time_offset: backAt, values: [rules.faceZoom.from] });
        }
      }
      seg.common_keyframes = [kf];
      result.zooms.push({ at: z.at, to, hold: z.hold ?? rules.faceZoomHoldSeconds,
                          shape: kf.keyframe_list.length === 4 ? 'push-hold-release' : 'push' });
    }
  }

  /* ---- the sounds, all onto one lane ---- */
  const cues = pending.filter(Boolean);
  if (cues.length) {
    const { audioSegmentFor, ensureAudioLane } = sigAudio();
    // Cues written before SFX carried an owner are tagged plain `sig:sfx`, and only a pass
    // that rewrites BOTH owners may clear those wholesale (above). A logo-only or
    // endcard-only rerun therefore left the legacy cue sitting on the very beat it had just
    // rewritten — two Culins on one frame. Sweep the stragglers by TIME instead: a legacy
    // cue on a beat we are writing now IS this cue, whoever wrote it.
    const tol = US(0.25);
    const onABeatWeRewrite = s => cues.some(c =>
      Math.abs((s.target_timerange?.start || 0) - US(Math.max(0, c.at))) <= tol);
    for (const t of doc.tracks) {
      t.segments = (t.segments || []).filter(s => (s.desc || '') !== 'sig:sfx' || !onABeatWeRewrite(s));
    }
    const lane = ensureAudioLane(doc, 'sig-sfx', mint);
    for (const c of cues) lane.segments.push(audioSegmentFor(doc, c, mint));
    lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    result.sfx = cues.length;
  }

  doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
  if (!result.logos.length && !result.endcard && !result.zooms.length) {
    throw new CapcutError('signature wrote nothing: pass logos, an endcard, or zooms.',
      { code: 'NOTHING_TO_SIGN', exitCode: 2 });
  }
  return result;
}

/** Reuse polish's captured audio-segment shape rather than inventing a second one. */
function sigAudio() {
  return {
    ensureAudioLane(doc, name, mintFn) {
      let t = doc.tracks.find(x => x.type === 'audio' && x.name === name);
      if (t) return t;
      const tpl = doc.tracks.find(x => x.type === 'audio');
      t = clone(tpl || sfxPresets().audioTrackTemplate);
      t.id = mintFn(`track:${name}`);
      t.name = name;
      t.segments = [];
      doc.tracks.push(t);
      return t;
    },
    audioSegmentFor(doc, cue, mintFn) {
      const p = sfxPresets();
      const seg = clone(p.audioSegmentTemplate);
      const refs = [];
      for (const [kind, tpl] of Object.entries(p.audioExtraTemplates)) {
        const m = clone(tpl);
        m.id = mintFn(`${kind}:sig:${cue.key}`);
        if ('bind_segment_id' in m) m.bind_segment_id = '';
        arr(doc, kind).push(m);
        refs.push(m.id);
      }
      seg.id = mintFn(`seg:sig:${cue.key}`);
      seg.material_id = cue.materialId;
      seg.extra_material_refs = refs;
      seg.target_timerange = { start: US(Math.max(0, cue.at)), duration: US(cue.duration) };
      seg.source_timerange = { start: 0, duration: US(cue.duration) };
      seg.volume = 1;
      seg.last_nonzero_volume = 1;
      seg.desc = cue.owner ? `sig:sfx:${cue.owner}` : 'sig:sfx';
      return seg;
    },
  };
}
