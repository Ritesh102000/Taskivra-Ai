import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {Coordinator} from '../../packages/coordinator';
import {DEFAULT_MODEL} from '../../packages/model-adapters';
import {DEFAULT_LIVE_LIMITS} from '../../packages/contracts/live';
test('five accepted long clarification replies continue without duplicating reply bodies',async()=>{
const root=await mkdtemp(join(tmpdir(),'r06-context-loop-'));let calls=0,quoted=0;
const adapter={
 async status(){return{configured:true,message:null,provider:'openai',model:DEFAULT_MODEL};},
 prepare(request:any){const body=JSON.stringify(request);return{id:randomUUID(),model:DEFAULT_MODEL,requestHash:createHash('sha256').update(body).digest('hex'),requestBytes:Buffer.byteLength(body),maxOutputTokens:request.maxOutputTokens};},
 async quote(p:any){quoted++;return{inputTokens:100,outputTokens:p.maxOutputTokens,maxCostMicrousd:1};},
 async complete(){calls++;return{responseId:randomUUID(),text:'',toolCalls:[{id:randomUUID(),name:'user_request',arguments:{requestJson:JSON.stringify({kind:'clarification',title:'Clarify '+calls,reason:'Please provide the detailed owner constraints.',continuation:'clarify-'+calls})}}],usage:{inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:0},costMicrousd:1};},
 discard(){}
};
const c=new Coordinator({dataRoot:join(root,'app'),modelAdapter:adapter});
async function settled(id:string){for(let n=0;n<400;n++){const task=c.snapshot().tasks.find(t=>t.id===id)!;if(!c.live.hasInFlightWork&&!['running','queued','recovering','pausing'].includes(task.state))return task;await new Promise(r=>setTimeout(r,5));}throw Error('did not settle');}
try{
 await c.live.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});
 const agent=c.handle({type:'agents.create',name:'Synthetic reviewer',instructions:''}).agents[0];
 await c.live.handle({type:'live.createTask',agentId:agent.id,objective:'Follow the saved owner constraints and produce a report.',completionCriteria:'A report.',model:DEFAULT_MODEL,policy:{mode:'workspace',allowedOrigins:['https://example.com']},limits:DEFAULT_LIVE_LIMITS});
 const task=c.snapshot().tasks[0];await c.live.handle({type:'live.start',taskId:task.id});
 const steps=[];
 for(let n=1;n<=5;n++){
  const state=await settled(task.id);steps.push({n,state:state.state,calls});
  if(state.state!=='waiting')break;
  const req=c.requests.list(task.id).find(r=>r.state==='open')!;
  await c.requests.handle({type:'requests.reply',requestId:req.id,revision:req.revision,response:String(n).repeat(8000)});c.live.tick();
 }
 const state=await settled(task.id);const live=(await c.live.state()).tasks.find(t=>t.taskId===task.id);
 assert.equal(calls,6);assert.equal(quoted,6);assert.equal(live?.lastError,null);assert.equal(state.state,'waiting');
}finally{await c.shutdown();await rm(root,{recursive:true,force:true});}

});
