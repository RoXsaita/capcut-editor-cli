/**
 * `mograph.place` — put an already-rendered motion graphic on the timeline.
 *
 * Rendering happens before the transaction (it needs a browser); this op only edits the draft,
 * so it is deterministic, dry-runnable and rolled back like every other op. It owns its output
 * by desc: `mograph:<id>` for the picture and `mograph:sfx:<id>` for its paired cue, so placing
 * the same id again replaces it instead of stacking a second copy.
 *
 * A scene (mograph/scenes) is placed the same way with a full-canvas box and `clipVolume: 1`:
 * its synthesised sound is inside the clip, so it has no separate cue on `mograph-sfx`.
 *
 * Picture: a ProRes 4444 clip goes through `clip.add` with the `--generated` origin (a graphic
 * has no editable original to relink), scaled and positioned so the rendered box lands on the
 * exact canvas pixels the template drew it at. A `png-still` becomes a native photo clip with an
 * eased pop, so it stays a CapCut property the editor can retime.
 *
 * Lanes: graphics sit on `mograph-N` video tracks at the top of the stack, above the face and
 * the layout plates. The first lane with room is reused; a clash opens the next lane.
 */
import path from 'node:path';
import { CapcutError, seededId } from './core.mjs';
import { opClipAdd } from './add.mjs';
import { insertOverlayTrack, layoutAudit, renumberTracks } from './layouts.mjs';
import { audioSegment, ensureAudio, ensureAudioTrack, sfxPresets, unavailableSfx } from './polish.mjs';
import { placeStill } from './signature.mjs';
import { placementFor } from './mograph-geometry.mjs';
import { loadProfile } from './profile.mjs';

const US = s => Math.round(Number(s) * 1e6);
const S = us => (us || 0) / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;
export const MOGRAPH_LANE = /^mograph-\d+$/;
export const MOGRAPH_SFX_LANE = 'mograph-sfx';

export const mographDesc = id => `mograph:${id}`;
export const mographSfxDesc = id => `mograph:sfx:${id}`;

/** Which look the principal track has at time t: full-face, split-screen or card (circle). */
export function layoutAt(doc, t) {
  let rows = [];
  try { rows = layoutAudit(doc); } catch { return 'full-face'; }
  const row = rows.find(r => t >= r.at && t < r.end) || rows.at(-1);
  if (!row) return 'full-face';
  return row.is === 'circle' ? 'card' : row.is;
}

function removeOwned(doc, id) {
  const descs = new Set([mographDesc(id), mographSfxDesc(id)]);
  const orphaned = new Set();
  for (const track of doc.tracks) {
    for (const s of track.segments || []) {
      if (!descs.has(s.desc || '')) continue;
      if (s.material_id) orphaned.add(s.material_id);
      for (const r of s.extra_material_refs || []) orphaned.add(r);
    }
    track.segments = (track.segments || []).filter(s => !descs.has(s.desc || ''));
  }
  const live = new Set();
  for (const track of doc.tracks) {
    for (const s of track.segments || []) {
      if (s.material_id) live.add(s.material_id);
      for (const r of s.extra_material_refs || []) live.add(r);
    }
  }
  for (const [kind, list] of Object.entries(doc.materials || {})) {
    if (!Array.isArray(list)) continue;
    doc.materials[kind] = list.filter(m => !m || !orphaned.has(m.id) || live.has(m.id));
  }
  doc.tracks = doc.tracks.filter(t => !(MOGRAPH_LANE.test(t.name || '') || t.name === MOGRAPH_SFX_LANE) || (t.segments || []).length);
  return orphaned.size > 0;
}

function freeLane(doc, atUs, durUs, mint) {
  const lanes = doc.tracks.filter(t => t.type === 'video' && MOGRAPH_LANE.test(t.name || ''));
  for (const lane of lanes) {
    const clash = (lane.segments || []).some(s => s.target_timerange.start < atUs + durUs
      && s.target_timerange.start + s.target_timerange.duration > atUs);
    if (!clash) return lane.name;
  }
  const name = `mograph-${lanes.length + 1}`;
  const track = insertOverlayTrack(doc, doc.tracks.length, mint(`track:${name}`));
  track.name = name;
  return name;
}

export function opMographPlace(doc, op, context = {}) {
  const seed = op.__seed || null;
  const mint = key => seededId(seed, `mograph:${op.id}:${key}`);
  for (const key of ['id', 'file', 'format']) {
    if (!op[key]) throw new CapcutError(`mograph.place requires ${key}.`, { code: 'MOGRAPH_PLACE', exitCode: 2 });
  }
  if (!/^[\w.-]{1,80}$/.test(op.id)) throw new CapcutError('mograph.place: id must be alphanumeric (._- allowed).', { code: 'MOGRAPH_PLACE', exitCode: 2 });
  const box = op.box;
  if (!box || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) {
    throw new CapcutError('mograph.place requires box {x,y,w,h} in canvas pixels.', { code: 'MOGRAPH_PLACE', exitCode: 2 });
  }
  const at = Number(op.at), duration = Number(op.duration);
  if (!(at >= 0) || !(duration > 0)) throw new CapcutError('mograph.place: bad at/duration.', { code: 'BAD_TIME', exitCode: 2 });
  const replaced = removeOwned(doc, op.id);
  const cc = doc.canvas_config || { width: 1080, height: 1920 };
  const geo = placementFor(box, { width: cc.width || 1080, height: cc.height || 1920 }, op.renderScale || 1);
  const atUs = US(at), durUs = US(duration);
  const lane = freeLane(doc, atUs, durUs, mint);

  let segment;
  if (op.format === 'png-still') {
    segment = placeStill(doc, {
      key: `mograph:${op.id}`, seed, file: path.resolve(op.file), width: geo.width, height: geo.height,
      at, hold: duration, scale: geo.scale, pos: [geo.x, geo.y], desc: mographDesc(op.id), trackName: lane,
    });
    const material = (doc.materials.videos || []).find(m => m.id === segment.material_id);
    if (material) {
      material.capcutctl_mograph = { template: op.template || null, fingerprint: op.fingerprint || null,
        importVerified: true, box, still: true };
    }
  } else if (op.format === 'prores') {
    const added = opClipAdd(doc, {
      op: 'clip.add', media: path.resolve(op.file), at, duration, track: lane, generated: true,
      width: geo.width, height: geo.height, mediaDuration: durUs, volume: op.clipVolume ?? 0, desc: mographDesc(op.id),
      forceNewMaterial: true, materialId: mint('material'), id: mint('segment'), __seed: seed,
    }, context);
    segment = doc.tracks.flatMap(t => t.segments || []).find(s => s.id === added.id);
    segment.clip.scale = { x: geo.scale, y: geo.scale };
    segment.clip.transform = { x: geo.x, y: geo.y };
    const material = (doc.materials.videos || []).find(m => m.id === segment.material_id);
    if (material) {
      material.capcutctl_mograph = { template: op.template || null, fingerprint: op.fingerprint || null,
        importVerified: op.importVerified === true, box,
        ...(String(op.template || '').startsWith('scene:') ? { scene: true } : {}) };
    }
  } else {
    throw new CapcutError(`mograph.place: format ${op.format} cannot be placed in CapCut (use prores or png-still).`,
      { code: 'MOGRAPH_FORMAT', exitCode: 2 });
  }

  // The paired cue. Graphics lead their word; the sound lands on the graphic's first frame
  // unless the op carries its own lead. Missing SFX on this machine is reported, not faked.
  let sfx = null;
  if (op.sfx && op.noSfx !== true) {
    const presets = sfxPresets();
    const name = presets.accents?.[op.sfx] || op.sfx;
    const audioId = presets.audioTemplates?.[name] ? ensureAudio(doc, name, key => mint(`sfx:${key}`)) : null;
    if (audioId) {
      const tpl = presets.audioTemplates[name];
      const lead = op.sfxLead ?? 0;
      const len = Math.min(S(tpl.duration || US(0.5)), 1.2, duration + lead);
      const lane = ensureAudioTrack(doc, MOGRAPH_SFX_LANE, key => mint(key));
      const volume = op.sfxVolume ?? presets.rules?.volume ?? 1;
      lane.segments.push(audioSegment(doc, audioId, Math.max(0, at - lead), len, `mograph:${op.id}:sfx`, volume,
        mographSfxDesc(op.id), key => mint(key)));
      lane.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
      sfx = { name, at: r3(Math.max(0, at - lead)) };
    } else {
      sfx = { name, unavailable: true };
    }
  }
  renumberTracks(doc);
  if (atUs + durUs > (doc.duration || 0)) doc.duration = atUs + durUs;
  const profile = loadProfile();
  return {
    changed: 1,
    id: op.id,
    template: op.template || null,
    format: op.format,
    lane,
    at: r3(at),
    duration: r3(duration),
    box,
    scale: r3(geo.scale),
    transform: { x: r3(geo.x), y: r3(geo.y) },
    replaced,
    sfx,
    ...(sfx?.unavailable ? { unavailableSfx: unavailableSfx() } : {}),
    importVerified: op.importVerified === true,
    fps: profile.canvas.fps,
  };
}

/** Remove every placed graphic whose id is not in `keep` — so a rebuild drops graphics the plan no longer names. */
export function opMographPrune(doc, op = {}) {
  const keep = new Set(op.keep || []);
  const ids = new Set();
  for (const track of doc.tracks) {
    for (const s of track.segments || []) {
      const m = /^mograph:(?:sfx:)?(.+)$/.exec(s.desc || '');
      if (m && !keep.has(m[1])) ids.add(m[1]);
    }
  }
  for (const id of ids) removeOwned(doc, id);
  if (ids.size) renumberTracks(doc);
  return { changed: ids.size, removed: [...ids].sort() };
}
