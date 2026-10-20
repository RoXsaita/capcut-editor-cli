/**
 * A local audio file inside a draft: probed, copied under a content hash, and cloned from a
 * harvested template with the library identity removed. Shared by `music --file` (the bed)
 * and `sfx --file` (a WAV whoosh, a click, a voice patch), so neither has to clone a
 * segment or ride an alpha-0 video carrier to get its own sound onto the timeline.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CapcutError, LOCAL_MEDIA_DIR } from './core.mjs';

export function probeAudioDuration(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ], { encoding: 'utf8' }).trim();
    const n = Number(out);
    if (!n) throw new Error('empty');
    return n;
  } catch {
    throw new CapcutError(`could not probe audio duration of ${path.basename(file)}`, { code: 'PROBE_FAILED', exitCode: 2 });
  }
}

/** Short content hash: the same bytes always land on the same name, so a rerun reuses them. */
export function audioContentStamp(source) {
  return crypto.createHash('sha1').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
}

/**
 * Copy the file into the draft under a content-hash name CapCut cannot remap. Without a
 * project (tests, planning) the source path is returned untouched; a dry run names the
 * destination and copies nothing.
 */
export function localizeAudioFile(projectDir, source, { dryRun = false, prefix = 'finish-music' } = {}) {
  source = path.resolve(source);
  if (!projectDir) return source;
  const dest = path.join(projectDir, LOCAL_MEDIA_DIR, `${prefix}-${audioContentStamp(source)}${path.extname(source) || '.mp3'}`);
  if (path.resolve(source) === path.resolve(dest)) return dest;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }
  return dest;
}

/** Library identity left on a cloned template makes CapCut swap our file for Hyperpop. */
export function detachLibraryIdentity(material) {
  material.effect_id = '';
  material.resource_id = '';
  material.music_id = '';
  material.pgc_id = '';
  material.pgc_name = '';
  material.unique_id = '';
  material.local_material_id = '';
  material.third_resource_id = '';
  material.formula_id = '';
  material.query = '';
  material.search_id = '';
  material.music_source = '';
  material.category_name = 'local';
  material.app_id = 0;
  return material;
}
