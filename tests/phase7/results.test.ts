import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import { DEFAULT_LIVE_LIMITS, type LivePolicy } from '../../packages/contracts/live';
import { DEFAULT_MODEL } from '../../packages/model-adapters/pricing';

async function fixture(policy: LivePolicy = { mode: 'workspace', allowedOrigins: [] }) {
  const root = await mkdtemp(join(tmpdir(), 'aw-results-')), dataRoot = join(root, 'data');
  const instances: Coordinator[] = [];
  const create = async () => { const c = new Coordinator({ dataRoot }); instances.push(c); await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } }); return c; };
  const c = await create(), agent = c.handle({ type: 'agents.create', name: 'Result fixture', instructions: '' }).agents[0];
  const taskId = c.createLiveTask({ type: 'live.createTask', agentId: agent.id, objective: 'Compare the two supplied periods.', completionCriteria: 'Report the actual change, cite the inputs, and disclose missing rows.', model: DEFAULT_MODEL, policy, limits: { ...DEFAULT_LIVE_LIMITS } });
  const inputPath = join(root, 'input.csv'); await writeFile(inputPath, 'period,value\nold,2\nnew,4\n');
  const inputId = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId }, paths: [inputPath] })).versionIds[0];
  // Completed-result fixture: exercise managed verified bytes, then supply the final
  // task metadata normally committed by the already-tested model/code finish path.
  const finish = async (coordinator: Coordinator, targetTask = taskId, name = 'report.md', content = '# Report\nThe increase is 100%.\n') => {
    const path = join(root, randomUUID() + '.md'); await writeFile(path, content);
    const versionId = (await coordinator.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId: targetTask }, paths: [path] })).versionIds[0];
    const db = new DatabaseSync(coordinator.databasePath);
    try {
      db.prepare('UPDATE artifacts SET display_name=? WHERE id=(SELECT artifact_id FROM artifact_versions WHERE id=?)').run(name, versionId);
      db.prepare("UPDATE task_artifacts SET role='output' WHERE task_id=? AND version_id=?").run(targetTask, versionId);
      db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(targetTask);
      db.prepare('UPDATE live_task_config SET result_version_id=?,cost_microusd=4200,enabled=0 WHERE task_id=?').run(versionId, targetTask);
    } finally { db.close(); }
    return versionId;
  };
  const versionId = await finish(c);
  return { c, root, dataRoot, agent, taskId, versionId, inputId, inputPath, finish, create, async close() { for (const item of instances) await item.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const accept = (taskId: string, versionId: string, revision = 0, key = randomUUID()) => ({ type: 'results.accept', taskId, versionId, revision, idempotencyKey: key });
const revise = (taskId: string, versionId: string, revision = 0) => ({ type: 'results.requestChanges', taskId, versionId, revision, feedback: 'Include the raw difference of 2 and distinguish it from the percentage.', limits: { ...DEFAULT_LIVE_LIMITS, maxCostUsd: 0.15 }, idempotencyKey: randomUUID() });

test('result inspection distinguishes file integrity, receipts and owner judgment', async () => {
  const f = await fixture(); try {
    const detail = await f.c.results.inspect(f.taskId, f.versionId);
    assert.equal(detail.integrity, 'verified'); assert.equal(detail.criteriaStatus, 'needs_owner_review');
    assert.equal(detail.result.review.state, 'unreviewed'); assert.equal(detail.totalEvidence, 0);
    assert.match(detail.preview.text!, /100%/); assert.equal(detail.inputs[0].id, f.inputId);
    assert.equal(detail.result.costUsd, 0.0042);
    await assert.rejects(f.c.results.handle(accept(f.taskId, f.inputId)), /final output/);
    await assert.rejects(f.c.results.inspect('unknown', f.versionId), /final output/);
  } finally { await f.close(); }
});

test('owner acceptance is exact-version, durable, idempotent and rejects stale/conflicting actions', async () => {
  const f = await fixture(); try {
    const command = accept(f.taskId, f.versionId);
    assert.equal((await f.c.results.handle(command)).results[0].review.state, 'accepted');
    assert.equal((await f.c.results.handle(command)).results[0].review.revision, 1);
    await assert.rejects(f.c.results.handle({ ...command, revision: 1 }), /different details/);
    await assert.rejects(f.c.results.handle(accept(f.taskId, f.versionId)), /changed in another window/);
    await f.c.shutdown(); const next = await f.create();
    assert.equal((await next.results.handle(command)).results[0].review.revision, 1);
    assert.equal((await next.results.inspect(f.taskId, f.versionId)).criteriaStatus, 'accepted_by_owner');
  } finally { await f.close(); }
});

test('file corruption cannot be accepted and does not create an owner decision', async () => {
  const f = await fixture(); try {
    const db = new DatabaseSync(f.c.databasePath); let storage: string;
    try { storage = String(db.prepare('SELECT storage_ref FROM artifact_versions WHERE id=?').get(f.versionId)!.storage_ref); } finally { db.close(); }
    const path = join(f.dataRoot, storage); await chmod(path, 0o600); await writeFile(path, 'changed bytes');
    await assert.rejects(f.c.results.handle(accept(f.taskId, f.versionId)));
    const check = new DatabaseSync(f.c.databasePath); try { assert.equal(check.prepare('SELECT COUNT(*) AS n FROM result_reviews').get()!.n, 0); } finally { check.close(); }
  } finally { await f.close(); }
});

test('revision creates a bounded paused task and pins exact original versions without reopening or copying grants', async () => {
  const f = await fixture(); try {
    const old = f.c.snapshot().artifacts.find(v => v.id === f.inputId)!;
    await writeFile(f.inputPath, 'period,value\nold,2\nnew,999\n');
    const newer = (await f.c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: f.agent.id, taskId: null }, paths: [f.inputPath], artifactId: old.artifactId })).versionIds[0];
    const command = revise(f.taskId, f.versionId), result = await f.c.results.handle(command), newTaskId = result.createdTaskId!;
    assert.equal(f.c.snapshot().tasks.find(t => t.id === f.taskId)!.state, 'succeeded');
    const task = f.c.snapshot().tasks.find(t => t.id === newTaskId)!;
    assert.equal(task.state, 'paused'); assert.match(task.objective, /raw difference of 2/);
    assert.equal(task.completionCriteria, result.results[0].completionCriteria);
    const pinned = f.c.snapshot().taskArtifacts.filter(a => a.taskId === newTaskId).map(a => a.versionId);
    assert.deepEqual(new Set(pinned), new Set([f.inputId, f.versionId])); assert.ok(!pinned.includes(newer));
    assert.equal(result.revisionJobs[0].state, 'ready'); assert.equal(f.c.results.blockingReason(newTaskId), null);
    const live = (await f.c.live.state()).tasks.find(t => t.taskId === newTaskId)!;
    assert.equal(live.enabled, false); assert.equal(live.calls, 0); assert.equal(live.limits.maxCostUsd, 0.15);
    assert.ok(f.c.snapshot().messages.some(m => m.taskId === newTaskId && m.deliveryState === 'pending' && m.content.includes('Compare the two supplied periods.')));
    const db = new DatabaseSync(f.c.databasePath); try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_capability_grants WHERE task_id=?').get(newTaskId)!.n, 0); } finally { db.close(); }
    assert.equal((await f.c.results.handle(command)).createdTaskId, newTaskId); assert.equal(f.c.snapshot().tasks.length, 2);
  } finally { await f.close(); }
});

test('Gmail revision keeps the exact read-only account policy', async () => {
  const policy: LivePolicy = { mode: 'read_only_browser', allowedOrigins: ['https://mail.google.com'], mailAccount: 'fixture@gmail.com' };
  const f = await fixture(policy); try {
    const result = await f.c.results.handle(revise(f.taskId, f.versionId));
    assert.deepEqual((await f.c.live.state()).tasks.find(t => t.taskId === result.createdTaskId)!.policy, policy);
  } finally { await f.close(); }
});

test('revision receipt failure rolls back new task and owner decision atomically', async () => {
  const f = await fixture(); try {
    const db = new DatabaseSync(f.c.databasePath); try { db.exec("CREATE TRIGGER reject_result_action BEFORE INSERT ON result_actions BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;"); } finally { db.close(); }
    await assert.rejects(f.c.results.handle(revise(f.taskId, f.versionId)), /fixture_failure/);
    assert.equal(f.c.snapshot().tasks.length, 1); assert.equal(f.c.results.state().revisionJobs.length, 0);
    assert.equal(f.c.results.state().results[0].review.state, 'unreviewed');
  } finally { await f.close(); }
});

test('failed managed input preparation stays blocked across restart and retries idempotently', async () => {
  const f = await fixture(); try {
    const original = f.c.artifacts.useInTask.bind(f.c.artifacts); let calls = 0;
    f.c.artifacts.useInTask = async options => { if (++calls === 2) throw new Error('fixture transfer interruption'); return original(options); };
    const command = revise(f.taskId, f.versionId), result = await f.c.results.handle(command), taskId = result.createdTaskId!;
    assert.equal(result.revisionJobs[0].state, 'failed'); assert.match(f.c.results.blockingReason(taskId)!, /not ready/);
    assert.equal(f.c.snapshot().tasks.find(t => t.id === taskId)!.state, 'paused');
    await f.c.shutdown(); const next = await f.create(); assert.match(next.results.blockingReason(taskId)!, /not ready/);
    const recovered = await next.results.handle(command);
    assert.equal(recovered.createdTaskId, taskId); assert.equal(recovered.revisionJobs[0].state, 'ready');
    assert.equal(next.snapshot().tasks.length, 2); assert.equal(next.snapshot().taskArtifacts.filter(a => a.taskId === taskId).length, 2);
  } finally { await f.close(); }
});

test('accepting a revision does not accept an older result and comparison binds its exact parent', async () => {
  const f = await fixture(); try {
    const revision = await f.c.results.handle(revise(f.taskId, f.versionId)), taskId = revision.createdTaskId!;
    const versionId = await f.finish(f.c, taskId, 'revision.md', '# Checked\nDifference: 2; increase: 100%.');
    await f.c.results.handle(accept(taskId, versionId));
    const state = f.c.results.state();
    assert.equal(state.results.find(r => r.taskId === f.taskId)!.review.state, 'changes_requested');
    assert.deepEqual(state.results.find(r => r.taskId === taskId)!.revisionOf, { taskId: f.taskId, versionId: f.versionId });
    await assert.rejects(f.c.results.handle(accept(f.taskId, versionId)), /final output/);
  } finally { await f.close(); }
});

test('result commands reject overbroad fields, oversized changes and invalid budgets without side effects', async () => {
  const f = await fixture(); try {
    const base = revise(f.taskId, f.versionId);
    for (const command of [{ ...base, feedback: '' }, { ...base, feedback: 'a'.repeat(4001) }, { ...base, allowedOrigins: ['https://other.example'] }, { ...base, limits: { ...base.limits, maxCostUsd: 100 } }, { ...base, revision: -1 }, { ...base, versionId: '../../file' }]) await assert.rejects(f.c.results.handle(command));
    assert.equal(f.c.snapshot().tasks.length, 1); assert.equal(f.c.results.state().results[0].review.state, 'unreviewed');
  } finally { await f.close(); }
});

test('C85 revision preserves named roles and effective structural requirements across restart',async()=>{
  const f=await fixture();try{
    const created=await f.c.workflows.handle({type:'workflows.createTask',workflowId:'data-report',values:{question:'Compare',files:'Exact period files'},agentId:f.agent.id,model:DEFAULT_MODEL,limits:{...DEFAULT_LIVE_LIMITS},idempotencyKey:randomUUID()});
    const taskId=created.createdTaskId!;
    const first=(await f.c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:f.agent.id,taskId},paths:[f.inputPath]})).versionIds[0];
    const secondPath=join(f.root,'second.csv');await writeFile(secondPath,'period,value\nold,1\n');
    const second=(await f.c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:f.agent.id,taskId},paths:[secondPath]})).versionIds[0];
    await f.c.workflows.handle({type:'workflows.assignInputs',taskId,assignments:[{slotKey:'current_data',versionId:first},{slotKey:'comparison_data',versionId:second}]});
    const source=await f.finish(f.c,taskId,'report.md','# Findings\nOriginal\n# Coverage\nExact versions\n# Calculation checks\nNone\n# Limitations\nSynthetic');
    const next=(await f.c.results.handle(revise(taskId,source))).createdTaskId!;
    assert.deepEqual(f.c.workflows.inputContext(next).map(role=>[role.slotKey,role.versionId]),[['current_data',first],['comparison_data',second]]);
    const incomplete=await f.finish(f.c,next,'report.md','# Findings\nOnly');
    assert.equal((await f.c.results.checkQuality(next,incomplete)).checks.find(check=>check.id==='sections')?.status,'fail');
    await f.c.shutdown();const restarted=await f.create();assert.deepEqual(restarted.workflows.inputContext(next).map(role=>role.versionId),[first,second]);
  }finally{await f.close();}
});
test('C89 bounded older pages and exact task lookup select persisted final version',async()=>{const f=await fixture();try{const db=new DatabaseSync(f.c.databasePath);try{const source=db.prepare('SELECT * FROM artifact_versions WHERE id=?').get(f.versionId)!;for(let i=0;i<200;i++){const task=f.c.createLiveTask({type:'live.createTask',agentId:f.agent.id,objective:`Newer completed fixture ${i}`,completionCriteria:'Fixture',model:DEFAULT_MODEL,policy:{mode:'workspace',allowedOrigins:[]},limits:{...DEFAULT_LIVE_LIMITS}}),artifact=randomUUID(),version=randomUUID();db.prepare("INSERT INTO artifacts(id,owner_agent_id,producer_task_id,visibility,display_name) VALUES (?,?,?,'private','synthetic.md')").run(artifact,f.agent.id,task);db.prepare("INSERT INTO artifact_versions(id,artifact_id,version_number,storage_ref,sha256,bytes,mime,format,provenance,status,created_at) VALUES (?,?,1,?,?,?,?,?,'{}','ready',?)").run(version,artifact,'synthetic-no-read-'+version,source.sha256,source.bytes,source.mime,source.format,Date.now()+i+1000);db.prepare("INSERT INTO task_artifacts(task_id,version_id,role,created_at) VALUES (?,?,'output',?)").run(task,version,Date.now());db.prepare("UPDATE tasks SET state='succeeded',updated_at=? WHERE id=?").run(Date.now()+i+1000,task);db.prepare('UPDATE live_task_config SET result_version_id=? WHERE task_id=?').run(version,task);}}finally{db.close();}const newest=f.c.results.state();assert.equal(newest.results.length,200);assert.equal(newest.results.some(item=>item.taskId===f.taskId),false);const older=await f.c.results.handle({type:'results.state',beforeTaskId:newest.results.at(-1)!.taskId});assert.equal(older.results.length,1);assert.equal(older.results[0].taskId,f.taskId);const exact=await f.c.results.handle({type:'results.inspect',taskId:f.taskId});assert.equal(exact.detail!.result.version.id,f.versionId);assert.equal(exact.detail!.integrity,'verified');}finally{await f.close();}});
