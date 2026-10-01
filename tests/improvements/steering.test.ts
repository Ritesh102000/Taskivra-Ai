import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import type { BrowserRuntime, BrowserHandle } from '../../packages/browser/runtime';
import type { CodeRuntime } from '../../packages/code/runtime';
import { DEFAULT_LIVE_LIMITS, type LiveLimits } from '../../packages/contracts/live';
import { DEFAULT_MODEL, maxCostMicrousd, usageCostMicrousd, ModelAdapterError, type ModelAdapter, type ModelRequest, type ModelToolCall, type ModelTurn, type PreparedTurn } from '../../packages/model-adapters';

type Step = (request: ModelRequest, signal: AbortSignal) => ModelToolCall | Promise<ModelToolCall>;
const call = (name: string, args: Record<string, unknown> = {}): ModelToolCall => ({ id: 'call_' + randomUUID(), name, arguments: args });
const ask = () => call('user_request', { requestJson: JSON.stringify({ kind: 'clarification', title: 'Choose the next source', reason: 'The revised task needs a source.', continuation: randomUUID() }) });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function within(promise: Promise<void>) { let timer: ReturnType<typeof setTimeout>; try { await Promise.race([promise, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture did not reach the awaited boundary.')), 5000); })]); } finally { clearTimeout(timer!); } }
function context(request: ModelRequest): Record<string, any> { return JSON.parse((request.input[0] as { content: string }).content); }
function updates(request: ModelRequest): string[] { return request.input.flatMap(message => 'content' in message ? JSON.parse(message.content).ownerUpdates ?? [] : []); }
class Adapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []; private pending = new Map<string, ModelRequest>(); steps: Step[] = [];
  async status() { return { configured: true, message: null, provider: 'openai', model: DEFAULT_MODEL }; }
  prepare(request: ModelRequest): PreparedTurn { const body = JSON.stringify(request), prepared = { id: randomUUID(), model: DEFAULT_MODEL, requestHash: createHash('sha256').update(body).digest('hex'), requestBytes: Buffer.byteLength(body), maxOutputTokens: request.maxOutputTokens }; this.pending.set(prepared.id, structuredClone(request)); this.requests.push(structuredClone(request)); return prepared; }
  async quote(prepared: PreparedTurn) { return { inputTokens: 100, outputTokens: prepared.maxOutputTokens, maxCostMicrousd: maxCostMicrousd(DEFAULT_MODEL, 100, prepared.maxOutputTokens) }; }
  async complete(prepared: PreparedTurn, { signal }: { signal: AbortSignal }): Promise<ModelTurn> { const step = this.steps.shift(); if (!step) throw new ModelAdapterError('model_incomplete'); const toolCall = await step(this.pending.get(prepared.id)!, signal), usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0 }; return { responseId: randomUUID(), text: '', toolCalls: [toolCall], usage, costMicrousd: usageCostMicrousd(DEFAULT_MODEL, usage) }; }
  discard(prepared: PreparedTurn) { this.pending.delete(prepared.id); }
}
async function fixture(options: Partial<Pick<ConstructorParameters<typeof Coordinator>[0], 'now' | 'codeRuntime' | 'browserRuntime' | 'artifactFault'>> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aw-steering-')), dataRoot = join(root, 'app'), instances: Coordinator[] = [];
  const create = async (adapter = new Adapter()) => { const c = new Coordinator({ dataRoot, modelAdapter: adapter, ...options }); instances.push(c); await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } }); return { c, adapter }; };
  const current = await create(), { c } = current;
  const agent = c.handle({ type: 'agents.create', name: 'Update fixture', instructions: '' }).agents[0];
  const task = async (limits: Partial<LiveLimits> = {}) => { await c.live.handle({ type: 'live.createTask', agentId: agent.id, objective: 'Read the pinned source and produce a private report.', completionCriteria: 'Verified factual report.', model: DEFAULT_MODEL, policy: { mode: 'workspace', allowedOrigins: ['https://example.com'] }, limits: { ...DEFAULT_LIVE_LIMITS, ...limits } }); return c.snapshot().tasks.at(-1)!; };
  const rows = (sql: string) => { const db = new DatabaseSync(c.databasePath); try { return db.prepare(sql).all() as Record<string, any>[]; } finally { db.close(); } };
  const put = async (taskId: string) => { const path = join(root, 'source.txt'); await writeFile(path, 'Verified source.'); return (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId }, paths: [path] })).versionIds[0]; };
  const close = async () => { for (const instance of instances) await instance.shutdown(); await rm(root, { recursive: true, force: true }); };
  return { ...current, root, dataRoot, agent, task, put, rows, create, close };
}
async function settled(c: Coordinator, taskId: string) { for (let i = 0; i < 500; i++) { const task = c.snapshot().tasks.find(t => t.id === taskId)!, live = await c.live.state(); if (!live.busy && !['queued', 'running', 'recovering', 'pausing'].includes(task.state)) return { task, live: live.tasks.find(t => t.taskId === taskId)! }; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Task did not settle.'); }
function send(c: Coordinator, taskId: string, content: string) { return c.handle({ type: 'tasks.message', taskId, content }); }
const tracked = (c: Coordinator, taskId: string) => c.snapshot().messages.filter(m => m.taskId === taskId && m.deliveryState);

test('correction during model request rejects stale action, charges both calls, and reads every update in order', async () => {
  const f = await fixture({ now: () => 1000 }), entered = gate(), release = gate();
  try { const t = await f.task(); send(f.c, t.id, 'Keep the first correction.');
    f.adapter.steps.push(async () => { entered.resolve(); await release.promise; return call('finish', { outputVersionId: 'stale-output', summary: 'Stale completion' }); }, request => { assert.deepEqual(updates(request), ['Keep the first correction.', ...Array.from({ length: 5 }, (_, i) => `Correction ${i + 2}`)]); return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await within(entered.promise);
    for (let i = 0; i < 5; i++) send(f.c, t.id, `Correction ${i + 2}`);
    assert.ok(tracked(f.c, t.id).every(m => m.deliveryState === 'pending')); release.resolve();
    const result = await settled(f.c, t.id); assert.equal(result.task.state, 'waiting'); assert.equal(result.live.calls, 2); assert.equal(result.live.steps, 1); assert.ok(result.live.costUsd > 0); assert.equal(result.live.reservedUsd, 0);
    assert.deepEqual(f.rows('SELECT tool_name FROM live_tool_receipts').map(r => r.tool_name), ['user_request']); assert.ok(tracked(f.c, t.id).every(m => m.deliveryState === 'incorporated' && m.incorporatedAt === 1000));
    assert.equal(f.c.snapshot().events.filter(e => e.type === 'live.owner_update_replan').length, 1);
  } finally { release.resolve(); await f.close(); }
});

test('queued updates survive restart, remain paused, and stay in future turns beyond the latest four replies', async () => {
  const f = await fixture();
  try { const t = await f.task(), values = Array.from({ length: 7 }, (_, i) => `Saved correction ${i + 1}`); for (const value of values) send(f.c, t.id, value);
    await f.c.shutdown(); const next = await f.create(); assert.equal(next.adapter.requests.length, 0); assert.equal(next.c.snapshot().tasks[0].state, 'paused'); assert.ok(tracked(next.c, t.id).every(m => m.deliveryState === 'pending'));
    next.adapter.steps.push(request => { assert.deepEqual(updates(request), values); return call('collaboration_context'); }, request => { assert.deepEqual(updates(request), values); return ask(); });
    await next.c.live.handle({ type: 'live.start', taskId: t.id }); await settled(next.c, t.id); assert.ok(tracked(next.c, t.id).every(m => m.deliveryState === 'incorporated'));
    assert.deepEqual((await next.c.live.state()).tasks[0].policy, { mode: 'workspace', allowedOrigins: ['https://example.com'] });
  } finally { await f.close(); }
});

for (const command of ['tasks.pause', 'tasks.cancel'] as const) test(`${command} during generation keeps pending update and blocks the late action`, async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try { const t = await f.task(); send(f.c, t.id, 'Use the revised scope.'); f.adapter.steps.push(async () => { entered.resolve(); await release.promise; return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await within(entered.promise); f.c.handle({ type: command, taskId: t.id }); release.resolve();
    const result = await settled(f.c, t.id); assert.equal(result.task.state, command === 'tasks.pause' ? 'paused' : 'cancelled'); assert.equal(tracked(f.c, t.id)[0].deliveryState, 'pending'); assert.equal(f.rows('SELECT * FROM live_tool_receipts').length, 0); assert.equal(result.live.calls, 1);
    if (command === 'tasks.cancel') assert.throws(() => send(f.c, t.id, 'Reopen without permission'), /finished/);
  } finally { release.resolve(); await f.close(); }
});

test('invalidated decisions do not bypass the original model-call budget', async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try { const t = await f.task({ maxModelCalls: 1 }); f.adapter.steps.push(async () => { entered.resolve(); await release.promise; return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await within(entered.promise); send(f.c, t.id, 'Wait for revised evidence.'); release.resolve();
    const result = await settled(f.c, t.id); assert.equal(result.task.state, 'paused'); assert.equal(result.live.calls, 1); assert.equal(result.live.steps, 0); assert.match(result.live.lastError!, /model-call limit/); assert.equal(tracked(f.c, t.id)[0].deliveryState, 'pending');
  } finally { release.resolve(); await f.close(); }
});

test('UTF-8 serialized update budget rejects atomically; large ordinary context cannot truncate accepted updates', async () => {
  const f = await fixture();
  try { const t = await f.task(), text = '界'.repeat(2600); for (let i = 0; i < 3; i++) send(f.c, t.id, `${i}:${text}`);
    assert.throws(() => send(f.c, t.id, text), /saved update limit/); assert.equal(tracked(f.c, t.id).length, 3);
    const db = new DatabaseSync(f.c.databasePath); try { db.prepare('INSERT INTO live_history(task_id,kind,content,created_at) VALUES (?,?,?,?)').run(t.id, 'observation', JSON.stringify({ longObservation: 'x'.repeat(80000) }), Date.now()); } finally { db.close(); }
    f.adapter.steps.push(request => { assert.equal(updates(request).length, 3); assert.ok(updates(request).every(value => value.endsWith(text))); return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await settled(f.c, t.id); assert.ok(tracked(f.c, t.id).every(m => m.deliveryState === 'incorporated'));
  } finally { await f.close(); }
});

test('owner correction arriving during asynchronous final artifact verification prevents task completion', async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try { const t = await f.task(), versionId = await f.put(t.id); let outputId = '';
    f.adapter.steps.push(() => call('read_file', { versionId }), request => call('save_report', { name: 'report.md', content: '# Report\nVerified source.', evidenceIds: [context(request).savedObservations.find((o: any) => o.tool === 'read_file').evidenceId] }), request => { outputId = context(request).producedOutputs[0].outputVersionId; return call('finish', { outputVersionId: outputId, summary: 'Done' }); }, request => { assert.deepEqual(updates(request), ['Add the missing comparison before finishing.']); return ask(); });
    const original = f.c.artifacts.preview.bind(f.c.artifacts); f.c.artifacts.preview = async args => { const result = await original(args); if (outputId && args.versionId === outputId) { entered.resolve(); await release.promise; } return result; };
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await within(entered.promise); send(f.c, t.id, 'Add the missing comparison before finishing.'); release.resolve();
    const result = await settled(f.c, t.id); assert.equal(result.task.state, 'waiting'); assert.equal(result.live.resultVersionId, outputId, 'The saved draft remains available even though completion was fenced.'); assert.equal(f.c.snapshot().events.some(e => e.type === 'live.completed'), false); assert.equal(tracked(f.c, t.id)[0].deliveryState, 'incorporated');
  } finally { release.resolve(); await f.close(); }
});

test('live task and config creation roll back together when an atomic creation callback fails', async () => {
  const f = await fixture();
  try { assert.throws(() => f.c.createLiveTask({ type: 'live.createTask', agentId: f.agent.id, objective: 'Atomic task.', completionCriteria: 'One saved task.', model: DEFAULT_MODEL, policy: { mode: 'workspace', allowedOrigins: [] }, limits: DEFAULT_LIVE_LIMITS }, () => { throw new Error('receipt failed'); }), /receipt failed/);
    assert.equal(f.c.snapshot().tasks.length, 0); assert.equal(f.rows('SELECT * FROM live_task_config').length, 0); assert.equal(f.rows('SELECT * FROM task_messages').length, 0); assert.equal(f.rows("SELECT * FROM events WHERE type='task.created'").length, 0);
  } finally { await f.close(); }
});

test('owner update during missing-file replanning discards the stale scope proposal and keeps blockers', async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try { const t = await f.task();
    f.adapter.steps.push(() => call('user_request', { requestJson: JSON.stringify({ kind: 'files', title: 'Provide input', reason: 'The original data is required.', continuation: 'source-file', slots: [{ key: 'source', label: 'Source', required: true, constraints: { formats: ['csv'] } }] }) }), async () => { entered.resolve(); await release.promise; return call('replan_result', { resultJson: JSON.stringify({ kind: 'reduced_scope', description: 'Skip the original data', completionCriteria: 'General discussion only', waiveSlotKeys: ['source'] }) }); }, request => { assert.deepEqual(updates(request), ['Do not reduce the scope. Wait for the original file.']); return call('replan_result', { resultJson: JSON.stringify({ kind: 'keep_blocked', message: 'Waiting for the original file as requested.' }) }); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await settled(f.c, t.id); const request = f.c.requests.list(t.id)[0];
    await f.c.requests.handle({ type: 'requests.reply', requestId: request.id, revision: request.revision, response: 'The file is currently unavailable.' }); f.c.tick(); await within(entered.promise); send(f.c, t.id, 'Do not reduce the scope. Wait for the original file.'); release.resolve();
    const result = await settled(f.c, t.id); assert.equal(result.task.state, 'waiting'); assert.equal(result.live.calls, 3); assert.equal(f.c.requests.list(t.id).some(r => r.kind === 'reduced_scope'), false); assert.equal(f.c.requests.list(t.id)[0].slots[0].state, 'missing'); assert.equal(tracked(f.c, t.id)[0].deliveryState, 'incorporated');
  } finally { release.resolve(); await f.close(); }
});

class BrowserFixture implements BrowserRuntime {
  methods: string[] = []; launches = 0; onUploadChunk?: () => void; onNavigate?: () => void; statusGate?: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> };
  async status() { if (this.statusGate) { const held = this.statusGate; this.statusGate = undefined; held.entered.resolve(); await held.release.promise; } return { ready: true, message: null }; }
  async reconcile() {} async close() {}
  async launch({ initialGeneration }: Parameters<BrowserRuntime['launch']>[0]): Promise<BrowserHandle> {
    this.launches++; let revision = 1;
    return {
      request: async (method) => { this.methods.push(method); if(method==='upload.chunk')this.onUploadChunk?.(); if(method==='page.navigate')this.onNavigate?.(); revision++; const tab = { id: 'tab-1', url: 'https://example.com/', title: 'Fixture', revision }; return { generation: initialGeneration, controller: 'agent', result: method === 'download.list' ? [] : method === 'upload.begin' ? {id:'upload-1'} : method.startsWith('upload.') ? {} : { tabs: [tab], selectedTabId: tab.id, tab: tab.id, url: tab.url, title: tab.title, revision, text: 'Public fixture', targets: [{ref:'file-1',kind:'file',label:'Upload'}], frame: method === 'page.peek' ? { jpegBase64: Buffer.from('fixture').toString('base64'), width: 1120, height: 760, revision, tabId: tab.id } : null } }; },
      async stop() {}, async close() { return { saved: true }; },
    };
  }
}

for (const handoff of [false, true]) test(`new update during browser startup prevents ${handoff ? 'a stale login blocker' : 'stale page navigation'}`, async () => {
  const runtime = new BrowserFixture(), f = await fixture({ browserRuntime: runtime }), entered = gate(), release = gate();
  try { const t = await f.task(); runtime.statusGate = { entered, release };
    f.adapter.steps.push(() => handoff ? call('user_request', { requestJson: JSON.stringify({ kind: 'browser_handoff', title: 'Log in', reason: 'Need a source', continuation: 'login' }) }) : call('browser_open', { url: 'https://example.com/old' }), request => { assert.deepEqual(updates(request), ['Wait for a different source.']); return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await within(entered.promise); send(f.c, t.id, 'Wait for a different source.'); release.resolve();
    const result = await settled(f.c, t.id); assert.equal(result.task.state, 'waiting'); assert.equal(result.live.calls, 2); assert.equal(runtime.launches, 0); assert.equal(runtime.methods.includes('page.navigate'), false); assert.equal(f.c.requests.list(t.id).some(r => r.kind === 'browser_handoff'), false); assert.equal(tracked(f.c, t.id)[0].deliveryState, 'incorporated');
  } finally { release.resolve(); await f.close(); }
});

test('browser broker checks the decision after its async entry before emitting navigation RPC', async () => {
  const runtime = new BrowserFixture(), f = await fixture({ browserRuntime: runtime });
  try { const t = await f.task(), original = f.c.browser.agentAction.bind(f.c.browser); let changed = false;
    f.c.browser.agentAction = async (...args) => { if (args[3] === 'page.navigate' && !changed) { changed = true; send(f.c, t.id, 'Use a different page.'); } return original(...args); };
    f.adapter.steps.push(() => call('browser_open', { url: 'https://example.com/old' }), request => { assert.deepEqual(updates(request), ['Use a different page.']); return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); const result = await settled(f.c, t.id);
    assert.equal(result.task.state, 'waiting'); assert.equal(runtime.launches, 1); assert.equal(runtime.methods.includes('page.navigate'), false); assert.equal(f.rows("SELECT * FROM browser_tool_calls WHERE method='page.navigate'").length, 0); assert.equal(result.live.calls, 2);
  } finally { await f.close(); }
});

for (const boundary of ['workspace', 'container'] as const) test(`code preflight fences changed instructions after ${boundary} preparation before the script runs`, async () => {
  const entered = gate(), release = gate(); let launches = 0, runs = 0, closes = 0;
  const runtime: CodeRuntime = { async status() { return { ready: true, message: null, imageDigest: 'sha256:fixture', packages: [] }; }, async reconcile() {}, async close() {}, async launch() { launches++; if (boundary === 'container') { entered.resolve(); await release.promise; } return { info: { containerId: 'fixture', imageDigest: 'sha256:fixture' }, async run() { runs++; throw Error('Superseded code must not run'); }, async export() { throw Error('No output expected'); }, async stop() {}, async close() { closes++; } }; } };
  const f = await fixture({ codeRuntime: runtime });
  try { const t = await f.task(); if (boundary === 'workspace') { const original = f.c.artifacts.beginCodeWorkspace.bind(f.c.artifacts); f.c.artifacts.beginCodeWorkspace = async input => { const lease = await original(input); entered.resolve(); await release.promise; return lease; }; }
    f.adapter.steps.push(() => call('code_execute', { runtime: 'python', source: 'print("old script")', inputVersionIds: [], timeoutSeconds: 10 }), request => { assert.deepEqual(updates(request), ['Revise the calculation before running code.']); return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await within(entered.promise); send(f.c, t.id, 'Revise the calculation before running code.'); release.resolve(); const result = await settled(f.c, t.id);
    assert.equal(result.task.state, 'waiting'); assert.equal(result.live.calls, 2); assert.equal(runs, 0); assert.equal(launches, boundary === 'container' ? 1 : 0); assert.equal(closes, launches); assert.equal(f.rows('SELECT * FROM code_workspace_revisions').length, 0); assert.equal(f.rows("SELECT * FROM code_executions WHERE reason='owner_update_pending'").length, 1); assert.equal(tracked(f.c, t.id)[0].deliveryState, 'incorporated');
  } finally { release.resolve(); await f.close(); }
});

test('owner correction during publication staging prevents metadata publication even with an earlier exact grant', async () => {
  let armed = false, taskId = '', current: Coordinator | undefined;
  const f = await fixture({ artifactFault: point => { if (armed && point === 'after_stage') { armed = false; send(current!, taskId, 'Keep the report private for now.'); } } }); current = f.c;
  try { const t = await f.task(); taskId = t.id; const versionId = await f.put(t.id);
    f.adapter.steps.push(() => { armed = true; return call('publish_output', { versionId }); }, request => { assert.deepEqual(updates(request), ['Keep the report private for now.']); return ask(); });
    const db = new DatabaseSync(f.c.databasePath); try {
      db.prepare("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (? ,?,'permission_change','Publish','Exact grant','fulfilled','fixture',?)").run('grant-request', taskId, Date.now());
      db.prepare('INSERT INTO request_capability_grants(request_id,task_id,capability_json,granted_at) VALUES (?,?,?,?)').run('grant-request', taskId, JSON.stringify({ name: 'artifact_publish', versionIds: [versionId] }), Date.now());
    } finally { db.close(); }
    await f.c.live.handle({ type: 'live.start', taskId }); const result = await settled(f.c, taskId);
    assert.equal(result.task.state, 'waiting'); assert.equal(result.live.calls, 2); assert.equal(f.c.snapshot().artifacts.some(a => a.visibility === 'shared'), false); assert.equal(f.c.snapshot().events.some(e => e.type === 'artifact.published'), false);
  } finally { await f.close(); }
});

test('upload checks the owner update before applying staged bytes to the page and aborts the staged transfer', async () => {
  const runtime = new BrowserFixture(), f = await fixture({ browserRuntime: runtime });
  try { const t = await f.task(), versionId = await f.put(t.id);
    const state = await f.c.browser.handle({ type: 'browser.open', agentId: f.agent.id, taskId: t.id });
    const db = new DatabaseSync(f.c.databasePath); try {
      db.prepare("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (? ,?,'permission_change','Upload','Exact grant','fulfilled','fixture',?)").run('upload-request', t.id, Date.now());
      db.prepare('INSERT INTO request_capability_grants(request_id,task_id,capability_json,granted_at) VALUES (?,?,?,?)').run('upload-request', t.id, JSON.stringify({ name: 'browser_upload', origin: 'https://example.com', versionIds: [versionId] }), Date.now());
    } finally { db.close(); }
    runtime.onUploadChunk = () => { runtime.onUploadChunk = undefined; send(f.c, t.id, 'Do not put this file into the page.'); };
    f.adapter.steps.push(() => call('browser_upload', { versionId, origin: 'https://example.com', ref: 'file-1', revision: state.tabs.find(tab => tab.id === state.activeTabId)!.revision }), request => { assert.deepEqual(updates(request), ['Do not put this file into the page.']); return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); const result = await settled(f.c, t.id);
    assert.equal(result.task.state, 'waiting'); assert.equal(result.live.calls, 2); assert.equal(runtime.methods.filter(m => m === 'upload.begin').length, 1); assert.equal(runtime.methods.filter(m => m === 'upload.chunk').length, 1); assert.equal(runtime.methods.includes('upload.finish'), false); assert.equal(runtime.methods.filter(m => m === 'upload.abort').length, 1);
  } finally { await f.close(); }
});

test('a correction during already-running code preserves its verified result and never replays the script', async () => {
  const entered = gate(), release = gate(); let runs = 0;
  const runtime: CodeRuntime = { async status() { return { ready: true, message: null, imageDigest: 'sha256:fixture', packages: [] }; }, async reconcile() {}, async close() {}, async launch() { return { info: { containerId: 'fixture', imageDigest: 'sha256:fixture' }, async run() { runs++; entered.resolve(); await release.promise; return { exitCode: 0, reason: 'exited', startedAt: 1, finishedAt: 2, durationMs: 1, logsTruncated: false }; }, async export() { return []; }, async stop() {}, async close() {} }; } };
  const f = await fixture({ codeRuntime: runtime });
  try { const t = await f.task(); f.adapter.steps.push(() => call('code_execute', { runtime: 'python', source: 'print("once")', inputVersionIds: [], timeoutSeconds: 10 }), request => { assert.deepEqual(updates(request), ['Use the result for a revised report.']); assert.ok(context(request).savedObservations.some((row: any) => row.tool === 'code_execute' && row.result.workspaceCommitted)); return ask(); });
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); await within(entered.promise); send(f.c, t.id, 'Use the result for a revised report.'); release.resolve(); const result = await settled(f.c, t.id);
    assert.equal(result.task.state, 'waiting'); assert.equal(runs, 1); assert.equal(f.rows("SELECT * FROM code_executions WHERE lifecycle='succeeded' AND workspace_committed=1").length, 1); assert.equal(f.rows("SELECT * FROM live_tool_receipts WHERE tool_name='code_execute' AND state='succeeded'").length, 1);
  } finally { release.resolve(); await f.close(); }
});

test('a correction during uncertain navigation does not convert it to an automatic retry', async () => {
  const runtime = new BrowserFixture(), f = await fixture({ browserRuntime: runtime });
  try { const t = await f.task(); runtime.onNavigate = () => { send(f.c, t.id, 'Check the latest page.'); throw Object.assign(new Error('Synthetic lost response'), { code: 'outcome_unknown' }); };
    f.adapter.steps.push(() => call('browser_open', { url: 'https://example.com/old' }), () => ask());
    await f.c.live.handle({ type: 'live.start', taskId: t.id }); const result = await settled(f.c, t.id);
    assert.equal(result.task.state, 'paused'); assert.equal(result.live.calls, 1); assert.equal(runtime.methods.filter(m => m === 'page.navigate').length, 1); assert.equal(tracked(f.c, t.id)[0].deliveryState, 'pending'); assert.equal(f.rows("SELECT * FROM browser_tool_calls WHERE method='page.navigate' AND state='outcome_unknown'").length, 1);
  } finally { await f.close(); }
});
