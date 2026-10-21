import './helpers/sfx-fixture.mjs';   // repoint the SFX palette off this machine — must come first
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { principalTrack, sliceAt, planPolish, pictureChanges, cutPoints, seamVariety, isCalloutPlate, calloutPlates, opCalloutSfx, opPolish, brollWindows, mapVtToTimeline, planInteractions, opInteractions, coldOpen } from '../src/polish.mjs';

/** Every pair of segments a single track carries, in time order, that share any time. */
function overlaps(d) {
  const bad = [];
  for (const t of d.tracks) {
    const ordered = [...(t.segments || [])]
      .filter(s => s.target_timerange)
      .sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1].target_timerange;
      if (prev.start + prev.duration > ordered[i].target_timerange.start) {
        bad.push(`${t.name || t.id}: ${ordered[i - 1].id} / ${ordered[i].id}`);
      }
    }
  }
  return bad;
}

const US = s => Math.round(s * 1e6);
const seg = (start, dur, srcStart = 0, extra = {}) => ({
  id: `s${start}`, material_id: 'M',
  target_timerange: { start: US(start), duration: US(dur) },
  source_timerange: { start: US(srcStart), duration: US(dur) },
  extra_material_refs: [], clip: { scale: { x: 1, y: 1 } }, ...extra,
});
const track = (type, segments) => ({ type, segments, id: 't' });

/** The Hermes-agent shape: B-roll with a hole, a gapless face above it, plates on top. */
function doc() {
  return {
    duration: US(30),
    materials: {
      videos: [{ id: 'M', type: 'video' }, { id: 'PLATE', type: 'photo' }],
      common_mask: [{ id: 'K', config: { centerY: 0.5 } }]
    },
    tracks: [
      { ...track('video', []), flag: 0 },                                   // 0: main, empty
      track('video', [seg(0, 5), seg(5, 5), seg(20, 10)]),                  // 1: B-roll, gap 10-20
      track('video', [seg(0, 12, 100), seg(12, 18, 200)]),                  // 2: the face, gapless
      track('video', [seg(0, 8, 0, { material_id: 'PLATE', desc: 'layout:seam-bar' })]),
    ],
  };
}

test('principalTrack picks the gapless full-span track, not the busiest', () => {
  assert.equal(principalTrack(doc()).index, 2);
});

test('principalTrack prefers the highest index when several qualify', () => {
  const d = doc();
  d.tracks.push(track('video', [seg(0, 15), seg(15, 15)]));
  assert.equal(principalTrack(d).index, 4);
});

test('principalTrack refuses when nothing is continuous', () => {
  const d = doc();
  d.tracks = [d.tracks[0], d.tracks[1], d.tracks[3]];
  assert.throws(() => principalTrack(d), /NO_PRINCIPAL_TRACK|no principal track/);
});

test('principalTrack honours an explicit override', () => {
  assert.equal(principalTrack(doc(), 1).index, 1);
});

test('a single continuous talking-head clip is still the principal', () => {
  const d = doc();
  d.tracks[2].segments = [seg(0, 30, 100)];
  assert.equal(principalTrack(d).index, 2);
});

test('a seam-bar stacked above the face is not the principal', () => {
  const d = doc();
  d.tracks.push(track('video', [
    seg(0, 15, 0, { material_id: 'PLATE', desc: 'layout:seam-bar' }),
    seg(15, 15, 0, { material_id: 'PLATE', desc: 'layout:seam-bar' }),
  ]));
  assert.equal(principalTrack(d).index, 2);
});

test('an endcard after the face does not disqualify the talking head', () => {
  const d = doc();
  d.duration = US(48);
  d.tracks[2].segments = [seg(0, 40, 100)];
  d.tracks.push(track('video', [seg(40, 8, 0, { material_id: 'PLATE', desc: 'sig:endcard' })]));
  assert.equal(principalTrack(d).index, 2);
});

test('sliceAt splits frame-continuously and keeps the timeline gapless', () => {
  const d = doc();
  const t = d.tracks[2];
  assert.equal(sliceAt(d, t, 6, 'k'), 'split');
  assert.equal(t.segments.length, 3);
  const [a, b] = t.segments;
  assert.equal(a.target_timerange.duration, US(6));
  assert.equal(b.target_timerange.start, US(6));
  // the cut must not skip or repeat a frame of source
  assert.equal(a.source_timerange.start + a.source_timerange.duration, b.source_timerange.start);
  // and the track must still be gapless
  let cursor = 0;
  for (const s of t.segments) {
    assert.equal(s.target_timerange.start, cursor);
    cursor += s.target_timerange.duration;
  }
});

test('sliceAt maps source through a speed change', () => {
  const d = doc();
  const t = track('video', [seg(0, 10, 0)]);
  t.segments[0].source_timerange.duration = US(20);     // 2x speed
  d.tracks.push(t);
  sliceAt(d, t, 4, 'k');
  assert.equal(t.segments[0].source_timerange.duration, US(8));
  assert.equal(t.segments[1].source_timerange.start, US(8));
  assert.equal(t.segments[1].source_timerange.duration, US(12));
});

test('sliceAt clones extra materials so the halves do not share a mask', () => {
  const d = doc();
  const t = d.tracks[2];
  t.segments[0].extra_material_refs = ['K'];
  sliceAt(d, t, 6, 'k');
  const [a, b] = t.segments;
  assert.notEqual(a.extra_material_refs[0], b.extra_material_refs[0]);
  assert.equal(d.materials.common_mask.length, 2);
  assert.deepEqual(d.materials.common_mask[1].config, d.materials.common_mask[0].config);
});

test('sliceAt reports an existing boundary instead of cutting twice', () => {
  const d = doc();
  assert.equal(sliceAt(d, d.tracks[2], 12, 'k'), 'existing');
  assert.equal(d.tracks[2].segments.length, 2);
});

test('sliceAt refuses a keyframed segment rather than rescaling its animation', () => {
  const d = doc();
  d.tracks[2].segments[0].common_keyframes = [{ keyframe_list: [{ time_offset: 0 }] }];
  assert.equal(sliceAt(d, d.tracks[2], 6, 'k'), 'keyframed');
  assert.equal(d.tracks[2].segments.length, 2);
});

/**
 * GrokBuild-20260825 put the identical Horizontal Triptych + Woosh on 18 of its 24 seams,
 * because every scene changed layout and `sweep` was exempt from the never-twice-running
 * rule. Identical seams are the loudest tell that a machine made the edit.
 */
function everySceneChangesLayout(scenes = 10) {
  const face = [], bars = [];
  for (let i = 0; i < scenes; i++) {
    face.push(seg(i * 2, 2, i * 2));
    bars.push({ ...seg(i * 2, 2), id: `bar${i}`, desc: 'layout:seam-bar' });
  }
  return {
    duration: US(scenes * 2),
    materials: { videos: [{ id: 'M', type: 'video' }] },
    tracks: [track('video', []), track('video', bars), track('video', face)],
  };
}

test('a layout change on every cut still alternates its sweep', () => {
  const plan = planPolish(everySceneChangesLayout());
  assert.ok(plan.length >= 6, `expected several cuts, got ${plan.length}`);
  for (let i = 1; i < plan.length; i++) {
    assert.notEqual(plan[i].pair, plan[i - 1].pair,
      `cut ${i} at ${plan[i].t}s repeats "${plan[i].pair}"`);
  }
  assert.ok(new Set(plan.map(c => c.pair)).size >= 2);
});

test('the last cut is a normal seam, not a cashier ding', () => {
  const d = everySceneChangesLayout(12); // 24s, would have tripped the old duration>20 payoff
  const plan = planPolish(d);
  assert.ok(plan.length >= 2);
  assert.notEqual(plan.at(-1).pair, 'payoff');
  assert.equal(/cashier/i.test(plan.at(-1).sfx || ''), false);
});

test('isCalloutPlate matches arrows/rects/circles and skips layout plates', () => {
  const seg = {};
  assert.equal(isCalloutPlate({ path: '/x/rect-16-9-1080x608.gif' }, seg), true);
  assert.equal(isCalloutPlate({ path: '/x/rectangle (1).gif' }, seg), true);
  assert.equal(isCalloutPlate({ path: '/x/arrow (1).gif' }, seg), true);
  assert.equal(isCalloutPlate({ path: '/x/circle-1080x1080.gif' }, seg), true);
  assert.equal(isCalloutPlate({ path: '/x/suheilai-rect-indigo-1080x1920 (2).png' }, seg), false);
  assert.equal(isCalloutPlate({ path: '/x/suheilai-circle-white-1080x1920.png' }, seg), false);
  assert.equal(isCalloutPlate({ path: '/x/grok.png' }, { desc: 'sig:logo' }), false);
  assert.equal(isCalloutPlate({ path: '/x/rect-16-9-1080x608.gif' }, { desc: 'layout:seam-bar' }), false);
});

test('opCalloutSfx places alternating enter/select clicks on callout appearances', () => {
  const d = {
    duration: US(30),
    materials: {
      videos: [
        { id: 'M', type: 'video', path: '/cam.mp4' },
        { id: 'R', type: 'gif', path: '/x/rect-16-9-1080x608.gif' },
        { id: 'A', type: 'gif', path: '/x/arrow (1).gif' },
        { id: 'BAR', type: 'photo', path: '/x/suheilai-rect-indigo-1080x1920 (2).png' },
      ],
      audios: [],
    },
    tracks: [
      track('video', [seg(0, 30, 0)]),
      track('video', [
        { ...seg(4, 2), id: 'rect', material_id: 'R' },
        { ...seg(10, 2), id: 'arrow', material_id: 'A' },
        { ...seg(0, 8), id: 'bar', material_id: 'BAR', desc: 'layout:seam-bar' },
      ]),
    ],
  };
  assert.deepEqual(calloutPlates(d).map(c => c.t), [4, 10]);
  const r = opCalloutSfx(d, { __seed: 'CALLOUT' });
  assert.equal(r.changed, 2);
  assert.equal(r.cues[0].sfx, 'Enter / click / select sound (picon)(890901)');
  assert.equal(r.cues[1].sfx, 'Enter / Click / Select sound');
  const lane = d.tracks.find(t => t.name === 'polish-callout');
  assert.equal(lane.segments.length, 2);
  assert.equal(lane.segments[0].desc, 'polish:callout');
  assert.equal(lane.segments[0].target_timerange.start, US(4));
  opCalloutSfx(d, { __seed: 'CALLOUT' });
  assert.equal(lane.segments.length, 2, 're-run replaces rather than stacks');
});

test('seamVariety reports a lopsided seam vocabulary without enforcing it', () => {
  assert.equal(seamVariety([]).lopsided, false);
  const same = Array.from({ length: 10 }, () => ({ transition: 'Horizontal Triptych' }));
  const lop = seamVariety(same);
  assert.equal(lop.lopsided, true);
  assert.equal(lop.topShare, 1);
  assert.equal(lop.distinct, 1);
  const mixed = seamVariety([...same.slice(0, 4),
    ...Array.from({ length: 6 }, (_, i) => ({ transition: `T${i}` }))]);
  assert.equal(mixed.lopsided, false);
});

test('a callout click never lands on top of the seam woosh it triggered', () => {
  // A callout APPEARING is a cut, so opPolish had already put a seam cue at
  // [t - lead, t - lead + dur] — a window that always contains t — and the click went onto
  // the same polish-sfx track at exactly t. Two TRACK_OVERLAP warnings out of doctor, and a
  // single track holding two sounds at once, which the CapCut UI cannot make.
  const d = doc();
  d.materials.videos.push({ id: 'RECT', type: 'gif', path: '/x/rect-16-9-1080x608.gif' });
  d.tracks.push(track('video', [
    { ...seg(4, 2), id: 'rect1', material_id: 'RECT' },
    { ...seg(10, 2), id: 'rect2', material_id: 'RECT' },
  ]));

  opPolish(d, { __seed: 'LANES' });

  const seams = d.tracks.find(t => t.name === 'polish-sfx');
  const clicks = d.tracks.find(t => t.name === 'polish-callout');
  assert.ok(clicks, 'clicks got their own lane');
  assert.equal(clicks.segments.length, 2);
  assert.ok(seams.segments.length >= 2);
  assert.deepEqual([...new Set(seams.segments.map(s => s.desc))], ['polish:sfx']);
  assert.deepEqual([...new Set(clicks.segments.map(s => s.desc))], ['polish:callout']);
  assert.deepEqual(overlaps(d), []);
});

test('noSfx keeps transitions but removes generated cues and preserves manual audio', () => {
  const d = doc();
  d.materials.videos.push({ id: 'RECT', type: 'gif', path: '/x/rect-16-9-1080x608.gif' });
  d.tracks.push(track('video', [{ ...seg(4, 2), material_id: 'RECT' }]));
  opPolish(d, { __seed: 'WITH_SOUND' });
  const lane = d.tracks.find(t => t.name === 'polish-sfx');
  assert.ok(lane.segments.length > 0);
  const cue = lane.segments[0];
  for (const desc of ['polish:click', 'polish:type', 'manual sound']) {
    lane.segments.push({ ...structuredClone(cue), id: desc, desc });
  }
  const result = opPolish(d, { __seed: 'SILENT', noSfx: true });
  assert.ok(result.transitions > 0);
  assert.equal(result.sfx, 0);
  assert.deepEqual(result.callouts, []);
  assert.deepEqual(result.interactions, []);
  const audio = d.tracks.filter(t => t.type === 'audio').flatMap(t => t.segments);
  assert.deepEqual(audio.map(s => s.desc), ['manual sound']);
  const fresh = doc();
  opPolish(fresh, { noSfx: true });
  assert.equal(fresh.tracks.some(t => t.type === 'audio'), false);
});

test('two callouts closer together than the click is long do not stack either', () => {
  const d = doc();
  d.materials.videos.push({ id: 'RECT', type: 'gif', path: '/x/rect-16-9-1080x608.gif' });
  d.tracks.push(track('video', [
    { ...seg(4, 0.4), id: 'rect1', material_id: 'RECT' },
    { ...seg(4.4, 1), id: 'rect2', material_id: 'RECT' },   // the click sound is ~1.0s long
  ]));
  opCalloutSfx(d, { __seed: 'TIGHT' });
  const clicks = d.tracks.find(t => t.name === 'polish-callout');
  assert.equal(clicks.segments.length, 2);
  assert.equal(clicks.segments[0].target_timerange.duration, US(0.4));
  assert.deepEqual(overlaps(d), []);
});

test('the callout lane is not left behind empty when the last callout goes', () => {
  const d = doc();
  d.materials.videos.push({ id: 'RECT', type: 'gif', path: '/x/rect-16-9-1080x608.gif' });
  const plates = track('video', [{ ...seg(4, 2), id: 'rect1', material_id: 'RECT' }]);
  d.tracks.push(plates);
  opCalloutSfx(d, { __seed: 'GONE' });
  assert.ok(d.tracks.find(t => t.name === 'polish-callout'));
  plates.segments = [];
  const r = opCalloutSfx(d, { __seed: 'GONE' });
  assert.equal(r.changed, 0);
  assert.equal(d.tracks.find(t => t.name === 'polish-callout'), undefined);
});

test('--no-transitions still plans seams on a draft with no principal track', () => {
  // `--no-transitions` is the escape hatch for exactly this shape, but planPolish had begun
  // resolving the principal unconditionally to power its layout-change test, so the escape
  // hatch threw NO_PRINCIPAL_TRACK instead of returning a plan.
  const d = doc();
  d.tracks = [d.tracks[0], track('video', [seg(2, 5), seg(7, 5)]), d.tracks[3]];
  assert.throws(() => principalTrack(d), /NO_PRINCIPAL_TRACK|no principal track/);

  const plan = planPolish(d, { noTransitions: true });
  assert.deepEqual(plan.map(c => c.t), [2, 7]);
  assert.equal(plan.every(c => c.pair !== 'sweep' && c.pair !== 'sweepL'), true,
    'no principal means no readable layout, so nothing claims to be a layout change');
  assert.doesNotThrow(() => pictureChanges(d));
});

test('a real clip whose filename says "arrow" is footage, not a callout', () => {
  const s = {};
  assert.equal(isCalloutPlate({ type: 'video', path: '/x/arrow-keys-demo.mp4' }, s), false);
  assert.equal(isCalloutPlate({ path: '/x/arrow-keys-demo.mp4' }, s), false, 'untyped, but still .mp4');
  assert.equal(isCalloutPlate({ type: 'video', path: '/x/circle-b-roll.mov' }, s), false);
  // `clip.add` stamps everything type:'video', so the type must NOT be what disqualifies it
  assert.equal(isCalloutPlate({ type: 'video', path: '/x/rect-16-9-1080x608.gif' }, s), true);
  assert.equal(isCalloutPlate({ type: 'gif', path: '/x/rect-16-9-1080x608.gif' }, s), true);
});

test('mapVtToTimeline follows chopped B-roll, including speed, and drops a skipped gap', () => {
  const d = doc();
  d.materials.videos[0].path = '/takes/windows-2/screen.mp4';
  d.tracks[1].segments = [
    seg(0, 5, 10, { desc: 'broll:a' }),             // src 10-15 at 1x → t 0-5
    seg(5, 5, 20, { desc: 'broll:b' }),             // src 20-25 at 1x → t 5-10
  ];
  const w = brollWindows(d);
  assert.equal(mapVtToTimeline(w, 12), 2);
  assert.equal(mapVtToTimeline(w, 22), 7);
  assert.equal(mapVtToTimeline(w, 17), null, '17s was cut out of the B-roll');
  d.tracks[1].segments[0].source_timerange = { start: US(10), duration: US(10) }; // 10-20 in 5s = 2x
  const w2 = brollWindows(d);
  assert.equal(mapVtToTimeline(w2, 14), 2);
});

test('planInteractions maps in-capture clicks through B-roll and skips the recorder chrome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl2-'));
  const take = path.join(dir, '.capcutctl', 'rl2', 'windows-2');
  fs.mkdirSync(take, { recursive: true });
  const events = [
    { type: 'click', host: 100, in_capture: true },
    { type: 'click', host: 100, in_capture: false },
    { type: 'typing_burst', host: 104, end: 105, count: 8 },
    { type: 'click', host: 200, in_capture: true },
  ];
  fs.writeFileSync(path.join(take, 'trace.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(take, 'session.json'), JSON.stringify({ start_host: 90, clock: { first_frame_host: 90 } }));
  const d = doc();
  d.materials.videos[0].path = path.join(dir, 'Resources', 'CapcutctlMedia', 'windows-2__screen.mp4');
  d.tracks[1].segments = [seg(0, 20, 0, { desc: 'broll:ui' })];   // src 0-20 at 1x
  const plan = planInteractions(d, { projectDir: dir });
  assert.deepEqual(plan.map(c => [c.t, c.kind]), [[10, 'click'], [14, 'type']]);
  const r = opInteractions(d, { __seed: 'I' }, { projectDir: dir });
  assert.equal(r.changed, 2);
  const lane = d.tracks.find(t => t.name === 'polish-interact');
  assert.equal(lane.segments.length, 2);
  assert.deepEqual(lane.segments.map(s => s.desc), ['polish:click', 'polish:type']);
});

test('coldOpen flags a 5s full-face start with no screen, and is quiet when B-roll covers it', () => {
  const d = doc();
  d.tracks[1].segments = [];                          // no B-roll
  d.tracks[2].segments = [seg(0, 30, 0, { enable_video_mask: false })];
  const miss = coldOpen(d);
  assert.ok(miss, miss);
  assert.equal(miss.layout, 'full-face');
  d.tracks[1].segments = [seg(0, 8, 0, { desc: 'broll:payoff' })];
  assert.equal(coldOpen(d), null);
});

test('screen recording is visible footage for picture changes and cold-open coverage, not its helper layers', () => {
  const d = doc();
  d.materials.videos.push({ id: 'SCREEN', type: 'video', path: '/takes/window__screen.mp4' });
  const screen = { ...seg(0, 8), id: 'SCREEN-FOOTAGE', material_id: 'SCREEN', desc: 'layout:screen-recording' };
  const frame = { ...seg(0, 8), id: 'SCREEN-FRAME', material_id: 'SCREEN', desc: 'layout:screen-frame' };
  d.tracks[1].segments = [screen, frame];
  assert.equal(brollWindows(d).some(window => window.id === 'SCREEN-FOOTAGE'), true);
  assert.equal(brollWindows(d).some(window => window.id === 'SCREEN-FRAME'), false);
  assert.equal(coldOpen(d), null, 'screen footage covers the opening even though its frame helper is present');

  const changed = doc();
  changed.materials.videos.push({ id: 'SCREEN', type: 'video', path: '/takes/window__screen.mp4' });
  changed.tracks[1].segments = [{ ...seg(5, 5), id: 'SCREEN-FOOTAGE', material_id: 'SCREEN', desc: 'layout:screen-recording' }];
  assert.equal(pictureChanges(changed).some(mark => mark.t === 5), true,
    'the visible recording start is a picture change');
  assert.equal(pictureChanges({ ...changed, tracks: changed.tracks.map(track => ({
    ...track, segments: track.segments.map(segment => segment.desc === 'layout:screen-recording'
      ? { ...segment, desc: 'layout:screen-frame' } : segment)
  })) }).some(mark => mark.t === 5), false,
  'a helper overlay alone is not footage');
});

test('explicit screen footage above the principal counts as proof and wins its layer', () => {
  const d = doc();
  d.materials.videos.push({ id: 'SCREEN', type: 'video', path: '/takes/window__screen.mp4' });
  d.tracks[1].segments = [];
  d.tracks[3].segments = [{ ...seg(0, 8), id: 'SCREEN-ABOVE', material_id: 'SCREEN', desc: 'layout:screen-recording upper take' }];

  assert.equal(brollWindows(d).some(window => window.id === 'SCREEN-ABOVE'), true);
  assert.equal(coldOpen(d), null, 'marked footage above the face proves the opening');

  const layered = doc();
  layered.materials.videos.push({ id: 'SCREEN', type: 'video', path: '/takes/window__screen.mp4' });
  layered.tracks[3].segments = [{ ...seg(0, 8), id: 'SCREEN-ABOVE', material_id: 'SCREEN', desc: 'layout:screen-recording upper take' }];
  assert.equal(pictureChanges(layered).some(mark => mark.t === 5), false,
    'a lower B-roll cut under the upper screen recording is not visible');

  const changed = doc();
  changed.materials.videos.push({ id: 'SCREEN', type: 'video', path: '/takes/window__screen.mp4' });
  changed.tracks[1].segments = [];
  changed.tracks[3].segments = [{ ...seg(5, 5), id: 'SCREEN-ABOVE', material_id: 'SCREEN', desc: 'layout:screen-recording upper take' }];
  assert.equal(pictureChanges(changed).some(mark => mark.t === 5), true,
    'the start of marked upper footage is a visible picture change');
});

test('mograph, scene, transparent, hidden, and disabled layers never count as B-roll proof', () => {
  const d = doc();
  d.materials.videos.push(
    { id: 'SCREEN', type: 'video', path: '/takes/window__screen.mp4' },
    { id: 'SCENE', type: 'video', path: '/renders/scene.mov', capcutctl_mograph: { scene: true } },
  );
  d.tracks[1].segments = [];
  const alphaZero = { ...seg(0, 8), id: 'ALPHA-ZERO', material_id: 'SCREEN', desc: 'layout:screen-recording alpha zero', clip: { alpha: 0 } };
  d.tracks[3].segments = [
    { ...seg(0, 8), id: 'MOGRAPH', material_id: 'SCENE', desc: 'mograph:scene' },
    { ...seg(0, 8), id: 'SCENE-MISLABEL', material_id: 'SCENE', desc: 'layout:screen-recording scene' },
    alphaZero,
    { ...seg(0, 8), id: 'DIRECTOR-STAGE', material_id: 'SCREEN', desc: 'layout:director-stage' },
  ];
  d.tracks.push({ ...track('video', [{ ...seg(0, 8), id: 'HIDDEN', material_id: 'SCREEN', desc: 'layout:screen-recording hidden' }]), hidden: true });
  d.tracks.push({ ...track('video', [{ ...seg(0, 8), id: 'DISABLED', material_id: 'SCREEN', desc: 'layout:screen-recording disabled' }]), flag: 0 });

  assert.deepEqual(brollWindows(d), []);
  assert.ok(coldOpen(d), 'none of the non-footage layers covers the full-face opening');

  d.tracks[3].segments.push({ ...alphaZero, id: 'ALPHA-ZERO-LATE', target_timerange: { start: US(5), duration: US(3) } });
  assert.equal(pictureChanges(d).some(mark => mark.t === 5), false,
    'a transparent marked segment does not create a visible picture change');
});

test('RL2 interaction sessions map only to their own same-basename take', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl2-two-takes-'));
  const makeSession = (name, takeId, origin, eventHost) => {
    const sessionDir = path.join(dir, '.capcutctl', 'rl2', name);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'trace.ndjson'), JSON.stringify({
      type: name.includes('one') ? 'click' : 'typing_burst', host: eventHost,
      ...(name.includes('one') ? { in_capture: true } : { end: eventHost + 0.5 })
    }) + '\n');
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
      start_host: origin, capcutctl: { source_take_id: takeId }
    }));
  };
  makeSession('take__one', 'take-one-id', 90, 95);
  makeSession('take__two', 'take-two-id', 190, 195);

  const d = doc();
  d.materials.videos.push(
    { id: 'TAKE-ONE', type: 'video', path: path.join(dir, 'Resources', 'CapcutctlMedia', 'take__screen.mp4'), source_take_id: 'take-one-id' },
    { id: 'TAKE-TWO', type: 'video', path: path.join(dir, 'Resources', 'CapcutctlMedia', 'take__screen-2.mp4'), source_take_id: 'take-two-id' },
  );
  d.tracks[1].segments = [
    { ...seg(0, 10), id: 'TAKE-ONE-CLIP', material_id: 'TAKE-ONE', source_take_id: 'take-one-id' },
    { ...seg(10, 10), id: 'TAKE-TWO-CLIP', material_id: 'TAKE-TWO', source_take_id: 'take-two-id' },
  ];
  d.tracks[2].segments = [seg(0, 20, 100)];
  const plan = planInteractions(d, { projectDir: dir });
  assert.deepEqual(plan.map(cue => [cue.t, cue.kind]), [[5, 'click'], [15, 'type']]);
  assert.deepEqual(brollWindows(d, { projectDir: dir }).map(window => window.takeId), ['take-one-id', 'take-two-id']);
});

test('polish planners stop at contentEnd and ignore parked Preset 3 parts-bin footage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-content-end-'));
  fs.mkdirSync(path.join(dir, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.capcutctl', 'created.json'), JSON.stringify({
    template: 'Preset 3', preserved: { start: US(10), end: US(12) }
  }));
  const d = doc();
  d.duration = US(20);
  d.materials.videos.push(
    { id: 'PARKED', type: 'video', path: '/parts-bin/arrow-keys-demo.mp4' },
    { id: 'PARKED-PLATE', type: 'video', path: '/parts-bin/rect-16-9-1080x608.gif' },
  );
  d.tracks[1].segments = [
    { ...seg(12, 2), id: 'PARKED-FOOTAGE', material_id: 'PARKED', desc: 'preset3 parts-bin' },
    { ...seg(12, 2), id: 'PARKED-HELPER', material_id: 'PARKED', desc: 'layout:screen-frame' },
    { ...seg(12, 2), id: 'PARKED-CALLOUT', material_id: 'PARKED-PLATE', desc: 'callout' },
  ];
  d.tracks[2].segments = [seg(0, 10, 100)];

  assert.deepEqual(cutPoints(d, { projectDir: dir }), []);
  assert.deepEqual(pictureChanges(d, { projectDir: dir }), []);
  assert.deepEqual(planPolish(d, { projectDir: dir }), []);
  assert.deepEqual(calloutPlates(d, { projectDir: dir }), []);
  assert.deepEqual(brollWindows(d, { projectDir: dir }), []);
  const result = opPolish(d, { __seed: 'PARKED', projectDir: dir }, { projectDir: dir });
  assert.deepEqual(result.cues, []);
  assert.deepEqual(result.callouts, []);
  assert.deepEqual(result.interactions, []);
});

/** Every material id that occurs more than once across all buckets. */
function repeatedIds(d) {
  const seen = new Set(), repeated = new Set();
  for (const values of Object.values(d.materials || {})) {
    if (!Array.isArray(values)) continue;
    for (const m of values) {
      if (!m?.id) continue;
      if (seen.has(m.id)) repeated.add(m.id);
      seen.add(m.id);
    }
  }
  return [...repeated];
}

test('sliceAt gives every cloned extra its own id (a speed plus two effects do not collide)', () => {
  const d = doc();
  d.materials.speeds = [{ id: 'SP', type: 'speed', speed: 1 }];
  d.materials.effects = [
    { id: 'E1', type: 'sharpen', value: 0.3, bind_segment_id: 's0' },
    { id: 'E2', type: 'clear', value: 0.1, bind_segment_id: '' },
  ];
  const t = d.tracks[2];
  t.segments[0].extra_material_refs = ['SP', 'E1', 'E2'];
  assert.equal(sliceAt(d, t, 2, 'k', 'seed-x'), 'split');
  const [left, right] = t.segments;
  assert.deepEqual(left.extra_material_refs, ['SP', 'E1', 'E2']);
  assert.equal(new Set(right.extra_material_refs).size, 3);
  assert.equal(right.extra_material_refs.some(r => left.extra_material_refs.includes(r)), false);
  assert.deepEqual(repeatedIds(d), []);
  assert.equal(d.materials.effects.length, 4);
  const effects = new Map(d.materials.effects.map(m => [m.id, m]));
  // bound to the old segment (or unbound) -> bound to the right half now
  assert.equal(effects.get(right.extra_material_refs[1]).bind_segment_id, right.id);
  assert.equal(effects.get(right.extra_material_refs[2]).bind_segment_id, right.id);
  assert.equal(effects.get('E1').bind_segment_id, 's0');
  // deterministic under a seed: both mirror documents mint the same ids
  const again = doc();
  again.materials.speeds = structuredClone(d.materials.speeds.slice(0, 1));
  again.materials.effects = [
    { id: 'E1', type: 'sharpen', value: 0.3, bind_segment_id: 's0' },
    { id: 'E2', type: 'clear', value: 0.1, bind_segment_id: '' },
  ];
  again.tracks[2].segments[0].extra_material_refs = ['SP', 'E1', 'E2'];
  sliceAt(again, again.tracks[2], 2, 'k', 'seed-x');
  assert.deepEqual(again.tracks[2].segments[1].extra_material_refs, right.extra_material_refs);
});

test('sliceAt refuses a clip with a native intro/outro animation and leaves the doc unchanged', async () => {
  const { opAnimation } = await import('../src/animations.mjs');
  const d = doc();
  const t = d.tracks[2];
  t.segments = [seg(0, 6, 100), seg(6, 24, 200)];
  t.segments[0].id = 'ANIM';
  opAnimation(d, { selector: { id: 'ANIM' }, intro: 'fade-in', outro: 'fade-out', __seed: 'anim' });
  const before = JSON.stringify(d);
  assert.equal(sliceAt(d, t, 3, 'k', 'seed'), 'animated');
  assert.equal(JSON.stringify(d), before);

  // a seam at 3s inside the animated clip is reported, not cut
  const d2 = doc();
  d2.tracks[2].segments = [seg(0, 6, 100), seg(6, 24, 200)];
  d2.tracks[2].segments[0].id = 'ANIM';
  opAnimation(d2, { selector: { id: 'ANIM' }, intro: 'fade-in', outro: 'fade-out', __seed: 'anim' });
  d2.tracks[1].segments = [seg(0, 3, 0, { id: 'b1' }), seg(3, 3, 50, { id: 'b2' })];
  const r2 = opPolish(d2, { __seed: 'ANIM2' });
  assert.ok(r2.animatedSoNotSliced?.includes(3), JSON.stringify(r2));
  assert.ok(r2.keyframedSoNotSliced.includes(3));
  assert.equal(d2.tracks[2].segments.filter(s => s.id === 'ANIM').length, 1);
  assert.equal(d2.tracks[2].segments.find(s => s.id === 'ANIM').target_timerange.duration, US(6));
});

/** A project directory whose meta ledger records `ids` as polish transitions. */
function ledgerProject(ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-ledger-'));
  fs.mkdirSync(path.join(dir, '.capcutctl'), { recursive: true });
  const materials = Object.fromEntries(ids.map(id => [id, { kind: 'transitions', path: null, fields: { capcutctl_polish: true } }]));
  fs.writeFileSync(path.join(dir, '.capcutctl', 'meta-ledger.json'), JSON.stringify({ version: 1, materials, segments: {} }));
  return dir;
}

test('polish takes back only its own transitions; a hand-made one survives at its cut', () => {
  const d = doc();
  // face cut at 12s carries a hand-made transition; one stale polish transition (CapCut
  // stripped its mark on save, the ledger still knows it) sits on the B-roll.
  d.materials.transitions = [
    { id: 'HAND', name: 'Hand Wipe', duration: US(0.4) },
    { id: 'OLD-POLISH', name: 'Flash', duration: US(0.3) },
  ];
  d.tracks[2].segments[0].extra_material_refs = ['HAND'];
  d.tracks[1].segments[0].extra_material_refs = ['OLD-POLISH'];
  const dir = ledgerProject(['OLD-POLISH']);
  const first = opPolish(d, { __seed: 'OWN' }, { projectDir: dir });
  assert.equal(first.removedTransitions, 1);
  assert.equal(first.keptHandTransitions, 1);
  assert.equal(first.legacyClearAll, undefined);
  const holders = () => allRefs(d).filter(([, r]) => r === 'HAND');
  assert.equal(holders().length, 1);
  const face = d.tracks[2].segments;
  const holder = face.find(s => (s.extra_material_refs || []).includes('HAND'));
  assert.equal(holder.target_timerange.start + holder.target_timerange.duration, US(12));
  assert.deepEqual(first.seamKeptByHand, [12]);
  assert.equal(first.cues.some(c => c.t === 12), false, 'no polish seam on top of the hand-made one');
  assert.equal(d.materials.transitions.filter(m => m.id !== 'HAND').every(m => m.capcutctl_polish === true), true);

  const snapshot = JSON.stringify(d);
  const second = opPolish(d, { __seed: 'OWN' }, { projectDir: dir });
  assert.equal(JSON.stringify(d), snapshot, 'a second run with the same seed changes nothing');
  assert.deepEqual(second.cues, first.cues);
  assert.equal(second.keptHandTransitions, 1);
  assert.equal(holders().length, 1);
  assert.deepEqual(repeatedIds(d), []);
});

function allRefs(d) {
  const out = [];
  for (const t of d.tracks) for (const s of t.segments || []) for (const r of s.extra_material_refs || []) out.push([s.id, r]);
  return out;
}

test('a cut inside a segment with a hand-made transition moves the transition to the right half', () => {
  const d = doc();
  d.materials.transitions = [{ id: 'HAND', name: 'Hand Wipe', duration: US(0.4) }];
  d.tracks[2].segments[0].extra_material_refs = ['HAND'];
  assert.equal(sliceAt(d, d.tracks[2], 6, 'k', 'seed'), 'split');
  const [left, right] = d.tracks[2].segments;
  assert.deepEqual(left.extra_material_refs, []);
  assert.deepEqual(right.extra_material_refs, ['HAND']);
  assert.equal(d.materials.transitions.length, 1);
});

test('a legacy draft with no marks and no ledger is cleared once, then only polish transitions go', () => {
  const d = doc();
  d.materials.transitions = [{ id: 'UNMARKED', name: 'Flash', duration: US(0.3) }];
  d.tracks[2].segments[0].extra_material_refs = ['UNMARKED'];
  const first = opPolish(d, { __seed: 'LEGACY' });
  assert.equal(first.legacyClearAll, true);
  assert.equal(first.removedTransitions, 1);
  assert.equal(d.materials.transitions.some(m => m.id === 'UNMARKED'), false);
  assert.equal(allRefs(d).some(([, r]) => r === 'UNMARKED'), false);
  const second = opPolish(d, { __seed: 'LEGACY' });
  assert.equal(second.legacyClearAll, undefined);
  assert.equal(second.removedTransitions, first.transitions);
});

test('reruns of polish, callouts and signature leave no orphan extras behind', async () => {
  const { opSignature } = await import('../src/signature.mjs');
  const d = doc();
  d.materials.videos.push({ id: 'RECT', type: 'gif', path: '/x/rect-16-9-1080x608.gif' });
  d.tracks.push(track('video', [{ ...seg(4, 2), id: 'rect1', material_id: 'RECT' }]));
  const count = () => Object.values(d.materials).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  const run = seed => {
    opPolish(d, { __seed: `${seed}-polish` });
    opCalloutSfx(d, { __seed: `${seed}-callout` });
    opSignature(d, { endcard: { text: 'Follow' }, __seed: `${seed}-sig` });
  };
  run('one');
  const afterOne = count();
  assert.ok(d.tracks.find(t => t.name === 'polish-sfx').segments.length >= 3, 'three seams placed');
  run('two');
  assert.equal(count(), afterOne);
  run('two');
  assert.equal(count(), afterOne, 'a stable seed does not stack duplicate ids either');
  const live = new Set(allRefs(d).map(([, r]) => r));
  for (const { segment } of d.tracks.flatMap(t => (t.segments || []).map(segment => ({ segment })))) live.add(segment.material_id);
  for (const kind of ['speeds', 'placeholder_infos', 'beats', 'sound_channel_mappings', 'vocal_separations']) {
    for (const m of d.materials[kind] || []) assert.ok(live.has(m.id), `${kind} ${m.id} is referenced`);
  }
  assert.deepEqual(repeatedIds(d), []);
});

/**
 * A deterministic multi-track draft: face cuts with circle/split masks, B-roll of several files
 * and framings, callout plates and mograph overlays. Same generator as the snapshot fixture.
 */
function syntheticDraft(n, withMasks, seed) {
  let rng = seed;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
  const s = (id, start, dur, srcStart = 0, extra = {}) => ({
    id, material_id: 'M',
    target_timerange: { start: US(start), duration: US(dur) },
    source_timerange: { start: US(srcStart), duration: US(dur) },
    extra_material_refs: [], clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } }, ...extra,
  });
  const face = [], broll = [], plates = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const d = 0.5 + rand() * 2.5;
    face.push(s(`f${i}`, t, d, 100 + t, withMasks && rand() < 0.5 ? { extra_material_refs: [rand() < 0.5 ? 'CIRC' : 'SPLIT'] } : {}));
    if (rand() < 0.7) {
      const mat = ['B1', 'B2', 'B3', 'GIF'][Math.floor(rand() * 4)];
      broll.push(s(`b${i}`, t, d * (0.5 + rand() * 0.5), rand() * 50, {
        material_id: mat, desc: rand() < 0.2 ? 'layout:screen-recording' : `broll:${i % 3}`,
        clip: { scale: { x: rand() < 0.3 ? 1.5 : 1, y: 1 }, transform: { x: 0, y: 0 } },
      }));
    }
    if (rand() < 0.15) plates.push(s(`p${i}`, t, 0.6, 0, { material_id: 'RECT', desc: 'callout' }));
    if (rand() < 0.1) plates.push(s(`m${i}`, t + 0.2, 0.6, 0, { material_id: 'B1', desc: 'mograph:x' }));
    t += d;
  }
  return {
    duration: US(t + 3), fps: 30,
    materials: {
      videos: [
        { id: 'M', type: 'video', path: '/a/face.mp4' },
        { id: 'B1', type: 'video', path: '/a/one.mp4' },
        { id: 'B2', type: 'video', path: '/a/two__screen.mp4' },
        { id: 'B3', type: 'photo', path: '/a/still.png' },
        { id: 'GIF', type: 'video', path: '/a/rect-thing.gif' },
        { id: 'RECT', type: 'video', path: '/a/arrow-1.gif' },
      ],
      common_mask: [{ id: 'CIRC', name: 'Circle' }, { id: 'SPLIT', name: 'Split', resource_type: 'line' }],
    },
    tracks: [
      { type: 'video', id: 't0', flag: 0, segments: [] },
      { type: 'video', id: 'tb', segments: broll },
      { type: 'video', id: 'tf', segments: face },
      { type: 'video', id: 'tp', segments: plates },
    ],
  };
}

test('the planners give the same answers as before they shared one context (snapshot)', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/polish-planners.snapshot.json', import.meta.url), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-snap-'));
  fs.mkdirSync(path.join(dir, '.capcutctl'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.capcutctl', 'created.json'),
    JSON.stringify({ template: 'Preset 3', preserved: { start: US(30), end: US(40) } }));
  for (const [name, n, masks, projectDir] of [['small', 8, false, null], ['masks', 30, true, null], ['masks-created', 40, true, dir]]) {
    const d = syntheticDraft(n, masks, 777 + n);
    const o = { projectDir };
    const actual = JSON.parse(JSON.stringify({
      pictureChanges: pictureChanges(d, o), cutPoints: cutPoints(d, o), planPolish: planPolish(d, o),
      planMotivated: planPolish(d, { ...o, motivated: true }), coldOpen: coldOpen(d, o),
    }));
    assert.deepEqual(actual, expected[name], name);
  }
});

test('planning a 240-clip draft stays fast (no per-segment content-end recompute)', () => {
  const d = syntheticDraft(240, true, 4242);
  const started = performance.now();
  pictureChanges(d);
  cutPoints(d);
  planPolish(d, { motivated: true });
  coldOpen(d);
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
});

test('the meta ledger remembers which transitions polish placed, so a CapCut save cannot orphan them', async () => {
  const { metaRecord, restoreMeta } = await import('../src/repair.mjs');
  const d = doc();
  opPolish(d, { __seed: 'LEDGER' });
  const placed = d.materials.transitions.map(m => m.id);
  assert.ok(placed.length > 0);
  const record = metaRecord([d]);
  for (const id of placed) assert.equal(record.materials[id]?.fields?.capcutctl_polish, true);
  // a native save strips the mark; the ledger puts it back
  const saved = structuredClone(d);
  for (const m of saved.materials.transitions) delete m.capcutctl_polish;
  restoreMeta(saved, record);
  assert.equal(saved.materials.transitions.every(m => m.capcutctl_polish === true), true);
});

test('the meta ledger forgets a legacy layout:<name> tag on the face, but still restores plate descs', async () => {
  const { metaRecord, nextLedger, restoreMeta } = await import('../src/repair.mjs');
  const legacy = { materials: {}, tracks: [{ type: 'video', segments: [
    { id: 'FACE', material_id: 'M', desc: 'layout:split-screen' },
    { id: 'BAR', material_id: 'P', desc: 'layout:seam-bar' }] }] };
  // a ledger an older version wrote (raw, tag included), and the draft after layout apply cleared it
  const previous = { version: 1, materials: {}, segments: {
    FACE: { material_id: 'M', fields: { desc: 'layout:split-screen' } },
    BAR: { material_id: 'P', fields: { desc: 'layout:seam-bar' } } } };
  const cleared = structuredClone(legacy);
  cleared.tracks[0].segments[0].desc = '';
  cleared.tracks[0].segments[0].capcutctl_layout = 'split-screen';
  const ledger = nextLedger(previous, [cleared]);
  assert.equal(ledger.segments.FACE.fields.desc, undefined, 'the cleared tag is not carried forward');
  assert.equal(metaRecord([legacy]).segments.FACE, undefined, 'a snapshot with the tag does not record it');
  // even a raw record that still holds it does not put it back; a stripped plate desc is restored
  const saved = structuredClone(cleared);
  saved.tracks[0].segments[1].desc = '';
  const restored = restoreMeta(saved, previous);
  assert.equal(saved.tracks[0].segments[0].desc, '');
  assert.equal(saved.tracks[0].segments[1].desc, 'layout:seam-bar');
  assert.deepEqual(restored, [{ segment: 'BAR', key: 'desc' }]);
});
