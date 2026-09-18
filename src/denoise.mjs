import path from 'node:path';
import { resolveMediaPath } from './core.mjs';
import { principalTrack } from './polish.mjs';
import { classifyLoudnessRole, analyzeAudio } from './loudness.mjs';
import { loadEnergy10, loadTranscript, median } from './stress.mjs';
import { opReplaceMedia } from './add.mjs';
import { derivedFailure as fail, derivedPath, renderDerived } from './derived-media.mjs';

// Use actual non-word gaps, not quiet speech mistaken for room tone.
export function pauseFloor(energy, transcript) {
  const bin=Number(energy?.bin), db=energy?.db;
  if(!Number.isFinite(bin)||bin<=0||bin>.1||!Array.isArray(db)||!db.length||!db.every(Number.isFinite)) fail('denoise needs a valid energy10 index; run cut first.');
  const rows=Array.isArray(transcript)?transcript:transcript?.segments;
  const words=(rows||[]).flatMap(row=>row.words?.length?row.words:[row]);
  if(!words.length || words.some(w=>!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<=w.start)) fail('denoise needs source-time speech intervals from the cut transcript.');
  const duration=db.length*bin, spans=words.map(w=>[Math.max(0,w.start-.1),Math.min(duration,w.end+.1)]).sort((a,b)=>a[0]-b[0]);
  const pauses=[]; let end=0;
  for(const [a,b] of [...spans,[duration,duration]]) {
    if(a-end>=.2) pauses.push([end,a]);
    end=Math.max(end,b);
  }
  const levels=pauses.flatMap(([a,b])=>db.slice(Math.ceil(a/bin),Math.floor(b/bin)));
  if(levels.length*bin<.2) fail('No measured pause of at least 200 ms; leave the voice unchanged.');
  return {pauseFloorDb:median(levels),pauseSeconds:levels.length*bin};
}

export function planDenoise(doc,op={},context={}) {
  const {track}=principalTrack(doc), sources=new Map(), skipped=[];
  for(const s of track.segments) {
    const m=doc.materials.videos.find(m=>m.id===s.material_id);
    if(s.volume===0||classifyLoudnessRole(track,s,m)!=='speech') continue;
    const st=s.source_timerange,tt=s.target_timerange;
    if(!st||!tt||![st.start,st.duration,tt.start,tt.duration].every(Number.isSafeInteger)||st.start<0||tt.start<0||st.duration<=0
      ||st.duration!==tt.duration||(s.speed??1)!==1||s.reverse
      ||(doc.materials.speeds||[]).some(m=>(s.extra_material_refs||[]).includes(m.id)&&(m.curve_speed||(m.speed??1)!==1))) fail('denoise refuses retimed or reversed speech; faces must stay 1x.');
    const source=resolveMediaPath(m?.path,context.projectDir)||m?.path;
    if(!source||m.type!=='video') fail('denoise requires the original talking-head video with embedded audio.');
    if(path.basename(path.dirname(source))==='CapcutctlDerived' && /^denoise-[a-f0-9]{20}\.mp4$/.test(path.basename(source))) {skipped.push({id:s.id,reason:'already-denoised'});continue;}
    if(!sources.has(source))sources.set(source,{source,ids:[],width:m.width,height:m.height,duration:m.duration/1e6});
    sources.get(source).ids.push(s.id);
  }
  if(sources.size>1&&(op.energy||op.transcript||op.words||op.wordsFile))fail('Explicit speech indexes require a single source take.');
  const proposed=[];
  for(const row of sources.values()) {
    const measurement=pauseFloor(loadEnergy10(row.source,op),loadTranscript(row.source,op));
    Object.assign(row,measurement);
    if(row.pauseFloorDb<=-55){skipped.push({...row,reason:'already-quiet'});continue;}
    if(!(row.duration>0)||!Number.isFinite(row.duration))fail('Source duration is missing; cannot preserve the complete take.');
    const filter=`afftdn=nr=12:nf=${Math.max(-80,Math.min(-20,row.pauseFloorDb))}:tn=1`;
    const recipe={kind:'denoise',version:1,filter};
    proposed.push({...row,filter,output:derivedPath(context.projectDir,row.source,recipe)});
  }
  return {sources:proposed,skipped,method:'FFmpeg afftdn spectral noise reduction; video stream copied',thresholdDb:-55};
}

export function opDenoise(doc,op={},context={}) {
  const plan=planDenoise(doc,op,context);
  if(op.plan||!plan.sources.length)return {changed:0,...plan};
  const {track}=principalTrack(doc);
  const voiceDoc=()=>({...doc,tracks:[track]});
  const before=context.dryRun?null:op.measurements?.before??analyzeAudio(voiceDoc(),context.projectDir).mix;
  for(const row of plan.sources) {
    renderDerived(row.output,['-i',row.source,'-map','0:v:0','-map','0:a:0','-c:v','copy','-af',row.filter,
      '-c:a','aac','-b:a','192k','-movflags','+faststart'],context,row);
    for(const id of row.ids)opReplaceMedia(doc,{selector:{id},path:row.output,derivedFrom:row.source,derivedOffset:0,
      width:row.width,height:row.height,__seed:op.__seed},context);
  }
  const after=context.dryRun?null:op.measurements?.after??analyzeAudio(voiceDoc(),context.projectDir).mix;
  return {changed:plan.sources.reduce((n,r)=>n+r.ids.length,0),...plan,beforeVoice:before,afterVoice:after,
    measurementScope:'principal-track edited audio, same loudness --measure engine',measurementPending:Boolean(context.dryRun)};
}
