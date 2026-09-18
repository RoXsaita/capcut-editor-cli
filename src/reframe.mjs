import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CapcutError, resolveMediaPath } from './core.mjs';
import { principalTrack } from './polish.mjs';
import { isBrollSegment } from './broll-lint.mjs';
import { opScaleKeyframe } from './add.mjs';
import { keyframeValue, applyFreeCurve, simplifyMotion } from './easing.mjs';
const fail = m => { throw new CapcutError(m, { code:'REFRAME_UNSUPPORTED',exitCode:2 }); };
const helper = fileURLToPath(new URL('../tools/vision/face',import.meta.url));
const US = t => Math.round(t*1e6);

export function detectFaces(file,start,duration) {
  if(!fs.existsSync(helper)) fail('Build the on-device helper: swiftc -O tools/vision/face.swift -o tools/vision/face');
  try{return JSON.parse(execFileSync(helper,[file,String(start),String(duration)],{encoding:'utf8',maxBuffer:32*1024*1024}));}
  catch(e){fail(`Face detection failed: ${e.stderr || e.message}`);}
}

// Refine a linear simplification against the actual eased reconstruction, not its chord.
export function simplifyEased(points,tolerance=6) {
  let result=simplifyMotion(points,tolerance);
  for(;;){
    const channels=points[0].v.map((_,j)=>applyFreeCurve(result.map(p=>({time_offset:US(p.t),values:[p.v[j]]}))));
    let worst=tolerance, candidate=null;
    for(const p of points){
      const error=Math.hypot(...p.v.map((v,j)=>v-keyframeValue(channels[j],US(p.t))));
      if(error>worst && !result.includes(p)){worst=error;candidate=p;}
    }
    if(!candidate) return result;
    result.push(candidate);result.sort((a,b)=>a.t-b.t);
  }
}

export function planReframe(doc,op={},context={}) {
  if(!!op.segment===!!op.auto) fail('reframe requires --segment ID or --auto.');
  const clips=principalTrack(doc).track.segments.filter(s=>op.auto||s.id===op.segment);
  if(op.segment&&!clips.length)fail('Reframe only the principal talking-head track.');
  const W=doc.canvas_config.width,H=doc.canvas_config.height;
  const plan={clips:[],skipped:[],sampleFps:10,deadbandPx:12,smoothingMs:400,maxScale:1.25};
  for(const s of clips){
    const m=doc.materials.videos.find(m=>m.id===s.material_id),st=s.source_timerange,tt=s.target_timerange,c=s.clip||{};
    const reject=reason=>{if(op.segment)fail(reason);plan.skipped.push({id:s.id,reason});};
    if(isBrollSegment(s,m)||s.reverse||Math.abs(st.duration/tt.duration-1)>1e-6||(doc.materials.speeds||[]).some(m=>(s.extra_material_refs||[]).includes(m.id)&&m.curve_speed)){reject('Only 1x forward talking-head footage is supported.');continue;}
    if((doc.materials.common_mask||[]).some(m=>(s.extra_material_refs||[]).includes(m.id))||c.rotation||c.flip?.horizontal||c.flip?.vertical){reject('Reframe requires an unmasked, unrotated full-face clip.');continue;}
    if((s.common_keyframes||[]).some(b=>/^KFType(Scale|Position)/.test(b.property_type))){reject('Existing camera motion overlaps; keep that move or clear it first.');continue;}
    const file=resolveMediaPath(m.path,context.projectDir)||m.path;
    const rows=op.boxes?.[s.id] || detectFaces(file,st.start/1e6,st.duration/1e6);
    if(!rows.length||rows.some(r=>r.boxes?.length!==1)){plan.skipped.push({id:s.id,reason:'missing or multiple faces'});continue;}
    if(rows.some((r,i)=>!Number.isFinite(r.t)||r.t<st.start/1e6||r.t>=(st.start+st.duration)/1e6||(i&&r.t<=rows[i-1].t)||!Object.values(r.boxes[0]).every(Number.isFinite)||r.boxes[0].w<=0||r.boxes[0].h<=0))fail('Invalid face samples.');
    const fit=Math.min(W/m.width,H/m.height),first=rows[0].boxes[0];
    const drift=Math.max(...rows.map(r=>Math.hypot((r.boxes[0].x+r.boxes[0].w/2-first.x-first.w/2)*m.width*fit,(r.boxes[0].y-first.y)*m.height*fit)));
    if(drift<=12){plan.skipped.push({id:s.id,reason:'inside-deadband'});continue;}
    // Enough overscan to center the face with 6% headroom without exposing canvas.
    const needed = rows.map(({boxes:[b]})=>{
      const x=(b.x+b.w/2)*m.width, y=Math.max(0,b.y-.5*b.h)*m.height;
      return Math.max(W/(2*x*fit),W/(2*(m.width-x)*fit),.06*H/(y*fit),.94*H/((m.height-y)*fit));
    });
    const scale=Math.max(c.scale?.x||1,...needed);
    if(scale>1.35)fail('Face needs scale above 1.35; choose another layout.');
    const points=[];let previous=null;
    for(const row of rows){
      const b=row.boxes[0], px=(b.x+b.w/2)*m.width, py=Math.max(0,b.y-.5*b.h)*m.height;
      const target=[scale,scale,-(px-m.width/2)*fit*scale/(W/2),(H/2-.06*H+(py-m.height/2)*fit*scale)/(H/2)];
      const alpha=previous?1-Math.exp(-(row.t-previous.t)/.4):1;
      const v=previous?target.map((x,j)=>previous.v[j]+alpha*(x-previous.v[j])):target;
      const left=W/2+v[2]*W/2+(b.x*m.width-m.width/2)*fit*scale, top=H/2-v[3]*H/2+(b.y*m.height-m.height/2)*fit*scale;
      const width=b.w*m.width*fit*scale,height=b.h*m.height*fit*scale;
      const visible=Math.max(0,Math.min(W,left+width)-Math.max(0,left))*Math.max(0,Math.min(H,top+height)-Math.max(0,top))/(width*height);
      const headTop=top-.5*height;
      if(visible<.95||headTop<.03*H)fail('Reframe cannot keep the face 95% visible with 3% headroom; choose another layout.');
      points.push({t:row.t,v});previous={t:row.t,v};
    }
    // Pixel-weight all channels so the bound is meaningful on this canvas.
    const weights=[W,H,W/2,H/2];
    const simple=simplifyEased(points.map(p=>({t:p.t,v:p.v.map((v,j)=>v*weights[j])})),3*W/1080);
    plan.clips.push({id:s.id,scale,rawSamples:rows.length,points:simple.map(p=>({t:p.t,v:p.v.map((v,j)=>v/weights[j])}))});
  }
  return plan;
}

export function opReframe(doc,op,context={}) {
  const plan=planReframe(doc,op,context);
  if(op.plan)return {changed:0,...plan};
  for(const row of plan.clips)opScaleKeyframe(doc,{selector:{id:row.id},path:row.points,ease:true,__seed:op.__seed});
  return {changed:plan.clips.length,...plan};
}
