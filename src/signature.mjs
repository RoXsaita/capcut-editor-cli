import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CapcutError, clone, uuid, allSegments, loadPreset } from './core.mjs';
import { principalTrack, sfxPresets } from './polish.mjs';
import { contentEndUs, parkPresetLeftover } from './add.mjs';

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
function mint(key) {
  if (!SEED) return uuid();
  const h = crypto.createHash('sha256').update(`${SEED}|${key}`).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
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
  return hits.sort((a, b) => a.at - b.at);
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
    for (const t of doc.tracks) t.segments = (t.segments || []).filter(s => !TAGS.includes(s.desc || ''));
    doc.tracks = doc.tracks.filter(t => !(t.name || '').startsWith('sig-') || (t.segments || []).length);
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
    mat.path = l.logo;
    mat.material_name = path.basename(l.logo);
    mat.local_material_id = mint(`lm:${key}`);
    const px = imageSize(l.logo);
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
    seg.common_keyframes = popKeyframes(rules.logoPop.from, scale, l.ramp ?? rules.logoPop.rampSeconds, key);
    seg.desc = 'sig:logo';

    const track = addTrack(doc, p.logoTrackTemplate, `sig-logo-${i}`);
    track.segments.push(seg);
    if (!op.noSfx) {
      const cue = ensureSfx(doc, rules.logoSfx, l.at - rules.logoSfxLeadSeconds, key);
      if (cue) { cue.owner = 'logo'; cue.duration = Math.min(cue.duration, S(editUs) - cue.at); pending.push(cue); }
    }
    result.logos.push({ brand: l.brand, at: l.at, scale, hold, logo: l.logo });
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
      const p = loadPreset('sfx');
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
