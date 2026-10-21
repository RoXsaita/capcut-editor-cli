/**
 * Two house rules that kept breaking because a session (ours, Codex, a hand edit in CapCut)
 * re-added the old look. Both are checked by the gate and repaired by the CLI, so the rule
 * holds whoever edited the draft.
 *
 * 1. Never a blurred background (2026-10-11: "delete the blurred one and always add the
 *    non-blurred one"). A copy of the face carrying CapCut's Blur effect, or CapCut's own
 *    Background → Blur canvas, is the blurred background. The clear room plate replaces it.
 * 2. One caption style (2026-10-11: "the English captions have different format, text size …
 *    I want the English captions to match the Arabic ones"). Every caption word carries the
 *    house font, size, colour, stroke and scale (captions.mjs houseStyle), whatever its script.
 */
import { allSegments } from './core.mjs';
import { principalTrack } from './polish.mjs';
import { houseStyle, isCaptionTrack } from './captions.mjs';

const BLUR_EFFECT_ID = '7399464929830423813';
export const isBlurEffect = e => e && (e.name === 'Blur' || e.effect_id === BLUR_EFFECT_ID || e.resource_id === BLUR_EFFECT_ID);
const S = us => Math.round((us || 0) / 1e4) / 100;

/** Materials the speaker is filmed in: everything on the principal track that is real video. */
function faceMaterials(doc) {
  let principal;
  try { principal = principalTrack(doc); } catch { return new Set(); }
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  return new Set((principal.track.segments || [])
    .map(s => s.material_id).filter(id => videos.get(id)?.type === 'video'));
}

/**
 * Blurred backgrounds still in the draft. Four shapes:
 *  - `face-copy`: a segment off the principal track that plays a face material (or is a layout
 *    plate) with a Blur effect attached (what `layout background`/`layout screen` wrote before
 *    2026-10-11, whatever its desc says now);
 *  - `blurred-video`: any other real video off the principal track with a Blur effect;
 *  - `blurred-media`: a still (photo material) off the principal track with a Blur effect;
 *  - `canvas`: a segment whose Background fill is CapCut's Blur canvas.
 * A Blur is matched by its effect id as well as its name: a localized CapCut names it 模糊.
 * Brand graphics (`sig:` logo reveals, `motion:` layers) blur on purpose and are not reported.
 */
export function blurredBackgrounds(doc) {
  const effects = new Map((doc.materials?.video_effects || []).map(e => [e.id, e]));
  const blurCanvases = new Set((doc.materials?.canvases || []).filter(c => c.type === 'canvas_blur').map(c => c.id));
  const faces = faceMaterials(doc);
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  let principalIndex = -1;
  try { principalIndex = principalTrack(doc).index; } catch { /* no principal track */ }
  const out = [];
  for (const { track, trackIndex, segment } of allSegments(doc)) {
    if (track.type !== 'video') continue;
    const refs = segment.extra_material_refs || [];
    const t = S(segment.target_timerange?.start), end = S((segment.target_timerange?.start || 0) + (segment.target_timerange?.duration || 0));
    if (/^(sig|motion):/.test(segment.desc || '')) continue;
    if (refs.some(id => blurCanvases.has(id))) out.push({ kind: 'canvas', id: segment.id, trackIndex, t, end });
    else if (trackIndex !== principalIndex && videos.get(segment.material_id)?.type === 'photo'
      && refs.some(id => isBlurEffect(effects.get(id)))) {
      out.push({ kind: 'blurred-media', id: segment.id, trackIndex, t, end });
    }
    else if (trackIndex !== principalIndex && videos.get(segment.material_id)?.type === 'video' && refs.some(id => isBlurEffect(effects.get(id)))) {
      // A copy of the face (on the principal track now, or a layout plate cut from a face the
      // edit has since swapped for a derived one) becomes the room plate; any other clip is
      // simply un-blurred.
      const faceCopy = faces.has(segment.material_id) || (segment.desc || '').startsWith('layout:');
      out.push({ kind: faceCopy ? 'face-copy' : 'blurred-video', id: segment.id, trackIndex, t, end });
    }
  }
  return out;
}

/** The style a caption word is drawn with; two words that differ here look different on screen. */
export function captionStyleKey(material, segment = null) {
  let style = {};
  try { style = JSON.parse(material.content || '{}').styles?.[0] || {}; } catch { /* plain text */ }
  const round = v => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v ?? null);
  return JSON.stringify({
    font: material.font_name || null,
    size: round(style.size ?? material.font_size),
    color: (style.fill?.content?.solid?.color || []).map(round).join(',') || material.text_color || null,
    stroke: round(style.strokes?.[0]?.width ?? material.border_width),
    scale: round(segment?.clip?.scale?.y ?? 1),
  });
}

/** The key every caption word must have: the one houseStyle writes. */
export function houseCaptionKey() {
  const scratch = {};
  houseStyle(scratch, 'x');
  return captionStyleKey(scratch, { clip: { scale: { x: 1, y: 1 } } });
}

/** Caption words not drawn in the house style (compared with the spec, not with each other). */
export function captionStyleDrift(doc) {
  const texts = new Map((doc.materials?.texts || []).map(m => [m.id, m]));
  const house = houseCaptionKey();
  const off = [];
  for (const { track, segment } of allSegments(doc)) {
    if (!isCaptionTrack(doc, track)) continue;
    const material = texts.get(segment.material_id);
    if (!material) continue;
    let text = '';
    try { text = JSON.parse(material.content || '{}').text || ''; } catch { /* plain text */ }
    const key = captionStyleKey(material, segment);
    if (key !== house) off.push({ t: S(segment.target_timerange?.start), text, key });
  }
  return { house, off };
}
