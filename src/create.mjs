import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CapcutError, DEFAULT_ROOT, LIVE_FILE_NAMES, PRESET_PARK_GAP_US, assertCapcutClosed,
  clone, listProjects, loadPreset, readJson, resolveProject, stableJson, uuid, localizeMedia,
  requireBinary
} from './core.mjs';
import { assertOrigin } from './origin.mjs';

/**
 * A new project is a literal duplicate of the branded preset with the name changed —
 * exactly what CapCut's own "duplicate" does. Anything cleverer (rebuilding the
 * skeleton, minting fresh ids) produces a project that passes every structural check
 * and still will not open.
 */
export const DEFAULT_TEMPLATE = 'Preset 3';

/** ~94MB of per-project mask cache. Nothing references it; CapCut recreates it. */
const SKIP_COPY = new Set(['matting', '.capcutctl', 'draft_info.BACKUP_prewrite.json']);

export function parseScenes(spec) {
  const out = [];
  // a real A-roll cut is dozens of scenes; accept @file as well as an inline list
  if (typeof spec === 'string' && spec.startsWith('@')) spec = fs.readFileSync(spec.slice(1), 'utf8').trim();
  for (const raw of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const [range, source] = raw.split('@');
    const [a, b] = range.split(':').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      throw new CapcutError(`Bad scene "${raw}". Use START:END in seconds, e.g. 0:6 or 0:6@122.4.`, { code: 'BAD_SCENES', exitCode: 2 });
    }
    const src = source == null ? a : Number(source);
    if (!Number.isFinite(src) || src < 0) throw new CapcutError(`Bad source offset in "${raw}".`, { code: 'BAD_SCENES', exitCode: 2 });
    out.push({ start: Math.round(a * 1e6), duration: Math.round((b - a) * 1e6), source: Math.round(src * 1e6) });
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].start + out[i - 1].duration) {
      throw new CapcutError('Scenes overlap; they must be in order and disjoint.', { code: 'BAD_SCENES', exitCode: 2 });
    }
  }
  return out;
}

export function probeMedia(file) {
  requireBinary('ffprobe', 'reading a media file\'s dimensions and duration');
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', file
    ], { encoding: 'utf8' }).trim().split('\n');
    const [width, height, duration] = [Number(out[0]), Number(out[1]), Number(out[2])];
    if (!width || !height || !duration) throw new Error('incomplete probe');
    return { width, height, duration: Math.round(duration * 1e6) };
  } catch {
    throw new CapcutError(
      `Could not probe ${path.basename(file)} with ffprobe. Pass --width, --height and `
      + '--media-duration (seconds) instead.',
      { code: 'PROBE_FAILED', exitCode: 2 }
    );
  }
}

/**
 * Materialise the bundled skeleton as a throwaway template directory.
 *
 * `--blank` is the documented route for someone building their own style, but it still cloned
 * `Preset 3` for the document SHAPE — so on a machine with no drafts it could not run at all,
 * which is every fresh install. `presets/blank-draft.json` is that shape: a real CapCut draft
 * with its identity, media, materials and segments removed and only the track shells and
 * CapCut-owned defaults left. Nothing is invented here either — it was harvested, then
 * stripped.
 */
function materialiseBlankTemplate() {
  const skeleton = loadPreset('blank-draft');
  const doc = clone(skeleton);
  delete doc.segmentTemplate;
  delete doc.videoMaterialTemplate;
  const timelineId = uuid();
  doc.id = timelineId;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-blank-'));
  const write = (target, value) => {
    fs.mkdirSync(target, { recursive: true });
    for (const file of LIVE_FILE_NAMES) fs.writeFileSync(path.join(target, file), stableJson(value));
  };
  write(dir, doc);
  write(path.join(dir, 'Timelines', timelineId), clone(doc));
  fs.writeFileSync(path.join(dir, 'Timelines', 'project.json'),
    stableJson({ main_timeline_id: timelineId, timelines: [{ id: timelineId }] }));
  return dir;
}

function pickTemplate(root, from, { blank = false } = {}) {
  if (from) return resolveProject(from, root);
  const dir = path.join(root, DEFAULT_TEMPLATE);
  if (fs.existsSync(path.join(dir, 'draft_info.json'))) return dir;
  if (blank) return materialiseBlankTemplate();
  const names = listProjects(root).map(p => p.name || p).slice(0, 8);
  throw new CapcutError(
    `Template "${DEFAULT_TEMPLATE}" not found in ${root}. Pass --from NAME of a draft you already have, or --blank for an empty timeline. Available: ${names.join(', ') || '(none)'}`,
    { code: 'NO_TEMPLATE', exitCode: 2 }
  );
}

function duplicate(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }
  fs.mkdirSync(path.join(to, 'matting'), { recursive: true });
}

/**
 * Document GROUPS, not loose files: the root draft and each timeline, each with its
 * .bak and .tmp mirrors. Every mirror in a group must be written from ONE edited
 * document — editing each file separately mints different ids and the mirrors drift.
 */
function docGroups(projectDir) {
  const dirs = [projectDir];
  const timelines = path.join(projectDir, 'Timelines');
  if (fs.existsSync(timelines)) {
    for (const entry of fs.readdirSync(timelines, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(timelines, entry.name));
    }
  }
  return dirs
    .map(dir => ({ dir, files: LIVE_FILE_NAMES.map(n => path.join(dir, n)).filter(f => fs.existsSync(f)) }))
    .filter(g => g.files.length);
}

/**
 * Root and timeline are separate documents that must receive IDENTICAL ids. A plain
 * uuid() per document silently desynchronises them, so ids come from one pre-drawn
 * pool replayed in the same order for every document.
 */
function idPool() {
  const drawn = [];
  let i = 0;
  return {
    next() { if (i >= drawn.length) drawn.push(uuid()); return drawn[i++]; },
    reset() { i = 0; }
  };
}

const segmentsOf = doc => (doc.tracks || []).flatMap(t => t.segments || []);

/** Slide the preset's own content so it starts at `startUs` (parked leftover, not the video's ending). */
function shiftContent(doc, startUs) {
  const segs = segmentsOf(doc);
  if (!segs.length) return 0;
  const delta = startUs - Math.min(...segs.map(s => s.target_timerange.start));
  if (!delta) return 0;
  for (const s of segs) {
    s.target_timerange.start += delta;
    if (s.render_timerange?.duration) s.render_timerange.start = (s.render_timerange.start || 0) + delta;
  }
  doc.duration = (doc.duration || 0) + delta;
  return delta;
}

const LOOK_KINDS = new Set([
  'common_mask', 'video_effects', 'material_animations',
  'filters', 'adjusts', 'effects', 'chromas', 'hsl'
]);

function pickSegmentTemplate(doc) {
  const all = (doc.tracks || []).filter(t => t.type === 'video').flatMap(t => t.segments || []);
  if (!all.length) throw new CapcutError('Template project has no video segment to model on.', { code: 'NO_TEMPLATE', exitCode: 2 });
  const kind = new Map();
  for (const [k, v] of Object.entries(doc.materials || {})) {
    if (Array.isArray(v)) for (const m of v) if (m?.id) kind.set(m.id, k);
  }
  const clean = s => !(s.extra_material_refs || []).some(r => LOOK_KINDS.has(kind.get(r)));
  const plain = s => s.enable_video_mask === false && s.clip?.scale?.x === 1 && !s.clip?.transform?.x && !s.clip?.transform?.y;
  return all.find(s => plain(s) && clean(s)) || all.find(clean) || all[0];
}

/** Add the new footage to the scenes, on a track in front of the preset's content. */
function parseCanvas(spec) {
  const m = String(spec).match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) throw new CapcutError('--canvas expects WIDTHxHEIGHT, e.g. 1080x1920.', { code: 'BAD_CANVAS', exitCode: 2 });
  const width = Number(m[1]), height = Number(m[2]);
  if (!(width > 0 && height > 0)) throw new CapcutError('--canvas dimensions must be positive.', { exitCode: 2 });
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(width, height);
  return { width, height, ratio: `${width / d}:${height / d}` };
}

function addScenes(doc, mediaPath, probe, scenes, ids, templates = {}) {
  const matTemplate = templates.matTemplate
    || (doc.materials?.videos || []).find(m => m.type === 'video')
    || { type: 'video', crop_scale: 1 };
  const segTemplate = templates.segTemplate || pickSegmentTemplate(doc);
  const kind = new Map();
  for (const bucket of [templates.materials, doc.materials]) {
    for (const [k, v] of Object.entries(bucket || {})) {
      if (Array.isArray(v)) for (const m of v) if (m?.id) kind.set(m.id, k);
    }
  }

  const material = clone(matTemplate);
  material.id = ids.next();
  material.path = mediaPath;
  material.material_name = path.basename(mediaPath);
  material.local_material_id = '';
  material.width = probe.width;
  material.height = probe.height;
  material.duration = probe.duration;
  (doc.materials.videos ||= []).push(material);

  const segments = scenes.map((scene, i) => {
    const segment = clone(segTemplate);
    segment.id = ids.next();
    segment.material_id = material.id;
    segment.target_timerange = { start: scene.start, duration: scene.duration };
    segment.source_timerange = { start: scene.source, duration: scene.duration };
    segment.clip = { scale: { x: 1, y: 1 }, rotation: 0, transform: { x: 0, y: 0 }, flip: { horizontal: false, vertical: false }, alpha: 1 };
    segment.enable_video_mask = false;
    segment.volume = 1;
    segment.speed = 1;
    segment.render_index = 2;
    segment.desc = `scene ${i + 1}`;
    // structure only — never inherit the preset's mask/blur/animation
    segment.extra_material_refs = (segTemplate.extra_material_refs || []).flatMap(ref => {
      const k = kind.get(ref);
      if (!k || LOOK_KINDS.has(k)) return [];
      const copied = clone(
        (doc.materials[k] || []).find(m => m.id === ref)
        || (templates.materials?.[k] || []).find(m => m.id === ref)
      );
      if (!copied) return [];
      copied.id = ids.next();
      if (copied.bind_segment_id) copied.bind_segment_id = segment.id;
      (doc.materials[k] ||= []).push(copied);
      return [copied.id];
    });
    return segment;
  });

  const shell = clone((doc.tracks || []).find(t => t.type === 'video') || { type: 'video' });
  const track = clone(shell);
  Object.assign(track, { id: ids.next(), flag: 2, attribute: 0, name: 'content', segments });
  doc.tracks.push(track);
  doc.tracks.forEach((t, i) => (t.segments || []).forEach(sg => { sg.track_render_index = i; }));
  return doc.tracks.length - 1;
}

function registerDraft(root, projectDir, name, draftId, durationUs) {
  const file = path.join(root, 'root_meta_info.json');
  if (!fs.existsSync(file)) return { registered: false };
  const meta = readJson(file);
  const store = meta.all_draft_store || [];
  const now = Date.now() * 1000;
  const template = store.find(e => e.draft_fold_path?.endsWith(path.sep + DEFAULT_TEMPLATE)) || store[0] || {};
  const entry = {
    ...clone(template),
    draft_name: name,
    draft_fold_path: projectDir,
    draft_root_path: root,
    draft_id: draftId,
    draft_cover: path.join(projectDir, 'draft_cover.jpg'),
    draft_json_file: path.join(projectDir, 'draft_info.json'),
    tm_duration: durationUs,
    tm_draft_create: now,
    tm_draft_modified: now,
    tm_draft_removed: 0
  };
  meta.all_draft_store = store.filter(e => e.draft_fold_path !== projectDir).concat([entry]);
  fs.copyFileSync(file, `${file}.bak_capcutctl`);
  const staged = `${file}.capcutctl-staged`;
  fs.writeFileSync(staged, stableJson(meta));
  readJson(staged);
  fs.renameSync(staged, file);
  return { registered: true };
}

export function createProject(name, options = {}) {
  const root = options.root ? path.resolve(options.root) : DEFAULT_ROOT;
  assertCapcutClosed({ forceRunning: options.forceRunning });
  if (/[/\\]/.test(name)) throw new CapcutError('Project name must not contain path separators.', { exitCode: 2 });

  const projectDir = path.join(root, name);
  if (fs.existsSync(projectDir)) {
    throw new CapcutError(`${projectDir} already exists. Pick another name or delete it first.`, { code: 'PROJECT_EXISTS', exitCode: 2 });
  }
  const templateDir = pickTemplate(root, options.from, { blank: Boolean(options.blank) });

  let probe = null;
  let scenes = [];
  if (options.media) {
    const media = path.resolve(options.media);
    if (!fs.existsSync(media)) throw new CapcutError(`Media not found: ${media}`, { code: 'MISSING_SOURCE', exitCode: 2 });
    probe = (options.width && options.height && options.duration)
      ? { width: Number(options.width), height: Number(options.height), duration: Math.round(Number(options.duration) * 1e6) }
      : probeMedia(media);
    scenes = options.scenes ? parseScenes(options.scenes) : [{ start: 0, duration: probe.duration, source: 0 }];
    for (const s of scenes) {
      if (s.source + s.duration > probe.duration) {
        throw new CapcutError(
          `Scene at ${s.start / 1e6}s reads source ${s.source / 1e6}..${(s.source + s.duration) / 1e6}s but the media is only ${(probe.duration / 1e6).toFixed(2)}s long.`,
          { code: 'BAD_SCENES', exitCode: 2 }
        );
      }
    }
    // The talking head is the timeline's clock; a pre-framed or scratchpad A-roll poisons every
    // scene hung off it. Same contract as clip.add, checked before the draft is registered.
    // The canvas is not built yet, so use the requested one (or the 1080x1920 default).
    const [cw, ch] = String(options.canvas || '1080x1920').split('x').map(Number);
    assertOrigin({
      file: media, width: probe.width, height: probe.height,
      canvas: [cw || 1080, ch || 1920], label: 'new --media', projectDir,
      generated: options.generated === true, derivedFrom: options.derivedFrom || null,
      derivedOffset: options.derivedOffset, allowEphemeral: options.allowEphemeral === true,
    });
    options.media = media;
  }

  if (options.newTimelineId) {
    throw new CapcutError(
      '--new-timeline-id is not supported: CapCut will not open a project whose draft id does not match the timeline folder.',
      { code: 'UNSUPPORTED_FLAG', exitCode: 2 });
  }
  const canvas = options.canvas ? parseCanvas(options.canvas) : null;
  const fps = options.fps != null ? Number(options.fps) : null;
  if (fps != null && !(fps > 0)) throw new CapcutError('--fps must be positive.', { exitCode: 2 });

  if (options.dryRun) {
    return {
      project: projectDir, template: templateDir, media: options.media || null, created: false, dryRun: true,
      blank: Boolean(options.blank), canvas, fps,
      scenes: scenes.map(s => ({ start: s.start / 1e6, end: (s.start + s.duration) / 1e6, source: s.source / 1e6 }))
    };
  }

  duplicate(templateDir, projectDir);
  try {
    if (options.media && options.localize !== false) {
      options.media = localizeMedia(projectDir, options.media);
    }
    return finishCreate(projectDir, { name, root, templateDir, options, probe, scenes, canvas, fps });
  } catch (error) {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function finishCreate(projectDir, { name, root, templateDir, options, probe, scenes, canvas, fps }) {
  const contentUs = scenes.length ? Math.max(...scenes.map(s => s.start + s.duration)) : 0;
  let contentTrack = null;
  let shifted = 0;
  let durationUs = 0;
  const ids = idPool();
  const staged = [];
  const transactionId = uuid();
  for (const group of docGroups(projectDir)) {
    const doc = readJson(group.files[0]);
    doc.name = name;
    // Capture templates BEFORE --blank wipes them. --blank --media used to empty
    // every video segment and then die in pickSegmentTemplate, leaving the folder.
    const templates = {};
    try {
      templates.segTemplate = clone(pickSegmentTemplate(doc));
      templates.matTemplate = clone((doc.materials?.videos || []).find(m => m.type === 'video') || { type: 'video', crop_scale: 1 });
      templates.materials = clone(doc.materials || {});
    } catch {
      // The bundled skeleton has no segments to model on — it carries the two templates
      // explicitly instead, harvested from a real draft the same way. Without this,
      // `new --blank --media … --scenes …` on a machine with no drafts died here.
      const skeleton = loadPreset('blank-draft');
      if (skeleton?.segmentTemplate && skeleton?.videoMaterialTemplate) {
        templates.segTemplate = clone(skeleton.segmentTemplate);
        templates.matTemplate = clone(skeleton.videoMaterialTemplate);
        templates.materials = clone(doc.materials || {});
      } else if (scenes.length) {
        throw new CapcutError('Template project has no video segment to model on.', { code: 'NO_TEMPLATE', exitCode: 2 });
      }
    }
    if (options.blank) {
      const main = (doc.tracks || []).filter(t => t.flag === 0).map(t => ({ ...clone(t), segments: [] }));
      const overlayShell = (doc.tracks || []).find(t => t.type === 'video' && t.flag === 2)
        || (doc.tracks || []).find(t => t.type === 'video');
      // Only keep an empty overlay lane when nothing else will make one. `addScenes` always
      // pushes its own track called 'content', so keeping this shell too left every --blank
      // project with a stray empty 'content' lane sitting above the real one in CapCut.
      const overlay = overlayShell && !scenes.length
        ? [{ ...clone(overlayShell), segments: [], flag: 2, attribute: 0, name: overlayShell.name || 'content' }]
        : [];
      doc.tracks = [...main, ...overlay];
      doc.materials = Object.fromEntries(Object.entries(doc.materials || {}).map(([k, v]) => [k, Array.isArray(v) ? [] : v]));
      doc.duration = 0;
    }
    if (scenes.length) {
      if (!options.blank) shifted = shiftContent(doc, contentUs + PRESET_PARK_GAP_US);
      ids.reset();
      contentTrack = addScenes(doc, options.media, probe, scenes, ids, templates);
      doc.duration = Math.max(doc.duration || 0, contentUs);
    }
    if (canvas) {
      doc.canvas_config = { ...(doc.canvas_config || {}), width: canvas.width, height: canvas.height, ratio: canvas.ratio };
    }
    if (fps != null) doc.fps = fps;
    durationUs = doc.duration || 0;
    const text = stableJson(doc);
    for (const file of group.files) {
      const temp = `${file}.capcutctl-${transactionId}.tmp`;
      fs.writeFileSync(temp, text);
      readJson(temp);
      staged.push({ temp, file });
    }
  }
  for (const item of staged) fs.renameSync(item.temp, item.file);

  const metaFile = path.join(projectDir, 'draft_meta_info.json');
  const draftId = uuid();
  if (fs.existsSync(metaFile)) {
    const meta = readJson(metaFile);
    const now = Date.now() * 1000;
    Object.assign(meta, {
      draft_name: name,
      draft_fold_path: projectDir,
      draft_root_path: root,
      draft_id: draftId,
      tm_duration: durationUs,
      tm_draft_create: now,
      tm_draft_modified: now,
      tm_draft_removed: 0
    });
    if (options.media && Array.isArray(meta.draft_materials)) {
      const bucket = meta.draft_materials.find(b => b.type === 0);
      const sample = bucket?.value?.find(v => v.metetype === 'video');
      if (bucket && !bucket.value.some(v => v.file_Path === options.media)) {
        bucket.value.push({
          ...(sample ? clone(sample) : {}),
          duration: probe.duration, extra_info: path.basename(options.media), file_Path: options.media,
          height: probe.height, width: probe.width, id: uuid().toLowerCase(), metetype: 'video',
          roughcut_time_range: { duration: probe.duration, start: 0 }, sub_time_range: { duration: -1, start: -1 },
          md5: '', material_color_tag: '', type: 0
        });
      }
    }
    const stagedMeta = `${metaFile}.capcutctl-staged`;
    fs.writeFileSync(stagedMeta, stableJson(meta));
    readJson(stagedMeta);
    fs.renameSync(stagedMeta, metaFile);
  }

  fs.mkdirSync(path.join(projectDir, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.capcutctl', 'created.json'), stableJson({
    template: path.basename(templateDir),
    contentTrack,
    preserved: scenes.length && !options.blank
      ? { start: contentUs + PRESET_PARK_GAP_US, end: durationUs }
      : null,
    contentEnd: scenes.length ? contentUs : null
  }));

  const registration = registerDraft(root, projectDir, name, draftId, durationUs);
  return {
    project: projectDir,
    template: templateDir,
    media: options.media || null,
    contentTrack,
    scenes: scenes.map(s => ({ start: s.start / 1e6, end: (s.start + s.duration) / 1e6, source: s.source / 1e6 })),
    carriedOver: options.blank ? 'none (--blank)' : `preset content shifted by ${(shifted / 1e6).toFixed(3)}s`,
    duration: durationUs / 1e6,
    canvas: canvas || null,
    fps: fps || null,
    created: true,
    ...registration
  };
}

/**
 * Delete a draft the way CapCut does: move it to .recycle_bin and drop its registry
 * entry. Doing this by hand means `rm -rf` plus a hand-edited root_meta_info.json —
 * unrecoverable, and one slip corrupts the whole draft library.
 */
export function removeProject(name, options = {}) {
  const root = options.root ? path.resolve(options.root) : DEFAULT_ROOT;
  assertCapcutClosed({ forceRunning: options.forceRunning });
  const projectDir = resolveProject(name, root);
  const label = path.basename(projectDir);
  if (path.resolve(projectDir) === path.resolve(root)) {
    throw new CapcutError('refusing to remove the drafts root itself.', { exitCode: 2 });
  }

  const bin = path.join(root, '.recycle_bin');
  let dest = path.join(bin, label);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(bin, `${label} (${n})`);

  const registry = path.join(root, 'root_meta_info.json');
  let removedEntries = 0;
  if (!options.dryRun) {
    fs.mkdirSync(bin, { recursive: true });
    fs.renameSync(projectDir, dest);
  }
  if (fs.existsSync(registry)) {
    const meta = readJson(registry);
    const before = (meta.all_draft_store || []).length;
    meta.all_draft_store = (meta.all_draft_store || [])
      .filter(e => path.resolve(e.draft_fold_path || '') !== path.resolve(projectDir));
    removedEntries = before - meta.all_draft_store.length;
    if (!options.dryRun && removedEntries) {
      fs.copyFileSync(registry, `${registry}.bak_capcutctl`);
      const staged = `${registry}.capcutctl-staged`;
      fs.writeFileSync(staged, stableJson(meta));
      readJson(staged);
      fs.renameSync(staged, registry);
    }
  }
  return { removed: projectDir, recycled: dest, registryEntriesRemoved: removedEntries,
           dryRun: Boolean(options.dryRun), restore: `mv "${dest}" "${projectDir}"` };
}
