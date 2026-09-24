/**
 * Read finished video files: a reference reel to learn its pacing from, and our own render
 * to check before it is posted.
 *
 * Both start from tools/media_scan.py, one decode that measures hard cuts, in-shot builds,
 * black, freezes, 1-2 frame flashes, silences and loudness. This module decides what those
 * numbers mean against the style profile.
 *
 * `reference` exists because "edit it like this reel" was answered by eye. A style is a
 * countable system (cuts per second, how fast the first thing moves, the longest a picture
 * holds, how often something pops inside a shot), and the gate already enforces exactly
 * those numbers from the profile. Measuring the reference in the gate's own terms turns
 * "like this" into a profile override the gate can hold the edit to.
 *
 * `check-export` exists because every other check reads the draft. The file that gets posted
 * can still open on black, carry a stray frame from a clip that ended one frame early, sit
 * silent for a second at a seam, or come out 6 LU quiet. Those are properties of the render,
 * so they are measured on the render.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CapcutError, loadProject } from './core.mjs';
import { loadProfile } from './profile.mjs';
import { pythonForTool, PACKAGE_ROOT } from './python.mjs';

const r2 = n => Math.round(n * 100) / 100;
const up1 = n => Math.ceil(n * 10 - 1e-9) / 10;

/** Run the scanner. `sheet` writes a contact sheet of the first frame of every shot. */
export function scanMedia(media, { sheet = null, cutThreshold = null, buildThreshold = null } = {}) {
  const args = [path.join(PACKAGE_ROOT, 'tools', 'media_scan.py'), '--media', path.resolve(media)];
  if (sheet) args.push('--sheet', path.resolve(sheet));
  if (cutThreshold != null) args.push('--cut-threshold', String(cutThreshold));
  if (buildThreshold != null) args.push('--build-threshold', String(buildThreshold));
  const python = pythonForTool('media_scan.py', { argv: args.slice(1) });
  const run = spawnSync(python.executable, args, { encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new CapcutError(`could not run media_scan.py: ${run.error.message}`, { code: 'MEDIA_SCAN', exitCode: 2 });
  if (run.status !== 0) {
    throw new CapcutError((run.stderr || '').trim() || `media_scan.py exited ${run.status}`, { code: 'MEDIA_SCAN', exitCode: 2 });
  }
  return JSON.parse(run.stdout);
}

/** Longest stretch between consecutive times inside [from, to], counting both ends. */
export function maxGap(times, from, to) {
  const points = [from, ...times.filter(t => t > from && t < to), to].sort((a, b) => a - b);
  let best = { gap: 0, from, to: from };
  for (let i = 1; i < points.length; i++) {
    const gap = points[i] - points[i - 1];
    if (gap > best.gap) best = { gap, from: points[i - 1], to: points[i] };
  }
  return { gap: r2(best.gap), from: r2(best.from), to: r2(best.to) };
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Seconds of [from, to] covered by the given spans. */
function covered(spans, from, to) {
  return spans.reduce((sum, s) => sum + Math.max(0, Math.min(to, s.end) - Math.max(from, s.start)), 0);
}

function rate(times, from, to) {
  const span = to - from;
  if (span <= 0) return null;
  return r2(times.filter(t => t >= from && t < to).length / span);
}

/**
 * The reference reel in the gate's own terms.
 *
 * A "visual event" is a hard cut or an in-shot build (a pop, a push, text landing); the
 * gate counts cuts, picture changes, camera moves and graphic entrances the same way, so
 * the two numbers are comparable. Perceived pace tracks events, not cuts: a reel with few
 * cuts and a pop every second reads fast, and cloning its cut rate alone reads slow.
 */
export function referenceReport(scan, { profile = loadProfile(), project = null } = {}) {
  const d = profile.density;
  const duration = scan.duration;
  const cuts = scan.cuts.map(c => c.t);
  const builds = scan.builds.map(b => b.t);
  const events = [...new Set([...cuts, ...builds].map(r2))].sort((a, b) => a - b);
  const bounds = [0, ...cuts, duration];
  const shots = bounds.slice(1).map((t, i) => r2(t - bounds[i])).filter(s => s > 0);
  const openingEnd = Math.min(duration, d.openingSeconds);
  const closingStart = Math.max(openingEnd, duration - 3);
  const longest = maxGap(events, 0, duration);
  const opening = maxGap(events, 0, openingEnd);
  const speech = scan.hasAudio ? r2(1 - covered(scan.silences, 0, duration) / duration) : null;
  const leading = scan.silences.find(s => s.start <= 0.05);

  const measured = {
    duration,
    canvas: `${scan.width}x${scan.height}`,
    fps: scan.fps,
    shots: shots.length,
    cuts: cuts.length,
    builds: builds.length,
    cutsPerSecond: r2(cuts.length / duration),
    eventsPerSecond: r2(events.length / duration),
    sections: {
      opening: { from: 0, to: r2(openingEnd), cutsPerSecond: rate(cuts, 0, openingEnd), eventsPerSecond: rate(events, 0, openingEnd) },
      body: { from: r2(openingEnd), to: r2(closingStart), cutsPerSecond: rate(cuts, openingEnd, closingStart), eventsPerSecond: rate(events, openingEnd, closingStart) },
      closing: { from: r2(closingStart), to: duration, cutsPerSecond: rate(cuts, closingStart, duration), eventsPerSecond: rate(events, closingStart, duration) },
    },
    firstEvent: events[0] ?? null,
    medianShot: shots.length ? r2(median(shots)) : null,
    longestShot: shots.length ? Math.max(...shots) : null,
    longestStatic: longest,
    openingLongestStatic: opening,
    speechRatio: speech,
    firstSoundAt: scan.hasAudio ? r2(leading ? leading.end : 0) : null,
    loudness: scan.loudness,
  };

  // Only the density numbers a reel can actually show. graphicEvery needs to know which
  // events are graphics, which a decode cannot tell; the gate keeps the profile's value.
  const density = {};
  if (measured.firstEvent != null) density.hookEventBy = Math.min(3, Math.max(0.3, up1(measured.firstEvent)));
  if (events.length) {
    density.openingMaxGap = Math.max(0.3, up1(opening.gap));
    density.maxStatic = Math.max(0.5, up1(longest.gap));
  }
  const override = Object.keys(density).length ? {
    _about: `Measured from ${path.basename(scan.media)} by capcutctl reference. Density only; review before using.`,
    density,
  } : null;

  const rows = [
    ['first visual event (s)', 'hookEventBy', measured.firstEvent, d.hookEventBy, 'hook'],
    ['longest static stretch (s)', 'maxStatic', longest.gap, d.maxStatic, 'max-static'],
    [`opening ${d.openingSeconds}s longest gap (s)`, 'openingMaxGap', opening.gap, d.openingMaxGap, 'opening-density'],
    ['median shot (s)', null, measured.medianShot, profile.provenance?.cutRhythmMedianSeconds ?? null, null],
  ];
  const projectValues = project ? Object.fromEntries(project.checks.map(c => [c.id, c.value])) : null;
  const compare = rows.map(([metric, key, reference, profileValue, check]) => ({
    metric,
    ...(key ? { profileKey: `density.${key}` } : {}),
    reference,
    profile: profileValue,
    ...(projectValues ? { project: check ? (projectValues[check] ?? null) : null } : {}),
  }));

  const notes = [];
  if (!cuts.length) notes.push('no hard cuts detected — a one-take reel, or --cut-threshold is too high for this footage');
  if (builds.length > cuts.length * 2 && cuts.length) notes.push('most of the pace comes from in-shot builds, not cuts: match events per second, not cuts per second');
  if (measured.sections.opening.eventsPerSecond != null && measured.sections.body.eventsPerSecond != null
      && measured.sections.opening.eventsPerSecond >= 1.5 * measured.sections.body.eventsPerSecond && measured.sections.body.eventsPerSecond > 0) {
    notes.push('the opening runs markedly denser than the body — front-load the hook');
  }
  return { media: scan.media, measured, compare, override, notes, sheet: scan.sheet ?? null };
}

/** The gate's view of a project, for the side-by-side column. */
export async function projectPacing(projectDir, profile) {
  const { gateReport } = await import('./gate.mjs');
  const state = loadProject(projectDir);
  const doc = state.groups.find(g => g.name.startsWith('timeline:'))?.doc || state.groups[0].doc;
  return gateReport(doc, { projectDir, profile });
}

/** What the render should be, from the project when there is one, else from the profile. */
export async function expectedDelivery(projectDir, profile) {
  if (!projectDir) return { source: 'profile', width: profile.canvas.width, height: profile.canvas.height, fps: profile.canvas.fps, duration: null };
  const { reviewContentRange } = await import('./review.mjs');
  const state = loadProject(projectDir);
  const doc = state.groups.find(g => g.name.startsWith('timeline:'))?.doc || state.groups[0].doc;
  return {
    source: 'project',
    width: doc.canvas_config?.width ?? profile.canvas.width,
    height: doc.canvas_config?.height ?? profile.canvas.height,
    fps: doc.fps ?? profile.canvas.fps,
    duration: reviewContentRange(doc, projectDir).end,
  };
}

const EDGE = 0.05;

/**
 * Is this file fit to post. FAIL is a defect in the file (black inside the edit, a clipped
 * true peak, no audio, the wrong canvas or length); WARN is something a person should look
 * at before posting (a 1-2 frame flash may be a deliberate flash transition; a held frame
 * may be a deliberate hold). Every flagged moment lands in `inspect`, ready for export-grid.
 */
export function checkExportReport(scan, { profile = loadProfile(), expected = null, target = null, peak = null } = {}) {
  const checks = [];
  const inspect = new Set();
  const add = (id, level, ok, message, value = null, want = null) => checks.push({ id, level, ok, message, value, target: want });
  const duration = scan.duration;
  const lufsTarget = target ?? profile.sound?.loudnessTarget ?? -14;
  const peakLimit = peak ?? profile.sound?.peak ?? -1;

  add('audio-stream', 'FAIL', scan.hasAudio, scan.hasAudio ? `audio: ${scan.audioCodec} ${scan.sampleRate} Hz` : 'no audio stream');
  if (expected) {
    const geometry = scan.width === expected.width && scan.height === expected.height;
    add('canvas', expected.source === 'project' ? 'FAIL' : 'WARN', geometry,
      `${scan.width}x${scan.height}${geometry ? '' : ` (${expected.source} is ${expected.width}x${expected.height})`}`,
      `${scan.width}x${scan.height}`, `${expected.width}x${expected.height}`);
    if (expected.fps && scan.fps) {
      const same = Math.abs(scan.fps - expected.fps) < 0.02;
      add('fps', 'WARN', same, `${scan.fps} fps${same ? '' : ` (${expected.source} is ${expected.fps})`}`, scan.fps, expected.fps);
    }
    if (expected.duration != null) {
      const tolerance = Math.max(0.15, scan.fps ? 1 / scan.fps : 0);
      const ok = Math.abs(duration - expected.duration) <= tolerance;
      add('duration', 'FAIL', ok, `${duration}s${ok ? '' : ` (the edit is ${expected.duration}s)`}`, duration, expected.duration);
    }
  }

  const opensBlack = scan.black.filter(b => b.start <= EDGE);
  const endsBlack = scan.black.filter(b => b.start > EDGE && b.end >= duration - EDGE);
  const inside = scan.black.filter(b => b.start > EDGE && b.end < duration - EDGE);
  inside.forEach(b => inspect.add(b.start));
  add('black-inside', 'FAIL', !inside.length, inside.length
    ? `black frames inside the edit: ${inside.map(b => `${b.start}s (${b.duration}s)`).join(', ')} — a gap between clips`
    : 'no black inside the edit');
  add('black-open', 'WARN', !opensBlack.length, opensBlack.length
    ? `opens on ${opensBlack[0].duration}s of black — the first frame is the thumbnail and the scroll-stopper`
    : 'first frame has picture');
  endsBlack.forEach(b => inspect.add(b.start));
  add('black-tail', 'WARN', !endsBlack.length, endsBlack.length
    ? `ends on ${endsBlack[0].duration}s of black from ${endsBlack[0].start}s — cut it unless it is a deliberate fade`
    : 'no black tail');

  scan.flashes.forEach(f => inspect.add(f.t));
  add('flash-frames', 'WARN', !scan.flashes.length, scan.flashes.length
    ? `${scan.flashes.length} flash frame(s): ${scan.flashes.map(f => `${f.t}s (${f.frames}f, luma ${f.luma} vs ${f.neighbours})`).join(', ')} — a stray frame unless it is a flash transition`
    : 'no stray 1-2 frame flashes');

  const micro = scan.microShots || [];
  micro.forEach(m => inspect.add(m.t));
  add('micro-shots', 'WARN', !micro.length, micro.length
    ? `shot(s) only 1-2 frames long: ${micro.map(m => `${m.t}s (${m.frames}f)`).join(', ')} — a stray frame between clips`
    : 'no 1-2 frame shots');

  const holds = scan.freezes.filter(f => f.duration > profile.density.maxStatic);
  holds.forEach(f => inspect.add(f.start));
  add('frozen-picture', 'WARN', !holds.length, holds.length
    ? `picture frozen past ${profile.density.maxStatic}s: ${holds.map(f => `${f.start}–${f.end}s`).join(', ')}`
    : `no frozen stretch past ${profile.density.maxStatic}s`, holds.length ? Math.max(...holds.map(f => f.duration)) : 0, profile.density.maxStatic);

  if (scan.hasAudio) {
    const lead = scan.silences.find(s => s.start <= EDGE);
    const firstSound = lead ? lead.end : 0;
    add('first-sound', 'WARN', firstSound <= 0.5, firstSound <= 0.5 ? `sound from ${r2(firstSound)}s` : `silent until ${r2(firstSound)}s — the hook starts late`, r2(firstSound), 0.5);
    const dead = scan.silences.filter(s => s.start > EDGE && s.end < duration - EDGE && s.duration >= 1.0);
    dead.forEach(s => inspect.add(s.start));
    add('dead-air', 'WARN', !dead.length, dead.length
      ? `silence ≥1s inside the edit: ${dead.map(s => `${s.start}–${s.end}s`).join(', ')}`
      : 'no dead air ≥1s', dead.length ? Math.max(...dead.map(s => s.duration)) : 0, 1.0);
    const { lufs, truePeak } = scan.loudness || {};
    if (lufs == null) add('loudness', 'WARN', false, 'loudness could not be measured');
    else {
      const off = r2(lufs - lufsTarget);
      add('loudness', 'WARN', Math.abs(off) <= 1, `integrated ${lufs} LUFS (${off >= 0 ? '+' : ''}${off} LU from ${lufsTarget})`, lufs, lufsTarget);
    }
    if (truePeak != null) {
      add('true-peak', 'FAIL', truePeak <= peakLimit + 0.05, `true peak ${truePeak} dBTP (limit ${peakLimit})`, truePeak, peakLimit);
    }
  }

  const fails = checks.filter(c => !c.ok && c.level === 'FAIL');
  const warns = checks.filter(c => !c.ok && c.level === 'WARN');
  const times = [...inspect].map(t => r2(Math.min(Math.max(0, t + 0.02), Math.max(0, duration - 0.05)))).sort((a, b) => a - b).slice(0, 32);
  return {
    media: scan.media,
    verdict: fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS',
    ok: !fails.length,
    file: { duration, canvas: `${scan.width}x${scan.height}`, fps: scan.fps, video: scan.videoCodec, pixFmt: scan.pixFmt,
      audio: scan.audioCodec, cuts: scan.cuts.length },
    expected,
    checks,
    inspect: times,
    next: times.length ? `capcutctl export-grid --media ${JSON.stringify(scan.media)} --out check-grid.png --times ${times.join(',')}` : null,
    sheet: scan.sheet ?? null,
  };
}

export function checkExportText(report) {
  const lines = [`check-export: ${report.verdict}  (${report.file.canvas} ${report.file.fps}fps ${report.file.duration}s)`];
  for (const c of report.checks) lines.push(`${c.ok ? 'ok  ' : c.level === 'FAIL' ? 'FAIL' : 'WARN'} ${c.id}: ${c.message}`);
  if (report.next) lines.push('', `look: ${report.next}`);
  return lines.join('\n');
}
