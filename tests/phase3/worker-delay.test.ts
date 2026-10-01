import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerBrowserRuntimeFactory } from '../../packages/browser-runtime/index';

test('a static page remains clickable after a human-scale delay following screenshot observation', {skip:process.env.AW_BROWSER_DOCKER_TEST!=='1',timeout:90_000},async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'aw-browser-frame-delay-')),factory=new DockerBrowserRuntimeFactory({dataRoot,profileKey:randomBytes(32),seccompPath:resolve('containers/browser/seccomp.json'),testFixture:true});
  try{
    const browser=await factory.launch({agentId:'delay-agent',sessionId:'delay-session',initialGeneration:61});
    const take=await browser.request('control.take',{}, {actor:'owner',generation:61}),generation=take.generation;
    const opened=await browser.request('tabs.open',{url:'http://fixture.agent-workspaces.test:8080/'},{actor:'human',generation}),tab=(opened.result as any).tab;
    await delay(250);
    for(const screenshot of [false,true,true]){
      const observed=(await browser.request('page.observe',{tab,screenshot},{actor:'broker',generation})).result as any;
      assert.equal(observed.tabs.find((item:any)=>item.id===tab).revision,observed.revision);
      if(screenshot)assert.equal(observed.frame.revision,observed.revision);
      await delay(250);
      const listed=(await browser.request('tabs.list',{}, {actor:'broker',generation})).result as any[];
      assert.equal(listed.find(item=>item.id===tab)!.revision,observed.revision,`screenshot=${screenshot} mutated the static page revision`);
      await browser.request('page.click',{tab,revision:observed.revision,x:10,y:10},{actor:'human',generation});
      await delay(250);
    }
  }finally{await factory.close();await rm(dataRoot,{recursive:true,force:true});}
});
