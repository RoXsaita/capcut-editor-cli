/**
 * Loudness match via clip `volume` — `capcutctl loudness`.
 *
 * Measure integrated LUFS per source with ffmpeg ebur128, then set each speech/SFX
 * segment's `volume` so playback lands at −14 LUFS (configurable). Music beds are
 * out of scope (F23 / F20). Only attenuation (volume < 1.0) is round-tripped;
 * a needed boost is VOLUME_BOOST_UNVERIFIED unless --allow-boost.
 *
 * Does not touch CapCut's `loudnesses.enable` / `target_loudness`. Fades stay
 * on `audio_fades` extras; stereo layout is not rewritten.
 *
 * Tests inject `op.measurements` so they never shell ffmpeg or bind to
 * ~/Downloads/.video-index.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CapcutError, requireBinary, resolveMediaPath } from './core.mjs';
import { isBrollSegment } from './broll-lint.mjs';

const r3 = n => Math.round(n * 1000) / 1000;
const r6 = n => Math.round(n * 1e6) / 1e6;

export const DEFAULT_TARGET_LUFS = -14;
export const LUFS_CACHE_VERSION = 1;

export function volumeForLufs(measuredLufs, targetLufs = DEFAULT_TARGET_LUFS) {
  if (!Number.isFinite(measuredLufs) || !Number.isFinite(targetLufs)) {
    throw new CapcutError('loudness needs finite measured and target LUFS.', {
      code: 'BAD_LUFS', exitCode: 2,
    });
  }
  return 10 ** ((targetLufs - measuredLufs) / 20);
}

export function playbackLufs(measuredLufs, volume) {
  const v = Number(volume);
  if (!(v > 0)) return null;
  return measuredLufs + 20 * Math.log10(v);
}

export function parseEbur128(text) {
  const body = String(text || '');
  const summary = body.split(/Summary:/i).at(-1) || body;
  const match = summary.match(/\bI:\s*([+-]?\d+(?:\.\d+)?)\s*LUFS/i)
    || summary.match(/Integrated loudness:\s*([+-]?\d+(?:\.\d+)?)\s*LUFS/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function defaultCacheDir() {
  return path.join(os.homedir(), 'Downloads', '.video-index');
}

function cacheKey(file) {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  return `${stem}.lufs.json`;
}

function fileToken(file) {
  const st = fs.statSync(file);
  return { path: path.resolve(file), mtimeMs: Math.round(st.mtimeMs), size: st.size };
}

export function readLufsCache(file, { cacheDir } = {}) {
  const token = fileToken(file);
  const dest = path.join(cacheDir || defaultCacheDir(), cacheKey(file));
  if (!fs.existsSync(dest)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
    if (parsed?.version !== LUFS_CACHE_VERSION) return null;
    if (parsed.path !== token.path || parsed.mtimeMs !== token.mtimeMs || parsed.size !== token.size) {
      return null;
    }
    const lufs = Number(parsed.integratedLufs);
    return Number.isFinite(lufs) ? lufs : null;
  } catch {
    return null;
  }
}

function writeLufsCache(file, lufs, { cacheDir } = {}) {
  const dir = cacheDir || defaultCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const token = fileToken(file);
  const dest = path.join(dir, cacheKey(file));
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: LUFS_CACHE_VERSION,
    ...token,
    integratedLufs: lufs,
  }));
  fs.renameSync(tmp, dest);
}

export function measureIntegratedLufs(file, { cacheDir, measurements } = {}) {
  const resolved = path.resolve(file);
  const injected = lookupMeasurement(measurements, { path: resolved, id: null });
  if (injected != null) return injected;
  const cached = readLufsCache(resolved, { cacheDir });
  if (cached != null) return cached;
  requireBinary('ffmpeg', 'measuring integrated LUFS');
  const result = spawnSync('ffmpeg', [
    '-nostats', '-i', resolved, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 120_000 });
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (result.error) {
    throw new CapcutError(`ffmpeg could not measure LUFS for ${path.basename(resolved)}: ${result.error.message}`, {
      code: 'LUFS_MEASURE_FAILED', exitCode: 2,
    });
  }
  const lufs = parseEbur128(text);
  if (lufs == null) {
    throw new CapcutError(`ffmpeg ebur128 produced no Integrated loudness for ${path.basename(resolved)}.`, {
      code: 'LUFS_MEASURE_FAILED', exitCode: 2, details: { status: result.status },
    });
  }
  try { writeLufsCache(resolved, lufs, { cacheDir }); } catch { /* cache is optional */ }
  return lufs;
}

function lookupMeasurement(measurements, { path: mediaPath, id }) {
  if (measurements == null) return null;
  if (typeof measurements === 'number' && Number.isFinite(measurements)) return measurements;
  if (Array.isArray(measurements)) {
    const hit = measurements.find(row => row && (
      (id && row.id === id)
      || (mediaPath && (row.path === mediaPath || path.basename(row.path || '') === path.basename(mediaPath)))
    ));
    const value = Number(hit?.lufs ?? hit?.integrated ?? hit?.I);
    return Number.isFinite(value) ? value : null;
  }
  if (typeof measurements === 'object') {
    const keys = [id, mediaPath, mediaPath && path.basename(mediaPath)].filter(Boolean);
    for (const key of keys) {
      const raw = measurements[key];
      const value = typeof raw === 'object' ? Number(raw?.lufs ?? raw?.integrated) : Number(raw);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function materialFor(doc, id) {
  for (const values of Object.values(doc.materials || {})) {
    if (!Array.isArray(values)) continue;
    const found = values.find(item => item && item.id === id);
    if (found) return found;
  }
  return null;
}

export function isMusicSegment(track, segment, material) {
  const desc = String(segment?.desc || '');
  const name = String(track?.name || '');
  const matName = String(material?.name || material?.material_name || '');
  if (desc === 'finish:music' || desc.startsWith('finish:music')) return true;
  if (name === 'finish-music' || name === 'sig-music') return true;
  if (material?.type === 'music') return true;
  if (matName === 'finish-music') return true;
  return false;
}

function isPlate(segment, material) {
  const desc = String(segment?.desc || '');
  if (desc.startsWith('layout:') || desc.startsWith('sig:')) return true;
  if (material?.type && material.type !== 'video' && material.type !== 'extract' && material.type !== 'audio') {
    return true;
  }
  return false;
}

/**
 * speech = talking-head video (and leftover voice audio).
 * sfx = polish/signature audio that is not the bed.
 * music / skip are left alone.
 */
export function classifyLoudnessRole(track, segment, material) {
  if (isMusicSegment(track, segment, material)) return 'music';
  if (track?.type === 'audio') {
    const desc = String(segment?.desc || '');
    if (desc.startsWith('polish:') || desc.startsWith('sig:sfx') || desc === 'sig:sfx') return 'sfx';
    return 'speech';
  }
  if (track?.type !== 'video' || track?.flag === 0) return 'skip';
  if (isPlate(segment, material)) return 'skip';
  if (isBrollSegment(segment, material)) return 'skip';
  if (material?.type && material.type !== 'video') return 'skip';
  return 'speech';
}

function snapshotFades(doc, segment) {
  const fades = new Map((doc.materials?.audio_fades || []).map(fade => [fade.id, fade]));
  const refs = [...(segment.extra_material_refs || [])];
  const extras = refs.filter(id => fades.has(id)).map(id => ({
    id,
    fade_in_duration: fades.get(id).fade_in_duration,
    fade_out_duration: fades.get(id).fade_out_duration,
    fade_type: fades.get(id).fade_type,
  }));
  return { refs, extras };
}

export function opLoudness(doc, op = {}, context = {}) {
  const target = op.target != null ? Number(op.target) : DEFAULT_TARGET_LUFS;
  if (!Number.isFinite(target)) {
    throw new CapcutError('loudness --target must be a finite LUFS value.', {
      code: 'BAD_LUFS', exitCode: 2,
    });
  }
  const allowBoost = Boolean(op.allowBoost);
  const selected = op.segments == null ? null : new Set(
    (Array.isArray(op.segments) ? op.segments : String(op.segments).split(','))
      .map(id => String(id).trim()).filter(Boolean),
  );
  if (selected) {
    const ids = new Set((doc.tracks || []).flatMap(t => (t.segments || []).map(s => s.id)));
    if (!selected.size || [...selected].some(id => !ids.has(id))) {
      throw new CapcutError('loudness --segments must name existing segment IDs.', { code: 'SELECTOR_EMPTY', exitCode: 2 });
    }
  }
  const loudnessesBefore = doc.loudnesses ? JSON.stringify(doc.loudnesses) : null;
  const segments = [];
  const skipped = [];
  const refused = [];
  let changed = 0;

  for (const track of doc.tracks || []) {
    for (const segment of track.segments || []) {
      if (selected && !selected.has(segment.id)) continue;
      const material = materialFor(doc, segment.material_id);
      const role = classifyLoudnessRole(track, segment, material);
      if (role === 'music') {
        skipped.push({ id: segment.id, reason: 'music' });
        continue;
      }
      if (role === 'skip') continue;

      const mediaPath = resolveMediaPath(material?.path, context.projectDir) || material?.path || '';
      let measured = lookupMeasurement(op.measurements, { path: mediaPath, id: material?.id });
      if (measured == null && mediaPath && op.measurements == null) {
        if (!fs.existsSync(mediaPath)) {
          skipped.push({ id: segment.id, reason: 'no media', path: mediaPath });
          continue;
        }
        measured = measureIntegratedLufs(mediaPath, { cacheDir: op.cacheDir });
      }
      if (!Number.isFinite(measured)) {
        throw new CapcutError(
          `loudness has no LUFS measurement for ${path.basename(mediaPath) || segment.id}. Inject op.measurements in tests, or keep ffmpeg on PATH.`,
          { code: 'LUFS_MEASURE_FAILED', exitCode: 2, details: { id: segment.id } },
        );
      }
      // ebur128 reports its -70 LUFS floor for silence and sub-gate short SFX.
      // That is not a usable measurement and must never become a 631x boost.
      if (measured <= -69.9) {
        refused.push({ id: segment.id, code: 'LUFS_UNMEASURABLE', measuredLufs: measured,
          message: 'No gated loudness measurement; keep this silent or short clip at its reviewed volume.' });
        continue;
      }

      const previousVolume = segment.volume == null ? 1 : Number(segment.volume);
      const needed = volumeForLufs(measured, target);
      const fades = snapshotFades(doc, segment);
      const row = {
        id: segment.id,
        kind: role,
        source: mediaPath || material?.id || null,
        beforeLufs: r3(playbackLufs(measured, previousVolume > 0 ? previousVolume : 1) ?? measured),
        measuredLufs: r3(measured),
        previousVolume: r6(previousVolume),
        volume: r6(needed),
        afterLufs: r3(playbackLufs(measured, needed)),
      };

      if (needed > 1) {
        const boost = {
          ...row,
          code: 'VOLUME_BOOST_UNVERIFIED',
          neededVolume: r6(needed),
        };
        if (!allowBoost) {
          refused.push(boost);
          continue;
        }
        segment.volume = needed;
        if ('last_nonzero_volume' in segment) segment.last_nonzero_volume = needed;
        changed++;
        segments.push({
          ...row,
          afterLufs: r3(playbackLufs(measured, needed)),
          unverified: true,
          warning: 'UNVERIFIED: clip volume > 1.0 has never been round-tripped through CapCut. Apply on a disposable copy.',
        });
        continue;
      }

      segment.volume = needed;
      if ('last_nonzero_volume' in segment) segment.last_nonzero_volume = needed;
      changed++;
      segments.push(row);
      const fadesAfter = snapshotFades(doc, segment);
      if (JSON.stringify(fades) !== JSON.stringify(fadesAfter)) {
        throw new CapcutError('loudness must not rewrite audio fades.', { code: 'FADE_MUTATED', exitCode: 2 });
      }
    }
  }

  if (loudnessesBefore != null && JSON.stringify(doc.loudnesses) !== loudnessesBefore) {
    throw new CapcutError('loudness must not touch CapCut loudnesses.enable / target_loudness (that is F20).', {
      code: 'LOUDNESS_MASTER_TOUCHED', exitCode: 2,
    });
  }

  return {
    target,
    changed,
    segments,
    refused,
    skipped,
    ...(allowBoost && segments.some(row => row.unverified) ? {
      unverified: true,
      warning: 'UNVERIFIED: clip volume > 1.0 has never been round-tripped through CapCut.',
    } : {}),
  };
}
