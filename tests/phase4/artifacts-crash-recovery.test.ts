import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Persistence } from '../../packages/persistence/index';
import { ArtifactService } from '../../packages/artifacts/index';

for(const faultPoint of ['after_finalize','after_metadata_commit'] as const)test(`SIGKILL ${faultPoint} reconciles code workspace, receipt and queued owner input without losing the previous output`,{timeout:20000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'aw-phase4-code-death-'));
  let persistence:Persistence|undefined=new Persistence(join(root,'app'),Date.now()),artifacts:ArtifactService|undefined=new ArtifactService({persistence});
  const dataRoot=persistence.dataRoot;
  try{
    await artifacts.ready;
    persistence.transaction(()=>{
      persistence!.db.exec(`
        INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES ('a','A','','a',1);
        INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,generation,created_at,updated_at) VALUES ('t','a','code','running','','complete',1,1,1);
        INSERT INTO runs(id,task_id,agent_id,attempt,worker_id,lease_until,fencing_generation,checkpoint,state,created_at) VALUES ('r','t','a',1,'worker',9999999999999,1,'{}','running',1);
        INSERT INTO tool_calls(id,run_id,generation,tool_name,args_ref,state,idempotency_key,created_at) VALUES ('e1','r',1,'code.execute','{}','dispatched','e1',1);
        INSERT INTO code_executions(id,tool_call_id,image_digest,argv,cwd,limits_json,lifecycle,task_id,agent_id,owner_pid) VALUES ('e1','e1','sha256:test','[]','/workspace','{}','exporting','t','a',${process.pid});
      `);
    });
    const exportRoot=join(dataRoot,'staging','test-code-export');await mkdir(exportRoot);
    const original='Already committed output.\n',candidate='Uncommitted until SQLite receipt.\n';
    const first=join(exportRoot,'first.txt'),second=join(exportRoot,'second.txt'),queued=join(root,'owner-queued.txt');
    await writeFile(first,original);await writeFile(second,candidate);await writeFile(queued,'Owner input arrived during execution.\n');
    const hash=(content:string)=>createHash('sha256').update(content).digest('hex');
    const w1=await artifacts.beginCodeWorkspace({taskId:'t',agentId:'a',executionId:'e1',versionIds:[],assertCurrent:()=>{}});
    const prior=await w1.commit([{path:'outputs/result.txt',sourcePath:first,bytes:Buffer.byteLength(original),sha256:hash(original)}],{assertCurrent:()=>{},onCommit:receipt=>{
      persistence!.db.prepare("UPDATE code_executions SET lifecycle='succeeded',workspace_committed=1,workspace_revision=?,output_version_ids=? WHERE id='e1'").run(receipt.revision,JSON.stringify(receipt.outputVersionIds));
    }});
    const priorVersion=artifacts.all()[0],priorRef=String(persistence.db.prepare('SELECT storage_ref FROM artifact_versions WHERE id=?').get(priorVersion.id)!.storage_ref),priorStat=await stat(join(dataRoot,priorRef));
    persistence.transaction(()=>{
      persistence!.db.exec(`INSERT INTO tool_calls(id,run_id,generation,tool_name,args_ref,state,idempotency_key,created_at) VALUES ('e2','r',1,'code.execute','{}','dispatched','e2',2);
        INSERT INTO code_executions(id,tool_call_id,image_digest,argv,cwd,limits_json,lifecycle,task_id,agent_id) VALUES ('e2','e2','sha256:test','[]','/workspace','{}','exporting','t','a');`);
    });
    artifacts.close();await artifacts.drain();persistence.close();artifacts=undefined;persistence=undefined;
    const childSource=`
      import { Persistence } from ${JSON.stringify(new URL('../../packages/persistence/index.ts',import.meta.url).href)};
      import { ArtifactService } from ${JSON.stringify(new URL('../../packages/artifacts/index.ts',import.meta.url).href)};
      const args=JSON.parse(process.argv[1]),p=new Persistence(args.dataRoot,Date.now());
      let armed=false;
      const a=new ArtifactService({persistence:p,fault(point){if(armed&&point===args.faultPoint)process.kill(process.pid,'SIGKILL');}});
      await a.ready;
      p.db.prepare("UPDATE code_executions SET owner_pid=? WHERE id='e2'").run(process.pid);
      const workspace=await a.beginCodeWorkspace({taskId:'t',agentId:'a',executionId:'e2',versionIds:[],assertCurrent:()=>{}});
      await a.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:'a',taskId:'t'},paths:[args.queued]});
      armed=true;
      await workspace.commit([{path:'outputs/result.txt',sourcePath:args.second,bytes:args.bytes,sha256:args.sha256}],{assertCurrent:()=>{},onCommit(receipt){
        p.db.prepare("UPDATE code_executions SET lifecycle='succeeded',workspace_committed=1,workspace_revision=?,output_version_ids=? WHERE id='e2'").run(receipt.revision,JSON.stringify(receipt.outputVersionIds));
        p.db.prepare("UPDATE tool_calls SET state='succeeded',result_ref=? WHERE id='e2'").run(JSON.stringify(receipt));
      }});
      throw new Error('Unexpectedly survived the SIGKILL hook');
    `;
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',childSource,JSON.stringify({dataRoot,faultPoint,second,queued,bytes:Buffer.byteLength(candidate),sha256:hash(candidate)})],{env:process.env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:1024*1024});
    assert.equal(child.error,undefined,child.stderr);assert.equal(child.status,null,child.stderr);assert.equal(child.signal,'SIGKILL',child.stderr);
    persistence=new Persistence(dataRoot,Date.now());
    const journal=persistence.db.prepare("SELECT state,owner_pid,manifest FROM artifact_operations WHERE kind='code-workspace' ORDER BY rowid DESC LIMIT 1").get()!;
    assert.equal(journal.owner_pid,child.pid);assert.equal(journal.state,faultPoint==='after_finalize'?'finalized':'committed');
    const pending=JSON.parse(String(journal.manifest));assert.equal(await readFile(join(dataRoot,pending.codeRevision.final,'outputs/result.txt'),'utf8'),candidate);
    assert.equal(persistence.db.prepare("SELECT state FROM task_artifact_deliveries").get()!.state,'pending');
    artifacts=new ArtifactService({persistence});await artifacts.ready;
    assert.equal(artifacts.latestCodeRevision('t'),faultPoint==='after_finalize'?1:2);
    const execution=persistence.db.prepare("SELECT workspace_committed,workspace_revision FROM code_executions WHERE id='e2'").get()!;
    assert.equal(execution.workspace_committed,faultPoint==='after_finalize'?0:1);assert.equal(execution.workspace_revision,faultPoint==='after_finalize'?null:2);
    assert.equal(persistence.db.prepare('SELECT COUNT(*) AS n FROM code_workspace_leases').get()!.n,0);
    assert.equal(persistence.db.prepare("SELECT state FROM task_artifact_deliveries").get()!.state,'delivered');
    assert.equal(artifacts.bindings().filter(x=>x.role==='input').length,1);assert.deepEqual(await readdir(join(dataRoot,'staging/artifacts')),[]);
    assert.equal(await readFile(join(dataRoot,priorRef),'utf8'),original);assert.equal((await stat(join(dataRoot,priorRef))).ino,priorStat.ino);
    assert.equal((await artifacts.preview({principal:{kind:'owner'},versionId:prior.outputVersionIds[0]})).text,original);
    if(faultPoint==='after_finalize'){
      assert.equal(artifacts.bindings().filter(x=>x.role==='output').length,1);
      for(const final of pending.finals)await assert.rejects(stat(join(dataRoot,final)),{code:'ENOENT'});
    }else{
      assert.equal(artifacts.bindings().filter(x=>x.role==='output').length,2);
      assert.equal(persistence.db.prepare("SELECT state FROM tool_calls WHERE id='e2'").get()!.state,'succeeded');
    }
    assert.deepEqual(persistence.db.prepare('PRAGMA foreign_key_check').all(),[]);
    await artifacts.reconcile();assert.equal(artifacts.bindings().filter(x=>x.role==='input').length,1);
  }finally{
    if(artifacts){artifacts.close();await artifacts.drain();}persistence?.close();await rm(root,{recursive:true,force:true});
  }
});
