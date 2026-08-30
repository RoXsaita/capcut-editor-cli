import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main, setOutput } from '../src/cli.mjs';

const US = seconds => Math.round(seconds * 1e6);

function dryRunProject(root) {
  const project = path.join(root, 'project');
  const media = path.join(root, 'screen.mp4');
  const doc = {
    id: 'MUSIC-TIMELINE',
    name: 'Music dry-run fixture',
    duration: US(8),
    fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [
        { id: 'BROLL', type: 'video', path: media, duration: US(8), width: 720, height: 1050 },
        { id: 'FACE', type: 'video', path: media, duration: US(8), width: 1080, height: 1920 },
      ],
      audios: [], common_mask: [], speeds: [], audio_fades: [], transitions: [],
    },
    tracks: [
      {
        id: 'BROLL-TRACK', type: 'video', flag: 2, name: 'broll', segments: [{
          id: 'BROLL-SEGMENT', material_id: 'BROLL', desc: 'broll:proof', volume: 0,
          source_timerange: { start: 0, duration: US(8) },
          target_timerange: { start: 0, duration: US(8) },
          clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        }],
      },
      {
        id: 'FACE-TRACK', type: 'video', flag: 2, name: 'content', segments: [{
          id: 'FACE-SEGMENT', material_id: 'FACE', volume: 1,
          source_timerange: { start: 0, duration: US(8) },
          target_timerange: { start: 0, duration: US(8) },
          clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        }],
      },
    ],
  };
  fs.writeFileSync(media, 'not decoded; dry-run must not probe or generate');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'draft_info.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return project;
}

test('music --dry-run propagates through finish preparation without Lyria or cache writes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-music-dry-run-'));
  const project = dryRunProject(temp);
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  let stdout = '';
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('Lyria must not be called during --dry-run');
  };
  // Capture through the CLI's own sink, never by hooking process.stdout.write: on Node 20 the
  // test runner reports through that same hook, so the JSON came back with the runner's binary
  // protocol spliced into it.
  const restoreOutput = setOutput(chunk => { stdout += String(chunk); return true; });
  const results = [];
  const cacheStates = [];
  try {
    for (const command of ['music', 'finish']) {
      stdout = '';
      await main(command === 'music'
        ? ['music', '--project', project, '--dry-run']
        : ['finish', '--project', project, '--music', '--dry-run']);
      results.push(JSON.parse(stdout));
      cacheStates.push(fs.existsSync(path.join(project, '.capcutctl')));
    }
  } finally {
    restoreOutput();
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
  for (const result of results) {
    assert.equal(result.dryRun, true);
    assert.equal(result.score.musicPrepared.dryRun, true);
    assert.equal(result.score.musicPrepared.wouldGenerate, true);
  }
  assert.equal(fetchCalls, 0);
  assert.deepEqual(cacheStates, [false, false]);
});
