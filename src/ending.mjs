/** Reusable follow ending: private profile + supplied frame, rendered by the existing scene engine. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CapcutError, allSegments, applySpec, assertCapcutClosed, loadProject, managedFile, preservedRange,
  principalEndUs, requireBinary, resolveMediaPath,
} from './core.mjs';
import { loadProfile, profileLayers, userDir } from './profile.mjs';
import { FOLLOW_ENDING_ID, isFollowEnding } from './mograph-place.mjs';
import { probeScene, renderScene, sceneFingerprint } from './mograph-scene.mjs';
import { principalTrack } from './polish.mjs';

const fail = (code, message) => { throw new CapcutError(message, { code, exitCode: 2 }); };
const expandHome = value => String(value).replace(/^~(?=$|\/)/, os.homedir());
const SCENE = 'follow-ending';
const DURATION = 3;
const COPY = ['pill', 'headline', 'sub', 'badge', 'faceX', 'faceY', 'faceScale'];

const sorted = list => [...list].sort((a, b) => a.time_offset - b.time_offset);

/** A keyframed value at a source-time offset, linear between keys; eased spans are approximate. */
function keyed(segment, property, atUs, fallback, notes) {
  const keys = sorted((segment.common_keyframes || []).find(k => k.property_type === property)?.keyframe_list || []);
  if (!keys.length) return fallback;
  if (atUs <= keys[0].time_offset) return keys[0].values[0];
  if (atUs >= keys.at(-1).time_offset) return keys.at(-1).values[0];
  const b = keys.findIndex(k => k.time_offset >= atUs), a = keys[b - 1], z = keys[b];
  if (a.values[0] !== z.values[0] && [a, z].some(k => k.curveType && k.curveType !== 'Line')) notes.add(`${property} mid-ease`);
  return a.values[0] + (z.values[0] - a.values[0]) * (atUs - a.time_offset) / (z.time_offset - a.time_offset);
}

/**
 * The edit's last picture, from the principal clip's own media: its last displayed source frame,
 * fitted to the canvas with the clip's scale, position and flip at that moment. Anything CapCut
 * draws over it (text, overlays) is not in the media and cuts away as the ending starts: `onTop`.
 * What the frame can only approximate (eased keys, masks, effects, crop) is `approximate`.
 */
export function captureLastFrame(doc, projectDir, { fps = 30, width = 1080, height = 1920 } = {}) {
  const ended = structuredClone(doc);
  for (const track of ended.tracks || []) track.segments = (track.segments || []).filter(s => !isFollowEnding(doc, s));
  const end = principalEndUs(ended, projectDir);
  const { track } = principalTrack(ended);
  const segment = (track.segments || []).find(s => Math.abs(s.target_timerange.start + s.target_timerange.duration - end) <= 1000);
  if (!segment) fail('ENDING_FRAME_CAPTURE', 'could not find the clip that ends the edit; pass --frame.');
  const material = (doc.materials?.videos || []).find(m => m.id === segment.material_id);
  const media = resolveMediaPath(material?.path, projectDir);
  if (!media || !fs.existsSync(media)) fail('ENDING_FRAME_CAPTURE', `the last clip's media is missing (${media || 'no path'}); pass --frame.`);
  const st = segment.source_timerange || { start: 0, duration: segment.target_timerange.duration };
  const speed = st.duration / segment.target_timerange.duration;
  const atUs = Math.max(st.start, st.start + st.duration - Math.round(1e6 / fps * speed));
  const notes = new Set();
  const clip = segment.clip || {};
  const sx = keyed(segment, 'KFTypeScaleX', atUs, clip.scale?.x ?? 1, notes);
  const linked = !(segment.common_keyframes || []).some(k => k.property_type === 'KFTypeScaleY');
  const sy = linked && (segment.common_keyframes || []).some(k => k.property_type === 'KFTypeScaleX') ? sx
    : keyed(segment, 'KFTypeScaleY', atUs, clip.scale?.y ?? clip.scale?.x ?? 1, notes);
  const tx = keyed(segment, 'KFTypePositionX', atUs, clip.transform?.x ?? 0, notes);
  const ty = keyed(segment, 'KFTypePositionY', atUs, clip.transform?.y ?? 0, notes);
  if (keyed(segment, 'KFTypeRotation', atUs, clip.rotation ?? 0, notes)) notes.add('rotation');
  if (keyed(segment, 'KFTypeAlpha', atUs, clip.alpha ?? 1, notes) < 1) notes.add('alpha');
  const refs = new Set(segment.extra_material_refs || []);
  for (const kind of ['common_mask', 'effects', 'video_effects', 'filters']) {
    if ((doc.materials?.[kind] || []).some(m => refs.has(m.id))) notes.add(kind);
  }
  const crop = material?.crop;
  if (crop && [crop.upper_left_x, crop.upper_left_y, crop.lower_left_x].some(v => Math.abs(v || 0) > 1e-6)) notes.add('crop');
  const last = end - Math.round(1e6 / fps), onTop = [];
  for (const { track: t, segment: s } of allSegments(ended)) {
    if (s === segment || t === track || !['video', 'text', 'sticker', 'effect', 'filter', 'adjust'].includes(t.type)) continue;
    const a = s.target_timerange?.start, d = s.target_timerange?.duration;
    if (a <= last && a + d > last) onTop.push(`${t.type}${s.desc ? ` ${s.desc}` : ''}`);
  }
  // CapCut fits media inside the canvas, then applies scale; position units are half the canvas.
  const mw = material?.width || width, mh = material?.height || height;
  const fit = Math.min(width / mw, height / mh);
  const w = Math.max(2, Math.round(mw * fit * Math.abs(sx) / 2) * 2), h = Math.max(2, Math.round(mh * fit * Math.abs(sy) / 2) * 2);
  const x = Math.round((width - w) / 2 + tx * width / 2), y = Math.round((height - h) / 2 - ty * height / 2);
  const flip = [clip.flip?.horizontal && 'hflip', clip.flip?.vertical && 'vflip'].filter(Boolean);
  requireBinary('ffmpeg', 'capturing the last frame for the ending');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-ending-'));
  const out = path.join(dir, 'last-frame.png');
  try {
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', (atUs / 1e6).toFixed(6), '-i', media,
      '-filter_complex', `color=c=black:s=${width}x${height}[bg];[0:v]${[...flip, `scale=${w}:${h}`].join(',')}[fg];[bg][fg]overlay=${x}:${y}:shortest=1,format=rgb24`,
      '-frames:v', '1', '-map_metadata', '-1', '-fflags', '+bitexact', '-y', out], { encoding: 'utf8' });
    if (run.status !== 0 || !fs.existsSync(out)) fail('ENDING_FRAME_CAPTURE', `ffmpeg could not read the last frame of ${media}: ${(run.stderr || '').trim().split('\n')[0]}`);
    return { file: media, data: fs.readFileSync(out), at: atUs / 1e6, clip: segment.id, approximate: [...notes], onTop };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Profile paths are relative to the layer that defines them; explicit --frame is relative to cwd. */
export function endingInput({ frame, profileFile = null, noSfx = false, copy = {}, captured = null } = {}) {
  const profile = loadProfile({ file: profileFile });
  if (profile.canvas.width !== 1080 || profile.canvas.height !== 1920
      || !Number.isFinite(profile.canvas.fps) || profile.canvas.fps <= 0) {
    fail('ENDING_CANVAS', 'follow ending needs a 1080×1920 canvas and a positive fps.');
  }
  if (profile.ending != null && (typeof profile.ending !== 'object' || Array.isArray(profile.ending))) fail('ENDING_PROFILE', 'profile ending must be an object.');
  // Per-video copy (edit.json `ending`) overrides the profile, field by field.
  const config = { ...(profile.ending || {}), ...Object.fromEntries(COPY.filter(k => copy[k] !== undefined).map(k => [k, copy[k]])) };
  let base = process.cwd(), file, data;
  if (frame) captured = null;
  if (!frame && !captured) {
    frame = config.frame;
    base = userDir();
    for (const layer of profileLayers({ file: profileFile }).filter(l => l.present)) {
      if (JSON.parse(fs.readFileSync(layer.file, 'utf8')).ending?.frame !== undefined) base = path.dirname(layer.file);
    }
  }
  if (captured) ({ file, data } = captured);
  else if (typeof frame !== 'string' || !frame.trim()) {
    fail('ENDING_FRAME', 'ending needs --frame PNG|JPG, or ending.frame in your private profile. Supply the final composed frame for a seamless start.');
  } else try {
    file = path.resolve(base, expandHome(frame));
    if (fs.statSync(file).size > 20 * 1024 * 1024) fail('ENDING_FRAME', 'ending frame must be at most 20 MB.');
    data = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENDING_FRAME') throw error;
    fail('ENDING_FRAME', `could not read ending frame ${file}: ${error.message}`);
  }
  const type = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'jpeg' : null;
  if (!type) fail('ENDING_FRAME', 'ending frame must be a PNG or JPEG image.');
  const params = {
    imageData: `data:image/${type};base64,${data.toString('base64')}`,
    faceX: config.faceX ?? 540, faceY: config.faceY ?? 920, faceScale: config.faceScale ?? 0.46,
    pill: config.pill ?? 'Next up', headline: config.headline ?? 'Follow',
    sub: config.sub ?? profile.brand?.handle ?? profile.brand?.name ?? '', badge: config.badge ?? '2', noSfx,
  };
  for (const key of ['pill', 'headline', 'sub', 'badge']) {
    if (typeof params[key] !== 'string' || params[key].length > 100 || /[\r\n]/.test(params[key])) fail('ENDING_PROFILE', `ending.${key} must be a single-line string of at most 100 characters.`);
  }
  if (!params.headline.trim()) fail('ENDING_PROFILE', 'ending.headline must not be empty.');
  for (const [key, max] of [['faceX', 1080], ['faceY', 1920], ['faceScale', 1]]) {
    if (!Number.isFinite(params[key]) || params[key] < 0 || params[key] > max || (key === 'faceScale' && params[key] === 0)) {
      fail('ENDING_PROFILE', `ending.${key} must be a number ${key === 'faceScale' ? 'above zero' : 'at least zero'} and at most ${max}.`);
    }
  }
  // The supplied frame must survive frame zero unchanged; this ending owns its camera and texture.
  const renderProfile = structuredClone(profile);
  Object.assign(renderProfile.tokens.scene, {
    bpm: 120, grain: 0, vignette: 0, blur: { samples: 1, shutter: 0 },
    palette: { ...profile.tokens.scene.palette, ...profile.tokens.color },
  });
  return { frame: file, params, profile: renderProfile };
}

/** Removing our own previous ending before measuring prevents each invocation extending the video again. */
export function planEnding(doc, projectDir, fingerprint, file, { noSfx = false } = {}) {
  const withoutEnding = structuredClone(doc);
  for (const track of withoutEnding.tracks || []) {
    track.segments = (track.segments || []).filter(s => !isFollowEnding(doc, s));
  }
  try { principalTrack(withoutEnding); }
  catch { fail('ENDING_EMPTY', 'cannot append an ending to an edit without a principal picture track.'); }
  const end = principalEndUs(withoutEnding, projectDir);
  if (!(end > 0)) fail('ENDING_EMPTY', 'cannot append an ending to an empty edit.');
  const parked = preservedRange(projectDir);
  if (parked && end + DURATION * 1e6 > parked.start) fail('ENDING_PARKED_RANGE', 'ending would overlap the preserved template range; move that range before appending.');
  return {
    op: 'mograph.place', id: FOLLOW_ENDING_ID, template: `scene:${SCENE}`, format: 'prores',
    file, fingerprint, at: end / 1e6, duration: DURATION,
    box: { x: 0, y: 0, w: 1080, h: 1920 }, sfx: null, ...(noSfx ? { clipVolume: 0 } : {}), importVerified: false,
  };
}

/**
 * In a project the opening frame is the edit's own last picture unless `frame` (--frame, or
 * edit.json ending.frame) names one; the profile's frame is only for a standalone --out render.
 */
export async function runEnding(projectDir, options = {}) {
  let doc = null, captured = null;
  if (projectDir) {
    const loaded = loadProject(projectDir);
    doc = (loaded.groups.find(g => g.name.startsWith('timeline:')) || loaded.groups[0]).doc;
    if (!options.frame) captured = captureLastFrame(doc, projectDir, { fps: doc.fps || 30 });
  }
  const { frame, params, profile } = endingInput({ ...options, captured });
  const fingerprint = sceneFingerprint(SCENE, params, profile);
  let placement = null, file, format;
  if (projectDir) {
    const canvas = doc.canvas_config;
    if (canvas?.width !== 1080 || canvas?.height !== 1920 || (doc.fps && doc.fps !== profile.canvas.fps)) {
      fail('ENDING_CANVAS', 'project must be 1080×1920 with the same fps as the profile.');
    }
    file = managedFile(projectDir, `mograph/ending-${fingerprint}.mov`);
    format = 'prores';
    placement = planEnding(doc, projectDir, fingerprint, file, options);
    if (!options.dryRun) assertCapcutClosed({ forceRunning: options.forceRunning, probe: options.processProbe });
  } else {
    if (typeof options.out !== 'string' || !/\.(mov|mp4)$/i.test(options.out)) fail('ENDING_OUT', 'ending --out must end in .mov or .mp4.');
    file = path.resolve(options.out);
    if (file === frame) fail('ENDING_OUT', 'ending output must not replace the input frame.');
    format = /\.mp4$/i.test(file) ? 'mp4' : 'prores';
  }
  const probed = await probeScene({ scene: SCENE, params, profile });
  if (probed.unsafe.length) fail('SCENE_SAFE_ZONE', `ending text intersects platform UI: ${probed.unsafe[0].text}. Shorten your profile copy.`);
  const report = { dryRun: Boolean(options.dryRun), frame,
    ...(captured ? { captured: { from: captured.file, at: captured.at, clip: captured.clip, approximate: captured.approximate, onTop: captured.onTop } } : {}),
    file, fingerprint, duration: DURATION,
    at: placement?.at ?? 0, end: (placement?.at ?? 0) + DURATION, meta: probed.meta, importVerified: false };
  if (options.dryRun) return { ...report, placement };
  // Content-addressed project files keep the previous ending intact if a render/transaction fails.
  const cached = Boolean(projectDir && fs.existsSync(file) && fs.statSync(file).size > 0);
  if (!cached) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stage = fs.mkdtempSync(path.join(path.dirname(file), '.ending-'));
    try {
      const rendered = await renderScene({ scene: SCENE, params, profile, out: path.join(stage, 'render'), format });
      fs.renameSync(rendered.file, file);
      if (captured) fs.writeFileSync(file.replace(/\.mov$/, '-frame.png'), captured.data);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  const result = placement ? applySpec(projectDir, { version: 1, name: 'ending', operations: [placement] }, options) : null;
  return { ...report, cached, ...(result ? { transaction: result } : {}) };
}
