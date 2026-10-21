import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A temp directory that is removed when the test process exits.
 *
 * Fixtures used to mkdtemp and never clean up, so every run left a few hundred project
 * copies in $TMPDIR. Exit-time removal keeps a fixture alive for the whole file (a later
 * test, or a child CLI process, may still read it) and still leaves nothing behind.
 */
const made = new Set();

function cleanup() {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
  }
  made.clear();
}

export function tmpDir(prefix = 'capcutctl-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (!made.size) process.once('exit', cleanup);
  made.add(dir);
  return dir;
}
