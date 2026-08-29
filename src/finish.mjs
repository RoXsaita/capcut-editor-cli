import fs from 'node:fs';
import { pictureChanges, planPolish, cutPoints, seamVariety, principalTrack } from './polish.mjs';
import { renderTimeline } from './timeline.mjs';
import { musicPrompt, musicCachePaths } from './music.mjs';

const S = us => (us || 0) / 1e6;
const r2 = n => Math.round(n * 100) / 100;

function transitionTimes(doc) {
  const ids = new Set((doc.materials?.transitions || []).map(m => m.id));
  const out = [];
  for (const track of doc.tracks || []) {
    if (track.type !== 'video') continue;
    for (const s of track.segments || []) {
      if (!(s.extra_material_refs || []).some(id => ids.has(id))) continue;
      out.push({
        t: r2(S(s.target_timerange.start + s.target_timerange.duration)),
        atClip: r2(S(s.target_timerange.start)),
      });
    }
  }
  return out;
}

function musicState(doc, projectDir) {
  const track = (doc.tracks || []).find(t => t.type === 'audio' && t.name === 'finish-music');
  const seg = track?.segments?.find(s => (s.desc || '') === 'finish:music');
  const cache = projectDir ? musicCachePaths(projectDir) : null;
  return {
    present: Boolean(seg),
    volume: seg?.volume ?? null,
    cached: Boolean(cache && fs.existsSync(cache.file)),
    file: cache?.file || null,
  };
}

function volumeOutliers(doc) {
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const out = [];
  for (const track of doc.tracks || []) {
    if (track.type !== 'video' || track.flag === 0) continue;
    for (const s of track.segments || []) {
      const desc = s.desc || '';
      if (desc.startsWith('layout:')) continue;
      const m = videos.get(s.material_id);
      const isBroll = desc.startsWith('broll:') || /Screen_Recording|screen\.mp4|gameplay/i.test(m?.path || '');
      if (!isBroll) continue;
      const vol = s.volume ?? 1;
      if (vol >= 0.9) out.push({ at: r2(S(s.target_timerange.start)), volume: vol, desc });
    }
  }
  return out;
}

function countFaceZooms(doc) {
  let n = 0;
  try {
    const { track } = principalTrack(doc);
    for (const s of track.segments || []) {
      const k = (s.common_keyframes || []).find(x => x.property_type === 'KFTypeScaleX');
      if (k && (k.keyframe_list || []).length >= 2) n++;
    }
  } catch { /* no principal */ }
  return n;
}

/**
 * Read-only scorecard for the finish pass. Does not write.
 */
export function finishScorecard(doc, { projectDir = null, width = 64 } = {}) {
  const duration = S(doc.duration || 0);
  const allCuts = cutPoints(doc);
  const picture = pictureChanges(doc);
  const trans = transitionTimes(doc);
  const nearPicture = t => picture.some(p => Math.abs(p.t - t) < 0.12);
  // transition is stored on the clip BEFORE the cut, so t is the cut time ≈ clip end
  const sameScreenTransitions = trans.filter(t => !nearPicture(t.t));
  const sameScreenCuts = allCuts.filter(c => !nearPicture(c.t));
  const motivated = planPolish(doc, { motivated: true });
  const unmotivated = planPolish(doc, { motivated: false });
  const logos = (doc.tracks || []).flatMap(t => (t.segments || [])
    .filter(s => (s.desc || '').startsWith('sig:logo'))
    .map(s => ({ at: r2(S(s.target_timerange.start)), desc: s.desc })));
  const endcard = (doc.tracks || []).flatMap(t => (t.segments || [])
    // the endcard CARD, not its paired cue: `sig:sfx:endcard` also contains "endcard",
    // and a substring match counted one endcard as two.
    .filter(s => (s.desc || '') === 'sig:endcard'
              || (t.name === 'sig-endcard' && !(s.desc || '').startsWith('sig:sfx')))
    .map(s => ({ at: r2(S(s.target_timerange.start)), desc: s.desc || t.name })));
  const timeline = renderTimeline(doc, { width });
  return {
    duration: r2(duration),
    timeline: timeline.text,
    cuts: allCuts.length,
    pictureChanges: picture,
    transitions: trans.length,
    sameScreenCuts: sameScreenCuts.map(c => r2(c.t)),
    sameScreenTransitions: sameScreenTransitions.map(t => r2(t.t)),
    motivatedSeams: motivated.length,
    unmotivatedSeams: unmotivated.length,
    variety: seamVariety(motivated),
    polishPlan: motivated.map(c => ({ t: c.t, pair: c.pair, transition: c.transition, sfx: c.sfx })),
    music: musicState(doc, projectDir),
    musicPrompt: musicPrompt(doc, { hits: picture }),
    logos,
    endcard,
    faceZooms: countFaceZooms(doc),
    brollHot: volumeOutliers(doc),
    laws: [
      'Transition only on a picture change (B-roll shot or layout class), never on an A-roll splice over the same screen.',
      'Do not recut speech to a beat. Generate and offset the bed so beats land on picture changes.',
      'Music is background: ~0.08, fade in, out before the CTA. Captions happen outside CapCut.',
    ],
  };
}

export function finishText(score) {
  const lines = [
    score.timeline,
    '',
    `cuts ${score.cuts}  picture-changes ${score.pictureChanges.length}  transitions ${score.transitions}  same-screen-cuts ${score.sameScreenCuts.length}`,
    `motivated polish would write ${score.motivatedSeams} seams (all-cuts would write ${score.unmotivatedSeams})`,
    `logos ${score.logos.length}  endcard ${score.endcard.length}  face-zooms ${score.faceZooms}  music ${score.music.present ? 'yes' : 'no'}`,
  ];
  if (score.sameScreenTransitions.length) {
    lines.push(`same-screen transitions (remove these): ${score.sameScreenTransitions.join(', ')}`);
  }
  if (score.sameScreenCuts.length) {
    lines.push(`same-screen cuts (do not decorate): ${score.sameScreenCuts.join(', ')}`);
  }
  if (score.brollHot.length) {
    lines.push(`B-roll at full volume: ${score.brollHot.map(b => `${b.at}s`).join(', ')}`);
  }
  lines.push('', 'music prompt:', score.musicPrompt);
  return lines.join('\n');
}
