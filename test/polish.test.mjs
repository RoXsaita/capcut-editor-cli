import test from 'node:test';
import assert from 'node:assert/strict';
import { principalTrack, sliceAt, planPolish, seamVariety, isCalloutPlate, calloutPlates, opCalloutSfx } from '../src/polish.mjs';

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
  const lane = d.tracks.find(t => t.name === 'polish-sfx');
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
