import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { DEFAULT_MODEL } from '../../packages/model-adapters/pricing';
import { prepareWorkflow, WORKFLOW_RECIPES } from '../../packages/workflows/catalog';
import { procedureVersion, readProcedure, renderProcedure } from '../../packages/workflows/procedures';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aw-workflow-inputs-')), instances: Coordinator[] = [];
  const create = async () => { const c = new Coordinator({ dataRoot: join(root, 'app') }); instances.push(c); await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } }); return c; };
  const c = await create(), agent = c.handle({ type: 'agents.create', name: 'CSV fixture', instructions: '' }).agents[0];
  const task = (workflowId = 'data-report', values: Record<string, string> = { question: 'What changed between periods?', files: 'Current and comparison data.' }) => c.workflows.handle({ type: 'workflows.createTask', workflowId, values, agentId: agent.id, model: DEFAULT_MODEL, limits: { ...DEFAULT_LIVE_LIMITS }, idempotencyKey: randomUUID() }).createdTaskId!;
  const add = async (taskId: string, name: string, text: string) => { const path = join(root, randomUUID() + '-' + name); await writeFile(path, text); return (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId }, paths: [path] })).versionIds[0]; };
  const assign = (taskId: string, slotKey: string, versionId: string) => c.workflows.handle({ type: 'workflows.assignInputs', taskId, assignments: [{ slotKey, versionId }] });
  return { c, agent, task, add, assign, create, async close() { for (const instance of instances) await instance.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('CSV task stores immutable named requirements and blocks before any paid call with missing inputs', async () => {
  const f = await fixture(); try {
    const taskId = f.task(), definition = f.c.workflows.requirementsForTask(taskId)!;
    assert.deepEqual(definition.fileSlots.map(slot => slot.key), ['current_data', 'comparison_data']);
    assert.deepEqual(definition.fileSlots[0].constraints.csv!.requiredColumns, []);
    assert.equal(definition.output.filename, 'report.md');
    await assert.rejects(f.c.workflows.assertInputsReady(taskId), /required workflow file/);
    await assert.rejects(f.c.live.handle({ type: 'live.start', taskId }), /required workflow file/);
    assert.equal((await f.c.live.state()).tasks.find(task => task.taskId === taskId)!.calls, 0);
    definition.output.filename = 'mutated.md';
    assert.equal(f.c.workflows.requirementsForTask(taskId)!.output.filename, 'report.md');
  } finally { await f.close(); }
});

test('two valid pinned CSVs pass shape checks and retain explicit roles across restart', async () => {
  const f = await fixture(); try {
    const taskId = f.task(), current = await f.add(taskId, 'current.csv', 'product,value\nA,3\nB,4\n'), comparison = await f.add(taskId, 'comparison.csv', 'product,value\nA,1\nB,2\n');
    f.assign(taskId, 'current_data', current); f.assign(taskId, 'comparison_data', comparison);
    assert.ok((await f.c.workflows.checkInputs(taskId)).every(slot => slot.status === 'accepted'));
    await f.c.workflows.assertInputsReady(taskId);
    await f.c.shutdown(); const next = await f.create();
    await next.workflows.assertInputsReady(taskId);
    assert.deepEqual(next.workflows.inputContext(taskId).map(slot => slot.versionId), [current, comparison]);
    assert.equal((await next.live.state()).tasks[0].calls, 0);
  } finally { await f.close(); }
});

test('wrong format and malformed CSV fail without losing the other valid assignment', async () => {
  const f = await fixture(); try {
    const taskId = f.task(), current = await f.add(taskId, 'current.csv', 'label,total\nA,2\n'), text = await f.add(taskId, 'other.txt', 'ordinary text');
    f.assign(taskId, 'current_data', current); f.assign(taskId, 'comparison_data', text);
    let checks = await f.c.workflows.checkInputs(taskId);
    assert.equal(checks[0].status, 'accepted'); assert.equal(checks[1].status, 'rejected');
    const bad = await f.add(taskId, 'bad.csv', 'label,total\nA\n'); f.assign(taskId, 'comparison_data', bad);
    checks = await f.c.workflows.checkInputs(taskId);
    assert.equal(checks[1].status, 'rejected'); assert.match(checks[1].detail, /column count/);
    assert.equal(f.c.workflows.inputContext(taskId)[0].versionId, current);
    await assert.rejects(f.c.workflows.assertInputsReady(taskId));
  } finally { await f.close(); }
});

test('input assignment rejects foreign/unpinned versions, unknown slots, duplicate roles and ended tasks', async () => {
  const f = await fixture(); try {
    const taskId = f.task(), other = f.task(), version = await f.add(other, 'other.csv', 'a\n1\n');
    assert.throws(() => f.assign(taskId, 'current_data', version), /already imported/);
    const own = await f.add(taskId, 'own.csv', 'a\n1\n');
    assert.throws(() => f.assign(taskId, 'invented', own), /no such file slot/);
    f.assign(taskId, 'current_data', own);
    assert.throws(() => f.assign(taskId, 'comparison_data', own), /different file versions/);
    assert.equal(f.c.workflows.inputContext(taskId)[1].versionId, null);
    f.c.handle({ type: 'tasks.cancel', taskId });
    assert.throws(() => f.assign(taskId, 'current_data', own), /Ended tasks/);
  } finally { await f.close(); }
});

test('parameterized saved procedures preserve named fields and version, without original values or file assignments', async () => {
  const f = await fixture(); try {
    const taskId = f.task('competitor-brief', { focus: 'PRIVATE-BRIEF-VALUE', websites: 'https://example.com/private-reference' });
    const saved = f.c.workflows.handle({ type: 'workflows.saveFromTask', taskId, title: 'Repeat comparison', description: '', category: 'business', idempotencyKey: randomUUID(), parameterized: true }).saved[0];
    assert.deepEqual(saved.inputs.map(input => input.id), ['focus', 'websites']);
    assert.equal(saved.procedure!.versionId, f.c.workflows.requirementsForTask(taskId)!.versionId);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE-BRIEF-VALUE|private-reference/);
    assert.throws(() => prepareWorkflow(saved, {}), /Complete/);
    for (const focus of ['Product coverage', 'Pricing clarity', 'Onboarding experience']) {
      const draft = prepareWorkflow(saved, { focus, websites: 'https://example.org/docs' });
      assert.match(draft.objective, new RegExp(focus));
      assert.deepEqual(draft.policy.allowedOrigins, ['https://example.org']);
    }
  } finally { await f.close(); }
});

test('legacy manual workflows and custom tasks remain unaffected by file-slot preflight', async () => {
  const f = await fixture(); try {
    const taskId = f.task();
    const saved = f.c.workflows.handle({ type: 'workflows.saveFromTask', taskId, title: 'Manual brief', description: '', category: 'business', idempotencyKey: randomUUID() }).saved[0];
    assert.equal(saved.procedure, undefined); assert.equal(saved.inputs[0].id, 'objective');
    const replay = f.c.workflows.handle({ type: 'workflows.createTask', workflowId: saved.id, values: {}, agentId: f.agent.id, model: DEFAULT_MODEL, limits: { ...DEFAULT_LIVE_LIMITS }, idempotencyKey: randomUUID() }).createdTaskId!;
    assert.equal(f.c.workflows.requirementsForTask(replay), null);
    await f.c.workflows.assertInputsReady(replay);
    assert.match((await f.c.workflows.taskReadiness(replay)).outcome, /report/);
  } finally { await f.close(); }
});

test('definition integrity checks reject damaged procedure snapshots and input substitution is not recursive', () => {
  const definition = structuredClone(WORKFLOW_RECIPES[0].procedure!);
  assert.equal(readProcedure(JSON.stringify(definition)).versionId, definition.versionId);
  definition.objectiveTemplate += 'changed';
  assert.throws(() => readProcedure(JSON.stringify(definition)), /damaged/);
  const { versionId: _, ...data } = definition;
  assert.notEqual(procedureVersion(data), definition.versionId);
  assert.equal(renderProcedure('Question: {{question}}; source: {{sources}}', { question: '{{sources}}', sources: 'https://example.com' }), 'Question: {{sources}}; source: https://example.com');
});

test('new file versions do not replace assigned inputs and a removed pin is rejected', async () => {
  const f = await fixture(); try {
    const taskId = f.task(), first = await f.add(taskId, 'v1.csv', 'a\n1\n'), second = await f.add(taskId, 'v2.csv', 'a\n2\n');
    f.assign(taskId, 'current_data', first); f.assign(taskId, 'comparison_data', second);
    await f.add(taskId, 'new.csv', 'a\n9\n');
    assert.equal(f.c.workflows.inputContext(taskId)[0].versionId, first);
    const db = new DatabaseSync(f.c.databasePath); try { db.prepare('DELETE FROM task_artifacts WHERE task_id=? AND version_id=?').run(taskId, first); } finally { db.close(); }
    assert.equal((await f.c.workflows.checkInputs(taskId))[0].status, 'rejected');
  } finally { await f.close(); }
});

test('detailed Gmail review is an explicit task option and named saved procedures do not copy it',async()=>{const f=await fixture();try{const values={account:'fixture@gmail.com',focus:'Identify urgent questions'},create=(mailDetail?:boolean)=>f.c.workflows.handle({type:'workflows.createTask',workflowId:'gmail-triage',values,agentId:f.agent.id,model:DEFAULT_MODEL,limits:{...DEFAULT_LIVE_LIMITS},idempotencyKey:randomUUID(),...(mailDetail!==undefined?{mailDetail}:{})}).createdTaskId!;const basic=create(),detailed=create(true);let state=await f.c.live.state();assert.equal(state.tasks.find(t=>t.taskId===basic)!.policy.mailDetail,undefined);assert.equal(state.tasks.find(t=>t.taskId===detailed)!.policy.mailDetail,'threads_and_attachments');assert.throws(()=>f.c.workflows.handle({type:'workflows.createTask',workflowId:'data-report',values:{question:'Compare',files:'Two periods'},agentId:f.agent.id,model:DEFAULT_MODEL,limits:{...DEFAULT_LIVE_LIMITS},idempotencyKey:randomUUID(),mailDetail:true}),/exact Gmail account/);const saved=f.c.workflows.handle({type:'workflows.saveFromTask',taskId:detailed,title:'Repeat review',description:'',category:'personal',idempotencyKey:randomUUID(),parameterized:true}).saved[0];const reused=f.c.workflows.handle({type:'workflows.createTask',workflowId:saved.id,values,agentId:f.agent.id,model:DEFAULT_MODEL,limits:{...DEFAULT_LIVE_LIMITS},idempotencyKey:randomUUID()}).createdTaskId!;state=await f.c.live.state();assert.equal(state.tasks.find(t=>t.taskId===reused)!.policy.mailDetail,undefined);}finally{await f.close();}});

test('manual Gmail policy and pinned PDF requirements cannot disappear with no procedure definition',async()=>{const f=await fixture();try{const mail=f.c.createLiveTask({type:'live.createTask',agentId:f.agent.id,objective:'Review inbox',completionCriteria:'A useful brief',model:DEFAULT_MODEL,limits:{...DEFAULT_LIVE_LIMITS},policy:{mode:'read_only_browser',allowedOrigins:['https://mail.google.com'],mailAccount:'fixture@gmail.com'}});const manual=f.c.createLiveTask({type:'live.createTask',agentId:f.agent.id,objective:'Review supplied document',completionCriteria:'A sourced brief',model:DEFAULT_MODEL,limits:{...DEFAULT_LIVE_LIMITS},policy:{mode:'workspace',allowedOrigins:[]}});assert.ok((await f.c.workflows.taskReadiness(mail)).capabilities.includes('gmail'));assert.deepEqual((await f.c.workflows.taskReadiness(manual)).capabilities,[]);await f.add(manual,'source.pdf','%PDF-1.7\n');const requirements=await f.c.workflows.taskReadiness(manual);assert.deepEqual(requirements.capabilities,['documents']);assert.deepEqual(requirements.documentInputs,[{format:'pdf',bytes:9,available:true}]);assert.equal(requirements.googleWorkspaceAccount,undefined);assert.equal((await f.c.live.state()).tasks.find(t=>t.taskId===manual)!.calls,0);}finally{await f.close();}});
