import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../../packages/coordinator/index';
import { DockerBrowserRuntimeFactory } from '../../packages/browser-runtime/index';
import type { BrowserState } from '../../packages/contracts/browser';

// Product service integration. Uses only a fresh labelled fixture runtime and
// synthetic credentials; no native app/browser automation or external account.
test('real browser service accepts owner pointer then queued-style keyboard login', {skip:process.env.AW_DOCKER_TESTS!=='1',timeout:120_000}, async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'aw-phase3-service-input-'));
  const runtime=new DockerBrowserRuntimeFactory({dataRoot,profileKey:randomBytes(32),seccompPath:resolve('containers/browser/seccomp.json'),testFixture:true});
  const c=new Coordinator({dataRoot,browserRuntime:runtime});
  const bound=(s:BrowserState)=>({agentId:s.agentId,sessionId:s.sessionId,generation:s.generation});
  const page=(s:BrowserState)=>({...bound(s),tabId:s.activeTabId!,revision:s.frame!.revision});
  try{
    await c.browser.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});
    const a=c.handle({type:'agents.create',name:'Input integration',instructions:''}).agents[0];
    const t=c.handle({type:'tasks.create',agentId:a.id,objective:'Synthetic input fixture',completionCriteria:'',scenario:'complete'}).tasks[0];
    let s=await c.browser.handle({type:'browser.open',agentId:a.id,taskId:t.id});
    s=await c.browser.handle({type:'browser.takeControl',...bound(s)});
    s=await c.browser.handle({type:'browser.navigate',...page(s),url:'http://fixture.agent-workspaces.test:8080/'});
    // Coordinates are defined by the repository's fixed HTML fixture, not read
    // from an unrelated live browser or a screenshot automation tool.
    s=await c.browser.handle({type:'browser.observe',...bound(s)});
    await delay(250); // A fresh screenshot must remain usable after its rendering cleanup.
    s=await c.browser.handle({type:'browser.pointer',...page(s),x:118,y:123});
    s=await c.browser.handle({type:'browser.text',...page(s),text:'ServiceInput'});
    s=await c.browser.handle({type:'browser.key',...page(s),key:'Tab'});
    s=await c.browser.handle({type:'browser.text',...page(s),text:'synthetic'});
    s=await c.browser.handle({type:'browser.key',...page(s),key:'Enter'});
    assert.equal(new URL(s.tabs.find(tab=>tab.id===s.activeTabId)!.url).pathname,'/account');
    s=await c.browser.handle({type:'browser.returnControl',...bound(s)});
    const claim=c.claimNext()!;
    const view=await c.browser.agentAction(claim,s.sessionId,s.generation,'page.observe',{tab:s.activeTabId}) as {text:string};
    assert.match(view.text,/Account: ServiceInput/);
  }finally{await c.shutdown();await rm(dataRoot,{recursive:true,force:true});}
});
