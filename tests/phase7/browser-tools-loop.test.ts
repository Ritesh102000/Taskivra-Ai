import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Coordinator} from '../../packages/coordinator';
import type {BrowserHandle,BrowserRuntime} from '../../packages/browser/runtime';
import type {GmailService} from '../../packages/gmail';
import {DEFAULT_LIVE_LIMITS,type LivePolicy} from '../../packages/contracts/live';
import {DEFAULT_MODEL,maxCostMicrousd,usageCostMicrousd,type ModelAdapter,type ModelRequest,type ModelToolCall} from '../../packages/model-adapters';

const origin='https://fixture.example.test';
const step=(name:string,args:Record<string,unknown>={}):ModelToolCall=>({id:randomUUID(),name,arguments:args});
const wait=()=>step('user_request',{requestJson:JSON.stringify({kind:'clarification',title:'Fixture complete',reason:'Owner review required.',continuation:'fixture-review'})});
type Decide=(context:any,turn:number,request:ModelRequest)=>ModelToolCall|Promise<ModelToolCall>;
class Runtime implements BrowserRuntime {
 tabs=[{id:'tab0',url:origin+'/one',title:'One',revision:1}];selected='tab0';methods:string[]=[];observed:string[]=[];bytes=new Map([['download1',Buffer.from('name,value\nfixture,7\n')]]);
 constructor(readonly native=false){}
 async status(){return{ready:true,message:null,backend:this.native?'desktop_chrome' as const:'docker' as const,supportsTransfers:!this.native};}
 async reconcile(){}async close(){}
 async launch({initialGeneration}:Parameters<BrowserRuntime['launch']>[0]):Promise<BrowserHandle>{
  const view=()=>{const tab=this.tabs.find(t=>t.id===this.selected)!;tab.revision++;return{tabs:structuredClone(this.tabs),selectedTabId:tab.id,tab:tab.id,url:tab.url,title:tab.title,revision:tab.revision,text:'Observed '+tab.title,targets:[],frame:null};};
  return{request:async(method,params)=>{this.methods.push(method);let result:unknown;
   if(method==='tabs.list')result=structuredClone(this.tabs);
   else if(method==='download.list')result=[...this.bytes].map(([id,bytes])=>({id,name:'fixture.csv',bytes:bytes.length,completed:true,status:'ready',sha256:createHash('sha256').update(bytes).digest('hex'),tabId:this.selected,origin}));
   else if(method==='download.read'){const bytes=this.bytes.get(String(params.id))!;result={offset:params.offset,base64:bytes.subarray(Number(params.offset),Number(params.offset)+Number(params.length)).toString('base64')};}
   else if(method==='download.ack'){this.bytes.delete(String(params.id));result={ok:true};}
   else{
    if(method==='tabs.open'){const tab={id:'tab'+this.tabs.length,url:String(params.url),title:'Two',revision:1};this.tabs.push(tab);this.selected=tab.id;}
    else if(method==='tabs.close'){this.tabs=this.tabs.filter(t=>t.id!==params.tab);this.selected=this.tabs[0].id;}
    else if(method==='page.observe'){if(params.tab)this.selected=String(params.tab);this.observed.push(this.selected);}
    else if(method!=='page.peek')throw Error('Unexpected runtime method '+method);
    result=view();
   }return{generation:initialGeneration,controller:'agent',result};},close:async()=>({saved:true}),stop:async()=>{}};
 }
}
async function fixture(decide:Decide,policy:LivePolicy={mode:'workspace',allowedOrigins:[origin]},runtime=new Runtime(),gmail?:GmailService){
 const root=await mkdtemp(join(tmpdir(),'aw-tab-tools-'));let turns=0;const requests=new Map<string,ModelRequest>();
 const model:ModelAdapter={async status(){return{configured:true,message:null,provider:'fixture',model:DEFAULT_MODEL};},prepare(request){const id=randomUUID(),encoded=JSON.stringify(request);requests.set(id,request);return{id,model:DEFAULT_MODEL,requestHash:createHash('sha256').update(encoded).digest('hex'),requestBytes:Buffer.byteLength(encoded),maxOutputTokens:request.maxOutputTokens};},async quote(p){return{inputTokens:100,outputTokens:p.maxOutputTokens,maxCostMicrousd:maxCostMicrousd(DEFAULT_MODEL,100,p.maxOutputTokens)};},async complete(p){const r=requests.get(p.id)!,context=JSON.parse((r.input[0] as {content:string}).content);const call=await decide(context,++turns,r);const usage={inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:0};return{responseId:randomUUID(),text:'',toolCalls:[call],usage,costMicrousd:usageCostMicrousd(DEFAULT_MODEL,usage)};},discard(p){requests.delete(p.id);}};
 const c=new Coordinator({dataRoot:join(root,'app'),modelAdapter:model,browserRuntime:runtime,gmail});await c.live.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});
 const agent=c.handle({type:'agents.create',name:'Tab tool fixture',instructions:''}).agents[0],taskId=c.createLiveTask({type:'live.createTask',agentId:agent.id,objective:'Read bounded approved sources and save their useful content.',completionCriteria:'Exact source receipt and private report.',model:DEFAULT_MODEL,limits:DEFAULT_LIVE_LIMITS,policy});
 return{c,agent,taskId,runtime,get turns(){return turns;},async start(){await c.live.handle({type:'live.start',taskId});for(let i=0;i<600;i++){if(!(await c.live.state()).busy)return;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture did not settle.');},receipts(){const db=new DatabaseSync(c.databasePath);try{return db.prepare('SELECT tool_name,state,result_json FROM live_tool_receipts WHERE task_id=? ORDER BY rowid').all(taskId).map(r=>({tool_name:String(r.tool_name),state:String(r.state),result:JSON.parse(String(r.result_json))}));}finally{db.close();}},async close(){await c.shutdown();await rm(root,{recursive:true,force:true});}};
}
const latest=(context:any,tool:string)=>context.savedObservations.findLast((r:any)=>r.tool===tool).result;
test('model lists, opens, observes an exact tab, closes it and grounds a report in its saved observation',async()=>{
 const f=await fixture((context,turn)=>{
  if(turn===1)return step('browser_tabs');
  if(turn===2){assert.deepEqual(latest(context,'browser_tabs').tabs.map((t:any)=>t.tabId),['tab0']);return step('browser_tab_open',{url:origin+'/two'});}
  if(turn===3){assert.equal(latest(context,'browser_tab_open').tabId,'tab1');return step('browser_tab_observe',{tabId:'tab0'});}
  if(turn===4){assert.equal(latest(context,'browser_tab_observe').text,'Observed One');return step('browser_tab_close',{tabId:'tab1'});}
  if(turn===5){assert.equal(latest(context,'browser_tab_close').tabs.length,1);return step('save_report',{name:'tabs.md',content:'The bounded first-tab observation says Observed One.',evidenceIds:[context.evidence.find((r:any)=>r.tool==='browser_tab_observe').evidenceId]});}
  if(turn===6)return step('finish',{outputVersionId:context.producedOutputs[0].outputVersionId,summary:'Read the exact tab and saved its report.'});throw Error('Unexpected turn');
 });try{await f.start();assert.equal(f.c.snapshot().tasks[0].state,'succeeded');assert.equal(f.turns,6);assert.deepEqual(f.runtime.methods.filter(m=>m.startsWith('tabs.')),['tabs.list','tabs.open','tabs.close']);assert.ok(f.runtime.observed.includes('tab0'));}finally{await f.close();}
});
test('foreign tab handles fail before runtime observation and login metadata cannot ground a report',async()=>{
 const runtime=new Runtime();runtime.tabs.push({id:'login',url:origin+'/login?token=CANARY',title:'CANARY',revision:1});
 const f=await fixture((context,turn)=>{if(turn===1)return step('browser_tab_observe',{tabId:'foreign'});if(turn===2)return step('browser_tab_observe',{tabId:'login'});if(turn===3){assert.equal(latest(context,'browser_tab_observe').loginOrRedirect,true);assert.equal(JSON.stringify(context).includes('CANARY'),false);return step('save_report',{name:'invalid.md',content:'Not verified',evidenceIds:[context.evidence.find((r:any)=>r.tool==='browser_tab_observe').evidenceId]});}return wait();},undefined,runtime);
 try{await f.start();assert.equal(f.c.snapshot().tasks[0].state,'waiting');assert.ok(!runtime.observed.includes('foreign'));assert.ok(!runtime.observed.includes('login'));assert.equal(f.receipts()[0].result.code,'permission_denied');assert.equal(f.receipts()[2].result.code,'missing_evidence');}finally{await f.close();}
});
test('managed download is saved privately, pinned into this run, and read before report evidence',async()=>{
 const f=await fixture((context,turn)=>{if(turn===1)return step('browser_tabs');if(turn===2)return step('browser_downloads');if(turn===3){assert.equal(latest(context,'browser_downloads').downloads[0].id,'download1');return step('browser_save_download',{downloadId:'download1'});}if(turn===4){const result=latest(context,'browser_save_download');assert.equal(result.readyForTask,true);assert.ok(context.inputs.some((v:any)=>v.versionId===result.versionId));return step('read_file',{versionId:result.versionId});}if(turn===5){assert.equal(latest(context,'read_file').text,'name,value\nfixture,7\n');return step('save_report',{name:'download.md',content:'The saved private CSV fixture value is 7.',evidenceIds:[context.evidence.find((r:any)=>r.tool==='read_file').evidenceId]});}return step('finish',{outputVersionId:context.producedOutputs[0].outputVersionId,summary:'Read the saved download.'});});
 try{await f.start();assert.equal(f.c.snapshot().tasks[0].state,'succeeded');assert.equal(f.turns,6);assert.equal(f.runtime.bytes.size,0);assert.equal(f.c.results.state().results.length,1);}finally{await f.close();}
});
test('native transfer unsupported is explicit; read-only policy rejects forged download calls before runtime',async()=>{
 for(const native of [false,true]){const f=await fixture((_c,turn)=>turn===1?step('browser_tabs'):turn===2?step('browser_downloads'):wait(),{mode:native?'workspace':'read_only_browser',allowedOrigins:[origin]},new Runtime(native));try{await f.start();const receipt=f.receipts()[1];assert.equal(receipt.state,'failed');assert.match(JSON.stringify(receipt.result),native?/managed.*container|native|Chrome/i:/not allowed/i);assert.equal(f.runtime.methods.filter(m=>m==='download.read').length,0);assert.equal(f.turns,native?2:3);}finally{await f.close();}}
});
test('project brief edit during model thinking discards its obsolete tab action before runtime dispatch',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>;f=await fixture(async(context,turn)=>{if(turn===1){f.c.projects.handle({type:'projects.brief.save',projectId:context.project.projectId,expectedRevision:0,content:'Wait for the owner before opening another page.',knowledgeVersionIds:[]});return step('browser_tab_open',{url:origin+'/obsolete'});}assert.equal(context.project.briefRevision,1);return wait();});try{await f.start();assert.equal(f.turns,2);assert.equal(f.runtime.methods.length,0);assert.deepEqual(f.receipts().map(r=>r.tool_name),['user_request']);}finally{await f.close();}
});
test('Gmail attachment bytes are zeroed when the post-read run fence fails',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>;const bytes=Buffer.from('PRIVATE_ATTACHMENT'),account='fixture@example.test';
 const gmail={async status(){return{connectedAccount:account,connecting:false,error:null};},verifiedConnectedAccount(){return account;},async close(){},async readAttachmentReadonly(){f.c.handle({type:'tasks.pause',taskId:f.taskId});assert.equal(f.c.live.hasInFlightWork,true);return{filename:'input.txt',bytes,source:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};}} as unknown as GmailService;
 f=await fixture(()=>step('gmail_attachment',{messageId:'message1',attachmentId:'attachment1'}),{mode:'read_only_browser',allowedOrigins:[],mailAccount:account,mailDetail:'threads_and_attachments'},new Runtime(),gmail);
 try{await f.c.handleProjects({type:'projects.gmail.bind',projectId:f.c.projects.agent(f.agent.id),account});await f.start();assert.equal(f.c.snapshot().tasks[0].state,'paused');assert.ok(bytes.every(b=>b===0));assert.equal(f.turns,1);assert.equal(f.c.live.hasInFlightWork,false);const db=new DatabaseSync(f.c.databasePath);try{assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_versions').get()!.n,0);}finally{db.close();}}finally{await f.close();}
});
test('Gmail selected attachment is pinned and readable in the same run without broadening file access',async()=>{
 const bytes=Buffer.from('Selected attachment only.\n'),account='fixture@example.test';
 const gmail={async status(){return{connectedAccount:account,connecting:false,error:null};},verifiedConnectedAccount(){return account;},async close(){},async readAttachmentReadonly(){return{filename:'input.txt',bytes,source:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),account,accountVerified:true,readOnly:true}};}} as unknown as GmailService;
 const f=await fixture((context,turn)=>{if(turn===1)return step('gmail_attachment',{messageId:'message1',attachmentId:'attachment1'});if(turn===2){const ids=latest(context,'gmail_attachment').versionIds;assert.equal(ids.length,2);assert.ok(ids.every((id:string)=>context.inputs.some((v:any)=>v.versionId===id)));return step('read_file',{versionId:ids[0]});}assert.equal(latest(context,'read_file').text,'Selected attachment only.\n');return wait();},{mode:'read_only_browser',allowedOrigins:[],mailAccount:account,mailDetail:'threads_and_attachments'},new Runtime(),gmail);
 try{await f.c.handleProjects({type:'projects.gmail.bind',projectId:f.c.projects.agent(f.agent.id),account});await f.start();assert.equal(f.c.snapshot().tasks[0].state,'waiting');assert.equal(f.turns,3);assert.ok(bytes.every(b=>b===0));assert.deepEqual(f.receipts().map(r=>[r.tool_name,r.state]),[['gmail_attachment','succeeded'],['read_file','succeeded'],['user_request','succeeded']]);}finally{await f.close();}
});
