import { fileURLToPath } from 'node:url';
import { CapcutError, seededId, allSegments, clone, removeUnreferencedMaterials } from './core.mjs';
import { brollWindows, findRl2Sessions, loadSession, windowsForSession, eventVt, principalTrack } from './polish.mjs';
import { opClipAdd, writeCameraPath } from './add.mjs';
import { applyFreeCurve, keyframeValue, simplifyMotion } from './easing.mjs';

const US = s => Math.round(s * 1e6);
const fail = m => { throw new CapcutError(m, { code: 'CURSOR_UNSUPPORTED', exitCode: 2 }); };
const ART = fileURLToPath(new URL('../assets/cursor-halo.png', import.meta.url));
const CHANNELS = ['KFTypeScaleX', 'KFTypeScaleY', 'KFTypePositionX', 'KFTypePositionY'];


function value(segment, property, time, fallback) {
  return keyframeValue(segment.common_keyframes?.find(b=>b.property_type===property)?.keyframe_list, US(time), fallback);
}

function position(doc, segment, material, p) {
  const W = doc.canvas_config.width, H = doc.canvas_config.height, c = segment.clip || {};
  const fit = Math.min(W / material.width, H / material.height);
  const sx = value(segment, CHANNELS[0], p.t, c.scale?.x ?? 1);
  const sy = segment.common_keyframes?.some(b=>b.property_type===CHANNELS[1])
    ? value(segment, CHANNELS[1], p.t, c.scale?.y ?? sx) : sx;
  const tx = value(segment, CHANNELS[2], p.t, c.transform?.x ?? 0);
  const ty = value(segment, CHANNELS[3], p.t, c.transform?.y ?? 0);
  const x = (p.x-material.width/2)*fit*sx, y = (p.y-material.height/2)*fit*sy;
  return [W/2+tx*W/2+x, H/2-ty*H/2+y];
}

export function planCursor(doc, op = {}, context = {}) {
  if (!!op.segment === !!op.auto) fail('cursor requires --segment ID or --auto.');
  const windows = brollWindows(doc, context).filter(w=>op.auto || w.id===op.segment);
  if (op.segment && !windows.length) fail('Select a visible B-roll recording below the face.');
  const loaded = op.sessions || findRl2Sessions(context.projectDir, doc).map(loadSession);
  const result = { clips: [], skippedNoCursor: [], skippedUnsupported: [], rmsLimit: 6 };
  for (const w of windows) {
    const segment = allSegments(doc).find(e=>e.segment.id===w.id).segment;
    const material = doc.materials.videos.find(m=>m.id===segment.material_id);
    if (segment.reverse || segment.clip?.rotation || segment.clip?.flip?.horizontal || segment.clip?.flip?.vertical
      || (doc.materials.speeds || []).some(m=>(segment.extra_material_refs||[]).includes(m.id)&&m.curve_speed)) {
      result.skippedUnsupported.push({ id:w.id, reason:'rotated, flipped or variable-speed recording' }); continue;
    }
    if (!(material?.width>0 && material?.height>0)) fail('Cursor needs known source dimensions.');
    const session = loaded.find(s=>windowsForSession([w],s).length);
    if (!session) { result.skippedNoCursor.push(w.id); continue; }
    const points = [];
    for (const ev of session.events) {
      const samples = ev.type==='pointer' ? ev.samples || [] : ev.type==='click' ? [ev] : [];
      for (const s of samples) {
        const t=eventVt(s,session.session,session.frames), p=s.at?.src_px;
        if (s.in_capture===false || t==null || !Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        if (p.x<0 || p.y<0 || p.x>material.width || p.y>material.height) continue;
        points.push({t,x:p.x,y:p.y,keep:ev.type==='click'});
      }
    }
    points.sort((a,b)=>a.t-b.t || Number(a.keep)-Number(b.keep));
    const unique=[...new Map(points.map(p=>[US(p.t),p])).values()];
    const samples=unique.filter(p=>p.t>=w.srcIn && p.t<w.srcOut);
    if (samples.length<2) { result.skippedNoCursor.push(w.id); continue; }
    const start=samples[0].t, end=samples.at(-1).t;
    const times=new Set(samples.map(p=>p.t));
    // Sample the composition (pointer × eased camera); simplify the resulting screen path.
    for(let t=start;t<end;t+=w.speed/30) times.add(t);
    const dense=[...new Set([...times].map(US))].sort((a,b)=>a-b).map(us=>{
      const t=us/1e6;
      const b=Math.max(0,unique.findIndex(p=>US(p.t)>=us)), a=Math.max(0,b-1), q=unique[b], p=unique[a];
      const f=q.t===p.t?0:(t-p.t)/(q.t-p.t);
      return {t:(t-start)/w.speed,v:position(doc,segment,material,{t,x:p.x+(q.x-p.x)*f,y:p.y+(q.y-p.y)*f}),keep:samples.some(p=>p.keep&&US(p.t)===us)};
    });
    const W=doc.canvas_config.width, H=doc.canvas_config.height;
    const reduced=simplifyMotion(dense, 3*W/1080);
    const cameraKeys=(segment.common_keyframes||[]).filter(b=>CHANNELS.includes(b.property_type)).flatMap(b=>b.keyframe_list);
    const clicks=samples.filter(p=>p.keep).map(p=>(p.t-start)/w.speed);
    const cameraStart=Math.min(...cameraKeys.map(k=>k.time_offset))/1e6, cameraEnd=Math.max(...cameraKeys.map(k=>k.time_offset))/1e6;
    const pulses=clicks.filter(t=>start+t*w.speed<cameraStart || start+t*w.speed>cameraEnd);
    result.clips.push({ id:w.id, at:w.tgtIn+(start-w.srcIn)/w.speed, duration:(end-start)/w.speed,
      rawSamples:samples.length, points:reduced, clicks, pulses,
      positions:reduced.map(p=>({t:p.t,v:[(p.v[0]-W/2)/(W/2),(H/2-p.v[1])/(H/2)]})) });
  }
  return result;
}

export function opCursor(doc, op, context = {}) {
  const plan=planCursor(doc,op,context);
  if(op.plan || !plan.clips.length) return {changed:0,...plan};
  const ids=new Set(plan.clips.map(c=>c.id));
  const owned = s => [...ids].some(id=>s.desc===`cursor:halo:${id}` || (s.desc==='cursor:halo' && s.id===seededId(`cursor:${doc.id}`,id)));
  for(const track of doc.tracks) if(track.type==='video' && track.flag!==0 && (track.segments||[]).some(owned)) track.name='cursor-halo';
  const removed=new Set();
  for(const t of doc.tracks) t.segments=(t.segments||[]).filter(s=>{
    if(!owned(s)) return true;
    for(const id of [s.material_id,...s.extra_material_refs||[]]) removed.add(id);
    return false;
  });
  removeUnreferencedMaterials(doc, removed);
  const W=doc.canvas_config.width,H=doc.canvas_config.height;
  const scale=(48*W/1080)/Math.min(W,H);
  for(const row of plan.clips) {
    const id=seededId(`cursor:${doc.id}`,row.id);
    opClipAdd(doc,{media:ART,track:'cursor-halo',id,at:row.at,duration:row.duration,generated:true,localize:true,
      width:96,height:96,mediaDuration:10800000000,volume:0,desc:`cursor:halo:${row.id}`,__seed:id},context);
    const lane=doc.tracks.find(t=>t.name==='cursor-halo');
    if(doc.tracks.indexOf(lane)>=principalTrack(doc).index) fail('Halo must stay below the face.');
    const segment=lane.segments.find(s=>s.id===id);
    doc.materials.videos.find(m=>m.id===segment.material_id).type='photo';
    segment.clip.scale={x:scale,y:scale};
    writeCameraPath(segment,row.positions.map(p=>({t:p.t,v:[scale,scale,...p.v]})),{seed:id});
    const pulse=[{t:0,v:scale},{t:row.duration,v:scale}]; let previous=-1;
    for(const t of row.pulses) {
      if(t-previous<.26) continue; previous=t;
      pulse.push({t:Math.max(0,t-.08),v:scale},{t,v:scale*1.25},{t:Math.min(row.duration,t+.18),v:scale});
    }
    const samples=[...new Map(pulse.sort((a,b)=>a.t-b.t).map(p=>[US(p.t),p])).values()];
    for(const b of segment.common_keyframes.filter(b=>CHANNELS.slice(0,2).includes(b.property_type))) {
      const template=b.keyframe_list[0];
      b.keyframe_list=applyFreeCurve(samples.map(p=>({...clone(template),id:seededId(id,`${b.property_type}:${p.t}`),time_offset:US(p.t),values:[p.v]})));
    }
  }
  return {changed:plan.clips.length,...plan};
}
