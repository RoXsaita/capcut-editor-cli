import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProject } from './helpers/polish-project.mjs';
import { applySpec, loadPreset, loadProject } from '../src/core.mjs';
import { main, setOutput } from '../src/cli.mjs';
import { opMotion } from '../src/motion.mjs';
import { validateDocument } from '../src/core.mjs';
const blank=()=>JSON.parse(fs.readFileSync(new URL('../presets/blank-draft.json',import.meta.url)));
const run=(recipe,extra={})=>{const doc=blank();opMotion(doc,{op:'motion',recipe,name:'demo',text:'FORGE',at:0,duration:4,...extra},{seed:'test',checkResources:false});return doc;};
for(const recipe of ['gradient','shimmer','spotlight','orbit-glow']) test(`${recipe}: native editable compound, empty cover, valid refs`,()=>{
 const doc=run(recipe);assert.equal(doc.tracks[0].segments.length,0);
 assert.ok(doc.materials.drafts.length);assert.ok(JSON.stringify(doc.materials.drafts).includes('FORGE'));
 assert.deepEqual(validateDocument(doc,{checkFiles:false}).filter(x=>x.level==='error'),[]);
});
test('animated mask channels bind constant_material_id, not mask record id',()=>{
 const doc=run('spotlight');const mask=doc.materials.common_mask[0];
 const keys=doc.tracks.flatMap(t=>t.segments).flatMap(s=>s.common_keyframes||[]);
 assert.ok(keys.length>=4);assert.ok(keys.every(k=>k.material_id===mask.constant_material_id));
 assert.ok(keys.find(k=>k.property_type==='KFTypeCommonMaskSizeWidth').keyframe_list.at(-1).values[0]>1);
});
test('shimmer moves mask, not artwork; gradient has no animation',()=>{
 const d=run('shimmer');assert.ok(d.tracks.flatMap(t=>t.segments).some(s=>s.common_keyframes.some(k=>k.property_type==='KFTypeCommonMaskPositionX')));
 assert.ok(d.tracks.flatMap(t=>t.segments).every(s=>s.clip.transform.x===0));
 assert.equal(run('gradient').tracks.flatMap(t=>t.segments).flatMap(s=>s.common_keyframes).length,0);
});
test('orbit maintains a sharp core above masked blurred underlay',()=>{
 const d=run('orbit-glow');const ss=d.tracks.flatMap(t=>t.segments);
 assert.equal(ss.length,2);assert.ok(ss[0].common_keyframes.some(k=>k.property_type==='KFTypeCommonMaskRotation'));
 assert.equal(ss[1].common_keyframes.length,0);assert.equal(d.materials.video_effects[0].name,'Blur');
});
test('same named recipe is idempotent and preserves foreign content',()=>{
 const d=run('gradient');const before=structuredClone(d);const result=opMotion(d,{op:'motion',recipe:'gradient',name:'demo',text:'FORGE',at:0,duration:4},{seed:'other',checkResources:false});
 assert.equal(result.unchanged,true);assert.deepEqual(d,before);
});
for(const bad of [{recipe:'bogus'},{duration:0},{at:-1},{text:''},{logo:'no.png'},{scale:NaN},{color:'oops'}]) test(`refuse invalid input ${JSON.stringify(bad)}`,()=>{
 const doc=blank(),before=structuredClone(doc);assert.throws(()=>opMotion(doc,{op:'motion',recipe:'gradient',name:'bad',text:'Hi',at:0,duration:4,...bad},{seed:'test',checkResources:false}));assert.deepEqual(doc,before);
});
test('manual keyframe and nested-text edits are not reported unchanged',()=>{
 for(const edit of [d=>{d.tracks.at(-1).segments[0].clip.alpha=.2;},d=>{d.materials.drafts[0].draft.materials.texts[0].content='edited';}]){
  const d=run('gradient');edit(d);const before=structuredClone(d);
  assert.throws(()=>opMotion(d,{op:'motion',recipe:'gradient',name:'demo',text:'FORGE',at:0,duration:4},{checkResources:false}),/MOTION_NAME_CONFLICT/);
  assert.deepEqual(d,before);
 }
});
test('transaction preserves foreign content, root/timeline IDs and all mirrors; CLI dry run writes nothing',async()=>{
 const project=buildProject(),temp=path.dirname(project);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'motion-presets-'));
 const native=structuredClone(loadPreset('motion'));
 for(const m of Object.values(native.masks))m.path=dir;
 native.blur.path=dir;
 fs.writeFileSync(path.join(dir,'motion.json'),JSON.stringify(native));
 const old=process.env.CAPCUTCTL_PRESET_DIR;process.env.CAPCUTCTL_PRESET_DIR=dir;
 try{
  const before=fs.readFileSync(path.join(project,'draft_info.json'),'utf8');
  let output='';const restore=setOutput(v=>{output+=v;return true;});
  try{await main(['motion','shimmer','--project',project,'--name','txn','--text','MOTION','--at','8','--duration','4','--dry-run','--force-running']);}finally{restore();}
  assert.equal(JSON.parse(output).dryRun,true);
  assert.equal(fs.readFileSync(path.join(project,'draft_info.json'),'utf8'),before);
  assert.equal(fs.existsSync(path.join(project,'.capcutctl','history')),false);
  applySpec(project,{version:1,operations:[{op:'motion',recipe:'shimmer',name:'txn',text:'MOTION',at:8,duration:4}]},{forceRunning:true});
  const docs=loadProject(project).groups.map(g=>g.doc);
  assert.deepEqual(docs[0],docs[1]);
  assert.deepEqual(docs[0].tracks.slice(0,2),JSON.parse(before).tracks);
  for(const g of loadProject(project).groups)for(const f of g.mirrors)assert.deepEqual(JSON.parse(fs.readFileSync(f)),g.doc);
  for(const nested of docs[0].materials.drafts)assert.deepEqual(validateDocument(nested.draft,{checkFiles:false}).filter(x=>x.level==='error'),[]);
 }finally{if(old===undefined)delete process.env.CAPCUTCTL_PRESET_DIR;else process.env.CAPCUTCTL_PRESET_DIR=old;fs.rmSync(temp,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing resource refuses before document mutation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'motion-missing-'));
 const native=structuredClone(loadPreset('motion'));native.masks.split.path=path.join(dir,'missing');
 fs.writeFileSync(path.join(dir,'motion.json'),JSON.stringify(native));const old=process.env.CAPCUTCTL_PRESET_DIR;process.env.CAPCUTCTL_PRESET_DIR=dir;
 try{const d=blank(),before=structuredClone(d);assert.throws(()=>opMotion(d,{op:'motion',recipe:'gradient',name:'missing',text:'X'},{seed:'test'}),/MOTION_RESOURCE_MISSING/);assert.deepEqual(d,before);}
 finally{if(old===undefined)delete process.env.CAPCUTCTL_PRESET_DIR;else process.env.CAPCUTCTL_PRESET_DIR=old;fs.rmSync(dir,{recursive:true,force:true});}
});
test('same name with different input refuses rather than deleting manual work',()=>{
 const d=run('gradient');assert.throws(()=>opMotion(d,{op:'motion',recipe:'gradient',name:'demo',text:'CHANGED',at:0,duration:4},{seed:'test',checkResources:false}),/MOTION_NAME_CONFLICT/);
});
