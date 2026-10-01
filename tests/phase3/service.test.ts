import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator/index';
import { BrowserError } from '../../packages/browser/index';
import type { BrowserHandle, BrowserReply, BrowserRuntime } from '../../packages/browser/runtime';
import type { BrowserState, BrowserTab } from '../../packages/contracts/browser';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { DEFAULT_MODEL } from '../../packages/model-adapters/pricing';

function deferred() { let resolve!:()=>void; const promise=new Promise<void>(done=>{resolve=done;}); return {promise,resolve}; }
type Launch=Parameters<BrowserRuntime['launch']>[0];
type Options=Parameters<BrowserHandle['request']>[2];
class FakeHandle implements BrowserHandle {
  generation:number; controller:'agent'|'human'='agent'; stopped=false; closed=false;
  tabs:BrowserTab[]=[{id:randomUUID(),url:'https://fixture.example.test/',title:'Fixture',revision:1}];
  selected=this.tabs[0].id;
  calls:{method:string;params:Record<string,unknown>;options:Options}[]=[];
  frameCanary='OWNER_FRAME_CANARY'; textCanary='OWNER_OBSERVATION_CANARY';
  downloadBytes=new Map<string,Buffer>(); ackFailures=0; failObserve=false; failControl=false; corruptDownload=false;
  block:{method:string;entered:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>}|null=null;
  uploaded:Buffer[]=[];
  failNext:{method:string;error:Error}|null=null;
  constructor(readonly launch:Launch){this.generation=launch.initialGeneration;}
  observation(advance=true){const tab=this.tabs.find(t=>t.id===this.selected); if(tab&&advance)tab.revision++; return {tabs:structuredClone(this.tabs),selectedTabId:tab?.id||null,targets:tab?[{ref:'input-file',kind:'file',label:'Attach file'}]:[],text:this.textCanary,frame:tab?{jpegBase64:Buffer.from(this.frameCanary).toString('base64'),width:1120,height:760,revision:tab.revision,tabId:tab.id}:null};}
  async request(method:string,params:Record<string,unknown>,options:Options):Promise<BrowserReply>{
    this.calls.push({method,params:structuredClone(params),options:{...options}});
    if(this.stopped||this.closed)throw new Error('worker_stopped');
    if(this.failNext?.method===method){const failure=this.failNext;this.failNext=null;throw failure.error;}
    if(options.generation!==this.generation)throw new Error('stale_generation');
    if(method==='control.take'||method==='control.release'){
      if(this.failControl){this.failControl=false;throw new Error('control_response_lost');}
      this.generation++;this.controller=method==='control.take'?'human':'agent';
      return {controller:this.controller,generation:this.generation,result:{observation:this.observation()}};
    }
    if(this.block?.method===method){const block=this.block;block.entered.resolve();await block.release.promise;this.block=null;if(options.generation!==this.generation)throw new Error('stale_generation');}
    let result:unknown;
    if(method==='page.observe'&&this.failObserve)throw new Error('invalid_initial_view');
    if(method==='download.list')result=[...this.downloadBytes].map(([id,bytes])=>({id,name:'download.txt',bytes:bytes.length,completed:true,status:'ready',sha256:createHash('sha256').update(bytes).digest('hex'),tabId:this.selected,origin:'https://fixture.example.test'}));
    else if(method==='download.read'){const bytes=this.downloadBytes.get(String(params.id));if(!bytes)throw new Error('unknown_download');const chunk=bytes.subarray(Number(params.offset),Number(params.offset)+Number(params.length));result={offset:params.offset,base64:(this.corruptDownload?Buffer.alloc(chunk.length):chunk).toString('base64')};}
    else if(method==='download.ack'){if(this.ackFailures-->0)throw new Error('ack_response_lost');this.downloadBytes.delete(String(params.id));result={ok:true};}
    else if(method==='upload.begin')result={id:'upload-one'};
    else if(method==='upload.chunk'){this.uploaded.push(Buffer.from(String(params.base64),'base64'));result={ok:true};}
    else if(method==='upload.finish')result={observation:this.observation()};
    else if(method==='upload.abort')result={ok:true};
    else if(method==='tabs.list')result=structuredClone(this.tabs);
    else if(method==='page.peek'){const view=this.observation(false);result={tabs:view.tabs,selectedTabId:view.selectedTabId,frame:view.frame};}
    else{
      if(method==='tabs.open'){assert.ok(this.tabs.length<6);const tab={id:randomUUID(),url:String(params.url),title:'New tab',revision:1};this.tabs.push(tab);this.selected=tab.id;}
      else if(method==='tabs.close'){const index=this.tabs.findIndex(t=>t.id===params.tab);if(index<0)throw new Error('unknown_tab');this.tabs.splice(index,1);this.selected=this.tabs[0]?.id||'';}
      else if(params.tab){const tab=this.tabs.find(t=>t.id===params.tab);if(!tab)throw new Error('unknown_tab');this.selected=tab.id;if(method==='page.navigate')tab.url=String(params.url);}
      result=this.observation();
    }
    return {controller:this.controller,generation:this.generation,result};
  }
  async close(options:{saveProfile:boolean}){this.closed=true;return {saved:options.saveProfile,savedAt:123456};}
  async stop(){this.stopped=true;}
  crash(){this.stopped=true;this.launch.onExit();}
}
class FakeRuntime implements BrowserRuntime {
  handles:FakeHandle[]=[]; failNextObservation=false; recoveryFailure=false;
  async status(){return {ready:true,message:null};}
  async launch(options:Launch){const handle=new FakeHandle(options);handle.failObserve=this.failNextObservation;this.failNextObservation=false;this.handles.push(handle);return handle;}
  async reconcile(){if(this.recoveryFailure)throw new Error('cleanup_unavailable');}
  async close(){for(const handle of this.handles)if(!handle.closed)await handle.stop();}
}
async function fixture(runtime=new FakeRuntime()){
  const root=await mkdtemp(join(tmpdir(),'aw-phase3-service-'));
  const c=new Coordinator({dataRoot:join(root,'app'),browserRuntime:runtime});await c.browser.ready;
  const db=()=>new DatabaseSync(c.databasePath);
  const agent=(name='A')=>{const known=new Set(c.snapshot().agents.map(a=>a.id));return c.handle({type:'agents.create',name,instructions:''}).agents.find(a=>!known.has(a.id))!;};
  const task=(agentId:string)=>{const known=new Set(c.snapshot().tasks.map(t=>t.id));return c.handle({type:'tasks.create',agentId,objective:'Browser service fixture',completionCriteria:'',scenario:'complete'}).tasks.find(t=>!known.has(t.id))!;};
  const source=async(name:string,content:string)=>{const path=join(root,name);await writeFile(path,content);return path;};
  return {root,c,runtime,db,agent,task,source,close:async()=>{await c.browser.shutdown();c.close();await c.artifacts.drain();await rm(root,{recursive:true,force:true});}};
}
const bound=(state:BrowserState)=>({agentId:state.agentId,sessionId:state.sessionId,generation:state.generation});
const page=(state:BrowserState)=>({...bound(state),tabId:state.activeTabId!,revision:state.frame!.revision});
const code=(expected:string)=>(error:unknown)=>error instanceof BrowserError&&error.code===expected;

async function liveDownloadFixture(f:Awaited<ReturnType<typeof fixture>>){
  await f.c.live.ready;const agent=f.agent('Download agent');const taskId=f.c.createLiveTask({type:'live.createTask',agentId:agent.id,objective:'Save an authorized downloaded source.',completionCriteria:'Read the exact private source.',model:DEFAULT_MODEL,limits:DEFAULT_LIVE_LIMITS,policy:{mode:'workspace',allowedOrigins:['https://fixture.example.test']}});
  const db=f.db();try{db.prepare("UPDATE tasks SET state='queued' WHERE id=?").run(taskId);db.prepare('UPDATE live_task_config SET enabled=1 WHERE task_id=?').run(taskId);}finally{db.close();}
  const claim=f.c.claimNext(undefined,'live')!;assert.ok(claim);const off=f.db();try{off.prepare('UPDATE live_task_config SET enabled=0 WHERE task_id=?').run(taskId);}finally{off.close();}
  await f.c.browser.agentOpen(claim);return{agent,taskId,claim,worker:f.runtime.handles[0]};
}

test('agent managed download save verifies bytes and idempotently pins the exact private version to its active run',async()=>{
  const f=await fixture();try{
    const {claim,worker,agent,taskId}=await liveDownloadFixture(f);worker.downloadBytes.set('download-a',Buffer.from('reviewed input\n'));
    const list=await f.c.browser.agentDownloads(claim);assert.equal(list.length,1);assert.equal(list[0].origin,'https://fixture.example.test');
    const saved=await f.c.browser.agentSaveDownload(claim,'download-a');assert.equal(saved.readyForTask,true);
    assert.equal((await f.c.artifacts.preview({principal:{kind:'agent',agentId:agent.id},versionId:saved.versionId})).text,'reviewed input\n');
    const again=await f.c.browser.agentSaveDownload(claim,'download-a');assert.equal(again.versionId,saved.versionId);
    const db=f.db();try{assert.equal(db.prepare('SELECT count(*) AS n FROM run_artifact_bindings WHERE run_id=? AND version_id=?').get(claim.runId,saved.versionId)!.n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM task_artifacts WHERE task_id=? AND version_id=? AND role='input'").get(taskId,saved.versionId)!.n,1);}finally{db.close();}
    await assert.rejects(f.c.browser.agentSaveDownload(claim,'foreign-id'),code('permission_denied'));
  }finally{await f.close();}
});

test('agent downloads are denied for read-only policies and outside origins; a fenced read cannot commit bytes',async()=>{
  const f=await fixture();try{
    const {claim,worker,taskId}=await liveDownloadFixture(f);worker.downloadBytes.set('download-a',Buffer.from('never import after pause'));
    const change=(policy:object)=>{const db=f.db();try{db.prepare('UPDATE live_task_config SET policy_json=? WHERE task_id=?').run(JSON.stringify(policy),taskId);}finally{db.close();}};
    change({mode:'read_only_browser',allowedOrigins:['https://fixture.example.test']});await assert.rejects(f.c.browser.agentDownloads(claim),code('permission_denied'));
    change({mode:'workspace',allowedOrigins:['https://other.example.test']});assert.deepEqual(await f.c.browser.agentDownloads(claim),[]);await assert.rejects(f.c.browser.agentSaveDownload(claim,'download-a'),code('permission_denied'));
    change({mode:'workspace',allowedOrigins:['https://fixture.example.test']});const gate={method:'download.read',entered:deferred(),release:deferred()};worker.block=gate;
    const saving=f.c.browser.agentSaveDownload(claim,'download-a');const rejected=assert.rejects(saving);await gate.entered.promise;f.c.handle({type:'tasks.pause',taskId});gate.release.resolve();await rejected;
    const db=f.db();try{assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_versions').get()!.n,0);}finally{db.close();}
  }finally{await f.close();}
});

// The fake emulates the framed worker protocol; these tests exercise the real
// coordinator, broker, SQLite transactions, artifact bytes and filesystem cleanup.
test('explicit startup, capacity, task association and owner page fences are enforced before dispatch',async()=>{
  const f=await fixture();try{const a=f.agent(),b=f.agent('B'),d=f.agent('C'),ta=f.task(a.id),ta2=f.task(a.id),tb=f.task(b.id),td=f.task(d.id);
    assert.equal((await f.c.browser.handle({type:'browser.state',agentId:a.id})).lifecycle,'idle');assert.equal(f.runtime.handles.length,0);
    await assert.rejects(f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:tb.id}),code('not_found'));
    let sa=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});const sb=await f.c.browser.handle({type:'browser.open',agentId:b.id,taskId:tb.id});
    await assert.rejects(f.c.browser.handle({type:'browser.open',agentId:d.id,taskId:td.id}),code('browser_capacity'));
    await assert.rejects(f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta2.id}),code('task_mismatch'));
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(sa),text:'not-owner'}),code('controller_required'));
    const stale=sa;sa=await f.c.browser.handle({type:'browser.takeControl',...bound(sa)});assert.equal(sa.controller,'human');assert.ok(sa.generation>stale.generation);
    const count=f.runtime.handles[0].calls.length;
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(stale),text:'stale'}),code('stale_browser'));
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(sa),sessionId:sb.sessionId,text:'wrong-session'}),code('stale_browser'));
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(sa),tabId:sb.activeTabId!,text:'wrong-tab'}),code('unknown_tab'));
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(sa),revision:sa.frame!.revision-1,text:'old-view'}),code('stale_observation'));
    assert.equal(f.runtime.handles[0].calls.length,count);
    const changed=await f.c.browser.handle({type:'browser.text',...page(sa),text:'owner input'});assert.ok(changed.frame!.revision>sa.frame!.revision);
    assert.equal(f.runtime.handles[0].calls.findLast(call=>call.method==='page.key')?.options.actor,'human');
  }finally{await f.close();}
});

test('owner progress polling uses a peek that preserves agent observation revisions and targets',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id),claim=f.c.claimNext()!;
    const opened=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});
    const worker=f.runtime.handles[0],agentView=await f.c.browser.agentAction(claim,opened.sessionId,opened.generation,'page.observe',{});
    const revision=worker.tabs[0].revision;worker.calls.length=0;
    for(let n=0;n<3;n++){
      const state=await f.c.browser.handle({type:'browser.observe',...bound(opened)});
      assert.equal(state.frame!.revision,revision);assert.equal(state.tabs[0].revision,revision);assert.deepEqual(state.targets,[{ref:'input-file',kind:'file',label:'Attach file'}]);
    }
    assert.equal(worker.calls.filter(call=>call.method==='page.peek').length,3);
    assert.equal(worker.calls.some(call=>call.method==='page.observe'),false);
    await assert.rejects(f.c.browser.agentAction(claim,opened.sessionId,opened.generation,'page.peek',{}),code('permission_denied'));
    assert.ok(agentView);
  }finally{await f.close();}
});

test('takeover fences an in-flight agent action and records an unknown outcome without replay',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id),claim=f.c.claimNext()!;let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});
    const handle=f.runtime.handles[0],gate={method:'page.navigate',entered:deferred(),release:deferred()};handle.block=gate;
    const pending=f.c.browser.agentAction(claim,s.sessionId,s.generation,'page.navigate',{tab:s.activeTabId,url:'https://fixture.example.test/submit'});
    const rejection=assert.rejects(pending,(error:unknown)=>error instanceof BrowserError&&['stale_generation','stale_browser'].includes(error.code));await gate.entered.promise;
    s=await f.c.browser.handle({type:'browser.takeControl',...bound(s)});gate.release.resolve();await rejection;
    assert.equal(s.controller,'human');await assert.rejects(f.c.browser.agentAction(claim,s.sessionId,s.generation,'page.observe',{}),code('permission_denied'));
    assert.equal(handle.calls.filter(call=>call.method==='page.navigate').length,1);
    const db=f.db();try{const calls=db.prepare('SELECT method,state FROM browser_tool_calls').all();assert.deepEqual(calls.map(row=>({...row})),[{method:'page.navigate',state:'outcome_unknown'}]);}finally{db.close();}
    s=await f.c.browser.handle({type:'browser.returnControl',...bound(s)});assert.equal(s.controller,'agent');assert.ok(s.frame);
    await f.c.browser.agentAction(claim,s.sessionId,s.generation,'page.observe',{});
  }finally{await f.close();}
});

test('login handoff fulfills exactly once and leaves an owner-paused task paused',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id);f.c.handle({type:'tasks.pause',taskId:ta.id});
    let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});s=await f.c.browser.handle({type:'browser.requestLogin',...bound(s),taskId:ta.id});
    assert.equal(s.controller,'human');assert.ok(s.requestId);assert.equal(f.c.snapshot().tasks.find(t=>t.id===ta.id)!.state,'paused');
    const request=s.requestId;s=await f.c.browser.handle({type:'browser.requestLogin',...bound(s),taskId:ta.id});assert.equal(s.requestId,request);
    const original=f.c.snapshot().requests.find(r=>r.id===request)!;assert.equal(original.type,'browser_handoff');
    assert.throws(()=>f.c.handle({type:'requests.respond',requestId:request!,revision:original.revision,response:'should not fulfill a login'}));
    s=await f.c.browser.handle({type:'browser.returnControl',...bound(s)});assert.equal(s.requestId,null);assert.equal(f.c.snapshot().requests.find(r=>r.id===request)!.state,'fulfilled');
    assert.equal(f.c.snapshot().tasks.find(t=>t.id===ta.id)!.state,'paused');
    const db=f.db();try{assert.equal(db.prepare('SELECT count(*) AS count FROM resume_receipts WHERE request_id=?').get(request!)!.count,1);}finally{db.close();}
    f.c.handle({type:'tasks.resume',taskId:ta.id});assert.equal(f.c.snapshot().tasks.find(t=>t.id===ta.id)!.state,'queued');
  }finally{await f.close();}
});

test('human text, URL query and owner frame never enter persisted tables or files',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id);let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});s=await f.c.browser.handle({type:'browser.takeControl',...bound(s)});
    const credential='LOGIN_CREDENTIAL_CANARY_71a8',query='LOGIN_QUERY_CANARY_0d35';
    s=await f.c.browser.handle({type:'browser.navigate',...page(s),url:`https://fixture.example.test/account?token=${query}`});s=await f.c.browser.handle({type:'browser.text',...page(s),text:credential});
    const markers=[credential,query,'OWNER_FRAME_CANARY','OWNER_OBSERVATION_CANARY',Buffer.from('OWNER_FRAME_CANARY').toString('base64')];
    const scan=async(label:string)=>{const db=f.db();try{for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){const rows=JSON.stringify(db.prepare(`SELECT * FROM "${String(table.name).replaceAll('"','""')}"`).all());for(const marker of markers)assert.equal(rows.includes(marker),false,`${label}: ${table.name} retained ${marker}`);}}finally{db.close();}
      const files=async(path:string):Promise<void>=>{for(const item of await readdir(path,{withFileTypes:true})){const target=join(path,item.name);if(item.isDirectory())await files(target);else if(item.isFile()){const content=await readFile(target);for(const marker of markers)assert.equal(content.includes(Buffer.from(marker)),false,`${label}: ${item.name} retained ${marker}`);}}};await files(f.c.dataRoot);};
    await scan('during human control');s=await f.c.browser.handle({type:'browser.returnControl',...bound(s)});await scan('after return');assert.equal(s.controller,'agent');
  }finally{await f.close();}
});

test('one worker crash clears its frame and fences commands without interrupting another agent',async()=>{
  const f=await fixture();try{const a=f.agent(),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id);const sa=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id}),sb=await f.c.browser.handle({type:'browser.open',agentId:b.id,taskId:tb.id});
    f.runtime.handles[0].crash();const lost=await f.c.browser.handle({type:'browser.state',agentId:a.id});assert.equal(lost.lifecycle,'disconnected');assert.equal(lost.frame,null);assert.deepEqual(lost.tabs,[]);assert.ok(lost.generation>sa.generation);
    await assert.rejects(f.c.browser.handle({type:'browser.takeControl',...bound(sa)}),code('stale_browser'));
    const other=await f.c.browser.handle({type:'browser.observe',...bound(sb)});assert.equal(other.lifecycle,'ready');assert.ok(other.frame);assert.equal(f.runtime.handles[1].stopped,false);
    const reopened=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});assert.equal(reopened.lifecycle,'ready');assert.ok(reopened.frame);assert.notEqual(reopened.activeTabId,sa.activeTabId);assert.ok(reopened.generation>lost.generation);
  }finally{await f.close();}
});

test('download bytes import privately once even when acknowledgement fails after commit',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id);let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});const handle=f.runtime.handles[0],id='download-one',bytes=Buffer.from('download bytes verified by checksum');handle.downloadBytes.set(id,bytes);handle.ackFailures=1;
    await assert.rejects(f.c.browser.handle({type:'browser.saveDownload',...bound(s),downloadId:id}),code('browser_action_failed'));
    const first=f.c.snapshot().artifacts;assert.equal(first.length,1);assert.equal(first[0].visibility,'private');assert.equal(first[0].ownerAgentId,a.id);assert.equal(first[0].producerTaskId,ta.id);
    s=await f.c.browser.handle({type:'browser.saveDownload',...bound(s),downloadId:id});assert.equal(f.c.snapshot().artifacts.length,1);assert.equal(s.downloads[0].versionId,first[0].id);assert.equal(s.downloads[0].state,'saved');
    assert.equal((await f.c.artifacts.preview({principal:{kind:'owner'},versionId:first[0].id})).text,bytes.toString());
    assert.equal(f.c.snapshot().taskArtifacts.filter(link=>link.versionId===first[0].id&&link.taskId===ta.id).length,1);
    assert.deepEqual(await readdir(join(f.c.dataRoot,'staging','artifacts')),[]);
    const db=f.db();try{const provenance=JSON.parse(String(db.prepare('SELECT provenance FROM artifact_versions WHERE id=?').get(first[0].id)!.provenance));assert.ok(JSON.stringify(provenance).includes(id));assert.ok(JSON.stringify(provenance).includes(s.sessionId));assert.deepEqual(first[0].browserSource,{origin:provenance.browserSource.origin});}finally{db.close();}
  }finally{await f.close();}
});

test('upload requires the exact task-linked private version, a fresh target and confirmed origin',async()=>{
  const f=await fixture();try{const a=f.agent(),b=f.agent('B'),ta=f.task(a.id),tb=f.task(b.id),bytes='exact pinned upload bytes';const path=await f.source('input.txt',bytes);
    const linked=(await f.c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:a.id,taskId:ta.id},paths:[path]})).versionIds[0];
    const unlinked=(await f.c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:a.id,taskId:null},paths:[await f.source('unlinked.txt','no grant')]})).versionIds[0];
    const foreign=(await f.c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:b.id,taskId:tb.id},paths:[await f.source('foreign.txt','private B')]})).versionIds[0];
    let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});s=await f.c.browser.handle({type:'browser.takeControl',...bound(s)});
    const upload={type:'browser.upload',...page(s),versionId:linked,ref:'input-file',destinationOrigin:'https://fixture.example.test'} as const;
    const before=f.runtime.handles[0].calls.length;
    for(const invalid of [{versionId:unlinked},{versionId:foreign},{ref:'forged-field'},{destinationOrigin:'https://other.example.test'}])await assert.rejects(f.c.browser.handle({...upload,...invalid}),code('upload_grant'));
    assert.equal(f.runtime.handles[0].calls.length,before);
    await f.c.browser.handle(upload);assert.equal(Buffer.concat(f.runtime.handles[0].uploaded).toString(),bytes);
    const begin=f.runtime.handles[0].calls.find(call=>call.method==='upload.begin')!;assert.equal(begin.params.versionId,linked);assert.equal(begin.params.origin,'https://fixture.example.test');
    assert.equal(f.runtime.handles[0].calls.filter(call=>call.method==='upload.finish').length,1);assert.equal(f.runtime.handles[0].calls.filter(call=>call.method==='upload.abort').length,0,'successful attachment must stay staged until the browser context closes');
  }finally{await f.close();}
});

test('a worker whose initial observation fails is stopped before another launch can proceed',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id);f.runtime.failNextObservation=true;
    await assert.rejects(f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id}),code('browser_start_failed'));
    assert.equal(f.runtime.handles[0].stopped,true,'failed worker must not stay alive outside capacity accounting');
    const s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});assert.equal(s.lifecycle,'ready');assert.equal(f.runtime.handles.filter(h=>!h.stopped&&!h.closed).length,1);
  }finally{await f.close();}
});

test('a cached idle view cannot claim a session subsequently owned by another live coordinator',async()=>{
  const f=await fixture();let peer:Coordinator|undefined;try{const a=f.agent(),ta=f.task(a.id),otherRuntime=new FakeRuntime();peer=new Coordinator({dataRoot:f.c.dataRoot,browserRuntime:otherRuntime});await peer.browser.ready;
    await peer.browser.handle({type:'browser.state',agentId:a.id});
    const owned=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});
    await assert.rejects(peer.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id}),code('browser_owned'));
    assert.equal(otherRuntime.handles.length,0);const stillOwned=await f.c.browser.handle({type:'browser.observe',...bound(owned)});assert.equal(stillOwned.lifecycle,'ready');
  }finally{peer?.close();await peer?.artifacts.drain();await f.close();}
});

test('control failure stops its live worker, hides the frame, and requires an explicit fresh launch',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id);const s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});f.runtime.handles[0].failControl=true;
    await assert.rejects(f.c.browser.handle({type:'browser.takeControl',...bound(s)}),/control_response_lost/);
    assert.equal(f.runtime.handles[0].stopped,true);const failed=await f.c.browser.handle({type:'browser.state',agentId:a.id});assert.equal(failed.lifecycle,'disconnected');assert.equal(failed.frame,null);assert.equal(failed.activeTabId,null);
    const fresh=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});assert.equal(fresh.controller,'agent');assert.ok(fresh.frame);assert.notEqual(fresh.activeTabId,s.activeTabId);
  }finally{await f.close();}
});

test('download checksum failure publishes no artifact and cleans staged bytes',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id),s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id}),worker=f.runtime.handles[0];worker.downloadBytes.set('corrupt-one',Buffer.from('verify actual bytes'));worker.corruptDownload=true;
    await assert.rejects(f.c.browser.handle({type:'browser.saveDownload',...bound(s),downloadId:'corrupt-one'}),code('download_integrity'));
    assert.equal(f.c.snapshot().artifacts.length,0);assert.equal(f.c.snapshot().taskArtifacts.length,0);assert.deepEqual(await readdir(join(f.c.dataRoot,'staging','artifacts')),[]);
    worker.downloadBytes.clear();
  }finally{await f.close();}
});

test('close fences a delayed agent result and waits before saving its profile',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id),claim=f.c.claimNext()!,s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id}),worker=f.runtime.handles[0],gate={method:'page.navigate',entered:deferred(),release:deferred()};worker.block=gate;
    const pending=f.c.browser.agentAction(claim,s.sessionId,s.generation,'page.navigate',{tab:s.activeTabId,url:'https://fixture.example.test/one-submit'});
    const rejected=assert.rejects(pending,(error:unknown)=>error instanceof BrowserError&&['stale_generation','stale_browser'].includes(error.code));await gate.entered.promise;
    const closing=f.c.browser.handle({type:'browser.close',...bound(s)});await Promise.resolve();const during=await f.c.browser.handle({type:'browser.state',agentId:a.id});assert.equal(during.lifecycle,'closing');assert.equal(during.frame,null);assert.equal(worker.closed,false);
    gate.release.resolve();await rejected;const closed=await closing;assert.equal(worker.closed,true);assert.equal(closed.lifecycle,'idle');assert.equal(closed.profile.saved,true);assert.equal(closed.profile.savedAt,123456);assert.equal(closed.frame,null);
    assert.equal(worker.calls.filter(call=>call.method==='page.navigate').length,1);
    const db=f.db();try{assert.equal(db.prepare('SELECT state FROM browser_tool_calls').get()!.state,'outcome_unknown');}finally{db.close();}
  }finally{await f.close();}
});

test('running login handoff fences the old run and resumes from its saved checkpoint',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id),claim=f.c.claimNext()!;f.c.executeSyntheticTool(claim,'simulation.observe');
    let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});await f.c.browser.agentRequestLogin(claim,s.sessionId,s.generation);s=await f.c.browser.handle({type:'browser.state',agentId:a.id});
    assert.equal(s.controller,'human');assert.ok(s.requestId);const waiting=f.c.snapshot().tasks.find(t=>t.id===ta.id)!;assert.equal(waiting.state,'waiting');assert.equal(waiting.checkpoint,1);assert.equal(f.c.claimNext(),null);
    await assert.rejects(f.c.browser.agentAction(claim,s.sessionId,s.generation,'page.observe',{}),/no longer owns/);
    s=await f.c.browser.handle({type:'browser.returnControl',...bound(s)});assert.equal(f.c.snapshot().tasks.find(t=>t.id===ta.id)!.state,'queued');
    const resumed=f.c.claimNext()!;assert.notEqual(resumed.runId,claim.runId);assert.ok(resumed.generation>claim.generation);assert.equal(f.c.snapshot().tasks.find(t=>t.id===ta.id)!.checkpoint,1);
    await f.c.browser.agentAction(resumed,s.sessionId,s.generation,'page.observe',{});
  }finally{await f.close();}
});

test('a late exit callback from a replaced worker cannot disconnect its replacement',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id);const s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id}),old=f.runtime.handles[0];old.failControl=true;
    await assert.rejects(f.c.browser.handle({type:'browser.takeControl',...bound(s)}),/control_response_lost/);
    const current=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});old.launch.onExit();
    const after=await f.c.browser.handle({type:'browser.state',agentId:a.id});assert.equal(after.lifecycle,'ready');assert.equal(after.generation,current.generation);assert.equal(f.runtime.handles[1].stopped,false);assert.equal(after.activeTabId,current.activeTabId);
  }finally{await f.close();}
});

test('plain-text paste preserves Unicode and newlines within the bound and rejects oversized or NUL input before dispatch',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id);let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});s=await f.c.browser.handle({type:'browser.takeControl',...bound(s)});
    const text='Login paste: café हिन्दी 日本語\nnext line 😀\tend';s=await f.c.browser.handle({type:'browser.text',...page(s),text});assert.equal(f.runtime.handles[0].calls.findLast(call=>call.method==='page.key')!.params.text,text);
    s=await f.c.browser.handle({type:'browser.text',...page(s),text:'x'.repeat(8192)});assert.equal(String(f.runtime.handles[0].calls.findLast(call=>call.method==='page.key')!.params.text).length,8192);
    const count=f.runtime.handles[0].calls.length;
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(s),text:'x'.repeat(8193)}),/input exceeds/);
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(s),text:'before\0after'}),/input exceeds/);
    assert.equal(f.runtime.handles[0].calls.length,count);
  }finally{await f.close();}
});

test('worker errors expose only allowlisted static messages and never raw page/input text',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id);let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});s=await f.c.browser.handle({type:'browser.takeControl',...bound(s)});const worker=f.runtime.handles[0],secret='RAW_FAILURE_LOGIN_URL_CANARY';
    worker.failNext={method:'page.key',error:Object.assign(new Error(secret),{code:'stale_observation'})};
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(s),text:'synthetic'}),(error:unknown)=>{assert.ok(error instanceof BrowserError);assert.equal(error.code,'stale_observation');assert.match(error.message,/page changed/i);assert.equal(error.message.includes(secret),false);return true;});
    worker.failNext={method:'page.key',error:Object.assign(new Error(secret),{code:secret})};
    await assert.rejects(f.c.browser.handle({type:'browser.text',...page(s),text:'synthetic'}),(error:unknown)=>{assert.ok(error instanceof BrowserError);assert.equal(error.code,'browser_action_failed');assert.equal(error.message.includes(secret),false);return true;});
  }finally{await f.close();}
});

test('a failed upload chunk aborts only its unfinished staging transfer',async()=>{
  const f=await fixture();try{const a=f.agent(),ta=f.task(a.id),path=await f.source('failed-upload.txt','private synthetic bytes');const versionId=(await f.c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:a.id,taskId:ta.id},paths:[path]})).versionIds[0];
    let s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:ta.id});s=await f.c.browser.handle({type:'browser.takeControl',...bound(s)});const worker=f.runtime.handles[0];worker.failNext={method:'upload.chunk',error:new Error('lost_chunk_response')};
    await assert.rejects(f.c.browser.handle({type:'browser.upload',...page(s),versionId,ref:'input-file',destinationOrigin:'https://fixture.example.test'}),code('browser_action_failed'));
    assert.equal(worker.calls.filter(call=>call.method==='upload.finish').length,0);assert.equal(worker.calls.filter(call=>call.method==='upload.abort').length,1);assert.deepEqual(await readdir(join(f.c.dataRoot,'staging','artifacts')),[]);
  }finally{await f.close();}
});


test('unavailable recovery leaves files/tasks usable and refuses browser launch until cleanup succeeds',async()=>{
  const runtime=new FakeRuntime();runtime.recoveryFailure=true;const f=await fixture(runtime);
  try{const a=f.agent(),task=f.task(a.id);assert.equal(f.c.snapshot().tasks.length,1);
    assert.equal((await f.c.browser.handle({type:'browser.state',agentId:a.id})).runtime.ready,false);
    await assert.rejects(f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:task.id}),code('browser_recovery_required'));assert.equal(runtime.handles.length,0);
    runtime.recoveryFailure=false;assert.equal((await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:task.id})).lifecycle,'ready');
  }finally{await f.close();}
});

test('mismatched owner frame metadata is rejected without accepting a foreign tab image',async()=>{
  const f=await fixture();try{const a=f.agent(),task=f.task(a.id),s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:task.id});const worker=f.runtime.handles[0],observe=worker.observation.bind(worker);
    worker.observation=()=>{const view=observe();view.frame!.tabId='foreign_tab';return view;};
    await assert.rejects(f.c.browser.handle({type:'browser.observe',...bound(s)}),code('invalid_observation'));
    const state=await f.c.browser.handle({type:'browser.state',agentId:a.id});assert.notEqual(state.frame?.tabId,'foreign_tab');worker.observation=observe;
  }finally{await f.close();}
});

test('unsupported permission creates one bounded alternative request and never grants the capability',async()=>{
  const f=await fixture();try{const a=f.agent(),task=f.task(a.id),claim=f.c.claimNext()!,s=await f.c.browser.handle({type:'browser.open',agentId:a.id,taskId:task.id});const worker=f.runtime.handles[0],observe=worker.observation.bind(worker);
    worker.observation=()=>({...observe(),permissions:[{permission:'geolocation'},{permission:'geolocation'},{permission:'not-a-capability'}]});
    await f.c.browser.agentAction(claim,s.sessionId,s.generation,'page.observe',{});const snapshot=f.c.snapshot();assert.equal(snapshot.tasks[0].state,'waiting');assert.equal(snapshot.requests.length,1);assert.match(snapshot.requests[0].reason,/does not enable/);
    f.c.handle({type:'requests.respond',requestId:snapshot.requests[0].id,revision:snapshot.requests[0].revision,response:'Use the manually supplied city instead.'});assert.equal(f.c.snapshot().tasks[0].state,'queued');
    assert.equal(worker.calls.some(call=>/permission/.test(call.method)),false);
  }finally{await f.close();}
});
