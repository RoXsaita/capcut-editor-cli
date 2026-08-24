import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapcutError, clone, uuid, allSegments } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let SFX = null;
export function sfxPresets() {
  if (!SFX) SFX = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'presets', 'sfx.json'), 'utf8'));
  return SFX;
}

let SEED = null;
function mint(key) {
  if (!SEED) return uuid();
  const h = crypto.createHash('sha256').update(`${SEED}|${key}`).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const US = s => Math.round(s * 1e6);
const arr = (doc, kind) => (doc.materials[kind] ||= []);

/** Cut points that a viewer actually sees: a scene change on any visual track. */
export function cutPoints(doc, { minGap = 0.9 } = {}) {
  const marks = new Map();
  for (const { segment, track } of allSegments(doc)) {
    if (track.type !== 'video' || !(track.segments || []).length) continue;
    const desc = segment.desc || '';
    if (desc.startsWith('layout:')) continue;              // bars and plates are not cuts
    const t = segment.target_timerange.start / 1e6;
    if (t <= 0.001) continue;                              // the first frame is not a cut
    const key = Math.round(t * 30) / 30;                   // frame-quantised
    marks.set(key, (marks.get(key) || 0) + 1);
  }
  const sorted = [...marks.entries()].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [t, weight] of sorted) {
    if (out.length && t - out.at(-1).t < minGap) { out.at(-1).weight += weight; continue; }
    out.push({ t, weight });
  }
  return out;
}

/** Ensure a named SFX / transition material exists; return its id. */
function ensureAudio(doc, name) {
  const p = sfxPresets();
  const tpl = p.audioTemplates[name];
  if (!tpl) throw new CapcutError(`unknown sfx "${name}". Known: ${Object.keys(p.audioTemplates).join(', ')}`, { code: 'UNKNOWN_SFX', exitCode: 2 });
  const found = (doc.materials.audios || []).find(m => m.name === name);
  if (found) return found.id;
  const m = clone(tpl);
  m.id = mint(`audio:${name}`);
  arr(doc, 'audios').push(m);
  return m.id;
}

function makeTransition(doc, name, durationS, key) {
  const p = sfxPresets();
  const tpl = p.transitionTemplates[name];
  if (!tpl) throw new CapcutError(`unknown transition "${name}"`, { code: 'UNKNOWN_TRANSITION', exitCode: 2 });
  const m = clone(tpl);
  m.id = mint(`transition:${key}`);
  m.duration = US(durationS);
  arr(doc, 'transitions').push(m);
  return m.id;
}

/**
 * Instantiated from a real CapCut audio segment (Hermes-agent), not invented. An audio
 * clip references speeds / placeholder_infos / beats / sound_channel_mappings /
 * vocal_separations — there is no audio_fades key, and guessing one produces a segment
 * CapCut will not play.
 */
function audioSegment(doc, materialId, startS, durationS, key, volume) {
  const p = sfxPresets();
  const seg = clone(p.audioSegmentTemplate);
  const refs = [];
  for (const [kind, tpl] of Object.entries(p.audioExtraTemplates)) {
    const m = clone(tpl);
    m.id = mint(`${kind}:${key}`);
    if ('bind_segment_id' in m) m.bind_segment_id = '';
    arr(doc, kind).push(m);
    refs.push(m.id);
  }
  seg.id = mint(`seg:${key}`);
  seg.material_id = materialId;
  seg.extra_material_refs = refs;
  seg.target_timerange = { start: US(Math.max(0, startS)), duration: US(durationS) };
  seg.source_timerange = { start: 0, duration: US(durationS) };
  seg.volume = volume;
  seg.last_nonzero_volume = volume;
  seg.desc = 'polish:sfx';
  return seg;
}

function ensureAudioTrack(doc, name) {
  let track = doc.tracks.find(t => t.type === 'audio' && t.name === name);
  if (track) return track;
  const tpl = doc.tracks.find(t => t.type === 'audio');
  track = clone(tpl || sfxPresets().audioTrackTemplate);
  track.id = mint(`track:${name}`);
  track.name = name;
  track.segments = [];
  doc.tracks.push(track);
  return track;
}

/**
 * Choose a pair per cut. His grammar, measured: a sweep for a layout change, a flash
 * for a jump inside a scene, a glitch when the machine does something, a coin on the
 * payoff. Deterministic — the same timeline always gets the same treatment.
 */
export function planPolish(doc, opts = {}) {
  const p = sfxPresets();
  const cuts = cutPoints(doc, { minGap: opts.minGap ?? 0.9 });
  const duration = (doc.duration || 0) / 1e6;
  const layoutChange = t => allSegments(doc).some(({ segment }) =>
    (segment.desc || '') === 'layout:seam-bar'
    && Math.abs(segment.target_timerange.start / 1e6 - t) < 0.05);

  // The coin is the payoff and there is exactly one payoff: the last cut into the CTA.
  // Firing it on everything in the closing stretch gave four coins in a row.
  const last = cuts.length ? cuts.at(-1).t : null;
  const rotate = ['flash', 'glitch', 'whiteflash', 'glitch2', 'flash', 'sweepL'];
  const plan = [];
  let rot = 0, prev = null;
  for (const c of cuts) {
    if (opts.only && !opts.only.includes(Math.round(c.t * 100) / 100)) continue;
    let name;
    if (c.t === last && duration > 20) name = 'payoff';
    else if (layoutChange(c.t)) name = 'sweep';
    else { name = rotate[rot++ % rotate.length]; }
    if (name === prev && name !== 'sweep') name = rotate[rot++ % rotate.length];  // never twice running
    prev = name;
    plan.push({ ...c, pair: name, ...p.pairs[name] });
  }
  return plan;
}

export function opPolish(doc, op, context = {}) {
  SEED = op.__seed || null;
  const p = sfxPresets();
  const lead = op.lead ?? p.rules.sfxLeadSeconds;
  const volume = op.volume ?? p.rules.volume;

  // start clean so re-running is idempotent
  for (const track of doc.tracks) {
    track.segments = (track.segments || []).filter(s => (s.desc || '') !== 'polish:sfx');
    for (const s of track.segments || []) {
      if (Array.isArray(s.extra_material_refs) && s.__polishTransition) delete s.__polishTransition;
    }
  }
  const priorTransitions = new Set((doc.materials.transitions || []).filter(m => m.__polish).map(m => m.id));
  for (const { segment } of allSegments(doc)) {
    segment.extra_material_refs = (segment.extra_material_refs || []).filter(r => !priorTransitions.has(r));
  }
  doc.materials.transitions = (doc.materials.transitions || []).filter(m => !m.__polish);

  const plan = planPolish(doc, op);
  const lane = ensureAudioTrack(doc, 'polish-sfx');
  const index = new Map(allSegments(doc).map(e => [e.segment.id, e]));

  let transitions = 0;
  for (const [i, cue] of plan.entries()) {
    // the transition rides the segment that ENDS at this cut, on the busiest visual track
    const ending = allSegments(doc).filter(({ segment, track }) =>
      track.type === 'video' && !(segment.desc || '').startsWith('layout:')
      && Math.abs((segment.target_timerange.start + segment.target_timerange.duration) / 1e6 - cue.t) < 0.05);
    if (ending.length && !op.noTransitions) {
      const target = ending.sort((a, b) => b.segment.target_timerange.duration - a.segment.target_timerange.duration)[0];
      const id = makeTransition(doc, cue.transition, cue.duration, `${i}:${cue.t}`);
      doc.materials.transitions.at(-1).__polish = true;
      target.segment.extra_material_refs = [...(target.segment.extra_material_refs || []), id];
      transitions++;
    }
    const audioId = ensureAudio(doc, cue.sfx);
    const tpl = p.audioTemplates[cue.sfx];
    const dur = Math.min((tpl.duration || US(0.5)) / 1e6, 1.2);
    lane.segments.push(audioSegment(doc, audioId, cue.t - lead, dur, `${i}:${cue.t}`, volume));
  }
  lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  doc.tracks.forEach((t, i) => (t.segments || []).forEach(s => { s.track_render_index = i; }));
  return { changed: plan.length, transitions, sfx: plan.length,
           cues: plan.map(c => ({ t: c.t, pair: c.pair, transition: c.transition, sfx: c.sfx })) };
}
