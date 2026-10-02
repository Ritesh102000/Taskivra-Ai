import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Persistence,SCHEMA_VERSION} from '../../packages/persistence';
import {RecoveryService} from '../../packages/recovery';
import {ProviderRegistry} from '../../packages/model-adapters/registry';
import type {ModelAdapter} from '../../packages/model-adapters/types';
import {DEFAULT_FLEET_LIMITS,DEFAULT_FLEET_TASK_LIMITS} from '../../packages/contracts/fleet';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'aw-fleet-recovery-')),p=new Persistence(join(root,'data'),Date.now());
 const recovery=new RecoveryService({persistence:p,appVersion:'0.9.0',withQuiesced:async work=>work()});
 const db=p.db;
 db.exec("INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES('a','Saved reviewer','','w',1); INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,created_at,updated_at,execution_mode) VALUES('t','a','Saved progress','paused','Report','complete',1,1,'live');");
 db.prepare("INSERT INTO live_task_config(task_id,model,policy_json,limits_json,cost_microusd,reserved_microusd,calls,created_at,updated_at) VALUES('t','gpt-fixture','{}',?,1000,2000,3,1,1)").run(JSON.stringify(DEFAULT_FLEET_TASK_LIMITS));
 const addFleet=(worker='gpt-fixture')=>{
  db.prepare("INSERT INTO fleet_runs(id,project_id,title,objective,source_version_ids,planner_model,worker_model,status,limits_json,task_limits_json,created_at,idempotency_key,request_hash,final_task_id) VALUES('f','personal-workspace','Saved fleet','Review supplied evidence','[]','gpt-fixture',?,'running',?,?,1,'once','fixture','t')").run(worker,JSON.stringify(DEFAULT_FLEET_LIMITS),JSON.stringify(DEFAULT_FLEET_TASK_LIMITS));
  db.exec("INSERT INTO fleet_members VALUES('m','f','a','lead','Lead','Coordinate','gpt-fixture',1); INSERT INTO fleet_tasks(task_id,fleet_id,member_id,kind,preparation) VALUES('t','f','m','lead','ready'); INSERT INTO fleet_plan_revisions VALUES('f',1,'Saved original plan',1,'plan-once','fixture'); UPDATE fleet_runs SET revision=1;");
 };
 return{root,p,db,recovery,addFleet,async close(){p.close();await rm(root,{recursive:true,force:true});}};
}

test('schema 16 upgrade preserves legacy review records and task budgets while adding an empty Fleet feature',async()=>{
 const f=await fixture();try{
  f.db.exec("INSERT INTO security_review_teams VALUES('old','Previous review','Saved scope','personal-workspace','[]',1,'old-key','old-hash'); INSERT INTO security_review_members VALUES('old',0,'code_review','a','t','gpt-fixture','{}','[]','ready',NULL);");
  const before={task:f.db.prepare('SELECT * FROM tasks').all(),budget:f.db.prepare('SELECT * FROM live_task_config').all(),team:f.db.prepare('SELECT * FROM security_review_teams').all(),member:f.db.prepare('SELECT * FROM security_review_members').all()};
  f.db.exec('ALTER TABLE code_executions DROP COLUMN cleanup_state; DROP TABLE repository_snapshot_receipts; DROP TABLE fleet_archives; DROP TABLE agent_archives; DROP TABLE task_archives; DROP TABLE fleet_source_manifests; DROP TABLE fleet_message_links; DROP TABLE fleet_followups');
  for(const table of ['fleet_messages','fleet_plan_revisions','fleet_tasks','fleet_items','fleet_members','fleet_runs'])f.db.exec(`DROP TABLE ${table}`);
  f.db.exec('DELETE FROM schema_migrations WHERE version>=17; PRAGMA user_version=16');f.p.close();
  const upgraded=new Persistence(join(f.root,'data'),Date.now());try{
   const db=upgraded.db;assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,SCHEMA_VERSION);
   assert.deepEqual({task:db.prepare('SELECT * FROM tasks').all(),budget:db.prepare('SELECT * FROM live_task_config').all(),team:db.prepare('SELECT * FROM security_review_teams').all(),member:db.prepare('SELECT * FROM security_review_members').all()},before);
   assert.equal(db.prepare('SELECT count(*) AS n FROM fleet_runs').get()!.n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{upgraded.close();}
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('restored Fleet keeps its plan, limits and uncertain spend but requires explicit owner resume',async()=>{
 const f=await fixture();try{f.addFleet();const backup=await f.recovery.createBackup(join(f.root,'backup'));const restored=await f.recovery.restoreBackup(backup.directory,join(f.root,'restored'));const db=new DatabaseSync(join(restored.dataRoot,'control/agent-workspaces.sqlite'));try{
  const fleet=db.prepare('SELECT * FROM fleet_runs').get()!;assert.equal(fleet.status,'paused');assert.match(String(fleet.problem),/resume.*explicitly/);assert.equal(fleet.revision,1);assert.equal(fleet.limits_json,JSON.stringify(DEFAULT_FLEET_LIMITS));
  const config=db.prepare('SELECT * FROM live_task_config').get()!;assert.equal(config.cost_microusd,1000);assert.equal(config.reserved_microusd,2000);assert.equal(config.calls,3);assert.equal(config.enabled,0);
  assert.equal(db.prepare('SELECT state FROM tasks').get()!.state,'paused');assert.equal(db.prepare('SELECT summary FROM fleet_plan_revisions').get()!.summary,'Saved original plan');assert.equal(db.prepare('SELECT count(*) AS n FROM live_model_calls').get()!.n,0);
 }finally{db.close();}}finally{await f.close();}
});

test('backup requires the pinned future worker model even before specialist roles are created',async()=>{
 const f=await fixture();try{
  const filePath=join(f.p.dataRoot,'control/model-providers.json');const registry=new ProviderRegistry({filePath,legacyAdapter:{status:async()=>({configured:false,provider:'openai',model:'unused',message:null})} as ModelAdapter,credentials:()=>({status:async()=>({configured:false,message:null}),read:async()=>{throw Error('No credential reads');},save:async()=>{throw Error('No credential writes');},remove:async()=>{}})});
  await registry.save({label:'Synthetic future worker',kind:'ollama',baseUrl:'http://localhost:11434',model:'fixture-local',authentication:'none',billing:'local',inputUsdPerMillion:0,outputUsdPerMillion:0,maxInputTokens:8192,maxOutputTokens:512,toolCalling:true});
  const worker=(await registry.state()).profiles[0].selectionId;f.addFleet(worker);const config=await readFile(filePath,'utf8');
  const backup=await f.recovery.createBackup(join(f.root,'complete'));assert.equal(await readFile(join(backup.directory,'control/model-providers.json'),'utf8'),config);
  await rm(filePath);await assert.rejects(f.recovery.createBackup(join(f.root,'missing')),/model connections missing/);
 }finally{await f.close();}
});
