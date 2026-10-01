import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerBrowserRuntimeFactory } from '../../packages/browser-runtime/index';

async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'aw-runtime-recovery-'))), owner=createHash('sha256').update(root).digest('hex');
  const run='12345678-1234-4234-8234-123456789abc',name=`awp3-${owner.slice(0,10)}-${run.slice(0,8)}-worker`;
  const directory=join(root,'control/browser-runtime');await mkdir(directory,{recursive:true});
  const path=join(directory,`${run}.json`),statePath=join(root,'fake-docker.json'),dockerPath=join(root,'docker-fixture');
  const resource={kind:'container',name,id:'a'.repeat(64)},labels={'io.agent-workspaces.browser.owner':owner,'io.agent-workspaces.browser.run':run};
  const journal={version:3,owner,run,pid:2147483647,resources:[resource]};
  await writeFile(path,JSON.stringify(journal));
  await writeFile(statePath,JSON.stringify({resources:[{...resource,labels}],calls:[]}));
  // A deterministic CLI fixture exercises actual reconciliation without touching Docker.
  await writeFile(dockerPath,`#!/usr/bin/env node
const fs=require('node:fs'),path=${JSON.stringify(statePath)},state=JSON.parse(fs.readFileSync(path,'utf8')),args=process.argv.slice(2);
state.calls.push(args);const save=()=>fs.writeFileSync(path,JSON.stringify(state));let result='';
if(args[1]==='ls'){let items=state.resources.filter(r=>r.kind===args[0]);for(let n=0;n<args.length;n++)if(args[n]==='--filter'&&args[n+1].startsWith('label=')){const pair=args[n+1].slice(6),split=pair.indexOf('=');items=items.filter(r=>r.labels[pair.slice(0,split)]===pair.slice(split+1));}result=items.map(r=>r.id).join('\\n');}
else if(args[1]==='inspect'){const r=state.resources.find(r=>r.id===args[2]||r.name===args[2]);if(!r){save();process.exit(1);}result=JSON.stringify([{Id:r.id,Name:r.name,Config:{Labels:r.labels},Labels:r.labels}]);}
else if(args[1]==='rm'){const id=args.at(-1);state.resources=state.resources.filter(r=>r.id!==id);result=id;}
else {save();process.exit(2);}save();process.stdout.write(result);
`,{mode:0o700});
  const factory=new DockerBrowserRuntimeFactory({dataRoot:root,profileKey:randomBytes(32),seccompPath:resolve('containers/browser/seccomp.json'),dockerPath});
  return{root,path,statePath,journal,factory,state:async()=>JSON.parse(await readFile(statePath,'utf8')),close:()=>rm(root,{recursive:true,force:true})};
}

test('startup reconciliation resolves journaled creation intent and removes only matching immutable Docker IDs',async()=>{
  const f=await fixture();try{
    f.journal.resources[0].id=null as unknown as string;await writeFile(f.path,JSON.stringify(f.journal));
    await f.factory.reconcile();const state=await f.state();assert.deepEqual(state.resources,[]);
    const removals=state.calls.filter((args:string[])=>args[1]==='rm');assert.equal(removals.length,1);assert.deepEqual(removals[0],['container','rm','-f','a'.repeat(64)]);
    await assert.rejects(readFile(f.path),{code:'ENOENT'});
  }finally{await f.close();}
});

test('foreign labels cannot authorize cleanup even with a journal naming the exact immutable ID',async()=>{
  const f=await fixture();try{
    const state=await f.state();state.resources[0].labels['io.agent-workspaces.browser.owner']='foreign-owner';await writeFile(f.statePath,JSON.stringify(state));
    await assert.rejects(f.factory.reconcile(),/cleanup_incomplete/);
    const after=await f.state();assert.equal(after.resources.length,1);assert.equal(after.calls.some((args:string[])=>args[1]==='rm'),false);assert.ok(await readFile(f.path));
  }finally{await f.close();}
});

test('forged journal owner, resource ID and name are rejected before any Docker mutation',async()=>{
  for(const mutate of [(j:any)=>j.owner='foreign',(j:any)=>j.resources[0].id='--force',(j:any)=>j.resources[0].name='unrelated-project']){
    const f=await fixture();try{mutate(f.journal);await writeFile(f.path,JSON.stringify(f.journal));await assert.rejects(f.factory.reconcile(),/journal_invalid/);assert.deepEqual((await f.state()).calls,[]);}finally{await f.close();}
  }
});

test('reconciliation preserves resources recorded by another currently live process',async()=>{
  const f=await fixture();try{f.journal.pid=process.ppid;await writeFile(f.path,JSON.stringify(f.journal));await f.factory.reconcile();assert.deepEqual((await f.state()).calls,[]);assert.ok(await readFile(f.path));}finally{await f.close();}
});

test('startup removes only generated checkpoint and journal staging owned by dead processes',async()=>{
  const f=await fixture();try{
    const profiles=join(f.root,'control/browser-profiles');await mkdir(profiles,{recursive:true});
    const suffix='12345678-1234-4234-8234-123456789abc';
    const dead=join(profiles,`agent.enc.2147483647.${suffix}.tmp`),live=join(profiles,`agent.enc.${process.pid}.${suffix}.tmp`),unrelated=join(profiles,'owner-note.tmp');
    const journalStage=join(f.root,'control/browser-runtime',`${suffix}.json.2147483647.${suffix}.tmp`);
    for(const path of [dead,live,unrelated,journalStage])await writeFile(path,'ciphertext fixture');
    await f.factory.reconcile();await assert.rejects(readFile(dead),{code:'ENOENT'});await assert.rejects(readFile(journalStage),{code:'ENOENT'});
    assert.equal(await readFile(live,'utf8'),'ciphertext fixture');assert.equal(await readFile(unrelated,'utf8'),'ciphertext fixture');
  }finally{await f.close();}
});
