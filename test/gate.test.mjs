import './helpers/neutral-profile.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { foldXray, gapsOver, gateReport } from '../src/gate.mjs';
import { presets, splitGaps } from '../src/layouts.mjs';

const US = s => Math.round(s * 1e6);
const range = (a, b) => ({ start: US(a), duration: US(b - a) });

/**
 * A 10s draft: the face on track 1 (masked as `look` from 2s to 8s, full face around it),
 * and whatever fills sit on track 0 under it.
 */
function draft(look, fills = [], extra = {}) {
  const circle = presets().layouts.circle.subject;
  const mask = look === 'circle'
    ? { id: 'MASK', type: 'mask', ...structuredClone(circle.maskTemplate), config: structuredClone(circle.mask) }
    : { id: 'MASK', type: 'mask', name: 'Split', resource_type: 'line', config: { width: 0.28, height: 0, centerY: 0.54 } };
  const face = (id, a, b, masked) => ({ id, material_id: 'FACE', desc: `scene ${id}`, target_timerange: range(a, b),
    source_timerange: range(a, b), extra_material_refs: masked ? ['MASK'] : [], enable_video_mask: masked,
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, alpha: 1 } });
  return {
    canvas_config: { width: 1080, height: 1920 },
    materials: {
      videos: [{ id: 'FACE', type: 'video', path: '/x/face.mp4', width: 1080, height: 1920 },
        { id: 'BROLL', type: 'video', path: '/x/screen_recording.mp4', width: 1080, height: 1920 },
        { id: 'PHOTO', type: 'photo', path: '/x/before.jpg', width: 1080, height: 1920 },
        { id: 'SCENE', type: 'video', path: '/x/scene.mov', width: 1080, height: 1920, capcutctl_mograph: { scene: true, template: 'opener' } }],
      common_mask: [mask], ...extra.materials,
    },
    tracks: [
      { type: 'video', flag: 0, name: 'under', segments: fills.map(([material, a, b, more = {}], i) => ({ id: `F${i}`, material_id: material,
        desc: material === 'BROLL' ? 'broll:demo' : '', target_timerange: range(a, b), source_timerange: range(0, b - a), ...more })) },
      { type: 'video', flag: 2, name: 'content', segments: [face('A', 0, 2, false), face('B', 2, 8, true), face('C', 8, 10, false)] },
      ...(extra.tracks || []),
    ],
  };
}

const check = (doc, id) => gateReport(doc).checks.find(c => c.id === id);

test('layout-filled: a split with nothing behind the face FAILs and names the stretch', () => {
  assert.deepEqual(splitGaps(draft('split')), [{ id: 'B', look: 'split-screen', t: 2, end: 8 }]);
  const row = check(draft('split'), 'layout-filled');
  assert.equal(row.ok, false);
  assert.equal(row.level, 'FAIL');
  assert.match(row.message, /1 split\/circle stretch\(es\) with nothing behind the face: 2–8s/);
});

test('layout-filled: B-roll, a photo or a mograph scene fills the split; a 0.1s seam is not a stretch', () => {
  assert.equal(check(draft('split', [['BROLL', 2, 8]]), 'layout-filled').ok, true);
  assert.equal(check(draft('split', [['PHOTO', 2, 8]]), 'layout-filled').ok, true);
  assert.equal(check(draft('split', [['SCENE', 2, 8]]), 'layout-filled').ok, true);
  assert.equal(check(draft('split', [['BROLL', 2, 7.9]]), 'layout-filled').ok, true, 'under minRun');
  assert.equal(check(draft('split', [['BROLL', 2, 8, { clip: { alpha: 0 } }]]), 'layout-filled').ok, false, 'alpha 0 fills nothing');
});

test('layout-filled: a circle with B-roll ending 2s early FAILs', () => {
  const gaps = splitGaps(draft('circle', [['BROLL', 2, 6]]));
  assert.deepEqual(gaps, [{ id: 'B', look: 'circle', t: 6, end: 8 }]);
  assert.equal(check(draft('circle', [['BROLL', 2, 6]]), 'layout-filled').ok, false);
});

test('max-static lists every stretch over the limit, worst first', () => {
  assert.deepEqual(gapsOver([2, 9], 0, 12, 3), [{ gap: 7, from: 2, to: 9 }, { gap: 3, from: 9, to: 12 }].filter(g => g.gap > 3));
  const doc = draft('full');
  doc.tracks[1].segments = [{ ...doc.tracks[1].segments[0], target_timerange: range(0, 30), source_timerange: range(0, 30),
    extra_material_refs: [], enable_video_mask: false }];
  // Punches at 2s, 4s and 14s split 30s into 2–4 (under the limit), 4–14 (10s) and 14–30 (16s).
  doc.tracks[1].segments[0].common_keyframes = [{ property_type: 'KFTypeScaleX', keyframe_list: [
    { time_offset: US(2), values: [1] }, { time_offset: US(2.1), values: [1.1] },
    { time_offset: US(4), values: [1.1] }, { time_offset: US(4.1), values: [1.2] },
    { time_offset: US(14), values: [1.2] }, { time_offset: US(14.1), values: [1] }] }];
  const row = gateReport(doc).checks.find(c => c.id === 'max-static');
  assert.equal(row.ok, false);
  assert.ok(row.target < 10 && row.target >= 2, `the shipped maxStatic (${row.target}) sits between the stretches`);
  assert.deepEqual(row.stretches.map(s => [s.from, s.to]), [[14, 30], [4, 14]]);
  assert.equal(row.value, row.stretches[0].gap);
  assert.match(row.message, /2 stretch\(es\).*16s \(14–30s\).*10s \(4–14s\)/);
});

test('mograph-import and unseen-layers are NOTEs, and an X-ray clears them', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const doc = draft('full', [], { tracks: [
    { type: 'video', name: 'mograph-1', segments: [{ id: 'M', material_id: 'GFX', desc: 'mograph:keyword-super', target_timerange: range(1, 2), source_timerange: range(0, 1) }] },
    { type: 'text', name: 'title', segments: [{ id: 'T', material_id: 'TXT', target_timerange: range(3, 4) }] },
  ], materials: { texts: [{ id: 'TXT', type: 'text' }] } });
  doc.materials.videos.push({ id: 'GFX', type: 'video', path: '/x/gfx.mov', capcutctl_mograph: { template: 'keyword-super', importVerified: false } });
  const report = gateReport(doc);
  for (const id of ['mograph-import', 'unseen-layers']) {
    assert.equal(report.checks.find(c => c.id === id).level, 'NOTE');
    assert.ok(report.noted.includes(id), `${id} is noted`);
    assert.ok(!report.warned.includes(id));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-xray-'));
  try {
    fs.writeFileSync(path.join(dir, 'xray.json'), JSON.stringify({ verdicts: [] }));
    foldXray(report, dir, null);
    for (const id of ['mograph-import', 'unseen-layers']) {
      const row = report.checks.find(c => c.id === id);
      assert.equal(row.ok, true);
      assert.match(row.message, /seen in the export X-ray/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

import { seamSilences } from '../src/gate.mjs';
import { opRipple } from '../src/ripple.mjs';

/**
 * Two A-roll clips of one take, cut at source 4.0 → 10.0. The energy index is loud (-20 dB)
 * except for `quiet` source windows (-60 dB).
 */
function seamDraft({ quiet = [[3.8, 4.0], [10.0, 10.3]], speed = 1, split = false } = {}) {
  const clip = (id, at, src, dur) => ({ id, material_id: 'FACE', desc: `scene ${id}`, extra_material_refs: [],
    target_timerange: range(at, at + dur / speed), source_timerange: range(src, src + dur),
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, alpha: 1 } });
  const b = split ? clip('B', 4 / speed, 4, 4) : clip('B', 4 / speed, 10, 4);
  const doc = {
    id: 'SEAM', duration: US(8 / speed), canvas_config: { width: 1080, height: 1920 },
    materials: { videos: [{ id: 'FACE', type: 'video', path: '/x/face.mp4', width: 1080, height: 1920, duration: US(30) }] },
    tracks: [{ type: 'video', flag: 0, segments: [] }, { type: 'video', flag: 2, name: 'content', segments: [clip('A', 0, 0, 4), b] }],
  };
  const energy = { bin: 0.01, db: Array.from({ length: 3000 }, (_, i) => (quiet.some(([a, z]) => i / 100 >= a - 1e-9 && i / 100 < z - 1e-9) ? -60 : -20)) };
  return { doc, energyFor: () => energy };
}
const seamRow = ({ doc, energyFor }, pauses = []) => gateReport(doc, { energyFor, pauses }).checks.find(c => c.id === 'seam-silence');

test('seam-silence: 0.2s tail + 0.3s head is dead air, and the ripple it names clears it', () => {
  const fixture = seamDraft();
  const [finding] = seamSilences(fixture.doc, { energyFor: fixture.energyFor }).findings;
  assert.deepEqual({ t: finding.t, tail: finding.tail, head: finding.head }, { t: 4, tail: 0.2, head: 0.3 });
  assert.deepEqual(finding.ripple, { from: 3.9, to: 4.2 });
  const row = seamRow(fixture);
  assert.equal(row.ok, false);
  assert.equal(row.level, 'FAIL');
  assert.match(row.message, /ripple --from 3\.9 --to 4\.2/);
  opRipple(fixture.doc, finding.ripple);
  assert.equal(seamRow(fixture).ok, true, 'after the ripple: 0.1s each side');
});

test('seam-silence: a split in place is no seam, --pause covers a deliberate one, speed shrinks the run', () => {
  const split = seamDraft({ split: true, quiet: [[3.7, 4.3]] });
  assert.equal(seamSilences(split.doc, { energyFor: split.energyFor }).seams, 0);
  assert.equal(seamRow(split).ok, true);
  assert.equal(seamRow(seamDraft(), [4.1]).ok, true, 'a declared pause');
  const slow = seamDraft({ quiet: [[3.8, 4.0], [10.0, 10.4]] });
  assert.equal(seamRow(slow).ok, false, '0.4s head at 1x');
  const fast = seamDraft({ quiet: [[3.8, 4.0], [10.0, 10.4]], speed: 2 });
  const [f] = seamSilences(fast.doc, { energyFor: fast.energyFor }).findings.concat([null]);
  assert.equal(f, null, 'at 2x the 0.2 + 0.4s run plays as 0.3s');
});

test('seam-silence: a legacy layout:<name> tag on the face is still A-roll; plates are not', () => {
  const tagged = seamDraft();
  for (const s of tagged.doc.tracks[1].segments) s.desc = 'layout:split-screen';
  const result = seamSilences(tagged.doc, { energyFor: tagged.energyFor });
  assert.deepEqual([result.seams, result.findings.length], [1, 1]);
  const plate = seamDraft();
  plate.doc.tracks[1].segments[1].desc = 'layout:seam-bar';
  assert.equal(seamSilences(plate.doc, { energyFor: plate.energyFor }).seams, 0);
});

test('seam-silence: no energy index is a WARN, not a pass', () => {
  const row = seamRow({ doc: seamDraft().doc, energyFor: () => null });
  assert.equal(row.level, 'WARN');
  assert.equal(row.ok, false);
  assert.match(row.message, /not checked: no energy index for face\.mp4/);
});
