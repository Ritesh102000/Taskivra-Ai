import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerBrowserRuntimeFactory } from '../../packages/browser-runtime/index';
import type { BrowserHandle, RequestOptions } from '../../packages/browser-runtime/types';
const exec=promisify(execFile),site='http://fixture.agent-workspaces.test:8080';
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const code=(expected:string)=>(cause:any)=>cause.code===expected||cause.message===expected;
class Session {
  generation:number;actor:'agent'|'human'='agent';observation:any;
  constructor(readonly handle:BrowserHandle,generation:number){this.generation=generation;}
  async request(method:string,params:object={},actor:RequestOptions['actor']=this.actor){try{const reply=await this.handle.request(method,params,{actor,generation:this.generation});this.generation=reply.generation;return reply.result as any;}catch(cause){const error=cause as Error;error.message=`${method}: ${error.message}`;throw error;}}
  async observe(tab?:string){this.observation=await this.request('page.observe',tab?{tab}:{},'broker');return this.observation;}
  async take(){const result=await this.request('control.take',{},'owner');this.actor='human';this.observation=result.observation;}
  async open(path:string){this.observation=await this.request('tabs.open',{url:site+path});return this.observation;}
  async fill(label:string,value:string){const ref=this.observation.targets.find((item:any)=>item.kind==='input'&&item.label.trim()===label)?.ref;assert.ok(ref,`Missing ${label} field`);this.observation=await this.request('page.fill',{tab:this.observation.tab,revision:this.observation.revision,ref,value});}
  async click(label:string){const ref=this.observation.targets.find((item:any)=>item.label.trim()===label)?.ref;assert.ok(ref,`Missing ${label} target`);this.observation=await this.request('page.click',{tab:this.observation.tab,revision:this.observation.revision,ref});}
}

test('Docker worker proves sandbox, two sessions, handoff, uploads/downloads and durable profile restart', {skip:process.env.AW_BROWSER_DOCKER_TEST!=='1',timeout:240_000},async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'aw-phase3-browser-docker-')),factory=new DockerBrowserRuntimeFactory({dataRoot,profileKey:randomBytes(32),seccompPath:resolve('containers/browser/seccomp.json'),testFixture:true});
  const checks:Record<string,boolean>={},startedAt=new Date().toISOString(),images:Record<string,string>={},sourceSha256:Record<string,string>={};let sandboxEvidence:unknown,a:Session|undefined,b:Session|undefined;
  try{
    assert.equal((await factory.status()).ready,true,'Explicit browser image setup is required.');
    a=new Session(await factory.launch({agentId:'agent-a',sessionId:'session-a',initialGeneration:41}),41);
    b=new Session(await factory.launch({agentId:'agent-b',sessionId:'session-b',initialGeneration:91}),91);
    images.browser=a.handle.info.imageId;sandboxEvidence=a.handle.info.sandbox;
    const topology=JSON.parse((await exec('docker',['network','inspect',a.handle.info.networkId])).stdout)[0],proxyId=Object.keys(topology.Containers).find(id=>id!==a!.handle.info.containerId)!;
    images.egress=JSON.parse((await exec('docker',['inspect',proxyId])).stdout)[0].Image;
    const workerFiles=['protocol.mjs','files.mjs','sandbox.mjs','worker.mjs','gmail.mjs','dom-fence.mjs'];for(const name of workerFiles)sourceSha256[name]=digest(await readFile(resolve('workers/browser',name)));
    const insideHashes=(await exec('docker',['exec',a.handle.info.containerId,'sha256sum',...workerFiles.map(name=>`/opt/browser-worker/${name}`)])).stdout;
    for(const name of workerFiles)assert.ok(insideHashes.includes(`${sourceSha256[name]}  /opt/browser-worker/${name}`));
    for(const session of [a,b]){
      const sandbox=session.handle.info.sandbox as any;assert.equal(sandbox.namespaceSandbox,true);assert.equal(sandbox.seccompBpfSandbox,true);assert.equal(sandbox.noNewPrivileges,true);assert.equal(sandbox.unsafeFlags,false);assert.ok(sandbox.renderers.length);
      const inspected=JSON.parse((await exec('docker',['inspect',session.handle.info.containerId],{maxBuffer:1024*1024})).stdout)[0];
      assert.equal(inspected.HostConfig.Privileged,false);assert.equal(inspected.Config.User,'1000:1000');assert.equal(inspected.HostConfig.ReadonlyRootfs,true);assert.deepEqual(inspected.HostConfig.CapDrop,['ALL']);assert.equal(inspected.HostConfig.NetworkMode,session.handle.info.networkId);assert.equal(inspected.HostConfig.IpcMode,'private');assert.equal(Object.keys(inspected.HostConfig.PortBindings||{}).length,0);assert.equal(inspected.Mounts.some((m:any)=>m.Type==='bind'),false);
      const view=await session.observe();assert.equal(view.frame.tabId,view.tab);assert.ok(Buffer.from(view.frame.jpegBase64,'base64').length<=2*1024*1024);assert.equal(Buffer.from(view.frame.jpegBase64,'base64').readUInt16BE(),0xffd8);
    }checks.sandboxLaunchAndResourceBoundary=true;
    for(const [session,name]of [[a,'Alice'],[b,'Bob']] as const){
      await session.take();await session.open('/');await session.fill('User',name);await session.fill('Password','SyntheticOnly42');assert.equal(session.observation.text.includes('SyntheticOnly42'),false);await session.click('Sign in');assert.match(session.observation.text,new RegExp(`Account: ${name}`));await session.open('/health');assert.equal((await session.request('tabs.list')).length,3);
    }checks.separateCookieIdentitiesAndThreeTabs=true;
    const aTab=a.observation.tab,bTab=b.observation.tab;
    await assert.rejects(a.request('page.observe',{tab:bTab},'broker'),code('unknown_tab'));
    const stale=a.observation;await a.observe(aTab);await assert.rejects(a.request('page.key',{tab:aTab,revision:stale.revision,text:'should not run'}),code('stale_observation'));
    await assert.rejects(a.handle.request('page.observe',{tab:aTab},{actor:'agent',generation:41}),code('stale_generation'));
    await assert.rejects(a.request('page.key',{tab:aTab,revision:a.observation.revision,text:'denied'},'agent'),code('permission_denied'));checks.humanFencingAndForeignIds=true;
    await a.open('/popup');await a.click('Open account popup');for(let n=0;n<20&&(await a.request('tabs.list')).length<5;n++)await delay(50);assert.equal((await a.request('tabs.list')).length,5);assert.equal((await b.request('tabs.list')).length,3);checks.popupOwnership=true;
    await a.open('/transfers');const uploadView=a.observation,fileRef=uploadView.targets.find((item:any)=>item.kind==='file')?.ref;assert.ok(fileRef);
    const bytes=Buffer.from('phase3 authorized upload\n'),upload=await a.request('upload.begin',{name:'verified.txt',bytes:bytes.length,sha256:digest(bytes),versionId:'version_1',tab:uploadView.tab,revision:uploadView.revision,ref:fileRef,origin:site},'broker');
    await a.request('upload.chunk',{id:upload.id,offset:0,base64:bytes.toString('base64')},'broker');const selected=await a.request('upload.finish',{id:upload.id},'broker');a.observation=selected.observation;await a.click('Submit upload');assert.ok(a.observation.text.includes(digest(bytes))||a.observation.text.includes('phase3 authorized upload'));checks.checkedUpload=true;
    a.observation=await a.request('page.navigate',{tab:a.observation.tab,url:site+'/cross-origin-upload'});const denied=a.observation.targets.find((item:any)=>item.kind==='file');assert.ok(denied);
    await assert.rejects(a.request('upload.begin',{name:'denied.txt',bytes:bytes.length,sha256:digest(bytes),versionId:'version_1',tab:a.observation.tab,revision:a.observation.revision,ref:denied.ref,origin:site},'broker'),code('upload_origin_mismatch'));checks.crossOriginFormUploadBlocked=true;
    a.observation=await a.request('page.navigate',{tab:a.observation.tab,url:site+'/transfers'});const downloadTab=a.observation.tab;await a.click('Download fixture');let downloads:any[]=[];
    for(let n=0;n<60;n++){downloads=await a.request('download.list',{},'broker');if(downloads.some(item=>item.completed))break;await delay(100);}
    assert.equal(downloads.length,1);assert.equal(downloads[0].status,'complete');assert.equal(downloads[0].tabId,downloadTab);assert.equal(downloads[0].origin,site);assert.equal('path'in downloads[0],false);
    const chunk=await a.request('download.read',{id:downloads[0].id,offset:0,length:128*1024},'broker'),downloaded=Buffer.from(chunk.base64,'base64');assert.equal(digest(downloaded),downloads[0].sha256);assert.equal(chunk.eof,true);
    await writeFile(join(dataRoot,'persisted-private-download.bin'),downloaded,{flag:'wx',mode:0o600});await a.request('download.ack',{id:downloads[0].id},'broker');assert.deepEqual(await a.request('download.list',{},'broker'),[]);checks.persistedDownloadBeforeContextClose=true;
    await a.request('control.release',{},'owner');a.actor='agent';await assert.rejects(a.request('page.key',{tab:downloadTab,revision:a.observation.revision,key:'Enter'}),code('fresh_observation_required'));
    const fresh=await a.request('page.observe',{tab:downloadTab},'agent');assert.equal(fresh.frame,null);checks.freshAgentObservationAndNoAgentFrame=true;
    a.observation=await a.request('page.navigate',{tab:downloadTab,url:site+'/reviewed-actions'},'agent');
    await a.fill('Record title','  Reviewed title  ');assert.match(a.observation.text,/Entered:.*Reviewed title/);
    const selection=a.observation.targets.find((item:any)=>item.kind==='select');assert.ok(selection);
    a.observation=await a.request('page.select',{tab:a.observation.tab,revision:a.observation.revision,ref:selection.ref,value:'ready'},'agent');assert.match(a.observation.text,/Selected: ready/);
    await a.click('Save record');assert.match(a.observation.text,/Saved:.*Reviewed title.*ready/);
    await a.click('Change target later');const old=a.observation,oldRef=old.targets.find((item:any)=>item.label==='Save record')?.ref;assert.ok(oldRef);await delay(1250);
    await assert.rejects(a.request('page.click',{tab:old.tab,revision:old.revision,ref:oldRef},'agent'),code('stale_observation'));
    a.observation=await a.request('page.observe',{tab:old.tab},'agent');assert.ok(a.observation.targets.some((item:any)=>item.label==='Delete record'));assert.match(a.observation.text,/Saved:.*Reviewed title.*ready/);checks.reviewedFillSelectClickAndDOMMutationFence=true;
    assert.equal((await a.handle.close({saveProfile:true})).saved,true);a=new Session(await factory.launch({agentId:'agent-a',sessionId:'session-a',initialGeneration:51}),51);assert.equal(a.handle.info.restored,true);
    const initial=await a.request('page.observe',{},'agent');const restored=await a.request('page.navigate',{tab:initial.tab,url:site+'/account'},'agent');assert.match(restored.text,/Account: Alice/);
    await assert.rejects(a.handle.request('page.observe',{tab:initial.tab},{actor:'agent',generation:43}),code('stale_generation'));checks.encryptedProfileRestartAndFreshGeneration=true;
    await exec('docker',['kill',a.handle.info.containerId]);await delay(100);b.observation=await b.request('page.navigate',{tab:bTab,url:site+'/account'});assert.match(b.observation.text,/Account: Bob/);checks.oneWorkerCrashLeavesPeerWorking=true;
    const evidence={kind:'phase3-browser-worker',startedAt,finishedAt:new Date().toISOString(),images,sourceSha256,sandbox:sandboxEvidence,checks,limitations:['Synthetic local fixture; real provider MFA/passkeys not exercised.','File selection grants the page access; JavaScript may forward received bytes.','No screenshots, profiles or credential input are recorded in this report.']};
    await mkdir(resolve('tests/phase3/evidence'),{recursive:true});await writeFile(resolve('tests/phase3/evidence/worker-docker.json'),JSON.stringify(evidence,null,2)+'\n');
  }finally{await factory.close();await rm(dataRoot,{recursive:true,force:true});}
});
