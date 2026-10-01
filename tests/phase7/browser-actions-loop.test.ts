import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../../packages/coordinator';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import type { BrowserHandle, BrowserReply, BrowserRuntime } from '../../packages/browser/runtime';
import { DEFAULT_MODEL, maxCostMicrousd, usageCostMicrousd, type ModelAdapter, type ModelRequest, type ModelToolCall, type ModelTurn, type PreparedTurn } from '../../packages/model-adapters';

class ScriptedModel implements ModelAdapter {
 calls = 0; pending = new Map<string, ModelRequest>(); beforeApply?: () => Promise<void>;
 async status() { return { configured: true, message: null, provider: 'fixture', model: DEFAULT_MODEL }; }
 prepare(request: ModelRequest): PreparedTurn { const body = JSON.stringify(request), id = randomUUID(); this.pending.set(id, request); return { id, model: DEFAULT_MODEL, requestHash: createHash('sha256').update(body).digest('hex'), requestBytes: Buffer.byteLength(body), maxOutputTokens: request.maxOutputTokens }; }
 async quote(p: PreparedTurn) { return { inputTokens: 100, outputTokens: p.maxOutputTokens, maxCostMicrousd: maxCostMicrousd(DEFAULT_MODEL, 100, p.maxOutputTokens) }; }
 async complete(p: PreparedTurn): Promise<ModelTurn> {
  const request = this.pending.get(p.id)!, context = JSON.parse((request.input[0] as { content: string }).content); this.calls++;
  const call = (name: string, args: Record<string, unknown> = {}): ModelToolCall => ({ id: randomUUID(), name, arguments: args }); let step: ModelToolCall;
  if (this.calls === 1) step = call('browser_open', { url: 'https://fixture.example.test/record' });
  else if (this.calls === 2) { const observation = context.savedObservations.findLast((r: any) => r.tool === 'browser_open').result; step = call('browser_request_action', { actionJson: JSON.stringify({ kind: 'fill', ref: observation.targets[0].ref, revision: observation.revision, value: 'Reviewed value' }), reason: 'Enter the requested value.', expectedEffect: 'The fixture will record this value immediately.', idempotencyKey: 'record-title' }); }
  else if (this.calls === 3) { assert.equal(context.browserActions[0].state, 'approved'); await this.beforeApply?.(); step = call('browser_apply_action', { actionId: context.browserActions[0].id }); }
  else if (this.calls === 4) step = call('browser_observe');
  else if (this.calls === 5) { const evidence = context.evidence.find((r: any) => r.tool === 'browser_observe'); assert.ok(evidence); step = call('save_report', { name: 'reviewed-record.md', content: '# Synthetic record\nThe fresh fixture observation says Saved value: Reviewed value. This fixture does not prove any real website integration.\n', evidenceIds: [evidence.evidenceId] }); }
  else if (this.calls === 6) step = call('finish', { outputVersionId: context.producedOutputs[0].outputVersionId, summary: 'The synthetic record was observed and the report is saved.' });
  else throw new Error('Unexpected extra model call in the deterministic fixture.');
  assert.ok(request.tools.some(t => t.name === step.name)); const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0 };
  return { responseId: randomUUID(), text: '', toolCalls: [step], usage, costMicrousd: usageCostMicrousd(DEFAULT_MODEL, usage) };
 }
 discard(p: PreparedTurn) { this.pending.delete(p.id); }
}
class FixtureBrowser implements BrowserHandle {
 revision = 1; controller: 'agent' | 'human' = 'agent'; url = 'about:blank'; value = ''; effects = 0; unknown = false;
 constructor(public generation: number) {}
 view(advance = true) { if (advance) this.revision++; return { tabs: [{ id: 'tab1', url: this.url, title: 'Synthetic record', revision: this.revision }], selectedTabId: 'tab1', tab: 'tab1', url: this.url, title: 'Synthetic record', revision: this.revision, text: this.value ? 'Saved value: ' + this.value : 'No saved value', targets: [{ ref: 'title_' + this.revision, kind: 'input', label: 'Record title' }], frame: null }; }
 async request(method: string, params: Record<string, unknown>, options: Parameters<BrowserHandle['request']>[2]): Promise<BrowserReply> {
  assert.equal(options.generation, this.generation); let result: unknown;
  if (method === 'page.observe') result = this.view();
  else if (method === 'page.peek') result = this.view(false);
  else if (method === 'page.navigate') { this.url = String(params.url); result = this.view(); }
  else if (method === 'page.fill') { assert.equal(params.revision, this.revision); assert.equal(params.ref, 'title_' + this.revision); this.effects++; this.value = String(params.value); if (this.unknown) throw Object.assign(new Error('Uncertain synthetic transport'), { code: 'outcome_unknown' }); result = this.view(); }
  else if (method === 'download.list') result = [];
  else if (method === 'control.take' || method === 'control.release') { this.generation++; this.controller = method === 'control.take' ? 'human' : 'agent'; result = { observation: this.view() }; }
  else throw new Error('Unexpected fixture browser method: ' + method);
  return { generation: this.generation, controller: this.controller, result };
 }
 async close() { return { saved: true, savedAt: Date.now() }; } async stop() {}
}
class FixtureRuntime implements BrowserRuntime {
 handle?: FixtureBrowser;
 async status() { return { ready: true, message: null, backend: 'desktop_chrome' as const }; }
 async launch(options: Parameters<BrowserRuntime['launch']>[0]) { return this.handle = new FixtureBrowser(options.initialGeneration); }
 async reconcile() {} async close() {}
}
async function idle(c: Coordinator) { for (let i = 0; i < 600; i++) { if (!(await c.live.state()).busy) return; await new Promise(done => setTimeout(done, 5)); } throw new Error('Fixture live loop did not settle.'); }
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'aw-browser-loop-')), model = new ScriptedModel(), runtime = new FixtureRuntime(), c = new Coordinator({ dataRoot: join(root, 'app'), modelAdapter: model, browserRuntime: runtime }); await c.live.ready;
 c.handle({ type: 'settings.update', settings: { driverEnabled: false } }); const agent = c.handle({ type: 'agents.create', name: 'Reviewed browser fixture', instructions: '' }).agents[0];
 const taskId = c.createLiveTask({ type: 'live.createTask', agentId: agent.id, objective: 'Enter one reviewed value and observe the fixture result.', completionCriteria: 'Fresh source observation after the reviewed change and a saved report.', model: DEFAULT_MODEL, limits: DEFAULT_LIVE_LIMITS, policy: { mode: 'workspace', allowedOrigins: ['https://fixture.example.test'], browserInteraction: 'reviewed_actions' } });
 await c.live.handle({ type: 'live.start', taskId }); await idle(c);
 return { c, taskId, agent, model, runtime, async approve() { const a = c.browserActions.state(taskId).actions[0]; await c.browserActions.handle({ type: 'browserActions.decide', actionId: a.id, revision: a.revision, decision: 'approve', accountConfirmation: 'Synthetic fixture account' }); await idle(c); }, async close() { await c.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('coordinator model flow waits for review, resumes a new claim, applies once, reobserves and saves a result', async () => {
 const f = await fixture(); try {
  assert.equal(f.c.snapshot().tasks[0].state, 'waiting'); assert.equal(f.model.calls, 2); assert.equal(f.runtime.handle!.effects, 0);
  await f.approve(); assert.equal(f.c.snapshot().tasks[0].state, 'succeeded'); assert.equal(f.model.calls, 6); assert.equal(f.runtime.handle!.effects, 1);
  assert.equal(f.c.browserActions.state(f.taskId).actions[0].state, 'completed'); const result = f.c.results.state().results[0]; assert.ok(result); assert.match((await f.c.results.inspect(f.taskId, result.version.id)).preview.text!, /fresh fixture observation/);
 } finally { await f.close(); }
});

test('coordinator unknown outcome pauses without another model turn or automatic resubmission', async () => {
 const f = await fixture(); try {
  f.runtime.handle!.unknown = true; await f.approve(); assert.equal(f.c.snapshot().tasks[0].state, 'paused'); assert.equal(f.model.calls, 3); assert.equal(f.runtime.handle!.effects, 1);
  assert.equal(f.c.browserActions.state(f.taskId).actions[0].state, 'outcome_unknown'); f.c.live.tick(); await idle(f.c); assert.equal(f.model.calls, 3);
  await f.c.live.handle({ type: 'live.start', taskId: f.taskId }); await idle(f.c); assert.notEqual(f.c.snapshot().tasks[0].state, 'running'); assert.equal(f.model.calls, 3); assert.equal(f.runtime.handle!.effects, 1);
 } finally { await f.close(); }
});

test('browser handoff between approval and apply invalidates it and pauses before the next effect', async () => {
 const f = await fixture(); try {
  f.model.beforeApply = async () => {
   let state = await f.c.browser.handle({ type: 'browser.state', agentId: f.agent.id });
   state = await f.c.browser.handle({ type: 'browser.takeControl', agentId: f.agent.id, sessionId: state.sessionId, generation: state.generation });
   await f.c.browser.handle({ type: 'browser.returnControl', agentId: f.agent.id, sessionId: state.sessionId, generation: state.generation });
  }; await f.approve();
  assert.equal(f.c.snapshot().tasks[0].state, 'paused'); assert.equal(f.c.browserActions.state(f.taskId).actions[0].state, 'stale'); assert.equal(f.runtime.handle!.effects, 0); assert.equal(f.model.calls, 3);
 } finally { await f.close(); }
});
