import assert from 'node:assert/strict';
import test from 'node:test';

import { ANIMATION_CATALOGUE, animationSlugs, opAnimation } from '../src/animations.mjs';

const US = seconds => Math.round(seconds * 1e6);

function doc() {
  return {
    duration: US(5),
    materials: { material_animations: [] },
    tracks: [{
      id: 'VIDEO-TRACK',
      type: 'video',
      flag: 2,
      name: 'broll',
      segments: [{
        id: 'SEG',
        material_id: 'VIDEO',
        target_timerange: { start: 0, duration: US(5) },
        source_timerange: { start: 0, duration: US(5) },
        extra_material_refs: [],
        common_keyframes: [],
        speed: 1,
        volume: 1,
      }],
    }],
  };
}

test('starter animation catalogue exposes verified intro/outro slugs', () => {
  assert.ok(animationSlugs().includes('fade-in'));
  assert.ok(animationSlugs().includes('fade-out'));
  assert.equal(ANIMATION_CATALOGUE['fade-in'].type, 'in');
  assert.equal(ANIMATION_CATALOGUE['fade-out'].type, 'out');
});

test('opAnimation attaches one native material_animations container with intro and outro', () => {
  const d = doc();
  const out = opAnimation(d, {
    selector: { id: 'SEG' },
    intro: 'fade-in',
    outro: 'fade-out',
    introDuration: 0.4,
    outroDuration: 0.6,
    __seed: 'fixed',
  });

  assert.equal(out.changed, 1);
  assert.equal(d.materials.material_animations.length, 1);
  const container = d.materials.material_animations[0];
  assert.equal(container.type, 'sticker_animation');
  assert.deepEqual(d.tracks[0].segments[0].extra_material_refs, [container.id]);
  assert.equal(container.animations.length, 2);

  const intro = container.animations.find(item => item.type === 'in');
  const outro = container.animations.find(item => item.type === 'out');
  assert.equal(intro.name, 'Fade In');
  assert.equal(intro.duration, US(0.4));
  assert.equal(intro.start, 0);
  assert.equal(outro.name, 'Fade Out');
  assert.equal(outro.duration, US(0.6));
  assert.equal(outro.start, US(4.4));
  assert.equal(intro.material_type, 'video');
  assert.equal(outro.panel, 'video');
});

test('opAnimation is deterministic across root and active-timeline passes', () => {
  const a = doc();
  const b = doc();
  opAnimation(a, { selector: { id: 'SEG' }, intro: 'fade-in', __seed: 'same-seed' });
  opAnimation(b, { selector: { id: 'SEG' }, intro: 'fade-in', __seed: 'same-seed' });
  assert.equal(a.materials.material_animations[0].id, b.materials.material_animations[0].id);
});

test('opAnimation refuses a second animation of the same type unless replace is explicit', () => {
  const d = doc();
  opAnimation(d, { selector: { id: 'SEG' }, intro: 'fade-in', __seed: 'first' });
  assert.throws(
    () => opAnimation(d, { selector: { id: 'SEG' }, intro: 'flash-in', __seed: 'second' }),
    error => error.code === 'ANIMATION_EXISTS'
  );
  opAnimation(d, { selector: { id: 'SEG' }, intro: 'flash-in', replace: true, __seed: 'third' });
  assert.equal(d.materials.material_animations[0].animations.length, 1);
  assert.equal(d.materials.material_animations[0].animations[0].name, 'Flash In');
});

test('opAnimation refuses intro/outro when a combo animation already owns the container', () => {
  const d = doc();
  d.materials.material_animations.push({
    id: 'GROUP',
    type: 'sticker_animation',
    multi_language_current: 'none',
    animations: [{ type: 'group', id: 'GROUP-EFFECT' }],
  });
  d.tracks[0].segments[0].extra_material_refs.push('GROUP');
  assert.throws(
    () => opAnimation(d, { selector: { id: 'SEG' }, intro: 'fade-in' }),
    error => error.code === 'ANIMATION_GROUP_CONFLICT'
  );
});

test('opAnimation validates animation type, duration, and track type', () => {
  const d = doc();
  assert.throws(
    () => opAnimation(d, { selector: { id: 'SEG' }, intro: 'fade-out' }),
    error => error.code === 'ANIMATION_WRONG_TYPE'
  );
  assert.throws(
    () => opAnimation(d, { selector: { id: 'SEG' }, intro: 'fade-in', introDuration: 6 }),
    error => error.code === 'ANIMATION_TOO_LONG'
  );

  const audio = doc();
  audio.tracks[0].type = 'audio';
  assert.throws(
    () => opAnimation(audio, { selector: { id: 'SEG' }, intro: 'fade-in' }),
    error => error.code === 'ANIMATION_BAD_TRACK'
  );
});
