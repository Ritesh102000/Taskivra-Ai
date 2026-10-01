import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {Persistence} from '../../packages/persistence/index';
import {ArtifactService} from '../../packages/artifacts/index';
import {RequestService} from '../../packages/requests/index';
import {fixture,claim,oneFileSpec} from './request-fixture';

for(const point of ['before_validation_commit','after_validation_commit'] as const)test(`SIGKILL ${point} recovers the exact candidate and one continuation receipt`,{timeout:20000},async()=>{
 const f=await fixture();let recovered:RequestService|undefined,artifacts:ArtifactService|undefined,p:Persistence|undefined;
 try{
  const version=await f.put('evidence.txt','required marker: exact immutable evidence');const request=f.requests.createForAgent(claim,oneFileSpec);await f.assign(request,[0],[version]);
  await f.requests.shutdown();f.artifacts.close();await f.artifacts.drain();f.p.close();
  const source=`
    import {Persistence} from ${JSON.stringify(new URL('../../packages/persistence/index.ts',import.meta.url).href)};
    import {ArtifactService} from ${JSON.stringify(new URL('../../packages/artifacts/index.ts',import.meta.url).href)};
    import {RequestService} from ${JSON.stringify(new URL('../../packages/requests/index.ts',import.meta.url).href)};
    const p=new Persistence(process.argv[1],Date.now()),artifacts=new ArtifactService({persistence:p});
    const requests=new RequestService({persistence:p,artifacts,authorize(){throw Error('No main run should be claimed for validation');},autoValidate:false,
      fault(point){if(point===process.argv[2])process.kill(process.pid,'SIGKILL');}});
    await requests.ready;await requests.drainValidations();throw Error('Child did not reach its kill hook');
  `;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',source,f.dataRoot,point],{env:process.env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:1024*1024});
  assert.equal(child.error,undefined,child.stderr);assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(child.status,null,child.stderr);
  p=new Persistence(f.dataRoot,Date.now());const after=point==='after_validation_commit';
  assert.equal(p.db.prepare('SELECT state FROM request_validation_jobs').get()!.state,after?'completed':'running');
  assert.equal(p.db.prepare('SELECT COUNT(*) AS n FROM task_artifacts').get()!.n,after?1:0);
  assert.equal(p.db.prepare('SELECT COUNT(*) AS n FROM resume_receipts').get()!.n,after?1:0);
  artifacts=new ArtifactService({persistence:p});recovered=new RequestService({persistence:p,artifacts,authorize(){throw Error('Main runner must remain unused');},autoValidate:false});await recovered.ready;await recovered.drainValidations();
  const current=recovered.list()[0];assert.equal(current.state,'fulfilled');assert.equal(current.slots[0].candidateVersionId,version);assert.equal(current.slots[0].state,'accepted');
  assert.equal(p.db.prepare('SELECT COUNT(*) AS n FROM resume_receipts').get()!.n,1);assert.equal(p.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='input.fulfilled'").get()!.n,1);assert.equal(p.db.prepare('SELECT COUNT(*) AS n FROM task_artifacts').get()!.n,1);assert.equal(p.db.prepare('SELECT state FROM tasks').get()!.state,'queued');
  assert.equal(p.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n,1);assert.equal(p.db.prepare('SELECT state FROM runs').get()!.state,'waiting');
  assert.equal((await artifacts.preview({principal:{kind:'owner'},versionId:version})).text,'required marker: exact immutable evidence');
  assert.deepEqual(p.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(p.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
 }finally{
  await recovered?.shutdown();if(artifacts){artifacts.close();await artifacts.drain();}p?.close();await rm(f.root,{recursive:true,force:true});
 }
});

test('immediate close before asynchronous readiness never touches a closed database',async()=>{
 const f=await fixture();const pending=new RequestService({persistence:f.p,artifacts:f.artifacts,authorize:f.authorize});pending.close();await f.close();await pending.ready;
});

test('a superseded or expired replan cannot produce a proposal; reply and replan cap survive service replacement',async()=>{
 const f=await fixture();let now=Date.now(),service:RequestService|undefined;try{
  f.requests.createForAgent(claim,oneFileSpec);f.requests.close();service=new RequestService({persistence:f.p,artifacts:f.artifacts,authorize:f.authorize,autoValidate:false,now:()=>now});await service.ready;
  for(let i=0;i<4;i++){
   let request=service.list()[0];await service.handle({type:'requests.reply',requestId:request.id,revision:request.revision,response:`Still unavailable ${i}`});
   const replan=service.claimReplan();if(i===3){assert.equal(replan,null);break;}assert.ok(replan);now+=120001;
   assert.throws(()=>service!.completeReplan(replan,{kind:'keep_blocked',message:'Wait for the data.'}),{code:'stale_replan'});
  }
  assert.equal(f.count('request_owner_replies'),4);assert.equal(f.count('request_replan_jobs'),3);assert.equal(f.count('resume_receipts'),0);assert.equal(service.list()[0].state,'open');assert.equal(f.p.db.prepare('SELECT state FROM tasks').get()!.state,'waiting');
 }finally{await service?.shutdown();await f.close();}
});
