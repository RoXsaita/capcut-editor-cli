import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildProject } from './helpers/polish-project.mjs';
import { applySpec, loadProject, validateDocument } from '../src/core.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { opCaptions, captionDisplayText } from '../src/captions.mjs';
import { captionStyleKey, captionStyleDrift } from '../src/house-rules.mjs';
import { captionLayers } from '../src/gate.mjs';

const cues = [
  {id: 1, start: 0, end: .5, text: 'خليت', position: 20},
  {id: 2, start: .4, end: 1, text: 'الـ CV', position: 50},
];
const operation = (extra = {}) => ({op: 'captions', name: 'suheil', cues, ...extra});
function fixture(fn) {
  const project = buildProject();
  try { return fn(project); } finally { fs.rmSync(path.dirname(project), {recursive:true, force:true}); }
}
const captionTrack = doc => doc.tracks.find(t => t.name === 'captions:suheil');

test('caption operation inserts editable ordinary text, not baked media or paid recognition', () => fixture(project => {
  const before = loadProject(project).groups[0].doc;
  applySpec(project, {version:1, operations:[operation()]}, {forceRunning:true});
  const doc = loadProject(project).groups[0].doc, track = captionTrack(doc);
  assert.equal(track.type, 'text'); assert.equal(track.segments.length, 2);
  assert.deepEqual(doc.tracks.slice(0, 2), before.tracks);
  assert.deepEqual(doc.materials.videos, before.materials.videos);
  assert.deepEqual(doc.materials.audios, before.materials.audios);
  assert.deepEqual(doc.tracks[0].segments, []);
  assert.deepEqual(doc.materials.texts.map(m => JSON.parse(m.content).text), ['خليت', 'الـ CV']);
  for (const m of doc.materials.texts) {
    assert.equal(m.type, 'text'); assert.equal(m.recognize_task_id, '');
    assert.equal(m.has_shadow, false); assert.equal(m.background_style, 0);
    const style = JSON.parse(m.content).styles[0];
    assert.deepEqual(style.fill.content.solid.color, [1,1,1]);
    assert.equal(style.strokes.length, 1);
    assert.deepEqual(style.strokes[0].content.solid.color, [0,0,0]);
    assert.ok(fs.existsSync(style.font.path));
    assert.ok(style.font.path.startsWith(project + path.sep));
  }
  // English words take the Arabic style exactly: one font, size, colour and stroke.
  assert.deepEqual(doc.materials.texts.map(m => m.font_name), ['Changa ExtraBold', 'Changa ExtraBold']);
  assert.equal(new Set(doc.materials.texts.map(captionStyleKey)).size, 1);
  assert.deepEqual(captionStyleDrift(doc).off, []);
  assert.deepEqual(validateDocument(doc, {checkFiles:true}).filter(x=>x.level==='error'), []);
}));

test('caption windows never overlap and positions use bottom-percent, not top-percent', () => fixture(project => {
  applySpec(project, {version:1,operations:[operation()]}, {forceRunning:true});
  const ss = captionTrack(loadProject(project).groups[0].doc).segments;
  assert.equal(ss[0].target_timerange.start, 0);
  assert.equal(ss[0].target_timerange.duration, 399000);
  assert.equal(ss[1].target_timerange.start, 400000);
  assert.equal(ss[0].clip.transform.y, -.6);
  assert.equal(ss[1].clip.transform.y, 0);
}));

test('caption transaction uses identical IDs in root/timeline and synchronizes mirrors', () => fixture(project => {
  applySpec(project, {version:1,operations:[operation()]}, {forceRunning:true});
  const {groups} = loadProject(project);
  assert.deepEqual(groups[0].doc, groups[1].doc);
  for (const g of groups) for (const file of g.mirrors) assert.deepEqual(JSON.parse(fs.readFileSync(file)),g.doc);
}));

test('identical untouched import is a no-op; changed inputs cannot overwrite editable text', () => fixture(project => {
  const spec = {version:1,operations:[operation()]};
  applySpec(project,spec,{forceRunning:true});
  const before = fs.readFileSync(path.join(project,'draft_info.json'),'utf8');
  applySpec(project,spec,{forceRunning:true});
  assert.equal(fs.readFileSync(path.join(project,'draft_info.json'),'utf8'),before);
  assert.throws(()=>applySpec(project,{version:1,operations:[operation({cues:[{...cues[0],text:'تغيير'}]})]}, {forceRunning:true}), /CAPTION_CONFLICT/);
  assert.equal(fs.readFileSync(path.join(project,'draft_info.json'),'utf8'),before);
}));

test('manual text or transform edits refuse regeneration', () => fixture(project => {
  applySpec(project,{version:1,operations:[operation()]},{forceRunning:true});
  const d = loadProject(project).groups[0].doc;
  const id = captionTrack(d).segments[0].id;
  applySpec(project,{version:1,operations:[{op:'segment.patch',selector:{id},set:{clip:{transform:{y:.2}}}}]}, {forceRunning:true});
  assert.throws(()=>applySpec(project,{version:1,operations:[operation()]},{forceRunning:true}), /CAPTION_CONFLICT/);
}));

for (const [label, invalid] of [
  ['negative time', [{...cues[0],start:-1}]],
  ['nonfinite time', [{...cues[0],end:NaN}]],
  ['reversed range', [{...cues[0],end:0}]],
  ['unsorted starts', [cues[1],cues[0]]],
  ['duplicate starts', [cues[0],{...cues[1],start:0}]],
  ['duplicate ids', [cues[0],{...cues[1],id:1}]],
  ['overlong cue', [{...cues[0],text:'one two three'}]],
  ['out of video', [{...cues[0],end:30}]],
  ['empty cues', []],
]) test(`caption input refuses ${label} before project mutation`, () => fixture(project => {
  const before = fs.readFileSync(path.join(project,'draft_info.json'),'utf8');
  // A NaN is now refused by applySpec's finite-number backstop (BAD_NUMBER) before the
  // caption validator sees it; either way nothing is written.
  assert.throws(()=>applySpec(project,{version:1,operations:[operation({cues:invalid})]},{forceRunning:true}),/CAPTION_|not a number/);
  assert.equal(fs.readFileSync(path.join(project,'draft_info.json'),'utf8'),before);
}));

test('caption scope cannot extend into an unrelated longer audio tail', () => fixture(project => {
  const doc=loadProject(project).groups[0].doc;
  doc.tracks.push({type:'audio',segments:[{target_timerange:{start:0,duration:30000000}}]});
  assert.throws(()=>opCaptions(doc,operation({cues:[{id:1,start:9,end:10,text:'late'}]})),/CAPTION_TIMING/);
}));

test('native display normalization keeps logical Arabic and hamza, with Staging digits', () => {
  assert.equal(captionDisplayText('أَإِؤُئ 50% الـ CV'), 'أإؤئ ٥٠٪ الـ CV');
});

test('CLI accepts its own generated report as a cue import', async () => {
  const project=buildProject(),dir=path.dirname(project),input=path.join(dir,'report.json');
  fs.writeFileSync(input,JSON.stringify({bundle:{version:1,cues}}));
  let output=''; const restore=setOutput(v=>{output+=v;return true;});
  try {await main(['captions','--project',project,'--cues',input,'--dry-run']);assert.equal(JSON.parse(output).dryRun,true);}
  finally {restore();fs.rmSync(dir,{recursive:true,force:true});}
});

test('CLI generation dry-run needs no ASR or source reads and writes nothing', async () => {
  const project=buildProject();let output='';const restore=setOutput(v=>{output+=v;return true;});
  try {await main(['captions','--project',project,'--dry-run']);assert.equal(JSON.parse(output).planOnly,true);
    assert.equal(fs.existsSync(path.join(project,'.capcutctl')),false);}
  finally {restore();fs.rmSync(path.dirname(project),{recursive:true,force:true});}
});

test('CLI cues dry-run validates without snapshots, font copies, or draft writes', async () => {
  const project = buildProject(), dir = path.dirname(project), input = path.join(dir,'cues.json');
  fs.writeFileSync(input, JSON.stringify({version:1,cues}));
  const before = fs.readFileSync(path.join(project,'draft_info.json'),'utf8');
  let result = ''; const restore = setOutput(v=>{result+=v;return true;});
  try {
    await main(['captions','--project',project,'--cues',input,'--dry-run']);
    assert.equal(JSON.parse(result).dryRun,true);
    assert.equal(fs.readFileSync(path.join(project,'draft_info.json'),'utf8'),before);
    assert.equal(fs.existsSync(path.join(project,'.capcutctl')),false);
    assert.equal(fs.existsSync(path.join(project,'Resources')),false);
  } finally {restore(); fs.rmSync(dir,{recursive:true,force:true});}
});

test('a Latin caption word keeps Western digits; an Arabic one gets Arabic-Indic', () => {
  assert.equal(captionDisplayText('GPT-5'), 'GPT-5');
  assert.equal(captionDisplayText('5'), '٥');
});

test('caption-style catches an English word styled apart from the Arabic ones', () => fixture(project => {
  applySpec(project, {version:1, operations:[operation()]}, {forceRunning:true});
  const doc = loadProject(project).groups[0].doc;
  const english = doc.materials.texts[1];
  english.font_name = 'Arial Unicode MS';
  const off = captionStyleDrift(doc).off;
  assert.equal(off.length, 1); assert.equal(off[0].text, 'الـ CV');
}));

test('captions --restyle puts an Arial English word back in the house style, keeping its text and place', () => fixture(project => {
  applySpec(project, {version:1, operations:[operation()]}, {forceRunning:true});
  const mutate = file => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = doc.materials.texts[1];
    m.font_name = 'Arial Unicode MS'; m.font_size = 15;
    const content = JSON.parse(m.content); content.text = 'CV'; content.styles[0].size = 15; m.content = JSON.stringify(content);
    fs.writeFileSync(file, JSON.stringify(doc));
  };
  for (const g of loadProject(project).groups) for (const f of [g.canonical, ...(g.mirrors || [])]) if (fs.existsSync(f)) mutate(f);
  assert.equal(captionStyleDrift(loadProject(project).groups[0].doc).off.length, 1);
  const before = captionTrack(loadProject(project).groups[0].doc).segments.map(s => s.clip.transform);
  applySpec(project, {version:1, operations:[{op:'captions-restyle'}]}, {forceRunning:true});
  const doc = loadProject(project).groups[0].doc;
  assert.deepEqual(captionStyleDrift(doc).off, []);
  assert.equal(JSON.parse(doc.materials.texts[1].content).text, 'CV', 'a hand correction survives');
  assert.deepEqual(captionTrack(doc).segments.map(s => s.clip.transform), before);
}));

test('caption-style compares with the house spec: an all-Arial track and an English majority both fail', () => fixture(project => {
  applySpec(project, {version:1, operations:[operation()]}, {forceRunning:true});
  const doc = loadProject(project).groups[0].doc;
  for (const m of doc.materials.texts) m.font_name = 'Arial Unicode MS';
  assert.equal(captionStyleDrift(doc).off.length, 2, 'every word off the spec, even when they all agree');
  doc.materials.texts[0].font_name = 'Changa ExtraBold';
  assert.deepEqual(captionStyleDrift(doc).off.map(w => w.text), ['الـ CV'], 'the Arial word is the odd one, never the Changa one');
  captionTrack(doc).segments[0].clip.scale = {x: 1.4, y: 1.4};
  assert.equal(captionStyleDrift(doc).off.length, 2, 'a word scaled in the canvas is a different size');
}));

const textIdsReferenced = doc => new Set(doc.tracks.flatMap(t => (t.segments || []).map(s => s.material_id)));

test('an SRT caption track or CapCut subtitle track conflicts too, and the message names --replace', () => fixture(project => {
  applySpec(project, {version:1, operations:[operation()]}, {forceRunning:true});
  const srt = loadProject(project).groups[0].doc;
  const track = captionTrack(srt);
  track.name = 'captions';                                      // the older SRT `caption` op's default
  for (const s of track.segments) s.desc = '';
  assert.throws(() => opCaptions(srt, operation()), err => /CAPTION_CONFLICT/.test(err.message)
    && /captions \(srt, 2 words\)/.test(err.message) && /captions --replace/.test(err.message));
  const auto = loadProject(project).groups[0].doc;
  const autoTrack = captionTrack(auto);
  autoTrack.name = 'Text';
  for (const m of auto.materials.texts) m.type = 'subtitle';
  assert.throws(() => opCaptions(auto, operation()), err => /CAPTION_CONFLICT/.test(err.message) && /Text \(subtitle/.test(err.message));
}));

test('captions --replace swaps every caption layer for one, leaving no orphan text', () => fixture(project => {
  applySpec(project, {version:1, operations:[operation()]}, {forceRunning:true});
  // A CapCut save strips desc: the track is no longer recognisably unchanged.
  for (const g of loadProject(project).groups) for (const file of g.mirrors) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const s of captionTrack(doc).segments) s.desc = '';
    fs.writeFileSync(file, JSON.stringify(doc));
  }
  assert.throws(() => applySpec(project, {version:1, operations:[operation()]}, {forceRunning:true}), /captions --replace/);
  const out = applySpec(project, {version:1, operations:[operation({replace:true, cues:[{...cues[0], text:'تغيير'}, cues[1]]})]}, {forceRunning:true});
  assert.deepEqual(out.result[0].operations[0].replaced, [{name:'captions:suheil', kind:'captions', words:2}]);
  const doc = loadProject(project).groups[0].doc;
  assert.equal(doc.tracks.filter(t => t.type === 'text' && /^captions/.test(t.name || '')).length, 1);
  const live = textIdsReferenced(doc);
  assert.deepEqual(doc.materials.texts.filter(m => !live.has(m.id)), [], 'no orphan text materials');
  assert.deepEqual(doc.materials.texts.map(m => JSON.parse(m.content).text), ['تغيير', 'الـ CV']);
  const layers = captionLayers(doc);
  assert.equal(layers.length, 1);
  // A second identical run is still a no-op, replace or not.
  const again = applySpec(project, {version:1, operations:[operation({replace:true, cues:[{...cues[0], text:'تغيير'}, cues[1]]})]}, {forceRunning:true});
  assert.equal(again.result[0].operations[0].unchanged, true);
}));

test('CLI --cues forwards --replace; without it an existing layer refuses naming --replace', async () => {
  const project = buildProject(), dir = path.dirname(project), input = path.join(dir, 'cues.json');
  fs.writeFileSync(input, JSON.stringify({version:1, cues}));
  let output = ''; const restore = setOutput(v => { output += v; return true; });
  try {
    await main(['captions', '--project', project, '--cues', input, '--force-running']);
    fs.writeFileSync(input, JSON.stringify({version:1, cues:[{...cues[0], text:'تغيير'}, cues[1]]}));
    await assert.rejects(main(['captions', '--project', project, '--cues', input, '--force-running']), /captions --replace/);
    output = '';
    await main(['captions', '--project', project, '--cues', input, '--replace', '--force-running']);
    const doc = loadProject(project).groups[0].doc;
    assert.equal(doc.tracks.filter(t => (t.name || '').startsWith('captions')).length, 1);
    assert.deepEqual(doc.materials.texts.map(m => JSON.parse(m.content).text), ['تغيير', 'الـ CV']);
  } finally { restore(); fs.rmSync(dir, {recursive:true, force:true}); }
});
