/**
 * Which video file of an rl2 take holds a moment, and at what file time.
 *
 * Every rl2 sidecar is stamped on ONE take-wide `vt` clock. When the recorder's watchdog
 * restarts the video, the pixels continue in screen-part02.mp4 (then -part03 ...), each file
 * starting its own clock at its part's `start_vt`; the seconds between one part's `end_vt` and
 * the next part's `start_vt` are in no file. session.json lists the parts under
 * `video_segments`. So a vt is a seek time only in a one-part take.
 *
 * tools/rl2_take.py is the same reader for the Python side; keep them in step.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_VIDEO = 'screen.mp4';
// end_vt is the time of a part's last frame, which is still on screen for one frame period.
const END_SLACK = 0.05;

const finite = value => typeof value === 'number' && Number.isFinite(value);

function readSession(takeDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(takeDir, 'session.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/**
 * The take's video files in vt order: [{ file, startVt, endVt }] (endVt null = open-ended).
 * Two or more listed parts (file, finite start_vt, frames > 0 when recorded) are a restarted
 * take; anything else is the one-file take, session.json `video` (or screen.mp4) from vt 0.
 */
export function takeParts(takeDir, session = null) {
  const s = session ?? readSession(takeDir);
  const listed = [];
  for (const seg of Array.isArray(s.video_segments) ? s.video_segments : []) {
    if (!seg || typeof seg !== 'object') continue;
    if (typeof seg.file !== 'string' || !seg.file || !finite(seg.start_vt)) continue;
    if (seg.frames != null && !(finite(seg.frames) && seg.frames > 0)) continue;
    listed.push({ file: seg.file, startVt: seg.start_vt, endVt: finite(seg.end_vt) ? seg.end_vt : null });
  }
  if (listed.length > 1) {
    listed.sort((a, b) => a.startVt - b.startVt);
    return listed.map((part, i) => (part.endVt != null || i === listed.length - 1)
      ? part : { ...part, endVt: listed[i + 1].startVt });
  }
  const video = typeof s.video === 'string' && s.video ? s.video : DEFAULT_VIDEO;
  return [{ file: video, startVt: 0, endVt: null }];
}

/** { file, t } for a take-wide vt, or null when it is in no file (a restart gap). */
export function locateVt(parts, vt) {
  if (!finite(vt)) return null;
  for (const part of parts || []) {
    const end = part.endVt == null ? Infinity : part.endVt + END_SLACK;
    if (vt >= part.startVt - 1e-6 && vt <= end) return { file: part.file, t: Math.max(0, vt - part.startVt) };
  }
  return null;
}

/** `<take>__screen-part02.mp4` and `screen-part02__1a2b3c4d.mp4` both stand for screen-part02. */
function mediaStem(name) {
  const stem = path.basename(String(name || '')).replace(/\.[^.]+$/, '').replace(/__[0-9a-f]{8}(_\d+)?$/, '');
  return stem.split('__').at(-1);
}

/** The part a media file is, or null. A one-part take answers its part for any name. */
export function partForMedia(parts, media) {
  if (!parts?.length) return null;
  if (parts.length === 1) return parts[0];
  const stem = mediaStem(media);
  return parts.find(part => mediaStem(part.file) === stem) || null;
}

/**
 * A take-wide vt as file time in `part`, or null when the vt is in another part or a gap.
 * One-part takes return vt unchanged, so their behaviour does not move by even a rounding.
 */
export function vtInPart(parts, part, vt) {
  if (!part) return null;
  if (!parts || parts.length <= 1) return vt;
  const at = locateVt(parts, vt);
  return at && at.file === part.file ? at.t : null;
}
