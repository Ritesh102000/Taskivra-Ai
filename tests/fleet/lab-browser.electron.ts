import {DEFAULT_MODEL} from '../../packages/model-adapters/pricing';
import {DEFAULT_FLEET_LIMITS,DEFAULT_FLEET_TASK_LIMITS} from '../../packages/contracts/fleet';
import {Coordinator} from '../../packages/coordinator';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {app} from 'electron';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {LocalLabController,LAB_ORIGIN} from '../../packages/local-lab';
import {ElectronLabRuntime} from '../../apps/desktop/main/lab-browser-runtime';

app.on('window-all-closed',()=>{});
void app.whenReady().then(async()=>{
const lab=new LocalLabController({serverPath:resolve('labs/harbor-desk/server.mjs'),cookies:id=>runtime.cookies(id)}),runtime=new ElectronLabRuntime(lab);
const results:string[]=[];
try{
 assert.equal((await lab.start()).ready,true);results.push('App verifies its own localhost server nonce');
 const brokerRoot=await mkdtemp(join(tmpdir(),'aw-lab-broker-'));const coordinator=new Coordinator({dataRoot:brokerRoot,browserRuntime:runtime,localLab:lab});await coordinator.live.ready;
 const fleet=(await coordinator.fleets.handle({type:'fleet.create',mode:'local_website',projectId:'personal-workspace',objective:'Local browser broker fixture',sourceVersionIds:[],plannerModel:DEFAULT_MODEL,workerModel:DEFAULT_MODEL,limits:{...DEFAULT_FLEET_LIMITS},taskLimits:{...DEFAULT_FLEET_TASK_LIMITS},idempotencyKey:'real-browser-broker-fixture'})).fleets[0];
 const task=fleet.tasks[0];const db=(coordinator as any).persistence.db;db.prepare("UPDATE fleet_runs SET status='running' WHERE id=?").run(fleet.id);db.prepare("UPDATE tasks SET state='queued' WHERE id=?").run(task.taskId);db.prepare('UPDATE live_task_config SET enabled=1 WHERE task_id=?').run(task.taskId);
 const claim=coordinator.claimNext(coordinator.instanceId,'live')!;assert.ok(claim);
 try{const state=await coordinator.browser.agentOpen(claim);assert.equal(state.lifecycle,'ready');await coordinator.browser.stopForTask(task.taskId);results.push('Actual Fleet BrowserService broker opens and closes local runtime');}catch(error){console.error('BROKER CAUSE',error,(error as Error).cause);throw error;}finally{await coordinator.shutdown();await rm(brokerRoot,{recursive:true,force:true});}
 await lab.start();
 const one=await runtime.launch({agentId:'first',sessionId:'s1',initialGeneration:1,onExit(){}});
 const two=await runtime.launch({agentId:'second',sessionId:'s2',initialGeneration:1,onExit(){}});
 const request=(handle:typeof one,method:string,params:Record<string,unknown>={},generation=1,actor:'agent'|'owner'='agent')=>handle.request(method,params,{actor,generation});
 let view=(await request(one,'page.observe')).result as any;assert.match(view.text,/Harbor Desk/);assert.ok(view.targets.length);assert.ok(view.frame.jpegBase64);results.push('Real Chromium page text, controls and screenshot');
 view=(await request(one,'page.navigate',{tab:view.tab,url:LAB_ORIGIN+'/'})).result as any;
 assert.ok(view.targets.length,'Navigation must wait for client-side controls, rather than return only a loading screen');assert.match(view.text,/Start your free workspace/);results.push('Navigation returns actual rendered controls after client startup');
 const joinTarget=view.targets.find((t:any)=>/start.*workspace|start.*trial|create.*workspace/i.test(t.label));assert.ok(joinTarget,JSON.stringify(view.targets));
 await request(one,'page.click',{tab:view.tab,revision:view.revision,ref:joinTarget.ref});
 await assert.rejects(request(one,'page.click',{tab:view.tab,revision:view.revision,ref:joinTarget.ref}),/stale/);results.push('Stale control references rejected');
 view=(await request(one,'page.observe')).result as any;
 for(const [label,value] of [['Your display name','Browser Tester'],['Workspace name','Independent QA'],['Fictional email address','tester@example.test']]){
  const input=view.targets.find((t:any)=>t.kind==='input'&&t.label.toLowerCase().includes(label.toLowerCase()));assert.ok(input,JSON.stringify(view.targets));
  view=(await request(one,'page.fill',{tab:view.tab,revision:view.revision,ref:input.ref,value})).result;
 }
 const submit=view.targets.find((t:any)=>t.kind==='button'&&/create my workspace/i.test(t.label));assert.ok(submit);view=(await request(one,'page.click',{tab:view.tab,revision:view.revision,ref:submit.ref})).result;
 assert.ok(await runtime.cookies('first'));assert.equal(await runtime.cookies('second'),'');results.push('Ordinary self-registration and isolated session cookies');
 const http=await lab.command('first',JSON.stringify(['curl',LAB_ORIGIN+'/api/session'])) as any;assert.equal(http.status,200);assert.match(http.body,/Browser Tester/);results.push('Bounded local request uses this agent session only');
 await assert.rejects(request(one,'page.navigate',{tab:view.tab,url:'https://example.com/'}),/training/);results.push('Other websites cannot be reached');
 const takeover=await request(one,'control.take',{tab:view.tab},1,'owner');assert.equal(takeover.controller,'human');
 await assert.rejects(request(one,'page.observe',{},1),/stale/);await assert.rejects(request(one,'page.observe',{},2),/controller/);
 const release=await request(one,'control.release',{tab:view.tab},2,'owner');assert.equal(release.controller,'agent');assert.equal(release.generation,3);results.push('Human takeover fences prior agent generation');
 await one.stop();await two.stop();assert.equal(await runtime.cookies('first'),'');results.push('Browser close removes synthetic sessions');
 writeFileSync(resolve('.test-data/fleet-lab-run-20260930/private/browser-proof.json'),JSON.stringify({passed:results.length,checks:results},null,2),{mode:0o600});
 console.log(JSON.stringify({passed:results.length,checks:results}));
}catch(error){console.error(error);process.exitCode=1;}finally{await runtime.close();app.exit(Number(process.exitCode)||0);}

});
