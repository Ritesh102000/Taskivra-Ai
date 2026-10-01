import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,lstat,realpath,symlink,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createConnection} from 'node:net';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeChromeRuntime} from '../../packages/native-browser/index';
// The extension source is JavaScript by design: Chrome loads the exact tested files.
// @ts-expect-error Runtime-only extension module.
import {Controller,validateRequest,validURL} from '../../extensions/agent-browser/policy.mjs';
// @ts-expect-error Runtime-only extension module.
import {NativeSession} from '../../extensions/agent-browser/session.mjs';
import {Decoder,encode,LIMIT} from '../../packages/native-browser/framing.mjs';
const request=(method:string,params:Record<string,unknown>={},actor='agent',generation=1)=>({method,params,actor,generation});
function fakeChrome(){
 const calls:{kind:string;value:any}[]=[],tabs=new Map<number,any>([[11,{id:11,windowId:2,active:true,url:'https://example.com/',title:'Example',status:'complete'}]]);let next=12,dom=1,sensitive=false;
 const api={
  tabs:{query:async(filter:any={})=>[...tabs.values()].filter(t=>(filter.active===undefined||t.active===filter.active)&&(!filter.lastFocusedWindow||t.windowId===2)),get:async(id:number)=>{if(!tabs.has(id))throw Error('missing');return tabs.get(id);},create:async(value:any)=>{calls.push({kind:'tab.create',value});const t={id:next++,windowId:2,title:'New tab',status:'complete',...value};tabs.set(t.id,t);return t;},update:async(id:number,value:any)=>{calls.push({kind:'tab.update',value});Object.assign(tabs.get(id),value);return tabs.get(id);},remove:async(id:number)=>{tabs.delete(id);}},
  windows:{create:async(value:any)=>{calls.push({kind:'window.create',value});return{id:3,tabs:[{id:99,windowId:3,url:value.url,title:''}]};},update:async(_id:number,value:any)=>{calls.push({kind:'window.update',value});}},
  debugger:{getTargets:async()=>[] as {tabId:number;attached:boolean}[],attach:async(value:any)=>{calls.push({kind:'attach',value});},detach:async(value:any)=>{calls.push({kind:'detach',value});},sendCommand:async()=>({data:'aGVsbG8='})},
  scripting:{executeScript:async(value:any)=>{const c=value.args[0];calls.push({kind:'script',value:c});if(c.type==='clear')return[{result:{cleared:true}}];if(['inspect','peek'].includes(c.type))return[{result:{documentId:'doc',revision:dom,sensitive,text:sensitive?'':'Example body',title:'Example',targets:c.type==='inspect'&&!sensitive?[{ref:'ref1',kind:'button',label:'Continue'}]:[],width:800,height:600}}];if(c.documentId!=='doc'||c.revision!==dom)return[{result:{error:'stale_observation'}}];if(sensitive)return[{result:{sensitive:true}}];dom++;return[{result:{acted:true}}];}},
 };
 return{api,calls,tabs,mutate:()=>dom++,sensitive:()=>{sensitive=true;}};
}
test('native framing bounds fragmented input and rejects oversized length before allocation',()=>{const wire=encode({kind:'hello'}),d=new Decoder();assert.deepEqual(d.push(wire.subarray(0,2)),[]);assert.deepEqual(d.push(wire.subarray(2)),[{kind:'hello'}]);const large=Buffer.alloc(4);large.writeUInt32LE(LIMIT+1);assert.throws(()=>new Decoder().push(large),/invalid_frame_length/);assert.throws(()=>encode('x'.repeat(LIMIT)),/frame_too_large/);});
test('closed extension command surface refuses raw script, forbidden URLs, forged owner methods and native human input',()=>{for(const url of ['file:///etc/passwd','chrome://settings','javascript:alert(1)','https://user:pass@example.com'])assert.throws(()=>validURL(url));assert.throws(()=>validateRequest(request('page.evaluate',{script:'1'})));assert.throws(()=>validateRequest(request('page.peek')));assert.throws(()=>validateRequest(request('control.take')));assert.throws(()=>validateRequest(request('page.fill',{tab:'t',revision:1,ref:'r',value:'secret'},'human')));assert.throws(()=>validateRequest(request('page.observe',{eval:'1'})));});
test('native select forwards only the exact observed target and value; stale document and selectors fail closed',async()=>{
 const f=fakeChrome(),s=new NativeSession(f.api,'selection-fixture',1);await s.initialize();
 const view=(await s.request(request('page.observe'))).result;
 await s.request(request('page.select',{tab:view.tab,revision:view.revision,ref:'ref1',value:'  exact option  '}));
 const sent=f.calls.findLast(c=>c.kind==='script'&&c.value.type==='select')?.value;assert.equal(sent?.ref,'ref1');assert.equal(sent?.value,'  exact option  ');assert.equal(sent?.documentId,'doc');
 assert.throws(()=>validateRequest(request('page.select',{tab:view.tab,revision:view.revision,ref:'ref1',value:'x',selector:'#hidden'})),/invalid_params/);
 const next=(await s.request(request('page.observe'))).result;f.mutate();await assert.rejects(s.request(request('page.select',{tab:next.tab,revision:next.revision,ref:'ref1',value:'ready'})),/stale_observation/);await s.end();
});
test('takeover immediately invalidates in-flight/queued agent commands, then requires fresh observation after return',async()=>{const c=new Controller(1);let release!:()=>void;const gate=new Promise<void>(res=>release=res);const running=c.submit(request('page.observe'),async()=>{await gate;return{};});await delay(0);const queued=c.submit(request('tabs.list'),async()=>[]);const take=c.submit(request('control.take',{},'owner'),async()=>({observation:{}}));const rejected=Promise.all([assert.rejects(running,/outcome_unknown/),assert.rejects(queued,/outcome_unknown/)]);release();await rejected;assert.equal((await take).generation,2);assert.throws(()=>c.submit(request('page.observe',{},'agent',1),async()=>{}),/stale_generation/);await c.submit(request('control.release',{},'owner',2),async()=>({}));await assert.rejects(c.submit(request('tabs.open',{url:'https://example.com'},'agent',3),async()=>({})),/fresh_observation_required/);});
test('background session uses opaque tab refs, never focuses for agent actions, and detaches screenshots',async()=>{const f=fakeChrome(),s=new NativeSession(f.api,'session',1);await s.initialize();const observed=(await s.request(request('page.observe'))).result;assert.notEqual(observed.tab,11);await s.request(request('tabs.open',{url:'https://example.org/'}));await s.request(request('page.peek',{},'owner'));assert.equal(f.calls.filter(c=>c.kind==='attach').length,1);assert.equal(f.calls.filter(c=>c.kind==='detach').length,1);assert.ok(f.calls.filter(c=>c.kind==='tab.create').every(c=>c.value.active===false));assert.equal(f.calls.filter(c=>c.kind==='window.update'||c.kind==='tab.update'&&c.value.active).length,0);await s.end();assert.equal(f.tabs.size,0);});
test('manual takeover returns only redacted metadata and makes no page reads until return',async()=>{const f=fakeChrome(),s=new NativeSession(f.api,'session',1);await s.initialize();await s.request(request('page.observe'));await s.request(request('page.peek',{},'owner'));const taken=await s.request(request('control.take',{},'owner'));assert.equal(taken.result.observation.frame,null);assert.equal(taken.result.observation.tabs[0].url,'about:blank');const before=f.calls.length;await s.request(request('page.observe',{},'owner',2));assert.equal(f.calls.length,before);await s.show();assert.equal(f.calls.filter(c=>c.kind==='window.update').length,1);await assert.rejects(async()=>s.request(request('page.observe',{},'agent',2)),/permission_denied/);await s.end();});
test('return adopts the active human tab without focusing or reading it before a fresh agent observation',async()=>{
 const f=fakeChrome(),s=new NativeSession(f.api,'session',1);await s.initialize();const old=(await s.request(request('page.observe'))).result.tab;await s.request(request('control.take',{},'owner'));
 f.tabs.get(11).active=false;const humanTab={id:12,windowId:2,active:true,url:'https://mail.google.com/mail/#inbox',title:'Synthetic mailbox',status:'complete'};f.tabs.set(12,humanTab);f.tabs.set(13,{id:13,windowId:3,active:true,url:'https://example.org/',title:'Other window'});s.created(humanTab);
 const before=f.calls.length;assert.equal((await s.request(request('page.observe',{},'owner',2))).result.frame,null);assert.equal(f.calls.length,before);assert.equal(s.tabs.size,1);
 const released=(await s.request(request('control.release',{tab:old},'owner',2))).result.observation;assert.notEqual(released.selectedTabId,old);assert.equal(s.record(released.selectedTabId).chromeId,12);assert.equal(released.frame,null);assert.ok(released.tabs.every((t:any)=>t.url==='about:blank'));assert.ok(f.calls.slice(before).every(c=>c.kind==='script'&&c.value.type==='clear'));
 const fresh=(await s.request(request('page.observe',{},'agent',3))).result;assert.equal(fresh.tab,released.selectedTabId);assert.equal(fresh.url,humanTab.url);
 await s.request(request('control.take',{},'owner',3));f.tabs.get(12).active=false;f.tabs.set(14,{id:14,windowId:2,active:true,url:'chrome://extensions',title:'Extensions'});
 const fallback=(await s.request(request('control.release',{},'owner',4))).result.observation;assert.equal(fallback.selectedTabId,released.selectedTabId);assert.equal(f.calls.filter(c=>c.kind==='tab.update'||c.kind==='window.update'||c.kind==='attach').length,0);await s.end();assert.ok(f.tabs.has(14));
});
test('sensitive login observation has no text, targets or screenshot; stale DOM refs cannot click',async()=>{const f=fakeChrome(),s=new NativeSession(f.api,'session',1);await s.initialize();const obs=(await s.request(request('page.observe'))).result;f.mutate();await assert.rejects(s.request(request('page.click',{tab:obs.tab,revision:obs.revision,ref:'ref1'})),/stale_observation/);f.sensitive();const login=(await s.request(request('page.observe'))).result;assert.equal(login.humanLoginRequired,true);assert.equal(login.text,'');assert.deepEqual(login.targets,[]);const peek=(await s.request(request('page.peek',{},'owner'))).result;assert.equal(peek.frame,null);assert.equal(f.calls.filter(c=>c.kind==='attach').length,0);await s.end();});
test('native transfer is explicit and unsupported, while managed download collection is empty',async()=>{const s=new NativeSession(fakeChrome().api,'session',1);await s.initialize();assert.throws(()=>s.request(request('upload.begin',{},'owner')),/native_transfer_unsupported/);assert.deepEqual((await s.request(request('download.list',{},'owner'))).result,[]);await s.end();});
test('dedicated profile registration and authenticated native socket fence cross-profile/reconnect commands',async t=>{
 if(process.platform!=='darwin')return t.skip('macOS helper prerequisite');
 const dataRoot=await realpath(await mkdtemp(join(tmpdir(),'aw-native-test-'))),runtime=new NativeChromeRuntime({dataRoot,bridgeInstallRoot:join(dataRoot,'bridge-install'),extensionPath:resolve('extensions/agent-browser'),hostPath:resolve('packages/native-browser/native-host.mjs')});let socket:ReturnType<typeof createConnection>|undefined;
 try{
  const status=await runtime.setup('agent_a');assert.equal(status.registered,true);assert.equal(status.connected,false);assert.equal(status.setupRequired,true);
  const profile=join(dataRoot,'native-browser/profiles/agent_a'),cfg=JSON.parse(await readFile(join((runtime as any).installation('agent_a'),'host-config.json'),'utf8'));assert.equal((await lstat(join((runtime as any).installation('agent_a'),'host-config.json'))).mode&0o777,0o600);
  const rejectedHost=spawnSync(join((runtime as any).installation('agent_a'),'native-host'),[`chrome-extension://${cfg.extensionId}/`],{encoding:'utf8',timeout:3000});assert.equal(rejectedHost.status,1);assert.match(rejectedHost.stderr,/agent-browser:profile_verifier/);
  const manifest=JSON.parse(await readFile(join(profile,'NativeMessagingHosts/com.agent_workspaces.browser.json'),'utf8'));assert.equal(manifest.allowed_origins[0],`chrome-extension://${cfg.extensionId}/`);
  const denied=createConnection(cfg.socketPath);await new Promise<void>(res=>denied.once('connect',res));denied.write(encode({type:'hello',agentId:'agent_b',profile:join(dataRoot,'native-browser/profiles/agent_b'),origin:manifest.allowed_origins[0]}));await new Promise<void>(res=>denied.once('close',()=>res()));assert.equal((await runtime.agentStatus('agent_b')).connected,false);
  socket=createConnection(cfg.socketPath);await new Promise<void>(res=>socket!.once('connect',res));const decoder=new Decoder();let generation=4;let acknowledged!:()=>void;const handshake=new Promise<void>(resolve=>acknowledged=resolve);
  socket.on('data',chunk=>{for(const raw of decoder.push(chunk)){const command=raw as any;if(command.type==='bridge.connected'){acknowledged();continue;}let result:any={};if(command.method==='session.request'){if(command.params.request.method==='control.take')generation++;result={controller:generation===4?'agent':'human',generation,result:{observation:{}}};}socket!.write(encode({id:command.id,result}));}});
  socket.write(encode({type:'hello',agentId:'agent_a',profile:cfg.profile,token:cfg.token,origin:manifest.allowed_origins[0]}));await handshake;
  assert.equal((await runtime.agentStatus('agent_a')).connected,true);let exits=0;const handle=await runtime.launch({sessionId:'session_a',agentId:'agent_a',initialGeneration:4,onExit:()=>exits++});
  await handle.request('page.observe',{},{actor:'agent',generation:4});await handle.request('control.take',{},{actor:'owner',generation:4});await assert.rejects(handle.request('page.observe',{},{actor:'agent',generation:4}),/stale_generation/);
  socket.destroy();await delay(20);assert.equal(exits,1);await assert.rejects(handle.request('page.observe',{},{actor:'agent',generation:5}),/session_not_running/);
 }finally{socket?.destroy();await runtime.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('real coordinator browser service consumes native extension replies through open, handoff, return and close',async()=>{
 const {Coordinator}=await import('../../packages/coordinator/index');const root=await mkdtemp(join(tmpdir(),'aw-native-service-'));const f=fakeChrome();let session:any;
 const runtime={status:async()=>({ready:true,message:null,backend:'desktop_chrome' as const,supportsTransfers:false}),reconcile:async()=>{},close:async()=>{await session?.end();},launch:async(options:any)=>{session=new NativeSession(f.api,options.sessionId,options.initialGeneration);await session.initialize();return{request:(method:string,params:any,o:any)=>session.request({method,params,...o}),stop:()=>session.end(),close:async()=>{await session.end();return{saved:true,savedAt:Date.now()};}};}};
 const c=new Coordinator({dataRoot:join(root,'app'),browserRuntime:runtime});try{
  await c.browser.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});const agent=c.handle({type:'agents.create',name:'Native test agent',instructions:''}).agents[0];const task=c.handle({type:'tasks.create',agentId:agent.id,objective:'Inspect synthetic page',completionCriteria:'',scenario:'complete'}).tasks[0];
  let state=await c.browser.handle({type:'browser.open',agentId:agent.id,taskId:task.id});assert.equal(state.lifecycle,'ready');assert.equal(state.controller,'agent');assert.ok(state.frame);
  const bound=()=>({agentId:agent.id,sessionId:state.sessionId,generation:state.generation});
  state=await c.browser.handle({type:'browser.takeControl',...bound()});assert.equal(state.controller,'human');assert.equal(state.frame,null);assert.equal(state.tabs[0].url,'about:blank');
  const before=f.calls.length;state=await c.browser.handle({type:'browser.observe',...bound()});assert.equal(f.calls.length,before);
  const oldTab=state.activeTabId;f.tabs.get(11).active=false;f.tabs.set(12,{id:12,windowId:2,active:true,url:'https://example.org/owner-finished',title:'Owner finished',status:'complete'});
  state=await c.browser.handle({type:'browser.returnControl',...bound()});assert.equal(state.controller,'agent');assert.notEqual(state.activeTabId,oldTab);assert.equal(state.tabs.find(t=>t.id===state.activeTabId)?.url,'https://example.org/owner-finished');assert.equal(state.frame?.tabId,state.activeTabId);assert.ok(state.frame);assert.equal(f.calls.filter(c=>c.kind==='tab.update'||c.kind==='window.update').length,0);
  state=await c.browser.handle({type:'browser.close',...bound()});assert.equal(state.lifecycle,'idle');
 }finally{await c.shutdown();await rm(root,{recursive:true,force:true});}
});


test('registration refuses a symlink destination and leaves its external target untouched',async t=>{
 if(process.platform!=='darwin')return t.skip('macOS helper prerequisite');
 const dataRoot=await realpath(await mkdtemp(join(tmpdir(),'aw-native-links-'))),runtime=new NativeChromeRuntime({dataRoot,bridgeInstallRoot:join(dataRoot,'bridge-install'),extensionPath:resolve('extensions/agent-browser'),hostPath:resolve('packages/native-browser/native-host.mjs')});
 try{await runtime.setup('agent_a');const target=join(dataRoot,'unrelated.txt'),config=join(dataRoot,'bridge-install/agent_a/host-config.json');await writeFile(target,'DO_NOT_CHANGE');await unlink(config);await symlink(target,config);await assert.rejects(runtime.setup('agent_a'),/unsafe_profile/);assert.equal(await readFile(target,'utf8'),'DO_NOT_CHANGE');}
 finally{await runtime.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('stop during background tab creation removes the late tab instead of leaving execution running',async()=>{
 const f=fakeChrome();f.tabs.clear();let release!:(value:any)=>void;f.api.windows.create=async()=>new Promise(res=>release=res);const s=new NativeSession(f.api,'session',1);const opening=s.initialize();await delay(0);await s.end();f.tabs.set(99,{id:99,windowId:3,url:'about:blank'});release({tabs:[{id:99,windowId:3,url:'about:blank'}]});await assert.rejects(opening,/session_not_running/);assert.equal(f.tabs.size,0);
});

test('native runtime can retry after another owner releases its socket without deleting the foreign socket',async t=>{
 if(process.platform!=='darwin')return t.skip('macOS helper prerequisite');const dataRoot=await realpath(await mkdtemp(join(tmpdir(),'aw-native-retry-')));const options={dataRoot,bridgeInstallRoot:join(dataRoot,'bridge-install'),extensionPath:resolve('extensions/agent-browser'),hostPath:resolve('packages/native-browser/native-host.mjs')};const first=new NativeChromeRuntime(options),second=new NativeChromeRuntime(options);
 try{await first.setup('agent_a');await assert.rejects(second.reconcile(),/runtime_owned/);const cfg=JSON.parse(await readFile(join(dataRoot,'bridge-install/agent_a/host-config.json'),'utf8'));assert.ok((await lstat(cfg.socketPath)).isSocket());await first.close();await second.reconcile();assert.equal((await second.setup('agent_b')).registered,true);}
 finally{await first.close();await second.close();await rm(dataRoot,{recursive:true,force:true});}
});
test('one damaged profile registration is quarantined while another agent can prepare a healthy profile',async t=>{
 if(process.platform!=='darwin')return t.skip('macOS helper prerequisite');const dataRoot=await realpath(await mkdtemp(join(tmpdir(),'aw-native-quarantine-')));const options={dataRoot,bridgeInstallRoot:join(dataRoot,'bridge-install'),extensionPath:resolve('extensions/agent-browser'),hostPath:resolve('packages/native-browser/native-host.mjs')};const first=new NativeChromeRuntime(options),second=new NativeChromeRuntime(options);
 try{await first.setup('agent_bad');await first.close();const config=join(dataRoot,'bridge-install/agent_bad/host-config.json'),target=join(dataRoot,'untouched');await writeFile(target,'UNCHANGED');await unlink(config);await symlink(target,config);await second.reconcile();assert.match((await second.agentStatus('agent_bad')).message!,/unsafe or damaged/);assert.equal((await second.setup('agent_good')).registered,true);assert.equal(await readFile(target,'utf8'),'UNCHANGED');}
 finally{await first.close();await second.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('handoff cannot claim debugger detachment while Chrome reports an attached owned target; stop still closes tabs',async()=>{
 const f=fakeChrome(),s=new NativeSession(f.api,'session',1);await s.initialize();await s.request(request('page.observe'));f.api.debugger.getTargets=async()=>[{tabId:11,attached:true}];await assert.rejects(s.request(request('control.take',{},'owner')),/debugger_detach_failed/);await assert.rejects(s.end(),/debugger_detach_failed/);assert.equal(f.tabs.size,0);
});
