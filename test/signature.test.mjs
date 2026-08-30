import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceToTimeline, detectBrands, talkingHeadScenes, opSignature, imageSize, logoScaleFor } from '../src/signature.mjs';

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

test('detectBrands strips trailing punctuation', () => {
  const tr = { segments: [{ start: 0, words: [{ start: 101.0, word: 'Grok.' }] }] };
  const hits = detectBrands(tr, sourceToTimeline(doc()),
    { brands: { grok: { aliases: ['grok'], logo: '/x/grok.png' } } });
  assert.equal(hits.length, 1);
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

test('Follow sits on the talking head, not on leftover preset clips after it', () => {
  const d = doc();
  d.duration = US(27);
  d.tracks.push({
    type: 'video', id: 'leftover', segments: [{
      id: 'preset', material_id: 'CAM', extra_material_refs: [],
      target_timerange: { start: US(20), duration: US(7) },
      source_timerange: { start: 0, duration: US(7) },
      desc: 'layout:endcard',
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
    }],
  });
  const r = opSignature(d, { endcard: { text: 'Follow' }, noSfx: true });
  assert.ok(r.endcard.at < 20, `Follow at ${r.endcard.at}s landed on the leftover, not the talking head`);
  assert.ok(r.endcard.at + r.endcard.hold <= 20.001, 'Follow must not spill onto the leftover');
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

test('endcard styles[].range is UTF-16 code units, not bytes', () => {
  // 'Follow 🚀' is the only case that pins the SEMANTICS: every BMP string has the same
  // UTF-16 and code-point length, so Array.from(text).length would pass on those alone.
  for (const text of ['Follow', 'جروك', 'اشترك', 'Follow 🚀']) {
    const d = doc();
    opSignature(d, { endcard: { text }, noSfx: true });
    const content = JSON.parse(d.materials.texts[0].content);
    assert.deepEqual(content.styles[0].range, [0, text.length], text);
  }
  assert.equal('Follow 🚀'.length, 9);
  assert.equal([...'Follow 🚀'].length, 8);          // the two must not be interchangeable
});

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

test('imageSize reads PNG IHDR', () => {
  const f = path.join(os.tmpdir(), 'capcutctl-1x1.png');
  fs.writeFileSync(f, PNG_1x1);
  assert.deepEqual(imageSize(f), { width: 1, height: 1 });
});

test('logoScaleFor keeps 0.36 on width-limited assets (the 1280×276 template and a square PNG)', () => {
  assert.ok(Math.abs(logoScaleFor(1280, 276, 0.36) - 0.36) < 1e-9);
  assert.ok(Math.abs(logoScaleFor(975, 936, 0.36) - 0.36) < 1e-9);
});

// The contract: whatever the asset's aspect, it must occupy the same ON-CANVAS WIDTH the
// 1280×276 template did at the requested scale. CapCut fits a material inside the canvas
// and then multiplies by clip.scale, so that width is scale * fit-width.
const onCanvasWidth = (sw, sh, scale, canvas) => scale * sw * Math.min(canvas.width / sw, canvas.height / sh);

test('logoScaleFor compensates when the ratio is genuinely not 1 (tall asset, non-9:16 canvas)', () => {
  const cases = [
    [500, 2000, { width: 1080, height: 1920 }],     // taller than the canvas: height-limited
    [975, 936, { width: 1920, height: 1080 }],      // landscape canvas, square asset
    [1280, 276, { width: 1920, height: 1080 }]
  ];
  for (const [sw, sh, canvas] of cases) {
    const scale = logoScaleFor(sw, sh, 0.36, canvas);
    const want = onCanvasWidth(1280, 276, 0.36, canvas);
    assert.ok(Math.abs(onCanvasWidth(sw, sh, scale, canvas) - want) < 1e-6,
      `${sw}x${sh} on ${canvas.width}x${canvas.height}: ${onCanvasWidth(sw, sh, scale, canvas)} != ${want}`);
  }
  // and the ratio must genuinely move, or `(sw, sh, requested) => requested` would pass
  assert.ok(Math.abs(logoScaleFor(500, 2000, 0.36, { width: 1080, height: 1920 }) - 0.36) > 0.1);
  assert.ok(Math.abs(logoScaleFor(975, 936, 0.36, { width: 1920, height: 1080 }) - 0.36) > 0.1);
});

test('logo material takes PNG pixel size, not the 1280×276 template', () => {
  const f = path.join(os.tmpdir(), 'capcutctl-logo.png');
  fs.writeFileSync(f, PNG_1x1);
  const d = doc();
  d.canvas_config = { width: 1080, height: 1920 };
  opSignature(d, { logos: [{ brand: 'grok', at: 1, logo: f }], noSfx: true });
  const mat = d.materials.videos.find(v => v.path === f);
  assert.equal(mat.width, 1);
  assert.equal(mat.height, 1);
});

test('signature refuses rather than silently doing nothing', () => {
  assert.throws(() => opSignature(doc(), {}), /NOTHING_TO_SIGN|wrote nothing/);
});

test('a missing logo asset is an error, not a silent skip', () => {
  assert.throws(() => opSignature(doc(), { logos: [{ brand: 'grok', at: 2, logo: '/nope/x.png' }] }),
    /NO_LOGO_ASSET|no logo file/);
});

import { layoutAudit } from '../src/layouts.mjs';

test('layoutAudit derives the layout from what is under the clip, not from judgement', () => {
  const d = doc();
  // B-roll covering only the first two principal clips
  d.tracks.splice(1, 0, { type: 'video', id: 'broll', segments: [
    { id: 'b1', material_id: 'CAM', extra_material_refs: [],
      target_timerange: { start: 0, duration: US(10) },
      source_timerange: { start: 0, duration: US(10) }, clip: { scale: { x: 1, y: 1 } } },
  ] });
  const rows = layoutAudit(d);
  assert.deepEqual(rows.map(r => [r.at, r.want]),
    [[0, 'split-screen'], [5, 'split-screen'], [10, 'full-face'], [14, 'full-face'], [16, 'full-face']]);
});

test('layoutAudit flags only the clips whose look disagrees with their B-roll', () => {
  const d = doc();
  d.tracks.splice(1, 0, { type: 'video', id: 'broll', segments: [
    { id: 'b1', material_id: 'CAM', extra_material_refs: [],
      target_timerange: { start: 0, duration: US(10) },
      source_timerange: { start: 0, duration: US(10) }, clip: { scale: { x: 1, y: 1 } } },
  ] });
  const rows = layoutAudit(d);
  // clip 0 is masked and has B-roll -> correct. clip 1 is unmasked but has B-roll -> wrong.
  assert.equal(rows[0].change, false);
  assert.equal(rows[1].change, true);
  // clips 3 and 4 are masked with nothing under them -> wrong
  assert.deepEqual(rows.filter(r => r.change).map(r => r.at), [5, 14, 16]);
});

test('a layout plate does not count as B-roll under the face', () => {
  const d = doc();
  d.materials.videos.push({ id: 'PLATE', type: 'photo', path: '/a/bar.png' });
  d.tracks.splice(1, 0, { type: 'video', id: 'bars', segments: [
    { id: 'p1', material_id: 'PLATE', desc: 'layout:seam-bar', extra_material_refs: [],
      target_timerange: { start: 0, duration: US(20) },
      source_timerange: { start: 0, duration: US(20) }, clip: { scale: { x: 1, y: 1 } } },
  ] });
  assert.ok(layoutAudit(d).every(r => r.brollUnder === false));
});

test('every op gets a deterministic seed, not a whitelisted few', async () => {
  // A per-op whitelist in core meant `signature` minted different ids in the root draft and
  // the timeline, and the two mirrors drifted apart on a real project. The invariant is that
  // the SAME seed produces the SAME ids, so each document's independent pass agrees.
  const { opSignature: run } = await import('../src/signature.mjs');
  const ids = docObj => docObj.tracks.flatMap(t => (t.segments || []).map(s => s.id))
    .concat(docObj.materials.texts.map(m => m.id));
  const a = doc(); const b = doc();
  run(a, { endcard: { text: 'Follow' }, noSfx: true, __seed: 'fixed-seed' });
  run(b, { endcard: { text: 'Follow' }, noSfx: true, __seed: 'fixed-seed' });
  assert.deepEqual(ids(a), ids(b));

  const c = doc();
  run(c, { endcard: { text: 'Follow' }, noSfx: true, __seed: 'other-seed' });
  assert.notDeepEqual(ids(c), ids(a));
});

test('zoom does not delete the endcard it never wrote', () => {
  // 11 tracks in, 9 out: opSignature wiped every sig:* segment before writing anything,
  // so `capcutctl zoom --auto` silently took the endcard and its Culin cue with it —
  // and `doctor` stayed clean, because the file was still structurally valid.
  const d = doc();
  opSignature(d, { endcard: { text: 'Follow' } });
  const endcards = () => d.tracks.flatMap(t => t.segments || [])
    .filter(x => (x.desc || '').startsWith('sig:endcard')).length;
  assert.equal(endcards(), 1, 'endcard was written');

  opSignature(d, { zooms: [{ at: 10.4 }] });                 // zoom writes no endcard
  assert.equal(endcards(), 1, 'endcard survives a zoom-only pass');
});

test('an endcard-only rerun clears the legacy untagged cue on the same beat', () => {
  // Cues written before SFX carried an owner are tagged plain `sig:sfx`, which only a pass
  // rewriting BOTH owners may clear wholesale. So `capcutctl endcard` on a project written
  // by an older version wrote its fresh sig:sfx:endcard cue and left the legacy one right
  // beside it — two Culins on one beat.
  const d = doc();
  opSignature(d, { endcard: { text: 'Follow' } });
  const cues = () => d.tracks.flatMap(t => t.segments || [])
    .filter(x => (x.desc || '').startsWith('sig:sfx'));
  assert.equal(cues().length, 1, 'the endcard cue was written');

  // age the project: strip the attribution the way an older capcutctl left it
  for (const s of cues()) s.desc = 'sig:sfx';

  opSignature(d, { endcard: { text: 'Follow' } });
  const after = cues();
  assert.equal(after.length, 1, 'the legacy cue on this beat was swept, not doubled');
  assert.equal(after[0].desc, 'sig:sfx:endcard');
});

test('the sweep is keyed on the beat, so an unrelated legacy cue survives', () => {
  const d = doc();
  opSignature(d, { endcard: { text: 'Follow' } });
  const lane = d.tracks.find(t => t.name === 'sig-sfx');
  const elsewhere = { ...structuredClone(lane.segments[0]), id: 'LEGACY-ELSEWHERE', desc: 'sig:sfx',
    target_timerange: { start: US(2), duration: US(0.5) } };
  lane.segments.push(elsewhere);

  opSignature(d, { endcard: { text: 'Follow' } });
  const kept = d.tracks.flatMap(t => t.segments || []).filter(x => x.id === 'LEGACY-ELSEWHERE');
  assert.equal(kept.length, 1, 'a cue on a beat this pass does not touch is left alone');
});
