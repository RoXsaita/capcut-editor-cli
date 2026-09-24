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
import { contentEndUs } from './core.mjs';
import { coldOpen, cutPoints, pictureChanges, principalTrack } from './polish.mjs';
import { firstPictureProof, finishScorecard } from './finish.mjs';
import { safeZoneViolations } from './mograph-geometry.mjs';
import { loadProfile } from './profile.mjs';

const S = us => (us || 0) / 1e6;
const r2 = n => Math.round(n * 100) / 100;
const GRAPHIC = /^(mograph:(?!sfx:)|sig:logo|sig:endcard|motion:)/;
const SFX_DESC = /^(polish:(sfx|callout|click|type)|sig:sfx|mograph:sfx:|callout|sfx)/;
const MOVE_PROPS = new Set(['KFTypeScaleX', 'KFTypePositionX', 'KFTypePositionY', 'KFTypeRotation']);

function segmentsOf(doc) {
  const out = [];
  (doc.tracks || []).forEach((track, index) => {
    for (const segment of track.segments || []) out.push({ track, index, segment });
  });
  return out;
}

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
  for (const { track, index, segment } of segmentsOf(doc)) {
    const desc = segment.desc || '';
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
      box: mograph?.box || null, importVerified: mograph ? mograph.importVerified !== false : true });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Camera ramps: every keyframe leg whose value changes, in timeline seconds. */
export function cameraMoves(doc) {
  const out = [];
  for (const { track, segment } of segmentsOf(doc)) {
    if (track.type !== 'video') continue;
    if (GRAPHIC.test(segment.desc || '')) continue;
    const t0 = startOf(segment), speed = speedOf(segment) || 1;
    for (const block of segment.common_keyframes || []) {
      if (!MOVE_PROPS.has(block.property_type)) continue;
      const keys = [...(block.keyframe_list || [])].sort((a, b) => a.time_offset - b.time_offset);
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i];
        if (Math.abs((a.values?.[0] ?? 0) - (b.values?.[0] ?? 0)) < 1e-6) continue;
        out.push({ t: r2(t0 + S(a.time_offset) / speed), end: r2(t0 + S(b.time_offset) / speed), property: block.property_type });
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
  for (const { track, segment } of segmentsOf(doc)) {
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
  for (const { segment } of segmentsOf(doc)) {
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
  const unsafe = graphics.filter(g => g.box).map(g => ({ g, zones: safeZoneViolations(g.box, profile) })).filter(x => x.zones.length);
  add('safe-zones', 'FAIL', !unsafe.length, unsafe.length ? unsafe.map(x => `${x.g.template || x.g.kind} at ${x.g.t}s in ${x.zones.join('+')}`).join('; ') : 'graphics clear of platform UI');
  const win = profile.sound.graphicSfxWindowSeconds;
  const unpaired = graphics.filter(g => g.kind !== 'text' && !sfx.some(s => Math.abs(s.t - g.t) <= win + 0.15));
  add('graphic-sfx', 'FAIL', !unpaired.length, unpaired.length ? `graphics without a sound: ${unpaired.map(g => `${g.template || g.kind}@${g.t}s`).join(', ')}` : 'every graphic has a sound');
  const logos = graphics.filter(g => g.kind === 'logo').map(g => g.t);
  const chipClash = graphics.filter(g => g.template === 'brand-chip' && logos.some(t => Math.abs(t - g.t) <= d.brandChipLogoGap));
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
