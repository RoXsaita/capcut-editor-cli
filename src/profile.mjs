/**
 * The style profile — the one source of taste.
 *
 * Every style number a command used to hard-code (face push, stress push, music bed level,
 * motion colour) and every target the `gate` checks live in
 * `presets/profile.json`. `CAPCUTCTL_PRESET_DIR/profile.json` overrides it; a partial file
 * deep-merges over the bundled one so a user can change one number without copying the rest.
 */
import fs from 'node:fs';
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

/** The effective profile: bundled, merged with the machine override, merged with `file` if given. */
export function loadProfile({ file = null, refresh = false } = {}) {
  if (CACHE && !file && !refresh) return CACHE;
  let profile = readJson(BUNDLED);
  const dir = process.env.CAPCUTCTL_PRESET_DIR;
  const local = dir ? path.join(dir, 'profile.json') : null;
  if (local && fs.existsSync(local)) profile = deepMerge(profile, readJson(local));
  if (file) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
      throw new CapcutError(`no such profile: ${resolved}`, { code: 'PROFILE_MISSING', exitCode: 2 });
    }
    profile = deepMerge(profile, readJson(resolved));
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
