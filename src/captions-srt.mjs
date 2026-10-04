import { CapcutError, clone, contentEndUs, loadPreset, seededId } from './core.mjs';

const US = seconds => Math.round(Number(seconds) * 1e6);
const S = microseconds => Number(microseconds) / 1e6;
const TAG = 'caption:native';

function normalizeCue(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new CapcutError(`Caption cue ${index + 1} must be an object.`, { code: 'CAPTION_BAD_CUE', exitCode: 2 });
  }
  const text = String(raw.text ?? raw.caption ?? '').trim();
  if (!text) throw new CapcutError(`Caption cue ${index + 1} has no text.`, { code: 'CAPTION_BAD_CUE', exitCode: 2 });

  const startUs = raw.startUs != null ? Number(raw.startUs)
    : raw.start_us != null ? Number(raw.start_us)
      : raw.start != null ? US(raw.start)
        : NaN;
  let endUs = raw.endUs != null ? Number(raw.endUs)
    : raw.end_us != null ? Number(raw.end_us)
      : raw.end != null ? US(raw.end)
        : NaN;
  if (!Number.isFinite(endUs)) {
    if (raw.durationUs != null) endUs = startUs + Number(raw.durationUs);
    else if (raw.duration_us != null) endUs = startUs + Number(raw.duration_us);
    else if (raw.duration != null) endUs = startUs + US(raw.duration);
  }
  if (!Number.isFinite(startUs) || startUs < 0 || !Number.isFinite(endUs) || endUs <= startUs) {
    throw new CapcutError(`Caption cue ${index + 1} has an invalid time range.`, {
      code: 'CAPTION_BAD_TIME', exitCode: 2, details: { startUs, endUs }
    });
  }
  return { startUs: Math.round(startUs), endUs: Math.round(endUs), text };
}

export function normalizeCaptionCues(value) {
  const rows = Array.isArray(value) ? value
    : Array.isArray(value?.cues) ? value.cues
      : Array.isArray(value?.segments) ? value.segments
        : null;
  if (!rows) {
    throw new CapcutError('Caption JSON must be an array, {cues:[...]}, or Whisper-style {segments:[...]}.', {
      code: 'CAPTION_BAD_FILE', exitCode: 2
    });
  }
  const cues = rows.map(normalizeCue).sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].startUs < cues[i - 1].endUs) {
      throw new CapcutError(`Caption cues overlap at ${S(cues[i].startUs).toFixed(3)}s.`, {
        code: 'CAPTION_OVERLAP', exitCode: 2,
        details: { previous: cues[i - 1], current: cues[i] }
      });
    }
  }
  return cues;
}

function updateTextMaterial(template, id, text) {
  const material = clone(template);
  material.id = id;
  material.sub_type = 1;
  material.name = '';
  material.recognize_text = text;
  const content = JSON.parse(material.content || '{}');
  content.text = text;
  if (!Array.isArray(content.styles) || !content.styles.length) content.styles = [{}];
  content.styles[0].range = [0, text.length];
  material.content = JSON.stringify(content);
  return material;
}

function captionTrack(doc, template, name, seed) {
  const existing = (doc.tracks || []).find(track => track.type === 'text' && track.name === name);
  if (existing) {
    const foreign = (existing.segments || []).find(segment => !String(segment.desc || '').startsWith(TAG));
    if (foreign) {
      throw new CapcutError(`Text track "${name}" already contains non-capcutctl segments. Choose another --track.`, {
        code: 'CAPTION_TRACK_OCCUPIED', exitCode: 2, details: { track: name, segment: foreign.id }
      });
    }
    const oldIds = new Set((existing.segments || []).map(segment => segment.material_id).filter(Boolean));
    doc.materials.texts = (doc.materials.texts || []).filter(material => !oldIds.has(material.id));
    existing.segments = [];
    return existing;
  }
  const track = clone(template);
  track.id = seededId(seed, `caption:track:${name}`);
  track.name = name;
  track.is_default_name = false;
  track.segments = [];
  (doc.tracks ||= []).push(track);
  return track;
}

export function opCaption(doc, op = {}, context = {}) {
  const cues = normalizeCaptionCues(op.cues || []);
  if (!cues.length) throw new CapcutError('caption requires at least one cue.', { code: 'CAPTION_EMPTY', exitCode: 2 });

  const trackName = String(op.track || 'captions').trim();
  if (!trackName) throw new CapcutError('caption --track cannot be empty.', { code: 'CAPTION_BAD_TRACK', exitCode: 2 });
  const scale = op.scale == null ? 1 : Number(op.scale);
  const y = op.y == null ? null : Number(op.y);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new CapcutError('caption --scale must be greater than 0 and no more than 8.', { code: 'CAPTION_BAD_STYLE', exitCode: 2 });
  }
  if (y != null && (!Number.isFinite(y) || y < -2 || y > 2)) {
    throw new CapcutError('caption --y must be between -2 and 2.', { code: 'CAPTION_BAD_STYLE', exitCode: 2 });
  }

  const end = contentEndUs(doc, context.projectDir);
  if (end > 0 && cues.at(-1).endUs > end + 1000) {
    throw new CapcutError(`Last caption ends at ${S(cues.at(-1).endUs).toFixed(3)}s, after content ends at ${S(end).toFixed(3)}s.`, {
      code: 'CAPTION_PAST_END', exitCode: 2
    });
  }

  const preset = loadPreset('signature');
  const seed = op.__seed || `caption:${trackName}`;
  const track = captionTrack(doc, preset.textTrackTemplate, trackName, seed);
  const texts = (doc.materials.texts ||= []);

  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index];
    const materialId = seededId(seed, `caption:material:${index}`);
    const segmentId = seededId(seed, `caption:segment:${index}`);
    texts.push(updateTextMaterial(preset.textMaterialTemplate, materialId, cue.text));

    const segment = clone(preset.textSegmentTemplate);
    segment.id = segmentId;
    segment.material_id = materialId;
    segment.desc = `${TAG}:${trackName}`;
    segment.source_timerange = null;
    segment.target_timerange = { start: cue.startUs, duration: cue.endUs - cue.startUs };
    segment.extra_material_refs = [];
    segment.keyframe_refs = [];
    segment.common_keyframes = [];
    segment.clip = clone(segment.clip || {});
    segment.clip.scale = { x: scale, y: scale };
    segment.clip.transform = clone(segment.clip.transform || { x: 0, y: 0 });
    if (y != null) segment.clip.transform.y = y;
    track.segments.push(segment);
  }

  track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  return {
    changed: cues.length,
    track: trackName,
    first: { at: S(cues[0].startUs), text: cues[0].text },
    last: { at: S(cues.at(-1).startUs), text: cues.at(-1).text }
  };
}
