import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../../packages/coordinator';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { OpenAIResponsesAdapter, ProviderRegistry } from '../../packages/model-adapters';
import type { ModelProviderInput } from '../../packages/contracts/model-providers';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-provider-runtime-'))), sent: { url: string; body: Record<string, any> }[] = [];
  const credentials = { status: async () => ({ configured: false, message: 'No fixture key' }), read: async (): Promise<string> => { throw Error('No keys are used by this fixture'); }, save: async () => {}, remove: async () => {} };
  const registry = new ProviderRegistry({ filePath: join(root, 'control', 'model-providers.json'), credentials: () => credentials, legacyAdapter: new OpenAIResponsesAdapter({ credentials }), fetch: async (url, options) => {
    const body = JSON.parse(options?.body as string); sent.push({ url: String(url), body });
    return Response.json({ model: body.model, done: true, done_reason: 'stop', prompt_eval_count: 64, eval_count: 20, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'user_request', arguments: { requestJson: JSON.stringify({ kind: 'clarification', title: 'Which source should I use?', reason: 'No source has been provided for this local fixture.', continuation: 'source-needed' }) } } }] } });
  } });
  const input: ModelProviderInput = { label: 'Local fixture', kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'fixture:original', authentication: 'none', billing: 'local', inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxInputTokens: 65536, maxOutputTokens: 512, toolCalling: true };
  await registry.save(input); const original = (await registry.state()).profiles[0];
  const c = new Coordinator({ dataRoot: root, modelResolver: id => registry.resolve(id), modelCatalog: () => registry.options() }); await c.live.ready;
  c.handle({ type: 'settings.update', settings: { driverEnabled: false } }); const agent = c.handle({ type: 'agents.create', name: 'Local model fixture', instructions: '' }).agents[0];
  const command = { type: 'live.createTask' as const, agentId: agent.id, objective: 'Ask which source to read.', completionCriteria: 'Save the source question.', model: original.selectionId, policy: { mode: 'workspace' as const, allowedOrigins: [] }, limits: { ...DEFAULT_LIVE_LIMITS } };
  await c.live.handle(command); const task = c.snapshot().tasks[0];
  return { root, c, registry, original, input, sent, command, task, close: async () => { await c.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function settle(c: Coordinator, id: string) {
  for (let i = 0; i < 300; i++) { const state = await c.live.state(), task = c.snapshot().tasks.find(t => t.id === id)!; if (!state.busy && !['queued', 'running', 'pausing'].includes(task.state)) return { task, live: state.tasks.find(t => t.taskId === id)! }; await new Promise(r => setTimeout(r, 10)); }
  throw Error('Fixture model task did not settle.');
}
test('saved local provider routes a real coordinator turn without an OpenAI key, then waits with checkpoint', async () => {
  const f = await fixture(); try {
    const before = await f.c.live.state(); assert.equal(before.tasks[0].modelConfigured, true); assert.equal(f.sent.length, 0);
    await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); const done = await settle(f.c, f.task.id);
    assert.equal(done.task.state, 'waiting'); assert.equal(done.live.calls, 1); assert.equal(done.live.costUsd, 0); assert.equal(done.live.reservedUsd, 0);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, 'http://localhost:11434/api/chat'); assert.equal(f.sent[0].body.model, 'fixture:original'); assert.equal(f.sent[0].body.options.num_predict, 512);
    assert.equal(f.c.snapshot().requests[0].title, 'Which source should I use?');
  } finally { await f.close(); }
});
test('edited and archived connections cannot silently replace an existing task or its output limit', async () => {
  const f = await fixture(); try {
    await f.registry.save({ ...f.input, model: 'fixture:replacement', maxOutputTokens: 1024 }, { id: f.original.id, expectedRevision: 1 }); const changed = (await f.registry.state()).profiles[0]; f.registry.archive(changed.id, changed.revision);
    await assert.rejects(f.c.live.handle({ ...f.command, model: changed.selectionId }), /current model connection/);
    await assert.rejects(f.c.live.handle(f.command), /current model connection/);
    await f.c.live.handle({ type: 'live.start', taskId: f.task.id }); const done = await settle(f.c, f.task.id);
    assert.equal(done.task.state, 'waiting'); assert.equal(f.sent[0].body.model, 'fixture:original'); assert.equal(f.sent[0].body.options.num_predict, 512); assert.equal(done.live.model, f.original.selectionId);
  } finally { await f.close(); }
});
test('a missing selected provider key blocks task start even if another local profile is configured', async () => {
  const f = await fixture(); try {
    await f.registry.save({ ...f.input, label: 'Cloud fixture', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'fixture-cloud', authentication: 'api-key', billing: 'metered', inputUsdPerMillion: 3, outputUsdPerMillion: 15 }); const cloud = (await f.registry.state()).profiles.find(p => p.label === 'Cloud fixture')!;
    await f.c.live.handle({ ...f.command, model: cloud.selectionId }); const task = f.c.snapshot().tasks.find(t => t.id !== f.task.id)!; const state = await f.c.live.state();
    assert.equal(state.credentialConfigured, true); assert.equal(state.tasks.find(t => t.taskId === task.id)?.modelConfigured, false);
    await assert.rejects(f.c.live.handle({ type: 'live.start', taskId: task.id }), /selected model connection/); assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});
