import test from 'node:test';
import assert from 'node:assert/strict';
import { planCursor, opCursor } from '../src/cursor.mjs';
import { applyFreeCurve, keyframeValue, simplifyMotion } from '../src/easing.mjs';
import { loadPreset } from '../src/core.mjs';

function fixture() {
 const s=structuredClone(loadPreset('signature').logoSegmentTemplate);
 Object.assign(s,{id:'screen',material_id:'screen-media',desc:'layout:screen-recording',source_take_id:'take',source_timerange:{start:1000000,duration:4000000},target_timerange:{start:0,duration:2000000},clip:{scale:{x:1,y:1},transform:{x:0,y:0}},extra_material_refs:[],common_keyframes:[],volume:0});
 const face={...structuredClone(s),id:'face',material_id:'face-media',desc:'',volume:1,target_timerange:{start:0,duration:8000000},source_timerange:{start:0,duration:8000000}};
 return {id:'TEST',duration:8000000,canvas_config:{width:1080,height:1920},materials:{videos:[{id:'screen-media',type:'video',path:'/take/screen.mp4',width:1080,height:1920,duration:8000000},{id:'face-media',type:'video',path:'/face.mp4',width:1080,height:1920,duration:8000000}],speeds:[],common_mask:[]},tracks:[{type:'video',flag:0,segments:[]},{type:'video',name:'screen',flag:2,segments:[s]},{type:'video',flag:2,segments:[face]}]};
}
const samples=Array.from({length:181},(_,i)=>({vt:i/30,at:{src_px:{x:100+i,y:300}},in_capture:true}));
const sessions=[{dir:'/take',sourceTakeId:'take',session:{},frames:[],events:[{type:'pointer',samples},... [2,4,5].map(t=>({type:'click',vt:t,at:{src_px:{x:100+t*30,y:300}},in_capture:t!==5}))]}];
test('cursor maps trimmed 2x source, preserves click peaks, reduces linear motion and is idempotent',()=>{
 const d=fixture(),before=structuredClone(d);const p=planCursor(d,{auto:true,sessions});
 assert.equal(p.clips.length,1);assert.ok(p.clips[0].points.length<8);assert.deepEqual(p.clips[0].clicks,[.5,1.5]);assert.deepEqual(d,before);
 opCursor(d,{auto:true,sessions});const lane=d.tracks.find(t=>t.name==='cursor-halo');assert.equal(lane.flag,2);assert.equal(d.tracks.indexOf(lane),2);before.tracks.at(-1).segments[0].track_render_index=3;assert.deepEqual(d.tracks.at(-1).segments,before.tracks.at(-1).segments);
 const k=lane.segments[0].common_keyframes.find(k=>k.property_type==='KFTypeScaleX').keyframe_list;assert.ok(k.some(k=>k.time_offset===500000));assert.equal(k[0].curveType,'FreeCurveInOut');
 const counts=Object.fromEntries(Object.entries(d.materials).map(([k,v])=>[k,v.length]));delete lane.name;opCursor(d,{auto:true,sessions});assert.deepEqual(Object.fromEntries(Object.entries(d.materials).map(([k,v])=>[k,v.length])),counts);assert.equal(lane.segments.length,1);
});
test('missing telemetry is a pure skip and simplification retains a bounded curved path',()=>{
 const d=fixture(),before=structuredClone(d);assert.deepEqual(opCursor(d,{auto:true,sessions:[]}).skippedNoCursor,['screen']);assert.deepEqual(d,before);
 const p=Array.from({length:100},(_,i)=>({t:i/30,v:[i*3,30*Math.sin(i/20)],keep:i===45}));const s=simplifyMotion(p,6);assert.ok(s.length<p.length/4);assert.ok(s.some(p=>p.t===1.5));
 for(const point of p){let b=s.findIndex(v=>v.t>=point.t);if(!b)continue;const a=s[b-1],z=s[b],f=(point.t-a.t)/(z.t-a.t);assert.ok(Math.hypot(...point.v.map((v,k)=>v-a.v[k]-(z.v[k]-a.v[k])*f))<=6+1e-6);}
});
test('easing matches measured native UI including overshoot',()=>{
 const keys=applyFreeCurve([1,2,3,4].map((t,i)=>({time_offset:t*1e6,values:[[1,1.5,1.5,1][i]]})));
 assert.equal(Math.round(keyframeValue(keys,1266666)*100),144);
 assert.equal(Math.round(keyframeValue(keys,1466666)*100),153);
 assert.equal(Math.round(keyframeValue(keys,3433333)*100),98);
});

test('native save may remove custom take ids; exact sidecar paths still match',()=>{
 const d=fixture();delete d.tracks[1].segments[0].source_take_id;
 const saved=structuredClone(sessions);saved[0].session={capcutctl:{localized_path:'/take/screen.mp4'}};
 assert.equal(planCursor(d,{auto:true,sessions:saved}).clips.length,1);
 saved[0].session.capcutctl.localized_path='/another/screen.mp4';
 assert.equal(planCursor(d,{auto:true,sessions:saved}).clips.length,0);
});
