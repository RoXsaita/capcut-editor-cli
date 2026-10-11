import assert from 'node:assert/strict';
import test from 'node:test';

import { captionLayers, endingCard } from '../src/gate.mjs';

const seg = (start, dur, extra = {}) => ({ id: `S${start}`, material_id: 'M', target_timerange: { start, duration: dur }, ...extra });
const docWith = tracks => ({ materials: { videos: [{ id: 'M', path: '/x/clip.mp4' }, { id: 'E', path: '/x/renders__suheilai-follow-ender.mov' }], texts: [] }, tracks });

test('captions: one layer counts, two layers are double captions, an empty track is none', () => {
  const one = docWith([{ type: 'text', name: 'captions:x', segments: [seg(0, 400_000)] }, { type: 'text', name: 'captions:empty', segments: [] }]);
  assert.equal(captionLayers(one).length, 1);
  const two = docWith([{ type: 'text', name: 'captions:x', segments: [seg(0, 400_000)] }, { type: 'text', name: 'captions:y', segments: [seg(0, 400_000)] }]);
  assert.equal(captionLayers(two).length, 2);
  assert.equal(captionLayers(docWith([])).length, 0);
});

test('ending: a follow-ender clip or sig:endcard on the last frame passes; one that stops early, or a render, does not', () => {
  const end = 10;
  assert.ok(endingCard(docWith([{ type: 'video', segments: [seg(8_000_000, 2_000_000, { desc: 'repost:shared-visual-follow-ender' })] }]), end));
  assert.ok(endingCard(docWith([{ type: 'text', segments: [seg(7_500_000, 2_500_000, { desc: 'sig:endcard' })] }]), end));
  assert.ok(endingCard(docWith([{ type: 'video', segments: [seg(8_000_000, 2_000_000, { material_id: 'E' })] }]), end), 'by file name');
  assert.equal(endingCard(docWith([{ type: 'video', segments: [seg(5_000_000, 2_000_000, { desc: 'sig:endcard' })] }]), end), null);
  assert.equal(endingCard(docWith([{ type: 'video', segments: [seg(8_000_000, 2_000_000, { desc: 'mograph:render' })] }]), end), null);
  assert.equal(endingCard(docWith([{ type: 'audio', segments: [seg(8_000_000, 2_000_000, { desc: 'sig:sfx:endcard' })] }]), end), null);
});

