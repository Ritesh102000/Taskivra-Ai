import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import type {Persistence} from '../../packages/persistence';
import {TaskRecoveryService} from '../../packages/task-recovery';
import {TASK_RECOVERY_MIGRATION} from '../../packages/task-recovery/migration';

function fixture(wait?: (ms:number, signal:AbortSignal)=>Promise<void>){
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task'); CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,aggregate_id TEXT,aggregate_revision INTEGER,payload TEXT,created_at INTEGER);");db.exec(TASK_RECOVERY_MIGRATION);
 const persistence={db,transaction<T>(work:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}} as Persistence;
 let now=1000;const delays:number[]=[];
 const service=new TaskRecoveryService({persistence,now:()=>now,wait:wait||(async ms=>{delays.push(ms);now+=ms;})});
 const options={taskId:'task',runId:'run',operation:'browser_read' as const,check:()=>{}};
 return{db,persistence,service,delays,options,async close(){await service.suspend();db.close();}};
}
const transient=()=>Object.assign(new Error('private page text must not be persisted'),{code:'observation_unavailable'});
test('transient observations recover with persisted bounded backoff and no raw page error',async()=>{
 const f=fixture();try{let calls=0;const value=await f.service.runRead({...f.options,read:async()=>{if(++calls<3)throw transient();return 'fresh';}});
  assert.equal(value,'fresh');assert.equal(calls,3);assert.deepEqual(f.delays,[300,1200]);const state=f.service.state();assert.equal(state.incidents[0].state,'recovered');assert.equal(state.incidents[0].attempts,2);assert.equal(state.needsAttention,0);assert.doesNotMatch(JSON.stringify(state),/private page text/);
 }finally{await f.close();}
});
test('task retry budget survives a new service and cannot be reset by acknowledgement',async()=>{
 const f=fixture();try{let calls=0;const read=async()=>{calls++;throw transient();};
  await assert.rejects(f.service.runRead({...f.options,read}));await assert.rejects(f.service.runRead({...f.options,runId:'run2',read}));assert.equal(calls,6);
  for(const incident of f.service.state().incidents)f.service.handle({type:'taskRecovery.acknowledge',id:incident.id});
  const second=new TaskRecoveryService({persistence:f.persistence,wait:async()=>{throw Error('No wait should be scheduled.');}});
  await assert.rejects(second.runRead({...f.options,runId:'run3',read}));assert.equal(calls,7);assert.equal(second.state().incidents.reduce((n,i)=>n+i.attempts,0),4);assert.equal(second.state().needsAttention,1);await second.suspend();
 }finally{await f.close();}
});
test('login, model, rate limits, permissions and unknown action errors do not retry',async()=>{
 const f=fixture();try{for(const code of ['login_required','model_http','rate_limit','permission_denied','browser_action_unknown','arbitrary_page_instruction']){let calls=0;await assert.rejects(f.service.runRead({...f.options,read:async()=>{calls++;throw Object.assign(Error('secret'),{code});}}));assert.equal(calls,1);}assert.equal(f.service.state().incidents.length,0);
 }finally{await f.close();}
});
test('pausing during backoff cancels immediately and never sends the reserved retry',async()=>{
 let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});
 const f=fixture(async(_ms,signal)=>{entered();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true});});});
 try{let calls=0;const work=f.service.runRead({...f.options,read:async()=>{calls++;throw transient();}});const failed=assert.rejects(work);await waiting;await f.service.suspend();await failed;assert.equal(calls,1);assert.equal(f.service.state().incidents[0].state,'cancelled');assert.equal(f.service.state().incidents[0].attempts,1);
 }finally{await f.close();}
});
test('task authority is rechecked after backoff and after a returned observation',async()=>{
 let allowed=true;const f=fixture(async()=>{allowed=false;});try{let calls=0;await assert.rejects(f.service.runRead({...f.options,check:()=>{if(!allowed)throw Error('Task paused.');},read:async()=>{calls++;throw transient();}}),/Task paused/);assert.equal(calls,1);assert.equal(f.service.state().incidents[0].state,'cancelled');
  allowed=true;await assert.rejects(f.service.runRead({...f.options,check:()=>{if(!allowed)throw Error('Task paused.');},read:async()=>{allowed=false;return 'stale';}}),/Task paused/);
 }finally{await f.close();}
});
test('dead process attempts become interrupted and retain their spent retry authority',async()=>{
 const f=fixture();try{f.db.prepare("INSERT INTO task_recovery_incidents VALUES ('prior','task','run','browser_read','browser_worker_exited','retrying',2,NULL,1,1,2147483647,0)").run();
  const after=new TaskRecoveryService({persistence:f.persistence,wait:async()=>{}});assert.equal(after.state().incidents[0].state,'interrupted');assert.equal(after.state().incidents[0].attempts,2);assert.equal(after.state().needsAttention,1);await after.suspend();
 }finally{await f.close();}
});
