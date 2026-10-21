import fs from 'node:fs';
import path from 'node:path';

import * as real from '../../src/mograph.mjs';

/**
 * The real mograph module with its browser renderers stood in: no Chromium, no ffmpeg. The box
 * is `params.testBox` ([x, y, w, h]) or a safe lower-band box; the render honours `checkBox`
 * before it writes, like the real one, and writes `${out}.mov|png` holding its params.
 */
export function stubMograph({ sfx = 'pop', duration = 1.5 } = {}) {
  const calls = [];
  const boxOf = params => {
    const [x, y, w, h] = params.testBox || [205, 1212, 582, 188];
    return { x, y, w, h };
  };
  const metaOf = template => ({ name: template, duration, fps: 30, still: 1, sfx, motion: 'rich', pad: 24 });
  return {
    ...real,
    calls,
    async probeMograph({ template, params = {} }) {
      return { template, meta: metaOf(template), box: boxOf(params) };
    },
    async renderMograph({ template, params = {}, out, format = 'prores', profile, checkBox = null }) {
      calls.push({ template, params, out, format });
      const box = boxOf(params), meta = metaOf(template);
      if (checkBox) await checkBox(box, meta);
      const file = `${out}.${format === 'png-still' ? 'png' : 'mov'}`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `render ${JSON.stringify(params)}`);
      return { template, params, file, format, box, meta, frames: 45, scale: 1,
        fingerprint: real.fingerprint(template, params, profile), importVerified: false };
    },
  };
}
