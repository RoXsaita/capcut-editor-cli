import test from 'node:test';
import assert from 'node:assert/strict';
import {
  energyAt, wordPeakDb, sentenceMedianDb, isStressed, planStressPunches, opStressZoom,
  STRESS_SCALE, STRESS_MARGIN_DB, STRESS_SPACING_S,
} from '../src/stress.mjs';

const US = s => Math.round(s * 1e6);

/** Flat floor plus rectangular peaks. bin = 10 ms, matching energy10. */
function energySeries({ duration = 20, floor = -30, peaks = [] } = {}) {
  const bin = 0.01;
  const db = Array.from({ length: Math.round(duration / bin) }, () => floor);
  for (const peak of peaks) {
    const lo = Math.max(0, Math.floor(peak.start / bin));
    const hi = Math.min(db.length, Math.ceil(peak.end / bin));
    for (let i = lo; i < hi; i++) db[i] = peak.db;
  }
  return { bin, db };
}

function faceDoc({
  duration = 20, mask = null, extraTrack = null, extraFace = null, broll = false,
} = {}) {
  const face = {
    id: 'face0', material_id: 'CAM', desc: 'talking-head',
    enable_video_mask: mask ? true : false,
    extra_material_refs: mask ? ['mask1'] : [],
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, alpha: 1 },
    source_timerange: { start: 0, duration: US(duration) },
    target_timerange: { start: 0, duration: US(duration) },
  };
  const tracks = [
    { type: 'video', flag: 0, segments: [] },
    { type: 'video', flag: 2, name: 'face', segments: extraFace ? [face, extraFace] : [face] },
  ];
  if (broll) {
    tracks.push({
      type: 'video', flag: 2, name: 'broll',
      segments: [{
        id: 'b0', material_id: 'SCR', desc: 'broll: screen',
        enable_video_mask: false, extra_material_refs: [],
        clip: { scale: { x: 1, y: 1 }, alpha: 1 },
        source_timerange: { start: US(10), duration: US(8) },
        target_timerange: { start: US(2), duration: US(8) },
      }],
    });
  }
  if (extraTrack) tracks.push(extraTrack);
  return {
    canvas_config: { width: 1080, height: 1920 },
    materials: {
      videos: [
        { id: 'CAM', type: 'video', path: '/tmp/capcutctl-stress-cam.mp4', width: 1080, height: 1920 },
        { id: 'SCR', type: 'video', path: '/tmp/capcutctl-stress-screen.mp4', width: 1920, height: 1080 },
      ],
      common_mask: mask ? [mask] : [],
    },
    tracks,
  };
}

const circleMask = {
  id: 'mask1', resource_type: 'circle',
  config: { rotation: 0, invert: false, centerX: 0, centerY: 0 },
};
const lineMask = {
  id: 'mask1', resource_type: 'line',
  config: { rotation: 180, invert: false, centerX: 0, centerY: 0 },
};

function loudWordTranscript({ at = 1.0, dur = 0.3, extra = [] } = {}) {
  return {
    segments: [{
      start: 0, end: 3,
      words: [
        { word: 'hello', start: 0.2, end: 0.5 },
        { word: 'YES', start: at, end: at + dur },
        { word: 'there', start: 2.0, end: 2.4 },
        ...extra,
      ],
    }],
  };
}

test('wordPeakDb is the max energy10 bin covering the word', () => {
  const energy = energySeries({
    peaks: [{ start: 1.0, end: 1.2, db: -18 }, { start: 1.05, end: 1.08, db: -12 }],
  });
  assert.equal(energyAt(energy, 1.06), -12);
  assert.equal(wordPeakDb(energy, { start: 1.0, end: 1.2 }), -12);
  assert.equal(wordPeakDb(energy, { start: 0.2, end: 0.5 }), -30);
});

test('+6 dB above the sentence median is stressed; +5.9 is not', () => {
  const energy = energySeries({ floor: -30 });
  const sentenceMedian = sentenceMedianDb(energy, { start: 0, end: 3 });
  assert.equal(sentenceMedian, -30);
  assert.equal(isStressed(-24, sentenceMedian), true);
  assert.equal(isStressed(-24.1, sentenceMedian), false);
  assert.equal(isStressed(-30 + STRESS_MARGIN_DB, sentenceMedian), true);
});

test('planStressPunches picks the hardest word and ignores a near-median one', () => {
  const energy = energySeries({
    floor: -30,
    peaks: [
      { start: 1.0, end: 1.3, db: -20 },
      { start: 2.0, end: 2.3, db: -28 },
    ],
  });
  const plan = planStressPunches({
    transcript: loudWordTranscript({ at: 1.0, extra: [{ word: 'meh', start: 2.0, end: 2.3 }] }),
    energy,
  });
  assert.equal(plan.punches.length, 1);
  assert.equal(plan.punches[0].word, 'YES');
  assert.ok(plan.punches[0].marginDb >= STRESS_MARGIN_DB);
  assert.equal(plan.punches[0].at, 1);
});

test('8 s spacing keeps the louder word and drops a neighbour', () => {
  const energy = energySeries({
    duration: 20,
    floor: -30,
    peaks: [
      { start: 1.0, end: 1.3, db: -18 },
      { start: 4.0, end: 4.3, db: -12 },
      { start: 12.0, end: 12.3, db: -16 },
    ],
  });
  const transcript = {
    segments: [{
      start: 0, end: 15,
      words: [
        { word: 'one', start: 1.0, end: 1.3 },
        { word: 'TWO', start: 4.0, end: 4.3 },
        { word: 'three', start: 12.0, end: 12.3 },
      ],
    }],
  };
  const plan = planStressPunches({ transcript, energy, spacing: STRESS_SPACING_S });
  assert.deepEqual(plan.punches.map(row => row.word), ['TWO', 'three']);
  assert.ok(plan.punches[1].at - plan.punches[0].at >= STRESS_SPACING_S);
});

test('opStressZoom writes a 1.08× Line push on the stressed word', () => {
  const d = faceDoc();
  const energy = energySeries({ peaks: [{ start: 1.0, end: 1.3, db: -18 }] });
  const out = opStressZoom(d, {
    transcript: loudWordTranscript(),
    energy,
    hold: 1.2,
    ramp: 0.2,
    __seed: 'stress-happy',
  });
  assert.equal(out.mode, 'stress');
  assert.equal(out.punches.length, 1);
  assert.equal(out.punches[0].word, 'YES');
  assert.equal(out.punches[0].to, STRESS_SCALE);
  const keys = d.tracks[1].segments[0].common_keyframes
    .find(block => block.property_type === 'KFTypeScaleX').keyframe_list;
  assert.ok(keys.length >= 4);
  assert.ok(keys.every(key => key.curveType === 'Line'));
  assert.ok(Math.abs(keys[1].values[0] - STRESS_SCALE) < 1e-9);
});

test('--ease writes FreeCurveInOut on ScaleX/Y only', () => {
  const d = faceDoc();
  const energy = energySeries({ peaks: [{ start: 1.0, end: 1.3, db: -18 }] });
  opStressZoom(d, {
    transcript: loudWordTranscript(), energy, hold: 1, ramp: 0.2, ease: true, __seed: 'stress-ease',
  });
  const seg = d.tracks[1].segments[0];
  const scaleX = seg.common_keyframes.find(block => block.property_type === 'KFTypeScaleX').keyframe_list;
  const scaleY = seg.common_keyframes.find(block => block.property_type === 'KFTypeScaleY')?.keyframe_list;
  assert.ok(scaleX.every(key => key.curveType === 'FreeCurveInOut'));
  if (scaleY) assert.ok(scaleY.every(key => key.curveType === 'FreeCurveInOut'));
  assert.equal(seg.common_keyframes.some(block => /Position/.test(block.property_type)), false);
});

test('circle layout is refused', () => {
  const d = faceDoc({ mask: circleMask });
  const energy = energySeries({ peaks: [{ start: 1.0, end: 1.3, db: -18 }] });
  assert.throws(() => opStressZoom(d, {
    transcript: loudWordTranscript(), energy, __seed: 'stress-circle',
  }), { code: 'MOTION_MASK_UNSUPPORTED' });
  assert.equal(d.tracks[1].segments[0].common_keyframes, undefined);
});

test('a line-masked inset is skipped; a sibling full-face clip can still punch', () => {
  const inset = {
    id: 'inset', material_id: 'CAM', desc: 'talking-head',
    enable_video_mask: true, extra_material_refs: ['mask1'],
    clip: { scale: { x: 1, y: 1 }, alpha: 1 },
    source_timerange: { start: US(10), duration: US(10) },
    target_timerange: { start: US(10), duration: US(10) },
  };
  const d = faceDoc({ extraFace: inset, mask: lineMask });
  d.tracks[1].segments[0].enable_video_mask = false;
  d.tracks[1].segments[0].extra_material_refs = [];
  d.tracks[1].segments[0].source_timerange = { start: 0, duration: US(10) };
  d.tracks[1].segments[0].target_timerange = { start: 0, duration: US(10) };
  const energy = energySeries({
    duration: 20,
    peaks: [
      { start: 1.0, end: 1.3, db: -18 },
      { start: 12.0, end: 12.3, db: -16 },
    ],
  });
  const transcript = {
    segments: [{
      start: 0, end: 15,
      words: [
        { word: 'YES', start: 1.0, end: 1.3 },
        { word: 'later', start: 12.0, end: 12.3 },
      ],
    }],
  };
  const out = opStressZoom(d, { transcript, energy, hold: 1, ramp: 0.2, __seed: 'stress-inset' });
  assert.ok(out.punches.some(row => row.word === 'YES'));
  assert.equal(out.punches.some(row => row.segment === 'inset'), false);
  assert.equal(d.tracks[1].segments[1].common_keyframes, undefined);
});

test('non-face B-roll overlays are untouched', () => {
  const d = faceDoc({ broll: true });
  const energy = energySeries({ peaks: [{ start: 1.0, end: 1.3, db: -18 }] });
  opStressZoom(d, {
    transcript: loudWordTranscript(), energy, hold: 1, ramp: 0.2, __seed: 'stress-broll',
  });
  const broll = d.tracks[2].segments[0];
  assert.equal(broll.id, 'b0');
  assert.equal(broll.common_keyframes, undefined);
  assert.equal(broll.clip.scale.x, 1);
});

test('a second stress pass on the same word is skipped as DOUBLE_PUNCH', () => {
  const d = faceDoc();
  const energy = energySeries({ peaks: [{ start: 1.0, end: 1.3, db: -18 }] });
  const op = { transcript: loudWordTranscript(), energy, hold: 1, ramp: 0.2, __seed: 'stress-once' };
  const first = opStressZoom(d, op);
  assert.equal(first.punches.length, 1);
  const second = opStressZoom(d, { ...op, __seed: 'stress-twice' });
  assert.equal(second.punches.length, 0);
  assert.ok(second.skipped.some(row => row.skipped === 'DOUBLE_PUNCH'));
});
