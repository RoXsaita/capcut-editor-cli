import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CapcutError, allSegments, loadPreset, seededId, localizeMedia, principalEndUs, resolveMediaPath, removeUnreferencedMaterials } from './core.mjs';
import { principalTrack } from './polish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (code, message) => { throw new CapcutError(`${code}: ${message}`, {code}); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const CAPTION_FONT = {path:path.join(ROOT, 'tools/caption_engine/fonts/Changa-ExtraBold.ttf'), name:'Changa ExtraBold'};

// Logical Unicode only. CapCut, not a manual bidi pre-pass, shapes native text.
export function captionDisplayText(text, language = 'ar') {
  if (!['ar', 'fa', 'ur'].includes(language.split('-')[0])) return text.normalize('NFC');
  // A Latin word keeps Western digits: "GPT-5", never "GPT-٥".
  return text.normalize('NFC').split(/(\s+)/).map(word => /[a-z]/i.test(word) ? word
    : word.replace(/[0-9]/g, n => '٠١٢٣٤٥٦٧٨٩'[Number(n)]).replace(/%/g, '٪')).join('')
    .replace(/[\u064b-\u065f\u0670]/g, '');
}
function ownedDigest(doc, track) {
  const ids = new Set(track.segments.map(s => s.material_id));
  const clean = structuredClone(track);
  for (const s of clean.segments) s.desc = '';
  return hash({track:clean, texts:(doc.materials.texts || []).filter(m => ids.has(m.id))});
}

// Measured in a native export: size 15 drew a word 49px tall on a 1080x1920 canvas, so the
// 90px target is about 28.
const NATIVE_SIZE = 28;

/** The one caption style: white Changa ExtraBold, size 28, thin black stroke. Text is kept. */
export function houseStyle(mat, text, fontPath = CAPTION_FONT.path) {
  const style = {
    fill:{alpha:1,content:{render_type:'solid',solid:{alpha:1,color:[1,1,1]}}},
    font:{id:'',path:fontPath},range:[0,text.length],size:NATIVE_SIZE,
    strokes:[{content:{solid:{alpha:1,color:[0,0,0]}},width:4/90}],
  };
  Object.assign(mat, {content:JSON.stringify({styles:[style],text}),font_name:CAPTION_FONT.name,font_title:CAPTION_FONT.name,
    font_path:fontPath,font_size:NATIVE_SIZE,check_flag:15,alignment:1,has_shadow:false,background_style:0,
    border_color:'#000000',border_width:4/90,border_alpha:1,text_color:'#FFFFFF'});
}

/**
 * Put every word already on a captions:* track into the house style — the fix for drafts made
 * before 2026-10-11, when English words were set in Arial Unicode. Text, timing and position
 * stay exactly as they are (hand corrections included); only the look changes.
 */
/**
 * Caption tracks, whoever wrote them: `captions` (captions:NAME), the older SRT `caption` op
 * (a text track named captions… by default) and CapCut's own auto-captions (subtitle text).
 */
export function isCaptionTrack(doc, track) {
  if (track.type !== 'text') return false;
  if ((track.name || '').startsWith('captions')) return true;
  const subtitles = new Set((doc.materials?.texts || []).filter(m => m.type === 'subtitle').map(m => m.id));
  return (track.segments || []).some(s => subtitles.has(s.material_id));
}

/** What wrote a caption track: this command (captions:NAME), CapCut's auto-captions, or an SRT import. */
function captionTrackKind(doc, track) {
  if ((track.name || '').startsWith('captions:')) return 'captions';
  const subtitles = new Set((doc.materials?.texts || []).filter(m => m.type === 'subtitle').map(m => m.id));
  return (track.segments || []).some(s => subtitles.has(s.material_id)) ? 'subtitle' : 'srt';
}

function captionTrackList(doc, tracks) {
  return tracks.map(t => `${t.name || '(unnamed)'} (${captionTrackKind(doc, t)}, ${(t.segments || []).length} words)`).join(', ');
}

/** Splice caption tracks out and drop the text materials nothing else uses. */
function removeCaptionTracks(doc, tracks) {
  const gone = new Set(tracks);
  const ids = new Set(tracks.flatMap(t => (t.segments || []).flatMap(s => [s.material_id, ...(s.extra_material_refs || [])])).filter(Boolean));
  const removed = tracks.map(t => ({ name: t.name || '(unnamed)', kind: captionTrackKind(doc, t), words: (t.segments || []).length }));
  doc.tracks = doc.tracks.filter(t => !gone.has(t));
  removeUnreferencedMaterials(doc, ids);
  return removed;
}

export function opCaptionsRestyle(doc, op, context = {}) {
  if (!fs.existsSync(CAPTION_FONT.path)) fail('CAPTION_FONT_MISSING', CAPTION_FONT.path);
  const localized = context.projectDir ? localizeMedia(context.projectDir,CAPTION_FONT.path,undefined,{dryRun:context.dryRun}) : CAPTION_FONT.path;
  const segments = doc.tracks.filter(t => isCaptionTrack(doc, t)).flatMap(t => t.segments);
  const ids = new Set(segments.map(s => s.material_id));
  if (!ids.size) fail('CAPTION_NONE', 'No caption track to restyle.');
  // CapCut re-saves font paths as its ##_draftpath_placeholder_…## form; reuse the form this
  // draft already has for the Changa file so words already in style stay byte-identical.
  const same = p => p && (p === localized || (context.projectDir && resolveMediaPath(p, context.projectDir) === localized));
  const fontPath = (doc.materials.texts || []).map(m => m.font_path).find(same) || localized;
  let changed = 0;
  // A word scaled in CapCut's canvas draws at another size whatever its font size says.
  for (const seg of segments) {
    const scale = seg.clip?.scale;
    if (scale && (scale.x !== 1 || scale.y !== 1)) { seg.clip.scale = {x:1, y:1}; changed++; }
  }
  for (const mat of doc.materials.texts || []) {
    if (!ids.has(mat.id)) continue;
    let text = '';
    try { text = JSON.parse(mat.content || '{}').text ?? ''; } catch { text = mat.content || ''; }
    const look = m => { let st = {}; try { st = JSON.parse(m.content).styles?.[0] || {}; } catch { /* plain */ }
      return JSON.stringify([m.font_name, m.font_path, m.font_size, st.size, st.font?.path, st.fill, st.strokes, m.border_width]); };
    const before = look(mat);
    houseStyle(mat, text, fontPath);
    if (look(mat) !== before) changed++;
  }
  return {changed, words:ids.size};
}

export function validateCaptionCues(cues, duration) {
  if (!Array.isArray(cues) || !cues.length || cues.length > 10000) fail('CAPTION_CUES', 'Supply 1–10000 word cues.');
  let previous = -1; const ids = new Set();
  return cues.map((cue, index) => {
    const {start, end, text} = cue || {}, position = cue?.position ?? 20;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || end <= start || start <= previous || end > duration + .001) {
      fail('CAPTION_TIMING', `Cue ${index + 1} must have finite, ordered, unique times inside the project content.`);
    }
    if (cue.id == null || ids.has(String(cue.id))) fail('CAPTION_ID', 'Cue IDs must be present and unique.');
    if (typeof text !== 'string' || !text.trim() || text.length > 120 || text.trim().split(/\s+/).length > 2) {
      fail('CAPTION_TEXT', `Cue ${cue.id} must contain one word or a glued particle pair.`);
    }
    if (typeof position !== 'number' || !Number.isFinite(position) || position < 5 || position > 85) {
      fail('CAPTION_POSITION', `Cue ${cue.id}: position must be 5–85 percent from the bottom.`);
    }
    ids.add(String(cue.id)); previous = start;
    return {...cue, text:text.trim(), position};
  });
}

/** Ordinary text segments; no subtitle recognition task, effect resource, or baked media. */
export function opCaptions(doc, op, context = {}) {
  const name = op.name ?? 'suheil';
  if (!/^[\w.-]{1,80}$/.test(name)) fail('CAPTION_NAME', 'Use a stable alphanumeric name.');
  const duration = principalEndUs(doc, context.projectDir) / 1e6;
  const cues = validateCaptionCues(op.cues, duration);
  const language = op.language || 'ar';
  const fingerprint = hash({name, cues, language, profile:'suheil-native-v1'});
  const trackName = `captions:${name}`;
  // Every caption layer counts, whoever wrote it: an SRT import or CapCut's auto-captions under
  // new ones is the double-captions failure the gate refuses.
  const existing = doc.tracks.filter(t => isCaptionTrack(doc, t));
  let replaced = null;
  if (existing.length) {
    const track = existing[0];
    if (existing.length === 1 && track.name === trackName) {
      const marker = `${trackName}:${fingerprint}:${ownedDigest(doc,track)}`;
      if (track.segments.length && track.segments.every(s => s.desc === marker)) return {changed:0, unchanged:true, name};
    }
    if (!op.replace) {
      fail('CAPTION_CONFLICT', `Caption layers already exist or were edited: ${captionTrackList(doc, existing)}. `
        + 'Keep them, or run `capcutctl captions --replace` to swap every caption layer for the new words '
        + '(hand corrections on them are lost).');
    }
    replaced = removeCaptionTracks(doc, existing);
  }
  // One style for every word, Arabic or English (2026-10-11: "I want the English captions to
  // match the Arabic ones"). Changa covers Latin, so Latin words no longer fall back to Arial.
  const font = CAPTION_FONT;
  if (!fs.existsSync(font.path)) fail('CAPTION_FONT_MISSING', font.path);
  const template = loadPreset('motion').text;
  const sourceTrack = template.tracks.find(t => t.type === 'text');
  const sourceText = template.materials.texts[0];
  const mint = key => seededId(op.__seed || fingerprint, `${trackName}:${key}`);
  const track = {...structuredClone(sourceTrack),id:mint('track'),name:trackName,is_default_name:false,segments:[]};
  const materials = [];
  for (const [i,cue] of cues.entries()) {
    const fontPath = context.projectDir ? localizeMedia(context.projectDir,font.path,undefined,{dryRun:context.dryRun}) : font.path;
    const text = captionDisplayText(cue.text,language);
    const mat = structuredClone(sourceText), seg = structuredClone(sourceTrack.segments[0]);
    mat.id = mint(`text:${cue.id}`);
    houseStyle(mat, text, fontPath);
    Object.assign(mat, {recognize_task_id:'',recognize_text:'',type:'text',language,words:{start_time:[],end_time:[],text:[]}});
    // Match Staging's half-open windows, retaining original timings in command output.
    const start = Math.round(cue.start*1e6);
    const end = Math.min(Math.round(cue.end*1e6),i+1<cues.length ? Math.round(cues[i+1].start*1e6)-1000 : Infinity);
    if (end <= start) fail('CAPTION_TIMING', `Cue ${cue.id} has no drawable window.`);
    Object.assign(seg,{id:mint(`segment:${cue.id}`),material_id:mat.id,extra_material_refs:[],
      target_timerange:{start,duration:end-start},source_timerange:null,common_keyframes:[],keyframe_refs:[],
      render_index:14000+doc.tracks.length,track_render_index:doc.tracks.length,caption_info:null,enable_video_mask:false});
    seg.clip.scale={x:1,y:1}; seg.clip.transform={x:0,y:(cue.position-50)/50};
    seg.clip.rotation=0; seg.clip.alpha=1;
    materials.push(mat); track.segments.push(seg);
  }
  (doc.materials.texts ||= []).push(...materials); doc.tracks.push(track);
  const marker = `${trackName}:${fingerprint}:${ownedDigest(doc,track)}`;
  for (const seg of track.segments) seg.desc = marker;
  return {changed:cues.length,name,track:track.id,editable:true,nativeVerified:false,...(replaced ? {replaced} : {}),
    warning:'Native font/stroke pixel parity and Arabic playback still require CapCut visual review.'};
}

/* ---------------- placement against the face ---------------- */

const secs = us => (us || 0) / 1e6;
const r2 = n => Math.round(n * 100) / 100;
const startS = s => secs(s.target_timerange?.start);
const endS = s => secs((s.target_timerange?.start || 0) + (s.target_timerange?.duration || 0));
/** Bottom-percent position (5–85) ↔ CapCut's transform.y, and its centre in px from the top. */
const yOf = position => (position - 50) / 50;
const centreOf = y => 960 - y * 960;
const POSITION_PROPS = new Set(['KFTypePositionX', 'KFTypePositionY']);

function faceLayout(face) {
  const ty = face.clip?.transform?.y ?? 0, sc = face.clip?.scale?.y ?? 1;
  const layout = ty <= -0.2 ? 'split' : ty >= 0.2 ? 'split-top' : 'full';
  let band;
  if (layout === 'split') band = [990, 1920];
  else if (layout === 'split-top') band = [0, 930];
  else { const top = 960 - ty * 960 - 960 * sc; band = [top + 0.10 * 1920 * sc, top + 0.75 * 1920 * sc]; }
  return { layout, band, scale: sc, key: `${layout}:${Math.round(sc * 100)}:${Math.round(ty * 100)}` };
}

/** The principal faces and the full-frame scenes, read once per document. */
export function captionContext(doc) {
  let principal = null;
  try { principal = principalTrack(doc); } catch { return null; }
  // Only a CLI-marked scene is known to cover the face; a transparent overlay (a slab) is not.
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const scenes = allSegments(doc).filter(({ segment }) => videos.get(segment.material_id)?.capcutctl_mograph?.scene)
    .map(({ segment }) => [startS(segment), endS(segment)]);
  return { faces: principal.track.segments || [], covered: t => scenes.some(([a, b]) => a <= t && t < b) };
}

/**
 * Where a caption word sits against the face under it. Full face: the head fills about
 * 10–75% of the clip height, so a caption belongs in the bottom band (position ≤ ~22). Split
 * with the face below the seam: the caption rides the seam, never inside the face half.
 * Null when no face is under the word; `covered` when a full-frame scene hides the face.
 */
export function captionPlacement(doc, segment, context = captionContext(doc)) {
  if (!context) return null;
  const t = (startS(segment) + endS(segment)) / 2;
  const face = context.faces.find(f => startS(f) <= t && t < endS(f));
  if (!face) return null;
  if (context.covered(t)) return { t, face, covered: true };
  const y = segment.clip?.transform?.y ?? 0;
  const cy = centreOf(y);
  const { layout, band, scale } = faceLayout(face);
  return { t, face, layout, band, scale, y, covered: false, onFace: cy > band[0] && cy < band[1] };
}

/** The position a word on this face belongs at, or null when no house position clears it. */
function clearPosition({ layout, band }) {
  if (layout !== 'full') return 50;
  for (const position of [20, ...Array.from({ length: 15 }, (_, i) => 19 - i)]) {
    const cy = centreOf(yOf(position));
    if (!(cy > band[0] && cy < band[1])) return position;
  }
  return null;
}

/** A word that crosses a change of face layout, with how much of it sits on each side. */
function layoutStraddle(context, segment) {
  const a = startS(segment), b = endS(segment);
  for (let i = 1; i < context.faces.length; i++) {
    const cut = startS(context.faces[i]);
    if (!(cut > a + 1e-6 && cut < b - 1e-6)) continue;
    if (faceLayout(context.faces[i - 1]).key === faceLayout(context.faces[i]).key) continue;
    return { cut, before: cut - a, after: b - cut };
  }
  return null;
}

const CLAMP_SHARE = 0.7;
const CLAMP_MIN_S = 0.08;

/**
 * Re-derive caption positions after the layout changed under them. Only words on the face
 * move: a split face takes the seam (50), a full face the bottom band (20, or the highest
 * position in 5–19 that clears a punched-in face). Words with position keyframes and words
 * under a full-frame scene are left alone. `clamp` trims a word that straddles a layout cut
 * to the side that holds ≥70% of it, when ≥80ms remain; without it the word is reported.
 */
export function opCaptionsReposition(doc, op = {}, context = {}) {
  const ctx = captionContext(doc);
  const tracks = (doc.tracks || []).filter(t => t.type === 'text' && (t.name || '').startsWith('captions:'));
  if (!tracks.length) fail('CAPTION_NONE', 'No captions:* track to reposition.');
  const moved = [], unresolved = [], straddling = [], trimmed = [], keyframed = [];
  for (const track of tracks) {
    const marker = stampState(doc, track);
    for (const segment of track.segments || []) {
      if ((segment.common_keyframes || []).some(k => POSITION_PROPS.has(k.property_type) && (k.keyframe_list || []).length)) {
        keyframed.push(r2(startS(segment)));
        continue;
      }
      if (ctx) {
        const straddle = layoutStraddle(ctx, segment);
        if (straddle) {
          const tt = segment.target_timerange, total = straddle.before + straddle.after;
          const keepBefore = straddle.before / total >= CLAMP_SHARE && straddle.before >= CLAMP_MIN_S;
          const keepAfter = straddle.after / total >= CLAMP_SHARE && straddle.after >= CLAMP_MIN_S;
          const row = { t: r2(startS(segment)), cut: r2(straddle.cut) };
          if (op.clamp && (keepBefore || keepAfter)) {
            const cutUs = Math.round(straddle.cut * 1e6);
            if (keepBefore) tt.duration = cutUs - tt.start;
            else { tt.duration = tt.start + tt.duration - cutUs; tt.start = cutUs; }
            trimmed.push({ ...row, kept: keepBefore ? 'before' : 'after' });
          } else straddling.push({ ...row, clampable: keepBefore || keepAfter });
        }
      }
      const place = captionPlacement(doc, segment, ctx);
      if (!place || place.covered || !place.onFace) continue;
      const position = clearPosition(place);
      if (position == null) { unresolved.push({ t: r2(place.t), layout: place.layout, scale: place.scale }); continue; }
      segment.clip ||= {};
      segment.clip.transform = { ...(segment.clip.transform || { x: 0 }), y: yOf(position) };
      moved.push({ t: r2(startS(segment)), layout: place.layout, from: r2(place.y), to: yOf(position), position });
    }
    if (marker) restamp(doc, track, marker);
  }
  return { changed: moved.length + trimmed.length, moved, unresolved, straddling, trimmed, keyframed,
    ...(straddling.length && !op.clamp ? { hint: 'words straddle a layout cut; --clamp trims them to one side' } : {}) };
}

/** The generation marker on a still-untouched captions track: `NAME:fingerprint:digest`. */
function stampState(doc, track) {
  const desc = track.segments?.[0]?.desc || '';
  if (!desc.startsWith(`${track.name}:`) || !track.segments.every(s => s.desc === desc)) return null;
  const rest = desc.slice(track.name.length + 1);
  const at = rest.lastIndexOf(':');
  if (at < 0 || rest.slice(at + 1) !== ownedDigest(doc, track)) return null;   // already hand-edited
  return { fingerprint: rest.slice(0, at) };
}

/** Keep an untouched track recognisable, so an identical `captions` run stays a no-op. */
function restamp(doc, track, { fingerprint }) {
  const marker = `${track.name}:${fingerprint}:${ownedDigest(doc, track)}`;
  for (const segment of track.segments) segment.desc = marker;
}
