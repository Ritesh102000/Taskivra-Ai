import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Coordinator} from '../../packages/coordinator';
import {DEFAULT_LIVE_LIMITS} from '../../packages/contracts/live';
import type {CodeRuntime,CodeOutcome} from '../../packages/code/runtime';
import {DEFAULT_MODEL,maxCostMicrousd,usageCostMicrousd,type ModelAdapter,type ModelRequest,type PreparedTurn,type ModelTurn} from '../../packages/model-adapters';
const gate=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};};
async function until(predicate:()=>boolean|Promise<boolean>){for(let n=0;n<350;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('The expected bounded lifecycle transition did not occur.');}
class Adapter implements ModelAdapter {
 quoteCalls=0;completeCalls=0;prepareCalls=0;
 async status(){return{configured:true,message:null,provider:'openai',model:DEFAULT_MODEL};}
 prepare(request:ModelRequest):PreparedTurn{this.prepareCalls++;const body=JSON.stringify(request);return{id:randomUUID(),model:DEFAULT_MODEL,requestHash:createHash('sha256').update(body).digest('hex'),requestBytes:Buffer.byteLength(body),maxOutputTokens:request.maxOutputTokens};}
 async quote(p:PreparedTurn){this.quoteCalls++;return{inputTokens:100,outputTokens:p.maxOutputTokens,maxCostMicrousd:maxCostMicrousd(DEFAULT_MODEL,100,p.maxOutputTokens)};}
 async complete():Promise<ModelTurn>{this.completeCalls++;const usage={inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:0};return{responseId:randomUUID(),text:'',toolCalls:[{id:randomUUID(),name:'code_execute',arguments:{runtime:'python',source:'print("synthetic code")',inputVersionIds:[],timeoutSeconds:120}}],usage,costMicrousd:usageCostMicrousd(DEFAULT_MODEL,usage)};}
 discard(){}
}
async function fixture(runtime?:CodeRuntime){const root=await mkdtemp(join(tmpdir(),'aw-phase5-deadline-'));let now=Date.now();const adapter=new Adapter(),c=new Coordinator({dataRoot:join(root,'app'),modelAdapter:adapter,codeRuntime:runtime,now:()=>now});await c.live.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});const agent=c.handle({type:'agents.create',name:'Budget test',instructions:''}).agents[0];await c.live.handle({type:'live.createTask',agentId:agent.id,objective:'Run bounded local work.',completionCriteria:'Only report a verified completed output.',model:DEFAULT_MODEL,policy:{mode:'workspace',allowedOrigins:[]},limits:{...DEFAULT_LIVE_LIMITS,maxActiveSeconds:10}});const taskId=c.snapshot().tasks[0].id;const rows=(sql:string)=>{const db=new DatabaseSync(c.databasePath);try{return db.prepare(sql).all();}finally{db.close();}};return{c,adapter,taskId,rows,advance:(ms:number)=>{now+=ms;},close:async()=>{await c.shutdown();await rm(root,{recursive:true,force:true});}};}

for(const elapsed of [11000,31000])test(`active-time expiry after ${elapsed}ms fences the task and stops real CodeService before a delayed runtime outcome`,{timeout:10000},async()=>{
 const entered=gate<void>(),release=gate<CodeOutcome>();let stops=0,exports=0,workerSignal:AbortSignal|undefined;
 const runtime:CodeRuntime={async status(){return{ready:true,message:null,imageDigest:'sha256:fixture',packages:[]};},async reconcile(){},async close(){},async launch(){return{info:{containerId:'fixture-container',imageDigest:'sha256:fixture'},async run({signal}){workerSignal=signal;entered.resolve();return release.promise;},async export(){exports++;throw Error('An expired execution must never export.');},async stop(){stops++;},async close(){}};}};
 const f=await fixture(runtime);let browserStops=0;const original=f.c.browser.stopForTask.bind(f.c.browser);f.c.browser.stopForTask=async taskId=>{browserStops++;return original(taskId);};
 try{await f.c.live.handle({type:'live.start',taskId:f.taskId});await until(()=>workerSignal!==undefined||f.c.snapshot().tasks[0].state==='paused');assert.ok(workerSignal,(await f.c.live.state()).tasks[0].lastError||'The fake runtime must be entered before the clock advances.');assert.equal(f.c.snapshot().tasks[0].state,'running');const generation=f.c.snapshot().tasks[0].generation;f.advance(elapsed);await until(()=>f.c.snapshot().tasks[0].state==='paused');
  assert.ok(f.c.snapshot().tasks[0].generation>generation);await until(()=>stops>0&&browserStops>0);assert.equal(workerSignal?.aborted,true);assert.equal(exports,0);assert.equal(f.rows('SELECT * FROM code_workspace_revisions').length,0);assert.equal(f.rows('SELECT * FROM run_artifact_bindings').length,0);assert.equal(f.c.snapshot().artifacts.length,0);
  release.resolve({exitCode:0,reason:'exited',startedAt:0,finishedAt:1,durationMs:1,logsTruncated:false});await until(async()=>!(await f.c.live.state()).busy);
  assert.equal(f.c.snapshot().tasks[0].state,'paused');assert.equal(exports,0);assert.equal(f.rows('SELECT * FROM code_workspace_revisions').length,0);assert.equal(f.rows('SELECT * FROM run_artifact_bindings').length,0);assert.equal(f.rows("SELECT * FROM events WHERE type='artifact.published'").length,0);assert.equal((await f.c.live.state()).tasks[0].resultVersionId,null);assert.equal(f.adapter.completeCalls,1);
 }finally{release.resolve({exitCode:0,reason:'exited',startedAt:0,finishedAt:1,durationMs:1,logsTruncated:false});await f.close();}
});

test('full storage rejects the live trace reservation before model preparation, quote or generation',async()=>{
 const f=await fixture();try{const db=new DatabaseSync(f.c.databasePath);try{db.exec('UPDATE artifact_settings SET budget_bytes=1');}finally{db.close();}await f.c.live.handle({type:'live.start',taskId:f.taskId});await until(async()=>!(await f.c.live.state()).busy);assert.equal(f.c.snapshot().tasks[0].state,'paused');assert.equal(f.adapter.prepareCalls,0);assert.equal(f.adapter.quoteCalls,0);assert.equal(f.adapter.completeCalls,0);assert.equal(f.rows('SELECT * FROM live_model_calls').length,0);assert.equal(f.rows('SELECT * FROM live_tool_receipts').length,0);assert.equal(f.c.snapshot().artifacts.length,0);}finally{await f.close();}
});
