import test from 'node:test';
import assert from 'node:assert/strict';
import { planReframe, opReframe, simplifyEased } from '../src/reframe.mjs';
import { keyframeValue, applyFreeCurve } from '../src/easing.mjs';
function fixture(){return {canvas_config:{width:1080,height:1920},materials:{videos:[{id:'m',type:'video',path:'/face.mp4',width:1080,height:1920}],common_mask:[]},tracks:[{type:'video',flag:2,segments:[{id:'face',material_id:'m',source_timerange:{start:0,duration:4000000},target_timerange:{start:0,duration:4000000},clip:{scale:{x:1,y:1},transform:{x:0,y:0}},extra_material_refs:[],common_keyframes:[]}]}]};}
const boxes=dx=>({face:Array.from({length:40},(_,i)=>({t:i/10,boxes:[{x:.35+dx*Math.sin(i/20),y:.25,w:.3,h:.3,confidence:1}]}))});
test('five pixel wobble emits no keys; drift writes native eased keys without retiming',()=>{
 const d=fixture();assert.equal(opReframe(d,{auto:true,boxes:boxes(5/1080)}).changed,0);
 const st=structuredClone(d.tracks[0].segments[0].source_timerange);
 const p=opReframe(d,{segment:'face',boxes:boxes(.05)});assert.equal(p.changed,1);
 const s=d.tracks[0].segments[0];assert.deepEqual(s.source_timerange,st);assert.ok(s.common_keyframes.every(b=>b.keyframe_list.every(k=>k.curveType==='FreeCurveInOut')));
});
test('circle and existing moves are refused, and the eased reduction stays within its bound',()=>{
 const d=fixture();d.materials.common_mask=[{id:'mask',resource_type:'circle'}];d.tracks[0].segments[0].extra_material_refs=['mask'];assert.throws(()=>planReframe(d,{segment:'face',boxes:boxes(.1)}),{code:'REFRAME_UNSUPPORTED'});
 const p=Array.from({length:100},(_,i)=>({t:i/10,v:[100*Math.sin(i/25),i]}));const s=simplifyEased(p,6);assert.ok(s.length<p.length);
 const ks=[0,1].map(j=>applyFreeCurve(s.map(p=>({time_offset:Math.round(p.t*1e6),values:[p.v[j]]}))));
 for(const a of p)assert.ok(Math.hypot(...a.v.map((v,j)=>v-keyframeValue(ks[j],Math.round(a.t*1e6))))<=6+1e-6);
});
