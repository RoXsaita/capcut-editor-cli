/**
 * `gate` — is this edit ready to post?
 *
 * `finish` is a scorecard; `gate` is the blocking version of it, with every threshold read
 * from the profile's `density` block. It measures the motion grammar, not a motion quota:
 * rhythm is contrast, so it checks for dead stretches AND for crowding, for a hook AND for
 * rest windows, for graphics that have a sound, and for graphics inside the platform UI.
 *
 * Levels: FAIL blocks (exit 1). WARN is reported and must be named in the hand-off. The gate
 * reads the draft only; it cannot see pixels or hear the mix, so its scope line says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { allSegments, contentEndUs, resolveMediaPath } from './core.mjs';
import { projectAlphaLeaks } from './alpha.mjs';
import { blurredBackgrounds, captionStyleDrift } from './house-rules.mjs';
import { coldOpen, cutPoints, pictureChanges, principalTrack } from './polish.mjs';
import { isCaptionTrack } from './captions.mjs';
import { firstPictureProof, finishScorecard } from './finish.mjs';
import { safeZoneViolations } from './mograph-geometry.mjs';
import { loadProfile } from './profile.mjs';

const S = us => (us || 0) / 1e6;
const r2 = n => Math.round(n * 100) / 100;
const GRAPHIC = /^(mograph:(?!sfx:)|sig:logo|sig:endcard|motion:)/;
const SFX_DESC = /^(polish:(sfx|callout|click|type)|sig:sfx|mograph:sfx:|callout|sfx)/;
const MOVE_PROPS = new Set(['KFTypeScaleX', 'KFTypePositionX', 'KFTypePositionY', 'KFTypeRotation']);

const startOf = s => S(s.target_timerange?.start);
const endOf = s => S((s.target_timerange?.start || 0) + (s.target_timerange?.duration || 0));
const speedOf = s => (s.target_timerange?.duration ? (s.source_timerange?.duration || s.target_timerange.duration) / s.target_timerange.duration : 1);

/** Graphic entrances: mograph clips, logo pops, endcard, native motion layers, text. One per start frame. */
export function graphicEvents(doc) {
  let principal = null;
  try { principal = principalTrack(doc); } catch { /* no principal */ }
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const out = [];
  const seen = new Set();
  for (const { track, trackIndex: index, segment } of allSegments(doc)) {
    const desc = segment.desc || '';
    if ((track.name || '').startsWith('captions:')) continue;   // word captions are subtitles, not graphic beats
    const isGraphic = GRAPHIC.test(desc) || (track.name || '').startsWith('motion:')
      || track.type === 'text' || (principal && index > principal.index && track.type === 'video'
        && !desc.startsWith('layout:') && !(track.name || '').startsWith('sig-') && !/^mograph-\d+$/.test(track.name || '')
        && !desc.startsWith('polish:') && !desc.startsWith('cursor'));
    if (!isGraphic) continue;
    const t = startOf(segment);
    const key = Math.round(t * 30);
    const mograph = videos.get(segment.material_id)?.capcutctl_mograph || null;
    const kind = desc.startsWith('mograph:') ? 'mograph' : desc.startsWith('sig:logo') ? 'logo'
      : desc.startsWith('sig:endcard') ? 'endcard' : track.type === 'text' ? 'text' : 'overlay';
    if (seen.has(`${kind}:${key}`)) continue;          // a glow underlay is the same entrance
    seen.add(`${kind}:${key}`);
    out.push({ t: r2(t), end: r2(endOf(segment)), kind, desc, template: mograph?.template || null,
      box: mograph?.box || null, importVerified: mograph ? mograph.importVerified !== false : true,
      ...(mograph?.scene ? { scene: true } : {}) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Camera ramps: every keyframe leg whose value changes, in timeline seconds. */
export function cameraMoves(doc) {
  const out = [];
  for (const { track, segment } of allSegments(doc)) {
    if (track.type !== 'video') continue;
    if (GRAPHIC.test(segment.desc || '')) continue;
    const t0 = startOf(segment), speed = speedOf(segment) || 1;
    // time_offset is SOURCE time (what CapCut writes and core's recut remaps), so a clip cut
    // from 187s holds keys near 187s, not near 0.
    const src0 = S(segment.source_timerange?.start || 0);
    const at = offset => r2(t0 + (S(offset) - src0) / speed);
    for (const block of segment.common_keyframes || []) {
      if (!MOVE_PROPS.has(block.property_type)) continue;
      const keys = [...(block.keyframe_list || [])].sort((a, b) => a.time_offset - b.time_offset);
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i];
        if (Math.abs((a.values?.[0] ?? 0) - (b.values?.[0] ?? 0)) < 1e-6) continue;
        out.push({ t: at(a.time_offset), end: at(b.time_offset), property: block.property_type });
      }
    }
  }
  // Scale + position of one move are one move.
  const merged = [];
  for (const m of out.sort((a, b) => a.t - b.t)) {
    const last = merged.at(-1);
    if (last && Math.abs(last.t - m.t) < 0.034 && Math.abs(last.end - m.end) < 0.034) continue;
    merged.push(m);
  }
  return merged;
}

export function sfxEvents(doc) {
  const out = [];
  for (const { track, segment } of allSegments(doc)) {
    if (track.type !== 'audio') continue;
    const desc = segment.desc || '';
    if (desc === 'finish:music' || track.name === 'finish-music') continue;
    if (!SFX_DESC.test(desc) && endOf(segment) - startOf(segment) > 3) continue;
    out.push({ t: r2(startOf(segment)), desc });
  }
  return out.sort((a, b) => a.t - b.t);
}

function transitionNames(doc) {
  const byId = new Map((doc.materials?.transitions || []).map(m => [m.id, m.name || m.effect_id || 'transition']));
  const names = [];
  for (const { segment } of allSegments(doc)) {
    for (const ref of segment.extra_material_refs || []) if (byId.has(ref)) names.push(byId.get(ref));
  }
  return names;
}

function maxGap(times, from, to) {
  const pts = [from, ...times.filter(t => t > from && t < to), to].sort((a, b) => a - b);
  let worst = { gap: 0, from, to: from };
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i] - pts[i - 1];
    if (gap > worst.gap) worst = { gap: r2(gap), from: r2(pts[i - 1]), to: r2(pts[i]) };
  }
  return worst;
}

/**
 * Captions that sit on the face. Captions are native text, so qa cannot draw them and only a
 * watch in CapCut shows them; this is the geometric version. Full face: the head fills about
 * 10–75% of the clip height, so a caption belongs in the bottom band (position ≤ ~22). Split
 * with the face below the seam: the caption rides the seam, never inside the face half.
 */
export function captionsOnFace(doc) {
  let principal = null;
  try { principal = principalTrack(doc); } catch { return []; }
  const faces = principal.track.segments || [];
  // Only a CLI-marked scene is known to cover the face; a transparent overlay (a slab) is not.
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const fullFrame = t => allSegments(doc).some(({ segment }) => videos.get(segment.material_id)?.capcutctl_mograph?.scene
    && startOf(segment) <= t && t < endOf(segment));
  const out = [];
  for (const { track, segment } of allSegments(doc)) {
    if (!(track.name || '').startsWith('captions:')) continue;
    const t = (startOf(segment) + endOf(segment)) / 2;
    const face = faces.find(f => startOf(f) <= t && t < endOf(f));
    if (!face || fullFrame(t)) continue;
    const ty = face.clip?.transform?.y ?? 0, sc = face.clip?.scale?.y ?? 1;
    const cy = 960 - (segment.clip?.transform?.y ?? 0) * 960;   // caption centre, px from the top
    let band;
    if (ty <= -0.2) band = [990, 1920];
    else if (ty >= 0.2) band = [0, 930];
    else { const top = 960 - ty * 960 - 960 * sc; band = [top + 0.10 * 1920 * sc, top + 0.75 * 1920 * sc]; }
    if (cy > band[0] && cy < band[1]) out.push({ t: r2(startOf(segment)), y: segment.clip?.transform?.y ?? 0, layout: ty <= -0.2 ? 'split' : ty >= 0.2 ? 'split-top' : 'full' });
  }
  return out;
}

/**
 * A shot that opens on one framing and snaps to another a few frames later: the first frames
 * show the wrong crop. A deliberate punch lands later in the shot; a snap inside the opening
 * 0.6s is a framing bug (a real edit, 2026-10-04: every terminal shot opened mis-cropped).
 */
export function openingSnaps(doc, { within = 0.6, snap = 0.15 } = {}) {
  const out = [];
  for (const { track, segment } of allSegments(doc)) {
    if (track.type !== 'video' || GRAPHIC.test(segment.desc || '')) continue;
    const t0 = startOf(segment), speed = speedOf(segment) || 1, src0 = S(segment.source_timerange?.start || 0);
    const at = offset => t0 + (S(offset) - src0) / speed;
    for (const block of segment.common_keyframes || []) {
      if (!MOVE_PROPS.has(block.property_type)) continue;
      const keys = [...(block.keyframe_list || [])].sort((a, b) => a.time_offset - b.time_offset);
      for (let i = 1; i < keys.length; i++) {
        const a = at(keys[i - 1].time_offset), b = at(keys[i].time_offset);
        if (Math.abs((keys[i - 1].values?.[0] ?? 0) - (keys[i].values?.[0] ?? 0)) < 1e-3) continue;
        if (a - t0 > 1e-3 && a - t0 < within && b - a < snap) { out.push({ t: r2(a), track: track.name || '' }); break; }
      }
    }
  }
  return [...new Map(out.map(o => [`${o.track}:${o.t}`, o])).values()].sort((x, y) => x.t - y.t);
}

/** Caption layers with words on them, whoever wrote them (captions:*, SRT, CapCut auto-captions). */
export function captionLayers(doc) {
  return (doc.tracks || []).filter(t => isCaptionTrack(doc, t) && (t.segments || []).length)
    .map(t => ({ name: t.name || '(unnamed)', words: t.segments.length,
      start: r2(Math.min(...t.segments.map(startOf))), end: r2(Math.max(...t.segments.map(endOf))) }));
}

// The house ender: a native sig:endcard, or a follow-ender clip. `render` is not an ender.
const ENDER = /end-?card|(^|[^a-z])ender([^a-z]|$)/i;

/** The follow ender / endcard that closes the video (it runs to the last frame), or null. */
export function endingCard(doc, end) {
  const media = new Map([...(doc.materials?.videos || []), ...(doc.materials?.texts || [])].map(m => [m.id, m]));
  for (const { track, segment } of allSegments(doc)) {
    const desc = segment.desc || '';
    if (/sfx/i.test(desc) || track.type === 'audio') continue;
    const file = path.basename(media.get(segment.material_id)?.path || '');
    if (!(ENDER.test(desc) || ENDER.test(track.name || '') || ENDER.test(file))) continue;
    const a = startOf(segment), b = endOf(segment);
    if (b >= end - 0.1 && a < end) return { t: r2(a), end: r2(b), desc: desc || track.name || file };
  }
  return null;
}

/** Longest stretch in [from, to) with no graphic on screen. */
function longestClear(graphics, from, to) {
  const spans = graphics.map(g => [Math.max(from, g.t), Math.min(to, g.end)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let cursor = from, best = 0;
  for (const [a, b] of spans) { best = Math.max(best, a - cursor); cursor = Math.max(cursor, b); }
  return r2(Math.max(best, to - cursor));
}

export function gateReport(doc, { projectDir = null, profile = loadProfile() } = {}) {
  const d = profile.density;
  const fps = profile.canvas.fps;
  const end = S(contentEndUs(doc, projectDir));
  const checks = [];
  const add = (id, level, ok, message, value = null, target = null) => checks.push({ id, level, ok, message, value, target });

  const graphics = graphicEvents(doc).filter(g => g.t < end);
  const moves = cameraMoves(doc).filter(m => m.t < end);
  const sfx = sfxEvents(doc);
  const cuts = cutPoints(doc, { projectDir, minGap: 0.05 }).map(c => c.t).filter(t => t < end);
  const changes = pictureChanges(doc, { projectDir }).map(c => c.t).filter(t => t < end);
  const visual = [...new Set([...cuts, ...changes, ...moves.map(m => m.t), ...graphics.map(g => g.t),
    ...graphics.map(g => g.end).filter(t => t < end)].map(r2))].sort((a, b) => a - b);

  // Hook and proof.
  const hook = visual.find(t => t <= d.hookEventBy + 1e-6);
  add('hook', 'FAIL', hook != null, hook != null
    ? `first visual event at ${hook}s` : `nothing moves in the first ${d.hookEventBy}s — open on a snap punch, a hook title or the proof`,
  hook ?? (visual[0] ?? null), d.hookEventBy);
  const proofMiss = coldOpen(doc, { seconds: d.proofBy, projectDir });
  add('proof', 'FAIL', !proofMiss, proofMiss ? `no proof on screen by ${d.proofBy}s (full-face open)` : `proof on screen by ${d.proofBy}s`);
  const first = firstPictureProof(doc);
  add('first-picture', 'FAIL', first.ok, first.ok ? 'first picture is proof' : 'first 5s are full-face with no screen');

  // Rhythm.
  const stat = maxGap(visual, 0, end);
  add('max-static', 'FAIL', stat.gap <= d.maxStatic, `longest stretch without a visual change: ${stat.gap}s (${stat.from}–${stat.to}s)`, stat.gap, d.maxStatic);
  const opening = maxGap(visual, 0, Math.min(end, d.openingSeconds));
  add('opening-density', 'WARN', opening.gap <= d.openingMaxGap, `opening ${d.openingSeconds}s: longest gap ${opening.gap}s (${opening.from}–${opening.to}s)`, opening.gap, d.openingMaxGap);
  const droughts = [];
  const gTimes = graphics.map(g => g.t);
  const gg = maxGap(gTimes, Math.min(end, d.openingSeconds), end);
  if (gg.gap > d.graphicEvery[1]) droughts.push(gg);
  add('graphic-cadence', 'WARN', !droughts.length, droughts.length
    ? `no graphic for ${gg.gap}s (${gg.from}–${gg.to}s); target one every ${d.graphicEvery[0]}–${d.graphicEvery[1]}s`
    : `graphics every ≤${d.graphicEvery[1]}s`, gg.gap, d.graphicEvery[1]);
  const noRest = [];
  for (let w = d.openingSeconds; w < end - 1; w += d.restPer) {
    const clear = longestClear(graphics, w, Math.min(end, w + d.restPer));
    if (clear < d.restWindowSeconds && Math.min(end, w + d.restPer) - w >= d.restWindowSeconds) noRest.push(`${r2(w)}–${r2(Math.min(end, w + d.restPer))}s`);
  }
  add('rest-windows', 'WARN', !noRest.length, noRest.length ? `no ${d.restWindowSeconds}s rest from overlays in ${noRest.join(', ')}` : 'rest windows present');

  // Crowding.
  const anim = [...graphics.map(g => ({ t: g.t, end: g.t + 0.35, what: g.template || g.kind })),
    ...moves.map(m => ({ t: m.t, end: Math.max(m.end, m.t + 0.1), what: 'camera' }))];
  let crowd = { n: 0, at: null };
  for (const a of anim) {
    const n = anim.filter(b => b.t < a.end && b.end > a.t).length;
    if (n > crowd.n) crowd = { n, at: a.t };
  }
  add('simultaneity', 'FAIL', crowd.n <= d.maxSimultaneous, `at most ${crowd.n} things animate at once${crowd.at != null ? ` (at ${r2(crowd.at)}s)` : ''}`, crowd.n, d.maxSimultaneous);
  const tooClose = [];
  for (let i = 1; i < graphics.length; i++) {
    if ((graphics[i].t - graphics[i - 1].t) * fps < d.entranceMinGapFrames) tooClose.push(`${graphics[i - 1].t}/${graphics[i].t}s`);
  }
  add('entrance-spacing', 'FAIL', !tooClose.length, tooClose.length ? `entrances within ${d.entranceMinGapFrames} frames: ${tooClose.join(', ')}` : 'entrances spaced');
  const repeats = [];
  const byTemplate = new Map();
  for (const g of graphics.filter(x => x.template)) {
    const last = byTemplate.get(g.template);
    if (last != null && g.t - last < d.templateRepeatGap) repeats.push(`${g.template} at ${last}s and ${g.t}s`);
    byTemplate.set(g.template, g.t);
  }
  add('template-repeat', 'FAIL', !repeats.length, repeats.length ? `same template within ${d.templateRepeatGap}s: ${repeats.join('; ')}` : 'no template repeats too soon');

  // Placement and pairing.
  // A scene is the whole frame by design; its readable text was proven clear of the UI when it
  // rendered (mograph scene-render refuses otherwise), and its sound is inside the clip.
  const unsafe = graphics.filter(g => g.box && !g.scene).map(g => ({ g, zones: safeZoneViolations(g.box, profile) })).filter(x => x.zones.length);
  add('safe-zones', 'FAIL', !unsafe.length, unsafe.length ? unsafe.map(x => `${x.g.template || x.g.kind} at ${x.g.t}s in ${x.zones.join('+')}`).join('; ') : 'graphics clear of platform UI');
  const win = profile.sound.graphicSfxWindowSeconds;
  const unpaired = graphics.filter(g => g.kind !== 'text' && !g.scene && !sfx.some(s => Math.abs(s.t - g.t) <= win + 0.15));
  add('graphic-sfx', 'FAIL', !unpaired.length, unpaired.length ? `graphics without a sound: ${unpaired.map(g => `${g.template || g.kind}@${g.t}s`).join(', ')}` : 'every graphic has a sound');
  const logos = graphics.filter(g => g.kind === 'logo').map(g => g.t);
  const chipClash = graphics.filter(g => g.template === 'brand-chip' && logos.some(t => Math.abs(t - g.t) <= d.brandChipLogoGap));
  const onFace = captionsOnFace(doc).filter(c => c.t < end);
  add('caption-face', 'FAIL', !onFace.length, onFace.length
    ? `${onFace.length} caption(s) on the face, first at ${onFace.slice(0, 4).map(c => `${c.t}s (${c.layout}, y=${c.y})`).join(', ')}: full face → position 20, split → the seam (50)`
    : 'captions clear of the face');
  const snaps = openingSnaps(doc).filter(x => x.t < end);
  add('opening-snap', 'FAIL', !snaps.length, snaps.length
    ? `shot re-frames with a snap just after it opens at ${snaps.map(x => `${x.t}s`).join(', ')}: start the shot on its final framing`
    : 'shots open on their final framing');
  const blurred = blurredBackgrounds(doc).filter(b => b.t < end);
  add('clear-background', 'FAIL', !blurred.length, blurred.length
    ? `${blurred.length} blurred background(s) at ${blurred.slice(0, 4).map(b => `${b.t}s (${b.kind})`).join(', ')}: never a blurred background — capcutctl layout background --project NAME swaps in the clear room plate${blurred.some(b => b.kind === 'canvas') ? '; set Background to None in CapCut for canvas blurs' : ''}`
    : 'no blurred backgrounds');
  const drift = captionStyleDrift(doc);
  add('caption-style', 'FAIL', !drift.off.length, drift.off.length
    ? `${drift.off.length} caption word(s) not in the house caption style, first ${drift.off.slice(0, 4).map(w => `"${w.text}"@${w.t}s`).join(', ')}: every word takes ${drift.house} — capcutctl captions --restyle --project NAME`
    : 'one caption style');
  const fin = profile.final || {};
  if (fin.captionsRequired !== false) {
    const layers = captionLayers(doc);
    add('captions', 'FAIL', layers.length === 1, layers.length === 1
      ? `one caption layer (${layers[0].words} words)`
      : layers.length ? `${layers.length} caption layers (${layers.map(l => l.name).join(', ')}): double captions — keep one`
        : 'no captions: capcutctl captions --project NAME');
  }
  const ender = endingCard(doc, end);
  add('ending', 'FAIL', Boolean(ender), ender ? `ends on the follow ender (${ender.desc} at ${ender.t}s)`
    : 'no follow ender / endcard on the last frame: edit.json endcard, or the follow-ender clip');
  if (fin.lengthWarnAbove) {
    add('length', 'WARN', end <= fin.lengthWarnAbove, `${r2(end)}s (45–60s ideal, 75s fine, warn above ${fin.lengthWarnAbove}s)`, r2(end), fin.lengthWarnAbove);
  }
  add('chip-and-logo', 'FAIL', !chipClash.length, chipClash.length ? `brand-chip and logo pop on one mention at ${chipClash.map(g => g.t).join(', ')}s` : 'no doubled brand mentions');

  // Seams.
  const score = finishScorecard(doc, { projectDir });
  add('same-screen-transitions', 'FAIL', !score.sameScreenTransitions.length, score.sameScreenTransitions.length
    ? `transitions on unchanged pictures at ${score.sameScreenTransitions.join(', ')}s` : 'transitions only on picture changes');
  const names = transitionNames(doc);
  const counts = names.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = top ? top[1] / names.length : 0;
  add('seam-variety', 'FAIL', names.length < 4 || share <= profile.seams.maxShare,
    top ? `${top[0]} is ${Math.round(share * 100)}% of ${names.length} transitions` : 'no transitions', r2(share), profile.seams.maxShare);

  // Alpha overlays must be premultiplied: CapCut adds a straight file's hidden colour to the frame.
  if (projectDir) {
    let leaks = null;
    try { leaks = projectAlphaLeaks(doc, projectDir, { resolve: resolveMediaPath }); } catch { leaks = null; }
    if (leaks) add('alpha-premultiplied', 'FAIL', !leaks.length, leaks.length
      ? `${leaks.length} overlay(s) carry straight alpha CapCut paints as a haze: ${leaks.map(l => path.basename(l.file)).join(', ')} — capcutctl alpha --project NAME`
      : 'alpha overlays premultiplied');
  }

  // Things the gate cannot see.
  const unverified = graphics.filter(g => g.kind === 'mograph' && !g.importVerified);
  add('mograph-import', 'WARN', !unverified.length, unverified.length
    ? `${unverified.length} rendered graphic(s) not yet import-verified on this CapCut build (docs/mograph.md)` : 'rendered graphics verified or absent');
  const unseen = graphics.filter(g => g.kind === 'text' || g.kind === 'endcard' || g.desc.startsWith('motion:')).length;
  add('unseen-layers', 'WARN', unseen === 0, unseen ? `unseen: ${unseen} native text/compound layer(s) — qa cannot render them; check in CapCut` : 'qa can render every graphic');
  add('b-roll-volume', 'WARN', !score.brollHot.length, score.brollHot.length ? `B-roll at full volume at ${score.brollHot.map(b => `${b.at}s`).join(', ')}` : 'B-roll audio is under the voice');
  add('music', 'WARN', score.music.present, score.music.present ? 'music bed present' : 'no music bed');
  if (score.crispness?.warnings?.length) add('crispness', 'WARN', false, `upscaled past ${score.crispness.warnAbove}×: ${score.crispness.warnings.map(w => `${w.at}s`).join(', ')}`);
  if (score.brollLint?.findings?.length) add('b-roll-lint', 'WARN', false, `${score.brollLint.findings.length} B-roll seam finding(s): run finish for details`);

  const failed = checks.filter(c => !c.ok && c.level === 'FAIL');
  const warned = checks.filter(c => !c.ok && c.level === 'WARN');
  return {
    verdict: failed.length ? 'FAIL' : warned.length ? 'WARN' : 'PASS',
    profile: profile.name,
    duration: r2(end),
    failed: failed.map(c => c.id),
    warned: warned.map(c => c.id),
    checks,
    metrics: { cuts: cuts.length, pictureChanges: changes.length, cameraMoves: moves.length, graphics: graphics.length,
      sfx: sfx.length, transitions: names.length, visualEvents: visual.length,
      eventsPer10s: end ? r2(visual.length / end * 10) : 0 },
    scope: 'Draft structure only. The gate cannot see pixels or hear the mix: check qa frames and a normal-speed watch with sound.',
  };
}

/**
 * Fold an export X-ray (capcutctl xray scan --project) into a gate report. The draft says what
 * was configured; the X-ray says what the export shows. Its FAIL verdicts block, its UNKNOWNs
 * warn (they must be named in the hand-off), and what it could not check is listed, never passed.
 */
// X-ray verdicts that only warn in a scan but block a final export.
const PROMOTE = new Set(['video.opens_black', 'video.stutter', 'audio.loudness']);

const finalCheck = (id, ok, message) => ({ id, level: 'FAIL', ok, message, value: null, target: null });

/**
 * Voice-band loudness of a video, 10 ms steps, in dB: the clock for speech timing. Whisper says
 * WHICH words were said but stretches each word over the silence around it (a 0.8s late start
 * reads as a first word at 0.00s), so onsets, gaps and the cut are timed from energy.
 */
export function voiceEnvelope(video) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', video, '-map', '0:a:0', '-af', 'highpass=f=300,lowpass=f=3400',
    '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 30, timeout: 120000 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2));
  const db = [];
  for (let i = 0; i + 160 <= pcm.length; i += 160) {
    let sum = 0;
    for (let k = i; k < i + 160; k++) sum += (pcm[k] / 32768) ** 2;
    db.push(Math.round(10 * Math.log10(sum / 160 + 1e-12) * 10) / 10);
  }
  return { step: 0.01, db };
}

/**
 * Speech timing on the export: the first word by firstWordBy, no stretch of silence over
 * maxSpeechGap inside the speech, and no word still sounding at the cut into the ender. The
 * transcript must have words (proof there is speech); the envelope times them. Silence is
 * 20 dB under the speech level, so a music bed within 20 dB of the voice hides a pause.
 */
export function speechGates(speech, { fin = {}, stop, enderAt = null, pauses = [], envelope = null } = {}) {
  if (!speech) return [finalCheck('speech', false, 'no transcript of the export: re-run the X-ray with --speech')];
  const words = (speech.words || []).filter(w => Number.isFinite(w.start) && w.start < stop);
  if (!words.length) return [finalCheck('speech', false, 'the export transcript has no words')];
  if (!envelope?.db?.length) return [finalCheck('speech', false, 'cannot read the export audio to time the speech')];
  const firstBy = fin.firstWordBy ?? 0.5, maxGap = fin.maxSpeechGap ?? 0.7;
  const { step, db } = envelope;
  const at = t => Math.max(0, Math.min(db.length - 1, Math.round(t / step)));
  const inWords = words.flatMap(w => db.slice(at(w.start), at(w.end))).filter(v => v > -70).sort((x, y) => x - y);
  const level = inWords.length ? inWords[Math.floor(inWords.length * 0.75)] : -30;
  const voiced = db.map(v => v >= level - 20);
  const last = words.at(-1);
  const end = at(stop);
  // Onset: the first 80 ms of continuous voice.
  let onset = null;
  for (let i = 0, run = 0; i < end; i++) { run = voiced[i] ? run + 1 : 0; if (run >= 8) { onset = (i - 7) * step; break; } }
  let lastVoiced = null;
  for (let i = end - 1; i >= 0; i--) if (voiced[i]) { lastVoiced = i; break; }
  const gaps = [];
  if (onset != null && lastVoiced != null) {
    for (let i = at(onset), from = null; i <= lastVoiced; i++) {
      if (!voiced[i]) { from ??= i; continue; }
      if (from != null) {
        const a = from * step, b = i * step;
        if (b - a > maxGap && !pauses.some(p => p >= a - 0.1 && p <= b + 0.1)) gaps.push({ t: r2(a), gap: r2(b - a) });
        from = null;
      }
    }
  }
  // Clipped: the voice is still sounding in the last 60 ms before the cut. A finished word has
  // decayed to room tone by then (about 40 dB under the speech level on the 2026-10-11 finals);
  // a word cut mid-syllable is still within ~16 dB of it.
  const tail = db.slice(Math.max(0, end - 6), end);
  const atCut = tail.length ? tail.reduce((x, y) => x + y, 0) / tail.length : -120;
  const clipped = atCut >= level - 22 && last.end >= stop - 0.3;
  return [
    finalCheck('first-word', onset != null && onset <= firstBy + 1e-6, onset == null ? 'no voice found before the ender'
      : `speech starts at ${r2(onset)}s (by ${firstBy}s; first word "${words[0].word}")`),
    finalCheck('speech-gaps', !gaps.length, gaps.length
      ? `${gaps.length} silence(s) over ${maxGap}s inside the speech at ${gaps.slice(0, 5).map(g => `${g.t}s (${g.gap}s)`).join(', ')}: tighten, or declare a deliberate pause with --pause SECONDS`
      : `no silence over ${maxGap}s inside the speech`),
    finalCheck('last-word', !clipped, clipped
      ? `the voice is still sounding at the cut into ${enderAt != null ? 'the ender' : 'the end'} (${r2(stop)}s, "${last.word}"): clipped — extend the clip`
      : `last word "${last.word}" finishes before ${enderAt != null ? 'the ender' : 'the end'}`),
  ];
}

const ratio = text => { const [a, b] = String(text || '').split('/').map(Number); return b ? a / b : a; };

/** The delivery file: canvas size and frame rate, an audio stream, and no silence before the ender. */
export function deliveryGates(xray, { profile, fin = {}, stop }) {
  const v = xray.info?.video || {};
  const want = profile.canvas;
  const fps = ratio(v.avg_frame_rate || v.r_frame_rate);
  const out = [finalCheck('export-format', Number(v.width) === want.width && Number(v.height) === want.height && Math.abs(fps - want.fps) < 0.02,
    `${v.width}x${v.height} at ${r2(fps)} fps (want ${want.width}x${want.height} at ${want.fps})`)];
  const audio = xray.audio || {};
  if (!audio.present) return [...out, finalCheck('export-audio', false, 'the export has no audio stream')];
  // A dropout is silence with sound after it; silence that runs into the (silent) ender is the ending.
  const drops = (audio.findings || []).filter(f => f.kind === 'silence' && f.where !== 'end' && f.t + f.dur_s < stop - 0.05)
    .filter(f => f.where === 'inside' || f.dur_s > (fin.firstWordBy ?? 0.5));
  return [...out, finalCheck('export-audio', !drops.length, drops.length
    ? `audio drops to silence before the ender at ${drops.slice(0, 4).map(f => `${f.t}s (${f.dur_s}s)`).join(', ')}`
    : 'sound all the way to the ender')];
}

/** Sudden level steps: short-term loudness (3s window) moving more than maxLoudnessJump LU in 1s. */
export function loudnessJumps(xray, { fin = {}, stop }) {
  const limit = fin.maxLoudnessJump ?? 6;
  const series = (xray.audio?.loudness?.momentary || []).filter(([t, , st]) => t < stop && st != null && st > -40);
  const at = new Map(series.map(([t, , st]) => [Math.round(t * 10), st]));
  const jumps = [];
  for (const [t, , st] of series) {
    const before = at.get(Math.round(t * 10) - 10);
    if (before != null && Math.abs(st - before) > limit && !(jumps.length && t - jumps.at(-1).t <= 1)) jumps.push({ t: r2(t), lu: r2(st - before) });
  }
  return [finalCheck('loudness-jumps', !jumps.length, jumps.length
    ? `short-term loudness steps over ${limit} LU in 1s at ${jumps.slice(0, 4).map(j => `${j.t}s (${j.lu > 0 ? '+' : ''}${j.lu} LU)`).join(', ')}`
    : 'no sudden loudness steps')];
}

/**
 * The final-export checks the X-ray measures but does not judge. Pure, so tests feed it numbers.
 * `enderAt` is where the follow ender starts (speech and sound rules stop there); `pauses` are
 * timeline seconds of deliberate pauses the editor declared.
 */
export function exportGates(xray, speech, { profile = loadProfile(), enderAt = null, pauses = [], envelope = null } = {}) {
  const fin = profile.final || {};
  const stop = enderAt ?? (Number(xray.info?.format?.duration) || 0);
  return [
    ...deliveryGates(xray, { profile, fin, stop }),
    ...(xray.audio?.present ? loudnessJumps(xray, { fin, stop }) : []),
    ...speechGates(speech, { fin, stop, enderAt, pauses, envelope }),
  ];
}

export function foldXray(report, xrayDir, projectDir, { profile = null, draft = null, pauses = [] } = {}) {
  const file = path.join(path.resolve(xrayDir), 'xray.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    report.checks.push({ id: 'xray', level: 'FAIL', ok: false, message: `cannot read ${file}: ${error.message}`, value: null, target: null });
    return finaliseReport(report);
  }
  const add = (id, level, ok, message) => report.checks.push({ id, level, ok, message, value: null, target: null });
  const draftPath = doc.draft?.draft_path;
  if (!doc.draft) add('xray-draft', 'WARN', false, 'the X-ray was scanned without --project; it cannot be tied to this draft');
  else if (projectDir && path.resolve(doc.draft.project) !== path.resolve(projectDir)) {
    add('xray-draft', 'FAIL', false, `the X-ray is of another project (${path.basename(doc.draft.project)})`);
  } else if (draftPath && fs.existsSync(draftPath) && fs.statSync(draftPath).mtimeMs * 1e6 > (doc.export?.mtime_ns || 0)) {
    add('xray-draft', 'WARN', false, 'the draft was saved after the exported video; re-export if anything changed');
  } else add('xray-draft', 'WARN', true, 'X-ray is of this draft\'s export');
  const notChecked = [];
  for (const v of doc.verdicts || []) {
    if (v.verdict === 'NOT CHECKED') { notChecked.push(v.property); continue; }
    add(`xray:${v.property}`, v.verdict === 'FAIL' || (profile && PROMOTE.has(v.property)) ? 'FAIL' : 'WARN', v.verdict === 'PASS', v.detail);
  }
  // Final-export gates: only when the caller holds the profile (gate --xray, export).
  if (profile) {
    let speech = null;
    try { speech = JSON.parse(fs.readFileSync(path.join(path.resolve(xrayDir), 'speech.json'), 'utf8')); } catch { /* checked below */ }
    const end = draft ? S(contentEndUs(draft, projectDir)) : null;
    const ender = draft && end ? endingCard(draft, end) : null;
    const video = doc.export?.path;
    const envelope = video && fs.existsSync(video) ? voiceEnvelope(video) : null;
    report.checks.push(...exportGates(doc, speech, { profile, enderAt: ender?.t ?? null, pauses, envelope }));
  }
  report.xray = { dir: path.resolve(xrayDir), export: doc.export?.path, sha256: doc.export?.sha256, notChecked };
  report.scope = `Draft structure plus the export X-ray (every frame and sample measured). Not checked: ${notChecked.join(', ') || 'nothing'}.`;
  return finaliseReport(report);
}

export function finaliseReport(report) {
  const failed = report.checks.filter(c => !c.ok && c.level === 'FAIL');
  const warned = report.checks.filter(c => !c.ok && c.level === 'WARN');
  report.failed = failed.map(c => c.id);
  report.warned = warned.map(c => c.id);
  report.verdict = failed.length ? 'FAIL' : warned.length ? 'WARN' : 'PASS';
  return report;
}

export function gateText(report) {
  const mark = c => (c.ok ? 'ok  ' : c.level === 'FAIL' ? 'FAIL' : 'warn');
  const lines = [`gate: ${report.verdict}  (profile ${report.profile}, ${report.duration}s)`];
  for (const c of report.checks) lines.push(`  ${mark(c)} ${c.id.padEnd(24)} ${c.message}`);
  const m = report.metrics;
  lines.push(`  events ${m.visualEvents} (${m.eventsPer10s}/10s) · cuts ${m.cuts} · moves ${m.cameraMoves} · graphics ${m.graphics} · sfx ${m.sfx} · transitions ${m.transitions}`);
  lines.push(`  ${report.scope}`);
  return lines.join('\n');
}

/** Persist the last verdict beside the draft, so the hand-off can quote it. */
export function writeGateRecord(projectDir, report) {
  if (!projectDir) return null;
  const dir = path.join(projectDir, '.capcutctl');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gate.json');
  fs.writeFileSync(file, `${JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2)}\n`);
  return file;
}
