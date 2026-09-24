import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CapcutError, loadPreset, seededId, localizeMedia } from './core.mjs';
import { imageSize } from './signature.mjs';
import { profileValue } from './profile.mjs';

export const MOTION_RECIPES = ['gradient', 'shimmer', 'spotlight', 'orbit-glow'];
const copy = structuredClone;
const fail = (code, detail) => { throw new CapcutError(`${code}: ${detail}`, {code}); };
const us = x => Math.round(x * 1e6);
const rgb = hex => hex.match(/\w\w/g).map(n => parseInt(n,16)/255);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ownedDigest(doc, tracks) {
  const refs = new Set(tracks.flatMap(t=>t.segments).flatMap(s=>[s.material_id,...s.extra_material_refs]));
  const materials = Object.fromEntries(Object.entries(doc.materials).map(([kind,list])=>[kind,list.filter(m=>refs.has(m.id))]).filter(([,list])=>list.length));
  const clean = copy(tracks);
  for(const t of clean)for(const s of t.segments)s.desc='';
  return digest({tracks:clean,materials});
}

/** Native text/compound/mask structures harvested from CapCut, not a proxy render. */
export function opMotion(doc, op, context = {}) {
  if (!MOTION_RECIPES.includes(op.recipe)) fail('MOTION_RECIPE', MOTION_RECIPES.join(', '));
  if (!op.name || !/^[\w.-]{1,80}$/.test(op.name)) fail('MOTION_NAME', 'supply a stable alphanumeric name');
  if (!!op.text === !!op.logo) fail('MOTION_INPUT', 'exactly one nonempty text or logo is required');
  if (op.text && (typeof op.text !== 'string' || op.text.length>500)) fail('MOTION_TEXT','text is limited to 500 UTF-16 units');
  const at = Number(op.at ?? 0), duration = Number(op.duration ?? 4), scale = Number(op.scale ?? (op.logo ? .5 : 2));
  const x = Number(op.x ?? 0), y = Number(op.y ?? 0);
  if (![at,duration,scale,x,y].every(Number.isFinite) || at<0 || duration<.3 || duration>120 || scale<=0 || scale>10) fail('MOTION_RANGE','invalid timing, scale or position');
  const color = op.color ?? profileValue('motion.color'), accent = op.accent ?? profileValue('motion.accent');
  if (![color,accent].every(v=>typeof v==='string' && /^[0-9a-f]{6}$/i.test(v))) fail('MOTION_COLOR','use six hex digits without #');
  if (op.recipe==='gradient' && op.logo) fail('MOTION_INPUT','gradient requires native text');
  const dims = op.logo ? imageSize(op.logo) : null;
  if (op.logo && !dims) fail('MOTION_LOGO','logo must be an existing readable image');
  const canonical = {recipe:op.recipe,text:op.text||null,logo:op.logo?path.resolve(op.logo):null,at,duration,scale,x,y,color,accent};
  const fingerprint=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const prefix=`motion:${op.name}:`;
  const owned=doc.tracks.filter(t=>t.name?.startsWith(prefix));
  if (owned.length) {
    const marker = prefix+fingerprint+':'+ownedDigest(doc,owned);
    const expected = op.recipe==='spotlight'?1:2;
    if (owned.length===expected && owned.every(t=>t.segments.length===1 && t.segments.every(s=>s.desc===marker))) return {unchanged:true,name:op.name};
    fail('MOTION_NAME_CONFLICT','this name already exists with different inputs; choose another name or remove it explicitly');
  }
  const p=loadPreset('motion');
  const maskType={gradient:'split',shimmer:'filmstrip',spotlight:'circle','orbit-glow':'split'}[op.recipe];
  const required=[p.masks[maskType],...(['orbit-glow','spotlight'].includes(op.recipe)?[p.blur]:[])];
  if (context.checkResources!==false) for(const r of required) {
    if (!r.path || !fs.existsSync(r.path)) fail('MOTION_RESOURCE_MISSING',`download ${r.name} in CapCut, or harvest a local motion preset; expected ${r.path}`);
  }
  let n=0;
  const mint=tag=>seededId(op.__seed || context.seed || fingerprint,`motion:${op.name}:${tag}:${n++}`);
  function fresh(value) {
    const ids=new Map();
    const collect=v=>{if (!v || typeof v!=='object')return;for(const [k,a] of Object.entries(v)){if(typeof a==='string' && /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(a) && (k==='id'||k==='constant_material_id'||k==='combination_id'))ids.set(a,mint(k));else collect(a);}};
    collect(value);
    const replace=v=>typeof v==='string'?(ids.get(v)??v):Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,a])=>[k,replace(a)])):v;
    return replace(value);
  }
  const durationUs=us(duration), atUs=us(at);
  const localized=op.logo && context.projectDir?localizeMedia(context.projectDir,path.resolve(op.logo),undefined,{dryRun:context.dryRun}):op.logo;
  const add=(kind,value)=>{(doc.materials[kind] ||= []).push(value);return value;};
  function layer(label, tint=color, layerScale=scale) {
    const tpl=fresh(p.compound), draftMat=tpl.materials.drafts[0], nested=draftMat.draft;
    nested.id=mint('nested');nested.name=prefix+label;nested.duration=durationUs;nested.fps=doc.fps;nested.canvas_config=copy(doc.canvas_config);
    const textDoc=fresh(p.text);
    nested.materials=textDoc.materials;nested.tracks=textDoc.tracks;
    const textSeg=nested.tracks.flatMap(t=>t.segments)[0];
    textSeg.target_timerange={start:0,duration:durationUs};textSeg.common_keyframes=[];textSeg.clip.scale={x:layerScale,y:layerScale};textSeg.clip.transform={x:0,y:0};
    if(op.logo){
      const sig=loadPreset('signature');const mat=fresh(sig.logoMaterialTemplate);
      mat.path=localized;mat.width=dims.width;mat.height=dims.height;mat.material_name=path.basename(op.logo);mat.duration=durationUs;mat.id=mint('photo');mat.local_material_id=mint('photo-local');
      nested.materials.videos=[mat];nested.materials.texts=[];textSeg.material_id=mat.id;textSeg.extra_material_refs=[];textSeg.source_timerange={start:0,duration:durationUs};nested.tracks.find(t=>t.segments.length).type='video';nested.tracks.find(t=>t.segments.length).flag=2;
    }else{
      const mat=nested.materials.texts[0],content=JSON.parse(mat.content);
      content.text=op.text;content.styles[0].range=[0,op.text.length];content.styles[0].fill.content.solid.color=rgb(tint);
      // The harvested face is Latin-only. Arabic copy would otherwise draw as boxes.
      if(/[\u0600-\u06FF]/.test(op.text)){
        const face=path.join(path.dirname(content.styles[0].font.path),'NotoSansArabic-Regular.ttf');
        if(!fs.existsSync(face))fail('MOTION_FONT',`Arabic text needs CapCut's Noto Sans Arabic at ${face}`);
        content.styles[0].font.path=face;mat.font_path=face;mat.font_title='Noto Sans Arabic';
      }
      mat.content=JSON.stringify(content);
    }
    const outer=tpl.tracks.flatMap(t=>t.segments)[0];outer.id=mint('segment');outer.target_timerange={start:atUs,duration:durationUs};outer.source_timerange={start:0,duration:durationUs};outer.common_keyframes=[];outer.desc=prefix+fingerprint;outer.clip.transform={x,y};outer.clip.scale={x:1,y:1};
    const video=tpl.materials.videos[0];video.duration=durationUs;video.width=doc.canvas_config.width;video.height=doc.canvas_config.height;video.material_name=prefix+label;
    draftMat.draft_file_path='';draftMat.draft_cover_path='';draftMat.draft_config_path='';
    for(const [kind,materials] of Object.entries(tpl.materials)) for(const material of materials) add(kind,material);
    const track={id:mint('track'),type:'video',flag:2,attribute:0,name:prefix+label,is_default_name:false,segments:[outer]};
    doc.tracks.push(track);outer.render_index=doc.tracks.length;outer.track_render_index=doc.tracks.length-1;
    return outer;
  }
  function mask(segment,type,config) {
    const m=fresh(p.masks[type]);m.config={...m.config,...config};add('common_mask',m);segment.extra_material_refs.push(m.id);segment.enable_video_mask=true;return m;
  }
  function keys(segment,m,property,points) {
    const template=p.maskKeys.find(k=>k.property_type===`KFTypeCommonMask${property}`);
    if(!template)fail('MOTION_KEY_TEMPLATE',property);
    const k=fresh(template);k.material_id=m.constant_material_id;k.keyframe_list=points.map(([time,value])=>({...copy(template.keyframe_list[0]),id:mint('key'),time_offset:us(time),values:[value],curveType:'Line'}));segment.common_keyframes.push(k);
  }
  function blur(segment,amount=.2) {
    const b=fresh(p.blur);b.adjust_params[0].value=amount;b.bind_segment_id=segment.id;add('video_effects',b);segment.extra_material_refs.push(b.id);
  }
  if(op.recipe==='gradient'){
    layer('base',color);const top=layer('gradient',accent);mask(top,'split',{rotation:0,centerY:-.02,feather:.5});
  }else if(op.recipe==='shimmer'){
    layer('base',color);const top=layer('sweep','FFFFFF');const m=mask(top,'filmstrip',{rotation:25,height:.09,feather:.5,centerX:-.8});
    keys(top,m,'PositionX',[[0,-.8],[duration*.2,-.8],[duration*.65,.8],[duration,.8]]);
  }else if(op.recipe==='orbit-glow'){
    const under=layer('orbit','FFFFFF',scale*1.045);blur(under,.15);const m=mask(under,'split',{rotation:0,feather:.5});keys(under,m,'Rotation',[[0,0],[duration,720]]);layer('core',color);
  }else{
    const top=layer('spotlight',color);blur(top,.02);const m=mask(top,'circle',{width:.12,height:.12*doc.canvas_config.width/doc.canvas_config.height,centerX:-.8,feather:.25});
    keys(top,m,'PositionX',[[0,-.8],[duration*.22,-.35],[duration*.48,.35],[duration*.65,0],[duration,0]]);
    keys(top,m,'PositionY',[[0,0],[duration*.22,.05],[duration*.48,-.04],[duration*.65,0],[duration,0]]);
    keys(top,m,'SizeWidth',[[0,.12],[duration*.65,.12],[duration*.85,2],[duration,2]]);
    keys(top,m,'SizeHeight',[[0,.22],[duration*.65,.22],[duration*.85,3.56],[duration,3.56]]);
  }
  doc.duration=Math.max(doc.duration||0,atUs+durationUs);
  const created=doc.tracks.filter(t=>t.name?.startsWith(prefix));
  const marker=prefix+fingerprint+':'+ownedDigest(doc,created);
  for(const t of created)for(const s of t.segments)s.desc=marker;
  return {name:op.name,recipe:op.recipe,at,duration,native:true,experimental:true,visualVerified:false,easing:'Line',layers:doc.tracks.filter(t=>t.name?.startsWith(prefix)).length};
}
