import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Coordinator} from '../../packages/coordinator';
import {DOCUMENT_RUNTIME_PACKAGES} from '../../packages/documents';
import {DEFAULT_LIVE_LIMITS} from '../../packages/contracts/live';
import type {CodeRuntime,CodeHandle} from '../../packages/code/runtime';
import {DEFAULT_MODEL,maxCostMicrousd,usageCostMicrousd,type ModelAdapter,type ModelRequest,type ModelToolCall,type PreparedTurn} from '../../packages/model-adapters';
const hash=(t:string)=>createHash('sha256').update(t).digest('hex');
class Adapter implements ModelAdapter {
 requests:ModelRequest[]=[];pending=new Map<string,ModelRequest>();steps:Array<(r:ModelRequest)=>ModelToolCall>=[];
 async status(){return{configured:true,message:null,provider:'openai',model:DEFAULT_MODEL};}
 prepare(r:ModelRequest){const s=JSON.stringify(r),p={id:randomUUID(),model:DEFAULT_MODEL,requestHash:hash(s),requestBytes:Buffer.byteLength(s),maxOutputTokens:r.maxOutputTokens};this.requests.push(r);this.pending.set(p.id,r);return Object.freeze(p);}
 async quote(p:PreparedTurn){return{inputTokens:100,outputTokens:p.maxOutputTokens,maxCostMicrousd:maxCostMicrousd(DEFAULT_MODEL,100,p.maxOutputTokens)};}
 async complete(p:PreparedTurn){const step=this.steps.shift();assert.ok(step,'Unexpected model call');const usage={inputTokens:100,outputTokens:20,cachedInputTokens:0,totalTokens:120};return{responseId:randomUUID(),text:'',toolCalls:[step(this.pending.get(p.id)!)],usage,costMicrousd:usageCostMicrousd(DEFAULT_MODEL,usage)};}
 discard(p:PreparedTurn){this.pending.delete(p.id);}
}
const runtime:CodeRuntime={
 async status(){return{ready:true,message:null,imageDigest:'sha256:'+'a'.repeat(64),packages:DOCUMENT_RUNTIME_PACKAGES.map(x=>({...x,runtime:'python' as const}))};},async reconcile(){},async close(){},
 async launch(options){const scriptFile=options.files.find(f=>f.path.includes('.aw-execution-'))!;const script=await readFile(scriptFile.sourcePath,'utf8');const match=/\nextract\(json.loads\((.+)\)\)\n$/.exec(script)!;assert.ok(match);const cfg=JSON.parse(JSON.parse(match[1]));const output=JSON.stringify({format:cfg.format,sourceSha256:cfg.sourceSha256,pages:[{page:1,text:'synthetic-extracted '.repeat(1100)}],coverage:{completeDocument:true}});
 const handle:CodeHandle={info:{containerId:'synthetic-owned-container',imageDigest:'sha256:'+'a'.repeat(64)},async run(){return{exitCode:0,reason:'exited',startedAt:1,finishedAt:2,durationMs:1,logsTruncated:false};},async export({destination}){const path=cfg.outputPath.replace('/workspace/',''),sourcePath=join(destination,path);await mkdir(dirname(sourcePath),{recursive:true});await writeFile(sourcePath,output);return[{path,sourcePath,bytes:Buffer.byteLength(output),sha256:hash(output)}];},async stop(){},async close(){}};return handle;}
};
test('verified extraction output is bound and readable in the producing run',async()=>{
const root=await mkdtemp(join(tmpdir(),'r22-binding-'));const adapter=new Adapter(),c=new Coordinator({dataRoot:join(root,'data'),modelAdapter:adapter,codeRuntime:runtime});
let out:any;
try{
 await c.live.ready;await c.code.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});
 const agent=c.handle({type:'agents.create',name:'Synthetic document binding',instructions:''}).agents[0];
 const taskId=c.createLiveTask({type:'live.createTask',agentId:agent.id,objective:'Read synthetic extraction result',completionCriteria:'Inspect exact extraction output',model:DEFAULT_MODEL,policy:{mode:'workspace',allowedOrigins:[]},limits:{...DEFAULT_LIVE_LIMITS,maxModelCalls:3}});
 const pdf=join(root,'synthetic.pdf');await writeFile(pdf,'%PDF- Synthetic fixture; runtime is fake and performs no parsing.');
 const inputId=(await c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:agent.id,taskId},paths:[pdf]})).versionIds[0];
 let outputId='';const call=(name:string,args:any)=>({id:'call_'+randomUUID(),name,arguments:args});
 adapter.steps.push(()=>call('extract_file',{versionId:inputId,optionsJson:'{}'}),request=>{const ctx=JSON.parse((request.input[0] as any).content),result=ctx.savedObservations.find((o:any)=>o.tool==='extract_file').result;outputId=result.outputVersionId;return call('read_file',{versionId:outputId});},()=>call('finish',{outputVersionId:'unreachable',summary:'Synthetic stop after denied read'}));
 await c.live.handle({type:'live.start',taskId});
 for(let i=0;i<1000;i++){if(!(await c.live.state()).busy&&!['running','queued','pausing','recovering'].includes(c.snapshot().tasks.find(t=>t.id===taskId)!.state))break;await new Promise(r=>setTimeout(r,10));}
 const db=new DatabaseSync(c.databasePath);try{const receipts=db.prepare('SELECT tool_name,state,result_json FROM live_tool_receipts ORDER BY created_at,rowid').all();const bindings=db.prepare('SELECT version_id FROM run_artifact_bindings').all();const output=await c.artifacts.readForValidation(agent.id,outputId,true);out={fixtureOnly:true,boundary:'Actual Coordinator, AgentLoop, DocumentService, CodeService, ArtifactService; fake CodeRuntime produces synthetic extraction JSON and scripted model, no parser/Docker/model/network',modelCalls:adapter.requests.length,inputId,outputId,outputExists:!!output.text,outputBytes:output.version.bytes,bindings,receipts,taskState:c.snapshot().tasks.find(t=>t.id===taskId)!.state};const read=receipts.find(x=>x.tool_name==='read_file');assert.equal(read?.state,'succeeded');assert.ok(bindings.some(x=>x.version_id===outputId));}finally{db.close();}
}finally{await c.shutdown();await rm(root,{recursive:true,force:true});}
});
