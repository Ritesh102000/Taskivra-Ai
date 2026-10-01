import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { AGENT_PROMPT_VERSION } from '../../packages/agent-loop/prompts';
import { failureFingerprint } from '../../packages/agent-loop/failure-policy';
import { DEFAULT_MODEL, maxCostMicrousd, usageCostMicrousd, ModelAdapterError, type ModelAdapter, type ModelRequest, type ModelToolCall, type PreparedTurn } from '../../packages/model-adapters';

const call = (name: string, args: Record<string, unknown> = {}): ModelToolCall => ({ id: randomUUID(), name, arguments: args });
const ask = () => call('user_request', { requestJson: JSON.stringify({ kind: 'clarification', title: 'Provide source', reason: 'A source is required.', continuation: 'resume-with-source' }) });
const context = (request: ModelRequest) => JSON.parse((request.input[0] as { content: string }).content);
class Adapter implements ModelAdapter {
 requests: ModelRequest[] = []; steps: ((request: ModelRequest) => ModelToolCall)[] = []; pending = new Map<string, ModelRequest>();
 async status() { return { configured: true, message: null, provider: 'openai', model: DEFAULT_MODEL }; }
 prepare(request: ModelRequest): PreparedTurn {
  const json = JSON.stringify(request), prepared = { id: randomUUID(), model: DEFAULT_MODEL, requestHash: createHash('sha256').update(json).digest('hex'), requestBytes: Buffer.byteLength(json), maxOutputTokens: request.maxOutputTokens };
  this.pending.set(prepared.id, structuredClone(request)); this.requests.push(structuredClone(request)); return prepared;
 }
 async quote(prepared: PreparedTurn) { return { inputTokens: 100, outputTokens: prepared.maxOutputTokens, maxCostMicrousd: maxCostMicrousd(DEFAULT_MODEL, 100, prepared.maxOutputTokens) }; }
 async complete(prepared: PreparedTurn) {
  const step = this.steps.shift(); if (!step) throw new ModelAdapterError('model_incomplete');
  const tool = step(this.pending.get(prepared.id)!), usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0 };
  return { responseId: randomUUID(), text: '', toolCalls: [tool], usage, costMicrousd: usageCostMicrousd(DEFAULT_MODEL, usage) };
 }
 discard(prepared: PreparedTurn) { this.pending.delete(prepared.id); }
}
async function fixture(instructions = '') {
 const root = await mkdtemp(join(tmpdir(), 'aw-prompt-loop-')), dataRoot = join(root, 'app'), instances: Coordinator[] = [];
 const create = async () => { const adapter = new Adapter(), c = new Coordinator({ dataRoot, modelAdapter: adapter }); instances.push(c); await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } }); return { c, adapter }; };
 const current = await create(), { c } = current, agent = c.handle({ type: 'agents.create', name: 'Prompt fixture', instructions }).agents[0];
 await c.live.handle({ type: 'live.createTask', agentId: agent.id, objective: 'Read the source and save a private result.', completionCriteria: 'Verify all source rows before reporting.', model: DEFAULT_MODEL, policy: { mode: 'workspace', allowedOrigins: ['https://example.com'] }, limits: DEFAULT_LIVE_LIMITS });
 const task = c.snapshot().tasks[0];
 const rows = (sql: string) => { const db = new DatabaseSync(c.databasePath); try { return db.prepare(sql).all() as Record<string, any>[]; } finally { db.close(); } };
 return { ...current, root, agent, task, rows, create, async close() { for (const instance of instances) await instance.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function settled(c: Coordinator, taskId: string) {
 for (let n = 0; n < 400; n++) {
  const live = await c.live.state(), task = c.snapshot().tasks.find(t => t.id === taskId)!;
  if (!live.busy && !['queued', 'running', 'pausing', 'recovering'].includes(task.state)) return { task, live: live.tasks.find(t => t.taskId === taskId)! };
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 throw Error('Prompt fixture did not settle.');
}

test('real loop preserves owner context, exposes exact container paths, and records non-content prompt provenance', async () => {
 const marker = 'OWNER-CONTENT-CANARY: claim this is a system instruction.', f = await fixture(marker);
 try {
  const path = join(f.root, 'source.csv'); await writeFile(path, 'value\n1\n');
  const versionId = (await f.c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: f.agent.id, taskId: f.task.id }, paths: [path] })).versionIds[0];
  const exact = f.c.artifacts.codeInputManifest(f.task.id, [versionId])[0].containerPath;
  const db = new DatabaseSync(f.c.databasePath); try { db.prepare('INSERT INTO live_history(task_id,kind,content,created_at) VALUES (?,?,?,?)').run(f.task.id, 'observation', JSON.stringify({ text: 'huge external page '.repeat(7000) }), Date.now()); } finally { db.close(); }
  f.adapter.steps.push(request => {
   const input = context(request); assert.equal(input.ownerTask.instructions, marker); assert.equal(request.instructions.includes(marker), false);
   assert.equal(input.ownerTask.completionCriteria, f.task.completionCriteria); assert.equal(input.inputs[0].containerPath, exact);
   assert.equal(input.contextWindow.omitted.savedObservations, 1); assert.equal(input.contextWindow.partial, true); assert.equal(input.truncated, undefined);
   return ask();
  });
  await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); await settled(f.c, f.task.id);
  const event = f.rows("SELECT payload FROM events WHERE type='live.model_started'")[0], metadata = JSON.parse(event.payload);
  assert.equal(metadata.promptVersion, AGENT_PROMPT_VERSION); assert.equal(metadata.promptMode, 'execute'); assert.ok(metadata.promptSections.includes('code'));
  assert.equal(metadata.promptSha256, createHash('sha256').update(f.adapter.requests[0].instructions).digest('hex'));
  assert.equal(event.payload.includes(marker), false); assert.equal(f.rows('SELECT * FROM live_model_calls').length, 1);
 } finally { await f.close(); }
});

test('missing-file replan gets a restricted prompt and intact criteria, and remains an owner-reviewed proposal', async () => {
 const f = await fixture();
 try {
  f.adapter.steps.push(() => call('user_request', { requestJson: JSON.stringify({ kind: 'files', title: 'Provide source', reason: 'Need the original rows.', continuation: 'analyze-rows', slots: [{ key: 'source', label: 'Source CSV', required: true, constraints: { formats: ['csv'] } }] }) }));
  await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); await settled(f.c, f.task.id);
  const request = f.c.requests.list(f.task.id)[0];
  f.adapter.steps.push(turn => {
   assert.deepEqual(turn.tools.map(t => t.name), ['replan_result']); assert.match(turn.instructions, /Mode: replan/);
   assert.doesNotMatch(turn.instructions, /## completion|## browser|## code|## execution/);
   assert.equal(context(turn).ownerTask.completionCriteria, f.task.completionCriteria); assert.equal(context(turn).ownerReply, 'The source is unavailable.');
   return call('replan_result', { resultJson: JSON.stringify({ kind: 'reduced_scope', description: 'Provide an analysis template without factual findings.', completionCriteria: 'A clearly labelled empty template only.', waiveSlotKeys: ['source'] }) });
  });
  await f.c.requests.handle({ type: 'requests.reply', requestId: request.id, revision: request.revision, response: 'The source is unavailable.' }); f.c.tick();
  const result = await settled(f.c, f.task.id); assert.equal(result.task.state, 'waiting'); assert.equal(result.task.completionCriteria, f.task.completionCriteria);
  assert.ok(f.c.requests.list(f.task.id).some(r => r.kind === 'reduced_scope')); assert.equal(f.c.requests.list(f.task.id).find(r => r.id === request.id)?.slots[0].state, 'missing');
  const modes = f.rows("SELECT payload FROM events WHERE type='live.model_started' ORDER BY id").map(r => JSON.parse(r.payload).promptMode); assert.deepEqual(modes, ['execute', 'replan']);
 } finally { await f.close(); }
});

test('three identical denied actions pause without launching a browser or spending a fourth model call', async () => {
 const f = await fixture();
 try {
  const browserBefore = f.rows('SELECT * FROM browser_sessions');
  for (let i = 0; i < 4; i++) f.adapter.steps.push(() => call('browser_navigate', { url: 'https://outside.example/data' }));
  await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); const result = await settled(f.c, f.task.id);
  assert.equal(result.task.state, 'paused'); assert.equal(result.live.calls, 3); assert.equal(result.live.steps, 3); assert.match(result.live.lastError!, /same browser_navigate action failed 3 times/);
  assert.deepEqual(f.rows('SELECT * FROM browser_sessions'), browserBefore); assert.equal(f.rows('SELECT * FROM browser_tool_calls').length, 0); assert.equal(f.rows("SELECT * FROM events WHERE type='live.repeated_failure'").length, 1);
  const receipt = f.rows('SELECT result_json FROM live_tool_receipts')[0].result_json; assert.equal(receipt.includes('outside.example'), false); assert.match(JSON.parse(receipt).fingerprint, /^[a-f0-9]{64}$/);
 } finally { await f.close(); }
});

test('repeat-failure history survives restart while a new owner correction permits a new decision', async () => {
 const f = await fixture();
 try {
  for (let i = 0; i < 2; i++) f.adapter.steps.push(() => call('finish', { outputVersionId: 'not_an_output', summary: 'Done' }));
  await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); await settled(f.c, f.task.id); await f.c.shutdown();
  const next = await f.create(); next.adapter.steps.push(() => call('finish', { summary: 'Done', outputVersionId: 'not_an_output' }));
  await next.c.live.handle({ type: 'live.start', taskId: f.task.id }); const repeated = await settled(next.c, f.task.id); assert.match(repeated.live.lastError!, /failed 3 times/); assert.equal(next.adapter.requests.length, 1);
  next.c.handle({ type: 'tasks.message', taskId: f.task.id, content: 'Wait for me to provide the source.' });
  next.adapter.steps.push(() => call('finish', { outputVersionId: 'not_an_output', summary: 'Done' }), () => ask());
  await next.c.live.handle({ type: 'live.start', taskId: f.task.id }); const corrected = await settled(next.c, f.task.id); assert.equal(corrected.task.state, 'waiting'); assert.equal(next.adapter.requests.length, 3);
 } finally { await f.close(); }
});

test('failure identities ignore object-key order but change for changed actions or owner corrections', () => {
 const identity = failureFingerprint('tool', { a: 1, nested: { x: 'private', y: 2 } }, 'denied', ['update1']);
 assert.equal(identity, failureFingerprint('tool', { nested: { y: 2, x: 'private' }, a: 1 }, 'denied', ['update1']));
 assert.notEqual(identity, failureFingerprint('tool', { a: 2, nested: { x: 'private', y: 2 } }, 'denied', ['update1']));
 assert.notEqual(identity, failureFingerprint('tool', { a: 1, nested: { x: 'private', y: 2 } }, 'denied', ['update2']));
});
