import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfiguredModelAdapter,providerSelectionId} from '../../packages/model-adapters';
import {Persistence} from '../../packages/persistence';
import {ReadinessService} from '../../packages/readiness';

for(const scenario of ['credential','http','transport'] as const)test(`generation dispatch evidence distinguishes ${scenario} independently of code`,async()=>{
 const id=randomUUID();let transports=0;
 const adapter=new ConfiguredModelAdapter({profile:{id,revision:1,selectionId:providerSelectionId(id,1),createdAt:Date.now(),label:'Synthetic',kind:'openai-compatible',baseUrl:'https://fixture.invalid/v1',model:'fixture',authentication:'api-key',billing:'metered',inputUsdPerMillion:1,outputUsdPerMillion:2,maxInputTokens:65536,maxOutputTokens:512,toolCalling:true},credentials:{status:async()=>({configured:true,message:null}),read:async()=>{if(scenario==='credential')throw Error('fixture');return 'synthetic-only-key';}},fetch:async()=>{transports++;if(scenario==='http')return new Response('',{status:401});throw Error('fixture');}});
 const prepared=adapter.prepare({instructions:'Synthetic',input:[{role:'user',content:'Synthetic'}],tools:[],maxOutputTokens:64});const signal=new AbortController().signal;await adapter.quote(prepared,{signal});await assert.rejects(adapter.complete(prepared,{signal}));
 assert.equal(transports,scenario==='credential'?0:1);assert.equal(adapter.generationWasNotDispatched(prepared),scenario==='credential');assert.equal(adapter.generationWasNotDispatched({...prepared}),false);
});
for(const method of ['transaction','readTransaction'] as const)test(`${method} rejects thenable and rolls back writes`,()=>{
 const root=mkdtempSync(join(tmpdir(),'transaction-boundary-'));const p=new Persistence(root,Date.now());try{assert.throws(()=>p[method](()=>{p.db.prepare("UPDATE settings SET driver_enabled=0").run();return Promise.resolve('invalid');}),/synchronous/);assert.equal(p.db.prepare('SELECT driver_enabled FROM settings').get()!.driver_enabled,1);}finally{p.close();rmSync(root,{recursive:true,force:true});}
});
test('readiness deadline includes unresolved requirements and does not call downstream ports later',async()=>{
 let release!:(v:any)=>void,modelCalls=0;const pending=new Promise<any>(resolve=>release=resolve);
 const service=new ReadinessService({timeoutMs:10,ports:{resolve:()=>pending,model:()=>{modelCalls++;return{credentialConfigured:true,models:[]};}}});
 await assert.rejects(service.handle({type:'readiness.check',target:{kind:'task',taskId:'synthetic'}}),/in time/);release({outcome:'Late',model:'synthetic',capabilities:[]});await new Promise(resolve=>setImmediate(resolve));assert.equal(modelCalls,0);
});
test('duplicate complete cannot replace a dispatched receipt with unsent evidence',async()=>{
 const id=randomUUID();let release!:(response:Response)=>void;const pending=new Promise<Response>(resolve=>release=resolve);
 const adapter=new ConfiguredModelAdapter({profile:{id,revision:1,selectionId:providerSelectionId(id,1),createdAt:Date.now(),label:'Synthetic',kind:'openai-compatible',baseUrl:'https://fixture.invalid/v1',model:'fixture',authentication:'api-key',billing:'metered',inputUsdPerMillion:1,outputUsdPerMillion:2,maxInputTokens:65536,maxOutputTokens:512,toolCalling:true},credentials:{status:async()=>({configured:true,message:null}),read:async()=>'synthetic-only-key'},fetch:async()=>pending});
 const prepared=adapter.prepare({instructions:'Synthetic',input:[{role:'user',content:'Synthetic'}],tools:[],maxOutputTokens:64}),signal=new AbortController().signal;await adapter.quote(prepared,{signal});const first=adapter.complete(prepared,{signal});await new Promise(resolve=>setImmediate(resolve));assert.equal(adapter.generationWasNotDispatched(prepared),false);await assert.rejects(adapter.complete(prepared,{signal}));assert.equal(adapter.generationWasNotDispatched(prepared),false);release(new Response('',{status:401}));await assert.rejects(first);assert.equal(adapter.generationWasNotDispatched(prepared),false);
});
// Compile-time contract coverage; this function is intentionally never executed.
function staticSynchronousContract(p:Persistence){
 p.transactionSync(()=>42);p.readTransactionSync(()=>42);
 // @ts-expect-error A synchronous callback cannot return an inferred Promise.
 p.transactionSync(async()=>42);
 // @ts-expect-error The read transaction has the same synchronous requirement.
 p.readTransactionSync(async()=>42);
}
