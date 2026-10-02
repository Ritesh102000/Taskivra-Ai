import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Coordinator,LEASE_MS} from '../../packages/coordinator/index';
import {DEFAULT_MODEL} from '../../packages/model-adapters/pricing';
import {DEFAULT_FLEET_LIMITS,DEFAULT_FLEET_TASK_LIMITS,FLEET_LAB_URL} from '../../packages/contracts/fleet';
import type {ModelAdapter,ModelRequest,ModelTurn} from '../../packages/model-adapters/types';
test('expired live run with lost task preparation does not block unrelated recovery',async()=>{
const root=mkdtempSync(join(tmpdir(),'r29-recovery-'));let now=1000000,ready=true,entered=false,networkRequests=0;
const adapter:ModelAdapter={
 async status(){return{configured:true,provider:'openai',model:DEFAULT_MODEL,message:null};},
 prepare(request:ModelRequest){const body=JSON.stringify(request);return{id:randomUUID(),model:DEFAULT_MODEL,requestHash:createHash('sha256').update(body).digest('hex'),requestBytes:Buffer.byteLength(body),maxOutputTokens:request.maxOutputTokens};},
 async quote(){return{inputTokens:100,outputTokens:100,maxCostMicrousd:1000};},
 complete(_prepared,{signal}){entered=true;return new Promise<ModelTurn>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('synthetic stopped')),{once:true});});},
 discard(){}
};
const lab={status:()=>({ready,siteUrl:FLEET_LAB_URL,message:ready?'Synthetic ready':'Synthetic dependency unavailable'}),async start(){ready=true;return this.status();},async command(){throw Error('No lab process or transport allowed');}};
const c=new Coordinator({dataRoot:root,now:()=>now,modelAdapter:adapter,localLab:lab});
const db=(c as any).persistence.db;const output:any={scope:'Actual Coordinator, FleetService and AgentLoop; public fleet/task creation and start; fake lab readiness, clock and held model adapter. No SQL state creation, production main, lab process, credentials, network, browser or Docker.'};
try{
 await c.live.ready;c.handle({type:'settings.update',settings:{driverEnabled:false,maxActiveAgents:1}});
 const state=await c.fleets.handle({type:'fleet.create',projectId:'personal-workspace',objective:'Synthetic C01 dependency-loss review',mode:'local_website',sourceVersionIds:[],plannerModel:DEFAULT_MODEL,workerModel:DEFAULT_MODEL,limits:{...DEFAULT_FLEET_LIMITS},taskLimits:{...DEFAULT_FLEET_TASK_LIMITS},idempotencyKey:randomUUID()});
 const fleet=state.fleets[0];await c.fleets.handle({type:'fleet.start',fleetId:fleet.id});
 for(let n=0;n<200&&!entered;n++)await new Promise(r=>setTimeout(r,5));assert.equal(entered,true);
 const row=db.prepare("SELECT * FROM runs WHERE state='running'").get();assert.ok(row);
 const claim={runId:row.id,taskId:row.task_id,agentId:row.agent_id,workerId:row.worker_id,generation:row.fencing_generation,leaseUntil:row.lease_until};
 const agent=c.handle({type:'agents.create',name:'Unrelated synthetic task',instructions:''}).agents.find(a=>a.name==='Unrelated synthetic task')!;
 const unrelated=c.handle({type:'tasks.create',agentId:agent.id,objective:'Unrelated synthetic claim',completionCriteria:'Synthetic only',scenario:'complete'}).tasks.find(t=>t.agentId===agent.id)!;
 now+=LEASE_MS+1;ready=false;const errors:string[]=[];
 const unrelatedClaim=c.claimNext();assert.equal(unrelatedClaim?.taskId,unrelated.id);
 assert.equal(c.claimNext(),null);
 assert.equal(db.prepare('SELECT state FROM runs WHERE id=?').get(row.id).state,'interrupted');
 assert.equal(c.snapshot().tasks.find(t=>t.id===unrelated.id)!.state,'running');
 let staleError='';try{c.authorizeRun(claim);}catch(e){staleError=(e as Error).message;}
 assert.match(staleError,/expired|stale|lease|run/i);
 output.blocked={errors,expiredRunState:'running',unrelatedState:'queued',oldClaimError:staleError,reservedMicrousd:db.prepare('SELECT reserved_microusd FROM live_task_config WHERE task_id=?').get(row.task_id).reserved_microusd};
 ready=true;
 assert.equal(c.recoverExpiredRuns(),0);
 const next=unrelatedClaim;assert.equal(next!.taskId,unrelated.id);
 output.afterDependencyRepair={unrelatedClaimed:next!.taskId===unrelated.id,recoveredRunState:db.prepare('SELECT state FROM runs WHERE id=?').get(row.id).state,reservedMicrousd:db.prepare('SELECT reserved_microusd FROM live_task_config WHERE task_id=?').get(row.task_id).reserved_microusd};
 assert.equal(output.afterDependencyRepair.recoveredRunState,'interrupted');assert.equal(output.afterDependencyRepair.reservedMicrousd,1000);
 output.networkRequests=networkRequests;output.status='reproduced';
}finally{ready=true;await c.shutdown();rmSync(root,{recursive:true,force:true});output.temporaryRootRemoved=true;}
});
