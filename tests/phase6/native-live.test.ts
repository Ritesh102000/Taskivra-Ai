import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,relative,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeChromeRuntime} from '../../packages/native-browser';
import type {BrowserHandle} from '../../packages/browser/runtime';

// Opt-in only: the owner first installs the reviewed extension into this explicit
// disposable QA profile and closes the desktop app using the same data root.
// No model, mailbox, OS input or personal Chrome profile is touched.
test('installed native host and real Chrome extension navigate in background, fence handoff and close owned tabs',{skip:process.env.AW_NATIVE_BROWSER_TEST!=='1',timeout:90_000},async()=>{
 const dataRoot=resolve(process.env.AW_NATIVE_QA_ROOT||''),agentId=process.env.AW_NATIVE_QA_AGENT||'',testRoot=resolve('.test-data');const rel=relative(testRoot,dataRoot);
 assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Use an explicit .test-data QA root, never the real app data root.');assert.match(agentId,/^[a-zA-Z0-9_-]{1,96}$/);
 const runtime=new NativeChromeRuntime({dataRoot,extensionPath:resolve('extensions/agent-browser'),hostPath:resolve('packages/native-browser/native-host.mjs')});let handle:BrowserHandle|undefined;
 try{
  await runtime.setup(agentId);let connected=false;for(let i=0;i<45;i++){if((await runtime.agentStatus(agentId)).connected){connected=true;break;}await delay(1000);}assert.ok(connected,'The owner-installed extension must reconnect to this app-owned native socket.');
  console.log('Native bridge authenticated; beginning public-page background check.');
  handle=await runtime.launch({sessionId:'native_public_page_qa',agentId,initialGeneration:1,onExit:()=>{}});
  const list=(await handle.request('tabs.list',{},{actor:'agent',generation:1})).result as {id:string;url:string}[];
  assert.ok(list.length>0);for(const tab of list)assert.ok(['about:blank','https://example.com/','https://example.org/'].includes(tab.url),'QA profile contains a non-fixture page; no content was observed.');
  let result=(await handle.request('page.observe',{tab:list[0].id},{actor:'agent',generation:1})).result as any;
  result=(await handle.request('page.navigate',{tab:result.tab,url:'https://example.com/'},{actor:'agent',generation:1})).result as any;
  assert.match(result.text,/documentation examples/);assert.equal(new URL(result.url).origin,'https://example.com');const oldRevision=result.revision;
  const peek=(await handle.request('page.peek',{tab:result.tab},{actor:'owner',generation:1})).result as any;assert.ok(peek.frame?.jpegBase64,'Real background preview should contain a bounded JPEG.');assert.ok(peek.frame.jpegBase64.length<=700*1024);
  const taken=await handle.request('control.take',{tab:result.tab},{actor:'owner',generation:1});assert.equal(taken.controller,'human');assert.equal(taken.generation,2);assert.equal((taken.result as any).debuggerDetached,true,'Chrome debugger.getTargets confirms owned targets are detached before human control.');const redacted=(taken.result as any).observation;assert.equal(redacted.frame,null);assert.equal(redacted.text,'');assert.ok(redacted.tabs.every((tab:any)=>tab.url==='about:blank'));
  await assert.rejects(handle.request('page.scroll',{tab:result.tab,revision:oldRevision,x:0,y:50},{actor:'agent',generation:1}),/stale_generation/);
  const human=(await handle.request('page.observe',{tab:result.tab},{actor:'owner',generation:2})).result as any;assert.equal(human.frame,null);assert.equal(human.text,'');
  const returned=await handle.request('control.release',{tab:result.tab},{actor:'owner',generation:2});assert.equal(returned.generation,3);
  await assert.rejects(handle.request('page.scroll',{tab:result.tab,revision:oldRevision,x:0,y:50},{actor:'agent',generation:3}),/fresh_observation_required/);
  result=(await handle.request('page.observe',{tab:result.tab},{actor:'agent',generation:3})).result as any;assert.match(result.text,/documentation examples/);assert.ok(result.revision>oldRevision);
  const closed=await handle.close({saveProfile:true});assert.equal(closed.saved,true);await assert.rejects(handle.request('tabs.list',{},{actor:'agent',generation:3}),/session_not_running/);handle=undefined;
  console.log('Native Chrome public-page navigation, JPEG preview, private human handoff, fresh return and stop passed.');
 }finally{await handle?.stop();await runtime.close();}
});
