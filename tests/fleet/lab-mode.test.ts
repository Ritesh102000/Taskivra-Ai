import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Coordinator,type RunClaim} from '../../packages/coordinator';
import {Persistence,SCHEMA_VERSION} from '../../packages/persistence';
import {FleetService,FLEET_LEAD_TOOLS,FLEET_LAB_LEAD_TOOLS,FLEET_LAB_WORKER_TOOLS} from '../../packages/fleet';
import {DEFAULT_FLEET_LIMITS,DEFAULT_FLEET_TASK_LIMITS,FLEET_LAB_URL} from '../../packages/contracts/fleet';
import {DEFAULT_MODEL} from '../../packages/model-adapters/pricing';
import type {CodeRuntime} from '../../packages/code/runtime';

async function fixture(codeRuntime?:CodeRuntime){
 const root=await mkdtemp(join(tmpdir(),'aw-fleet-local-mode-')),c=new Coordinator({dataRoot:join(root,'data'),codeRuntime});await c.live.ready;
 c.handle({type:'settings.update',settings:{driverEnabled:false,maxActiveAgents:2}});
 const p=(c as unknown as {persistence:Persistence}).persistence,db=p.db,closed:string[]=[];
 let ready=false,labStarts=0;
 const importer=c.handle({type:'agents.create',name:'Outside evidence',instructions:''}).agents[0].id;
 const file=join(root,'outside.txt');await writeFile(file,'Unrelated source fixture. This must never enter a black-box website fleet.');
 const privateVersion=(await c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:importer,taskId:null},paths:[file]})).versionIds[0];
 const source=(await c.artifacts.publish({principal:{kind:'owner'},versionId:privateVersion})).versionIds[0];
 const options={persistence:p,artifacts:c.artifacts,
  createTask:(command:Parameters<Coordinator['createLiveTask']>[0],callback:(id:string)=>void)=>c.createLiveTask(command,callback),
  createAgent:(projectId:string,name:string,instructions:string)=>{const id=randomUUID();db.prepare('INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES (?,?,?,?,?)').run(id,name,instructions,randomUUID(),Date.now());db.prepare('INSERT INTO browser_sessions(id,agent_id) VALUES (?,?)').run(randomUUID(),id);c.projects.assignNewAgent(id,projectId);return id;},
  validateModel:(selection:string)=>assert.equal(selection,DEFAULT_MODEL),modelReadiness:async()=>true,
  startTask:async(taskId:string)=>{db.prepare("UPDATE tasks SET state='queued',waiting_reason=NULL WHERE id=?").run(taskId);db.prepare('UPDATE live_task_config SET enabled=1,last_error=NULL WHERE task_id=?').run(taskId);},
  pauseTask:(taskId:string)=>{db.prepare("UPDATE tasks SET state='paused',generation=generation+1 WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')").run(taskId);db.prepare("UPDATE runs SET state='paused' WHERE task_id=? AND state='running'").run(taskId);db.prepare('UPDATE live_task_config SET enabled=0 WHERE task_id=?').run(taskId);},
  stopTask:(taskId:string)=>{db.prepare("UPDATE tasks SET state='cancelled',generation=generation+1 WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')").run(taskId);db.prepare("UPDATE runs SET state='cancelled' WHERE task_id=? AND state='running'").run(taskId);db.prepare('UPDATE live_task_config SET enabled=0 WHERE task_id=?').run(taskId);},
  authorize:(claim:RunClaim)=>c.authorizeRun(claim),
  labStatus:()=>({ready,siteUrl:FLEET_LAB_URL,message:ready?'Synthetic fixture website is ready.':'Website is stopped.'}),
  startLab:async()=>{labStarts++;ready=true;return{ready,siteUrl:FLEET_LAB_URL,message:'Synthetic fixture website is ready.'};},
  closeLabBrowser:async(taskId:string)=>{closed.push(taskId);}
 };
 const service=new FleetService(options);
 // Use this service for the real Coordinator claim/lease gates in these port tests.
 (c as unknown as {fleets:FleetService}).fleets=service;
 const command={type:'fleet.create',mode:'local_website',projectId:'personal-workspace',objective:'Explore the synthetic website as a logged-out visitor and report evidenced behavior.',sourceVersionIds:[] as string[],plannerModel:DEFAULT_MODEL,workerModel:DEFAULT_MODEL,limits:{...DEFAULT_FLEET_LIMITS},taskLimits:{...DEFAULT_FLEET_TASK_LIMITS},idempotencyKey:randomUUID()};
 const invoke=(claim:RunClaim,name:string,args:Record<string,unknown>)=>service.dispatch(claim,name,args,randomUUID(),()=>c.authorizeRun(claim));
 async function start(){await service.handle({type:'fleet.labStart'});const fleet=(await service.handle(command)).fleets[0];await service.handle({type:'fleet.start',fleetId:fleet.id});const lead=c.claimNext(c.instanceId,'live')!;assert.ok(lead);return{fleet,lead};}
 async function plan(lead:RunClaim){await invoke(lead,'fleet_plan',{planJson:JSON.stringify({summary:'Assess discovered public user journeys.',roles:[{key:'journeys',name:'Journey reviewer',goal:'Explore public browser journeys and self-register only if offered.'}],items:[{key:'browse',title:'Explore the user journey',description:'Start logged out, discover pages, and retain observed evidence.',roleKey:'journeys',dependsOnKeys:[]}],cancelItemIds:[],expectedRevision:0,idempotencyKey:randomUUID()})});await service.drain();}
 async function output(claim:RunClaim){const path=join(root,randomUUID()+'.md');await writeFile(path,'# Findings\nObserved training website behavior.\n# Evidence\nSynthetic port fixture only; no website request made in this service test.\n# Impact\nRequires real browser validation.\n# Remediation\nReview the authorization boundary.\n# Coverage\nA service lifecycle test, not a live vulnerability finding.');const version=(await c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:claim.agentId,taskId:claim.taskId},paths:[path]})).versionIds[0];db.prepare("UPDATE task_artifacts SET role='output' WHERE task_id=? AND version_id=?").run(claim.taskId,version);service.assertFinish(claim.taskId,version);db.prepare("UPDATE tasks SET state='succeeded',generation=generation+1 WHERE id=?").run(claim.taskId);db.prepare("UPDATE runs SET state='succeeded' WHERE id=?").run(claim.runId);db.prepare('UPDATE live_task_config SET enabled=0,result_version_id=? WHERE task_id=?').run(version,claim.taskId);return version;}
 return{root,c,p,db,service,options,command,source,privateVersion,importer,closed,start,plan,invoke,output,labStarts:()=>labStarts,async close(){await c.shutdown();await rm(root,{recursive:true,force:true});}};
}

test('local website drafts contain only the fixed URL and never mount sources or start models',async()=>{
 const f=await fixture();try{
  const state=await f.service.handle(f.command),fleet=state.fleets[0];assert.equal(fleet.mode,'local_website');assert.equal(fleet.siteUrl,FLEET_LAB_URL);assert.deepEqual(fleet.sourceVersionIds,[]);assert.deepEqual(fleet.tasks[0].inputVersionIds,[]);assert.equal(fleet.tasks[0].preparation,'ready');assert.equal(fleet.tasks[0].state,'paused');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM live_model_calls').get()!.n,0);assert.equal(f.labStarts(),0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_artifacts').get()!.n,0);
  const task=f.db.prepare('SELECT completion_criteria FROM tasks WHERE id=?').get(fleet.tasks[0].taskId)!;assert.match(String(task.completion_criteria),/observed, reproduced and potential/);assert.doesNotMatch(String(task.completion_criteria),/this was static review/);
  const context=f.service.context(fleet.tasks[0].taskId)!;assert.equal(context.mode,'local_website');assert.equal(context.targetUrl,FLEET_LAB_URL);assert.match(context.constraints,/Start logged out with only this URL/);
  await f.service.handle(f.command);assert.equal(f.service.state().fleets.length,1);
  await assert.rejects(f.service.handle({...f.command,idempotencyKey:randomUUID(),sourceVersionIds:[f.source]}),/URL only/);
  await assert.rejects(f.service.handle({...f.command,idempotencyKey:randomUUID(),mode:'arbitrary_website'}),/imported evidence or the local/);
  assert.throws(()=>f.service.handle({...f.command,siteUrl:'https://outside.example'}),/not supported/);
 }finally{await f.close();}
});

test('local website start requires the trusted app lab port and paid calls remain owner-started',async()=>{
 const f=await fixture();try{
  const fleet=(await f.service.handle(f.command)).fleets[0];await assert.rejects(f.service.handle({type:'fleet.start',fleetId:fleet.id}),/Start the synthetic training website/);assert.equal(fleet.status,'prepared');
  const state=await f.service.handle({type:'fleet.labStart'});assert.equal(state.lab?.ready,true);assert.equal(state.lab?.siteUrl,FLEET_LAB_URL);assert.equal(f.labStarts(),1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM live_model_calls').get()!.n,0);
  const unavailable=new FleetService({...f.options,labStatus:undefined,startLab:undefined});assert.equal(unavailable.state().lab?.ready,false);await assert.rejects(unavailable.handle({type:'fleet.labStart'}),/unavailable/);await unavailable.suspend();
 }finally{await f.close();}
});

test('local tools require a claim and keep browser, terminal and offline inputs in the same fleet',async()=>{
 const f=await fixture();try{
  const {lead}=await f.start();assert.deepEqual(f.service.allowedToolNames(lead.taskId),FLEET_LAB_LEAD_TOOLS);assert.equal(f.service.labOrigin(lead.taskId),'http://127.0.0.1:4318');assert.equal(f.service.isLabAgent(lead.agentId),true);assert.equal(f.service.isLabAgent(f.importer),false);
  for(const name of ['lab_open','lab_observe','lab_action','lab_command','lab_close'])f.service.assertToolAllowed(lead.taskId,name,{});
  f.service.assertToolAllowed(lead.taskId,'browser_open',{url:FLEET_LAB_URL+'catalog'});assert.throws(()=>f.service.assertToolAllowed(lead.taskId,'browser_open',{url:'https://outside.example'}),/fixed local/);assert.throws(()=>f.service.assertToolAllowed(lead.taskId,'browser_open',{url:'http://user:password@127.0.0.1:4318/'}),/fixed local/);
  for(const name of ['browser_action','browser_downloads','browser_upload','gmail_search','publish_output'])assert.throws(()=>f.service.assertToolAllowed(lead.taskId,name,{}),/outside/);
  f.service.assertToolAllowed(lead.taskId,'code_execute',{inputVersionIds:[]});assert.throws(()=>f.service.assertToolAllowed(lead.taskId,'code_execute',{inputVersionIds:[f.source]}),/fleet’s reports only/);assert.throws(()=>f.service.assertToolAllowed(lead.taskId,'read_file',{versionId:f.privateVersion}),/outside/);
  await f.plan(lead);await f.invoke(lead,'fleet_wait',{reason:'Wait for the browser specialist.'});await f.service.drain();const worker=f.c.claimNext(f.c.instanceId,'live')!;assert.ok(worker);assert.deepEqual(f.service.allowedToolNames(worker.taskId),FLEET_LAB_WORKER_TOOLS);
  assert.throws(()=>f.service.assertToolAllowed(worker.taskId,'lab_open',{}),/Claim one/);await f.invoke(worker,'fleet_claim',{itemId:f.service.context(worker.taskId)!.items[0].id});f.service.assertToolAllowed(worker.taskId,'lab_open',{});
 }finally{await f.close();}
});

test('local browsers close on leader wait, completed worker handoff and final synthesis',async()=>{
 const f=await fixture();try{
  const {lead}=await f.start();await f.plan(lead);await f.invoke(lead,'fleet_wait',{reason:'Collect specialist observations.'});await f.service.drain();assert.ok(f.closed.includes(lead.taskId));
  const worker=f.c.claimNext(f.c.instanceId,'live')!;await f.invoke(worker,'fleet_claim',{itemId:f.service.context(worker.taskId)!.items[0].id});await f.output(worker);f.service.tick();await f.service.drain();assert.ok(f.closed.includes(worker.taskId));
  const current=f.service.state().fleets[0],published=current.items[0].publishedVersionId!;assert.equal(current.items[0].state,'completed');assert.deepEqual(f.service.allowedInputVersionIds(lead.taskId),[published]);
  const resumed=f.c.claimNext(f.c.instanceId,'live')!;assert.equal(resumed.taskId,lead.taskId);f.service.assertToolAllowed(resumed.taskId,'code_execute',{inputVersionIds:[published]});const final=await f.output(resumed);const before=f.closed.filter(id=>id===lead.taskId).length;f.service.tick();await f.service.drain();assert.ok(f.closed.filter(id=>id===lead.taskId).length>before);assert.equal(f.service.state().fleets[0].finalVersionId,final);assert.equal(f.service.state().fleets[0].status,'succeeded');
 }finally{await f.close();}
});

test('pause and stop fence local fleet tools and close terminal sessions before reconciliation',async()=>{
 const f=await fixture();try{
  const {fleet,lead}=await f.start();await f.plan(lead);const worker=f.c.claimNext(f.c.instanceId,'live')!;await f.invoke(worker,'fleet_claim',{itemId:f.service.context(worker.taskId)!.items[0].id});await f.output(worker);
  // Pausing can beat reconciliation; completed workers must still release browsers.
  const pausing=f.service.handle({type:'fleet.pause',fleetId:fleet.id});assert.equal(f.service.state().fleets[0].status,'paused');assert.throws(()=>f.service.assertToolAllowed(lead.taskId,'lab_open',{}),/not running/);await pausing;assert.ok(f.closed.includes(lead.taskId));assert.ok(f.closed.includes(worker.taskId));
  await f.service.handle({type:'fleet.stop',fleetId:fleet.id});await assert.rejects(f.service.handle({type:'fleet.start',fleetId:fleet.id}),/finished fleet/);assert.equal(f.db.prepare('SELECT count(*) AS n FROM live_task_config WHERE enabled=1').get()!.n,0);
 }finally{await f.close();}
});

test('imported evidence mode keeps old tool scope and old creation keys replayable',async()=>{
 const f=await fixture();try{
  const command={...f.command,mode:undefined,sourceVersionIds:[f.source]},before=(await f.service.handle(command)).fleets[0];assert.equal(before.mode,'imported_evidence');assert.equal(before.siteUrl,null);assert.deepEqual(f.service.allowedToolNames(before.tasks[0].taskId),FLEET_LEAD_TOOLS);
  await f.service.handle({...command,mode:'imported_evidence'});assert.equal(f.service.state().fleets.length,1);assert.equal(f.service.labOrigin(before.tasks[0].taskId),null);assert.equal(f.service.isLabAgent(before.members[0].agentId),false);
  await f.service.handle({type:'fleet.start',fleetId:before.id});assert.throws(()=>f.service.assertToolAllowed(before.tasks[0].taskId,'lab_open',{}),/outside/);assert.throws(()=>f.service.assertToolAllowed(before.tasks[0].taskId,'code_execute',{inputVersionIds:[]}),/outside/);
 }finally{await f.close();}
});

test('owner and agent code entries cannot mount unrelated evidence attached to a local website task',async()=>{
 let statusCalls=0,launches=0;const runtime:CodeRuntime={async status(){statusCalls++;return{ready:true,message:null,imageDigest:'sha256:synthetic',packages:[]};},async launch(){launches++;throw Error('Unexpected runtime launch.');},async reconcile(){},async close(){}};
 const f=await fixture(runtime);try{
  const draft=(await f.service.handle(f.command)).fleets[0],taskId=draft.tasks[0].taskId;
  const attached=await f.c.artifacts.useInTask({principal:{kind:'owner'},taskId,versionId:f.source});assert.equal(Boolean(attached.deliveryDeferred),false);
  assert.ok(f.c.artifacts.codeInputManifest(taskId).some(input=>input.versionId===f.source));
  const {lead}=await f.start(),input={runtime:'python' as const,source:'print(1)',timeoutSeconds:10,inputVersionIds:[f.source]};
  await assert.rejects(f.c.code.handle({type:'code.execute',taskId,...input}),/fleet’s reports only/);
  await assert.rejects(f.c.code.executeForAgent(lead,input),/fleet’s reports only/);
  assert.equal(statusCalls,0);assert.equal(launches,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM code_executions').get()!.n,0);assert.equal(f.db.prepare('SELECT state FROM runs WHERE id=?').get(lead.runId)!.state,'running');f.c.authorizeRun(lead);
 }finally{await f.close();}
});

test('schema 17 upgrade preserves saved fleets and their limits while defaulting to imported evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-fleet-lab-upgrade-'));let p=new Persistence(join(root,'data'),Date.now());try{
  p.db.prepare("INSERT INTO fleet_runs(id,project_id,title,objective,source_version_ids,planner_model,worker_model,status,limits_json,task_limits_json,created_at,idempotency_key,request_hash) VALUES('old','personal-workspace','Saved static fleet','Saved objective','[]',?,?,'paused',?,?,1,'saved-key','saved-hash')").run(DEFAULT_MODEL,DEFAULT_MODEL,JSON.stringify(DEFAULT_FLEET_LIMITS),JSON.stringify(DEFAULT_FLEET_TASK_LIMITS));
  p.db.exec('ALTER TABLE fleet_runs DROP COLUMN site_url; ALTER TABLE fleet_runs DROP COLUMN mode; DELETE FROM schema_migrations WHERE version=18; PRAGMA user_version=17');const before=p.db.prepare('SELECT * FROM fleet_runs').get()!;p.close();p=new Persistence(join(root,'data'),Date.now());const after=p.db.prepare('SELECT * FROM fleet_runs').get()!,{mode,site_url,...legacy}=after;
  assert.deepEqual(legacy,{...before});assert.equal(mode,'imported_evidence');assert.equal(site_url,null);assert.equal(p.db.prepare('PRAGMA user_version').get()!.user_version,SCHEMA_VERSION);assert.equal(SCHEMA_VERSION,18);assert.deepEqual(p.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>p.db.prepare("UPDATE fleet_runs SET mode='local_website',site_url='https://outside.example' WHERE id='old'").run(),/CHECK/);
 }finally{p.close();await rm(root,{recursive:true,force:true});}
});
