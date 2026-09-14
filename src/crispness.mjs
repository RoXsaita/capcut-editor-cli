import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { allSegments, resolveMediaPath } from './core.mjs';

/** Finish warns when a clip draws source pixels above this factor. */
export const UPSCALE_WARN = 1.5;
/** Later punch-in (`keyframe --focus`) refuses a zoom whose peak would exceed this. */
export const UPSCALE_REFUSE = 2.0;

const PLATE_EXT = /\.(gif|png|webp|apng|jpe?g|heic)$/i;
const LAYOUT_HELPER = /^layout:(?!screen-recording$)/;
const r3 = n => Math.round(n * 1000) / 1000;
const r2 = n => Math.round(n * 100) / 100;

function canvasSize(canvas) {
  if (Array.isArray(canvas)) return { width: Number(canvas[0]), height: Number(canvas[1]) };
  return {
    width: Number(canvas?.width) || 1080,
    height: Number(canvas?.height) || 1920,
  };
}

/**
 * Flat plates — indigo seam bar, white ring, logos, stills, GIFs — have no video
 * stream to go soft. Same distinction pace/coveringBroll already use.
 */
export function isFlatPlate(segment, material) {
  const desc = String(segment?.desc || '');
  if (LAYOUT_HELPER.test(desc) || desc.startsWith('sig:')) return true;
  if (!material) return false;
  if (material.type && material.type !== 'video') return true;
  const file = String(material.path || '');
  if (/indigo|suheilai-rect|suheilai-circle-white/i.test(file)) return true;
  if (PLATE_EXT.test(file)) return true;
  return false;
}

function cropWindow(crop, cropScale = 1) {
  const xs = [crop?.upper_left_x, crop?.upper_right_x, crop?.lower_left_x, crop?.lower_right_x]
    .map(Number).filter(Number.isFinite);
  const ys = [crop?.upper_left_y, crop?.upper_right_y, crop?.lower_left_y, crop?.lower_right_y]
    .map(Number).filter(Number.isFinite);
  const w = xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 1;
  const h = ys.length >= 2 ? Math.max(...ys) - Math.min(...ys) : 1;
  const zoom = Number.isFinite(Number(cropScale)) && Number(cropScale) > 0 ? Number(cropScale) : 1;
  return {
    w: Math.min(1, Math.max(1e-6, (w > 0 ? w : 1) / zoom)),
    h: Math.min(1, Math.max(1e-6, (h > 0 ? h : 1) / zoom)),
  };
}

function peakClipScale(segment) {
  const baseX = Number(segment?.clip?.scale?.x);
  const baseY = Number(segment?.clip?.scale?.y);
  const xs = [Number.isFinite(baseX) && baseX > 0 ? baseX : 1];
  const ys = [Number.isFinite(baseY) && baseY > 0 ? baseY : xs[0]];
  let sawY = false;
  for (const block of segment?.common_keyframes || []) {
    const values = (block.keyframe_list || [])
      .map(k => Number(k?.values?.[0]))
      .filter(v => Number.isFinite(v) && v > 0);
    if (block.property_type === 'KFTypeScaleX') xs.push(...values);
    if (block.property_type === 'KFTypeScaleY') { sawY = true; ys.push(...values); }
  }
  const peakX = Math.max(...xs);
  const peakY = sawY ? Math.max(...ys) : peakX;
  return Math.max(peakX, peakY);
}

/**
 * Peak upscale factor = (canvas px covered by the clip) / (source px used).
 *
 * CapCut fits the used source into the canvas (`min(canvas/source)`), then multiplies
 * by clip.scale. Peak over Line ScaleX/ScaleY keys (linear interpolation never exceeds
 * a key). Crop shrinks the source pixels in play. Returns factor 0 with `exempt` for
 * plates so a later punch-in can call this and skip them.
 */
export function peakUpscale(segment, sourceDims, canvas, extras = {}) {
  const material = extras.material ?? null;
  if (isFlatPlate(segment, material)) {
    return { factor: 0, exempt: true, reason: 'plate', scale: 0, fit: 0 };
  }
  const sw = Number(sourceDims?.width);
  const sh = Number(sourceDims?.height);
  if (!(sw > 0 && sh > 0)) {
    return { factor: null, exempt: false, unknown: true, reason: 'no-source-dims', scale: 0, fit: 0 };
  }
  const { width: cw, height: ch } = canvasSize(canvas);
  if (!(cw > 0 && ch > 0)) {
    return { factor: null, exempt: false, unknown: true, reason: 'no-canvas', scale: 0, fit: 0 };
  }
  const crop = extras.crop ?? segment?.crop ?? segment?.clip?.crop ?? material?.crop;
  const cropScale = extras.cropScale ?? material?.crop_scale ?? 1;
  const window = cropWindow(crop, cropScale);
  const usedW = sw * window.w;
  const usedH = sh * window.h;
  const fit = Math.min(cw / usedW, ch / usedH);
  const scale = peakClipScale(segment);
  const factor = fit * scale;
  return {
    factor: r3(factor),
    exempt: false,
    unknown: false,
    fit: r3(fit),
    scale: r3(scale),
    crop: window,
    sourceUsed: { width: r3(usedW), height: r3(usedH) },
  };
}

export function probeSourceDims(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '--', file,
    ], { encoding: 'utf8', timeout: 15_000 }).trim();
    const [width, height] = out.split(/[,\s]+/).map(Number);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

export function sourceDimsFor(material, projectDir = null) {
  if (Number(material?.width) > 0 && Number(material?.height) > 0) {
    return { width: Number(material.width), height: Number(material.height) };
  }
  const file = resolveMediaPath(material?.path, projectDir);
  return probeSourceDims(file);
}

/**
 * Per-video-segment crispness rows for the finish scorecard.
 * Plates are listed as exempt; clips without dimensions are skipped rather than guessed.
 */
export function scoreCrispness(doc, { projectDir = null } = {}) {
  const canvas = doc.canvas_config || { width: 1080, height: 1920 };
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const segments = [];
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video') continue;
    const material = videos.get(segment.material_id);
    const measured = peakUpscale(segment, sourceDimsFor(material, projectDir), canvas, { material });
    const at = r2((segment.target_timerange?.start || 0) / 1e6);
    const row = {
      id: segment.id,
      at,
      desc: segment.desc || '',
      factor: measured.factor,
      scale: measured.scale,
      fit: measured.fit,
      exempt: Boolean(measured.exempt),
      unknown: Boolean(measured.unknown),
      warn: measured.factor != null && measured.factor > UPSCALE_WARN,
    };
    segments.push(row);
  }
  const measured = segments.filter(row => row.factor != null && !row.exempt);
  const warnings = measured.filter(row => row.warn);
  const peak = measured.reduce((best, row) => (best == null || row.factor > best.factor ? row : best), null);
  return {
    warnAbove: UPSCALE_WARN,
    refuseAbove: UPSCALE_REFUSE,
    segments,
    warnings,
    peak: peak ? { id: peak.id, at: peak.at, factor: peak.factor, desc: peak.desc } : null,
  };
}

export function crispnessLine(score) {
  const measured = (score?.segments || []).filter(row => row.factor != null && !row.exempt);
  if (!measured.length) return null;
  const cells = measured.map(row => `${row.id}:${row.factor}×${row.warn ? ' WARN' : ''}`);
  return `upscale ${cells.join('  ')}`;
}
