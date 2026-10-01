import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Coordinator} from '../../packages/coordinator';
import {DEFAULT_LIVE_LIMITS} from '../../packages/contracts/live';
import {DEFAULT_MODEL} from '../../packages/model-adapters/pricing';
import type {ModelAdapter,ModelRequest,PreparedTurn,ModelTurn,ModelToolCall} from '../../packages/model-adapters/types';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
async function until(check:()=>boolean|Promise<boolean>){const end=Date.now()+4000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Concurrent workflow did not reach its expected state.');}
const request=():ModelToolCall=>({id:randomUUID(),name:'user_request',arguments:{requestJson:JSON.stringify({kind:'clarification',title:'Fixture clarification',reason:'Provide the missing fixture detail.',continuation:'after_owner_answer'})}});
class Adapter implements ModelAdapter{
 pending=new Map<string,ModelRequest>();signals=new Map<string,AbortSignal>();entered:string[]=[];
 handler:(objective:string,signal:AbortSignal)=>Promise<ModelToolCall>=async()=>request();
 async status(){return{configured:true,provider:'openai',model:DEFAULT_MODEL,message:null};}
 prepare(r:ModelRequest):PreparedTurn{const text=JSON.stringify(r),p={id:randomUUID(),model:DEFAULT_MODEL,requestHash:createHash('sha256').update(text).digest('hex'),requestBytes:Buffer.byteLength(text),maxOutputTokens:r.maxOutputTokens};this.pending.set(p.id,r);return p;}
 async quote(){return{inputTokens:100,outputTokens:100,maxCostMicrousd:1000};}
 async complete(p:PreparedTurn,{signal}:{signal:AbortSignal}):Promise<ModelTurn>{const ctx=JSON.parse((this.pending.get(p.id)!.input[0] as {content:string}).content),objective=ctx.ownerTask?.objective??ctx.task;this.entered.push(objective);this.signals.set(objective,signal);const call=await this.handler(objective,signal);return{responseId:randomUUID(),text:'',toolCalls:[call],usage:{inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:0},costMicrousd:72};}
 discard(p:PreparedTurn){this.pending.delete(p.id);}
}
async function fixture(now?:()=>number){const dir=await mkdtemp(join(tmpdir(),'aw-phase6-concurrency-')),adapter=new Adapter(),c=new Coordinator({dataRoot:join(dir,'app'),modelAdapter:adapter,now});await c.live.ready;c.handle({type:'settings.update',settings:{driverEnabled:false,maxActiveAgents:2}});return{c,adapter,dir,agent(name:string){const before=new Set(c.snapshot().agents.map(a=>a.id));return c.handle({type:'agents.create',name,instructions:''}).agents.find(a=>!before.has(a.id))!;},async task(agentId:string,objective:string){const before=new Set(c.snapshot().tasks.map(t=>t.id));await c.live.handle({type:'live.createTask',agentId,objective,completionCriteria:'Ask for missing details before doing work.',model:DEFAULT_MODEL,policy:{mode:'workspace',allowedOrigins:[]},limits:DEFAULT_LIVE_LIMITS});return c.snapshot().tasks.find(t=>!before.has(t.id))!;},async close(){await c.shutdown();await rm(dir,{recursive:true,force:true});}};}

test('B makes progress while A has a slow model request; cancelling A never cancels B',async()=>{
 const f=await fixture(),aRelease=deferred(),bRelease=deferred();try{
  const a=f.agent('A'),b=f.agent('B'),ta=await f.task(a.id,'slow-A'),tb=await f.task(b.id,'independent-B');
  f.adapter.handler=async objective=>{await (objective==='slow-A'?aRelease.promise:bRelease.promise);return request();};
  await f.c.live.handle({type:'live.start',taskId:ta.id});await until(()=>f.adapter.entered.includes('slow-A'));
  await f.c.live.handle({type:'live.start',taskId:tb.id});await until(()=>f.adapter.entered.includes('independent-B'));
  assert.equal(f.c.snapshot().tasks.filter(t=>t.state==='running').length,2);
  await f.c.live.handle({type:'live.stop',taskId:ta.id});assert.equal(f.adapter.signals.get('slow-A')!.aborted,true);assert.equal(f.adapter.signals.get('independent-B')!.aborted,false);
  bRelease.resolve();await until(()=>f.c.snapshot().tasks.find(t=>t.id===tb.id)?.state==='waiting');
  assert.equal(f.c.snapshot().tasks.find(t=>t.id===ta.id)?.state,'cancelled');assert.equal(f.c.snapshot().requests.some(r=>r.taskId===ta.id),false);
  aRelease.resolve();await until(async()=>!(await f.c.live.state()).busy);
  assert.equal(f.c.snapshot().requests.filter(r=>r.taskId===tb.id).length,1);
 }finally{aRelease.resolve();bRelease.resolve();await f.close();}
});

test('one executing task per agent; a waiting task frees that agent for the next queued task',async()=>{
 const f=await fixture(),release=deferred();try{
  const a=f.agent('A'),first=await f.task(a.id,'first-A'),second=await f.task(a.id,'second-A');
  f.adapter.handler=async objective=>{if(objective==='first-A')await release.promise;return request();};
  await f.c.live.handle({type:'live.start',taskId:first.id});await until(()=>f.adapter.entered.includes('first-A'));
  await f.c.live.handle({type:'live.start',taskId:second.id});await new Promise(r=>setTimeout(r,40));assert.deepEqual(f.adapter.entered,['first-A']);
  release.resolve();await until(()=>f.adapter.entered.includes('second-A'));await until(async()=>!(await f.c.live.state()).busy);
  assert.equal(f.c.snapshot().tasks.filter(t=>t.state==='waiting').length,2);
 }finally{release.resolve();await f.close();}
});

test('global capacity holds a third agent until a slot is released',async()=>{
 const f=await fixture(),release=deferred();try{
  const tasks=[];for(const n of ['one','two','three'])tasks.push(await f.task(f.agent(n).id,n));
  f.adapter.handler=async objective=>{if(objective!=='three')await release.promise;return request();};
  for(const t of tasks)await f.c.live.handle({type:'live.start',taskId:t.id});
  await until(()=>f.adapter.entered.length===2);assert.equal(f.c.snapshot().tasks.filter(t=>t.state==='running').length,2);assert.equal(f.adapter.entered.includes('three'),false);
  release.resolve();await until(()=>f.adapter.entered.includes('three'));await until(async()=>!(await f.c.live.state()).busy);
  assert.equal(f.c.snapshot().tasks.filter(t=>t.state==='waiting').length,3);
 }finally{release.resolve();await f.close();}
});

const filesRequest=():ModelToolCall=>({id:randomUUID(),name:'user_request',arguments:{requestJson:JSON.stringify({kind:'files',title:'Required input',reason:'A file is required before continuing.',continuation:'required_input',slots:[{key:'source',label:'Source',required:true,constraints:{formats:['txt']}}]})}});
const keepBlocked=():ModelToolCall=>({id:randomUUID(),name:'replan_result',arguments:{resultJson:JSON.stringify({kind:'keep_blocked',message:'The required file is still missing.'})}});
function simulation(c:Coordinator,agentId:string,objective:string){const before=new Set(c.snapshot().tasks.map(t=>t.id));return c.handle({type:'tasks.create',agentId,objective,completionCriteria:'',scenario:'complete'}).tasks.find(t=>!before.has(t.id))!;}
function dbRows(c:Coordinator,sql:string,...values:any[]){const db=new DatabaseSync(c.databasePath);try{return db.prepare(sql).all(...values) as Record<string,any>[];}finally{db.close();}}
async function waitingReplan(f:Awaited<ReturnType<typeof fixture>>,release:ReturnType<typeof deferred>){
 const a=f.agent('Replan agent'),task=await f.task(a.id,'Replan input');let calls=0;f.adapter.handler=async()=>{if(calls++===0)return filesRequest();await release.promise;return keepBlocked();};
 await f.c.live.handle({type:'live.start',taskId:task.id});await until(()=>f.c.snapshot().tasks.find(t=>t.id===task.id)?.state==='waiting');await until(async()=>!(await f.c.live.state()).busy);
 const request=f.c.requests.list(task.id).find(r=>r.kind==='files')!;await f.c.requests.handle({type:'requests.reply',requestId:request.id,revision:request.revision,response:'I cannot provide this file. Please replan.'});return{agent:a,task};
}

test('waiting-task replan admission respects two database-owned simulation runs and resumes after one slot is freed',async()=>{
 const f=await fixture(),release=deferred();try{
  const waiting=await waitingReplan(f,release),a=f.agent('Simulation A'),b=f.agent('Simulation B');const ta=simulation(f.c,a.id,'Sim A');simulation(f.c,b.id,'Sim B');assert.ok(f.c.claimNext());assert.ok(f.c.claimNext());
  f.c.live.tick();await new Promise(r=>setTimeout(r,60));assert.equal(f.adapter.entered.filter(x=>x==='Replan input').length,1,'A replan must not become a third active agent.');assert.equal(dbRows(f.c,"SELECT * FROM request_replan_jobs WHERE state='running'").length,0);
  f.c.handle({type:'tasks.cancel',taskId:ta.id});f.c.live.tick();await until(()=>f.adapter.entered.filter(x=>x==='Replan input').length===2);assert.equal(f.c.snapshot().tasks.find(t=>t.id===waiting.task.id)!.state,'waiting');
 }finally{release.resolve();await f.close();}
});

test('a foreign coordinator counts an active replan toward capacity and cannot execute a second task for its agent',async()=>{
 const f=await fixture(),release=deferred();let other:Coordinator|undefined;try{
  const waiting=await waitingReplan(f,release);f.c.live.tick();await until(()=>f.adapter.entered.filter(x=>x==='Replan input').length===2);
  other=new Coordinator({dataRoot:join(f.dir,'app')});await other.live.ready;const same=simulation(other,waiting.agent.id,'Same-agent background task');assert.equal(other.claimNext(),null,'An agent with an active replan must not receive another run.');
  const a=f.agent('Independent A'),b=f.agent('Independent B');simulation(other,a.id,'Independent A');simulation(other,b.id,'Independent B');const first=other.claimNext(other.instanceId,'simulation',[waiting.agent.id]);assert.ok(first);assert.notEqual(first.taskId,same.id);assert.equal(other.claimNext(other.instanceId,'simulation',[waiting.agent.id]),null,'A replan plus one run fills the two-agent capacity.');
 }finally{release.resolve();await other?.shutdown();await f.close();}
});

test('shutdown aborts active model work, waits for its exit, and never admits queued work afterwards',async()=>{
 const f=await fixture(),release=deferred();let closing:Promise<void>|undefined;try{
  f.c.handle({type:'settings.update',settings:{maxActiveAgents:1}});const a=f.agent('A'),b=f.agent('B'),ta=await f.task(a.id,'Active at shutdown'),tb=await f.task(b.id,'Queued at shutdown');f.adapter.handler=async()=>{await release.promise;return request();};
  await f.c.live.handle({type:'live.start',taskId:ta.id});await until(()=>f.adapter.entered.length===1);await f.c.live.handle({type:'live.start',taskId:tb.id});closing=f.c.shutdown();assert.equal(f.adapter.signals.get('Active at shutdown')!.aborted,true);assert.equal(f.adapter.entered.length,1);release.resolve();await closing;assert.equal(f.adapter.entered.length,1);
 }finally{release.resolve();await closing;await f.close();}
});

test('a recovered worker late model failure cannot pause or cancel the newer coordinator generation',async()=>{
 let now=Date.now();const f=await fixture(()=>now),oldRelease=deferred(),newRelease=deferred();let other:Coordinator|undefined;
 try{
  const agent=f.agent('Recovery agent'),task=await f.task(agent.id,'Recover into new generation');f.adapter.handler=async()=>{await oldRelease.promise;throw new Error('The obsolete model request failed late.');};
  await f.c.live.handle({type:'live.start',taskId:task.id});await until(()=>f.adapter.entered.length===1);const oldRun=dbRows(f.c,"SELECT * FROM runs WHERE task_id=? AND state='running'",task.id)[0];now+=16000;
  const newAdapter=new Adapter();newAdapter.handler=async()=>{await newRelease.promise;return request();};other=new Coordinator({dataRoot:join(f.dir,'app'),modelAdapter:newAdapter,now:()=>now});await other.live.ready;assert.equal(other.snapshot().tasks.find(t=>t.id===task.id)!.state,'paused');await other.live.handle({type:'live.start',taskId:task.id});await until(()=>newAdapter.entered.length===1);
  const current=dbRows(other,"SELECT * FROM runs WHERE task_id=? AND state='running'",task.id)[0];assert.notEqual(current.id,oldRun.id);assert.ok(current.fencing_generation>oldRun.fencing_generation);
  oldRelease.resolve();await until(async()=>!(await f.c.live.state()).busy);assert.equal(other.snapshot().tasks.find(t=>t.id===task.id)!.state,'running','An obsolete worker must not pause the replacement run.');assert.equal(dbRows(other,'SELECT state FROM runs WHERE id=?',current.id)[0].state,'running');assert.equal(newAdapter.signals.get('Recover into new generation')!.aborted,false);
 }finally{oldRelease.resolve();newRelease.resolve();await other?.shutdown();await f.close();}
});

test('replan guards renew only a current lease and cleanup cannot release a newer coordinator attempt',async()=>{
 let now=100_000;const f=await fixture(()=>now),release=deferred();let other:Coordinator|undefined;
 try{
  const waiting=await waitingReplan(f,release),first=f.c.requests.claimReplan({taskIds:[waiting.task.id]});assert.ok(first);f.c.requests.authorizeReplan(first);
  now+=60_000;const renewed=f.c.requests.renewReplan(first);assert.ok(renewed.leaseUntil>first.leaseUntil);f.c.requests.authorizeReplan(first);
  assert.throws(()=>f.c.requests.authorizeReplan({...first,generation:first.generation+1}),(error:any)=>error.code==='stale_replan');assert.equal(f.c.requests.releaseReplan({...first,generation:first.generation+1}),false);assert.equal(f.c.requests.releaseReplan(first),true);
  other=new Coordinator({dataRoot:join(f.dir,'app'),now:()=>now});await other.live.ready;const second=other.requests.claimReplan({taskIds:[waiting.task.id]});assert.ok(second);assert.ok(second.generation>first.generation);assert.equal(f.c.requests.releaseReplan(first),false);other.requests.authorizeReplan(second);
  other.handle({type:'tasks.pause',taskId:waiting.task.id});assert.throws(()=>other!.requests.authorizeReplan(second),(error:any)=>error.code==='stale_replan');assert.equal(other.requests.releaseReplan(second),true);assert.equal(dbRows(other,"SELECT * FROM request_replan_jobs WHERE state='running'").length,0);
  other.handle({type:'tasks.resume',taskId:waiting.task.id});const third=other.requests.claimReplan({taskIds:[waiting.task.id]});assert.ok(third);now=third.leaseUntil+1;assert.throws(()=>other!.requests.renewReplan(third),(error:any)=>error.code==='stale_replan');assert.equal(other.requests.releaseReplan(third),true);
 }finally{release.resolve();await other?.shutdown();await f.close();}
});
