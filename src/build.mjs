/**
 * `build` — one edit plan in, a finished editable project out.
 *
 * After the talking head is signed off, everything else is mechanical: the agent writes only
 * the judgement (which shots, which words deserve a graphic, which brands, the CTA, the music
 * brief) into an `edit.json`, and `build` compiles it into the existing operations in a fixed
 * order, with the profile's defaults filling every gap:
 *
 *   picture   reviewed shots (once) → layout auto → camera (stress pushes, optional reframe/cursor)
 *   graphics  mograph renders placed on their words, full-frame scenes cut in on theirs (their
 *             sound is inside the clip) → logo pops (or a brand-chip when the art is
 *             missing) → endcard → the follow ending (profile ending.auto or edit.json `ending`),
 *             appended after the last frame, opening on that frame
 *   sound     motivated seams + SFX → music bed aligned to the graphics and picture changes →
 *             loudness (true peak held under the ceiling by lowering levels) → duck under speech
 *   gate      the blocking ready-to-post check
 *
 * Every stage owns its output (mograph:*, sig:*, polish:*, finish:music), so running `build`
 * again replaces rather than stacks. Graphics are anchored to SOURCE WORDS: after a recut the
 * same plan lands every graphic on its word again, or refuses by name when a word was cut.
 * An unchanged plan on an unchanged cut is a no-op (`.capcutctl/build.json` holds its hash and
 * the ids of the segments build placed; when a restore took those away, it rebuilds).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CapcutError, stableJson, applySpec, loadProject, loadWorkingDoc, readJson, resolveMediaPath, allSegments, BUILD_STATE_RELATIVE,
  repairProject, restoreProjectSnapshot,
} from './core.mjs';
import { findWordsFile, resolveAnchors } from './anchors.mjs';
import { layoutAt } from './mograph-place.mjs';
import { safeZoneViolations } from './mograph-geometry.mjs';
import { loadProfile, applyStyle } from './profile.mjs';
import { principalTrack, pictureChanges } from './polish.mjs';
import { firstPictureProof } from './finish.mjs';
import { gateReport, writeGateRecord, foldBuildStages, noteRestoredMeta } from './gate.mjs';

export const EDIT_PLAN_VERSION = 1;
const ENDING_KEYS = new Set(['frame', 'noSfx', 'pill', 'headline', 'sub', 'badge', 'faceX', 'faceY', 'faceScale']);
const r3 = n => Math.round(n * 1000) / 1000;

const fail = (code, message, details) => { throw new CapcutError(message, { code, exitCode: 2, details }); };

const segmentIds = doc => new Set(allSegments(doc).map(entry => entry.segment.id));
const firstLine = error => String(error?.message || error).split('\n')[0];
// The loudness refusals the sound stage may fall back from (the mix stands without the pass,
// and the gate FAILs build-stages). Anything else is a real error and propagates.
const LOUDNESS_FALLBACK = new Set(['MIX_PEAK_EXCEEDED', 'AUDIO_MEASURE_FAILED', 'LUFS_MEASURE_FAILED', 'LUFS_UNMEASURABLE',
  'VOLUME_BOOST_UNVERIFIED', 'BAD_LUFS']);
const POLISH_OWNED = /^polish:(sfx|callout|click|type)$/;

function workingDoc(projectDir) {
  const state = loadProject(projectDir);
  const group = state.groups.find(g => g.name.startsWith('timeline:')) || state.groups[0];
  return group.doc;
}

/** Validate and normalise an edit plan. Unknown top-level keys refuse, so a typo is not silently ignored. */
export function normalizePlan(raw, { baseDir = process.cwd() } = {}) {
  if (!raw || typeof raw !== 'object') fail('PLAN_INVALID', 'edit plan must be a JSON object');
  if (raw.version !== EDIT_PLAN_VERSION) fail('PLAN_VERSION', `edit plan version must be ${EDIT_PLAN_VERSION}`);
  const known = new Set(['version', 'profile', 'style', 'words', 'shots', 'layout', 'camera', 'graphics', 'scenes', 'logos', 'endcard', 'ending', 'sound', 'notes']);
  const unknown = Object.keys(raw).filter(k => !known.has(k));
  if (unknown.length) fail('PLAN_INVALID', `unknown edit plan keys: ${unknown.join(', ')}`);
  const abs = file => (file ? path.resolve(baseDir, String(file).replace(/^~(?=$|\/)/, process.env.HOME || '~')) : null);
  const graphics = (raw.graphics || []).map((g, i) => {
    if (!g?.template) fail('PLAN_INVALID', `graphics[${i}] needs a template`);
    if (g.say == null && g.at == null) fail('PLAN_INVALID', `graphics[${i}] (${g.template}) needs "say" (words) or "at" (seconds)`);
    const id = g.id || `${g.template}-${i + 1}`;
    if (!/^[\w.-]{1,80}$/.test(id)) fail('PLAN_INVALID', `graphics[${i}] id "${id}" must be alphanumeric`);
    return { ...g, id, params: { ...(g.params || {}) } };
  });
  // Scenes: full-frame motion design (mograph/scenes), anchored like graphics but starting ON
  // their word (a scene is a cut, not a super that leads the word).
  const scenes = (raw.scenes || []).map((g, i) => {
    if (!g?.scene) fail('PLAN_INVALID', `scenes[${i}] needs a scene`);
    if (g.say == null && g.at == null) fail('PLAN_INVALID', `scenes[${i}] (${g.scene}) needs "say" (words) or "at" (seconds)`);
    const id = g.id || `${g.scene}-${i + 1}`;
    if (!/^[\w.-]{1,80}$/.test(id)) fail('PLAN_INVALID', `scenes[${i}] id "${id}" must be alphanumeric`);
    return { ...g, id, params: { ...(g.params || {}) } };
  });
  const ids = [...graphics, ...scenes].map(g => g.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) fail('PLAN_INVALID', `duplicate graphic/scene id "${dup}"`);
  let ending = raw.ending === undefined ? null : raw.ending;
  if (ending !== null && typeof ending !== 'boolean') {
    if (typeof ending !== 'object' || Array.isArray(ending)) fail('PLAN_INVALID', 'ending must be true, false or an object');
    const bad = Object.keys(ending).filter(k => !ENDING_KEYS.has(k));
    if (bad.length) fail('PLAN_INVALID', `unknown ending keys: ${bad.join(', ')}`);
    ending = { ...ending, ...(ending.frame ? { frame: abs(ending.frame) } : {}) };
  }
  const sound = { seams: 'motivated', music: false, duck: true, loudness: true, ...(raw.sound || {}) };
  if (sound.music && typeof sound.music === 'object' && sound.music.file) sound.music = { ...sound.music, file: abs(sound.music.file) };
  return {
    version: EDIT_PLAN_VERSION,
    profile: abs(raw.profile),
    style: raw.style == null ? null : String(raw.style),
    words: abs(raw.words),
    shots: abs(raw.shots),
    layout: raw.layout === undefined ? 'auto' : raw.layout,
    camera: { stress: true, reframe: false, cursor: false, ...(raw.camera || {}) },
    graphics,
    scenes,
    logos: raw.logos === undefined ? 'auto' : raw.logos,
    endcard: raw.endcard === undefined ? null : raw.endcard,
    ending,
    sound,
  };
}

export function readEditPlan(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) fail('PLAN_MISSING', `no such edit plan: ${resolved}`);
  return normalizePlan(readJson(resolved), { baseDir: path.dirname(resolved) });
}

function principalSignature(doc, projectDir = null) {
  const { track } = principalTrack(doc);
  const media = new Map((doc.materials?.videos || []).map(m => [m.id, m.path]));
  // A relink keeps the material id; the file stamp is what tells the ending its frame changed.
  const stamp = id => {
    try { const st = fs.statSync(resolveMediaPath(media.get(id), projectDir)); return `${st.size}@${st.mtimeMs}`; }
    catch { return ''; }
  };
  return (track.segments || []).map(s => [s.material_id, stamp(s.material_id), s.source_timerange?.start, s.source_timerange?.duration,
    s.target_timerange?.start, s.target_timerange?.duration].join(':')).join('|');
}

function planHash(plan, profile, doc, wordsFile, templateHashes, projectDir = null) {
  let wordsStamp = null;
  if (wordsFile && fs.existsSync(wordsFile)) { const st = fs.statSync(wordsFile); wordsStamp = `${st.size}:${st.mtimeMs}`; }
  return crypto.createHash('sha256').update(JSON.stringify({
    plan, profile, principal: principalSignature(doc, projectDir), wordsStamp, templateHashes,
  })).digest('hex').slice(0, 24);
}

function templateMotion(id, templates) {
  return templates.find(t => t.id === id)?.motion || 'rich';
}

/** Brands heard in the cut: art → native logo pop; no art → brand-chip graphic (when that template exists). */
async function planLogos(plan, doc, wordsFile, templates) {
  if (!plan.logos) return { logos: [], chips: [] };
  const sig = await import('./signature.mjs');
  const mapper = sig.sourceToTimeline(doc);
  let hits = [];
  if (plan.logos === 'auto') {
    if (!wordsFile) return { logos: [], chips: [], skipped: 'no word-level transcript for brand detection' };
    hits = sig.detectBrands(readJson(wordsFile), mapper);
  } else if (Array.isArray(plan.logos)) {
    const brands = sig.brandPresets().brands;
    const anchored = resolveAnchors(plan.logos.map((l, i) => ({ ...l, id: l.brand || l.name || `logo-${i + 1}` })),
      { doc, wordsFile });
    hits = anchored.map(l => ({ brand: l.brand || l.name || path.basename(l.logo || '').replace(/\.[^.]+$/, ''),
      at: l.at, logo: l.logo ? path.resolve(l.logo) : brands[l.brand]?.logo || null }));
    const noTime = hits.filter(h => h.at == null);
    if (noTime.length) fail('PLAN_INVALID', `logos need "say" or "at": ${noTime.map(h => h.brand).join(', ')}`);
  }
  const art = hits.filter(h => h.logo && fs.existsSync(h.logo));
  const missing = hits.filter(h => !h.logo || !fs.existsSync(h.logo));
  const chips = templates.some(t => t.id === 'brand-chip')
    ? missing.map(h => ({ id: `brand-chip-${String(h.brand).replace(/[^\w.-]+/g, '-')}`, template: 'brand-chip', at: h.at,
      params: { name: h.brand }, fromLogo: true }))
    : [];
  const rules = sig.sigPresets().rules;
  const logos = art.map(h => ({ brand: h.brand, at: r3(h.at), logo: h.logo }));
  sig.spreadOverlapping(logos, rules);
  return { logos, chips, missingArt: missing.map(h => h.brand) };
}

async function renderGraphics(projectDir, graphics, { dryRun, profile }) {
  const mograph = await import('./mograph.mjs');
  const dir = path.join(projectDir, 'mograph');
  const out = [];
  for (const g of graphics) {
    const sidecarFile = path.join(dir, `${g.id}.json`);
    const fingerprint = mograph.fingerprint(g.template, g.params, profile);
    const cached = fs.existsSync(sidecarFile) ? readJson(sidecarFile) : null;
    let rendered;
    if (cached && cached.fingerprint === fingerprint && cached.format === g.format && fs.existsSync(cached.file)) {
      rendered = { ...cached, cached: true };
    } else if (dryRun) {
      const probe = await mograph.probeMograph({ template: g.template, params: g.params, profile });
      rendered = { template: g.template, params: g.params, format: g.format, box: probe.box, meta: probe.meta, fingerprint,
        file: path.join(dir, `${g.id}.${g.format === 'png-still' ? 'png' : 'mov'}`), importVerified: g.format === 'png-still' };
    } else {
      rendered = await mograph.renderMograph({ template: g.template, params: g.params, out: path.join(dir, g.id), format: g.format, profile });
    }
    const unsafe = safeZoneViolations(rendered.box, profile);
    if (unsafe.length && !g.allowUnsafe) {
      fail('MOGRAPH_SAFE_ZONE', `${g.id} (${g.template}) sits in the platform UI (${unsafe.join(', ')}). `
        + 'Move it with params.center/layout, or set "allowUnsafe": true if intended.');
    }
    out.push({ ...g, rendered, sidecarFile, fingerprint });
  }
  return out;
}

async function renderScenes(projectDir, scenes, { dryRun, profile }) {
  if (!scenes.length) return [];
  const mod = await import('./mograph-scene.mjs');
  const dir = path.join(projectDir, 'mograph');
  const out = [];
  for (const g of scenes) {
    const sidecarFile = path.join(dir, `${g.id}.json`);
    const fingerprint = mod.sceneFingerprint(g.scene, g.params, profile);
    const cached = fs.existsSync(sidecarFile) ? readJson(sidecarFile) : null;
    let rendered;
    if (cached && cached.fingerprint === fingerprint && fs.existsSync(cached.file)) {
      rendered = { ...cached, unsafe: [], cached: true };
    } else if (dryRun) {
      const probe = await mod.probeScene({ scene: g.scene, params: g.params, profile });
      rendered = { scene: g.scene, params: g.params, format: 'prores', meta: probe.meta, unsafe: probe.unsafe, fingerprint,
        file: path.join(dir, `${g.id}.mov`) };
    } else {
      rendered = await mod.renderScene({ scene: g.scene, params: g.params, out: path.join(dir, g.id), format: 'prores', profile,
        allowUnsafe: Boolean(g.allowUnsafe) });
    }
    if (rendered.unsafe?.length && !g.allowUnsafe) {
      const u = rendered.unsafe[0];
      fail('SCENE_SAFE_ZONE', `${g.id} (${g.scene}): "${u.text}" is in the ${u.zone} zone at ${u.t}s. `
        + 'Shorten the text, or set "allowUnsafe": true if intended.');
    }
    out.push({ ...g, template: null, format: 'prores', rendered, sidecarFile, fingerprint,
      box: { x: 0, y: 0, w: profile.canvas.width, h: profile.canvas.height } });
  }
  return out;
}

function writeSidecars(graphics) {
  for (const g of graphics) {
    const r = g.rendered;
    fs.mkdirSync(path.dirname(g.sidecarFile), { recursive: true });
    fs.writeFileSync(g.sidecarFile, stableJson({
      version: 1, id: g.id, ...(g.scene ? { scene: g.scene } : {}), template: g.template, params: g.params, format: g.format,
      file: r.file, box: g.box || r.box,
      meta: r.meta, fingerprint: g.fingerprint, anchor: g.anchor || null, at: g.at, duration: g.duration,
      importVerified: !g.scene && g.format === 'png-still',
    }));
  }
}

/**
 * What would refuse later, found before the first write: the music brief / Gemini key and the
 * speech index the duck keys from. A real build throws; a dry run reports it in its stages.
 */
async function preflight(projectDir, plan, doc, profile, wordsFile, dryRun) {
  const found = {};
  if (plan.sound.music) {
    const { musicPreflight } = await import('./music.mjs');
    const m = typeof plan.sound.music === 'object' ? plan.sound.music : {};
    const music = musicPreflight(projectDir, doc, {
      file: m.file || undefined, prompt: m.prompt || undefined, regen: Boolean(m.regen),
      volume: m.volume ?? profile.sound.musicVolume, hits: Array.isArray(m.hits) && m.hits.length ? m.hits : null,
    });
    if (music.code) {
      if (!dryRun) fail(music.code, music.error, { stage: 'music', needsBrief: music.needsBrief, keyMissing: music.keyMissing });
      found.music = music;
    }
  }
  if (plan.sound.music && plan.sound.duck && profile.sound.duck) {
    const { speechSpans } = await import('./duck.mjs');
    try { speechSpans(doc, wordsFile ? { wordsFile } : {}, { projectDir }); }
    catch (error) {
      if (!dryRun) throw error;
      found.duck = { code: error.code || null, error: `${error.code || 'DUCK_FAILED'}: ${firstLine(error)}` };
    }
  }
  return found;
}

/**
 * Compile and apply. Returns { upToDate?, stages, gate }. `dryRun` validates every stage and
 * writes nothing (renders are probed, not encoded). A stage that throws after an earlier one
 * committed restores the draft to before the build (error.details.rolledBack).
 */
export async function runBuild(projectDir, plan, { dryRun = false, force = false, forceRunning = false, backup = true, record = true } = {}) {
  const profileFile = plan.profile || null;
  const profile = applyStyle(loadProfile({ file: profileFile }), plan.style);
  const mograph = await import('./mograph.mjs');
  const templates = mograph.listTemplates();
  const txn = label => ({ dryRun, forceRunning, backup, label });
  const stages = {};
  // A CapCut save strips desc / capcutctl_* (the identity of every mograph:*, sig:* and the
  // follow ender). The writers prune and replace by those keys, so reading only would stack a
  // second copy of every graphic: put them back in the draft first (a dry run uses the copy).
  let { doc, restored } = loadWorkingDoc(projectDir);
  if (restored.length && !dryRun) {
    stages.repaired = repairProject(projectDir, { forceRunning, backup, label: 'build-repair' }).repaired;
    ({ doc } = loadWorkingDoc(projectDir));
  }
  principalTrack(doc);                                     // refuses a project with no talking head
  const wordsFile = plan.words || findWordsFile(doc);
  const templateHashes = Object.fromEntries(templates.map(t => [t.id, mograph.fingerprint(t.id, {}, profile)]));
  if (plan.scenes.length) {
    const { listScenes, sceneFingerprint } = await import('./mograph-scene.mjs');
    const known = new Set(listScenes().map(x => x.id));
    const unknown = plan.scenes.find(x => !known.has(x.scene));
    if (unknown) fail('PLAN_INVALID', `unknown scene "${unknown.scene}" (see capcutctl mograph scenes)`);
    for (const id of new Set(plan.scenes.map(x => x.scene))) templateHashes[`scene:${id}`] = sceneFingerprint(id, {}, profile);
  }
  const hash = planHash(plan, profile, doc, wordsFile, templateHashes, projectDir);
  const stateFile = path.join(projectDir, BUILD_STATE_RELATIVE);
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : {};
  const startIds = segmentIds(doc);
  const previousOutputs = Array.isArray(state.outputs) ? state.outputs : [];
  // The hash covers the plan and the principal cut, not the overlays build placed. A restore
  // that removed them left the hash matching, and "up to date" sat on an empty draft.
  const outputsPresent = previousOutputs.every(id => startIds.has(id));
  if (!force && !dryRun && state.hash === hash) {
    if (outputsPresent) {
      const gate = gateReport(doc, { projectDir, profile });
      if (Array.isArray(state.skipped)) foldBuildStages(gate, state.skipped);
      return { upToDate: true, hash, gate, skipped: Array.isArray(state.skipped) ? state.skipped : [],
        ...(stages.repaired ? { repaired: stages.repaired } : {}) };
    }
    stages.reason = 'build outputs missing (restore?)';
  }

  const found = await preflight(projectDir, plan, doc, profile, wordsFile, dryRun);
  if (found.duck) stages.duck = found.duck;

  // From the first committed stage on, a throw puts the draft back to before the build.
  const skipped = [];
  let firstSnapshot = null;
  let failedStage = null;
  const remember = tx => { if (!dryRun && !firstSnapshot && tx?.snapshot) firstSnapshot = tx.snapshot; return tx; };
  const apply = (name, operations) => {
    failedStage = name;
    return remember(applySpec(projectDir, { version: 1, name, operations }, txn(name)));
  };
  let rendered, logoPlan, ranPolish = false, prunedSeams = false;
  let shotOutputs = Array.isArray(state.shotOutputs) ? state.shotOutputs : [];
  try {
    // ---- picture: shots (once), layout, camera ----------------------------------------------
    const pictureOps = [];
    if (plan.shots) {
      const shotsKey = crypto.createHash('sha256').update(fs.readFileSync(plan.shots)).digest('hex').slice(0, 16);
      // --force also re-applies shots whose placed clips are all gone (a restore from before them).
      const shotOutputs = Array.isArray(state.shotOutputs) ? state.shotOutputs : [];
      const shotsGone = force && shotOutputs.length > 0 && !shotOutputs.some(id => startIds.has(id));
      if (state.shots !== shotsKey || shotsGone) {
        const matcher = await import('./match.mjs');
        const spec = matcher.shotsToSpec(matcher.readShotsFile(plan.shots), {});
        const check = matcher.writersAccept(spec.operations);
        if (!check.ok) fail('UNSUPPORTED_OPERATION', 'shots emit ops the writers do not accept', check.rejected);
        pictureOps.push(...spec.operations);
        stages.shots = { applied: spec.operations.length, key: shotsKey };
      } else stages.shots = { applied: 0, reason: 'already applied (change shots with match/replace-media, or restore a snapshot)' };
    }
    if (pictureOps.length) {
      const beforeShots = segmentIds(doc);
      stages.shotsResult = apply('build-shots', pictureOps);
      if (!dryRun) {
        doc = workingDoc(projectDir);
        shotOutputs = [...segmentIds(doc)].filter(id => !beforeShots.has(id));
      }
    }
    const cameraOps = [];
    if (plan.layout === 'auto') {
      const { buildLayoutSpec } = await import('./layouts.mjs');
      try { cameraOps.push(...buildLayoutSpec(projectDir, 'auto', {}).operations); }
      catch (error) {
        stages.layout = { skipped: error.message };
        skipped.push({ stage: 'layout', reason: firstLine(error), code: error.code || null });
      }
    }
    if (plan.camera.reframe) cameraOps.push({ op: 'reframe', auto: true });
    if (plan.camera.cursor) cameraOps.push({ op: 'cursor', auto: true });
    if (plan.camera.stress) {
      const stressOp = { op: 'zoom.stress', ease: profile.camera.ease, ...(wordsFile ? { wordsFile } : {}) };
      try {
        applySpec(projectDir, { version: 1, name: 'build-stress-check', operations: [stressOp] }, { ...txn('check'), dryRun: true });
        cameraOps.push(stressOp);
      } catch (error) {
        stages.stress = { skipped: firstLine(error) };
        skipped.push({ stage: 'stress', reason: firstLine(error), code: error.code || null });
      }
    }
    if (cameraOps.length) {
      stages.picture = apply('build-picture', cameraOps);
      if (!dryRun) doc = workingDoc(projectDir);
    }

    // ---- graphics -----------------------------------------------------------------------------
    failedStage = 'build-graphics';
    logoPlan = await planLogos(plan, doc, wordsFile, templates);
    const wanted = [...plan.graphics, ...logoPlan.chips];
    const anchored = resolveAnchors(wanted, { doc, wordsFile });
    const lead = profile.tokens.frames.lead / profile.canvas.fps;
    const graphics = anchored.map(g => {
      // Anchored graphics lead their word by the profile's lead frames (the anchor already
      // carries any offset); timed ones take `at` plus their offset as given.
      const at = Math.max(0, g.say ? g.at - lead : Number(g.at) + Number(g.offset || 0));
      const params = { ...g.params };
      if (!params.center && !params.box && !params.layout) params.layout = layoutAt(doc, at);
      if (g.hold != null && params.hold == null) params.hold = g.hold;
      const format = g.format || (templateMotion(g.template, templates) === 'rich' ? 'prores' : 'png-still');
      return { ...g, at: r3(at), params, format };
    });
    const sceneItems = resolveAnchors(plan.scenes, { doc, wordsFile })
      .map(g => ({ ...g, at: r3(Math.max(0, g.say ? g.at : Number(g.at) + Number(g.offset || 0))) }));
    rendered = [
      ...(await renderGraphics(projectDir, graphics, { dryRun, profile })),
      ...(await renderScenes(projectDir, sceneItems, { dryRun, profile })),
    ].sort((a, b) => a.at - b.at);
    for (const g of rendered) g.duration = r3(g.rendered.meta.duration);
    // null: profile ending.auto decides; false also removes an ending placed earlier.
    const ending = plan.ending ?? (profile.ending?.auto ? true : null);
    const graphicOps = [{ op: 'mograph.prune', keep: rendered.map(g => g.id), dropEnding: plan.ending === false }];
    for (const g of rendered) {
      if (g.scene) {
        graphicOps.push({
          op: 'mograph.place', id: g.id, template: `scene:${g.scene}`, file: g.rendered.file, format: 'prores',
          at: g.at, duration: g.duration, box: g.box, fingerprint: g.fingerprint, sfx: null,
          ...(g.volume != null ? { clipVolume: g.volume } : {}), importVerified: false,
        });
        continue;
      }
      graphicOps.push({
        op: 'mograph.place', id: g.id, template: g.template, file: g.rendered.file, format: g.format,
        at: g.at, duration: g.duration, box: g.rendered.box, fingerprint: g.fingerprint,
        sfx: g.sfx === null ? null : (g.sfx || g.rendered.meta.sfx), sfxLead: 0,
        importVerified: g.format === 'png-still',
      });
    }
    const signature = {};
    if (logoPlan.logos.length) signature.logos = logoPlan.logos;
    if (plan.endcard) signature.endcard = typeof plan.endcard === 'object' ? plan.endcard : {};
    // logos:false, or a recut that no longer names a brand the last build popped, takes the old
    // pops and their sounds away. Never when detection could not run (no transcript): those
    // pops are kept, not judged. The endcard clears only on an explicit "endcard": false.
    const clears = {};
    if (!signature.logos && !logoPlan.skipped && (plan.logos === false || Number(state.logos) > 0)) clears.clearLogos = true;
    if (plan.endcard === false) clears.clearEndcard = true;
    if (Object.keys(signature).length || Object.keys(clears).length) {
      graphicOps.push({ op: 'signature', ease: true, glow: (profile.logo?.reveal === 'glow'), ...signature, ...clears });
    }
    const planned = rendered.map(g => ({ id: g.id, ...(g.scene ? { scene: g.scene } : { template: g.template }), at: g.at,
      duration: g.duration, format: g.format, box: g.box || g.rendered.box, anchor: g.anchor || null, cached: Boolean(g.rendered.cached) }));
    // A dry run has only probed the renders, so their files do not exist yet: validate everything
    // else in the stage and report the placements it would make.
    const applied = dryRun ? graphicOps.filter(op => op.op !== 'mograph.place') : graphicOps;
    stages.graphics = { planned, signature: Object.keys(signature).length ? signature : null,
      ...(Object.keys(clears).length ? { cleared: Object.keys(clears) } : {}),
      result: apply('build-graphics', applied) };
    if (logoPlan.skipped) stages.logosSkipped = logoPlan.skipped;
    if (logoPlan.missingArt?.length) {
      stages.logosMissingArt = logoPlan.missingArt;
      const chipped = new Set(logoPlan.chips.map(c => c.params.name));
      const bare = logoPlan.missingArt.filter(b => !chipped.has(b));
      if (bare.length) {
        skipped.push({ stage: 'logos', reason: `no logo art (and no brand-chip template) for ${bare.join(', ')}: capcutctl brands`, code: 'NO_LOGO_ASSET' });
      }
    }
    if (!dryRun) { writeSidecars(rendered); doc = workingDoc(projectDir); }

    // ---- ending: after the picture and graphics are final, so it opens on the real last frame;
    // before sound, so the music bed and loudness cover it.
    if (ending) {
      failedStage = 'ending';
      const { runEnding } = await import('./ending.mjs');
      const o = typeof ending === 'object' ? ending : {};
      stages.ending = await runEnding(projectDir, { frame: o.frame || null, copy: o, noSfx: Boolean(o.noSfx),
        profileFile: plan.profile || null, dryRun, forceRunning, backup });
      remember(stages.ending?.transaction);
      if (!dryRun) doc = workingDoc(projectDir);
    }

    // ---- sound --------------------------------------------------------------------------------
    failedStage = 'build-sound';
    const soundOps = [];
    let pruneSeams = !plan.sound.seams;
    if (plan.sound.seams) {
      if (firstPictureProof(doc).ok) { soundOps.push({ op: 'polish', motivated: plan.sound.seams !== 'all' }); ranPolish = true; }
      else { stages.seams = { skipped: 'first picture is not proof; fix the opening, then rebuild' }; pruneSeams = true; }
    }
    // Seams off (or skipped): an earlier pass's transitions and woosh/click cues come out, but
    // only the transitions build recorded placing — one the user added by hand stays.
    const seamTransitions = Array.isArray(state.seamTransitions) ? state.seamTransitions : [];
    const polishLeft = allSegments(doc).some(({ segment }) => POLISH_OWNED.test(segment.desc || ''));
    if (pruneSeams && (seamTransitions.length || polishLeft)) {
      soundOps.push({ op: 'polish', prune: true, only: seamTransitions });
      prunedSeams = true;
      stages.seams = { ...(stages.seams || {}), pruned: true };
    }
    if (plan.sound.music) {
      const { prepareMusic } = await import('./music.mjs');
      const m = typeof plan.sound.music === 'object' ? plan.sound.music : {};
      const hits = Array.isArray(m.hits) ? m.hits
        : [...new Set([...rendered.map(g => g.at), ...pictureChanges(doc, { projectDir }).map(c => c.t)].map(r3))].sort((a, b) => a - b);
      const prepared = await prepareMusic(projectDir, doc, {
        file: m.file || undefined, prompt: m.prompt || undefined, regen: Boolean(m.regen),
        volume: m.volume ?? profile.sound.musicVolume, hits: hits.length ? hits : null, dryRun,
      });
      const off = prepared.align?.offset || 0;
      stages.music = { file: prepared.file, hits: prepared.hits, offset: off, wouldGenerate: prepared.wouldGenerate || false,
        needsBrief: Boolean(prepared.needsBrief || found.music?.needsBrief),
        error: found.music?.error || prepared.error || null, keyMissing: Boolean(found.music?.keyMissing) };
      if (!dryRun) {
        soundOps.push({ op: 'music', file: prepared.file, duration: prepared.duration, volume: prepared.volume,
          srcOffset: off < 0 ? -off : 0, at: off > 0 ? off : 0, fadeIn: 0.4, fadeOut: 1.2 });
      }
    }
    // Loudness before the duck: the measurement cannot render volume keyframes, and the duck only
    // lowers the bed, so the peak ceiling loudness proves on the full bed still holds once ducked.
    // Loudness may lower the music (never raise it); the duck then keys from that level.
    if (plan.sound.loudness) soundOps.push({ op: 'loudness', target: profile.sound.loudnessTarget, peak: profile.sound.peak });
    if (plan.sound.music && !dryRun && plan.sound.duck && profile.sound.duck) {
      soundOps.push({ op: 'music', duck: true, ...(wordsFile ? { wordsFile } : {}) });
    }
    if (soundOps.length) {
      try {
        stages.sound = apply('build-sound', soundOps);
      } catch (error) {
        // Loudness refuses a mix it cannot make safe; the rest of the sound stage still stands
        // (and the gate FAILs build-stages). Any other error is real and propagates.
        if (!soundOps.some(op => op.op === 'loudness') || !LOUDNESS_FALLBACK.has(error.code)) throw error;
        const rest = soundOps.filter(op => op.op !== 'loudness');
        stages.sound = rest.length ? apply('build-sound', rest) : null;
        stages.loudness = { skipped: firstLine(error) };
        skipped.push({ stage: 'loudness', reason: firstLine(error), code: error.code });
      }
      // what the peak limiter lowered to keep the mix under the ceiling (loudness reports it per segment)
      const ops = stages.sound?.result?.[0]?.operations || [];
      const loud = ops.find(r => r.op === 'loudness');
      if (loud?.peakLimit) stages.peakLimit = loud.peakLimit;
      const pruned = ops.find(r => r.op === 'polish' && r.pruned);
      if (pruned) stages.seams = { ...(stages.seams || {}), pruned: { transitions: pruned.removedTransitions, sfx: pruned.removedSfx,
        ...(pruned.transitionsUnknown ? { unknown: pruned.transitionsUnknown } : {}) } };
      if (!dryRun) doc = workingDoc(projectDir);
    }
  } catch (error) {
    if (dryRun) throw error;
    let rolledBack = false, rollbackError = null;
    if (firstSnapshot) {
      try { restoreProjectSnapshot(projectDir, firstSnapshot, { forceRunning }); rolledBack = true; }
      catch (undo) { rollbackError = firstLine(undo); }
    }
    const extra = { rolledBack, snapshot: firstSnapshot, failedStage, ...(rollbackError ? { rollbackError } : {}) };
    if (error && typeof error === 'object') {
      Object.assign(error, extra);
      error.details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? { ...error.details, ...extra } : { ...(error.details != null ? { cause: error.details } : {}), ...extra };
      if (rolledBack) error.message += ` (build rolled back to before ${failedStage}: ${path.basename(firstSnapshot)})`;
    }
    throw error;
  }

  // ---- gate -----------------------------------------------------------------------------------
  const gate = gateReport(doc, { projectDir, profile });
  foldBuildStages(gate, skipped);
  if (dryRun) noteRestoredMeta(gate, restored);
  if (!dryRun) {
    if (record) writeGateRecord(projectDir, gate);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const finalDoc = workingDoc(projectDir);
    // What build placed: segments that are new since the start, plus earlier outputs it kept
    // (a rebuild re-places graphics under their stable ids).
    const kept = new Set(previousOutputs);
    const outputs = [...segmentIds(finalDoc)].filter(id => !startIds.has(id) || kept.has(id));
    const seamTransitions = ranPolish ? (finalDoc.materials?.transitions || []).map(m => m.id)
      : prunedSeams ? [] : (Array.isArray(state.seamTransitions) ? state.seamTransitions : []);
    const next = { version: 1, hash: planHash(plan, profile, finalDoc, wordsFile, templateHashes, projectDir), builtFrom: hash,
      shots: stages.shots?.key || state.shots || null, shotOutputs, outputs, at: new Date().toISOString(), verdict: gate.verdict,
      // logo pops placed (a later build with none clears them), the stages it could not run (the
      // up-to-date path re-reports them), the polish transitions it owns, and what export gates with
      logos: logoPlan.skipped ? (Number(state.logos) || 0) : logoPlan.logos.length,
      skipped, seamTransitions,
      profile: profileFile ? path.resolve(profileFile) : null, style: plan.style || null };
    fs.writeFileSync(stateFile, stableJson(next));
  }
  return { dryRun, hash, stages, skipped, gate };
}
