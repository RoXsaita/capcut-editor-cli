/**
 * `build` — one edit plan in, a finished editable project out.
 *
 * After the talking head is signed off, everything else is mechanical: the agent writes only
 * the judgement (which shots, which words deserve a graphic, which brands, the CTA, the music
 * brief) into an `edit.json`, and `build` compiles it into the existing operations in a fixed
 * order, with the profile's defaults filling every gap:
 *
 *   picture   reviewed shots (once) → layout auto → camera (stress pushes, optional reframe/cursor)
 *   graphics  mograph renders placed on their words → logo pops (or a brand-chip when the art is
 *             missing) → endcard
 *   sound     motivated seams + SFX → music bed aligned to the graphics and picture changes →
 *             duck under speech → loudness
 *   gate      the blocking ready-to-post check
 *
 * Every stage owns its output (mograph:*, sig:*, polish:*, finish:music), so running `build`
 * again replaces rather than stacks. Graphics are anchored to SOURCE WORDS: after a recut the
 * same plan lands every graphic on its word again, or refuses by name when a word was cut.
 * An unchanged plan on an unchanged cut is a no-op (`.capcutctl/build.json` holds its hash).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CapcutError, applySpec, loadProject, readJson } from './core.mjs';
import { findWordsFile, resolveAnchors } from './anchors.mjs';
import { layoutAt } from './mograph-place.mjs';
import { safeZoneViolations } from './mograph-geometry.mjs';
import { loadProfile } from './profile.mjs';
import { principalTrack, pictureChanges } from './polish.mjs';
import { firstPictureProof } from './finish.mjs';
import { gateReport, writeGateRecord } from './gate.mjs';

export const EDIT_PLAN_VERSION = 1;
const r3 = n => Math.round(n * 1000) / 1000;

const fail = (code, message, details) => { throw new CapcutError(message, { code, exitCode: 2, details }); };

function workingDoc(projectDir) {
  const state = loadProject(projectDir);
  const group = state.groups.find(g => g.name.startsWith('timeline:')) || state.groups[0];
  return group.doc;
}

/** Validate and normalise an edit plan. Unknown top-level keys refuse, so a typo is not silently ignored. */
export function normalizePlan(raw, { baseDir = process.cwd() } = {}) {
  if (!raw || typeof raw !== 'object') fail('PLAN_INVALID', 'edit plan must be a JSON object');
  if (raw.version !== EDIT_PLAN_VERSION) fail('PLAN_VERSION', `edit plan version must be ${EDIT_PLAN_VERSION}`);
  const known = new Set(['version', 'profile', 'words', 'shots', 'layout', 'camera', 'graphics', 'logos', 'endcard', 'sound', 'notes']);
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
  const ids = graphics.map(g => g.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) fail('PLAN_INVALID', `duplicate graphic id "${dup}"`);
  const sound = { seams: 'motivated', music: false, duck: true, loudness: true, ...(raw.sound || {}) };
  if (sound.music && typeof sound.music === 'object' && sound.music.file) sound.music = { ...sound.music, file: abs(sound.music.file) };
  return {
    version: EDIT_PLAN_VERSION,
    profile: abs(raw.profile),
    words: abs(raw.words),
    shots: abs(raw.shots),
    layout: raw.layout === undefined ? 'auto' : raw.layout,
    camera: { stress: true, reframe: false, cursor: false, ...(raw.camera || {}) },
    graphics,
    logos: raw.logos === undefined ? 'auto' : raw.logos,
    endcard: raw.endcard === undefined ? null : raw.endcard,
    sound,
  };
}

export function readEditPlan(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) fail('PLAN_MISSING', `no such edit plan: ${resolved}`);
  return normalizePlan(readJson(resolved), { baseDir: path.dirname(resolved) });
}

function principalSignature(doc) {
  const { track } = principalTrack(doc);
  return (track.segments || []).map(s => [s.material_id, s.source_timerange?.start, s.source_timerange?.duration,
    s.target_timerange?.start, s.target_timerange?.duration].join(':')).join('|');
}

function planHash(plan, profile, doc, wordsFile, templateHashes) {
  let wordsStamp = null;
  if (wordsFile && fs.existsSync(wordsFile)) { const st = fs.statSync(wordsFile); wordsStamp = `${st.size}:${st.mtimeMs}`; }
  return crypto.createHash('sha256').update(JSON.stringify({
    plan, profile, principal: principalSignature(doc), wordsStamp, templateHashes,
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

function writeSidecars(graphics) {
  for (const g of graphics) {
    const r = g.rendered;
    fs.mkdirSync(path.dirname(g.sidecarFile), { recursive: true });
    fs.writeFileSync(g.sidecarFile, `${JSON.stringify({
      version: 1, id: g.id, template: g.template, params: g.params, format: g.format, file: r.file, box: r.box,
      meta: r.meta, fingerprint: g.fingerprint, anchor: g.anchor || null, at: g.at, duration: g.duration,
      importVerified: g.format === 'png-still',
    }, null, 2)}\n`);
  }
}

/**
 * Compile and apply. Returns { upToDate?, stages, gate }. `dryRun` validates every stage and
 * writes nothing (renders are probed, not encoded).
 */
export async function runBuild(projectDir, plan, { dryRun = false, force = false, forceRunning = false, backup = true, record = true } = {}) {
  const profile = loadProfile({ file: plan.profile || null });
  const mograph = await import('./mograph.mjs');
  const templates = mograph.listTemplates();
  const txn = label => ({ dryRun, forceRunning, backup, label });
  let doc = workingDoc(projectDir);
  principalTrack(doc);                                     // refuses a project with no talking head
  const wordsFile = plan.words || findWordsFile(doc);
  const templateHashes = Object.fromEntries(templates.map(t => [t.id, mograph.fingerprint(t.id, {}, profile)]));
  const hash = planHash(plan, profile, doc, wordsFile, templateHashes);
  const stateFile = path.join(projectDir, '.capcutctl', 'build.json');
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : {};
  if (!force && !dryRun && state.hash === hash) {
    const gate = gateReport(doc, { projectDir, profile });
    return { upToDate: true, hash, gate };
  }
  const stages = {};

  // ---- picture: shots (once), layout, camera ------------------------------------------------
  const pictureOps = [];
  if (plan.shots) {
    const shotsKey = crypto.createHash('sha256').update(fs.readFileSync(plan.shots)).digest('hex').slice(0, 16);
    if (state.shots !== shotsKey) {
      const matcher = await import('./match.mjs');
      const spec = matcher.shotsToSpec(matcher.readShotsFile(plan.shots), {});
      const check = matcher.writersAccept(spec.operations);
      if (!check.ok) fail('UNSUPPORTED_OPERATION', 'shots emit ops the writers do not accept', check.rejected);
      pictureOps.push(...spec.operations);
      stages.shots = { applied: spec.operations.length, key: shotsKey };
    } else stages.shots = { applied: 0, reason: 'already applied (change shots with match/replace-media, or restore a snapshot)' };
  }
  if (pictureOps.length) {
    stages.shotsResult = applySpec(projectDir, { version: 1, name: 'build-shots', operations: pictureOps }, txn('build-shots'));
    if (!dryRun) doc = workingDoc(projectDir);
  }
  const cameraOps = [];
  if (plan.layout === 'auto') {
    const { buildLayoutSpec } = await import('./layouts.mjs');
    try { cameraOps.push(...buildLayoutSpec(projectDir, 'auto', {}).operations); }
    catch (error) { stages.layout = { skipped: error.message }; }
  }
  if (plan.camera.reframe) cameraOps.push({ op: 'reframe', auto: true });
  if (plan.camera.cursor) cameraOps.push({ op: 'cursor', auto: true });
  if (plan.camera.stress) {
    const stressOp = { op: 'zoom.stress', ease: profile.camera.ease, ...(wordsFile ? { wordsFile } : {}) };
    try {
      applySpec(projectDir, { version: 1, name: 'build-stress-check', operations: [stressOp] }, { ...txn('check'), dryRun: true });
      cameraOps.push(stressOp);
    } catch (error) { stages.stress = { skipped: error.message.split('\n')[0] }; }
  }
  if (cameraOps.length) {
    stages.picture = applySpec(projectDir, { version: 1, name: 'build-picture', operations: cameraOps }, txn('build-picture'));
    if (!dryRun) doc = workingDoc(projectDir);
  }

  // ---- graphics -------------------------------------------------------------------------------
  const logoPlan = await planLogos(plan, doc, wordsFile, templates);
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
  const rendered = await renderGraphics(projectDir, graphics, { dryRun, profile });
  for (const g of rendered) g.duration = r3(g.rendered.meta.duration);
  const graphicOps = [{ op: 'mograph.prune', keep: rendered.map(g => g.id) }];
  for (const g of rendered) {
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
  if (Object.keys(signature).length) {
    graphicOps.push({ op: 'signature', ease: true, glow: (profile.logo?.reveal === 'glow'), ...signature });
  }
  const planned = rendered.map(g => ({ id: g.id, template: g.template, at: g.at, duration: g.duration, format: g.format,
    box: g.rendered.box, anchor: g.anchor || null, cached: Boolean(g.rendered.cached) }));
  // A dry run has only probed the renders, so their files do not exist yet: validate everything
  // else in the stage and report the placements it would make.
  const applied = dryRun ? graphicOps.filter(op => op.op !== 'mograph.place') : graphicOps;
  stages.graphics = { planned, signature: Object.keys(signature).length ? signature : null,
    result: applySpec(projectDir, { version: 1, name: 'build-graphics', operations: applied }, txn('build-graphics')) };
  if (logoPlan.missingArt?.length) stages.logosMissingArt = logoPlan.missingArt;
  if (!dryRun) { writeSidecars(rendered); doc = workingDoc(projectDir); }

  // ---- sound ----------------------------------------------------------------------------------
  const soundOps = [];
  if (plan.sound.seams) {
    if (firstPictureProof(doc).ok) soundOps.push({ op: 'polish', motivated: plan.sound.seams !== 'all' });
    else stages.seams = { skipped: 'first picture is not proof; fix the opening, then rebuild' };
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
    stages.music = { file: prepared.file, hits: prepared.hits, offset: off, wouldGenerate: prepared.wouldGenerate || false };
    if (!dryRun) {
      soundOps.push({ op: 'music', file: prepared.file, duration: prepared.duration, volume: prepared.volume,
        srcOffset: off < 0 ? -off : 0, at: off > 0 ? off : 0, fadeIn: 0.4, fadeOut: 1.2 });
      if (plan.sound.duck && profile.sound.duck) soundOps.push({ op: 'music', duck: true, ...(wordsFile ? { wordsFile } : {}) });
    }
  }
  if (plan.sound.loudness) soundOps.push({ op: 'loudness', target: profile.sound.loudnessTarget, peak: profile.sound.peak });
  if (soundOps.length) {
    try {
      stages.sound = applySpec(projectDir, { version: 1, name: 'build-sound', operations: soundOps }, txn('build-sound'));
    } catch (error) {
      // Loudness refuses a mix it cannot make safe; the rest of the sound stage still stands.
      if (!soundOps.some(op => op.op === 'loudness')) throw error;
      const rest = soundOps.filter(op => op.op !== 'loudness');
      stages.sound = rest.length
        ? applySpec(projectDir, { version: 1, name: 'build-sound', operations: rest }, txn('build-sound'))
        : null;
      stages.loudness = { skipped: error.message.split('\n')[0] };
    }
    if (!dryRun) doc = workingDoc(projectDir);
  }

  // ---- gate -----------------------------------------------------------------------------------
  const gate = gateReport(doc, { projectDir, profile });
  if (!dryRun) {
    if (record) writeGateRecord(projectDir, gate);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const next = { version: 1, hash: planHash(plan, profile, workingDoc(projectDir), wordsFile, templateHashes), builtFrom: hash,
      shots: stages.shots?.key || state.shots || null, at: new Date().toISOString(), verdict: gate.verdict };
    fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { dryRun, hash, stages, gate };
}
