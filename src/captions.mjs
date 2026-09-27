import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CapcutError, loadPreset, seededId, localizeMedia, contentEndUs } from './core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (code, message) => { throw new CapcutError(`${code}: ${message}`, {code}); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CHANGA = path.join(ROOT, 'tools/caption_engine/fonts/Changa-ExtraBold.ttf');

// Logical Unicode only. CapCut, not a manual bidi pre-pass, shapes native text.
export function captionDisplayText(text, language = 'ar') {
  if (!['ar', 'fa', 'ur'].includes(language.split('-')[0])) return text.normalize('NFC');
  return text.normalize('NFC').replace(/[0-9]/g, n => '٠١٢٣٤٥٦٧٨٩'[Number(n)])
    .replace(/%/g, '٪').replace(/[\u064b-\u065f\u0670]/g, '');
}
function latinFont() {
  const candidates = [process.env.CAPCUTCTL_LATIN_FONT,
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode.ttf'];
  const result = candidates.find(p => p && fs.existsSync(p));
  if (!result) fail('CAPTION_FONT_MISSING', 'Mixed Latin cues require Arial Unicode; set CAPCUTCTL_LATIN_FONT to your licensed font file.');
  return result;
}
function ownedDigest(doc, track) {
  const ids = new Set(track.segments.map(s => s.material_id));
  const clean = structuredClone(track);
  for (const s of clean.segments) s.desc = '';
  return hash({track:clean, texts:(doc.materials.texts || []).filter(m => ids.has(m.id))});
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
  const duration = contentEndUs(doc, context.projectDir) / 1e6;
  const cues = validateCaptionCues(op.cues, duration);
  const language = op.language || 'ar';
  const fingerprint = hash({name, cues, language, profile:'suheil-native-v1'});
  const trackName = `captions:${name}`;
  const owned = doc.tracks.filter(t => t.name?.startsWith('captions:'));
  if (owned.length) {
    const track = owned[0];
    if (owned.length === 1 && track.name === trackName) {
      const marker = `${trackName}:${fingerprint}:${ownedDigest(doc,track)}`;
      if (track.segments.length && track.segments.every(s => s.desc === marker)) return {changed:0, unchanged:true, name};
    }
    fail('CAPTION_CONFLICT', 'Caption layers already exist or were edited. Preserve them; explicitly remove them before generating a replacement.');
  }
  const fonts = cues.map(c => /[a-z]/i.test(c.text) ? {path:latinFont(), name:'Arial Unicode MS'} : {path:CHANGA,name:'Changa ExtraBold'});
  for (const font of fonts) if (!fs.existsSync(font.path)) fail('CAPTION_FONT_MISSING', font.path);
  const template = loadPreset('motion').text;
  const sourceTrack = template.tracks.find(t => t.type === 'text');
  const sourceText = template.materials.texts[0];
  const mint = key => seededId(op.__seed || fingerprint, `${trackName}:${key}`);
  const track = {...structuredClone(sourceTrack),id:mint('track'),name:trackName,is_default_name:false,segments:[]};
  const materials = [];
  // Measured in a native export: size 15 drew a word 49px tall on a 1080x1920 canvas, so the
  // 90px target is about 28.
  const nativeSize = 28;
  for (const [i,cue] of cues.entries()) {
    const font = fonts[i];
    const fontPath = context.projectDir ? localizeMedia(context.projectDir,font.path,undefined,{dryRun:context.dryRun}) : font.path;
    const text = captionDisplayText(cue.text,language);
    const mat = structuredClone(sourceText), seg = structuredClone(sourceTrack.segments[0]);
    mat.id = mint(`text:${cue.id}`);
    const style = {
      fill:{alpha:1,content:{render_type:'solid',solid:{alpha:1,color:[1,1,1]}}},
      font:{id:'',path:fontPath},range:[0,text.length],size:nativeSize,
      strokes:[{content:{solid:{alpha:1,color:[0,0,0]}},width:4/90}],
    };
    Object.assign(mat, {content:JSON.stringify({styles:[style],text}),font_name:font.name,font_title:font.name,
      font_path:fontPath,font_size:nativeSize,check_flag:15,alignment:1,has_shadow:false,background_style:0,
      border_color:'#000000',border_width:4/90,border_alpha:1,text_color:'#FFFFFF',recognize_task_id:'',
      recognize_text:'',type:'text',language,words:{start_time:[],end_time:[],text:[]}});
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
  return {changed:cues.length,name,track:track.id,editable:true,nativeVerified:false,
    warning:'Native font/stroke pixel parity and Arabic playback still require CapCut visual review.'};
}
