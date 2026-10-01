import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, link, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Persistence } from '../../packages/persistence/index';
import { RecoveryService, RecoveryError } from '../../packages/recovery/index';
import type { RecoveryLimits } from '../../packages/recovery/index';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(limits?: Partial<RecoveryLimits>) {
  const root = await mkdtemp(join(tmpdir(), 'aw-recovery-'));
  const persistence = new Persistence(join(root, 'data'), Date.now());
  persistence.db.prepare("INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES('agent','A','','workspace',1)").run();
  persistence.db.prepare("INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,created_at,updated_at,checkpoint) VALUES('task','agent','Keep progress','paused','Deliver text','complete',1,1,3)").run();
  const content = 'A saved private result.\n';
  const storage = 'artifacts/private/agent/artifact/version/content.txt';
  await mkdir(join(persistence.dataRoot, storage, '..'), { recursive: true });
  await writeFile(join(persistence.dataRoot, storage), content);
  persistence.db.prepare("INSERT INTO artifacts(id,owner_agent_id,producer_task_id,visibility,display_name) VALUES('artifact','agent','task','private','result.txt')").run();
  persistence.db.prepare("INSERT INTO artifact_versions(id,artifact_id,storage_ref,sha256,bytes,mime,status,created_at) VALUES('version','artifact',?,?,?,'text/plain','ready',1)").run(storage, digest(content), Buffer.byteLength(content));
  persistence.db.prepare("INSERT INTO task_artifacts(task_id,version_id,role,created_at) VALUES('task','version','output',1)").run();
  persistence.db.prepare("INSERT INTO browser_sessions(id,agent_id,profile_ref,profile_saved_at) VALUES('browser','agent','private/browser-secret',1)").run();
  await mkdir(join(persistence.dataRoot, 'native-browser/profiles/agent'), { recursive: true });
  await writeFile(join(persistence.dataRoot, 'native-browser/profiles/agent/Cookies'), 'NEVER BACKUP COOKIES');
  await writeFile(join(persistence.dataRoot, 'control/profile-key'), 'NEVER BACKUP KEYS');
  let gateCalls = 0;
  const service = new RecoveryService({ persistence, appVersion: 'test', limits, withQuiesced: async work => { gateCalls++; return work(); } });
  return { root, persistence, service, storage, content, gateCalls: () => gateCalls, close: async () => { persistence.close(); await rm(root, { recursive: true, force: true }); } };
}
const errorCode = (code: string) => (error: unknown) => error instanceof RecoveryError && error.code === code;

test('application startup refuses incomplete restored roots, including a linked incomplete marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-incomplete-root-'));
  try {
    const marker = join(root, '.recovery-incomplete');
    await writeFile(marker, 'unfinished');
    assert.throws(() => new Persistence(root, 1), /recovery did not finish/);
    await rm(marker); await symlink(join(root, 'missing'), marker);
    assert.throws(() => new Persistence(root, 1), /recovery did not finish/);
    assert.ok(!(await readdir(root)).includes('control'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('committed WAL data and private artifacts restore separately, with execution and browser authority disabled', async () => {
  const f = await fixture();
  try {
    f.persistence.db.prepare("UPDATE tasks SET objective='Latest WAL checkpoint',state='waiting',waiting_reason='files' WHERE id='task'").run();
    const backup = await f.service.createBackup(join(f.root, 'backup'));
    assert.equal(f.gateCalls(), 1);
    assert.equal(backup.manifest.files.length, 2);
    assert.deepEqual((await readdir(join(backup.directory, 'control'))).sort(), ['agent-workspaces.sqlite']);
    await f.service.verifyBackup(backup.directory);
    await f.service.verifyBackup(backup.directory); // Verification must not create WAL sidecars.
    const restored = await f.service.restoreBackup(backup.directory, join(f.root, 'restored'));
    assert.equal(restored.pausedTasks, 1);
    const db = new DatabaseSync(join(restored.dataRoot, 'control/agent-workspaces.sqlite'));
    try {
      const row = db.prepare("SELECT objective,state,checkpoint,generation FROM tasks WHERE id='task'").get()!;
      assert.equal(row.objective, 'Latest WAL checkpoint'); assert.equal(row.state, 'paused'); assert.equal(row.checkpoint, 3); assert.equal(row.generation, 1);
      assert.equal(db.prepare('SELECT driver_enabled FROM settings').get()!.driver_enabled, 0);
      assert.equal(db.prepare('SELECT enabled FROM agents').get()!.enabled, 1); // Existing owner Resume remains usable.
      assert.equal(db.prepare('SELECT profile_ref FROM browser_sessions').get()!.profile_ref, null);
    } finally { db.close(); }
    assert.equal(await readFile(join(restored.dataRoot, f.storage), 'utf8'), f.content);
    assert.equal(f.persistence.db.prepare("SELECT state FROM tasks WHERE id='task'").get()!.state, 'waiting');
    assert.ok(!JSON.stringify(backup.manifest).includes('profile-key'));
    assert.ok(!(await readdir(restored.dataRoot)).includes('native-browser'));
  } finally { await f.close(); }
});

test('running work refuses backup; coordinator pause gate is required and runs before the snapshot', async () => {
  const f = await fixture();
  try {
    f.persistence.db.exec("UPDATE tasks SET state='running'");
    await assert.rejects(f.service.createBackup(join(f.root, 'refused')), errorCode('not_quiesced'));
    assert.equal(f.gateCalls(), 1);
    const gated = new RecoveryService({ persistence: f.persistence, appVersion: 'test', withQuiesced: async work => { f.persistence.db.exec("UPDATE tasks SET state='paused'"); return work(); } });
    await gated.createBackup(join(f.root, 'paused-backup'));
    assert.equal(f.persistence.db.prepare('SELECT state FROM tasks').get()!.state, 'paused');
  } finally { await f.close(); }
});

test('database writer reservation refuses competing mutations without silently taking a partial copy', async () => {
  const f = await fixture();
  try {
    const blocker = new DatabaseSync(f.persistence.databasePath);
    blocker.exec('BEGIN IMMEDIATE');
    try { await assert.rejects(f.service.createBackup(join(f.root, 'locked')), /locked|busy/i); }
    finally { blocker.exec('ROLLBACK'); blocker.close(); }
    assert.ok(!(await readdir(f.root)).includes('locked'));
  } finally { await f.close(); }
});

test('hash corruption, omitted references and incomplete snapshots cannot be restored', async () => {
  const f = await fixture();
  try {
    const result = await f.service.createBackup(join(f.root, 'backup'));
    const content = join(result.directory, f.storage);
    await chmod(content, 0o600); await writeFile(content, 'tampered');
    await assert.rejects(f.service.restoreBackup(result.directory, join(f.root, 'bad')), errorCode('integrity_error'));
    await writeFile(content, f.content);
    const manifest = { ...result.manifest, files: result.manifest.files.filter(entry => entry.kind === 'database') };
    manifest.totalBytes = manifest.files[0].bytes;
    await writeFile(join(result.directory, 'backup-manifest.json'), JSON.stringify(manifest));
    await assert.rejects(f.service.verifyBackup(result.directory), errorCode('incomplete_backup'));
    await writeFile(join(result.directory, '.recovery-incomplete'), 'incomplete');
    await assert.rejects(f.service.verifyBackup(result.directory), errorCode('incomplete_backup'));
    assert.ok(!(await readdir(f.root)).includes('bad'));
  } finally { await f.close(); }
});

test('source corruption leaves a clearly incomplete backup that verification refuses', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.persistence.dataRoot, f.storage), 'broken');
    await assert.rejects(f.service.createBackup(join(f.root, 'partial')), errorCode('integrity_error'));
    await assert.rejects(f.service.verifyBackup(join(f.root, 'partial')), errorCode('incomplete_backup'));
    assert.ok(await lstat(join(f.root, 'partial/.recovery-incomplete')));
  } finally { await f.close(); }
});

test('destinations never overwrite data, and links and out-of-bounds files are refused', async () => {
  const f = await fixture();
  try {
    const backup = await f.service.createBackup(join(f.root, 'backup'));
    await mkdir(join(f.root, 'existing'));
    await assert.rejects(f.service.restoreBackup(backup.directory, join(f.root, 'existing')), errorCode('destination_exists'));
    await assert.rejects(f.service.restoreBackup(backup.directory, f.persistence.dataRoot), errorCode('unsafe_destination'));
    await assert.rejects(f.service.createBackup(join(f.persistence.dataRoot, 'inside')), errorCode('unsafe_destination'));
    await rm(join(f.persistence.dataRoot, f.storage));
    await symlink(join(backup.directory, f.storage), join(f.persistence.dataRoot, f.storage));
    await assert.rejects(f.service.createBackup(join(f.root, 'linked')), /link|ELOOP/i);
    await rm(join(f.persistence.dataRoot, f.storage));
    await link(join(backup.directory, f.storage), join(f.persistence.dataRoot, f.storage));
    await assert.rejects(f.service.createBackup(join(f.root, 'hardlinked')), errorCode('unsafe_file'));
  } finally { await f.close(); }
});

test('manifest traversal, forged storage paths and size limits cannot copy unrelated files', async () => {
  const f = await fixture({ totalBytes: 512 });
  try {
    await assert.rejects(f.service.createBackup(join(f.root, 'small')), errorCode('size_limit'));
    f.persistence.db.prepare("UPDATE artifact_versions SET storage_ref='control/profile-key'").run();
    await assert.rejects(f.service.createBackup(join(f.root, 'forged')), errorCode('invalid_manifest'));
    assert.ok(!(await readdir(f.root)).includes('forged'));
  } finally { await f.close(); }
});

test('workspace input snapshots and code revisions are complete and hash-checked on restore', async () => {
  const f = await fixture();
  try {
    const db = f.persistence.db;
    const snapshot = 'private/agent/workspace/tasks/task/snapshots/snapshot';
    const inputFiles = [{ path: 'inputs/version/content.txt', versionId: 'version', bytes: Buffer.byteLength(f.content), sha256: digest(f.content) }];
    await mkdir(join(f.persistence.dataRoot, snapshot, 'inputs/version'), { recursive: true });
    await writeFile(join(f.persistence.dataRoot, snapshot, inputFiles[0].path), f.content);
    await writeFile(join(f.persistence.dataRoot, snapshot, 'manifest.json'), JSON.stringify({ taskId: 'task', revision: 1, files: inputFiles }, null, 2));
    db.prepare("INSERT INTO workspace_snapshots(id,task_id,revision,storage_ref,manifest,bytes,file_count,status,created_at) VALUES('snapshot','task',1,?,?,?,1,'ready',1)").run(snapshot, JSON.stringify(inputFiles), Buffer.byteLength(f.content));
    db.exec("INSERT INTO workspace_heads VALUES('task','snapshot')");
    db.exec("INSERT INTO runs(id,task_id,agent_id,attempt,worker_id,lease_until,fencing_generation,checkpoint,state,created_at) VALUES('run','task','agent',1,'worker',0,1,'{}','succeeded',1)");
    db.exec("INSERT INTO tool_calls(id,run_id,generation,tool_name,args_ref,state,idempotency_key,created_at) VALUES('tool','run',1,'code.execute','{}','succeeded','key',1)");
    db.exec("INSERT INTO code_executions(id,tool_call_id,image_digest,argv,cwd,limits_json,lifecycle,task_id,agent_id) VALUES('execution','tool','digest','[]','/workspace','{}','succeeded','task','agent')");
    const revision = 'private/agent/workspace/tasks/task/revisions/revision', output = 'print(42)\n';
    const codeFiles = [{ path: 'source/main.py', bytes: Buffer.byteLength(output), sha256: digest(output) }];
    await mkdir(join(f.persistence.dataRoot, revision, 'source'), { recursive: true });
    await writeFile(join(f.persistence.dataRoot, revision, codeFiles[0].path), output);
    await writeFile(join(f.persistence.dataRoot, revision, 'manifest.json'), JSON.stringify({ taskId: 'task', executionId: 'execution', parentId: null, revision: 1, files: codeFiles }, null, 2));
    db.prepare("INSERT INTO code_workspace_revisions(id,task_id,execution_id,parent_id,revision,storage_ref,manifest,bytes,file_count,status,output_version_ids,created_at) VALUES('revision','task','execution',NULL,1,?,?,?,1,'ready','[]',1)").run(revision, JSON.stringify(codeFiles), Buffer.byteLength(output));
    db.exec("INSERT INTO code_workspace_heads VALUES('task','revision')");
    const backup = await f.service.createBackup(join(f.root, 'backup'));
    assert.equal(backup.manifest.files.filter(entry => entry.kind === 'workspace').length, 4);
    const restored = await f.service.restoreBackup(backup.directory, join(f.root, 'restore'));
    assert.equal(await readFile(join(restored.dataRoot, revision, 'source/main.py'), 'utf8'), output);
    assert.equal(await readFile(join(restored.dataRoot, snapshot, 'inputs/version/content.txt'), 'utf8'), f.content);
  } finally { await f.close(); }
});

test('pending paid calls and browser control fail the idle gate; restore revokes grants and disables paid execution', async () => {
  const f = await fixture();
  try {
    const db = f.persistence.db;
    db.exec("INSERT INTO live_task_config(task_id,model,policy_json,limits_json,enabled,created_at,updated_at) VALUES('task','test','{}','{}',1,1,1)");
    db.exec("INSERT INTO live_model_calls(id,task_id,state,reserved_microusd,cost_microusd,request_hash,owner_pid,owner_instance,created_at) VALUES('call','task','reserved',7,0,'hash',1,'instance',1)");
    await assert.rejects(f.service.createBackup(join(f.root, 'pending')), errorCode('not_quiesced'));
    db.exec("UPDATE live_model_calls SET state='uncertain'; UPDATE browser_sessions SET controller='human'");
    await assert.rejects(f.service.createBackup(join(f.root, 'browser-busy')), errorCode('not_quiesced'));
    db.exec("UPDATE browser_sessions SET controller='none'");
    db.exec("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES('request','task','permission_change','Permission','Needed','fulfilled','permission',1)");
    db.exec("INSERT INTO request_capability_grants(request_id,task_id,capability_json,granted_at) VALUES('request','task','{}',1)");
    const backup = await f.service.createBackup(join(f.root, 'backup'));
    const restored = await f.service.restoreBackup(backup.directory, join(f.root, 'restore'));
    const restoredDb = new DatabaseSync(join(restored.dataRoot, 'control/agent-workspaces.sqlite'));
    try {
      assert.equal(restoredDb.prepare('SELECT enabled FROM live_task_config').get()!.enabled, 0);
      assert.ok(Number(restoredDb.prepare('SELECT revoked_at FROM request_capability_grants').get()!.revoked_at) > 0);
      assert.equal(restoredDb.prepare('SELECT state FROM live_model_calls').get()!.state, 'uncertain');
      assert.equal(restoredDb.prepare('SELECT reserved_microusd FROM live_model_calls').get()!.reserved_microusd, 7); // No refund of uncertain usage.
    } finally { restoredDb.close(); }
  } finally { await f.close(); }
});


test('backup refuses in-flight routine preparation and restored schedules and notifications remain inactive', async () => {
  const f = await fixture();
  try {
    const db = f.persistence.db;
    db.exec("INSERT INTO routines VALUES('routine','Morning review','task','agent',1,'{}',1,9999999999999,1000000,'{}',NULL,1,'routine-key','hash')");
    db.exec("INSERT INTO routine_occurrences VALUES('occurrence','routine','2026-09-30',1,NULL,'preparing',NULL,250000,1)");
    db.prepare("INSERT INTO routine_preparation_claims VALUES('occurrence','owner',?,?)").run(process.pid, Date.now() + 60000);
    await assert.rejects(f.service.createBackup(join(f.root, 'preparing')), errorCode('not_quiesced'));
    db.exec("DELETE FROM routine_preparation_claims; UPDATE routine_occurrences SET state='blocked'; UPDATE notice_settings SET enabled=1");
    const eventId=Number(db.prepare("INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES('task.complete','task',1,'{}',1)").run().lastInsertRowid);
    db.prepare("INSERT INTO owner_notices(event_id,task_id,kind,created_at,seen,delivered) VALUES(?,'task','completed',1,0,1)").run(eventId);
    const backup = await f.service.createBackup(join(f.root, 'backup'));
    const restored = await f.service.restoreBackup(backup.directory, join(f.root, 'restore'));
    const restoredDb = new DatabaseSync(join(restored.dataRoot, 'control/agent-workspaces.sqlite'));
    try {
      assert.equal(restoredDb.prepare('SELECT enabled FROM routines').get()!.enabled, 0);
      assert.equal(restoredDb.prepare('SELECT enabled FROM notice_settings').get()!.enabled, 0);
      assert.equal(restoredDb.prepare('SELECT delivered FROM owner_notices').get()!.delivered, 1);
      assert.equal(restoredDb.prepare('SELECT count(*) AS n FROM routine_preparation_claims').get()!.n, 0);
    } finally { restoredDb.close(); }
  } finally { await f.close(); }
});
