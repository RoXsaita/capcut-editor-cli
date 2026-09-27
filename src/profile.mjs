/**
 * The style profile — the one source of taste.
 *
 * Every style number a command used to hard-code (face push, stress push, music bed level,
 * motion colour) and every target the `gate` checks live in the profile. It is three layers,
 * each deep-merged over the one before so a file only has to hold what it changes:
 *
 *   1. `presets/profile.json` — the shipped, brand-neutral defaults. Part of the repo.
 *   2. `<user dir>/profile.json` — the creator's brand, styles and preferences. Never in the
 *      repo: `capcutctl profile init` writes it from `presets/profile.template.json`.
 *   3. `--profile FILE` (or `edit.json` → `profile`) — one video, one reference reel.
 *
 * The user dir is `$CAPCUTCTL_PRESET_DIR` when set, else `$XDG_CONFIG_HOME/capcutctl`, else
 * `~/.config/capcutctl`. The other presets (`brands.json`, `sfx.json`, …) are looked up there too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No import from core.mjs: modules that core loads (stress, music, add) read the profile at
// their own top level, so this module must evaluate first and stand alone. Errors carry the
// same `code` / `exitCode` shape as CapcutError, which is all the CLI's handler reads.
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
class CapcutError extends Error {
  constructor(message, { code, exitCode = 1 } = {}) {
    super(message);
    this.name = 'CapcutError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.join(HERE, '..', 'presets', 'profile.json');
export const PROFILE_TEMPLATE = path.join(HERE, '..', 'presets', 'profile.template.json');

const expandHome = value => (value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value);

/** The directory that holds this user's profile and preset overrides. It may not exist yet. */
export function userDir() {
  const explicit = String(process.env.CAPCUTCTL_PRESET_DIR || '').trim();
  if (explicit) return path.resolve(expandHome(explicit));
  const xdg = String(process.env.XDG_CONFIG_HOME || '').trim();
  return path.join(xdg ? path.resolve(expandHome(xdg)) : path.join(os.homedir(), '.config'), 'capcutctl');
}

/** The user layer's path, whether or not it exists. */
export const userProfilePath = () => path.join(userDir(), 'profile.json');

/**
 * Older user files named the brand fill after its hue (`tokens.color.indigo`). The role is
 * `brand` now; carry the old key across so a profile written before the rename still wins.
 */
function migrate(layer) {
  const color = layer?.tokens?.color;
  if (isObject(color) && color.indigo && !color.brand) color.brand = color.indigo;
  return layer;
}

let CACHE = null;

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = deepMerge(base[key], value);
  return out;
}

function readLayer(file) {
  try { return migrate(readJson(file)); }
  catch (error) {
    throw new CapcutError(`could not read profile ${file}: ${error.message}`, { code: 'PROFILE_INVALID', exitCode: 2 });
  }
}

/** Every layer that exists, in merge order: `{ layer, file, present }`. */
export function profileLayers({ file = null } = {}) {
  const local = userProfilePath();
  const layers = [
    { layer: 'bundled', file: BUNDLED, present: true },
    { layer: 'user', file: local, present: fs.existsSync(local) },
  ];
  if (file) layers.push({ layer: 'file', file: path.resolve(expandHome(String(file))), present: fs.existsSync(path.resolve(expandHome(String(file)))) });
  return layers;
}

/** The effective profile: bundled, merged with the user layer, merged with `file` if given. */
export function loadProfile({ file = null, refresh = false } = {}) {
  if (CACHE && !file && !refresh) return CACHE;
  let profile = migrate(readJson(BUNDLED));
  for (const entry of profileLayers({ file }).slice(1)) {
    if (!entry.present) {
      if (entry.layer === 'file') throw new CapcutError(`no such profile: ${entry.file}`, { code: 'PROFILE_MISSING', exitCode: 2 });
      continue;
    }
    profile = deepMerge(profile, readLayer(entry.file));
  }
  if (profile.version !== 1) {
    throw new CapcutError(`profile version ${profile.version} is not supported (want 1).`, { code: 'PROFILE_VERSION', exitCode: 2 });
  }
  if (!file) CACHE = profile;
  return profile;
}

export function resetProfileCache() { CACHE = null; }

/** Read one dotted path from the effective profile, with a fallback for partial overrides. */
export function profileValue(dotted, fallback = undefined) {
  let node = loadProfile();
  for (const key of dotted.split('.')) {
    if (!isObject(node) || !(key in node)) return fallback;
    node = node[key];
  }
  return node ?? fallback;
}

/**
 * Write the user layer from the template. Refuses to overwrite a profile that exists unless
 * `force`, because that file is the creator's brand and it is not in any repository.
 */
export function initUserProfile({ force = false, dryRun = false } = {}) {
  const target = userProfilePath();
  const exists = fs.existsSync(target);
  if (exists && !force) {
    throw new CapcutError(`${target} already exists. Edit it, or pass --force to replace it with the template.`,
      { code: 'PROFILE_EXISTS', exitCode: 2 });
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(PROFILE_TEMPLATE, target);
    resetProfileCache();
  }
  return { file: target, template: PROFILE_TEMPLATE, replaced: exists, dryRun };
}

/**
 * The profile as one style sees it. A style (profile `styles.NAME`) is how the brand flexes per
 * video type; the part the engine enforces is its pace, which replaces `density.graphicEvery`.
 * The rest of a style (feel, lead, accent, camera, sound) is direction for whoever plans the edit.
 */
export function applyStyle(profile, name) {
  if (!name) return profile;
  const styles = Object.fromEntries(Object.entries(profile.styles || {}).filter(([k, v]) => !k.startsWith('_') && isObject(v)));
  const style = styles[name];
  if (!style) {
    throw new CapcutError(`no style "${name}" in the profile. Styles: ${Object.keys(styles).join(', ') || 'none'}.`,
      { code: 'STYLE_UNKNOWN', exitCode: 2 });
  }
  const pace = style.pace || {};
  return deepMerge(profile, {
    activeStyle: name,
    density: Array.isArray(pace.graphicEvery) ? { graphicEvery: pace.graphicEvery } : {},
  });
}
