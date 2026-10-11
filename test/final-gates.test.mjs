import assert from 'node:assert/strict';
import test from 'node:test';

import { captionLayers } from '../src/gate.mjs';

const seg = (start, dur, extra = {}) => ({ id: `S${start}`, material_id: 'M', target_timerange: { start, duration: dur }, ...extra });
const docWith = tracks => ({ materials: { videos: [{ id: 'M', path: '/x/clip.mp4' }, { id: 'E', path: '/x/renders__suheilai-follow-ender.mov' }], texts: [] }, tracks });

test('captions: one layer counts, two layers are double captions, an empty track is none', () => {
  const one = docWith([{ type: 'text', name: 'captions:x', segments: [seg(0, 400_000)] }, { type: 'text', name: 'captions:empty', segments: [] }]);
  assert.equal(captionLayers(one).length, 1);
  const two = docWith([{ type: 'text', name: 'captions:x', segments: [seg(0, 400_000)] }, { type: 'text', name: 'captions:y', segments: [seg(0, 400_000)] }]);
  assert.equal(captionLayers(two).length, 2);
  assert.equal(captionLayers(docWith([])).length, 0);
});
