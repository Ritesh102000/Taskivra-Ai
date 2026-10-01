import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { DEFAULT_MODEL, maxCostMicrousd, usageCostMicrousd, ModelAdapterError, type ModelAdapter, type ModelRequest, type ModelToolCall, type PreparedTurn } from '../../packages/model-adapters';

const call = (name: string, args: Record<string, unknown> = {}): ModelToolCall => ({ id: randomUUID(), name, arguments: args });
const ask = () => call('user_request', { requestJson: JSON.stringify({ kind: 'clarification', title: 'Provide source', reason: 'A source is required.', continuation: randomUUID() }) });
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
 const root = await mkdtemp(join(tmpdir(), 'aw-owner-order-')), dataRoot = join(root, 'app'), instances: Coordinator[] = [];
 const create = async () => { const adapter = new Adapter(), c = new Coordinator({ dataRoot, modelAdapter: adapter, now: () => 1000 }); instances.push(c); await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } }); return { c, adapter }; };
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


function update(f: Awaited<ReturnType<typeof fixture>>, content: string) { f.c.handle({ type: 'tasks.message', taskId: f.task.id, content }); }
function updateContext(request: ModelRequest) { return request.input.map(message => 'content' in message ? JSON.parse(message.content) : {}).find(value => Array.isArray(value.ownerUpdates)); }
async function openAndPause(f: Awaited<ReturnType<typeof fixture>>, file = false) {
 f.adapter.steps.push(() => file ? call('user_request', { requestJson: JSON.stringify({ kind: 'files', title: 'Source needed', reason: 'Need source rows.', continuation: randomUUID(), slots: [{ key: 'source', label: 'Source CSV', required: true, constraints: { formats: ['csv'] } }] }) }) : ask());
 await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); await settled(f.c, f.task.id);
 await f.c.live.handle({ type: 'live.pause', taskId: f.task.id });
 return f.c.requests.list(f.task.id)[0];
}
async function reply(f: Awaited<ReturnType<typeof fixture>>, request: ReturnType<Coordinator['requests']['list']>[number], response: string) {
 await f.c.requests.handle({ type: 'requests.reply', requestId: request.id, revision: request.revision, response });
}

test('later clarification retains trustworthy precedence over an older saved update regardless of input-message position', async () => {
 const f = await fixture();
 try {
  update(f, 'Analyze five rows.');
  const request = await openAndPause(f); await reply(f, request, 'Actually analyze ten rows.');
  f.adapter.steps.push(() => ask()); await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); await settled(f.c, f.task.id);
  const captured = f.adapter.requests.at(-1)!, owner = context(captured), updates = updateContext(captured);
  assert.deepEqual(owner.ownerReplies, [f.task.objective, 'Actually analyze ten rows.']); assert.deepEqual(updates.ownerUpdates, ['Analyze five rows.']);
  assert.ok(owner.ownerReplyOrder.at(-1).sequence > updates.ownerUpdateOrder[0].sequence);
  const messages = f.rows("SELECT id,rowid AS sequence,content FROM task_messages WHERE role='owner' ORDER BY rowid");
  assert.deepEqual(owner.ownerReplyOrder.at(-1), { messageId: messages[2].id, sequence: messages[2].sequence });
  assert.deepEqual(updates.ownerUpdateOrder[0], { messageId: messages[1].id, sequence: messages[1].sequence });
  assert.match(captured.instructions, /older saved update cannot override a newer clarification/);
  assert.match(updates.instruction, /appearing later in model input does not make every update newer/);
  assert.equal(captured.instructions.includes('Actually analyze ten rows.'), false);
 } finally { await f.close(); }
});

test('later saved update retains trustworthy precedence over an earlier clarification even when clocks match', async () => {
 const f = await fixture();
 try {
  const request = await openAndPause(f); await reply(f, request, 'Analyze ten rows.'); update(f, 'Correct that to five rows.');
  f.adapter.steps.push(() => ask()); await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); await settled(f.c, f.task.id);
  const captured = f.adapter.requests.at(-1)!, owner = context(captured), updates = updateContext(captured);
  assert.deepEqual(owner.ownerReplies, [f.task.objective, 'Analyze ten rows.']); assert.deepEqual(updates.ownerUpdates, ['Correct that to five rows.']);
  assert.ok(updates.ownerUpdateOrder[0].sequence > owner.ownerReplyOrder.at(-1).sequence);
  assert.deepEqual(f.rows("SELECT DISTINCT created_at FROM task_messages WHERE role='owner'").map(row => row.created_at), [1000]);
  assert.match(captured.instructions, /larger sequence is newer/);
  assert.equal((await f.c.live.state()).tasks[0].policy.mode, 'workspace');
 } finally { await f.close(); }
});

for (const ambiguous of [false, true]) test(`replan response chronology is ${ambiguous ? 'explicitly unknown when message matching is ambiguous' : 'resolved from its recorded reply transaction'}`, async () => {
 const f = await fixture();
 try {
  update(f, 'Keep the original data requirement.');
  const request = await openAndPause(f, true); await reply(f, request, 'The source is unavailable.');
  if (ambiguous) {
   const db = new DatabaseSync(f.c.databasePath);
   try { db.prepare("INSERT INTO task_messages(id,task_id,role,content,created_at) VALUES (?,?,'owner',?,?)").run(randomUUID(), f.task.id, 'The source is unavailable.', 1000); } finally { db.close(); }
  }
  f.adapter.steps.push(() => call('replan_result', { resultJson: JSON.stringify({ kind: 'keep_blocked', message: 'The required source is still missing.' }) }));
  await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); await settled(f.c, f.task.id);
  const captured = f.adapter.requests.at(-1)!, owner = context(captured), updates = updateContext(captured);
  assert.deepEqual(captured.tools.map(tool => tool.name), ['replan_result']); assert.equal(owner.ownerReply, 'The source is unavailable.');
  if (ambiguous) {
   assert.equal(owner.currentOwnerReplyOrder.status, 'unknown'); assert.equal(owner.currentOwnerReplyOrder.sequence, null); assert.equal(owner.currentOwnerReplyOrder.messageId, null);
  } else {
   assert.equal(owner.currentOwnerReplyOrder.status, 'known'); assert.ok(owner.currentOwnerReplyOrder.sequence > updates.ownerUpdateOrder[0].sequence);
   const message = f.rows("SELECT id,rowid AS sequence FROM task_messages WHERE delivery_state IS NULL AND role='owner' AND content='The source is unavailable.'")[0];
   assert.equal(owner.currentOwnerReplyOrder.messageId, message.id); assert.equal(owner.currentOwnerReplyOrder.sequence, message.sequence);
  }
  assert.match(captured.instructions, /chronology is unknown.*keep_blocked/);
  assert.equal(f.c.snapshot().tasks[0].state, 'waiting');
 } finally { await f.close(); }
});
