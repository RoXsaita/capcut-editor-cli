import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreset } from '../src/core.mjs';
import { keyframeValue } from '../src/easing.mjs';
import { planPolishedCursor, opPolishedCursor, pointerVideoTime } from '../src/polished-cursor.mjs';

const U = t => Math.round(t*1e6);
function fixture({ start=0, duration=8, speed=1 } = {}) {
  const screen=structuredClone(loadPreset('signature').logoSegmentTemplate);
  Object.assign(screen,{id:'screen',material_id:'screen-media',desc:'layout:screen-recording',source_take_id:'take',
    source_timerange:{start:U(start),duration:U(duration*speed)},target_timerange:{start:0,duration:U(duration)},
    clip:{scale:{x:1,y:1},transform:{x:0,y:0},alpha:1},extra_material_refs:[],common_keyframes:[],volume:0,render_index:7});
  const face={...structuredClone(screen),id:'face',material_id:'face-media',desc:'face',volume:1,render_index:42};
  return {id:'TEST',fps:30,duration:U(duration),canvas_config:{width:1920,height:1080},
    materials:{videos:[{id:'screen-media',type:'video',path:'/take/screen.mp4',width:1920,height:1080,duration:U(60)},
      {id:'face-media',type:'video',path:'/face.mp4',width:1920,height:1080,duration:U(60)}],speeds:[],common_mask:[]},
    tracks:[{type:'video',flag:0,segments:[]},{type:'video',name:'screen',flag:2,segments:[screen]},
      {type:'video',flag:2,segments:[face]}]};
}
function telemetry({ clicks=[1,3,5], visible=()=>true, end=12 } = {}) {
  return [{dir:'/take',sourceTakeId:'take',session:{capture:{shows_cursor:false,delivered_width:1920,delivered_height:1080}},frames:[],
    events:[{type:'pointer',samples:Array.from({length:end*120+1},(_,i)=>({vt:i/120,at:{src_px:{x:300+Math.min(8,i/120)*70,y:400}},in_capture:visible(i/120)}))},
      ...clicks.map(t=>({type:'pointer_down',vt:t,at:{src_px:{x:300+t*70,y:400}},in_capture:true}))]}];
}
const options=sessions=>({style:'polished',segment:'screen',sessions});
const channel=(s,property)=>s.common_keyframes.find(k=>k.property_type===property).keyframe_list;

test('poison dagger uses the recorded artwork and keeps its blade tip fixed during click bounce',()=>{
  const d=fixture(), sessions=telemetry({clicks:[1]});
  sessions[0].session.capture.cursor={style:'poison-dragon-dagger',height_at_1920:48};
  for (const p of sessions[0].events[0].samples) p.at.src_px={x:300,y:400};
  for (const e of sessions[0].events.slice(1)) e.at.src_px={x:300,y:400};
  opPolishedCursor(d,options(sessions));
  const s=d.tracks.flatMap(t=>t.segments).find(s=>s.desc==='cursor:polished:screen');
  const m=d.materials.videos.find(m=>m.id===s.material_id);
  assert.match(m.path,/cursor-dagger\.png$/);
  assert.deepEqual(s.clip.flip,{horizontal:true,vertical:false});
  assert.equal(m.width,645); assert.equal(m.height,1316);
  const fit=Math.min(1920/645,1080/1316);
  assert.ok(Math.abs(1316*fit*keyframeValue(channel(s,'KFTypeScaleY'),0)-48)<.01);
  for(let frame=25;frame<43;frame++) {
    const v=p=>keyframeValue(channel(s,p),U(frame/30));
    const x=960+960*v('KFTypePositionX')+(1-322.5)*fit*v('KFTypeScaleX');
    const y=540-540*v('KFTypePositionY')+(-658)*fit*v('KFTypeScaleY');
    assert.ok(Math.abs(x-300)<.01,`tip x ${x}`);
    assert.ok(Math.abs(y-400)<.01,`tip y ${y}`);
  }
});

test('polished plan is pure; native helpers reuse lanes and repeated writes preserve face and layer count',()=>{
  const d=fixture(), sessions=telemetry(), before=structuredClone(d);
  const plan=planPolishedCursor(d,options(sessions));
  assert.deepEqual(d,before);assert.equal(plan.clips.length,1);assert.equal(plan.clips[0].rings.length,3);
  opPolishedCursor(d,options(sessions));
  const rings=d.tracks.filter(t=>t.name?.startsWith('cursor-ripple:'));
  assert.equal(rings.length,1);assert.equal(rings[0].segments.length,3);
  assert.equal(new Set(rings[0].segments.map(s=>s.id)).size,3);
  assert.equal(d.tracks.length,5);
  const face=d.tracks.at(-1).segments[0], expected=structuredClone(before.tracks.at(-1).segments[0]);
  expected.track_render_index=4;assert.deepEqual(face,expected);
  assert.equal(face.render_index,42);
  const counts=Object.fromEntries(Object.entries(d.materials).map(([k,v])=>[k,v.length]));
  // Native may rename helper lanes; surviving descriptions still identify ownership.
  for(const t of d.tracks.filter(t=>t.name?.startsWith('cursor-'))) delete t.name;
  opPolishedCursor(d,options(sessions));
  assert.equal(d.tracks.length,5);
  assert.deepEqual(Object.fromEntries(Object.entries(d.materials).map(([k,v])=>[k,v.length])),counts);
  assert.deepEqual(d.tracks.at(-1).segments[0],expected);
});

test('overlapping click rings use only the maximum concurrent lanes',()=>{
  const d=fixture();opPolishedCursor(d,options(telemetry({clicks:[1,1.2,3,3.2]})));
  const lanes=d.tracks.filter(t=>t.name?.startsWith('cursor-ripple:'));
  assert.equal(lanes.length,2);assert.deepEqual(lanes.map(t=>t.segments.length),[2,2]);
});

test('subframe clock mapping, trimmed 2x click times and source-relative click effects',()=>{
  assert.equal(pointerVideoTime({host:10.0125},{},[{host:10,vt:0},{host:10.025,vt:.05}]).toFixed(6),'0.025000');
  assert.equal(pointerVideoTime({host:12},{clock:{first_frame_host:10}},[]),2);
  const d=fixture({start:2,duration:3,speed:2});
  const p=planPolishedCursor(d,options(telemetry({clicks:[1.9,3]}))).clips[0];
  assert.equal(p.at,0);assert.equal(p.duration,3);
  assert.ok(Math.abs(p.rings[0].at-2/30)<1e-8);
  assert.ok(Math.abs(p.rings[1].at-.6)<1e-8);
  assert.ok(Math.abs(p.rings[1].duration-.3)<1e-8);
  assert.ok(Math.abs(p.rings[1].keys[0].alpha-.6*(1-.025/.6)**3)<1e-8);
  assert.ok(p.rings[1].keys.at(-1).alpha<1e-12);
  assert.ok(p.rings[1].keys.at(-1).v[0]>p.rings[1].keys[0].v[0]*5);
  // Ripple follows the original click coordinate, not the pointer after the click.
  assert.equal(p.rings[1].keys[0].v[2],p.rings[1].keys.at(-1).v[2]);
  opPolishedCursor(d,options(telemetry({clicks:[1.9,3]})));
  for(const lane of d.tracks.filter(t=>t.name?.startsWith('cursor-'))) for(const segment of lane.segments) {
    for(const v of Object.values(segment.target_timerange)) assert.ok(Math.abs(v/1e6*30-Math.round(v/1e6*30))<.00002);
    for(const block of segment.common_keyframes) for(const [i,key] of block.keyframe_list.entries()) {
      assert.ok(Math.abs(key.time_offset/1e6*30-Math.round(key.time_offset/1e6*30))<.00002);
      if(i) assert.ok(key.time_offset-block.keyframe_list[i-1].time_offset>=33333);
    }
  }
});

test('visibility is binary on output frames and keys cannot collapse during native frame snapping',()=>{
  const d=fixture();opPolishedCursor(d,options(telemetry({clicks:[],visible:t=>t<1 || t>=2})));
  const pointer=d.tracks.find(t=>t.name?.startsWith('cursor-polished:')).segments[0];
  const alpha=channel(pointer,'KFTypeAlpha');
  assert.equal(keyframeValue(alpha,U(29/30)),1);
  assert.equal(keyframeValue(alpha,U(1)),0);
  assert.equal(keyframeValue(alpha,U(59/30)),0);
  assert.equal(keyframeValue(alpha,U(2)),1);
  assert.ok(alpha.every((k,i)=>!i || k.time_offset-alpha[i-1].time_offset>=33333));
});

test('trim warms the spring and preserves already-running click ripple',()=>{
  const sessions=telemetry({clicks:[5.8]});
  const full=fixture(), trimmed=fixture({start:6,duration:2});
  opPolishedCursor(full,options(sessions));opPolishedCursor(trimmed,options(sessions));
  const a=full.tracks.find(t=>t.name?.startsWith('cursor-polished:')).segments[0];
  const b=trimmed.tracks.find(t=>t.name?.startsWith('cursor-polished:')).segments[0];
  assert.ok(Math.abs(keyframeValue(channel(a,'KFTypePositionX'),U(6))-keyframeValue(channel(b,'KFTypePositionX'),0))*960<.1);
  const ring=trimmed.tracks.find(t=>t.name?.startsWith('cursor-ripple:')).segments[0];
  assert.equal(ring.target_timerange.start,0);
  assert.ok(channel(ring,'KFTypeAlpha')[0].values[0]<.6);
});

test('selected replacement refuses absent or unsafe telemetry and unsupported source geometry without writes',()=>{
  for(const mutate of [
    (d,s)=>{s.length=0;}, (d,s)=>{s[0].events=[];},
    (d,s)=>{s[0].session.capture.shows_cursor=true;},
    (d,s)=>{s[0].session.capture.delivered_width=1280;},
    (d,s)=>{s[0].events[0].samples.forEach(p=>{p.vt+=1000000;});s[0].events=s[0].events.slice(0,1);},
    (d,s)=>{s[0].events=s[0].events.filter(e=>e.type!=='pointer');},
    d=>{d.materials.videos[0].width=0;},
    d=>{d.materials.videos[0].crop_scale=1.2;},
    d=>{d.tracks[1].segments[0].clip.alpha=0;},
    d=>{d.tracks[1].segments[0].reverse=true;},
    d=>{d.tracks[1].segments[0].clip.rotation=20;},
  ]) {
    const d=fixture(),s=telemetry();mutate(d,s);const before=structuredClone(d);
    assert.throws(()=>planPolishedCursor(d,options(s)),{code:'CURSOR_UNSUPPORTED'});
    assert.deepEqual(d,before);
  }
});

test('nonuniform unlocked source scaling survives cursor projection and camera key sampling',()=>{
  const d=fixture(),screen=d.tracks[1].segments[0];
  screen.uniform_scale={on:false};screen.clip.scale={x:1,y:.5};
  screen.common_keyframes=[{property_type:'KFTypeScaleX',keyframe_list:[{time_offset:0,values:[1],curveType:'Line'},{time_offset:U(8),values:[2],curveType:'Line'}]}];
  const p=planPolishedCursor(d,options(telemetry({clicks:[]}))).clips[0].points;
  assert.ok(Math.abs(p[0].v[0]/p[0].v[1]-2)<1e-8);
  assert.ok(Math.abs(p.at(-1).v[0]/p.at(-1).v[1]-4)<1e-8);
});

test('replacement cannot attach clean metadata by filename or ambiguous legacy basename',()=>{
  const d=fixture(),s=telemetry();delete d.tracks[1].segments[0].source_take_id;delete s[0].sourceTakeId;
  d.materials.videos[0].path='/unrelated/take__screen.mp4';
  assert.throws(()=>planPolishedCursor(d,options(s)),{code:'CURSOR_UNSUPPORTED'});
  s[0].session.capcutctl={localized_path:'/unrelated/take__screen.mp4'};
  assert.equal(planPolishedCursor(d,options(s)).clips.length,1);
});
