import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Persistence } from '../../packages/persistence/index';
import { ArtifactService, ArtifactError, type ArtifactFaultPoint } from '../../packages/artifacts/index';
import type { CodeWorkspaceReceipt } from '../../packages/artifacts/code';
import type { CodeExportFile } from '../../packages/code/runtime';

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function workspaceFixture(fault?:(point:ArtifactFaultPoint)=>void){
  const root=await mkdtemp(join(tmpdir(),'aw-phase4-artifacts-'));
  const p=new Persistence(join(root,'app'),Date.now()),dataRoot=p.dataRoot,a=new ArtifactService({persistence:p,fault});await a.ready;
  p.transaction(()=>{
    for(const agentId of ['agent-a','agent-b'])p.db.prepare("INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES (?,?,'',?,?)").run(agentId,agentId,agentId,Date.now());
    p.db.prepare("INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,generation,created_at,updated_at) VALUES ('task-a','agent-a','code','running','','complete',1,?,?)").run(Date.now(),Date.now());
    p.db.prepare("INSERT INTO runs(id,task_id,agent_id,attempt,worker_id,lease_until,fencing_generation,checkpoint,state,created_at) VALUES ('run-a','task-a','agent-a',1,'worker',?,1,'{}','running',?)").run(Date.now()+3600000,Date.now());
  });
  const execution=(id=randomUUID())=>{p.transaction(()=>{
    p.db.prepare("INSERT INTO tool_calls(id,run_id,generation,tool_name,args_ref,state,idempotency_key,created_at) VALUES (?,'run-a',1,'code.execute','{}','dispatched',?,?)").run(id,id,Date.now());
    p.db.prepare("INSERT INTO code_executions(id,tool_call_id,image_digest,argv,cwd,limits_json,lifecycle,task_id,agent_id,owner_instance,owner_pid) VALUES (?,?,'sha256:test','[]','/workspace','{}','exporting','task-a','agent-a','fixture',?)").run(id,id,process.pid);
  });return id;};
  const source=async(name:string,content:string|Buffer)=>{const path=join(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,content);return path;};
  const exported=async(entries:Record<string,string|Buffer>):Promise<CodeExportFile[]>=>{const stage=join(dataRoot,'staging',`test-export-${randomUUID()}`);await mkdir(stage);const files=[];
    for(const [path,content]of Object.entries(entries)){const sourcePath=join(stage,path);await mkdir(dirname(sourcePath),{recursive:true});await writeFile(sourcePath,content);files.push({path,sourcePath,bytes:Buffer.byteLength(content),sha256:hash(content)});}return files;};
  const current=()=>{const row=p.db.prepare("SELECT generation,state FROM tasks WHERE id='task-a'").get()!;if(row.generation!==1||row.state!=='running')throw new ArtifactError('stale_workspace','Task fenced.');};
  const begin=(executionId:string,versionIds:string[]=[])=>a.beginCodeWorkspace({taskId:'task-a',agentId:'agent-a',executionId,versionIds,assertCurrent:current});
  const commit=(executionId:string)=>(receipt:CodeWorkspaceReceipt)=>{p.db.prepare("UPDATE code_executions SET lifecycle='succeeded',workspace_committed=1,workspace_revision=?,output_version_ids=? WHERE id=?").run(receipt.revision,JSON.stringify(receipt.outputVersionIds),executionId);};
  const input=async(name:string,content:string,scope:'private'|'shared'='private',agentId='agent-a')=>(await a.importFiles({principal:{kind:'owner'},target:{scope,agentId,taskId:agentId==='agent-a'?'task-a':null},paths:[await source(name,content)]})).versionIds[0];
  const close=async()=>{a.close();await a.drain();p.close();await rm(root,{recursive:true,force:true});};
  return{root,dataRoot,p,a,execution,source,exported,current,begin,commit,input,close};
}

test('code revisions preserve work and outputs, replace deletions, and pin only selected private/shared inputs',async()=>{
  const f=await workspaceFixture();try{
    const privateId=await f.input('private.txt','private'),sharedId=await f.input('shared.csv','value\n1\n','shared'),unselected=await f.input('unselected.txt','exclude');
    const e1=f.execution(),w1=await f.begin(e1,[privateId,sharedId]);
    assert.equal(w1.baseRevision,null);assert.equal(w1.baseRevisionNumber,0);assert.equal(w1.files.length,2);
    assert.deepEqual(w1.files.map(x=>x.area),['workspace','shared']);assert.ok(w1.files.every(x=>!x.sourcePath.includes(unselected)));
    assert.equal(w1.inputs[0].containerPath,`/workspace/inputs/${privateId}/content.txt`);assert.equal(w1.inputs[1].containerPath,`/shared/${sharedId}/content.csv`);
    const r1=await w1.commit(await f.exported({'inputs/modified.txt':'mutable working copy','work/state.bin':'state','work/deleted.txt':'remove later','outputs/report.txt':'result'}),{assertCurrent:f.current,onCommit:f.commit(e1)});
    assert.equal(r1.revision,1);assert.equal(f.a.latestCodeRevision('task-a'),1);assert.equal(r1.outputVersionIds.length,1);
    const output=f.a.all().find(x=>x.id===r1.outputVersionIds[0])!;
    assert.equal(output.visibility,'private');assert.deepEqual(output.codeSource,{executionId:e1,inputVersionIds:[privateId,sharedId]});
    assert.equal(f.a.bindings().find(x=>x.versionId===output.id)?.role,'output');assert.equal(f.a.all().filter(x=>x.visibility==='shared').length,1);
    const e2=f.execution(),w2=await f.begin(e2,[privateId]);assert.equal(w2.baseRevision,r1.revisionId);assert.equal(w2.baseRevisionNumber,1);
    assert.deepEqual(w2.files.filter(x=>x.area==='workspace').map(x=>x.path).sort(),[`inputs/${privateId}/content.txt`,'outputs/report.txt','work/deleted.txt','work/state.bin'].sort());
    await w2.commit(await f.exported({'work/state.bin':'next','outputs/report.txt':'next result'}),{assertCurrent:f.current,onCommit:f.commit(e2)});
    const e3=f.execution(),w3=await f.begin(e3);assert.deepEqual(w3.files.map(x=>x.path).sort(),['outputs/report.txt','work/state.bin']);
    assert.equal(await readFile(w3.files.find(x=>x.path==='work/state.bin')!.sourcePath,'utf8'),'next');await w3.release();
    assert.equal((await f.a.preview({principal:{kind:'owner'},versionId:output.id})).text,'result');
  }finally{await f.close();}
});

test('owner imports during a job commit private bytes and defer task delivery until commit or release',async()=>{
  const f=await workspaceFixture();try{
    const old=await f.input('old.txt','old'),e=f.execution(),workspace=await f.begin(e,[old]);
    const oldSnapshot=f.a.snapshots().at(-1)!.id;
    const imported=await f.a.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:'agent-a',taskId:'task-a'},paths:[await f.source('new.txt','new')]});
    assert.equal(imported.deliveryDeferred,true);const pending=imported.versionIds[0];
    assert.ok(f.a.all().some(x=>x.id===pending));assert.ok(!f.a.bindings().some(x=>x.versionId===pending));assert.equal(f.a.snapshots().at(-1)!.id,oldSnapshot);
    assert.deepEqual(workspace.inputs.map(x=>x.versionId),[old]);assert.throws(()=>f.a.codeInputManifest('task-a',[pending]),ArtifactError);
    await workspace.commit(await f.exported({'work/state.bin':'done'}),{assertCurrent:f.current,onCommit:f.commit(e)});
    assert.ok(f.a.bindings().some(x=>x.versionId===pending));assert.notEqual(f.a.snapshots().at(-1)!.id,oldSnapshot);
    assert.equal(f.p.db.prepare("SELECT state FROM task_artifact_deliveries WHERE version_id=?").get(pending)!.state,'delivered');
    const e2=f.execution(),w2=await f.begin(e2),releasedInput=await f.input('on-abort.txt','retain');
    await w2.release();assert.ok(f.a.bindings().some(x=>x.versionId===releasedInput));assert.equal(f.a.latestCodeRevision('task-a'),1);
  }finally{await f.close();}
});

test('durable lease rejects a competing service and selected inputs cannot cross agent scope',async()=>{
  const f=await workspaceFixture();let second:ArtifactService|undefined;try{
    const foreign=await f.input('foreign.txt','private','private','agent-b'),e=f.execution();
    await assert.rejects(f.begin(e,[foreign]),ArtifactError);
    const w=await f.begin(e);second=new ArtifactService({persistence:f.p});await second.ready;
    await assert.rejects(second.beginCodeWorkspace({taskId:'task-a',agentId:'agent-a',executionId:e,versionIds:[],assertCurrent:f.current}),cause=>cause instanceof ArtifactError&&cause.code==='workspace_busy');
    assert.equal(f.p.db.prepare('SELECT owner_id FROM code_workspace_leases').get()!.owner_id,f.a.instanceId);await w.release();
  }finally{if(second){second.close();await second.drain();}await f.close();}
});

test('task fencing after file finalization refuses the complete metadata commit',async()=>{
  let armed=false;const f=await workspaceFixture(point=>{if(armed&&point==='after_finalize')f.p.db.prepare("UPDATE tasks SET generation=2,state='paused' WHERE id='task-a'").run();});try{
    const e=f.execution(),w=await f.begin(e);armed=true;
    await assert.rejects(w.commit(await f.exported({'work/state.bin':'state','outputs/a.txt':'uncommitted'}),{assertCurrent:f.current,onCommit:f.commit(e)}),ArtifactError);
    assert.equal(f.a.latestCodeRevision('task-a'),0);assert.equal(f.a.all().length,0);assert.equal(f.p.db.prepare('SELECT workspace_committed FROM code_executions').get()!.workspace_committed,0);
    armed=false;await w.release();await f.a.reconcile();assert.deepEqual(await readdir(join(f.dataRoot,'staging/artifacts')),[]);
  }finally{await f.close();}
});

test('receipt callback failure rolls back artifacts, output bindings, head and authoritative execution state together',async()=>{
  const f=await workspaceFixture();try{
    const e=f.execution(),w=await f.begin(e);
    await assert.rejects(w.commit(await f.exported({'outputs/a.txt':'result'}),{assertCurrent:f.current,onCommit:receipt=>{f.commit(e)(receipt);throw new Error('transaction fault');}}),ArtifactError);
    assert.equal(f.a.all().length,0);assert.equal(f.a.bindings().length,0);assert.equal(f.a.latestCodeRevision('task-a'),0);
    assert.equal(f.p.db.prepare('SELECT lifecycle,workspace_committed FROM code_executions').get()!.lifecycle,'exporting');
    assert.equal(f.p.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='workspace.code_committed'").get()!.n,0);await w.release();await f.a.reconcile();
  }finally{await f.close();}
});

test('hash, traversal, duplicate normalized path, file-directory collision and supported format masquerade cannot commit',async()=>{
  const f=await workspaceFixture();try{
    const e=f.execution(),w=await f.begin(e),base=(await f.exported({'outputs/good.txt':'good'}))[0];
    for(const files of [
      [{...base,sha256:'a'.repeat(64)}],[{...base,path:'outputs/../control/key'}],
      [base,{...base,path:'outputs/GOOD.txt'}],[{...base,path:'outputs/a'},{...base,path:'outputs/a/b'}],
      [{...base,path:'outputs/not-a-png.png'}],[{...base,bytes:100*1024*1024+1}],
    ])await assert.rejects(w.commit(files,{assertCurrent:f.current,onCommit:f.commit(e)}),ArtifactError);
    const outside=await f.source('external.txt','good'),unsafe=join(f.dataRoot,'staging','link.txt');await symlink(outside,unsafe);
    await assert.rejects(w.commit([{...base,sourcePath:unsafe}],{assertCurrent:f.current}),ArtifactError);
    await rm(unsafe);await link(base.sourcePath,unsafe);await assert.rejects(w.commit([base],{assertCurrent:f.current}),ArtifactError);await rm(unsafe);
    assert.equal(f.a.all().length,0);assert.equal(f.a.latestCodeRevision('task-a'),0);await w.release();
  }finally{await f.close();}
});

test('storage budget includes existing bytes and both immutable workspace and output copies',async()=>{
  const f=await workspaceFixture();try{
    await f.a.updateBudget(64*1024*1024);const e=f.execution(),w=await f.begin(e),files=await f.exported({'outputs/large.bin':Buffer.alloc(18*1024*1024,7)});
    await assert.rejects(w.commit(files,{assertCurrent:f.current,onCommit:f.commit(e)}),cause=>cause instanceof ArtifactError&&cause.code==='storage_full');
    assert.equal(f.a.all().length,0);assert.equal(f.a.latestCodeRevision('task-a'),0);await w.release();
  }finally{await f.close();}
});

test('corrupt committed workspace blocks another execution while immutable output artifact remains readable',async()=>{
  const f=await workspaceFixture();try{
    const e=f.execution(),w=await f.begin(e),receipt=await w.commit(await f.exported({'work/state.bin':'state','outputs/a.txt':'result'}),{assertCurrent:f.current,onCommit:f.commit(e)});
    const row=f.p.db.prepare('SELECT storage_ref FROM code_workspace_revisions WHERE id=?').get(receipt.revisionId)!;
    const path=join(f.dataRoot,String(row.storage_ref),'work/state.bin');await chmod(path,0o600);await writeFile(path,'tampered');await f.a.reconcile();
    assert.equal(f.p.db.prepare('SELECT status FROM code_workspace_revisions').get()!.status,'corrupt');
    await assert.rejects(f.begin(f.execution()),ArtifactError);assert.equal((await f.a.preview({principal:{kind:'owner'},versionId:receipt.outputVersionIds[0]})).text,'result');
  }finally{await f.close();}
});
