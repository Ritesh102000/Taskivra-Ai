import test from 'node:test';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Coordinator} from '../../packages/coordinator/index';
import {ConfiguredModelAdapter, providerSelectionId} from '../../packages/model-adapters/index';
import {DEFAULT_LIVE_LIMITS} from '../../packages/contracts/live';
test('proven unsent generation releases holds but dispatched repair failure retains them',async()=>{
const root=realpathSync(mkdtempSync(join(tmpdir(),'r05-predispatch-'))),id=randomUUID();let fetches=0,readFails=true;
const profile={id,revision:1,selectionId:providerSelectionId(id,1),createdAt:Date.now(),label:'Synthetic credential failure',kind:'openai-compatible' as const,baseUrl:'https://fixture.invalid/v1',model:'fixture',authentication:'api-key' as const,billing:'metered' as const,inputUsdPerMillion:1,outputUsdPerMillion:2,maxInputTokens:65536,maxOutputTokens:512,toolCalling:true as const};
const adapter=new ConfiguredModelAdapter({profile,credentials:{status:async()=>({configured:true,message:null}),read:async()=>{if(readFails)throw Error('Synthetic credential unavailable after status');return 'synthetic-only-key';}},fetch:async()=>{fetches++;throw Error('No network allowed');}});
const c=new Coordinator({dataRoot:root,modelResolver:()=>adapter,modelCatalog:()=>[{id:profile.selectionId,label:profile.label,provider:profile.kind,local:false,inputUsdPerMillion:1,outputUsdPerMillion:2,maxInputTokens:65536,maxOutputTokens:512}]});
try{
 await c.live.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});
 const a=c.handle({type:'agents.create',name:'Synthetic R05',instructions:''}).agents[0];
 await c.live.handle({type:'live.createTask',agentId:a.id,objective:'Synthetic no-network accounting review',completionCriteria:'No dispatch',model:profile.selectionId,policy:{mode:'workspace',allowedOrigins:[]},limits:{...DEFAULT_LIVE_LIMITS,maxCostUsd:0.1}});
 const task=c.snapshot().tasks[0];await c.live.handle({type:'live.start',taskId:task.id});
 for(let i=0;i<300;i++){const state=await c.live.state();if(!state.busy&&c.snapshot().tasks.find(t=>t.id===task.id)?.state==='paused')break;await new Promise(r=>setTimeout(r,10));}
 const state=(await c.live.state()).tasks.find(t=>t.taskId===task.id)!;
 assert.equal(fetches,0);assert.equal(state.calls,1);assert.equal(state.costUsd,0);assert.equal(state.reservedUsd,0);
 readFails=false;await c.live.handle({type:'live.start',taskId:task.id});
 for(let i=0;i<300;i++){const s=await c.live.state();if(!s.busy&&c.snapshot().tasks.find(t=>t.id===task.id)?.state==='paused')break;await new Promise(r=>setTimeout(r,10));}
 const repaired=(await c.live.state()).tasks.find(t=>t.taskId===task.id)!;assert.equal(fetches,1);assert.ok(repaired.reservedUsd>0);assert.equal(repaired.calls,2);
}finally{await c.shutdown();rmSync(root,{recursive:true,force:true});}

});
