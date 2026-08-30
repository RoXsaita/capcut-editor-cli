import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Make the SFX palette resolvable on any machine.
 *
 * `presets/sfx.json` points into CapCut's own effect/music cache — paths CapCut mints on the
 * machine where the sound was downloaded. `polish` now checks that a sound is actually present
 * before writing a reference to it (otherwise the whole transaction dies with a dozen
 * MISSING_MEDIA errors on anyone else's Mac), which means a test asserting that clicks and
 * wooshes get placed only passes where those files happen to exist. It did not on CI.
 *
 * So: copy the REAL palette — every id, duration and extra-material shape harvested from a
 * genuine project — and repoint each entry at one stand-in file in a temp directory. The code
 * path under test is unchanged; only the bytes on the end of it are ours. Exercising
 * CAPCUTCTL_PRESET_DIR here also keeps the bring-your-own-palette override honest.
 *
 * Import this for side effects BEFORE importing anything that reads presets.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(HERE, '..', '..', 'presets', 'sfx.json');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-sfx-preset-'));
const stand_in = path.join(dir, 'sound.dat');
fs.writeFileSync(stand_in, 'sfx-fixture-bytes');

const palette = JSON.parse(fs.readFileSync(REAL, 'utf8'));
for (const kind of ['audioTemplates', 'transitionTemplates']) {
  for (const template of Object.values(palette[kind] || {})) {
    if (template.path) template.path = stand_in;
  }
}
fs.writeFileSync(path.join(dir, 'sfx.json'), JSON.stringify(palette, null, 2));

// Every other preset still falls back to the bundled one, so this overrides sfx.json alone.
process.env.CAPCUTCTL_PRESET_DIR = dir;

export const SFX_FIXTURE_DIR = dir;
export const SFX_FIXTURE_FILE = stand_in;
