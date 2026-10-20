/**
 * Loudness match via clip `volume` — `capcutctl loudness`.
 *
 * Measure edited ranges and the mix with ffmpeg ebur128, then set speech clip
 * volume toward −14 LUFS, constrained by true-peak headroom. Music beds are never
 * raised (F23 / F20). SFX keep the level they were placed at (a mograph pop, a
 * `capcutctl sfx` hit, a hand-set level): the clip pass may bring a hot one down to
 * the target but never raises one back up, and otherwise only the peak limiter
 * lowers them. An explicit --segments selection still matches a named SFX to the
 * target. Only attenuation (volume < 1.0) is round-tripped; a needed boost is
 * VOLUME_BOOST_UNVERIFIED unless --allow-boost.
 *
 * Parked parts-bin clips past the content end are neither measured nor rewritten.
 * Volume keyframes (build's duck) are keys of absolute gain that replace the static
 * volume; every volume write here scales them by the same gain. --peak-only
 * (match:false) skips the clip pass and only limits the mix peak.
 *
 * Clip headroom cannot guarantee mix headroom where SFX, music or a scene's sound
 * overlap the voice, so a mix still over the peak ceiling is brought under it by
 * lowering clip volumes (see limitMixPeak) and the change is reported, rather than
 * refused for someone to fix by hand.
 *
 * Does not touch CapCut's `loudnesses.enable` / `target_loudness`. Fades stay
 * on `audio_fades` extras; stereo layout is not rewritten.
 *
 * Tests inject `op.measurements` so they never shell ffmpeg or bind to
 * ~/Downloads/.video-index.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CapcutError, contentEndUs, resolveMediaPath } from './core.mjs';
import { isBrollSegment } from './broll-lint.mjs';
import { pythonForTool, PACKAGE_ROOT } from './python.mjs';

const r3 = n => Math.round(n * 1000) / 1000;
const r6 = n => Math.round(n * 1e6) / 1e6;

export const DEFAULT_TARGET_LUFS = -14;

export function analyzeAudio(doc, projectDir, { mixOnly = false } = {}) {
  const python = pythonForTool('audio_levels.py');
  // Parked parts-bin clips past the edit are not in the video: leave them out of the mix.
  const endUs = contentEndUs(doc, projectDir);
  const result = spawnSync(python.executable, [path.join(PACKAGE_ROOT, 'tools/audio_levels.py')], {
    input: JSON.stringify({ doc, projectDir: projectDir || '.', mixOnly, ...(endUs > 0 ? { contentEndUs: endUs } : {}) }),
    encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new CapcutError(`Edited audio measurement failed: ${result.error?.message || result.stderr?.trim()}`, {
      code: 'AUDIO_MEASURE_FAILED', exitCode: 2,
    });
  }
  return JSON.parse(result.stdout);
}

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
 * sfx = polish/signature/mograph audio that is not the bed, and a scene's own sound.
 * music / skip are left alone.
 */
export function classifyLoudnessRole(track, segment, material) {
  if (isMusicSegment(track, segment, material)) return 'music';
  const graphic = String(segment?.desc || '').startsWith('mograph:');   // a graphic's cue, a scene's own sound
  if (track?.type === 'audio') {
    const desc = String(segment?.desc || '');
    if (graphic || desc.startsWith('polish:') || desc.startsWith('sig:sfx') || desc.startsWith('sfx:')) return 'sfx';
    return 'speech';
  }
  if (track?.type !== 'video' || track?.flag === 0) return 'skip';
  if (isPlate(segment, material)) return 'skip';
  if (isBrollSegment(segment, material)) return 'skip';
  if (material?.type && material.type !== 'video') return 'skip';
  return graphic ? 'sfx' : 'speech';
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

// Land a little under the ceiling: ebur128 reports true peak to 0.1 dB, and -1.0 must read as ≤ -1.0.
const PEAK_MARGIN_DB = 0.2;
// A step around the voice that moved the peak less than this did not touch what makes it.
const MIN_HELP_DB = 0.1;

const volumeKeyBlocks = segment => (segment.common_keyframes || []).filter(b => b?.property_type === 'KFTypeVolume');

/**
 * Set a clip's static volume and scale its volume keys by the same gain: CapCut's keys are
 * absolute gain that replace the static volume, so a duck left alone would play the bed at
 * its old level. Returns an undo function.
 */
function setVolume(segment, volume) {
  const from = segment.volume ?? 1;
  const hadVolume = 'volume' in segment;
  const last = segment.last_nonzero_volume;
  const keys = volumeKeyBlocks(segment).flatMap(b => (b.keyframe_list || []).map(k => [k, k.values ? [...k.values] : k.values]));
  const g = from > 0 ? volume / from : 1;
  segment.volume = volume;
  if ('last_nonzero_volume' in segment) segment.last_nonzero_volume = volume;
  for (const [key] of keys) if (Array.isArray(key.values)) key.values = key.values.map(v => v * g);
  return () => {
    if (hadVolume) segment.volume = from; else delete segment.volume;
    if (last !== undefined) segment.last_nonzero_volume = last;
    for (const [key, values] of keys) key.values = values;
  };
}

function isParked(segment, endUs) {
  return endUs > 0 && Number(segment.target_timerange?.start) >= endUs;
}

/**
 * Bring the measured mix under `peak` dBTP by lowering clip volumes, never raising one (a music
 * level the user set stays a ceiling). First the layers around the voice — SFX, pops, music, a
 * scene's own sound — by the excess: they cause most overlap peaks and barely move integrated
 * loudness; up to three times, and a step that did not help (the voice itself peaks) is undone.
 * Then, if the mix is still over, every layer by the remaining excess: gain is linear, so that
 * step lands.
 */
function limitMixPeak(doc, analysis, mix, peak, { projectDir, selected, endUs }) {
  const layers = [];
  for (const track of doc.tracks || []) {
    for (const segment of track.segments || []) {
      if (!analysis.segments[segment.id] || !((segment.volume ?? 1) > 0) || isParked(segment, endUs)) continue;
      if (selected && !selected.has(segment.id)) continue;
      const role = classifyLoudnessRole(track, segment, materialFor(doc, segment.material_id));
      layers.push({ segment, around: role === 'sfx' || role === 'music' });
    }
  }
  const steps = [];
  const lower = (rows, stage) => {
    const gainDb = peak - PEAK_MARGIN_DB - mix.truePeak;
    const g = 10 ** (gainDb / 20);
    const undo = [];
    const segments = rows.map(({ segment }) => {
      const from = segment.volume ?? 1;
      undo.push(setVolume(segment, from * g));
      return { id: segment.id, from: r6(from), to: r6(segment.volume),
        ...(volumeKeyBlocks(segment).length ? { keysScaled: true } : {}) };
    });
    const prev = mix;
    const after = analyzeAudio(doc, projectDir, { mixOnly: true }).mix;
    steps.push({ stage, gainDb: r3(gainDb), segments, truePeak: after.truePeak == null ? null : r3(after.truePeak) });
    return { prev, after, undo };
  };
  const beforeTruePeak = mix.truePeak;
  const around = layers.filter(l => l.around);
  // The voice adds to the overlap peak too, so one step rarely lands; a few more converge.
  for (let i = 0; i < 3 && around.length && around.length < layers.length && mix.truePeak > peak; i++) {
    const step = lower(around, 'around-voice');
    if (step.after.truePeak == null || step.prev.truePeak - step.after.truePeak < MIN_HELP_DB) {
      for (const restore of step.undo.reverse()) restore();
      steps.pop();
      break;
    }
    mix = step.after;
  }
  if (layers.length && mix.truePeak != null && mix.truePeak > peak) mix = lower(layers, 'whole-mix').after;
  return { mix, report: { ceiling: peak, beforeTruePeak: r3(beforeTruePeak), afterTruePeak: mix.truePeak == null ? null : r3(mix.truePeak),
    afterLufs: mix.lufs == null ? null : r3(mix.lufs), steps } };
}

export function opLoudness(doc, op = {}, context = {}) {
  const target = op.target != null ? Number(op.target) : DEFAULT_TARGET_LUFS;
  if (!Number.isFinite(target)) {
    throw new CapcutError('loudness --target must be a finite LUFS value.', {
      code: 'BAD_LUFS', exitCode: 2,
    });
  }
  const allowBoost = Boolean(op.allowBoost);
  const match = op.match !== false;
  if (!match && op.measurements != null) {
    throw new CapcutError('loudness --peak-only limits the measured mix; it cannot run on injected clip measurements.', {
      code: 'BAD_ARGS', exitCode: 2,
    });
  }
  if (!match && op.limitPeak === false) {
    throw new CapcutError('loudness --peak-only with peak limiting turned off would do nothing.', { code: 'BAD_ARGS', exitCode: 2 });
  }
  const peak = op.peak == null ? -1 : Number(op.peak);
  if (!Number.isFinite(peak) || peak > 0 || peak < -24) {
    throw new CapcutError('loudness --peak must be between -24 and 0 dBTP.', { code: 'BAD_PEAK', exitCode: 2 });
  }
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
  const analysis = op.measurements == null ? analyzeAudio(doc, context.projectDir) : null;
  const before = analysis ? structuredClone(doc) : null;
  const endUs = contentEndUs(doc, context.projectDir);
  const segments = [];
  const skipped = [];
  const refused = [];
  let changed = 0;

  for (const track of match ? doc.tracks || [] : []) {
    for (const segment of track.segments || []) {
      if (selected && !selected.has(segment.id)) continue;
      const material = materialFor(doc, segment.material_id);
      const role = classifyLoudnessRole(track, segment, material);
      if (role === 'skip') continue;
      if (isParked(segment, endUs)) {
        // A parts-bin clip past the edit: not in the video, so its level is not ours to set.
        skipped.push({ id: segment.id, reason: 'parked' });
        continue;
      }
      if (role === 'music') {
        skipped.push({ id: segment.id, reason: 'music' });
        continue;
      }
      if (segment.volume === 0) {
        skipped.push({ id: segment.id, reason: 'muted' });
        continue;
      }

      const mediaPath = resolveMediaPath(material?.path, context.projectDir) || material?.path || '';
      const level = analysis?.segments[segment.id];
      if (analysis && !level) {
        skipped.push({ id: segment.id, reason: 'no audio stream' });
        continue;
      }
      if (level?.keyed) {
        // Its measured level moves with the keys; the peak limiter still scales them.
        skipped.push({ id: segment.id, reason: 'volume keyframes' });
        continue;
      }
      const measured = level?.lufs ?? lookupMeasurement(op.measurements, { path: mediaPath, id: material?.id });
      if (!Number.isFinite(measured)) {
        throw new CapcutError(
          `loudness has no LUFS measurement for ${path.basename(mediaPath) || segment.id}. Inject op.measurements in tests, or keep ffmpeg on PATH.`,
          { code: 'LUFS_MEASURE_FAILED', exitCode: 2, details: { id: segment.id } },
        );
      }
      // ebur128 reports its -70 LUFS floor for silence and sub-gate short SFX.
      // That is not a usable measurement and must never become a 631x boost.
      if (measured <= -69.9 || (level && level.truePeak == null)) {
        refused.push({ id: segment.id, code: 'LUFS_UNMEASURABLE', measuredLufs: measured,
          message: 'No gated loudness measurement; keep this silent or short clip at its reviewed volume.' });
        continue;
      }

      const previousVolume = segment.volume == null ? 1 : Number(segment.volume);
      const desired = volumeForLufs(measured, target);
      const peakSafe = level?.truePeak != null
        ? Math.min(desired, volumeForLufs(level.truePeak, peak)) : desired;
      // An SFX keeps the level it was placed at: never raised back toward the voice target.
      // Only a named --segments selection matches one to the target.
      const capped = role === 'sfx' && !selected && peakSafe > previousVolume;
      const needed = capped ? previousVolume : peakSafe;
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
        ...(level ? {
          beforeTruePeak: level.truePeak == null ? null : r3(playbackLufs(level.truePeak, previousVolume)),
          afterTruePeak: level.truePeak == null ? null : r3(playbackLufs(level.truePeak, needed)),
          peakLimited: peakSafe < desired,
        } : {}),
        ...(capped ? { capped: 'sfx-level' } : {}),
      };
      if (capped) {
        segments.push({ ...row, unchanged: true });
        continue;
      }

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
        setVolume(segment, needed);
        changed++;
        segments.push({
          ...row,
          afterLufs: r3(playbackLufs(measured, needed)),
          unverified: true,
          warning: 'UNVERIFIED: clip volume > 1.0 has never been round-tripped through CapCut. Apply on a disposable copy.',
        });
        continue;
      }

      setVolume(segment, needed);
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

  // --peak-only: the clip pass did not run, so the measured mix is still the current one.
  let after = !analysis ? null : match ? analyzeAudio(doc, context.projectDir, { mixOnly: true }).mix : analysis.mix;
  let peakLimit = null;
  if (after?.truePeak != null && after.truePeak > peak && op.limitPeak !== false) {
    ({ mix: after, report: peakLimit } = limitMixPeak(doc, analysis, after, peak,
      { projectDir: context.projectDir, selected, endUs }));
  }
  if (after?.truePeak != null && after.truePeak > peak + (op.limitPeak === false ? 0.05 : 0)) {
    // Nothing left to lower (a --segments selection that misses the overlap), or limiting was turned off.
    if (before) {
      for (const key of Object.keys(doc)) delete doc[key];
      Object.assign(doc, before);
    }
    throw new CapcutError('The combined mix exceeds the peak ceiling. Lower overlapping music/SFX or choose a lower loudness target.', {
      code: 'MIX_PEAK_EXCEEDED', exitCode: 2, details: { peak, before: analysis.mix, proposed: after, peakLimit },
    });
  }
  if (peakLimit) {
    const matched = new Set(segments.filter(row => !row.unchanged).map(row => row.id));
    changed += new Set(peakLimit.steps.flatMap(step => step.segments.map(row => row.id)).filter(id => !matched.has(id))).size;
  }

  return {
    target,
    peak,
    ...(match ? {} : { peakOnly: true }),
    ...(analysis ? { beforeMix: analysis.mix, afterMix: after, measurementScope: analysis.scope } : {}),
    ...(peakLimit ? { peakLimit } : {}),
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
