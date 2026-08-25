import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceToTimeline, detectBrands, talkingHeadScenes, opSignature } from '../src/signature.mjs';

const US = s => Math.round(s * 1e6);

function doc() {
  const face = (tStart, tDur, sStart, sDur, refs = []) => ({
    id: `f${tStart}`, material_id: 'CAM', extra_material_refs: refs,
    target_timerange: { start: US(tStart), duration: US(tDur) },
    source_timerange: { start: US(sStart), duration: US(sDur) },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
  });
  return {
    duration: US(20),
    materials: {
      videos: [{ id: 'CAM', type: 'video', path: '/a/cam.mp4', duration: US(400) }],
      common_mask: [{ id: 'MASK', name: 'Split', config: {} }],
      audios: [], texts: [], speeds: [],
    },
    tracks: [
      { type: 'video', segments: [], id: 't0' },
      { type: 'video', id: 'principal', segments: [
        face(0, 5, 100, 5, ['MASK']),        // split screen
        face(5, 5, 200, 10),                 // full face, 2x speed
        face(10, 4, 300, 4),                 // full face
        face(14, 2, 310, 2, ['MASK']),       // split, and short
        face(16, 4, 320, 4, ['MASK']),
      ] },
      { type: 'audio', id: 'a0', name: '', segments: [] },
    ],
  };
}

test('sourceToTimeline maps a raw-take moment onto the recut timeline', () => {
  const m = sourceToTimeline(doc());
  assert.equal(m(100), 0);           // start of the first clip
  assert.equal(m(102.5), 2.5);       // 1x
  assert.equal(m(205), 7.5);         // 2x speed: 5s of source = 2.5s of screen
  assert.equal(m(302), 12);
});

test('sourceToTimeline returns null for a moment that was cut out', () => {
  const m = sourceToTimeline(doc());
  assert.equal(m(150), null);        // between clips in the source
  assert.equal(m(0), null);
});

test('detectBrands folds Arabic transliteration variants', () => {
  const tr = { segments: [{ start: 0, words: [
    { start: 100.0, word: 'هذا' }, { start: 100.5, word: 'تطبيق' },
    { start: 101.0, word: 'قروك' },                     // qaf spelling
  ] }] };
  const hits = detectBrands(tr, sourceToTimeline(doc()),
    { brands: { grok: { aliases: ['grok', 'جروك'], logo: '/x/grok.png' } } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, 1);
});

test('detectBrands takes the first mention that SURVIVES the cut', () => {
  const tr = { segments: [{ start: 0, words: [
    { start: 7.0, word: 'جروك' },      // an earlier take, not on the timeline
    { start: 102.0, word: 'جروك' },    // the one that is
  ] }] };
  const hits = detectBrands(tr, sourceToTimeline(doc()),
    { brands: { grok: { aliases: ['جروك'], logo: '/x/grok.png' } } });
  assert.equal(hits[0].sourceAt, 102);
  assert.equal(hits[0].at, 2);
});

test('detectBrands reports a brand only once', () => {
  const tr = { segments: [{ start: 0, words: [
    { start: 101, word: 'claude' }, { start: 102, word: 'claude' }, { start: 103, word: 'claude' },
  ] }] };
  const hits = detectBrands(tr, sourceToTimeline(doc()),
    { brands: { claude: { aliases: ['claude'], logo: '/x/c.png' } } });
  assert.equal(hits.length, 1);
});

test('talkingHeadScenes finds unmasked clips only, and skips brief ones', () => {
  const scenes = talkingHeadScenes(doc());
  assert.deepEqual(scenes.map(s => s.start), [5, 10]);
});

test('a face push-in is push-hold-release at his measured 1.15 / 0.23s', () => {
  const d = doc();
  const r = opSignature(d, { zooms: [{ at: 10.4 }] });
  assert.equal(r.zooms[0].to, 1.15);
  assert.equal(r.zooms[0].shape, 'push-hold-release');
  const kl = d.tracks[1].segments[2].common_keyframes[0].keyframe_list;
  assert.equal(kl.length, 4);
  assert.deepEqual(kl.map(k => k.values[0]), [1, 1.15, 1.15, 1]);
  assert.ok(Math.abs((kl[1].time_offset - kl[0].time_offset) / 1e6 - 0.23) < 0.005);
});

test('a push-in maps into SOURCE time, scaled by the clip speed', () => {
  const d = doc();
  opSignature(d, { zooms: [{ at: 6 }] });                   // inside the 2x clip
  const seg = d.tracks[1].segments[1];
  const kl = seg.common_keyframes[0].keyframe_list;
  // 1s into a 2x clip = 2s into the source
  assert.equal(kl[0].time_offset, US(202));
  // and the ramp stays 0.23s ON SCREEN, so 0.46s of source
  assert.ok(Math.abs((kl[1].time_offset - kl[0].time_offset) / 1e6 - 0.46) < 0.01);
  for (const k of kl) {
    assert.ok(k.time_offset >= seg.source_timerange.start
           && k.time_offset <= seg.source_timerange.start + seg.source_timerange.duration);
  }
});

test('a push-in never overwrites an existing zoom', () => {
  const d = doc();
  d.tracks[1].segments[2].common_keyframes = [{ property_type: 'KFTypeScaleX', keyframe_list: [{ time_offset: 0, values: [2] }] }];
  const r = opSignature(d, { zooms: [{ at: 10.4 }] });
  assert.equal(r.zooms[0].skipped, 'already keyframed');
});

test('the endcard lands inside the draft, never one microsecond past it', () => {
  const d = doc();
  d.duration = 52366666;                                    // the real rounding trap
  const r = opSignature(d, { endcard: { text: 'Follow' }, noSfx: true });
  const seg = d.tracks.at(-1).segments[0];
  assert.ok(seg.target_timerange.start + seg.target_timerange.duration <= d.duration,
    `${seg.target_timerange.start + seg.target_timerange.duration} > ${d.duration}`);
  assert.equal(r.endcard.text, 'Follow');
});

test('the endcard pops from 0.01 and carries the text it was given', () => {
  const d = doc();
  opSignature(d, { endcard: { text: 'اشترك' }, noSfx: true });
  const seg = d.tracks.at(-1).segments[0];
  assert.equal(seg.clip.scale.x, 0.01);
  assert.equal(seg.common_keyframes[0].keyframe_list[0].values[0], 0.01);
  assert.equal(JSON.parse(d.materials.texts[0].content).text, 'اشترك');
});

test('signature refuses rather than silently doing nothing', () => {
  assert.throws(() => opSignature(doc(), {}), /NOTHING_TO_SIGN|wrote nothing/);
});

test('a missing logo asset is an error, not a silent skip', () => {
  assert.throws(() => opSignature(doc(), { logos: [{ brand: 'grok', at: 2, logo: '/nope/x.png' }] }),
    /NO_LOGO_ASSET|no logo file/);
});
