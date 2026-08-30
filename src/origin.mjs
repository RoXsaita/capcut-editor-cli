/**
 * The origin contract: what media is allowed into a project.
 *
 * The deliverable is an EDITABLE CapCut project, not a rendered file. That only holds if
 * every framing decision is still a CapCut property the human can drag. Two ways of
 * importing media destroy that, and both actually happened:
 *
 *   1. **Pre-framed media.** The B-roll for "AI Video Editor" was cropped and scaled from
 *      1920x1080 to 1080x960 with ffmpeg, then imported and placed with an identity
 *      transform. It looks right, and `doctor` passes, because the framing was baked into
 *      the pixels — which is exactly why the human cannot change it. The rows outside the
 *      crop no longer exist in the file, so no reframe, no re-zoom, no switch to circle or
 *      full-frame. `layout broll --row` / `layout screen` express the identical framing as
 *      clip.scale + clip.transform + a seam mask, on the full-resolution source.
 *
 *   2. **Ephemeral origins.** Those same clips were written into an agent session's
 *      scratchpad. `localizeMedia` copies the bytes in, so the project still plays — but
 *      media-map.json records the original as
 *      `/private/tmp/claude-501/.../scratchpad/broll/grok-work.mp4`, which no longer
 *      exists. The trail back to the real recording is gone permanently.
 *
 * Metadata cannot tell these apart on its own: rl2 muxes its takes through ffmpeg, so a
 * genuine screen recording carries the same `Lavf` encoder tag as a derivative. The two
 * checks below are structural instead, and neither has a plausible false positive:
 * capture devices do not emit exactly half the canvas, and originals do not live in /tmp.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CapcutError } from './core.mjs';

/** Directories whose contents are deleted out from under the project. */
function ephemeralRoots() {
  const roots = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  for (const value of [os.tmpdir(), process.env.TMPDIR, process.env.TMP]) {
    if (value) roots.push(value);
  }
  return [...new Set(roots.map(value => path.resolve(value)))];
}

/** Resolve symlinks so a link planted in a durable directory cannot smuggle a temp file in. */
function canonical(file) {
  const resolved = path.resolve(file);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

const under = (child, parent) => child === parent || child.startsWith(parent + path.sep);

export function isEphemeralPath(file) {
  const resolved = canonical(file);
  if (ephemeralRoots().some(root => under(resolved, root))) return true;
  // Agent scratchpads are per-session directories that outlive neither the session nor the
  // edit. They are not always under a system temp root, so match the segment by name too.
  return resolved.split(path.sep).some(part => part === 'scratchpad' || part === '.scratch');
}

/**
 * A frame that is exactly the canvas width by exactly half the canvas height is not a
 * capture — it is the split-screen upper half, already cut. Nothing records at that size.
 *
 * The full-canvas size is deliberately NOT flagged: plenty of phones record exactly
 * 1080x1920, so it carries no information. `doctor` reports it as context, not a fault.
 */
export function isPreframed({ width, height, canvas = [1080, 1920] } = {}) {
  const w = Number(width), h = Number(height);
  const [W, H] = canvas.map(Number);
  if (!(w > 0 && h > 0 && W > 0 && H > 0)) return null;
  if (w === W && h === Math.round(H / 2)) return { region: 'upper/lower half', canvas: [W, H] };
  if (h === H && w === Math.round(W / 2)) return { region: 'left/right half', canvas: [W, H] };
  return null;
}

/**
 * Classify a source file. `width`/`height` come from the caller's existing ffprobe, so this
 * never spawns a second probe.
 */
export function classifyOrigin({ file, width, height, canvas } = {}) {
  return {
    path: file ? canonical(file) : null,
    ephemeral: file ? isEphemeralPath(file) : false,
    preframed: isPreframed({ width, height, canvas }),
  };
}

const NATIVE_FRAMING_HINT = [
  'Import the full-frame original and let CapCut own the framing:',
  '  capcutctl add    --project P --media ORIGINAL --at S --dur S --track broll',
  '  capcutctl layout broll  --project P --at S --track broll --row SOURCE_PIXEL_ROW',
  '  capcutctl layout screen --project P --at S --media ORIGINAL   # landscape / window capture',
  'Both write clip.scale + clip.transform + the seam mask, so every one of those choices',
  'stays draggable in CapCut.',
].join('\n');

/**
 * Enforce the contract, and return the provenance note to stamp onto the material.
 *
 * `generated` is the honest escape hatch for a rendered asset that has no editable original
 * (a Remotion or After Effects graphic). `derivedFrom` is the escape hatch for deliberate
 * pre-processing: it is allowed only when it names a real, durable file, because the whole
 * point is that the human can still find the source.
 */
export function assertOrigin({
  file, width, height, canvas, label = 'clip.add', projectDir = null,
  generated = false, derivedFrom = null, derivedOffset = null, allowEphemeral = false,
} = {}) {
  // "Ephemeral" is relative to the project. A draft that itself lives under a temp root — a
  // test fixture, or a scratch experiment — cannot outlive its own media, so the check has
  // nothing to protect. Real CapCut drafts live in ~/Movies/CapCut and are never exempt.
  if (projectDir && isEphemeralPath(projectDir)) allowEphemeral = true;
  const found = classifyOrigin({ file, width, height, canvas });
  const name = file ? path.basename(file) : '<media>';

  let original = null;
  if (derivedFrom) {
    original = canonical(derivedFrom);
    if (!fs.existsSync(original)) {
      throw new CapcutError(
        `${label}: --derived-from ${derivedFrom} does not exist. It has to name the real original, `
        + 'otherwise the provenance it records is a dead link — which is the failure it exists to prevent.',
        { code: 'DERIVED_SOURCE_MISSING', exitCode: 2 });
    }
    if (isEphemeralPath(original) && !allowEphemeral) {
      throw new CapcutError(
        `${label}: --derived-from ${original} is itself in a temporary directory. Point it at the `
        + 'recording that will still be there next week.',
        { code: 'DERIVED_SOURCE_EPHEMERAL', exitCode: 2 });
    }
  }

  if (found.ephemeral && !allowEphemeral) {
    throw new CapcutError(
      `${label}: ${name} lives in a temporary directory (${found.path}).\n`
      + 'The bytes would be copied into the project, but the recorded origin would point at a path\n'
      + 'that gets deleted — which is how the last project lost the trail back to its screen\n'
      + 'recordings for good. Move or render it somewhere durable first (beside the project, or\n'
      + `~/Desktop/Screen Recordings/), then re-run. --allow-ephemeral overrides and accepts that loss.`,
      { code: 'EPHEMERAL_MEDIA', exitCode: 2 });
  }

  if (found.preframed && !generated && !original) {
    const [W, H] = found.preframed.canvas;
    throw new CapcutError(
      `${label}: ${name} is ${width}x${height} — exactly the ${found.preframed.region} of the ${W}x${H} `
      + 'canvas.\nThat is a crop baked in before import: the pixels outside it are gone, so in CapCut the\n'
      + 'human cannot reframe the shot, zoom somewhere else, or move the scene to another layout.\n\n'
      + NATIVE_FRAMING_HINT
      + '\n\nIf this really is a rendered asset with no editable original, pass --generated.\n'
      + 'If pre-processing was unavoidable, pass --derived-from ORIGINAL so the source stays findable.',
      { code: 'PREFRAMED_MEDIA', exitCode: 2 });
  }

  return {
    kind: generated ? 'generated' : original ? 'derived' : 'capture',
    derivedFrom: original,
    derivedOffset: derivedOffset == null ? null : Number(derivedOffset),
    preframed: Boolean(found.preframed),
    ephemeral: found.ephemeral,
  };
}

/** Stamp the contract's verdict where both a project copy and media-map.json can read it. */
export function stampOrigin(material, note) {
  if (!material || !note) return material;
  material.capcutctl_origin = note.kind;
  if (note.derivedFrom) material.derived_from_path = note.derivedFrom;
  if (note.derivedOffset != null) material.derived_from_offset = note.derivedOffset;
  if (note.preframed) material.capcutctl_preframed = true;
  return material;
}
