import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planDuckMusic, opDuckMusic } from '../src/duck.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { loadPreset } from '../src/core.mjs';
import { buildContract } from '../src/contract.mjs';

const US = s => Math.round(s * 1e6);
const words = { segments: [{ start: 1, end: 2 }, { start: 2.2, end: 3 }, { start: 5, end: 6 }] };
function fixture() {
  const segment = (id, material, start, duration, source = 0) => ({ id, material_id: material,
    volume: id === 'bed' ? 0.08 : 1, speed: 1,
    source_timerange: { start: US(source), duration: US(duration) },
    target_timerange: { start: US(start), duration: US(duration) }, extra_material_refs: [], common_keyframes: [] });
  const face = segment('face', 'CAM', 0, 8);
  const bed = segment('bed', 'MUSIC', 0, 8);
  bed.extra_material_refs = ['fade'];
  bed.common_keyframes = [{ id: 'unrelated', property_type: 'OtherProperty', keyframe_list: [] }];
  return { id: 'DUCK-TEST', name: 'Duck test', duration: US(8), fps: 30,
    canvas_config: { width: 1080, height: 1920 },
    materials: { videos: [{ id: 'CAM', type: 'video', path: '/missing/face.mp4', width: 1080, height: 1920 }],
      audios: [{ id: 'MUSIC', type: 'music' }, { id: 'SFX', type: 'extract' }],
      audio_fades: [{ id: 'fade', type: 'audio_fade', fade_in_duration: US(0.4), fade_out_duration: US(1.2) }] },
    tracks: [{ id: 'cover', type: 'video', flag: 0, segments: [] },
      { id: 'voice', type: 'video', flag: 2, segments: [face] },
      { id: 'music', type: 'audio', flag: 0, name: 'finish-music', segments: [bed] },
      { id: 'fx', type: 'audio', flag: 0, name: 'polish-sfx', segments: [segment('click', 'SFX', 1, 0.2)] }] };
}

test('duck merges short gaps and clones only the harvested music channel, preserving voice, SFX and fades', () => {
  const doc = fixture(), before = structuredClone(doc);
  const template = structuredClone(loadPreset('volume-keyframes').block);
  template.harvested_extra = 'preserve';
  const plan = planDuckMusic(doc, { transcript: words });
  assert.deepEqual(doc, before);
  assert.deepEqual(plan.regions, [{ start: 1, end: 3 }, { start: 5, end: 6 }]);
  assert.equal(plan.mergedGaps.length, 1);
  const output = opDuckMusic(doc, { transcript: words, keyframeTemplate: template, __seed: 'test' });
  assert.equal(output.changed, 1);
  assert.deepEqual(doc.tracks[1], before.tracks[1]);
  assert.deepEqual(doc.tracks[3], before.tracks[3]);
  assert.deepEqual(doc.materials, before.materials);
  const bed = doc.tracks[2].segments[0];
  assert.deepEqual(bed.extra_material_refs, before.tracks[2].segments[0].extra_material_refs);
  assert.equal(bed.volume, 0.08);
  const block = bed.common_keyframes[1];
  assert.equal(block.harvested_extra, 'preserve');
  assert.notEqual(block.id, template.id);
  assert.equal(block.property_type, 'KFTypeVolume');
  const at = t => block.keyframe_list.find(k => k.time_offset === US(t)).values[0];
  assert.equal(at(0), Math.fround(0.08));
  assert.equal(at(1), Math.fround(0.08 * 10 ** (-12 / 20)));
  assert.equal(at(3.125), at(1));
  assert.equal(at(3.505), at(0));
  assert.equal(at(8), at(0));
  assert.equal(new Set(block.keyframe_list.map(k => k.id)).size, block.keyframe_list.length);
  assert.throws(() => opDuckMusic(doc, { transcript: words }), { code: 'DUCK_EXISTING_AUTOMATION' });
});

test('source intersections handle clipped words, repeated takes and sped-up/trimmed music', () => {
  const doc = fixture(), face = doc.tracks[1].segments[0], bed = doc.tracks[2].segments[0];
  face.source_timerange = { start: US(10), duration: US(2) };
  face.target_timerange.duration = US(2);
  doc.tracks[1].segments.push({ ...structuredClone(face), id: 'repeat', target_timerange: { start: US(2), duration: US(2) } });
  bed.source_timerange = { start: US(20), duration: US(16) };
  const plan = planDuckMusic(doc, { transcript: { segments: [{ start: 9, end: 10.5 }, { start: 11.5, end: 13 }] } });
  assert.deepEqual(plan.regions, [{ start: 0, end: 0.5 }, { start: 1.5, end: 2.5 }, { start: 3.5, end: 4 }]);
  assert.equal(plan.segments[0].keys[0].time_offset, US(20));
  assert.equal(plan.segments[0].keys.at(-1).time_offset, US(36));
  assert.ok(plan.segments[0].keys.some(k => k.time_offset === US(23)));
});

test('energy wins over transcripts, silence skips writes, and short pauses only partially recover', () => {
  const doc = fixture();
  const energy = { bin: 0.1, db: Array.from({ length: 80 }, (_, i) => i >= 10 && i < 20 ? -20 : -80) };
  assert.deepEqual(planDuckMusic(doc, { energy, transcript: words }).regions, [{ start: 1, end: 2 }]);
  const before = structuredClone(doc);
  assert.equal(opDuckMusic(doc, { energy: { bin: 0.1, db: [-80] } }).changed, 0);
  assert.deepEqual(doc, before);
  const plan = planDuckMusic(doc, { transcript: { segments: [{ start: 1, end: 2 }, { start: 2.5, end: 3 }] } });
  const peak = plan.segments[0].keys.find(k => k.time_offset === US(2.38)).value;
  assert.ok(peak > plan.segments[0].underGain && peak < 0.08);
  assert.ok(plan.segments[0].keys.every((k, i, a) => !i || k.time_offset > a[i - 1].time_offset));
  const threshold = planDuckMusic(doc, { transcript: { segments: [{ start: 1, end: 2 }, { start: 2.45, end: 3 }] } });
  assert.equal(threshold.regions.length, 2, 'a pause at the 450 ms threshold may recover');
});

test('duck rejects invalid controls, unavailable evidence, curved/reversed clips and missing music', () => {
  for (const [key, value] of [['underDb', NaN], ['underDb', -1], ['attackMs', 0], ['releaseMs', Infinity], ['minGapMs', -1]]) {
    assert.throws(() => planDuckMusic(fixture(), { transcript: words, [key]: value }), { code: 'BAD_DUCK' });
  }
  assert.throws(() => planDuckMusic(fixture(), {}), { code: 'DUCK_NO_SPEECH_INDEX' });
  const doc = fixture(); doc.tracks[2].segments = [];
  assert.throws(() => planDuckMusic(doc, { transcript: words }), { code: 'DUCK_NO_MUSIC' });
  const reverse = fixture(); reverse.tracks[2].segments[0].reverse = true;
  assert.throws(() => planDuckMusic(reverse, { transcript: words }), { code: 'DUCK_SPEED_UNSUPPORTED' });
  const curve = fixture(); curve.materials.speeds = [{ id: 'curve', curve_speed: {} }];
  curve.tracks[1].segments[0].extra_material_refs.push('curve');
  assert.throws(() => planDuckMusic(curve, { transcript: words }), { code: 'DUCK_SPEED_UNSUPPORTED' });
});

test('CLI plan and transaction dry-run write nothing; contract includes duck controls', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const doc = fixture(), file = path.join(root, 'draft_info.json'), transcript = path.join(root, 'words.json');
  fs.writeFileSync(file, JSON.stringify(doc)); fs.writeFileSync(transcript, JSON.stringify(words));
  const before = fs.readFileSync(file, 'utf8'), listing = fs.readdirSync(root);
  let stdout = '';
  const restore = setOutput(chunk => { stdout += String(chunk); return true; }); t.after(restore);
  for (const mode of ['--plan', '--dry-run']) {
    stdout = '';
    await main(['music', '--project', root, '--duck', '--words', transcript, mode]);
    const result = JSON.parse(stdout);
    assert.ok(mode === '--plan' ? result.changed === 1 : result.dryRun);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(root), listing);
  }
  const options = buildContract().commands.music.options;
  for (const flag of ['--duck', '--under-db', '--attack-ms', '--release-ms', '--min-gap-ms', '--words']) assert.ok(options.includes(flag));
  await assert.rejects(main(['music', '--project', root, '--duck', '--file', 'unused', '--plan']), { code: 'MUSIC_OPTIONS' });
});
