/** Editable pointer and click rings. Original artwork and standard spring dynamics. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapcutError, allSegments, seededId, clone, removeUnreferencedMaterials, resolveMediaPath } from './core.mjs';
import { findRl2Sessions, loadSession, windowsForSession } from './polish.mjs';
import { opClipAdd, writeCameraPath } from './add.mjs';
import { keyframeValue, simplifyMotion } from './easing.mjs';
import { renumberTracks } from './layouts.mjs';

const US = t => Math.round(t * 1e6);
const ART = name => fileURLToPath(new URL(`../assets/cursor-${name}.png`, import.meta.url));
const CAMERA = ['KFTypeScaleX', 'KFTypeScaleY', 'KFTypePositionX', 'KFTypePositionY'];
const fail = message => { throw new CapcutError(message, { code: 'CURSOR_UNSUPPORTED', exitCode: 2 }); };
export const POINTER_PRESET = Object.freeze({ stiffness: 483.2352, damping: 47.7897333333, mass: 1.80729, size: 2.5, bounce: .16, bounceDuration: .35, rippleDuration: .6, rippleDelay: .175 });

// Semi-implicit Euler at <= 1/480s; deterministic and independent of output frame rate.
export function stepPointerSpring(state, target, seconds) {
  const steps = Math.max(1, Math.ceil(seconds * 480)), dt = seconds / steps;
  for (let i = 0; i < steps; i++) {
    state.velocity += (POINTER_PRESET.stiffness * (target - state.value) - POINTER_PRESET.damping * state.velocity) / POINTER_PRESET.mass * dt;
    state.value += state.velocity * dt;
  }
  return state.value;
}

function atTime(points, time) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (points[mid].t <= time) lo = mid; else hi = mid - 1; }
  const a = points[lo], b = points[Math.min(lo + 1, points.length - 1)];
  if (!a || time < a.t) return null;
  if (!a.visible || !b.visible || a === b) return a;
  const f = Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)));
  return { ...a, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Interpolate the recorded frame clock without quantizing high-frequency pointer events. */
export function pointerVideoTime(sample, session, frames) {
  if (Number.isFinite(sample.vt)) return sample.vt;
  const host = sample.host ?? sample.input_time;
  if (!Number.isFinite(host)) return null;
  if (frames.length) {
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (frames[mid].host <= host) lo = mid; else hi = mid - 1; }
    const a = frames[lo], b = frames[Math.min(lo + 1, frames.length - 1)];
    if (a === b || host < a.host) return a.vt + host - a.host;
    return a.vt + (host - a.host) / (b.host - a.host) * (b.vt - a.vt);
  }
  const origin = session.clock?.first_frame_host ?? session.start_host;
  return Number.isFinite(origin) ? host - origin : null;
}

function project(doc, segment, material, t, x, y) {
  const W = doc.canvas_config.width, H = doc.canvas_config.height, c = segment.clip;
  const values = CAMERA.map((property, i) => keyframeValue(segment.common_keyframes?.find(b => b.property_type === property)?.keyframe_list, US(t), [c.scale?.x ?? 1, c.scale?.y ?? c.scale?.x ?? 1, c.transform?.x ?? 0, c.transform?.y ?? 0][i]));
  // Native linked scale uses X for both axes when no Y keys exist.
  if ((segment.uniform_scale?.on ?? ((c.scale?.x ?? 1) === (c.scale?.y ?? 1))) && !segment.common_keyframes?.some(b => b.property_type === CAMERA[1]) && segment.common_keyframes?.some(b => b.property_type === CAMERA[0])) values[1] = values[0];
  const [sx, sy, tx, ty] = values, fit = Math.min(W / material.width, H / material.height);
  return { x: W / 2 + tx * W / 2 + (x - material.width / 2) * fit * sx,
    y: H / 2 - ty * H / 2 + (y - material.height / 2) * fit * sy, sx, sy, fit };
}

function visibleAt(doc, segment, material, p, projected) {
  if (!p.visible || p.x < 0 || p.y < 0 || p.x > material.width || p.y > material.height) return false;
  if (projected.x < 0 || projected.y < 0 || projected.x > doc.canvas_config.width || projected.y > doc.canvas_config.height) return false;
  const mask = segment.enable_video_mask !== false && doc.materials.common_mask?.find(m => segment.extra_material_refs?.includes(m.id));
  if (!mask) return true;
  const row = material.height * (1 - (mask.config?.centerY || 0)) / 2;
  return Number(mask.config?.rotation || 0) === 180 ? p.y >= row : p.y <= row;
}

export function planPolishedCursor(doc, op = {}, context = {}) {
  if (op.style !== 'polished') fail('cursor --style must be halo or polished.');
  if (!!op.segment === !!op.auto) fail('cursor requires --segment ID or --auto.');
  const size = op.size ?? POINTER_PRESET.size;
  if (!Number.isFinite(size) || size <= 0 || size > 8) fail('Cursor size must be > 0 and <= 8.');
  const fps = doc.fps || 30;
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) fail('Cursor requires a project frame rate from 1 to 240.');
  const loaded = op.sessions || findRl2Sessions(context.projectDir, doc).map(loadSession);
  const result = { style: 'polished', clips: [], skippedNoCursor: [], skippedUnsupported: [], motionBlur: false };
  const candidates = allSegments(doc).filter(e => e.track.type === 'video' && e.track.flag !== 0 && (!op.segment || e.segment.id === op.segment));
  if (op.segment && !candidates.length) fail('Select a screen recording on an overlay track.');
  for (const { segment: s, trackIndex } of candidates) {
    const m = doc.materials.videos?.find(m => m.id === s.material_id);
    if (!m || m.type === 'photo' || String(s.desc || '').startsWith('cursor:')) continue;
    const st = s.source_timerange, tt = s.target_timerange;
    if (!(st?.duration > 0 && tt?.duration > 0)) continue;
    const w = { id: s.id, srcIn: st.start / 1e6, srcOut: (st.start + st.duration) / 1e6, tgtIn: tt.start / 1e6, speed: st.duration / tt.duration,
      path: resolveMediaPath(m.path, context.projectDir) || m.path, takeId: s.source_take_id || m.source_take_id || s.rl2_take_id || m.rl2_take_id };
    // Cursor replacement needs an identity or an exact source path, never a basename guess.
    const session = loaded.find(l => (l.sourceTakeId && windowsForSession([w], l).length)
      || (!w.takeId && [path.resolve(l.dir, l.session.video || 'screen.mp4'), l.session.source_path, l.session.localized_path,
        l.session.capcutctl?.source_path, l.session.capcutctl?.localized_path].filter(Boolean).some(p => path.resolve(w.path) === path.resolve(p))));
    if (!session) { if (op.segment) fail(`Recording ${s.id} has no matching cursor telemetry.`); continue; }
    if (session.session.capture?.shows_cursor !== false) fail(`Recording ${s.id} does not prove its cursor was hidden. Use rl2 polished/hidden capture; a replacement would duplicate the baked cursor.`);
    const dagger = session.session.capture?.cursor?.style === 'poison-dragon-dagger';
    if ((s.clip?.alpha ?? 1) !== 1 || s.common_keyframes?.some(k => k.property_type === 'KFTypeAlpha')) fail('Polished cursor requires a fully visible source without opacity keyframes.');
    const fullCrop = { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 };
    if ((m.crop_scale ?? 1) !== 1 || (m.crop && Object.entries(fullCrop).some(([k,v]) => !Number.isFinite(m.crop[k]) || Math.abs(m.crop[k]-v)>1e-6))) fail('Polished cursor requires uncropped source media.');
    const mask = s.enable_video_mask !== false && doc.materials.common_mask?.find(m => s.extra_material_refs?.includes(m.id));
    if (s.reverse || s.clip?.rotation || s.clip?.flip?.horizontal || s.clip?.flip?.vertical || (mask && (mask.resource_type !== 'line' || mask.config?.invert || ![0, 180].includes(Number(mask.config?.rotation || 0))))
      || doc.materials.speeds?.some(m => s.extra_material_refs?.includes(m.id) && m.curve_speed)) fail('Polished cursor requires an unrotated recording with constant speed and no circle/complex mask.');
    if (!(m.width > 0 && m.height > 0)) fail('Cursor needs known source dimensions.');
    const capture = session.session.capture;
    if ((capture.delivered_width && capture.delivered_width !== m.width) || (capture.delivered_height && capture.delivered_height !== m.height)) fail('Cursor telemetry dimensions do not match the source media.');
    const points = [], clicks = [];
    let pointerSamples = 0;
    const frames = [...new Map(session.frames.filter(f => Number.isFinite(f.host) && Number.isFinite(f.vt)).sort((a,b) => a.host-b.host).map(f => [f.host,f])).values()];
    const hasPress = session.events.some(e => e.type === 'pointer_down');
    for (const ev of session.events) {
      const click = hasPress ? ev.type === 'pointer_down' : ev.type === 'click';
      for (const sample of ev.type === 'pointer' ? ev.samples || [] : ['click', 'pointer_down', 'pointer_up'].includes(ev.type) ? [ev] : []) {
        const t = pointerVideoTime(sample, session.session, frames), p = sample.at?.src_px;
        if (t == null || !Number.isFinite(t) || !Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        const point = { t, x: p.x, y: p.y, visible: sample.in_capture !== false };
        points.push(point);
        if (ev.type === 'pointer') pointerSamples++;
        if (click && point.visible && t >= w.srcIn-POINTER_PRESET.rippleDelay-POINTER_PRESET.rippleDuration && t < w.srcOut) clicks.push(point);
      }
    }
    points.sort((a,b) => a.t-b.t); clicks.sort((a,b) => a.t-b.t);
    const unique = [...new Map(points.map(p => [US(p.t), p])).values()];
    if (pointerSamples<2 || !unique.length || unique[0].t>w.srcOut || unique.at(-1).t<w.srcIn) {
      if (op.segment) fail(`Recording ${s.id} has no continuous cursor telemetry covering this source window.`);
      result.skippedNoCursor.push(s.id); continue;
    }
    const firstFrame=Math.max(0,Math.ceil(w.tgtIn*fps-1e-6)), endFrame=Math.ceil((tt.start+tt.duration)/1e6*fps-1e-6);
    const at=firstFrame/fps, duration=(endFrame-firstFrame)/fps, start=w.srcIn+(at-w.tgtIn)*w.speed;
    if (!(duration>0)) { if(op.segment) fail('Recording has no complete output frame for a cursor.'); continue; }
    const frameTimes=Array.from({length:endFrame-firstFrame+1},(_,i)=>i/fps);
    const outputTimes=new Map(frameTimes.map(t=>[US(start+t*w.speed),t]));
    const first = unique[0];
    // Warm the spring before the trim, so changing a cut does not restart cursor inertia.
    let previous = Math.max(first.t, start - 2), wasVisible = false;
    const initial = atTime(unique, previous) || first;
    const stateX = { value: initial.x, velocity: 0 }, stateY = { value: initial.y, velocity: 0 };
    const samples = [];
    const sourceTimes = [];
    for (let t = previous; t < start+duration*w.speed; t += 1 / 120) sourceTimes.push(t);
    sourceTimes.push(...frameTimes.map(t => start+t*w.speed));
    let lastAlpha = 0, clickIndex = -1;
    const clickTimes = new Set(clicks.map(c => US(c.t)));
    for (const t of [...new Map(sourceTimes.map(t => [US(t),US(t)/1e6])).values()].sort((a,b)=>a-b)) {
      const p = atTime(unique, t);
      if (!p) continue;
      if (!wasVisible || !p.visible) { stateX.value=p.x; stateY.value=p.y; stateX.velocity=stateY.velocity=0; }
      else { stepPointerSpring(stateX,p.x,Math.max(0,t-previous)); stepPointerSpring(stateY,p.y,Math.max(0,t-previous)); }
      previous=t; wasVisible=p.visible;
      if (!outputTimes.has(US(t))) continue;
      const projected=project(doc,s,m,t,stateX.value,stateY.value), alpha=Number(visibleAt(doc,s,m,{...p,x:stateX.value,y:stateY.value},projected));
      while (clickIndex+1<clicks.length && clicks[clickIndex+1].t<=t) clickIndex++;
      const click=clicks[clickIndex], age=click ? t-click.t : Infinity;
      const bounce=age<=.35 ? 1-.16*Math.sin(Math.PI*age/.35) : 1;
      // The PNG hotspot is its center; scaling never moves the clicked pixel.
      const side=(256/108)*28*size*(m.width/1920)*projected.fit;
      const v=[side*projected.sx/Math.min(doc.canvas_config.width,doc.canvas_config.height)*bounce,
        side*projected.sy/Math.min(doc.canvas_config.width,doc.canvas_config.height)*bounce,
        (projected.x-doc.canvas_config.width/2)/(doc.canvas_config.width/2),
        (doc.canvas_config.height/2-projected.y)/(doc.canvas_config.height/2)];
      if (dagger) {
        const W=doc.canvas_config.width,H=doc.canvas_config.height;
        const pixelScale=(capture.cursor?.height_at_1920 ?? 95)/1316*(size/2.5)*(m.width/1920)*projected.fit*bounce;
        const assetFit=Math.min(W/645,H/1316);
        v[0]=pixelScale*projected.sx/assetFit;
        v[1]=pixelScale*projected.sy/assetFit;
        // The blade mirrored tip (1,0) stays on the click, including during press scaling.
        v[2]+=(322.5-1)*pixelScale*projected.sx/(W/2);
        v[3]-=658*pixelScale*projected.sy/(H/2);
      }
      const time=outputTimes.get(US(t));
      const keep=alpha!==lastAlpha || clickTimes.has(US(t));
      if (alpha!==lastAlpha && samples.length) samples.at(-1).keep=true;
      samples.push({t:time,v,alpha,keep}); lastAlpha=alpha;
    }
    if (!samples.length) { result.skippedNoCursor.push(s.id); continue; }
    if (samples[0].t>0) samples.unshift({t:0,v:samples[0].v,alpha:0,keep:true});
    const W=doc.canvas_config.width,H=doc.canvas_config.height;
    const errorUnits=[Math.min(W,H),Math.min(W,H),W/2,H/2];
    const reduced=simplifyMotion(samples.map(p=>({...p,v:p.v.map((v,i)=>v*errorUnits[i])})),.6).map(p=>({...p,v:p.v.map((v,i)=>v/errorUnits[i])}));
    const rings=[];
    for (const click of clicks) {
      const ringStart=Math.max(firstFrame,Math.ceil((w.tgtIn+(click.t+.175-w.srcIn)/w.speed)*fps-1e-6));
      const ringEnd=Math.min(endFrame,Math.ceil((w.tgtIn+(click.t+.775-w.srcIn)/w.speed)*fps-1e-6));
      const from=(ringStart-firstFrame)/fps, length=(ringEnd-ringStart)/fps;
      if (!(length>0)) continue;
      const keys=[];
      for(let i=0;i<=ringEnd-ringStart;i++) {
        const local=Math.min(length,i/fps), sourceT=start+(from+local)*w.speed;
        const q=project(doc,s,m,sourceT,click.x,click.y), progress=Math.min(1,Math.max(0,(sourceT-click.t-.175)/.6));
        const h=28*size*(m.width/1920)*q.fit, fade=(1-progress)**3;
        // PNG radius is 104px in a 256px canvas. Scaling its stroke is an intentional
        // approximation; native editable transforms cannot keep the stroke constant.
        const side=Math.max(.5,(1-fade)*h*1.95)*256/104;
        keys.push({t:local,v:[side*q.sx/Math.min(W,H),side*q.sy/Math.min(W,H),(q.x-W/2)/(W/2),(H/2-q.y)/(H/2)],alpha:visibleAt(doc,s,m,click,q)?.6*fade:0});
      }
      rings.push({at:at+from,duration:length,keys});
    }
    result.clips.push({id:s.id,trackIndex,at,duration,pointerArt:dagger?'dagger':'pointer',points:reduced,visibility:samples.map(p=>({t:p.t,alpha:p.alpha})),rings,rawSamples:unique.length});
  }
  if (op.segment && !result.clips.length) fail('Selected segment is not a supported recording with continuous cursor telemetry.');
  return result;
}

function alphaKeys(segment, points, id, stepped = false, fps = 30) {
  const source=segment.common_keyframes[0], template=source.keyframe_list[0];
  if (stepped) {
    // One binary value per rendered frame. A pair one microsecond apart can collapse
    // into duplicate keys when native CapCut snaps it to frame boundaries on save.
    const frames=[], duration=segment.target_timerange.duration/1e6;
    let index=0;
    for (let frame=0; frame/fps<duration; frame++) {
      const t=frame/fps;
      while(index+1<points.length && US(points[index+1].t)<=US(t)) index++;
      frames.push({t,alpha:points[index].alpha});
    }
    frames.push({t:duration,alpha:points.at(-1).alpha});
    points=frames;
  }
  const retained=[];
  for (const [i,p] of points.entries()) {
    const prev=points[i-1];
    if (i===0 || i===points.length-1 || p.alpha!==prev?.alpha || p.alpha!==points[i+1]?.alpha) retained.push(p);
  }
  const unique=[...new Map(retained.map(p=>[US(p.t),p])).values()];
  segment.common_keyframes.push({...clone(source),id:seededId(id,'alpha'),property_type:'KFTypeAlpha',keyframe_list:unique.map(p=>({...clone(template),id:seededId(id,`alpha:${p.t}`),time_offset:US(p.t),values:[p.alpha]}))});
}

export function opPolishedCursor(doc, op, context = {}) {
  const plan=planPolishedCursor(doc,op,context);
  if (op.plan || !plan.clips.length) return {changed:0,...plan};
  const ids=new Set(plan.clips.map(c=>c.id)), removed=new Set(), ownedTracks=new Set();
  for(const track of doc.tracks) track.segments=(track.segments||[]).filter(s=>{
    if (![...ids].some(id=>s.desc===`cursor:halo:${id}` || s.desc===`cursor:polished:${id}` || s.desc===`cursor:ripple:${id}`)) return true;
    ownedTracks.add(track);
    for(const id of [s.material_id,...s.extra_material_refs||[]]) removed.add(id);
    return false;
  });
  removeUnreferencedMaterials(doc,removed);
  // Remove only empty owned helper lanes, including lanes renamed by native CapCut.
  doc.tracks=doc.tracks.filter(t=>t.segments?.length || !ownedTracks.has(t));
  const add=(row,kind,index,laneIndex,at,duration,points,visibility)=>{
    const id=seededId(`cursor:${doc.id}`,`${row.id}:${kind}:${index}`), laneName=`cursor-${kind}:${row.id}:${laneIndex}`;
    const art=kind==='polished'?row.pointerArt:'ripple';
    opClipAdd(doc,{media:ART(art),track:laneName,id,at,duration,generated:true,localize:true,width:art==='dagger'?645:256,height:art==='dagger'?1316:256,mediaDuration:10800000000,volume:0,desc:`cursor:${kind}:${row.id}`,__seed:id},context);
    const lane=doc.tracks.find(t=>t.name===laneName), s=lane.segments.find(s=>s.id===id);
    doc.materials.videos.find(m=>m.id===s.material_id).type='photo';
    if (art==='dagger') s.clip.flip={horizontal:true,vertical:false};
    s.clip.scale={x:points[0].v[0],y:points[0].v[1]};
    s.clip.transform={x:points[0].v[2],y:points[0].v[3]};
    const unique=[...new Map(points.map(p=>[US(p.t),p])).values()];
    writeCameraPath(s,unique,{seed:id}); alphaKeys(s,visibility,id,kind==='polished',doc.fps||30);
    // Put effects immediately above their source, below face/background siblings above it.
    doc.tracks.splice(doc.tracks.indexOf(lane),1);
    const sourceIndex=doc.tracks.findIndex(t=>t.segments?.some(s=>s.id===row.id));
    doc.tracks.splice(sourceIndex+1,0,lane);
  };
  for(const row of plan.clips) {
    // Reuse non-overlapping ripple lanes so a long take does not gain one track per click.
    const laneEnds=[];
    row.rings.forEach((r,i)=>{
      let lane=laneEnds.findIndex(end=>end<=r.at); if(lane<0)lane=laneEnds.length; laneEnds[lane]=r.at+r.duration;
      add(row,'ripple',i,lane,r.at,r.duration,r.keys,r.keys);
    });
    add(row,'polished',0,0,row.at,row.duration,row.points,row.visibility);
  }
  // Tracks are now in final order; use the existing stacking convention.
  renumberTracks(doc);
  return {changed:plan.clips.length,...plan};
}
