import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CapcutError, resolveMediaPath } from './core.mjs';
import { isEphemeralPath } from './origin.mjs';
import { brollWindows } from './polish.mjs';
import { resolveClip, opReplaceMedia } from './add.mjs';
import { rescaleKeyframes, setSpeed } from './pace.mjs';
import { probeMedia } from './create.mjs';

export function derivedFailure(message) { throw new CapcutError(message,{code:'DERIVED_MEDIA_REFUSED',exitCode:2}); }
export function derivedPath(projectDir, source, recipe) {
  if(!projectDir || isEphemeralPath(projectDir)) derivedFailure('Derived media needs a durable project directory.');
  const stat=fs.statSync(source);
  const hash=crypto.createHash('sha256').update(JSON.stringify([source,stat.size,stat.mtimeMs,recipe])).digest('hex').slice(0,20);
  return path.join(projectDir,'Resources','CapcutctlDerived',`${recipe.kind}-${hash}.mp4`);
}
export function renderDerived(file,args,{dryRun=false}={},expected) {
  if(dryRun) return;
  const validate=file=>{
    const actual=probeMedia(file);
    if(expected && (actual.width!==expected.width || actual.height!==expected.height
      || Math.abs(actual.duration/1e6-expected.duration)>.05)) derivedFailure('Derivative dimensions or duration differ from the planned source window.');
  };
  if(fs.existsSync(file)) { validate(file); return; }
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=path.join(path.dirname(file),`${crypto.randomUUID()}.pending.mp4`);
  try {
    const result=spawnSync('ffmpeg',['-v','error','-nostdin','-y',...args,temp],{encoding:'utf8',timeout:900000,maxBuffer:4*1024*1024});
    if(result.error||result.status!==0) derivedFailure(`ffmpeg failed: ${result.error?.message||result.stderr}`);
    validate(temp);
    fs.renameSync(temp,file);
  } finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function planBlurBroll(doc,op={},context={}) {
  if(!op.segment) derivedFailure('blur-broll requires --segment ID.');
  const {segment:s}=resolveClip(doc,{id:op.segment});
  if(!brollWindows(doc,context).some(w=>w.id===s.id)) derivedFailure('Only recording B-roll below the principal track may be blurred.');
  const st=s.source_timerange,tt=s.target_timerange,speed=st.duration/tt.duration;
  if(!Number.isFinite(speed)||speed<8||speed>100) derivedFailure('Blur requires existing constant speed from 8x to 100x. Pace the clip first.');
  if(s.reverse||(doc.materials.speeds||[]).some(m=>(s.extra_material_refs||[]).includes(m.id)&&m.curve_speed))derivedFailure('Reverse and speed curves are unsupported.');
  if(s.volume!==0)derivedFailure('Mute recording audio first; this picture-only derivative does not retain sped-up sound.');
  const m=doc.materials.videos.find(m=>m.id===s.material_id);
  const source=resolveMediaPath(m.path,context.projectDir)||m.path;
  const recipe={kind:'blur-broll',version:1,start:st.start/1e6,sourceDuration:st.duration/1e6,duration:tt.duration/1e6,speed};
  const output=derivedPath(context.projectDir,source,recipe);
  const filter=`minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir,tmix=frames=${Math.ceil(speed*2)},setpts=(PTS-STARTPTS)/${speed},fps=30,tpad=stop_mode=clone:stop_duration=${recipe.duration}`;
  return {...recipe,id:s.id,source,output,width:m.width,height:m.height,filter};
}
export function opBlurBroll(doc,op,context={}) {
  const plan=planBlurBroll(doc,op,context);
  if(op.plan)return {changed:0,...plan};
  const {segment:s}=resolveClip(doc,{id:plan.id}),st={...s.source_timerange};
  for(const m of doc.materials.speeds||[]) if((s.extra_material_refs||[]).includes(m.id)
    && doc.tracks.some(t=>t.segments.some(o=>o.id!==s.id&&(o.extra_material_refs||[]).includes(m.id)))) derivedFailure('The speed material is shared with another clip.');
  renderDerived(plan.output,['-ss',String(plan.start),'-t',String(plan.sourceDuration),'-i',plan.source,'-an','-vf',plan.filter,
    '-t',String(plan.duration),'-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart'],context,plan);
  rescaleKeyframes(s,st.start,st.duration,0,s.target_timerange.duration);
  s.source_timerange={start:0,duration:s.target_timerange.duration};
  opReplaceMedia(doc,{selector:{id:s.id},path:plan.output,derivedFrom:plan.source,derivedOffset:plan.start,
    width:plan.width,height:plan.height,mediaDuration:s.target_timerange.duration,__seed:op.__seed},context);
  setSpeed(doc,s,1,{sourceStart:0});
  return {changed:1,...plan,playbackSpeed:1};
}
