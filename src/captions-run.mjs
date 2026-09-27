import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { applySpec, assertCapcutClosed, CapcutError, loadProject, contentEndUs, resolveMediaPath } from './core.mjs';
import { principalTrack } from './polish.mjs';
import { layoutAudit } from './layouts.mjs';
import { pythonForTool } from './python.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw new CapcutError(`${code}: ${message}`, {code}); };
function working(projectDir) {
  const groups = loadProject(projectDir).groups;
  return groups.find(g=>g.name.startsWith('timeline:'))?.doc || groups[0].doc;
}
function generate(request) {
  const python = pythonForTool('caption_generate.py');
  return new Promise((resolve,reject) => {
    const child = spawn(python.executable,[path.join(ROOT,'tools/caption_generate.py')],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill('SIGTERM'),20*60*1000);
    child.stdout.on('data', data=>{stdout+=data;if(stdout.length>16*1024*1024)child.kill('SIGTERM');});
    child.stderr.on('data', data=>{stderr=(stderr+data).slice(-12000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0)return reject(new CapcutError(`CAPTION_GENERATION: ${stderr || `worker exited ${code}`}`,{code:'CAPTION_GENERATION'}));
      try {resolve(JSON.parse(stdout));}catch {reject(new CapcutError('CAPTION_GENERATION: worker returned invalid JSON',{code:'CAPTION_GENERATION'}));}
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function runCaptions(projectDir,args,options={}) {
  const doc = working(projectDir), before = digest(doc);
  let bundle;
  if(args.cues){
    if(args.script || args.track) fail('CAPTION_INPUT','--cues uses timeline timestamps directly; do not combine it with --script or --track.');
    const value=JSON.parse(fs.readFileSync(path.resolve(args.cues),'utf8'));
    bundle=Array.isArray(value)?{version:1,cues:value}:(value.bundle || value);
    if(!bundle || (bundle.version!=null && bundle.version!==1))fail('CAPTION_INPUT','Unsupported cue bundle version.');
  }else{
    if(doc.tracks.some(t=>t.name?.startsWith('captions:')))fail('CAPTION_CONFLICT','Caption track already exists. Keep manual edits; explicitly remove it before regenerating.');
    let trackIndex;
    if(args.track!=null){
      const matches=doc.tracks.map((t,i)=>({t,i})).filter(({t,i})=>t.name===String(args.track)||String(i)===String(args.track));
      if(matches.length!==1 || !['video','audio'].includes(matches[0].t.type))fail('CAPTION_TRACK','Select one narration video/audio track.');
      trackIndex=matches[0].i;
    }else trackIndex=principalTrack(doc).index;
    const duration=contentEndUs(doc,projectDir)/1e6;
    if(!(duration>0))fail('CAPTION_EMPTY','No edited content.');
    const script=args.script?fs.readFileSync(path.resolve(args.script),'utf8'):'';
    let scenes=[];
    try {scenes=layoutAudit(doc,doc.tracks[trackIndex].type==='video'?trackIndex:null);}
    catch(error){if(doc.tracks[trackIndex].type==='video')throw error;}
    // A single untouched imported master can already contain a split-screen edit.
    // In that case inspect its actual pixels with Staging's shot/Apple Vision detector.
    const segments=doc.tracks[trackIndex].segments;
    const s=segments.length===1?segments[0]:null;
    const otherPicture=doc.tracks.some((t,i)=>i!==trackIndex && ['video','sticker'].includes(t.type) && t.segments?.length);
    const identity=s && s.target_timerange.start===0 && s.source_timerange?.start===0
      && s.source_timerange.duration===s.target_timerange.duration && !s.reverse
      && !s.clip?.rotation && (s.clip?.scale?.x??1)===1 && (s.clip?.scale?.y??1)===1
      && !(s.clip?.transform?.x||s.clip?.transform?.y) && !s.extra_material_refs?.some(id=>(doc.materials.common_mask||[]).some(m=>m.id===id));
    const material=identity&&!otherPicture?(doc.materials.videos||[]).find(m=>m.id===s.material_id):null;
    const visualSource=material?.width===doc.canvas_config.width && material?.height===doc.canvas_config.height
      ?resolveMediaPath(material.path,projectDir):null;
    if(options.dryRun)return {dryRun:true,planOnly:true,project:projectDir,track:trackIndex,duration,
      scenes,steps:['mix edited narration only','strong ASR','Staging single-word cues and typo pass','native editable text transaction'],
      warning:'No ASR or model calls were run; use --cues with --dry-run to validate a prepared caption transaction.'};
    assertCapcutClosed({forceRunning:options.forceRunning});
    bundle=await generate({projectDir,document:doc,trackIndex,duration,scenes,script,visualSource,language:args.lang||'ar'});
    // ASR can take time. Never apply stale timing to a project edited in the meantime.
    if(digest(working(projectDir))!==before)fail('CAPTION_PROJECT_CHANGED','Project changed during transcription; no caption layers were written.');
  }
  const result=applySpec(projectDir,{version:1,name:'captions',operations:[{
    op:'captions',name:args.name||'suheil',cues:bundle.cues,language:args.lang||bundle.language||'ar',
  }]},options);
  return {...result,bundle,review:{status:'needs_review',native_verified:false},
    warning:'Editable text layers, not burned media. Native visual parity is experimental; inspect in CapCut.'};
}
