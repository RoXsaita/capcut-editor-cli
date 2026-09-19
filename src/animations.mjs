import os from 'node:os';
import path from 'node:path';

import { CapcutError, clone, seededId, selectSegments } from './core.mjs';

const US = seconds => Math.round(Number(seconds) * 1e6);
const S = microseconds => Number(microseconds) / 1e6;

export const ANIMATION_CATALOGUE = Object.freeze({
  'fade-in': Object.freeze({
    name: 'Fade In',
    effectId: '6798320778182922760',
    resourceId: '6798320778182922760',
    md5: '883ad04bd79b502aaa55b5d9b87175ea',
    categoryId: '2037708296',
    thirdResourceId: '6798320778182922760',
    type: 'in',
    durationUs: 500000,
  }),
  'flash-in': Object.freeze({
    name: 'Flash In',
    effectId: '7211044701367964162',
    resourceId: '7211044701367964162',
    md5: '6a680c49cd11a05f3eb0e5a3fed165f7',
    categoryId: '2037708312',
    thirdResourceId: '7211044701367964162',
    type: 'in',
    durationUs: 433333,
  }),
  'pulsing-zooms': Object.freeze({
    name: 'Pulsing Zooms',
    effectId: '7530463994486820097',
    resourceId: '7530463994486820097',
    md5: 'c2223de4486ee5b2a5900d707e9a362b',
    categoryId: '2037708296',
    thirdResourceId: '0',
    type: 'in',
    durationUs: 3000000,
  }),
  'scroll-up': Object.freeze({
    name: 'Scroll up',
    effectId: '7315336764636271105',
    resourceId: '7315336764636271105',
    md5: 'cb8899ed512a2d40bd27d9e03d039ec0',
    categoryId: 'in_fav',
    thirdResourceId: '7315336764636271105',
    type: 'in',
    durationUs: 1200000,
  }),
  'stripe-merge': Object.freeze({
    name: 'Stripe Merge',
    effectId: '7570497406203251973',
    resourceId: '7570497406203251973',
    md5: 'fc08875f779dae706387fb160dbaa898',
    categoryId: '2037708296',
    thirdResourceId: '0',
    type: 'in',
    durationUs: 633333,
  }),
  'zoom-out': Object.freeze({
    name: 'Zoom Out',
    effectId: '6798332584276267527',
    resourceId: '6798332584276267527',
    md5: '0c736f993d36a7b1ef00cc73d2ba656f',
    categoryId: '',
    thirdResourceId: '',
    type: 'in',
    durationUs: 2000000,
  }),
  'fade-out': Object.freeze({
    name: 'Fade Out',
    effectId: '6798320902548230669',
    resourceId: '6798320902548230669',
    md5: 'c6f05ce62355b537be762550040bfc08',
    categoryId: '2037708296',
    thirdResourceId: '0',
    type: 'out',
    durationUs: 500000,
  }),
  'blur-out': Object.freeze({
    name: 'Blur Out',
    effectId: '7507514531212479761',
    resourceId: '7507514531212479761',
    md5: '78d0826a4aba60259f37acb30149b258',
    categoryId: 'out_fav',
    thirdResourceId: '0',
    type: 'out',
    durationUs: 1000000,
  }),
  smoke: Object.freeze({
    name: 'Smoke',
    effectId: '7229983825080619522',
    resourceId: '7229983825080619522',
    md5: 'e70e26e7aa770d0deedca54e3eac0323',
    categoryId: 'out_fav',
    thirdResourceId: '7229983825080619522',
    type: 'out',
    durationUs: 900000,
  }),
});

export function animationSlugs() {
  return Object.keys(ANIMATION_CATALOGUE);
}

function cachePath(meta) {
  return path.join(
    os.homedir(),
    'Library/Containers/com.lemon.lvoverseas/Data/Movies/CapCut/User Data/Cache/effect',
    meta.effectId,
    meta.md5
  );
}

function materialArray(doc) {
  return (doc.materials.material_animations ||= []);
}

function findContainer(doc, segment) {
  const byId = new Map(materialArray(doc).map(material => [material.id, material]));
  for (const id of segment.extra_material_refs || []) {
    const material = byId.get(id);
    if (material) return material;
  }
  return null;
}

function ensureContainer(doc, segment, seed) {
  const existing = findContainer(doc, segment);
  if (existing) {
    if (!Array.isArray(existing.animations)) existing.animations = [];
    return existing;
  }
  const container = {
    animations: [],
    id: seededId(seed, `animation:container:${segment.id}`),
    multi_language_current: 'none',
    type: 'sticker_animation',
  };
  materialArray(doc).push(container);
  segment.extra_material_refs ||= [];
  segment.extra_material_refs.push(container.id);
  return container;
}

function animationFor(slug, expectedType, duration, segmentDuration) {
  const meta = ANIMATION_CATALOGUE[slug];
  if (!meta) {
    throw new CapcutError(`Unknown animation "${slug}". Available: ${animationSlugs().join(', ')}.`, {
      code: 'ANIMATION_UNKNOWN', exitCode: 2
    });
  }
  if (meta.type !== expectedType) {
    throw new CapcutError(`${slug} is a ${meta.type === 'in' ? 'intro' : 'outro'} animation, not ${expectedType === 'in' ? 'an intro' : 'an outro'}.`, {
      code: 'ANIMATION_WRONG_TYPE', exitCode: 2
    });
  }
  const durationUs = duration == null ? meta.durationUs : US(duration);
  if (!Number.isFinite(durationUs) || durationUs <= 0) {
    throw new CapcutError('Animation duration must be greater than zero.', { code: 'ANIMATION_BAD_DURATION', exitCode: 2 });
  }
  if (durationUs > segmentDuration) {
    throw new CapcutError(`Animation duration ${S(durationUs).toFixed(3)}s exceeds clip duration ${S(segmentDuration).toFixed(3)}s.`, {
      code: 'ANIMATION_TOO_LONG', exitCode: 2
    });
  }
  const start = expectedType === 'out' ? segmentDuration - durationUs : 0;
  return {
    anim_adjust_params: null,
    category_id: meta.categoryId,
    category_name: meta.categoryId,
    duration: durationUs,
    id: meta.effectId,
    material_type: 'video',
    name: meta.name,
    panel: 'video',
    path: cachePath(meta),
    platform: 'all',
    request_id: '',
    resource_id: meta.resourceId,
    source_platform: 1,
    start,
    third_resource_id: meta.thirdResourceId,
    type: expectedType,
  };
}

function addOne(container, segment, slug, type, duration, replace) {
  if (!slug) return null;
  const existingIndex = (container.animations || []).findIndex(animation => animation?.type === type);
  if (existingIndex >= 0 && !replace) {
    throw new CapcutError(`Segment ${segment.id} already has a ${type === 'in' ? 'intro' : 'outro'} animation. Pass --replace-existing to replace it.`, {
      code: 'ANIMATION_EXISTS', exitCode: 2
    });
  }
  const animation = animationFor(slug, type, duration, segment.target_timerange.duration);
  if (existingIndex >= 0) container.animations.splice(existingIndex, 1, animation);
  else container.animations.push(animation);
  return {
    type,
    slug,
    name: animation.name,
    duration: S(animation.duration),
    start: S(animation.start),
    cachedPath: animation.path,
  };
}

export function opAnimation(doc, op = {}) {
  const selected = selectSegments(doc, op.selector || {});
  if (!selected.length) {
    throw new CapcutError(`animation.apply: no segment matched ${JSON.stringify(op.selector || {})}.`, {
      code: 'SELECTOR_EMPTY', exitCode: 2
    });
  }
  if (selected.length > 1 && op.all !== true) {
    throw new CapcutError(`animation.apply: selector matched ${selected.length} segments; use a unique selector.`, {
      code: 'SELECTOR_AMBIGUOUS', exitCode: 2
    });
  }
  if (!op.intro && !op.outro) {
    throw new CapcutError('animation.apply requires intro and/or outro.', { code: 'ANIMATION_EMPTY', exitCode: 2 });
  }

  const results = [];
  for (const { segment, track } of selected) {
    if (track.type !== 'video') {
      throw new CapcutError(`Native clip animations require a video/image segment; ${segment.id} is on a ${track.type} track.`, {
        code: 'ANIMATION_BAD_TRACK', exitCode: 2
      });
    }
    if (!segment.target_timerange?.duration) {
      throw new CapcutError(`Segment ${segment.id} has no positive target duration.`, { code: 'ANIMATION_BAD_SEGMENT', exitCode: 2 });
    }
    const seed = op.__seed || `animation:${segment.id}`;
    const container = ensureContainer(doc, segment, seed);
    const added = [];
    const intro = addOne(container, segment, op.intro, 'in', op.introDuration, Boolean(op.replace));
    const outro = addOne(container, segment, op.outro, 'out', op.outroDuration, Boolean(op.replace));
    if (intro) added.push(intro);
    if (outro) added.push(outro);
    results.push({ id: segment.id, material: container.id, animations: added });
  }
  return { changed: results.length, segments: results };
}
