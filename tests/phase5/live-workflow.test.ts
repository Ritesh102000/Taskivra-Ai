import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import { DockerCodeRuntimeFactory } from '../../packages/code-runtime';
import { OpenAIResponsesAdapter, MacKeychainCredentials, DEFAULT_MODEL } from '../../packages/model-adapters';
import type { UserRequest } from '../../packages/contracts/requests';

const enabled = process.env.AW_PHASE5_LIVE_WORKFLOW === '1';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function query(c: Coordinator, sql: string, ...args: string[]) { const db = new DatabaseSync(c.databasePath); try { return db.prepare(sql).all(...args) as Record<string, any>[]; } finally { db.close(); } }
async function until(c: Coordinator, test: () => boolean, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (test()) return; c.tick(); await delay(100); }
  throw new Error('The bounded live workflow did not reach the expected checkpoint.');
}

// No credential, network, Docker or filesystem work happens unless this separate flag is set.
// The synthetic task budget is $0.10, below the separately authorized $0.20 test ceiling.
test('explicit opt-in: real OpenAI asks for two files, survives blocked restart, then Docker verifies sum20', { skip: !enabled, timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-phase5-live-')), dataRoot = join(root, 'app');
  const instances: Coordinator[] = [], runtimes: DockerCodeRuntimeFactory[] = [];
  let c!: Coordinator, taskId = '', checkpoint = 'starting';
  const create = async () => {
    await mkdir(dataRoot, { recursive: true });
    const runtime = new DockerCodeRuntimeFactory({ dataRoot }); runtimes.push(runtime);
    const configured = await runtime.status(); assert.equal(configured.ready, true, 'The existing local code image and Docker Desktop must be ready; this test never builds or pulls.');
    const adapter = new OpenAIResponsesAdapter({ credentials: new MacKeychainCredentials({ helperPath: resolve('packages/model-adapters/bin/keychain-helper') }) });
    assert.equal((await adapter.status()).configured, true, 'Configure the existing native OpenAI Keychain item first.');
    c = new Coordinator({ dataRoot, codeRuntime: runtime, modelAdapter: adapter }); instances.push(c); await c.live.ready; await c.requests.ready;
    c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
    return configured;
  };
  try {
    const runtimeStatus = await create();
    const agent = c.handle({ type: 'agents.create', name: 'Two-file live fixture', instructions: '' }).agents[0];
    const requestSpec = { kind: 'files', title: 'Provide both CSV inputs', reason: 'The calculation requires the value column from both inputs.', continuation: 'sum-two-csv-inputs', slots: [
      { key: 'left', label: 'Left CSV', required: true, constraints: { formats: ['csv'], csv: { requiredColumns: ['value'], minRows: 1 } } },
      { key: 'right', label: 'Right CSV', required: true, constraints: { formats: ['csv'], csv: { requiredColumns: ['value'], minRows: 1 } } },
    ] };
    await c.live.handle({ type: 'live.createTask', agentId: agent.id, model: DEFAULT_MODEL, policy: { mode: 'workspace', allowedOrigins: [] }, limits: { maxCostUsd: 0.10, maxModelCalls: 20, maxToolSteps: 30, maxActiveSeconds: 180, maxTokens: 60_000 }, objective: `Compute the sum of all numeric values in two CSV files that the owner will provide. Neither input is available yet. Your FIRST tool must be user_request with requestJson equal to this JSON: ${JSON.stringify(requestSpec)}. Wait until both required slots are accepted. Do not waive either slot or use a rejected candidate. Once both are accepted, use code_execute with Python standard-library csv/json to read exactly those two accepted version IDs and write outputs/sum.json containing {"sum": <computed numeric total>}. Their container paths are /workspace/inputs/<versionId>/content.csv. Pass both version IDs as inputVersionIds. Do not use network or packages. Finish with the verified container output version ID; no publication or browser action is authorized.`, completionCriteria: 'Both required CSV inputs are validated, a real isolated Python execution computes their combined numeric total, and an existing checksum-verified outputs/sum.json is the final deliverable.' });
    taskId = c.snapshot().tasks[0].id; checkpoint = 'waiting_for_request';
    await c.live.handle({ type: 'live.start', taskId });
    await until(c, () => c.snapshot().tasks.find(t => t.id === taskId)!.state === 'waiting' && c.requests.list(taskId).some(r => r.kind === 'files'));
    let request: UserRequest = c.requests.list(taskId).find(r => r.kind === 'files')!;
    assert.deepEqual(request.slots.map(s => s.key).sort(), ['left', 'right']); assert.equal(request.slots.every(s => s.required), true);
    const importFixture = async (name: string, text: string) => { const path = join(root, name); await writeFile(path, text); return (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId: null }, paths: [path] })).versionIds[0]; };
    const leftText = 'value\n3\n7\n', wrongText = 'wrong_column\n999\n', rightText = 'value\n4\n6\n';
    const left = await importFixture('left.csv', leftText), wrong = await importFixture('wrong.csv', wrongText);
    await c.requests.handle({ type: 'requests.assign', requestId: request.id, revision: request.revision, assignments: request.slots.map(slot => ({ slotId: slot.id, slotRevision: slot.revision, versionId: slot.key === 'left' ? left : wrong })) });
    await c.requests.drainValidations(); request = c.requests.list(taskId).find(r => r.id === request.id)!;
    assert.equal(request.slots.find(s => s.key === 'left')!.state, 'accepted'); assert.equal(request.slots.find(s => s.key === 'right')!.state, 'needs_replacement'); assert.notEqual(request.state, 'fulfilled');
    assert.equal(c.snapshot().tasks.find(t => t.id === taskId)!.state, 'waiting'); assert.equal(query(c, 'SELECT * FROM code_executions').length, 0); assert.equal(query(c, 'SELECT * FROM resume_receipts WHERE request_id=?', request.id).length, 0);
    checkpoint = 'wrong_file_blocked';
    const acceptedRevision = request.slots.find(s => s.key === 'left')!.revision, beforeRestartCalls = (await c.live.state()).tasks[0].calls;
    await c.shutdown(); await create();
    request = c.requests.list(taskId).find(r => r.id === request.id)!;
    assert.equal(c.snapshot().tasks.find(t => t.id === taskId)!.state, 'waiting'); assert.equal(request.slots.find(s => s.key === 'left')!.candidateVersionId, left); assert.equal(request.slots.find(s => s.key === 'left')!.state, 'accepted'); assert.equal((await c.live.state()).tasks[0].calls, beforeRestartCalls);
    checkpoint = 'blocked_restart_verified';
    const right = await importFixture('right.csv', rightText), rightSlot = request.slots.find(s => s.key === 'right')!;
    const replacement = { type: 'requests.assign' as const, requestId: request.id, revision: request.revision, assignments: [{ slotId: rightSlot.id, slotRevision: rightSlot.revision, versionId: right }] };
    await c.requests.handle(replacement); await c.requests.handle(replacement); await c.requests.drainValidations();
    request = c.requests.list(taskId).find(r => r.id === request.id)!;
    assert.equal(request.state, 'fulfilled'); assert.equal(request.slots.find(s => s.key === 'left')!.revision, acceptedRevision); assert.equal(query(c, 'SELECT * FROM resume_receipts WHERE request_id=?', request.id).length, 1); assert.equal(c.snapshot().tasks.find(t => t.id === taskId)!.state, 'queued');
    checkpoint = 'one_continuation_queued';
    const priorRuns = query(c, 'SELECT * FROM runs WHERE task_id=?', taskId).length;
    await until(c, () => ['succeeded', 'failed', 'paused', 'cancelled'].includes(c.snapshot().tasks.find(t => t.id === taskId)!.state));
    const finalTask = c.snapshot().tasks.find(t => t.id === taskId)!, state = (await c.live.state()).tasks.find(t => t.taskId === taskId)!;
    checkpoint = 'continuation_settled';
    assert.equal(finalTask.state, 'succeeded', state.lastError || 'The live task did not complete.'); assert.equal(query(c, 'SELECT * FROM runs WHERE task_id=?', taskId).length, priorRuns + 1);
    assert.ok(state.resultVersionId); assert.ok(state.costUsd + state.reservedUsd <= 0.10); assert.ok(state.calls <= 20);
    const executions = (await c.code.handle({ type: 'code.state', taskId })).executions;
    const successful = executions.filter(e => e.lifecycle === 'succeeded' && e.workspaceCommitted); assert.ok(successful.length > 0);
    assert.ok(successful.some(e => e.inputs.length === 2 && e.inputs.map(i => i.versionId).sort().join(',') === [left, right].sort().join(','))); assert.equal(executions.some(e => e.inputs.some(i => i.versionId === wrong)), false);
    const outputIds = new Set(successful.flatMap(e => e.outputVersionIds));
    const output = c.snapshot().artifacts.find(v => outputIds.has(v.id) && v.displayName === 'sum.json'); assert.ok(output, 'The real container must produce sum.json.');
    const preview = await c.artifacts.preview({ principal: { kind: 'owner' }, versionId: output.id }); assert.ok(preview.text); assert.equal(JSON.parse(preview.text).sum, 20); assert.equal(hash(preview.text), output.sha256);
    const finalPreview = await c.artifacts.preview({ principal: { kind: 'owner' }, versionId: state.resultVersionId! }); assert.ok(finalPreview.version.bytes > 0);
    assert.equal(c.snapshot().events.some(e => e.type === 'artifact.published'), false);
    if (process.env.AW_MODEL_EVIDENCE === '1') {
      const directory = resolve('packages/model-adapters/evidence'); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'live-workflow.json'), JSON.stringify({ checkedAt: new Date().toISOString(), synthetic: true, model: DEFAULT_MODEL, imageDigest: runtimeStatus.imageDigest, goodInputSha256: [hash(leftText), hash(rightText)], rejectedInputSha256: hash(wrongText), blockedWithWrongFile: true, restartPreservedAcceptedSlot: true, fulfillmentReceipts: 1, continuationRuns: 1, realCodeExecutions: successful.length, verifiedSum: 20, outputSha256: output.sha256, outputBytes: output.bytes, finalState: finalTask.state, modelCalls: state.calls, inputTokens: state.inputTokens, outputTokens: state.outputTokens, costUsd: state.costUsd, reservedUsd: state.reservedUsd, taskBudgetUsd: 0.10, credentialsOmitted: true }, null, 2) + '\n', { mode: 0o600 });
    }
  } catch (cause) {
    if (process.env.AW_MODEL_EVIDENCE === '1' && c && taskId) {
      try {
        const state = (await c.live.state()).tasks.find(t => t.taskId === taskId), task = c.snapshot().tasks.find(t => t.id === taskId);
        const summaries = query(c, 'SELECT tool_name,state,result_json FROM live_tool_receipts ORDER BY created_at').map(row => { const result = JSON.parse(row.result_json || '{}'); return { tool: row.tool_name, state: row.state, error: typeof result.error === 'string' ? result.error : null }; });
        const executions = query(c, 'SELECT lifecycle,exit_code,workspace_committed,image_digest,error FROM code_executions');
        const directory = resolve('packages/model-adapters/evidence'); await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `live-workflow-failure-${Date.now()}.json`), JSON.stringify({ checkedAt: new Date().toISOString(), synthetic: true, passed: false, checkpoint, finalState: task?.state, modelCalls: state?.calls, costUsd: state?.costUsd, reservedUsd: state?.reservedUsd, taskBudgetUsd: 0.10, lastError: state?.lastError, tools: summaries, executions, credentialsOmitted: true }, null, 2) + '\n', { mode: 0o600 });
      } catch { /* Never mask the original assertion if diagnostic recording fails. */ }
    }
    throw cause;
  } finally { for (const instance of instances) await instance.shutdown(); for (const runtime of runtimes) await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
