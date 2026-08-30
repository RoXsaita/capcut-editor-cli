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
