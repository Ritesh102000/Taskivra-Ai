import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Persistence} from '../../packages/persistence';
import {RecoveryService} from '../../packages/recovery';
import {ProviderRegistry} from '../../packages/model-adapters/registry';
import type {ModelAdapter} from '../../packages/model-adapters/types';
const legacy={status:async()=>({configured:false,provider:'openai',model:'unused',message:null})} as ModelAdapter;
const credentials=()=>({status:async()=>({configured:false,message:null}),read:async()=>{throw Error('No key reads');},save:async()=>{throw Error('No key writes');},remove:async()=>{throw Error('No key deletes');}});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'aw-profile-backup-')),persistence=new Persistence(join(root,'data'),Date.now()),filePath=join(persistence.dataRoot,'control/model-providers.json');const registry=new ProviderRegistry({filePath,credentials,legacyAdapter:legacy});const recovery=new RecoveryService({persistence,appVersion:'0.8.0',withQuiesced:async work=>work()});return{root,persistence,filePath,registry,recovery,close:async()=>{persistence.close();await rm(root,{recursive:true,force:true});}};}
const profile={label:'Local review model',kind:'ollama' as const,baseUrl:'http://localhost:11434',model:'fixture-local',authentication:'none' as const,billing:'local' as const,inputUsdPerMillion:0,outputUsdPerMillion:0,maxInputTokens:8192,maxOutputTokens:512,toolCalling:true as const};
test('backup retains immutable nonsecret model revisions, restores a writable registry and does not restore execution',async()=>{
 const f=await fixture();try{await f.registry.save(profile);const first=(await f.registry.state()).profiles[0];await f.registry.save({...profile,label:'Edited review model'},{id:first.id,expectedRevision:1});f.registry.archive(first.id,2);const saved=await readFile(f.filePath,'utf8');
  const backup=await f.recovery.createBackup(join(f.root,'backup'));assert.equal(backup.manifest.files.filter(e=>e.kind==='configuration').length,1);assert.equal(backup.manifest.files.find(e=>e.kind==='configuration')?.path,'control/model-providers.json');
  const restored=await f.recovery.restoreBackup(backup.directory,join(f.root,'restored'));const path=join(restored.dataRoot,'control/model-providers.json');assert.equal(await readFile(path,'utf8'),saved);assert.equal((await stat(path)).mode&0o777,0o600);
  const registry=new ProviderRegistry({filePath:path,credentials,legacyAdapter:legacy});assert.equal(registry.profile(first.selectionId).maxOutputTokens,512);assert.equal(registry.selectable(first.selectionId),false);await registry.save({...profile,label:'Restored new connection'});assert.equal((await registry.state()).profiles.length,2);
 }finally{await f.close();}
});
test('an unexpected secret field in configuration fails backup and leaves an incomplete unusable copy',async()=>{
 const f=await fixture();try{await f.registry.save(profile);const raw=JSON.parse(await readFile(f.filePath,'utf8'));raw.profiles[0].apiKey='synthetic-forbidden-field';await writeFile(f.filePath,JSON.stringify(raw),{mode:0o600});await assert.rejects(f.recovery.createBackup(join(f.root,'backup')),/nonsecret configuration/);await assert.rejects(f.recovery.verifyBackup(join(f.root,'backup')),/did not finish/);await assert.rejects(readFile(join(f.root,'backup/control/model-providers.json')),{code:'ENOENT'});}finally{await f.close();}
});
test('backup refuses omitted configuration needed by a pinned task model',async()=>{
 const f=await fixture();try{await f.registry.save(profile);const id=(await f.registry.state()).profiles[0].selectionId;const db=f.persistence.db;db.exec("INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES('a','Reviewer','','w',1); INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,created_at,updated_at,execution_mode) VALUES('t','a','Review','paused','Report','complete',1,1,'live');");
  db.prepare("INSERT INTO live_task_config(task_id,model,policy_json,limits_json,created_at,updated_at) VALUES('t',?,'{}','{}',1,1)").run(id);await rm(f.filePath);await assert.rejects(f.recovery.createBackup(join(f.root,'backup')),/model connections missing/);
 }finally{await f.close();}
});
