import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator, type RunClaim } from '../../packages/coordinator';
import { parseCollaborationCommand } from '../../packages/collaboration/validation';
import type { CollaborationCommand } from '../../packages/contracts/collaboration';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'aw-phase6-collaboration-')),dataRoot=join(root,'app'),instances:Coordinator[]=[];let now=100_000;
 const create=async()=>{const c=new Coordinator({dataRoot,now:()=>now});instances.push(c);await c.collaboration.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});return c;};
 const c=await create();
 const agent=(name:string)=>{const before=new Set(c.snapshot().agents.map(a=>a.id));return c.handle({type:'agents.create',name,instructions:'PRIVATE-INSTRUCTIONS-'+name}).agents.find(a=>!before.has(a.id))!;};
 const task=(agentId:string,objective='PRIVATE-OBJECTIVE-'+randomUUID())=>{const before=new Set(c.snapshot().tasks.map(t=>t.id));return c.handle({type:'tasks.create',agentId,objective,completionCriteria:'PRIVATE-COMPLETION',scenario:'complete'}).tasks.find(t=>!before.has(t.id))!;};
 const sql=(statement:string,...values:any[])=>{const db=new DatabaseSync(c.databasePath);db.exec('PRAGMA foreign_keys=ON');try{return db.prepare(statement).all(...values) as Record<string,any>[];}finally{db.close();}};
 const command=(cmd:CollaborationCommand)=>c.collaboration.handle(cmd);
 const policy=async(taskId:string,peers:string[],summary='Owner-approved shared summary')=>{const current=c.collaboration.state().policies.find(p=>p.taskId===taskId)!;return command({type:'collaboration.policy',taskId,revision:current.revision,visibility:'shared',summary,peerAgentIds:peers});};
 const input=async(agentId:string,taskId:string,content='fixture',artifactId?:string)=>{const path=join(root,randomUUID()+'.txt');await writeFile(path,content);return(await c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId,taskId},paths:[path],...(artifactId?{artifactId}:{})})).versionIds[0];};
 const publish=async(versionId:string)=>(await c.artifacts.publish({principal:{kind:'owner'},versionId})).versionIds[0];
 const claim=(agentId:string)=>{const claim=c.claimNext(c.instanceId,'simulation',c.snapshot().agents.filter(a=>a.id!==agentId).map(a=>a.id));assert.ok(claim);assert.equal(claim.agentId,agentId);return claim;};
 const close=async()=>{for(const instance of instances){try{await instance.shutdown();}catch{instance.close();await instance.artifacts.drain();}}await rm(root,{recursive:true,force:true});};
 return{root,dataRoot,c,create,agent,task,sql,command,policy,input,publish,claim,close,advance:(ms:number)=>{now+=ms;}};
}
function code(error:any,expected:string){assert.equal(error.code,expected);return true;}

test('A publishes v1, B consumes that exact version, v2 never changes its active read or code pins, and B publishes a derived immutable copy',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id);await f.policy(ta.id,[b.id]);await f.policy(tb.id,[a.id]);
  const privateV1=await f.input(a.id,ta.id,'source one'),sharedV1=await f.publish(privateV1),run=f.claim(b.id);f.c.collaboration.reconcile();
  assert.equal(f.c.collaboration.context(run).publications.filter(p=>p.versionId===sharedV1).length,1);
  const used=await f.c.collaboration.consume(run,{versionId:sharedV1});assert.equal(used.pinned,true);assert.equal(used.alreadyPinned,false);
  const privateV2=await f.input(a.id,ta.id,'source two',f.c.artifacts.getForAgent(a.id,privateV1).artifactId),sharedV2=await f.publish(privateV2);f.c.collaboration.reconcile();
  assert.equal(f.c.collaboration.discover(run).some(v=>v.versionId===sharedV2),true);
  assert.deepEqual(f.sql('SELECT version_id FROM run_artifact_bindings WHERE run_id=?',run.runId).map(r=>r.version_id),[sharedV1]);
  await assert.rejects(f.c.collaboration.consume(run,{versionId:sharedV2}),e=>code(e,'version_pinned'));
  await assert.rejects(f.command({type:'collaboration.consume',taskId:tb.id,versionId:sharedV2}),e=>code(e,'version_pinned'));
  assert.equal(f.c.artifacts.codeInputManifest(tb.id,[sharedV1])[0].versionId,sharedV1);
  assert.equal((await f.c.artifacts.preview({principal:{kind:'agent',agentId:b.id},versionId:sharedV1})).text,'source one');
  const derived=await f.input(b.id,tb.id,'Derived from source one'),sharedDerived=await f.publish(derived);
  assert.notEqual(sharedDerived,sharedV1);assert.equal((await f.c.artifacts.preview({principal:{kind:'owner'},versionId:sharedV1})).text,'source one');
  f.c.handle({type:'tasks.pause',taskId:tb.id});f.c.tick();await f.command({type:'collaboration.consume',taskId:tb.id,versionId:sharedV2});
  f.c.handle({type:'tasks.resume',taskId:tb.id});const next=f.claim(b.id);const pins=f.sql('SELECT version_id FROM run_artifact_bindings WHERE run_id=?',next.runId).map(r=>r.version_id);assert.ok(pins.includes(sharedV2));assert.ok(!pins.includes(sharedV1));
 }finally{await f.close();}
});

test('private task objectives, conversations, inputs, source IDs and private-derived output metadata never enter peer context',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),privateId=await f.input(a.id,ta.id,'PRIVATE-CONTENT');f.c.handle({type:'tasks.message',taskId:ta.id,content:'PRIVATE-CONVERSATION'});
  const run=f.claim(b.id);assert.deepEqual(f.c.collaboration.context(run).board,[]);await assert.rejects(f.c.collaboration.consume(run,{versionId:privateId}),e=>code(e,'permission_denied'));
  assert.throws(()=>f.c.collaboration.send(run,{recipientAgentId:a.id,kind:'update',taskIds:[],versionIds:[privateId],idempotencyKey:'private'}),e=>code(e,'permission_denied'));
  const published=await f.publish(privateId);await f.policy(ta.id,[b.id],'Explicit owner description');const context=JSON.stringify(f.c.collaboration.context(run));
  assert.match(context,/Explicit owner description/);for(const secret of ['PRIVATE-OBJECTIVE','PRIVATE-INSTRUCTIONS','PRIVATE-CONVERSATION','PRIVATE-COMPLETION','PRIVATE-CONTENT',privateId])assert.ok(!context.includes(secret));
  const artifact=f.c.collaboration.discover(run).find(v=>v.versionId===published)!;assert.equal(Object.hasOwn(artifact,'sourceVersionId'),false);assert.equal(Object.hasOwn(artifact,'codeSource'),false);
 }finally{await f.close();}
});

test('agent messages use fixed reference-only bodies, enforce owner peer policy, persist recipient acknowledgments and deduplicate retries',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),runA=f.claim(a.id),runB=f.claim(b.id),input={recipientAgentId:b.id,kind:'handoff' as const,taskIds:[ta.id],versionIds:[],idempotencyKey:'handoff-one'};
  assert.throws(()=>f.c.collaboration.send(runA,input),e=>code(e,'permission_denied'));await f.policy(ta.id,[b.id]);
  assert.throws(()=>f.c.collaboration.send(runA,{...input,body:'LEAK PRIVATE CONTENT'}));const message=f.c.collaboration.send(runA,input);assert.equal(message.body,'Shared references are ready for this handoff.');assert.equal(message.origin,'agent');
  assert.equal(f.c.collaboration.send(runA,input).id,message.id);assert.throws(()=>f.c.collaboration.send(runA,{...input,kind:'question'}),e=>code(e,'idempotency_conflict'));
  assert.throws(()=>f.c.collaboration.ack(runA,[message.id]),e=>code(e,'permission_denied'));f.c.collaboration.ack(runB,[message.id]);const readAt=f.c.collaboration.context(runB).inbox[0].readAt;f.advance(100);f.c.collaboration.ack(runB,[message.id]);assert.equal(f.c.collaboration.context(runB).inbox[0].readAt,readAt);
  assert.equal(f.sql("SELECT COUNT(*) AS n FROM events WHERE type='message.delivered'")[0].n,1);
  await f.c.shutdown();const reopened=await f.create();assert.equal(reopened.collaboration.state().inbox[0].readAt,readAt);
 }finally{await f.close();}
});

test('owner messages are labeled owner and revoked task visibility hides old message and board from future agent context',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id);await f.policy(ta.id,[b.id]);const run=f.claim(b.id);
  await f.command({type:'collaboration.send',taskId:ta.id,recipientAgentId:b.id,kind:'question',taskIds:[],versionIds:[],body:'Owner-selected shareable question',idempotencyKey:'owner'});
  const item=f.c.collaboration.context(run).inbox[0];assert.equal(item.origin,'owner');assert.equal(item.body,'Owner-selected shareable question');
  const policy=f.c.collaboration.state().policies.find(p=>p.taskId===ta.id)!;await f.command({type:'collaboration.policy',taskId:ta.id,revision:policy.revision,visibility:'private',summary:'',peerAgentIds:[]});
  assert.deepEqual(f.c.collaboration.context(run).inbox,[]);assert.deepEqual(f.c.collaboration.context(run).board,[]);
  await assert.rejects(f.command({type:'collaboration.policy',taskId:ta.id,revision:policy.revision,visibility:'shared',summary:'Stale',peerAgentIds:[b.id]}),e=>code(e,'stale_revision'));
 }finally{await f.close();}
});

test('duplicate publication events and cursor replay produce one durable notice per version and recipient',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),version=await f.publish(await f.input(a.id,ta.id));f.c.collaboration.reconcile();
  const event=f.sql("SELECT * FROM events WHERE type='artifact.published'")[0];f.sql('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?) RETURNING id',event.type,event.aggregate_id,event.aggregate_revision,event.payload,event.created_at);
  f.sql("UPDATE event_cursors SET last_event_id=0 WHERE consumer_id='collaboration:publications:v1' RETURNING last_event_id");f.c.collaboration.reconcile();
  assert.equal(f.sql('SELECT * FROM collaboration_publications WHERE version_id=?',version).length,2);const run=f.claim(b.id),notice=f.c.collaboration.context(run).publications.find(p=>p.versionId===version)!;f.c.collaboration.ack(run,[],[notice.id]);
  await f.c.shutdown();const reopened=await f.create();reopened.collaboration.reconcile();assert.equal(reopened.collaboration.state().publications.filter(p=>p.recipientAgentId===b.id&&p.versionId===version).length,1);assert.ok(reopened.collaboration.state().publications.find(p=>p.id===notice.id)!.readAt);
 }finally{await f.close();}
});

test('dependency cycles fail atomically and failure produces an explicit blocker while unrelated agents can claim work',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id);await f.command({type:'collaboration.dependency.add',taskId:tb.id,dependsOnTaskId:ta.id,requiredVersionId:null});
  await assert.rejects(f.command({type:'collaboration.dependency.add',taskId:ta.id,dependsOnTaskId:tb.id,requiredVersionId:null}),e=>code(e,'dependency_cycle'));assert.equal(f.sql('SELECT * FROM task_dependencies').length,1);
  assert.equal(f.c.snapshot().tasks.find(t=>t.id===tb.id)!.state,'waiting');const active=f.claim(a.id);assert.equal(active.taskId,ta.id);
  f.sql("UPDATE tasks SET state='failed',generation=generation+1 WHERE id=? RETURNING id",ta.id);f.sql("UPDATE runs SET state='failed' WHERE id=? RETURNING id",active.runId);f.c.collaboration.reconcile();
  const dependency=f.c.collaboration.state().dependencies[0];assert.equal(dependency.status,'upstream_failed');assert.equal(f.c.snapshot().tasks.find(t=>t.id===tb.id)!.waitingReason,'dependency_failed');assert.equal(f.c.claimNext(),null);
 }finally{await f.close();}
});

test('dependency resolution wakes a waiting task once, preserves paused and cancelled consumers, and still respects input blockers',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),waiting=f.task(b.id),paused=f.task(b.id),cancelled=f.task(b.id);
  for(const t of [waiting,paused,cancelled])await f.command({type:'collaboration.dependency.add',taskId:t.id,dependsOnTaskId:ta.id,requiredVersionId:null});
  f.c.handle({type:'tasks.pause',taskId:paused.id});f.c.handle({type:'tasks.cancel',taskId:cancelled.id});f.sql("UPDATE tasks SET state='succeeded' WHERE id=? RETURNING id",ta.id);f.c.collaboration.reconcile();f.c.collaboration.reconcile();
  assert.equal(f.c.snapshot().tasks.find(t=>t.id===waiting.id)!.state,'queued');assert.equal(f.c.snapshot().tasks.find(t=>t.id===paused.id)!.state,'paused');assert.equal(f.c.snapshot().tasks.find(t=>t.id===cancelled.id)!.state,'cancelled');
  assert.equal(f.sql("SELECT * FROM events WHERE aggregate_id=? AND type='task.state_changed' AND json_extract(payload,'$.state')='queued'",waiting.id).length,1); // Exactly one release; creation has its own event type.
  const blocked=f.task(b.id);f.sql("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?, 'clarification','Need input','Owner question','open','clarify',0) RETURNING id",randomUUID(),blocked.id);
  await f.command({type:'collaboration.dependency.add',taskId:blocked.id,dependsOnTaskId:ta.id,requiredVersionId:null});assert.equal(f.c.snapshot().tasks.find(t=>t.id===blocked.id)!.state,'waiting');assert.equal(f.c.snapshot().tasks.find(t=>t.id===blocked.id)!.waitingReason,'clarification');
 }finally{await f.close();}
});

test('required exact publication must belong to upstream and be intact; missing output blocks claims and removing a final dependency releases work',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),other=f.task(a.id),version=await f.publish(await f.input(a.id,ta.id));
  await assert.rejects(f.command({type:'collaboration.dependency.add',taskId:tb.id,dependsOnTaskId:other.id,requiredVersionId:version}),e=>code(e,'invalid_dependency'));
  await f.command({type:'collaboration.dependency.add',taskId:tb.id,dependsOnTaskId:ta.id,requiredVersionId:version});f.sql("UPDATE tasks SET state='succeeded' WHERE id=? RETURNING id",ta.id);f.sql("UPDATE artifact_versions SET status='missing' WHERE id=? RETURNING id",version);f.c.collaboration.reconcile();
  assert.equal(f.c.collaboration.state().dependencies[0].status,'artifact_unavailable');assert.equal(f.c.snapshot().tasks.find(t=>t.id===tb.id)!.waitingReason,'dependency_artifact');assert.equal(f.c.claimNext(f.c.instanceId,'simulation',[a.id]),null);
  await f.command({type:'collaboration.dependency.remove',taskId:tb.id,dependsOnTaskId:ta.id});assert.equal(f.c.snapshot().tasks.find(t=>t.id===tb.id)!.state,'queued');
 }finally{await f.close();}
});

test('agent dependency wait records callback atomically before releasing its run and rejects hidden upstream tasks',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),run=f.claim(b.id);assert.throws(()=>f.c.collaboration.waitFor(run,{dependsOnTaskId:ta.id}),e=>code(e,'permission_denied'));
  await f.policy(ta.id,[b.id]);assert.throws(()=>f.c.collaboration.waitFor(run,{dependsOnTaskId:ta.id},()=>{throw new Error('checkpoint failed');}),/checkpoint failed/);assert.equal(f.sql('SELECT * FROM task_dependencies').length,0);assert.equal(f.c.snapshot().tasks.find(t=>t.id===tb.id)!.state,'running');
  let callbackRan=false;const result=f.c.collaboration.waitFor(run,{dependsOnTaskId:ta.id},()=>{f.c.authorizeRun(run);callbackRan=true;});assert.ok(callbackRan);assert.ok(result.waiting);assert.equal(f.c.snapshot().tasks.find(t=>t.id===tb.id)!.state,'waiting');assert.throws(()=>f.c.collaboration.discover(run),e=>code(e,'stale_generation'));
  await f.c.shutdown();const reopened=await f.create();assert.equal(reopened.snapshot().tasks.find(t=>t.id===tb.id)!.state,'waiting');
 }finally{await f.close();}
});

test('cancellation and expired lease during asynchronous checksum verification cannot add task or run pins',async()=>{
 for(const cancellation of [true,false]){const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),version=await f.publish(await f.input(a.id,ta.id)),run=f.claim(b.id);
  const original=f.c.artifacts.readForValidation.bind(f.c.artifacts);let entered!:()=>void,release!:()=>void;const seen=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  f.c.artifacts.readForValidation=async(...args)=>{const result=await original(...args);entered();await gate;return result;};
  const consuming=f.c.collaboration.consume(run,{versionId:version});await seen;if(cancellation)f.c.handle({type:'tasks.cancel',taskId:tb.id});else f.advance(15_001);release();
  await assert.rejects(consuming,e=>code(e,cancellation?'stale_generation':'lease_expired'));assert.equal(f.sql('SELECT * FROM task_artifacts WHERE task_id=?',tb.id).length,0);assert.equal(f.sql('SELECT * FROM run_artifact_bindings WHERE run_id=?',run.runId).length,0);assert.equal(f.sql('SELECT * FROM collaboration_consumptions WHERE task_id=?',tb.id).length,0);
 }finally{await f.close();}}
});

test('forged claim, sender, path, cyclic object, accessor, duplicate refs and oversized fields are rejected',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),run=f.claim(a.id);await f.policy(ta.id,[b.id]);
  assert.throws(()=>f.c.collaboration.send({...run,agentId:b.id},{recipientAgentId:b.id,kind:'update',taskIds:[],versionIds:[],idempotencyKey:'x'}),e=>code(e,'stale_generation'));
  const invalid:any[]=[{type:'collaboration.state',path:'/etc/passwd'},{type:'collaboration.ack',agentId:a.id,messageIds:['../x']},{type:'collaboration.policy',taskId:ta.id,revision:1,visibility:'shared',summary:'s'.repeat(241),peerAgentIds:[]},{type:'collaboration.send',taskId:ta.id,body:'',recipientAgentId:b.id,senderAgentId:b.id,kind:'update',taskIds:[],versionIds:[],idempotencyKey:'x'},{type:'collaboration.ack',agentId:a.id,messageIds:['same','same']}];
  const cyclic:any={type:'collaboration.ack',agentId:a.id,messageIds:[]};cyclic.messageIds.push(cyclic);invalid.push(cyclic);const accessor=Object.defineProperty({},'type',{get(){throw new Error('Getter executed');}});invalid.push(accessor);
  for(const value of invalid)assert.throws(()=>parseCollaborationCommand(value),(error:any)=>error.code==='invalid_command');
  assert.equal(f.sql('SELECT * FROM agent_messages').length,0);
 }finally{await f.close();}
});

test('claim exclusions reserve an agent for background cleanup without blocking an independent agent',async()=>{
 const f=await fixture();try{const a=f.agent('A'),b=f.agent('B');f.task(a.id);f.task(b.id);const claim=f.c.claimNext(f.c.instanceId,'simulation',[a.id]);assert.equal(claim?.agentId,b.id);assert.equal(f.c.claimNext(f.c.instanceId,'simulation',[a.id,b.id]),null);}finally{await f.close();}
});

test('already satisfied dependency reports waiting false inside the receipt transaction and leaves its current run authorized',async()=>{
 const f=await fixture();try{const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id);await f.policy(ta.id,[b.id]);f.sql("UPDATE tasks SET state='succeeded' WHERE id=? RETURNING id",ta.id);const run=f.claim(b.id);let recorded:unknown;const result=f.c.collaboration.waitFor(run,{dependsOnTaskId:ta.id},value=>{recorded=value;});assert.equal(result.waiting,false);assert.deepEqual(recorded,result);f.c.authorizeRun(run);assert.equal(f.c.snapshot().tasks.find(t=>t.id===tb.id)!.state,'running');}finally{await f.close();}
});

test('shared consumption rejects a changed file and cannot exceed the task input byte budget',async()=>{
 const f=await fixture();try{
  const a=f.agent('A'),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),version=await f.publish(await f.input(a.id,ta.id,'shared fixture')),held=await f.input(b.id,tb.id,'large metadata fixture'),run=f.claim(b.id);
  f.sql('UPDATE artifact_versions SET bytes=? WHERE id=? RETURNING id',512*1024*1024,held);await assert.rejects(f.c.collaboration.consume(run,{versionId:version}),e=>code(e,'capacity_limit'));assert.equal(f.sql('SELECT * FROM collaboration_consumptions').length,0);
  f.sql('UPDATE artifact_versions SET bytes=? WHERE id=? RETURNING id',22,held);const storage=f.sql('SELECT storage_ref FROM artifact_versions WHERE id=?',version)[0].storage_ref;await chmod(join(f.dataRoot,storage),0o600);await writeFile(join(f.dataRoot,storage),'tampered shared bytes');await assert.rejects(f.c.collaboration.consume(run,{versionId:version}),e=>code(e,'integrity_error'));assert.equal(f.sql('SELECT status FROM artifact_versions WHERE id=?',version)[0].status,'corrupt');assert.equal(f.sql('SELECT * FROM collaboration_consumptions').length,0);
 }finally{await f.close();}
});
test('C72 owner recipient scope precedes500 publication bound while model authority remains separate',async()=>{const f=await fixture();try{const producer=f.agent('Producer'),selected=f.agent('Selected'),other=f.agent('Other'),task=f.task(producer.id);await f.policy(task.id,[selected.id,other.id]);const original=await f.input(producer.id,task.id,'Actual managed source'),published=await f.publish(original);f.c.collaboration.reconcile();const old=f.c.collaboration.state(selected.id).publications.find(item=>item.versionId===published)!;assert.ok(old);const db=new DatabaseSync(f.c.databasePath);try{const source=db.prepare('SELECT * FROM artifact_versions WHERE id=?').get(published)!;for(let i=0;i<501;i++){const id=randomUUID();db.prepare("INSERT INTO artifact_versions(id,artifact_id,version_number,storage_ref,sha256,bytes,mime,format,provenance,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'ready',?)").run(id,source.artifact_id,i+2,'synthetic-not-read-'+id,source.sha256,source.bytes,source.mime,source.format,'{}',200000+i);const event=db.prepare("INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES ('synthetic.fixture',?,1,'{}',?)").run(id,200000+i);db.prepare('INSERT INTO collaboration_publications(id,event_id,recipient_agent_id,version_id,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),event.lastInsertRowid,other.id,id,200000+i);}}finally{db.close();}assert.equal(f.c.collaboration.state().publications.some(item=>item.id===old.id),false);const scoped=await f.command({type:'collaboration.state',agentId:selected.id});assert.equal(scoped.publications.some(item=>item.id===old.id),true);assert.ok(scoped.publications.every(item=>item.recipientAgentId===selected.id));await f.command({type:'collaboration.ack',agentId:selected.id,messageIds:[],publicationIds:[old.id]});assert.ok(f.c.collaboration.state(selected.id).publications.find(item=>item.id===old.id)!.readAt);}finally{await f.close();}});
