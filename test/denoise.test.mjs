import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {pauseFloor,planDenoise,opDenoise} from '../src/denoise.mjs';
const source=fileURLToPath(new URL('../package.json',import.meta.url));
const transcript={segments:[{start:1,end:2}]};
const energy=floor=>({bin:.01,db:Array.from({length:300},(_,i)=>i>=100&&i<200?-18:floor)});
function fixture(){return {canvas_config:{width:1080,height:1920},materials:{videos:[{id:'m',type:'video',path:source,width:1080,height:1920,duration:3000000}],audio_fades:[{id:'fade',fade_in_duration:400000}],speeds:[]},tracks:[{type:'video',flag:0,segments:[]},{type:'video',flag:2,segments:[{id:'face',material_id:'m',volume:.8,speed:1,source_timerange:{start:500000,duration:2000000},target_timerange:{start:0,duration:2000000},extra_material_refs:['fade']}]}]};}
const context={projectDir:'/durable/project',dryRun:true};
test('measure real pauses; quiet and already-cleaned takes skip, retimed speech refuses',()=>{
  const d=fixture();assert.equal(pauseFloor(energy(-60),transcript).pauseFloorDb,-60);
  const plan=planDenoise(d,{energy:energy(-60),transcript},context);assert.equal(plan.sources.length,0);assert.equal(plan.skipped[0].reason,'already-quiet');
  assert.throws(()=>pauseFloor(energy(-35),null));assert.throws(()=>pauseFloor(energy(-35),{segments:[{start:0,end:3}]}));
  d.tracks[1].segments[0].speed=2;assert.throws(()=>planDenoise(d,{energy:energy(-35),transcript},context));
});
test('denoise dry-run records derived origin without altering timing, volume or fades',()=>{
  const d=fixture(),before=structuredClone(d),op={energy:energy(-38),transcript};
  const r=opDenoise(d,op,context),s=d.tracks[1].segments[0],m=d.materials.videos[0];
  assert.equal(r.changed,1);assert.equal(m.derived_from_path,source);assert.equal(m.derived_from_offset,0);
  for(const key of ['source_timerange','target_timerange','speed','volume','extra_material_refs'])assert.deepEqual(s[key],before.tracks[1].segments[0][key]);
  assert.deepEqual(d.materials.audio_fades,before.materials.audio_fades);
  assert.equal(planDenoise(d,op,context).skipped[0].reason,'already-denoised');
});
