/**
 * `variant` — the same signed-off edit with a different hook, for trial reels.
 *
 * A hook is a source window of the talking-head take (`in`/`out` seconds, as in a production's
 * hooks.json). The variant is a duplicate of the project under a unique name whose opening —
 * the face segments up to the first cut, or `--opening S` — is replaced by that window:
 *
 *   - the body (everything from the old seam on, follow ending included) moves by the change in
 *     length, so every B-roll shot, graphic, caption and cue stays on its word;
 *   - the opening's graphics and cues are re-timed into the new opening (proportionally, or kept
 *     against the seam when they ended on it); a frame or bed that runs from the top is stretched
 *     to the new seam, and a scene across the seam (seam-wipe) moves with it;
 *   - the old hook's captions are dropped and the hook's own words captioned in the same style;
 *   - no volume is touched — the pops keep their levels (`rerender` used to reset them to 1.0).
 *
 * Then the gate runs on the variant. The op is deterministic and transactional like every other.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  CapcutError, activeStage, applySpec, assertCapcutClosed, contentEndUs, loadProject, readJson,
  removeUnreferencedMaterials, seededId, stableJson, uuid,
} from './core.mjs';
import { principalTrack } from './polish.mjs';
import { captionDisplayText, isCaptionTrack } from './captions.mjs';
import { parkPresetLeftover } from './add.mjs';

const US = s => Math.round(Number(s) * 1e6);
const r3 = n => Math.round(n * 1000) / 1000;
const S = us => r3((us || 0) / 1e6);
const FRAME_US = 34_000;

/** Read one hook from hooks.json: an array or `{ hooks: [...] }`, picked by id (or the only one). */
export function readHook(file, id = null) {
  const value = readJson(file);
  const hooks = Array.isArray(value) ? value : Array.isArray(value?.hooks) ? value.hooks : null;
  if (!hooks?.length) throw new CapcutError(`${file} has no hooks (expected [...] or {"hooks": [...]}).`, { code: 'HOOKS_FORMAT', exitCode: 2 });
  const named = hooks.map((h, i) => ({ ...h, id: String(h.id ?? h.name ?? i + 1) }));
  const hook = id == null ? (named.length === 1 ? named[0] : null) : named.find(h => h.id === String(id));
  if (!hook) {
    throw new CapcutError(`${id == null ? 'Pick a hook with --hook ID' : `No hook "${id}"`}; ${file} has: ${named.map(h => h.id).join(', ')}.`,
      { code: 'HOOK_NOT_FOUND', exitCode: 2 });
  }
  return normalizeHook(hook);
}

export function normalizeHook(hook) {
  const pick = (...keys) => keys.map(k => hook[k]).find(v => v != null);
  let start = pick('in', 'src_in', 'srcIn', 'source_in', 'sourceIn', 'start');
  let end = pick('out', 'src_out', 'srcOut', 'source_out', 'sourceOut', 'end');
  if (typeof hook.src === 'string' && start == null) [start, end] = hook.src.split('-').map(Number);
  start = Number(start); end = Number(end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new CapcutError(`Hook ${hook.id ?? ''} needs a source window: in/out seconds with out > in >= 0.`, { code: 'BAD_HOOK', exitCode: 2 });
  }
  return { id: String(hook.id ?? `${r3(start)}-${r3(end)}`), in: start, out: end };
}

function setStart(seg, start) {
  seg.target_timerange.start = start;
  if (seg.render_timerange?.duration) seg.render_timerange.start = start;
}

/** Change a clip's length at its own speed; a source that cannot reach is shortened instead. */
function setDuration(seg, duration, material) {
  const tt = seg.target_timerange, st = seg.source_timerange;
  const speed = st && tt.duration > 0 ? st.duration / tt.duration : 1;
  let short = false;
  if (st) {
    let src = Math.round(duration * speed);
    if (material && material.type !== 'photo' && material.duration > 0 && st.start + src > material.duration) {
      src = Math.max(0, material.duration - st.start);
      duration = Math.round(src / speed);
      short = true;
    }
    st.duration = src;
  }
  tt.duration = duration;
  if (seg.render_timerange?.duration) seg.render_timerange.duration = duration;
  return short;
}

function captionText(material) {
  try { return JSON.parse(material.content || '{}').text ?? ''; } catch { return material.content || ''; }
}

function withCaptionText(template, text) {
  const material = structuredClone(template);
  let content;
  try { content = JSON.parse(template.content || '{}'); } catch { content = {}; }
  content.text = text;
  if (Array.isArray(content.styles)) for (const style of content.styles) style.range = [0, text.length];
  material.content = JSON.stringify(content);
  if (material.words) material.words = { start_time: [], end_time: [], text: [] };
  return material;
}

export function opVariantHook(doc, op, context = {}) {
  const hook = normalizeHook(op.hook || {});
  const seed = op.__seed || `variant:${hook.id}`;
  const mint = key => seededId(seed, `variant:${key}`);
  const { index: pi, track: principal } = principalTrack(doc);
  const faces = [...principal.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  const ends = faces.map(s => s.target_timerange.start + s.target_timerange.duration);
  const O = op.opening != null ? US(op.opening) : ends[0];
  const cut = ends.findIndex(end => Math.abs(end - O) <= FRAME_US);
  if (cut < 0 || cut === faces.length - 1) {
    throw new CapcutError(`--opening ${S(O)}s is not a cut on the face track. Cuts: ${ends.slice(0, -1).map(S).join(', ')}.`,
      { code: 'BAD_OPENING', exitCode: 2 });
  }
  const seam = ends[cut];
  const opening = faces.slice(0, cut + 1);
  const template = opening[0];
  const materials = new Map(Object.values(doc.materials || {}).filter(Array.isArray).flat().filter(m => m?.id).map(m => [m.id, m]));
  const face = materials.get(template.material_id);
  const H = US(hook.out - hook.in);
  if (face?.duration > 0 && US(hook.out) > face.duration + 1) {
    throw new CapcutError(`Hook ${hook.id} ends at ${hook.out}s but the face take is ${S(face.duration)}s long.`, { code: 'BAD_HOOK', exitCode: 2 });
  }
  const delta = H - seam;
  const contentEnd = contentEndUs(doc, context.projectDir);
  const rows = { body: 0, stretched: [], seamMoved: [], retimed: [], captionsDropped: 0, captionsAdded: 0, short: [] };
  const drop = new Set();

  // The opening's face: the first segment becomes the hook, the rest of the old opening goes.
  // Its layout (clip, masks, frame refs) is kept; keyframes were timed to the old words.
  const removedFaces = new Set(opening.slice(1).map(s => s.id));
  for (const s of opening.slice(1)) for (const ref of s.extra_material_refs || []) drop.add(ref);
  principal.segments = principal.segments.filter(s => !removedFaces.has(s.id));
  template.source_timerange = { start: US(hook.in), duration: H };
  template.target_timerange = { start: 0, duration: H };
  if (template.render_timerange?.duration) template.render_timerange = { start: 0, duration: H };
  if (Number.isFinite(template.speed)) template.speed = 1;
  for (const ref of template.extra_material_refs || []) {
    const speed = materials.get(ref);
    if (speed && (doc.materials.speeds || []).includes(speed)) { speed.speed = 1; if ('curve_speed' in speed) speed.curve_speed = null; }
  }
  template.common_keyframes = [];
  template.keyframe_refs = [];

  let captionTemplate = null;
  for (const [index, track] of (doc.tracks || []).entries()) {
    const captions = isCaptionTrack(doc, track);
    const keep = [];
    for (const seg of track.segments || []) {
      if (seg === template) { keep.push(seg); continue; }
      const tt = seg.target_timerange;
      const start = tt.start, end = tt.start + tt.duration;
      const label = `${track.name || track.type}:${String(seg.id).slice(0, 8)}`;
      if (start >= contentEnd) { keep.push(seg); continue; }                 // parked parts bin
      if (start >= seam - FRAME_US) { setStart(seg, start + delta); rows.body++; keep.push(seg); continue; }
      if (index === pi) { keep.push(seg); continue; }
      if (captions) {
        captionTemplate ||= { seg, track };
        drop.add(seg.material_id);
        rows.captionsDropped++;
        continue;
      }
      const material = materials.get(seg.material_id);
      if (end > seam + FRAME_US) {
        // a bed that starts a beat in (music at 0.133) runs from the top too: moving it would go negative
        if (start <= FRAME_US || start + delta < 0) {
          if (setDuration(seg, tt.duration + delta, material)) rows.short.push(label);
          rows.stretched.push(label);
        } else {
          setStart(seg, start + delta);
          rows.seamMoved.push(label);
        }
      } else {
        const dur = Math.min(tt.duration, H);
        if (dur < tt.duration) setDuration(seg, dur, material);
        const at = Math.abs(end - seam) <= FRAME_US ? H - dur : Math.round(start * H / seam);
        setStart(seg, Math.max(0, Math.min(at, H - dur)));
        rows.retimed.push(label);
      }
      keep.push(seg);
    }
    track.segments = keep;
  }

  // The hook's own words, captioned like the words they replace.
  const words = (op.words || []).filter(w => w.start >= hook.in - 0.02 && w.start < hook.out - 0.02);
  const fallback = captionTemplate || (() => {
    const track = doc.tracks.find(t => isCaptionTrack(doc, t) && t.segments?.length);
    return track ? { seg: track.segments[0], track } : null;
  })();
  if (fallback && words.length) {
    const textTemplate = materials.get(fallback.seg.material_id);
    const times = words.map(w => ({ text: captionDisplayText(String(w.text ?? w.word ?? '').trim(), op.language || 'ar'),
      start: Math.max(0, US(w.start - hook.in)), end: Math.min(H, US((w.end ?? w.start) - hook.in)) }));
    const added = [];
    for (const [i, w] of times.entries()) {
      const end = Math.min(w.end, i + 1 < times.length ? times[i + 1].start - 1000 : H);
      if (!w.text || end <= w.start || !textTemplate) continue;
      const material = withCaptionText(textTemplate, w.text);
      material.id = mint(`caption:text:${i}`);
      const seg = structuredClone(fallback.seg);
      Object.assign(seg, { id: mint(`caption:segment:${i}`), material_id: material.id, extra_material_refs: [],
        common_keyframes: [], keyframe_refs: [] });
      seg.target_timerange = { start: w.start, duration: end - w.start };
      if (seg.render_timerange?.duration) seg.render_timerange = { ...seg.target_timerange };
      (doc.materials.texts ||= []).push(material);
      added.push(seg);
    }
    fallback.track.segments.push(...added);
    fallback.track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    rows.captionsAdded = added.length;
  }
  removeUnreferencedMaterials(doc, drop);

  for (const track of doc.tracks || []) track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  doc.duration = Math.max(0, ...doc.tracks.flatMap(t => t.segments.map(s => s.target_timerange.start + s.target_timerange.duration)));
  if (op.name) doc.name = op.name;
  const parked = parkPresetLeftover(doc, context, op);

  const warnings = [];
  if (rows.captionsDropped && !rows.captionsAdded) {
    warnings.push('The old hook\'s captions were removed and the new hook has none: pass --words TRANSCRIPT.json or run `capcutctl captions`.');
  }
  if (rows.short.length) warnings.push(`These run from the top but their source is too short to reach the new seam: ${rows.short.join(', ')}.`);
  if (rows.stretched.some(l => !l.startsWith('mograph') && /audio|music/.test(l))) {
    warnings.push('A music bed runs across the seam: it now plays the same notes under a shifted body, so re-run `capcutctl music` if its hits matter.');
  }
  return { changed: 1, hook, opening: { was: S(seam), now: S(H), delta: S(delta), faceSegmentsReplaced: opening.length },
    shifted: rows.body, stretched: rows.stretched, seamMoved: rows.seamMoved, retimed: rows.retimed,
    captions: { dropped: rows.captionsDropped, added: rows.captionsAdded }, parked: parked.slid || 0, warnings };
}

function uniqueName(root, base) {
  const clean = base.replace(/[/\\\0]/g, '-').trim();
  if (!fs.existsSync(path.join(root, clean))) return clean;
  for (let n = 2; ; n++) if (!fs.existsSync(path.join(root, `${clean} ${n}`))) return `${clean} ${n}`;
}

/**
 * Duplicate `projectDir` under a unique name with `hook` as its opening, then gate it.
 * A dry run plans the edit on the original (nothing is copied or written).
 */
export async function runVariant(projectDir, { hook, name = null, opening = null, words = null, language = 'ar',
  dryRun = false, forceRunning = false, processProbe = null, gate = true, profile = null } = {}) {
  hook = normalizeHook(hook);
  if (activeStage(projectDir)) {
    throw new CapcutError('This project has an active stage; `capcutctl stage commit` it before making variants.', { code: 'STAGE_ACTIVE', exitCode: 2 });
  }
  const root = path.dirname(projectDir);
  const target = name ? name : uniqueName(root, `${path.basename(projectDir)} hook-${hook.id}`);
  if (name && fs.existsSync(path.join(root, name))) throw new CapcutError(`${path.join(root, name)} already exists.`, { code: 'PROJECT_EXISTS', exitCode: 2 });
  const op = { op: 'variant.hook', hook, opening, words, language, name: target };
  if (dryRun) {
    const tx = applySpec(projectDir, { version: 1, name: 'variant', operations: [op] }, { dryRun: true });
    return { dryRun: true, project: path.join(root, target), from: projectDir, plan: tx.result[0].operations[0] };
  }
  // The duplicate is registered in CapCut's library, which CapCut owns while it runs.
  assertCapcutClosed({ forceRunning, probe: processProbe || undefined });
  const { cloneDraft } = await import('./stage.mjs');
  const { registerDraft, unregisterDraft } = await import('./create.mjs');
  // Everything that can refuse for reasons outside the draft (a broken profile) refuses before
  // anything is copied or registered.
  let gateWith = null;
  if (gate) {
    const { gateReport } = await import('./gate.mjs');
    const { loadProfile } = await import('./profile.mjs');
    gateWith = { gateReport, profile: profile || loadProfile() };
  }
  const dest = path.join(root, target);
  let registration = null;
  try {
    cloneDraft(projectDir, dest);
    const draftId = uuid();
    const metaFile = path.join(dest, 'draft_meta_info.json');
    if (fs.existsSync(metaFile)) {
      const now = Date.now() * 1000;
      fs.writeFileSync(metaFile, stableJson({ ...readJson(metaFile), draft_name: target, draft_fold_path: dest,
        draft_root_path: root, draft_id: draftId, tm_draft_create: now, tm_draft_modified: now, tm_draft_removed: 0 }));
    }
    // The new opening moves the end of the edit; the copied contentEnd describes the original.
    // Drop it here and the variant transaction records the live value (with a parked range).
    const createdFile = path.join(dest, '.capcutctl', 'created.json');
    if (fs.existsSync(createdFile)) {
      const created = readJson(createdFile);
      if (created && typeof created === 'object' && 'contentEnd' in created) {
        delete created.contentEnd;
        fs.writeFileSync(createdFile, stableJson(created));
      }
    }
    const tx = applySpec(dest, { version: 1, name: 'variant', operations: [op] }, { forceRunning: true, label: `variant-${hook.id}` });
    const durationUs = loadProject(dest).groups[0].doc.duration || 0;
    registration = registerDraft(root, dest, target, draftId, durationUs);
    let report = null;
    if (gateWith) {
      const state = loadProject(dest);
      const doc = (state.groups.find(g => g.name.startsWith('timeline:')) || state.groups[0]).doc;
      report = gateWith.gateReport(doc, { projectDir: dest, profile: gateWith.profile });
    }
    return { created: true, project: dest, name: target, from: projectDir, plan: tx.result[0].operations[0],
      snapshot: tx.snapshot, ...registration, gate: report };
  } catch (error) {
    // The folder goes, so its library entry must go too: CapCut lists a registered draft whose
    // folder is missing as a broken project.
    if (registration?.registered) {
      try { unregisterDraft(root, dest); } catch { /* the original error is the one to report */ }
    }
    fs.rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}
