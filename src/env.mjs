import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load cli/.env then cwd/.env into process.env without overriding anything
 * already set. Call once at process start. Never logs values.
 */
export function loadEnv() {
  const files = [
    path.join(HERE, '..', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
    }
  }
}

export function geminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

export function googleCloudProject() {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_NUMBER || '';
}
