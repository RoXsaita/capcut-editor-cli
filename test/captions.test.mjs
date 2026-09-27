import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildProject } from './helpers/polish-project.mjs';
import { applySpec, loadProject, validateDocument } from '../src/core.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { opCaptions, captionDisplayText } from '../src/captions.mjs';

// Unit schema tests use the licensed bundled font as a path fixture on non-macOS CI.
if (process.platform !== 'darwin') process.env.CAPCUTCTL_LATIN_FONT = new URL('../tools/caption_engine/fonts/Changa-ExtraBold.ttf', import.meta.url).pathname;
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
  assert.equal(doc.materials.texts[0].font_name, 'Changa ExtraBold');
  assert.equal(doc.materials.texts[1].font_name, 'Arial Unicode MS');
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
  assert.throws(()=>applySpec(project,{version:1,operations:[operation({cues:invalid})]},{forceRunning:true}),/CAPTION_/);
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
