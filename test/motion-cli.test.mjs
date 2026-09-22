import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, setOutput } from '../src/cli.mjs';
import { buildProject } from './helpers/polish-project.mjs';
import { loadPreset, loadProject } from '../src/core.mjs';
async function invoke(args) {
 let output=''; const restore=setOutput(v=>{output+=v;return true;});
 try {await main(args); return JSON.parse(output);} finally {restore();}
}
test('motion list is discoverable without a project and reports input support',async()=>{
 const list=await invoke(['motion','list']);
 assert.deepEqual(list.recipes.map(r=>r.name).sort(),['gradient','orbit-glow','shimmer','spotlight']);
 assert.deepEqual(list.recipes.find(r=>r.name==='gradient').inputs,['text']);
 assert.deepEqual(list.recipes.find(r=>r.name==='spotlight').inputs,['text','asset']);
});
test('single command accepts text or asset, defaults stable name, and repeats safely',async()=>{
 const project=buildProject(),temp=path.dirname(project);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'motion-cli-'));
 const preset=structuredClone(loadPreset('motion'));
 for(const m of Object.values(preset.masks)) m.path=dir; preset.blur.path=dir;
 fs.writeFileSync(path.join(dir,'motion.json'),JSON.stringify(preset));
 const old=process.env.CAPCUTCTL_PRESET_DIR;process.env.CAPCUTCTL_PRESET_DIR=dir;
 try{
  const text=['motion','gradient','--project',project,'--text','REUSABLE','--force-running'];
  await invoke(text);
  const docs=loadProject(project).groups.map(g=>g.doc);
  assert.ok(docs[0].tracks.some(t=>t.name==='motion:gradient-0:base'));
  assert.deepEqual(docs[0],docs[1]);
  assert.equal((await invoke(text)).committed,false);
  const asset=path.resolve('assets/suheilai-ring.png');
  // Locate a bundled, real PNG instead of synthesizing a test media response.
  const png=fs.readdirSync('assets').find(f=>f.endsWith('.png'));
  assert.ok(png);
  const args=['motion','spotlight','--project',project,'--asset',path.resolve('assets',png),'--at','6','--force-running'];
  const before=fs.readFileSync(path.join(project,'draft_info.json'),'utf8');
  await invoke([...args,'--dry-run']);
  assert.equal(fs.readFileSync(path.join(project,'draft_info.json'),'utf8'),before);
  await invoke(args);
  const d=loadProject(project).groups[0].doc;
  const nested=d.materials.drafts.map(m=>m.draft);
  assert.ok(nested.some(n=>n.materials.videos.some(v=>v.path.startsWith(project) && fs.existsSync(v.path))));
  assert.equal((await invoke(args)).committed,false);
  await assert.rejects(()=>invoke([...args,'--logo',asset]),/asset.*logo|logo.*asset/);
 }finally{
  if(old===undefined)delete process.env.CAPCUTCTL_PRESET_DIR;else process.env.CAPCUTCTL_PRESET_DIR=old;
  fs.rmSync(temp,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});
 }
});
