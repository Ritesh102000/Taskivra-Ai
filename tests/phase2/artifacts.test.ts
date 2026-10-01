import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod, unlink, symlink, link, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { Coordinator } from '../../packages/coordinator/index';
import { ArtifactError, FILE_LIMITS } from '../../packages/artifacts/index';
import type { ArtifactFaultPoint, Principal } from '../../packages/artifacts/index';
import { SCHEMA_VERSION } from '../../packages/persistence/index';

const owner:Principal={kind:'owner'};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'aw-phase2-artifacts-')),dataRoot=join(root,'app'),instances:Coordinator[]=[];
  const create=async(fault?:(point:ArtifactFaultPoint)=>void)=>{const c=new Coordinator({dataRoot,artifactFault:fault});instances.push(c);await c.artifacts.ready;return c;};
  const source=async(name:string,content:string|Buffer)=>{const path=join(root,name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,content);return path;};
  return{root,dataRoot,create,source,close:async()=>{for(const c of instances){c.close();await c.artifacts.drain();}await rm(root,{recursive:true,force:true});}};
}
function agent(c:Coordinator,name='A'){const known=new Set(c.snapshot().agents.map(a=>a.id));return c.handle({type:'agents.create',name,instructions:''}).agents.find(a=>!known.has(a.id))!;}
function task(c:Coordinator,agentId:string){const known=new Set(c.snapshot().tasks.map(t=>t.id));return c.handle({type:'tasks.create',agentId,objective:'Use the selected files',completionCriteria:'',scenario:'complete'}).tasks.find(t=>!known.has(t.id))!;}
function expected(code:string){return(cause:unknown)=>cause instanceof ArtifactError&&cause.code===code;}
function db(c:Coordinator){return new DatabaseSync(c.databasePath);}
async function imported(c:Coordinator,path:string,agentId:string,taskId:string|null=null){return(await c.artifacts.importFiles({principal:owner,target:{scope:'private',agentId,taskId},paths:[path]})).versionIds[0];}

test('same-name imports remain distinct immutable files and task snapshots pin exact hashes',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),t=task(c,a.id);const first=await f.source('one/report.csv','period,value\nold,1\n'),second=await f.source('two/report.csv','period,value\nnew,2\n');
    const {versionIds}=await c.artifacts.importFiles({principal:owner,target:{scope:'private',agentId:a.id,taskId:t.id},paths:[first,second]});
    assert.equal(new Set(versionIds).size,2);const versions=c.snapshot().artifacts;assert.equal(versions.length,2);assert.notEqual(versions[0].artifactId,versions[1].artifactId);assert.notEqual(versions[0].sha256,versions[1].sha256);
    assert.ok(versions.every(v=>v.displayName==='report.csv'&&v.status==='ready'&&v.visibility==='private'));
    assert.equal(c.snapshot().taskArtifacts.length,2);assert.equal(c.snapshot().workspaceSnapshots[0].fileCount,2);
    const connection=db(c);try{for(const row of connection.prepare('SELECT storage_ref FROM artifact_versions').all()){const stat=await import('node:fs/promises').then(fs=>fs.stat(join(c.dataRoot,String(row.storage_ref))));assert.equal(stat.mode&0o222,0);}}finally{connection.close();}
    assert.match((await c.artifacts.preview({principal:{kind:'agent',agentId:a.id},versionId:versionIds[0]})).text!,/old,1/);
  }finally{await f.close();}
});

test('private reads, guessed IDs, cross-agent snapshots and handoff require scope checks',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),b=agent(c,'B'),ta=task(c,a.id),tb=task(c,b.id),path=await f.source('secret.txt','private content');const versionId=await imported(c,path,a.id,ta.id);
    assert.throws(()=>c.artifacts.getForAgent(b.id,versionId),expected('permission_denied'));
    await assert.rejects(c.artifacts.preview({principal:{kind:'agent',agentId:b.id},versionId}),expected('permission_denied'));
    await assert.rejects(c.artifacts.preview({principal:{kind:'agent',agentId:a.id},versionId:'../../control'}),expected('not_found'));
    await assert.rejects(c.artifacts.useInTask({principal:owner,taskId:tb.id,versionId}),expected('permission_denied'));
    await assert.rejects(c.artifacts.createSnapshot({principal:{kind:'agent',agentId:b.id},taskId:ta.id}),expected('permission_denied'));
    await assert.rejects(c.artifacts.publish({principal:{kind:'agent',agentId:a.id},versionId}),expected('permission_denied'));
    await assert.rejects(c.artifacts.importFiles({principal:{kind:'agent',agentId:a.id},target:{scope:'private',agentId:a.id,taskId:null},paths:[path]}),expected('permission_denied'));
    assert.equal(c.snapshot().taskArtifacts.filter(v=>v.taskId===tb.id).length,0);
  }finally{await f.close();}
});

test('publication groups private versions, preserves originals and active run input bindings',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),b=agent(c,'B'),t=task(c,b.id),path=await f.source('data.csv','value\n1\n');const privateV1=await imported(c,path,a.id);
    const sharedV1=(await c.artifacts.publish({principal:owner,versionId:privateV1})).versionIds[0];
    assert.deepEqual(await c.artifacts.publish({principal:owner,versionId:privateV1}),{versionIds:[sharedV1]});
    await c.artifacts.useInTask({principal:{kind:'agent',agentId:b.id},taskId:t.id,versionId:sharedV1});const claim=c.claimNext()!;
    await writeFile(path,'value\n2\n');const privateArtifact=c.snapshot().artifacts.find(v=>v.id===privateV1)!.artifactId;
    const privateV2=(await c.artifacts.importFiles({principal:owner,target:{scope:'private',agentId:a.id,taskId:null},paths:[path],artifactId:privateArtifact})).versionIds[0];
    const sharedV2=(await c.artifacts.publish({principal:owner,versionId:privateV2})).versionIds[0],versions=c.snapshot().artifacts;
    assert.equal(versions.find(v=>v.id===sharedV1)!.artifactId,versions.find(v=>v.id===sharedV2)!.artifactId);
    assert.equal(versions.find(v=>v.id===sharedV2)!.version,2);assert.equal(versions.find(v=>v.id===sharedV2)!.sourceVersionId,privateV2);
    assert.match((await c.artifacts.preview({principal:owner,versionId:privateV1})).text!,/1/);
    assert.equal(c.snapshot().taskArtifacts.some(v=>v.taskId===t.id&&v.versionId===sharedV2),false);
    await c.artifacts.useInTask({principal:owner,taskId:t.id,versionId:sharedV2});
    const connection=db(c);try{assert.deepEqual(connection.prepare('SELECT version_id FROM run_artifact_bindings WHERE run_id=?').all(claim.runId).map(v=>v.version_id),[sharedV1]);}finally{connection.close();}
    assert.match((await c.artifacts.preview({principal:{kind:'agent',agentId:b.id},versionId:sharedV1})).text!,/1/);
  }finally{await f.close();}
});

test('shared-library Add version preserves publication owner and producer metadata',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),t=task(c,a.id),path=await f.source('shared.txt','one');const original=await imported(c,path,a.id,t.id),published=(await c.artifacts.publish({principal:owner,versionId:original})).versionIds[0],v1=c.snapshot().artifacts.find(v=>v.id===published)!;
    await writeFile(path,'two');const v2id=(await c.artifacts.importFiles({principal:owner,target:{scope:'shared',agentId:null,taskId:null},artifactId:v1.artifactId,paths:[path]})).versionIds[0],v2=c.snapshot().artifacts.find(v=>v.id===v2id)!;
    assert.equal(v2.version,2);assert.equal(v2.ownerAgentId,a.id);assert.equal(v2.producerTaskId,t.id);assert.equal(v2.visibility,'shared');assert.match((await c.artifacts.preview({principal:owner,versionId:published})).text!,/one/);
  }finally{await f.close();}
});

test('empty, unknown binary and large text previews are safe and bounded',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),empty=await imported(c,await f.source('empty.txt',''),a.id),binary=await imported(c,await f.source('unknown.bin',Buffer.from([0,1,2,3,255])),a.id),text=await imported(c,await f.source('large.txt','a'.repeat(100_000)),a.id);
    assert.equal((await c.artifacts.preview({principal:owner,versionId:empty})).text,'');
    assert.equal((await c.artifacts.preview({principal:owner,versionId:binary})).text,null);
    const preview=await c.artifacts.preview({principal:owner,versionId:text});assert.equal(preview.truncated,true);assert.ok(Buffer.byteLength(preview.text!)<=65536);
  }finally{await f.close();}
});

test('a rejected batch exposes no completed artifacts, bindings or snapshots',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),t=task(c,a.id),good=await f.source('good.txt','good'),bad=await f.source('bad.png','this is text');
    await assert.rejects(c.artifacts.importFiles({principal:owner,target:{scope:'private',agentId:a.id,taskId:t.id},paths:[good,bad]}),ArtifactError);
    assert.equal(c.snapshot().artifacts.length,0);assert.equal(c.snapshot().taskArtifacts.length,0);assert.equal(c.snapshot().workspaceSnapshots.length,0);
    c.close();await c.artifacts.drain();const reopened=await f.create();assert.equal(reopened.snapshot().artifacts.length,0);assert.deepEqual(await readdir(join(reopened.dataRoot,'staging/artifacts')),[]);
  }finally{await f.close();}
});

for(const faultPoint of ['after_stage','after_finalize','before_metadata_commit'] as const)test(`restart cleans ${faultPoint} without fabricating a committed version`,async()=>{
  const f=await fixture();try{let armed=true;const c=await f.create(point=>{if(armed&&point===faultPoint)throw new Error('injected crash');}),a=agent(c),t=task(c,a.id),path=await f.source('crash.csv','a\n1\n');
    await assert.rejects(c.artifacts.importFiles({principal:owner,target:{scope:'private',agentId:a.id,taskId:t.id},paths:[path]}),ArtifactError);
    assert.equal(c.snapshot().artifacts.length,0);assert.equal(c.snapshot().workspaceSnapshots.length,0);armed=false;c.close();await c.artifacts.drain();const reopened=await f.create();
    assert.equal(reopened.snapshot().artifacts.length,0);assert.deepEqual(await readdir(join(reopened.dataRoot,'staging/artifacts')),[]);
    const connection=db(reopened);try{assert.ok(connection.prepare("SELECT state FROM artifact_operations").all().every(row=>row.state==='abandoned'));}finally{connection.close();}
    await imported(reopened,path,a.id,t.id);assert.equal(reopened.snapshot().artifacts[0].status,'ready');
  }finally{await f.close();}
});

test('a crash after metadata commit preserves the real committed bytes on reopen',async()=>{
  const f=await fixture();try{const c=await f.create(point=>{if(point==='after_metadata_commit')throw new Error('crash after commit');}),a=agent(c),path=await f.source('committed.txt','persisted');
    await assert.rejects(imported(c,path,a.id),ArtifactError);const version=c.snapshot().artifacts[0];assert.equal(version.status,'ready');c.close();await c.artifacts.drain();const reopened=await f.create();
    assert.equal(reopened.snapshot().artifacts[0].id,version.id);assert.equal((await reopened.artifacts.preview({principal:owner,versionId:version.id})).text,'persisted');assert.deepEqual(await readdir(join(reopened.dataRoot,'staging/artifacts')),[]);
  }finally{await f.close();}
});

test('normal committed-stage cleanup is idempotent across repeated reopening',async()=>{
  const f=await fixture();try{let c=await f.create();const a=agent(c),version=await imported(c,await f.source('reopen.txt','saved'),a.id);for(let n=0;n<3;n++){c.close();await c.artifacts.drain();c=await f.create();assert.equal((await c.artifacts.preview({principal:owner,versionId:version})).text,'saved');}}finally{await f.close();}
});

test('missing, corrupt and symlinked managed bytes are detected without reading a target outside storage',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),v1=await imported(c,await f.source('missing.txt','missing'),a.id),v2=await imported(c,await f.source('corrupt.txt','original'),a.id),v3=await imported(c,await f.source('link.txt','link'),a.id),connection=db(c);
    let paths:Record<string,string>={};try{for(const row of connection.prepare('SELECT id,storage_ref FROM artifact_versions').all())paths[String(row.id)]=join(c.dataRoot,String(row.storage_ref));}finally{connection.close();}
    await unlink(paths[v1]);await chmod(paths[v2],0o600);await writeFile(paths[v2],'tampered');await unlink(paths[v3]);await symlink(await f.source('outside-secret.txt','must not read'),paths[v3]);
    c.close();await c.artifacts.drain();const reopened=await f.create(),versions=reopened.snapshot().artifacts;
    assert.equal(versions.find(v=>v.id===v1)!.status,'missing');assert.equal(versions.find(v=>v.id===v2)!.status,'corrupt');assert.equal(versions.find(v=>v.id===v3)!.status,'corrupt');
    await assert.rejects(reopened.artifacts.preview({principal:owner,versionId:v3}),expected('integrity_error'));
  }finally{await f.close();}
});

test('file and batch limits reject sparse oversized files before copying',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c);const big=await f.source('huge.bin',''),handle=await open(big,'r+');await handle.truncate(FILE_LIMITS.file+1);await handle.close();
    await assert.rejects(imported(c,big,a.id),expected('limit_exceeded'));
    const paths=[];for(let n=0;n<3;n++){const path=await f.source(`batch-${n}.bin`,''),file=await open(path,'r+');await file.truncate(90*1024*1024);await file.close();paths.push(path);}
    await assert.rejects(c.artifacts.importFiles({principal:owner,target:{scope:'private',agentId:a.id,taskId:null},paths}),expected('limit_exceeded'));assert.equal(c.snapshot().artifacts.length,0);
  }finally{await f.close();}
});

test('budget counts pre-existing staging and snapshots, not just artifact metadata',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),t=task(c,a.id),version=await imported(c,await f.source('budget.txt','x'.repeat(10000)),a.id,t.id);await c.artifacts.updateBudget(64*1024*1024);
    const before=c.snapshot().storage.usedBytes;assert.ok(before>20000);
    const pending=join(c.dataRoot,'staging','owner-large-staging.bin'),file=await open(pending,'wx');await file.truncate(63*1024*1024);await file.close();
    await assert.rejects(imported(c,await f.source('too-much.txt','additional'),a.id),expected('storage_full'));assert.equal(c.snapshot().artifacts.length,1);
    await unlink(pending);await c.artifacts.reconcile();assert.equal((await c.artifacts.preview({principal:owner,versionId:version})).text!.length,10000);
  }finally{await f.close();}
});

test('exports require owner identity, preserve existing destinations, and verify exact bytes',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),versionId=await imported(c,await f.source('export.txt','exact bytes'),a.id),destination=join(f.root,'exported.txt');
    await assert.rejects(c.artifacts.exportFile({principal:{kind:'agent',agentId:a.id},versionId,destination}),expected('permission_denied'));
    await c.artifacts.exportFile({principal:owner,versionId,destination});assert.equal(await readFile(destination,'utf8'),'exact bytes');
    await assert.rejects(c.artifacts.exportFile({principal:owner,versionId,destination}),expected('destination_exists'));assert.equal(await readFile(destination,'utf8'),'exact bytes');
    const connection=db(c);try{
      const operations=connection.prepare("SELECT state,reserved_bytes,manifest FROM artifact_operations WHERE kind='export' ORDER BY rowid").all();
      assert.equal(operations[0].state,'committed');assert.equal(operations[0].reserved_bytes,0);
      assert.equal(operations[1].state,'abandoned');assert.equal(operations[1].reserved_bytes,0);
      for(const operation of operations){const manifest=JSON.parse(String(operation.manifest));assert.deepEqual(manifest.finals,[]);assert.equal(String(operation.manifest).includes(destination),false);}
    }finally{connection.close();}
  }finally{await f.close();}
});

test('export temporary bytes must fit the shared storage reservation before any external write',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),versionId=await imported(c,await f.source('export-budget.bin',Buffer.alloc(8*1024*1024,7)),a.id),destination=join(f.root,'budget-export.bin');
    await c.artifacts.updateBudget(64*1024*1024);
    const pending=join(c.dataRoot,'staging','other-pending.bin'),file=await open(pending,'wx');await file.truncate(35*1024*1024);await file.close();
    await assert.rejects(c.artifacts.exportFile({principal:owner,versionId,destination}),expected('storage_full'));
    await assert.rejects(readFile(destination),{code:'ENOENT'});assert.equal((await readdir(f.root)).some(name=>name.startsWith('.agent-workspaces-export-')),false);
    await unlink(pending);await c.artifacts.exportFile({principal:owner,versionId,destination});assert.equal((await readFile(destination)).length,8*1024*1024);
  }finally{await f.close();}
});

for(const mutation of ['symlink','hardlink','oversized'] as const)test(`snapshot manifest ${mutation} fails integrity checks even when its directory is valid`,async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),t=task(c,a.id);await imported(c,await f.source('snapshot.txt','pinned'),a.id,t.id);
    const connection=db(c);let manifestPath:string;try{manifestPath=join(c.dataRoot,String(connection.prepare('SELECT storage_ref FROM workspace_snapshots').get()!.storage_ref),'manifest.json');}finally{connection.close();}
    const trusted=await readFile(manifestPath),outside=await f.source('external-manifest.json',trusted);await unlink(manifestPath);
    if(mutation==='symlink')await symlink(outside,manifestPath);else if(mutation==='hardlink')await link(outside,manifestPath);else{const file=await open(manifestPath,'wx');await file.truncate(3*1024*1024);await file.close();}
    c.close();await c.artifacts.drain();const reopened=await f.create();assert.equal(reopened.snapshot().workspaceSnapshots.length,0);assert.equal(reopened.snapshot().artifacts[0].status,'ready');assert.deepEqual(await readFile(outside),trusted);
    const check=db(reopened);try{assert.equal(check.prepare('SELECT status FROM workspace_snapshots').get()!.status,'corrupt');}finally{check.close();}
  }finally{await f.close();}
});

test('format limits identify the JSON bound separately from ordinary file limits',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c),path=await f.source('oversized.json',JSON.stringify('x'.repeat(1024*1024)));
    await assert.rejects(imported(c,path,a.id),(cause:unknown)=>cause instanceof ArtifactError&&cause.code==='format_limit'&&/1 MiB/.test(cause.message));assert.equal(c.snapshot().artifacts.length,0);
  }finally{await f.close();}
});

test('second live service does not reconcile an active owner operation away',async()=>{
  const f=await fixture();try{let other:Coordinator|undefined;const c=await f.create(point=>{if(point==='after_stage'&&!other)other=new Coordinator({dataRoot:f.dataRoot});}),a=agent(c),version=await imported(c,await f.source('live.txt','still active'),a.id);assert.ok(other);await other!.artifacts.ready;assert.equal((await other!.artifacts.preview({principal:owner,versionId:version})).text,'still active');other!.close();await other!.artifacts.drain();}finally{await f.close();}
});

test('Phase 2 migration preserves Phase 1 agents, tasks, messages and waiting checkpoint',async()=>{
  const f=await fixture();try{const c=await f.create(),a=agent(c);const t=c.handle({type:'tasks.create',agentId:a.id,objective:'Wait before migration',completionCriteria:'',scenario:'clarification'}).tasks[0];for(let n=0;n<3;n++)c.tick();const before=c.snapshot();assert.equal(before.tasks[0].state,'waiting');c.close();await c.artifacts.drain();
    const connection=db(c);try{
      connection.exec('PRAGMA foreign_keys=OFF');for(const row of connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'project_%'").all())connection.exec('DROP TRIGGER '+String(row.name));for(const name of ['fleet_messages','fleet_plan_revisions','fleet_tasks','fleet_items','fleet_members','fleet_runs','security_review_handoffs','security_review_members','security_review_teams','task_recovery_incidents','routine_change_alerts','routine_result_comparisons','routine_alert_settings','browser_action_proposals','project_briefs','project_gmail_accounts','project_google_workspace_accounts','project_artifacts','project_agents','projects','owner_notices','notice_settings','routine_preparation_claims','routine_occurrences','routines','result_actions','result_revision_jobs','result_reviews','workflow_input_assignments'])connection.exec('DROP TABLE IF EXISTS '+name);
      connection.exec(`PRAGMA foreign_keys=OFF;
        DROP TABLE workflow_task_origins; DROP TABLE workflow_receipts; DROP TABLE saved_workflows;
        DROP INDEX task_message_delivery;
        ALTER TABLE task_messages DROP COLUMN delivery_state; ALTER TABLE task_messages DROP COLUMN incorporated_at;
        DROP TABLE collaboration_dependency_status; DROP TABLE collaboration_consumptions;
        DROP TABLE collaboration_publications; DROP TABLE collaboration_policies;
        DROP INDEX collaboration_message_once; DROP INDEX collaboration_inbox;
        ALTER TABLE agent_messages DROP COLUMN source_task_id; ALTER TABLE agent_messages DROP COLUMN origin;
        ALTER TABLE agent_messages DROP COLUMN kind; ALTER TABLE agent_messages DROP COLUMN idempotency_key;
        ALTER TABLE agent_messages DROP COLUMN payload_hash; ALTER TABLE agent_messages DROP COLUMN read_at;
        DROP TABLE gmail_connection_requests; DROP TABLE live_tool_receipts; DROP TABLE live_history; DROP TABLE live_model_calls; DROP TABLE live_task_config;
        ALTER TABLE tasks DROP COLUMN execution_mode;
        DROP TABLE request_capability_grants; DROP TABLE request_replan_jobs; DROP TABLE request_owner_replies;
        DROP TABLE request_validation_jobs; DROP TABLE slot_candidates; DROP TABLE request_details;
        ALTER TABLE request_slots DROP COLUMN label; ALTER TABLE request_slots DROP COLUMN explanation;
        DROP TABLE code_workspace_leases; DROP TABLE code_workspace_heads; DROP TABLE code_workspace_revisions;
        DROP TABLE task_artifact_deliveries; DROP TABLE code_dependencies; DROP TABLE code_executions;
        CREATE TABLE code_executions (
          id TEXT PRIMARY KEY, tool_call_id TEXT NOT NULL REFERENCES tool_calls(id), image_digest TEXT NOT NULL,
          argv TEXT NOT NULL, cwd TEXT NOT NULL, limits_json TEXT NOT NULL, exit_code INTEGER, log_ref TEXT, lifecycle TEXT NOT NULL
        ) STRICT;
        DROP TABLE browser_downloads; DROP TABLE browser_tool_calls; DROP INDEX browser_download_import_once;
        ALTER TABLE browser_sessions DROP COLUMN task_id; ALTER TABLE browser_sessions DROP COLUMN selected_tab_id;
        ALTER TABLE browser_sessions DROP COLUMN revision; ALTER TABLE browser_sessions DROP COLUMN profile_saved_at;
        ALTER TABLE browser_sessions DROP COLUMN last_error; ALTER TABLE browser_sessions DROP COLUMN owner_instance; ALTER TABLE browser_sessions DROP COLUMN owner_pid;
        DROP TABLE workspace_heads; DROP TABLE workspace_snapshots; DROP TABLE run_artifact_bindings; DROP TABLE task_artifacts; DROP TABLE artifact_operations; DROP TABLE artifact_settings;
        DROP INDEX one_publication_group; DROP INDEX artifact_version_sequence; DROP INDEX published_source_once;
        ALTER TABLE artifacts DROP COLUMN published_from_artifact_id; ALTER TABLE artifacts DROP COLUMN created_at;
        ALTER TABLE artifact_versions DROP COLUMN version_number; ALTER TABLE artifact_versions DROP COLUMN format; ALTER TABLE artifact_versions DROP COLUMN source_version_id;
        DELETE FROM schema_migrations WHERE version>=2; PRAGMA user_version=1;`);
    }finally{connection.close();}
    const reopened=await f.create(),after=reopened.snapshot();assert.deepEqual(after.agents,before.agents);assert.deepEqual(after.messages,before.messages);assert.equal(after.tasks.find(v=>v.id===t.id)!.checkpoint,2);assert.equal(after.requests[0].state,'open');assert.equal(after.runtime.schemaVersion,SCHEMA_VERSION);
  }finally{await f.close();}
});

test('a source growing after preflight cannot exceed its batch/storage reservation',async()=>{
  const f=await fixture();try{const path=await f.source('changed.txt','small');const c=await f.create(point=>{if(point==='after_preflight')writeFileSync(path,'x'.repeat(1024*1024));}),a=agent(c);
    await assert.rejects(imported(c,path,a.id),expected('limit_exceeded'));assert.equal(c.snapshot().artifacts.length,0);assert.equal(c.snapshot().workspaceSnapshots.length,0);
  }finally{await f.close();}
});

test('failed replacement snapshot retains the previous head and all committed input versions',async()=>{
  const f=await fixture();try{let armed=false;const c=await f.create(point=>{if(armed&&point==='before_metadata_commit')throw new Error('snapshot commit interruption');}),a=agent(c),t=task(c,a.id),first=await imported(c,await f.source('first.txt','first'),a.id,t.id),before=c.snapshot();
    armed=true;await assert.rejects(imported(c,await f.source('second.txt','second'),a.id,t.id),ArtifactError);
    assert.deepEqual(c.snapshot().workspaceSnapshots,before.workspaceSnapshots);assert.deepEqual(c.snapshot().taskArtifacts,before.taskArtifacts);c.close();await c.artifacts.drain();const next=await f.create();
    assert.equal(next.snapshot().artifacts.length,1);assert.equal(next.snapshot().workspaceSnapshots[0].id,before.workspaceSnapshots[0].id);assert.equal((await next.artifacts.preview({principal:owner,versionId:first})).text,'first');
  }finally{await f.close();}
});

test('closing during an import prevents metadata commit and drains its owned staging',async()=>{
  const f=await fixture();try{let c:Coordinator;let armed=false;c=await f.create(point=>{if(armed&&point==='after_stage')c.close();});const a=agent(c),path=await f.source('closing.txt','pending');armed=true;
    await assert.rejects(imported(c,path,a.id),expected('closed'));await c.artifacts.drain();const next=await f.create();assert.equal(next.snapshot().artifacts.length,0);assert.deepEqual(await readdir(join(next.dataRoot,'staging/artifacts')),[]);
  }finally{await f.close();}
});

test('expired operation lease alone cannot delete staging owned by a live process',async()=>{
  const f=await fixture();try{const c=await f.create(),operationId='live-expired-operation',relative=`staging/artifacts/${operationId}`;await mkdir(join(c.dataRoot,relative));await writeFile(join(c.dataRoot,relative,'pending'),'held');const connection=db(c);
    try{connection.prepare("INSERT INTO artifact_operations(id,owner_id,owner_pid,kind,state,manifest,reserved_bytes,lease_until,created_at,updated_at) VALUES (?,?,?,'import','staging',?,0,0,0,0)").run(operationId,'other-live-service',process.pid,JSON.stringify({id:operationId,stage:relative,kind:'import',finals:[],candidates:[]}));}finally{connection.close();}
    const peer=await f.create();assert.equal(await readFile(join(peer.dataRoot,relative,'pending'),'utf8'),'held');
    const cleanup=db(c);try{cleanup.prepare("UPDATE artifact_operations SET state='abandoned' WHERE id=?").run(operationId);}finally{cleanup.close();}await c.artifacts.reconcile();assert.deepEqual(await readdir(join(c.dataRoot,'staging/artifacts')),[]);
  }finally{await f.close();}
});
