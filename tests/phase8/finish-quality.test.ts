import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import { ResultService } from '../../packages/results';
import type { Persistence } from '../../packages/persistence';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { DEFAULT_MODEL, maxCostMicrousd, usageCostMicrousd, type ModelAdapter, type ModelRequest, type ModelToolCall, type ModelTurn, type PreparedTurn } from '../../packages/model-adapters';

const call = (name: string, args: Record<string, unknown>): ModelToolCall => ({ id: 'call_' + randomUUID(), name, arguments: args });
const context = (request: ModelRequest): any => JSON.parse((request.input[0] as { content: string }).content);
class ScriptedAdapter implements ModelAdapter {
  steps: Array<(request: ModelRequest) => ModelToolCall> = []; calls = 0; pending = new Map<string, ModelRequest>();
  async status() { return { configured: true, message: null, provider: 'openai', model: DEFAULT_MODEL }; }
  prepare(request: ModelRequest): PreparedTurn { const text = JSON.stringify(request), prepared = { id: randomUUID(), model: DEFAULT_MODEL, requestHash: createHash('sha256').update(text).digest('hex'), requestBytes: Buffer.byteLength(text), maxOutputTokens: request.maxOutputTokens }; this.pending.set(prepared.id, structuredClone(request)); return Object.freeze(prepared); }
  async quote(prepared: PreparedTurn) { return { inputTokens: 100, outputTokens: prepared.maxOutputTokens, maxCostMicrousd: maxCostMicrousd(DEFAULT_MODEL, 100, prepared.maxOutputTokens) }; }
  async complete(prepared: PreparedTurn): Promise<ModelTurn> { this.calls++; const step = this.steps.shift(); assert.ok(step, 'Unexpected additional model step'); const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, totalTokens: 120 }; return { responseId: 'resp_' + randomUUID(), text: '', toolCalls: [step(this.pending.get(prepared.id)!)], usage, costMicrousd: usageCostMicrousd(DEFAULT_MODEL, usage) }; }
  discard(prepared: PreparedTurn) { this.pending.delete(prepared.id); }
}
async function waitForTask(c: Coordinator, id: string) {
  for (let i = 0; i < 500; i++) { const task = c.snapshot().tasks.find(task => task.id === id)!; if (!(await c.live.state()).busy && ['paused', 'failed', 'succeeded', 'cancelled'].includes(task.state)) return task; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('The fixture task did not settle within five seconds.');
}

test('live finish refuses missing workflow headings, exposes the defect, and completes only the corrected saved output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-finish-quality-')), adapter = new ScriptedAdapter(), c = new Coordinator({ dataRoot: join(root, 'data'), modelAdapter: adapter });
  try {
    await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
    const agent = c.handle({ type: 'agents.create', name: 'Quality loop fixture', instructions: '' }).agents[0];
    const created = await c.workflows.handle({ type: 'workflows.createTask', workflowId: 'code-review', values: { focus: 'Review only the synthetic supplied fixture.', files: 'fixture.txt' }, agentId: agent.id, model: DEFAULT_MODEL, limits: DEFAULT_LIVE_LIMITS, idempotencyKey: randomUUID() });
    const taskId = created.createdTaskId!; assert.ok(taskId);
    const path = join(root, 'fixture.txt'); await writeFile(path, 'This synthetic fixture has two observations.');
    const versionId = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId }, paths: [path] })).versionIds[0];
    let rejectedVersion = '', correctedVersion = '';
    const lastReport = (request: ModelRequest) => context(request).savedObservations.filter((entry: any) => entry.tool === 'save_report').at(-1).result.versionId;
    const evidence = (request: ModelRequest) => context(request).evidence.find((entry: any) => entry.tool === 'read_file').evidenceId;
    adapter.steps.push(
      request => { assert.deepEqual(context(request).outputRequirements.sections, ['Findings', 'Sources and coverage', 'Limitations']); return call('read_file', { versionId }); },
      request => call('save_report', { name: 'report.md', content: '# Findings\nThe fixture has two observations.', evidenceIds: [evidence(request)] }),
      request => { rejectedVersion = lastReport(request); return call('finish', { outputVersionId: rejectedVersion, summary: 'Attempt to finish incomplete structure.' }); },
      request => {
        assert.notEqual(c.snapshot().tasks.find(task => task.id === taskId)!.state, 'succeeded'); assert.equal(c.results.state().results.length, 0);
        const rejected = context(request).savedObservations.find((entry: any) => entry.tool === 'finish' && entry.code === 'output_required'); assert.ok(rejected); assert.match(rejected.error, /Missing required headings: Sources and coverage, Limitations/);
        return call('save_report', { name: 'corrected.md', content: `# Findings\nThe fixture has two observations.\n# Sources and coverage\nRead exact input artifact:${versionId}.\n# Limitations\nSynthetic fixture only; no real code tests were run.`, evidenceIds: [evidence(request)] });
      },
      request => { correctedVersion = lastReport(request); assert.notEqual(correctedVersion, rejectedVersion); return call('finish', { outputVersionId: correctedVersion, summary: 'Saved the report with required sections and disclosed its scope.' }); },
    );
    await c.live.handle({ type: 'live.start', taskId }); const task = await waitForTask(c, taskId); assert.equal(task.state, 'succeeded'); assert.equal(adapter.calls, 5);
    const final = await c.results.inspect(taskId, correctedVersion); assert.equal(final.quality.canFinish, true); assert.equal(final.result.review.state, 'unreviewed'); assert.equal(final.result.version.id, correctedVersion); assert.equal(final.canRequestChanges, true);
    const db = new DatabaseSync(c.databasePath); try {
      const finishes = db.prepare("SELECT state,result_json FROM live_tool_receipts WHERE task_id=? AND tool_name='finish' ORDER BY rowid").all(taskId);
      assert.deepEqual(finishes.map(row => row.state), ['failed', 'succeeded']); assert.equal(JSON.parse(String(finishes[1].result_json)).quality.sourceVersionId, correctedVersion);
      assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE type='live.completed' AND aggregate_id=?").get(taskId)!.n, 1);
    } finally { db.close(); }
  } finally { await c.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('a restricted source cannot create a generic revision or change owner review state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-revision-scope-')), c = new Coordinator({ dataRoot: join(root, 'data') }); let db: DatabaseSync | undefined;
  try {
    await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
    const agent = c.handle({ type: 'agents.create', name: 'Restricted result fixture', instructions: '' }).agents[0];
    const taskId = c.createLiveTask({ type: 'live.createTask', agentId: agent.id, objective: 'Create a scoped fixture report.', completionCriteria: 'Report only supplied fixture observations.', model: DEFAULT_MODEL, policy: { mode: 'workspace', allowedOrigins: [] }, limits: DEFAULT_LIVE_LIMITS });
    const path = join(root, 'report.md'); await writeFile(path, '# Fixture report\nA bounded source.');
    const versionId = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId }, paths: [path] })).versionIds[0];
    db = new DatabaseSync(c.databasePath); db.prepare("UPDATE task_artifacts SET role='output' WHERE task_id=? AND version_id=?").run(taskId, versionId); db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(taskId); db.prepare('UPDATE live_task_config SET result_version_id=? WHERE task_id=?').run(versionId, taskId);
    let checked = '', created = false;
    const service = new ResultService({ persistence: { db } as unknown as Persistence, artifacts: c.artifacts, createTask: () => { created = true; throw new Error('A restricted source must not reach task creation.'); }, canReviseSource: id => id !== taskId, assertRevisionSource: id => { checked = id; throw new Error('Prepare a new scoped review for another revision.'); } });
    const detail = await service.inspect(taskId, versionId); assert.equal(detail.canRequestChanges, false); assert.equal(detail.result.review.state, 'unreviewed'); assert.equal(detail.integrity, 'verified'); assert.match(detail.preview.text!, /bounded source/);
    await assert.rejects(service.handle({ type: 'results.requestChanges', taskId, versionId, revision: 0, feedback: 'Revise the result.', limits: DEFAULT_LIVE_LIMITS, idempotencyKey: randomUUID() }), /new scoped review/);
    assert.equal(checked, taskId); assert.equal(created, false); assert.equal(c.snapshot().tasks.length, 1); assert.equal(service.state().results[0].review.state, 'unreviewed');
    for (const table of ['result_reviews', 'result_actions', 'result_revision_jobs']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
  } finally { db?.close(); await c.shutdown(); await rm(root, { recursive: true, force: true }); }
});
