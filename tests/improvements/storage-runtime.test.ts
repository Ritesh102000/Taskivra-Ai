import test from 'node:test';
import assert from 'node:assert/strict';
import {nextOccurrence} from '../../packages/routines/timing';
// @ts-ignore JavaScript recipe module exercised at runtime.
import {validateRecipe} from '../../packages/code-runtime/recipe.mjs';
test('weekly missing spring-forward time skips to next valid Sunday',()=>{
 assert.equal(new Date(nextOccurrence(Date.parse('2026-03-01T08:00:00Z'),{timezone:'America/New_York',hour:2,minute:30,weekdays:[0]})).toISOString(),'2026-03-15T06:30:00.000Z');
});
test('npm package punctuation retains exact identity and exact duplicates fail',()=>{
 const node=[{name:'object.assign',version:'4.1.7'},{name:'object-assign',version:'4.1.1'}];
 assert.equal(validateRecipe({version:1,node}).node.length,2);
 assert.throws(()=>validateRecipe({version:1,node:[node[0],node[0]]}),/Duplicate/);
});
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Coordinator} from '../../packages/coordinator';
test('failed mixed import releases copied staging in the same process',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-staging-repair-'));const c=new Coordinator({dataRoot:join(root,'app')});
 try{
  await c.artifacts.ready;const agent=c.handle({type:'agents.create',name:'Staging test',instructions:''}).agents[0];
  const good=join(root,'good.txt'),bad=join(root,'bad.png');await writeFile(good,'valid text');await writeFile(bad,'invalid image');
  await assert.rejects(c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:agent.id,taskId:null},paths:[good,bad]}));
  assert.deepEqual(await readdir(join(c.dataRoot,'staging/artifacts')),[]);
 }finally{await c.shutdown();await rm(root,{recursive:true,force:true});}
});
import {StringDecoder} from 'node:string_decoder';
test('code log broker preserves UTF8 characters across chunks independently per stream',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-utf8-'));const c=new Coordinator({dataRoot:root});
 try{
  await c.code.ready;
  const entry={stopped:false,logBytes:0,stdout:'',stderr:'',lastFlush:Date.now(),decoders:{stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')}};
  type LogEntry=typeof entry;
  const service=c.code as unknown as {log(entry:LogEntry,stream:'stdout'|'stderr',bytes:Uint8Array):void};
  const bytes=Buffer.from('A界🙂Z');for(const byte of bytes)service.log(entry,'stdout',new Uint8Array([byte]));
  assert.equal(entry.stdout,'A界🙂Z');assert.equal(entry.stderr,'');
 }finally{await c.shutdown();await rm(root,{recursive:true,force:true});}
});
import {compatibleExtension} from '../../packages/native-browser';
test('native extension compatibility requires declared behavior before task binding',()=>{
 const capabilities=['generation-fence','dom-fence','readonly-fill','navigation-completion','owner-handoff'];
 assert.equal(compatibleExtension({protocol:1,capabilities}),true);
 assert.equal(compatibleExtension({protocol:2,capabilities}),false);
 assert.equal(compatibleExtension({protocol:1,capabilities:capabilities.slice(1)}),false);
 assert.equal(compatibleExtension(null),false);
});
import {chmod} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {safeRecoveryFailure,RecoveryError} from '../../packages/recovery';
test('owner exact quarantine repair preserves version identity and rejects mismatched bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-quarantine-'));const c=new Coordinator({dataRoot:join(root,'app')});
 try{
  await c.artifacts.ready;const agent=c.handle({type:'agents.create',name:'Repair test',instructions:''}).agents[0];const source=join(root,'original.txt');await writeFile(source,'immutable original');
  const versionId=(await c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:agent.id,taskId:null},paths:[source]})).versionIds[0];
  const db=new DatabaseSync(c.databasePath);const path=join(c.dataRoot,String(db.prepare('SELECT storage_ref FROM artifact_versions WHERE id=?').get(versionId)!.storage_ref));db.close();
  await chmod(path,0o600);await writeFile(path,'damaged');await assert.rejects(c.artifacts.preview({principal:{kind:'owner'},versionId}));
  await assert.rejects(c.artifacts.repairVersion({principal:{kind:'agent',agentId:agent.id},versionId,sourcePath:source}));
  const wrong=join(root,'wrong.txt');await writeFile(wrong,'wrong');await assert.rejects(c.artifacts.repairVersion({principal:{kind:'owner'},versionId,sourcePath:wrong}));
  const repaired=await c.artifacts.repairVersion({principal:{kind:'owner'},versionId,sourcePath:source});assert.equal(repaired.id,versionId);assert.equal(repaired.status,'ready');assert.equal((await c.artifacts.preview({principal:{kind:'owner'},versionId})).text,'immutable original');
 }finally{await c.shutdown();await rm(root,{recursive:true,force:true});}
});
test('recovery guidance maps reviewed categories and never raw filesystem text',()=>{
 assert.equal(safeRecoveryFailure(new RecoveryError('incomplete_source','secret path')).code,'incomplete_source');
 assert.doesNotMatch(safeRecoveryFailure(new Error('private canary path')).message,/canary/);
 assert.equal(safeRecoveryFailure(new RecoveryError('invented','private')).code,'recovery_failed');
});
test('postcommit staging cleanup failure returns saved identity and records separate recoverable debt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-cleanup-'));const c=new Coordinator({dataRoot:root});
 try{
  await c.artifacts.ready;const agent=c.handle({type:'agents.create',name:'Cleanup test',instructions:''}).agents[0],source=join(root,'source.txt');await writeFile(source,'saved');
  const service=c.artifacts as unknown as {removeManaged(path:string):Promise<void>};const original=service.removeManaged.bind(service);let inject=true;service.removeManaged=async path=>{if(inject&&path.startsWith('staging/')){inject=false;throw Error('synthetic failure');}await original(path);};
  const receipt=await c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:agent.id,taskId:null},paths:[source]});
  assert.equal((await c.artifacts.preview({principal:{kind:'owner'},versionId:receipt.versionIds[0]})).text,'saved');
  const db=new DatabaseSync(c.databasePath);assert.equal(Number(db.prepare("SELECT count(*) AS n FROM events WHERE type='artifact.cleanup_pending'").get()!.n),1);db.close();
  await c.artifacts.reconcile();assert.deepEqual(await readdir(join(root,'staging/artifacts')),[]);
 }finally{await c.shutdown();await rm(root,{recursive:true,force:true});}
});
test('staging directory creation failure abandons reservation before same-process retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-reservation-'));const c=new Coordinator({dataRoot:root});
 try{
  await c.artifacts.ready;const stage=join(root,'staging/artifacts');await rm(stage,{recursive:true});await writeFile(stage,'synthetic directory blocker');
  await assert.rejects(c.artifacts.reserveExternal('code-execution',100));
  const db=new DatabaseSync(c.databasePath);assert.equal(Number(db.prepare("SELECT count(*) AS n FROM artifact_operations WHERE state IN ('staging','finalized')").get()!.n),0);db.close();
  await rm(stage);const release=await c.artifacts.reserveExternal('code-execution',100);await release();
 }finally{await c.shutdown();await rm(root,{recursive:true,force:true});}
});
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
test('FIFO backup manifest is rejected promptly by isolated verifier',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-fifo-'));try{
  execFileSync('/usr/bin/mkfifo',[join(root,'backup-manifest.json')]);
  const moduleURL=pathToFileURL(join(process.cwd(),'packages/recovery/index.ts')).href;
  const script=`import {RecoveryService} from ${JSON.stringify(moduleURL)};const service=new RecoveryService({persistence:{dataRoot:process.argv[1],databasePath:process.argv[1]+'/control/agent-workspaces.sqlite'},appVersion:'test',withQuiesced:async f=>f()});try{await service.verifyBackup(process.argv[1]);process.exitCode=1;}catch(e){console.log(e.code);}`;
  const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script,root],{timeout:2000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  assert.match(result.stdout,/invalid_manifest/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('recovery state surfaces older actionable incident before reviewed rows and pages exact stored history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-recovery-page-'));const c=new Coordinator({dataRoot:root});
 try{
  await c.artifacts.ready;const agent=c.handle({type:'agents.create',name:'Recovery history',instructions:''}).agents[0],task=c.handle({type:'tasks.create',agentId:agent.id,objective:'Fixture',completionCriteria:'',scenario:'complete'}).tasks[0];
  const db=new DatabaseSync(c.databasePath);try{
   const insert=db.prepare("INSERT INTO task_recovery_incidents(id,task_id,run_id,operation,code,state,attempts,created_at,updated_at,owner_pid,acknowledged) VALUES (?,?,?,'browser_read','runtime_lost',?,0,?,?,?,?)");
   insert.run('old_actionable',task.id,'synthetic_run','exhausted',1,1,process.pid,0);
   for(let n=0;n<101;n++)insert.run(`reviewed_${String(n).padStart(3,'0')}`,task.id,'synthetic_run','recovered',2,2,process.pid,1);
   const first=c.taskRecovery.handle({type:'taskRecovery.state'});assert.equal(first.needsAttention,1);assert.equal(first.incidents[0].id,'old_actionable');assert.equal(first.page!.hasMore,true);
   const next=c.taskRecovery.handle({type:'taskRecovery.state',beforeIncidentId:first.page!.beforeIncidentId!});assert.equal(next.incidents.length,2);assert.equal(new Set([...first.incidents,...next.incidents].map(i=>i.id)).size,102);
   const exact=c.taskRecovery.handle({type:'taskRecovery.state',incidentId:'reviewed_100'});assert.equal(exact.incidents[0].id,'reviewed_100');
  }finally{db.close();}
 }finally{await c.shutdown();await rm(root,{recursive:true,force:true});}
});
import {pageCommand} from '../../extensions/agent-browser/page.mjs';
test('native page fill rejects readonly input before value mutation or events',()=>{
 const keys=['location','document','MutationObserver','innerWidth','innerHeight','__agentWorkspacesIsolatedWorldV1'];const old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));let events=0;
 const element={tagName:'INPUT',type:'text',readOnly:true,disabled:false,isConnected:true,value:'original',getClientRects:()=>[{}],getAttribute:()=>null,matches:(s:string)=>s.startsWith('input,textarea'),dispatchEvent:()=>{events++;},textContent:''};
 try{
  Object.assign(globalThis,{location:{hostname:'example.com',pathname:'/'},document:{documentElement:{},querySelector:()=>null,querySelectorAll:()=>[element],body:{innerText:'Fixture'},title:'Fixture'},MutationObserver:class{observe(){}disconnect(){}takeRecords(){return[];}},innerWidth:800,innerHeight:600});delete (globalThis as Record<string,unknown>).__agentWorkspacesIsolatedWorldV1;
  const observed=pageCommand({type:'inspect'});const result=pageCommand({type:'fill',documentId:observed.documentId,revision:observed.revision,ref:(observed.targets as {ref:string}[])[0].ref,value:'changed'});
  assert.equal(result.error,'invalid_target');assert.equal(element.value,'original');assert.equal(events,0);
 }finally{for(const k of keys){const descriptor=old.get(k);if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete (globalThis as Record<string,unknown>)[k];}}
});
import {build} from 'esbuild';
test('actual Electron lab runtime shares last-window cleanup and retries failed partition clear',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aw-lab-cleanup-'));try{
  const outfile=join(root,'lab-test.mjs');
  const mock=`import {EventEmitter} from 'node:events';export class BrowserWindow extends EventEmitter{static windows=[];destroyed=false;webContents={on(){},setWindowOpenHandler(){}};constructor(){super();BrowserWindow.windows.push(this);}async loadURL(){}showInactive(){}isDestroyed(){return this.destroyed;}destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('closed');}}export const session={clears:0,failOnce:false,fromPartition(){return{setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(){}},on(){},cookies:{async get(){return[];}},async clearStorageData(){session.clears++;if(session.failOnce){session.failOnce=false;throw Error('synthetic clear failure');}}};}};`;
  await build({stdin:{contents:`export {ElectronLabRuntime} from './apps/desktop/main/lab-browser-runtime';export {BrowserWindow,session} from 'electron';`,resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',plugins:[{name:'mock-electron',setup(builder){builder.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fake'}));builder.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:mock,loader:'js'}));}}]});
  const mod=await import(pathToFileURL(outfile).href) as {ElectronLabRuntime:new(lab:unknown)=>{launch(opts:unknown):Promise<{stop():Promise<void>}>;close():Promise<void>};BrowserWindow:{windows:{destroy():void}[]};session:{clears:number;failOnce:boolean}};
  let exited=0,labClosed=0;const runtime=new mod.ElectronLabRuntime({status:()=>({ready:true,message:null}),close:async()=>{labClosed++;}});
  const first=await runtime.launch({sessionId:'first',agentId:'a',initialGeneration:1,onExit:()=>{exited++;}});mod.BrowserWindow.windows.at(-1)!.destroy();await first.stop();assert.equal(mod.session.clears,1);assert.equal(exited,1);
  const second=await runtime.launch({sessionId:'second',agentId:'a',initialGeneration:1,onExit:()=>{exited++;}});mod.session.failOnce=true;mod.BrowserWindow.windows.at(-1)!.destroy();await new Promise(resolve=>setImmediate(resolve));assert.equal(mod.session.clears,2);await second.stop();assert.equal(mod.session.clears,3);await second.stop();assert.equal(mod.session.clears,3);await runtime.close();assert.equal(labClosed,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
test('actual lab bootstrap treats only optional public404 as absent and keeps session/other failures',async()=>{
 const source=(await readFile(join(process.cwd(),'labs/harbor-desk/public/app.js'),'utf8')).replace('safely(boot)();','globalThis.labBoot=boot;globalThis.labState=state;');
 function harness(sessionStatus:number,publicStatus:number){
  const nodes=new Map<string,{innerHTML:string;disabled?:boolean;onclick?:unknown;textContent?:string}>();const node=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:''});return nodes.get(selector)!;};
  const sandbox:{labBoot?:()=>Promise<void>;labState?:{snapshots:unknown[]};[key:string]:unknown}={document:{querySelector:node},location:{pathname:'/'},fetch:async(url:string)=>({ok:(url==='/api/session'?sessionStatus:publicStatus)===200,status:url==='/api/session'?sessionStatus:publicStatus,json:async()=>url==='/api/session'?{persona:null}:{snapshots:[]}}),setTimeout:()=>1,clearTimeout:()=>{}};
  runInNewContext(source,sandbox);return{sandbox,nodes};
 }
 const optional=harness(200,404);await optional.sandbox.labBoot!();assert.equal(JSON.stringify(optional.sandbox.labState!.snapshots),'[]');assert.match(optional.nodes.get('#root')!.innerHTML,/Start your free workspace/);assert.equal(optional.nodes.get('#public-snapshot')!.disabled,true);
 for(const [session,summary,status] of [[404,200,404],[200,500,500]]){const f=harness(session,summary);await assert.rejects(f.sandbox.labBoot!(),(error:unknown)=>(error as {status:number}).status===status);}
});
