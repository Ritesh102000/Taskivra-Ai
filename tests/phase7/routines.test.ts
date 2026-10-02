import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Coordinator} from '../../packages/coordinator';
import {RoutineService} from '../../packages/routines';
import {nextOccurrence,localParts} from '../../packages/routines/timing';
import {DEFAULT_MODEL} from '../../packages/model-adapters/pricing';
import {DEFAULT_LIVE_LIMITS} from '../../packages/contracts/live';
import type {Persistence} from '../../packages/persistence';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'aw-routines-'));let now=Date.parse('2026-09-30T08:59:00Z');const c=new Coordinator({dataRoot:join(root,'app'),now:()=>now});await c.live.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});const agent=c.handle({type:'agents.create',name:'Monitor',instructions:''}).agents[0];const source=c.workflows.handle({type:'workflows.createTask',workflowId:'competitor-brief',values:{focus:'Read approved sources',websites:'https://example.com'},agentId:agent.id,model:DEFAULT_MODEL,limits:{...DEFAULT_LIVE_LIMITS},idempotencyKey:randomUUID()}).createdTaskId!;
 const file=join(root,'report.md');await writeFile(file,'# Report\nBounded fixture result.');const version=(await c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:agent.id,taskId:source},paths:[file]})).versionIds[0];
 const db=new DatabaseSync(c.databasePath);db.prepare("UPDATE task_artifacts SET role='output' WHERE task_id=? AND version_id=?").run(source,version);db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(source);db.prepare('UPDATE live_task_config SET result_version_id=?,cost_microusd=1000 WHERE task_id=?').run(version,source);
 await c.results.handle({type:'results.accept',taskId:source,versionId:version,revision:0,idempotencyKey:randomUUID()});
 const started:string[]=[];let failCheck=false;const services:RoutineService[]=[];
 const persistence=(c as unknown as {persistence:Persistence}).persistence;
 const makeService=(overrides:Partial<{preflight:(id:string)=>Promise<void>;start:(id:string)=>Promise<unknown>}>={})=>{
  const service=new RoutineService({persistence,artifacts:c.artifacts,now:()=>now,createTask:(command,cb)=>c.createLiveTask(command,cb),preflight:async()=>{if(failCheck)throw Error('private raw secret');},start:async id=>{started.push(id);},...overrides});services.push(service);return service;
 };
 const service=makeService();
 const create=(extra:Record<string,unknown>={})=>service.handle({type:'routines.create',sourceTaskId:source,title:'Daily monitor',limits:{...DEFAULT_LIVE_LIMITS,maxCostUsd:.25},monthlyCapUsd:1,expiresAt:now+90*86400000,timing:{timezone:'UTC',hour:9,minute:0,weekdays:[0,1,2,3,4,5,6]},idempotencyKey:'saved-routine',...extra});
 const tick=async()=>{service.tick();await service.drain();};
 return{c,db,root,source,version,service,makeService,started,create,tick,setTime:(v:string)=>{now=Date.parse(v);},fail:()=>{failCheck=true;},async close(){await Promise.all(services.map(s=>s.suspend()));db.close();await c.shutdown();await rm(root,{recursive:true,force:true});}};
}
test('schedule requires accepted read-only versioned work and caps no greater than reviewed run',async()=>{const f=await fixture();try{const state=f.create();assert.equal(state.routines.length,1);assert.equal(state.routines[0].enabled,true);assert.equal(f.create().routines.length,1);assert.throws(()=>f.create({title:'changed'}),/different schedule/);assert.throws(()=>f.create({idempotencyKey:'larger',limits:{...DEFAULT_LIVE_LIMITS,maxCostUsd:2},monthlyCapUsd:3}),/cannot exceed/);f.db.prepare("DELETE FROM result_reviews").run();assert.throws(()=>f.create({idempotencyKey:'unaccepted'}),/Accept/);}finally{await f.close();}});
test('durable occurrence identity prevents duplicate dispatch and overlapping work',async()=>{const f=await fixture();try{f.create();f.setTime('2026-09-30T09:00:00Z');await f.tick();await f.tick();assert.equal(f.started.length,1);let state=f.service.state();const taskId=state.occurrences[0].taskId!;assert.equal(f.c.snapshot().tasks.find(t=>t.id===taskId)!.state,'paused');assert.equal(f.c.snapshot().taskArtifacts.filter(a=>a.taskId===taskId).length,0);f.setTime('2026-10-01T09:00:00Z');await f.tick();assert.equal(f.started.length,1);state=f.service.state();assert.match(state.occurrences[0].reason!,/overlapping/);assert.equal(state.occurrences.length,2);}finally{await f.close();}});
test('unavailable Mac skips missed work without burst, and setup failure pauses exactly one occurrence',async()=>{const f=await fixture();try{f.create();f.setTime('2026-10-03T15:00:00Z');await f.tick();assert.equal(f.started.length,0);assert.equal(f.service.state().occurrences.length,1);assert.match(f.service.state().occurrences[0].reason!,/Missed/);f.fail();f.setTime('2026-10-04T09:00:00Z');await f.tick();const state=f.service.state();assert.equal(state.routines[0].enabled,false);assert.equal(state.occurrences[0].state,'blocked');assert.doesNotMatch(JSON.stringify(state),/private raw secret/);await f.tick();assert.equal(f.service.state().occurrences.length,2);}finally{await f.close();}});
test('monthly cap counts two failed runs in one month before rejecting a third and resets next month',async()=>{
 const f=await fixture();try{
  f.setTime('2026-09-27T08:59:00Z');f.create({monthlyCapUsd:.5});
  for(const day of [27,28]){
   f.setTime(`2026-09-${day}T09:00:00Z`);await f.tick();
   const id=f.started.at(-1)!;f.db.prepare("UPDATE tasks SET state='failed' WHERE id=?").run(id);
   f.db.prepare('UPDATE live_task_config SET cost_microusd=250000 WHERE task_id=?').run(id);
  }
  assert.equal(f.started.length,2);f.setTime('2026-09-29T09:00:00Z');await f.tick();
  assert.equal(f.started.length,2);assert.match(f.service.state().occurrences[0].reason!,/Monthly estimated-spend cap/);
  f.setTime('2026-09-30T09:00:00Z');await f.tick();assert.equal(f.started.length,2);
  f.setTime('2026-10-01T09:00:00Z');await f.tick();assert.equal(f.started.length,3);
 }finally{await f.close();}
});
test('unknown paid usage on a failed task retains its monthly reservation',async()=>{
 const f=await fixture();try{
  f.setTime('2026-09-27T08:59:00Z');f.create({monthlyCapUsd:.25});f.setTime('2026-09-27T09:00:00Z');await f.tick();
  const id=f.started[0];f.db.prepare("UPDATE tasks SET state='failed' WHERE id=?").run(id);
  f.db.prepare('UPDATE live_task_config SET cost_microusd=0,reserved_microusd=250000 WHERE task_id=?').run(id);
  f.setTime('2026-09-28T09:00:00Z');await f.tick();assert.equal(f.started.length,1);
  assert.match(f.service.state().occurrences[0].reason!,/Monthly estimated-spend cap/);
 }finally{await f.close();}
});
test('two service instances cannot steal an active preparation or dispatch its occurrence twice',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();try{
  f.create();const one=f.makeService({preflight:async()=>{entered.resolve();await release.promise;}}),two=f.makeService();
  f.setTime('2026-09-30T09:00:00Z');one.tick();await entered.promise;two.tick();await two.drain();
  assert.equal(two.state().occurrences.length,1);assert.equal(two.state().occurrences[0].state,'preparing');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM routine_preparation_claims').get()!.n,1);
  assert.equal(f.started.length,0);release.resolve();await one.drain();two.tick();await two.drain();
  assert.equal(f.started.length,1);assert.equal(two.state().occurrences.length,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM routine_preparation_claims').get()!.n,0);
 }finally{release.resolve();await f.close();}
});
for(const stop of ['pause','expiry','suspend','revoke-acceptance'] as const)test(`${stop} during preflight prevents dispatch after the async check returns`,async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();try{
  const routine=f.create({expiresAt:Date.parse('2026-09-30T09:00:01Z')}).routines[0];
  const service=f.makeService({preflight:async()=>{entered.resolve();await release.promise;}});
  f.setTime('2026-09-30T09:00:00Z');service.tick();await entered.promise;
  let suspended:Promise<void>|undefined;
  if(stop==='pause')service.handle({type:'routines.setEnabled',id:routine.id,enabled:false});
  else if(stop==='expiry')f.setTime('2026-09-30T09:00:02Z');else if(stop==='revoke-acceptance')f.db.prepare('DELETE FROM result_reviews WHERE task_id=?').run(f.source);else suspended=service.suspend();
  release.resolve();await service.drain();await suspended;
  assert.equal(f.started.length,0);assert.equal(service.state().occurrences[0].state,'blocked');
  assert.equal(service.state().routines[0].enabled,false);
  const taskId=service.state().occurrences[0].taskId!;
  assert.throws(()=>f.c.handle({type:'tasks.resume',taskId}),/Routines/);
 }finally{release.resolve();await f.close();}
});
test('pausing in the dispatch credential-check window also fences the coordinator resume',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();try{
  const routine=f.create().routines[0];
  const service=f.makeService({start:async id=>{entered.resolve();await release.promise;f.c.handle({type:'tasks.resume',taskId:id});f.started.push(id);}});
  f.setTime('2026-09-30T09:00:00Z');service.tick();await entered.promise;
  assert.equal(service.state().occurrences[0].state,'dispatching');
  service.handle({type:'routines.setEnabled',id:routine.id,enabled:false});release.resolve();await service.drain();
  assert.equal(f.started.length,0);assert.equal(service.state().occurrences[0].state,'blocked');
 }finally{release.resolve();await f.close();}
});
test('pause then re-enable cannot revive the preparation that was already cancelled',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();try{
  const routine=f.create().routines[0],service=f.makeService({preflight:async()=>{entered.resolve();await release.promise;}});
  f.setTime('2026-09-30T09:00:00Z');service.tick();await entered.promise;
  service.handle({type:'routines.setEnabled',id:routine.id,enabled:false});service.handle({type:'routines.setEnabled',id:routine.id,enabled:true});
  release.resolve();await service.drain();assert.equal(f.started.length,0);assert.equal(service.state().occurrences[0].state,'blocked');
 }finally{release.resolve();await f.close();}
});
test('restart blocks a durable interrupted preparation even before a task was created',async()=>{
 const f=await fixture();try{
  const routine=f.create().routines[0];
  f.db.prepare("INSERT INTO routine_occurrences VALUES ('interrupted',?,'2026-09-29',?,NULL,'preparing',NULL,250000,?)").run(routine.id,Date.parse('2026-09-29T09:00Z'),Date.parse('2026-09-29T09:00Z'));
  f.db.prepare("INSERT INTO routine_preparation_claims VALUES ('interrupted','old-owner',?,?)").run(process.pid,Date.parse('2026-09-29T09:01Z'));
  await f.tick();assert.equal(f.started.length,0);const state=f.service.state();
  assert.equal(state.occurrences[0].taskId,null);assert.equal(state.occurrences[0].state,'blocked');assert.equal(state.routines[0].enabled,false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM routine_preparation_claims').get()!.n,0);
  await f.tick();assert.equal(f.service.state().occurrences.length,1);
 }finally{await f.close();}
});
test('revoking acceptance of the source result prevents future routine dispatch',async()=>{
 const f=await fixture();try{
  f.create();f.db.prepare('DELETE FROM result_reviews WHERE task_id=?').run(f.source);
  f.setTime('2026-09-30T09:00:00Z');await f.tick();assert.equal(f.started.length,0);
  assert.match(f.service.state().occurrences[0].reason!,/no longer accepted/);assert.equal(f.service.state().routines[0].enabled,false);
 }finally{await f.close();}
});
test('DST missing hours skip, repeated hours share a durable local-day key, and invalid zones fail',()=>{const base={timezone:'America/New_York',hour:2,minute:30,weekdays:[0,1,2,3,4,5,6]};assert.equal(new Date(nextOccurrence(Date.parse('2026-03-08T06:00:00Z'),base)).toISOString(),'2026-03-09T06:30:00.000Z');const one=nextOccurrence(Date.parse('2026-11-01T04:00:00Z'),{...base,hour:1});const two=nextOccurrence(one,{...base,hour:1});assert.equal(localParts(one,base.timezone).date,localParts(two,base.timezone).date);assert.throws(()=>nextOccurrence(Date.now(),{...base,timezone:'not-a-timezone'}));});
test('C82 independent scheduled child preserves approved replacement criteria instead of restoring original headings',async()=>{const f=await fixture();try{const requestId=randomUUID();f.db.prepare("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?,'files','Reduced scope fixture','Owner accepted replacement','fulfilled',?,?)").run(requestId,f.source,randomUUID(),Date.now());f.db.prepare("INSERT INTO request_details(request_id,kind,spec_json,payload_json) VALUES (?,'reduced_scope','{}',?)").run(requestId,JSON.stringify({completionCriteria:'Required sections: Findings',waiveSlotKeys:[]}));f.db.prepare('UPDATE tasks SET completion_criteria=? WHERE id=?').run('Required sections: Findings',f.source);f.create();f.setTime('2026-09-30T09:00:00Z');await f.tick();const child=f.started[0];assert.ok(child);const requirements=f.c.workflows.requirementsForTask(child)!;assert.deepEqual(requirements.output.sections,[]);assert.equal(requirements.output.format,undefined);assert.equal(f.c.snapshot().tasks.find(task=>task.id===child)!.completionCriteria,'Required sections: Findings');const file=join(f.root,'child-report.md');await writeFile(file,'# Findings\nReduced scope result');const output=(await f.c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:f.c.snapshot().tasks.find(task=>task.id===child)!.agentId,taskId:child},paths:[file]})).versionIds[0];f.db.prepare("UPDATE task_artifacts SET role='output' WHERE task_id=? AND version_id=?").run(child,output);const quality=await f.c.results.checkQuality(child,output);assert.equal(quality.checks.find(check=>check.id==='sections')!.status,'pass');assert.equal(f.db.prepare('SELECT count(*) AS n FROM request_capability_grants WHERE task_id=?').get(child)!.n,0);}finally{await f.close();}});
test('a saved schedule domain blocker pauses only that routine and leaves a later healthy routine dispatchable',async()=>{
 const f=await fixture();try{
  const broken=f.create().routines[0];f.create({idempotencyKey:'healthy-independent',title:'Healthy'});
  f.db.prepare("UPDATE routines SET timing_json=? WHERE id=?").run(JSON.stringify({timezone:'America/New_York',hour:2,minute:30,weekdays:[]}),broken.id);
  f.setTime('2026-09-30T09:00:00Z');await f.tick();
  assert.equal(f.started.length,1);const state=f.service.state();assert.equal(state.routines.find(r=>r.id===broken.id)!.enabled,false);assert.match(state.routines.find(r=>r.id===broken.id)!.lastError!,/schedule needs review/);
  assert.doesNotThrow(()=>f.service.handle({type:'routines.setEnabled',id:broken.id,enabled:false}));
 }finally{await f.close();}
});
test('routine alert paging exposes older unread alerts and exact history without acknowledgement',async()=>{
 const f=await fixture();try{
  const routine=f.create().routines[0];const insert=f.db.prepare('INSERT INTO routine_change_alerts VALUES (?,?,?,?,?,?,?,?,?,?)');
  for(let n=0;n<102;n++)insert.run(`alert_${String(n).padStart(3,'0')}`,routine.id,f.source,f.version,f.source,f.version,String(n),JSON.stringify({added:1,removed:0,addedExamples:[],removedExamples:[],unit:'sections',format:'markdown',baselineHash:'a',resultHash:String(n)}),n,n===0?0:1);
  const first=f.service.handle({type:'routines.state'});assert.equal(first.alerts[0].id,'alert_000');assert.equal(first.unreadAlerts,1);assert.equal(first.alertPage!.hasMore,true);
  const second=f.service.handle({type:'routines.state',beforeAlertId:first.alertPage!.beforeAlertId!});assert.equal(second.alerts.length,2);assert.equal(new Set([...first.alerts,...second.alerts].map(a=>a.id)).size,102);
  const unread=f.service.handle({type:'routines.state',unreadOnly:true});assert.deepEqual(unread.alerts.map(a=>a.id),['alert_000']);
  assert.equal(f.service.handle({type:'routines.state',alertId:'alert_001'}).alerts[0].id,'alert_001');assert.equal(f.service.state().unreadAlerts,1);
 }finally{await f.close();}
});
test('no-baseline candidates cannot monopolize the next bounded comparison batch',async()=>{
 const f=await fixture();try{
  const routine=f.create({alertsEnabled:true}).routines[0];
  const alerts=(f.service as unknown as {alerts:{rows(sql:string,...args:(string|number)[]):Record<string,string|number|null>[];baseline(candidate:Record<string,string|number|null>):Record<string,string|number|null>|undefined;reconcile(check:()=>void):Promise<void>}}).alerts;
  const originalRows=alerts.rows.bind(alerts),originalBaseline=alerts.baseline.bind(alerts);const inspected:string[]=[];
  const candidates=Array.from({length:21},(_,n)=>({routine_id:routine.id,due_at:1,task_id:n===20?f.source:`ineligible_${n}`,agent_id:f.service.state().routines[0].agentId,completed_at:Date.parse('2026-09-30T08:59:00Z'),version_id:f.version}));
  alerts.rows=(sql,...args)=>sql.includes('FROM routine_occurrences o JOIN tasks')?candidates.slice(Number(args.at(-1)||0),Number(args.at(-1)||0)+20):originalRows(sql,...args);
  alerts.baseline=candidate=>{inspected.push(String(candidate.task_id));return candidate.task_id===f.source?originalBaseline(candidate):undefined;};
  await alerts.reconcile(()=>{});assert.equal(inspected.includes(f.source),false);await alerts.reconcile(()=>{});assert.equal(inspected.includes(f.source),true);
  assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM routine_result_comparisons WHERE task_id=?').get(f.source)!.n),1);
 }finally{await f.close();}
});
