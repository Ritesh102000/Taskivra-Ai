import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfiguredModelAdapter, MacKeychainCredentials, ModelAdapterError, ProviderRegistry, configuredCostMicrousd, providerCredentialAccount, providerSelectionId, validateProviderInput, type CredentialProvider, type FunctionTool, type ModelAdapter, type ModelRequest } from '../../packages/model-adapters';
import type { ModelProviderInput, ModelProviderKind, ModelProviderProfile } from '../../packages/contracts/model-providers';
import { ProviderController } from '../../apps/desktop/main/provider-controller';
const signal = () => new AbortController().signal;
const tool: FunctionTool = { name: 'sum', description: 'Add two integers.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } };
const request = (): ModelRequest => ({ instructions: 'Use only the listed tools.', input: [{ role: 'user', content: 'Add 2 and 3.' }], tools: [structuredClone(tool)], maxOutputTokens: 128 });
const input = (kind: ModelProviderKind = 'openai-compatible'): ModelProviderInput => ({ label: 'Fixture model', kind, baseUrl: kind === 'openai' ? 'https://api.openai.com/v1' : kind === 'anthropic' ? 'https://api.anthropic.com/v1' : kind === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1', model: 'fixture-pinned', authentication: kind === 'ollama' || kind === 'openai-compatible' ? 'none' : 'api-key', billing: kind === 'ollama' || kind === 'openai-compatible' ? 'local' : 'metered', inputUsdPerMillion: kind === 'ollama' || kind === 'openai-compatible' ? 0 : 1.25, outputUsdPerMillion: kind === 'ollama' || kind === 'openai-compatible' ? 0 : 5, maxInputTokens: 4096, maxOutputTokens: 512, toolCalling: true });
const profile = (kind: ModelProviderKind = 'openai-compatible'): ModelProviderProfile => { const id = randomUUID(); return { ...input(kind), id, revision: 1, selectionId: providerSelectionId(id, 1), createdAt: Date.now() }; };
const credential: CredentialProvider = { status: async () => ({ configured: true, message: null }), read: async () => 'synthetic-secret-not-a-real-key' };
function response(p: ModelProviderProfile): any {
  if (p.kind === 'openai') return { id: 'resp_fixture', model: p.model, status: 'completed', service_tier: 'default', usage: { input_tokens: 64, output_tokens: 20, total_tokens: 84 }, output: [{ type: 'function_call', call_id: 'call_fixture', name: 'sum', arguments: '{"a":2,"b":3}' }] };
  if (p.kind === 'anthropic') return { id: 'msg_fixture', model: p.model, type: 'message', role: 'assistant', stop_reason: 'tool_use', usage: { input_tokens: 64, output_tokens: 20 }, content: [{ type: 'tool_use', id: 'tool_fixture', name: 'sum', input: { a: 2, b: 3 } }] };
  if (p.kind === 'ollama') return { model: p.model, done: true, done_reason: 'stop', prompt_eval_count: 64, eval_count: 20, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'sum', arguments: { a: 2, b: 3 } } }] } };
  return { id: 'chatcmpl_fixture', model: p.model, usage: { prompt_tokens: 64, completion_tokens: 20, total_tokens: 84 }, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'sum', arguments: '{"a":2,"b":3}' } }] } }] };
}
async function complete(adapter: ModelAdapter, r = request()) { const p = adapter.prepare(r); const q = await adapter.quote(p, { signal: signal() }); return { p, q, turn: await adapter.complete(p, { signal: signal() }) }; }
for (const kind of ['openai', 'anthropic', 'ollama', 'openai-compatible'] as const) test(`${kind}: real request translation, schema checked tool, usage, immutable reservation and one dispatch`, async () => {
  const p = profile(kind); let calls = 0, captured: any, headers: Headers | undefined, url = '';
  const adapter = new ConfiguredModelAdapter({ profile: p, credentials: credential, fetch: async (target, init) => { calls++; captured = JSON.parse(init?.body as string); headers = new Headers(init?.headers); url = String(target); assert.equal(init?.redirect, 'error'); return Response.json(response(p)); } });
  const r = request(), prepared = adapter.prepare(r); r.input[0] = { role: 'user', content: 'MUTATED' }; r.tools[0].name = 'injected';
  await assert.rejects(adapter.complete(prepared, { signal: signal() }), (e: any) => e.code === 'model_quote_required'); assert.equal(calls, 0);
  const quoted = await adapter.quote(prepared, { signal: signal() }); assert.equal(quoted.inputTokens, p.maxInputTokens); quoted.maxCostMicrousd = 0;
  const turn = await adapter.complete(prepared, { signal: signal() }); assert.equal(calls, 1); assert.deepEqual(turn.toolCalls[0].arguments, { a: 2, b: 3 }); assert.equal(turn.usage.totalTokens, 84); assert.equal(turn.costMicrousd, configuredCostMicrousd(p, 64, 20)); assert.equal(prepared.model, p.selectionId);
  assert.ok(!JSON.stringify(captured).includes('MUTATED')); assert.ok(!JSON.stringify(captured).includes('injected')); assert.equal(captured.model, 'fixture-pinned');
  assert.equal(headers?.get('Authorization'), p.authentication === 'api-key' && kind !== 'anthropic' ? 'Bearer synthetic-secret-not-a-real-key' : null);
  assert.equal(headers?.get('x-api-key'), kind === 'anthropic' ? 'synthetic-secret-not-a-real-key' : null);
  assert.equal(url, p.baseUrl + (kind === 'openai' ? '/responses' : kind === 'anthropic' ? '/messages' : kind === 'ollama' ? '/api/chat' : '/chat/completions'));
  await assert.rejects(adapter.complete(prepared, { signal: signal() }), (e: any) => e.code === 'model_already_used'); assert.equal(calls, 1);
});
for (const kind of ['openai', 'anthropic', 'ollama', 'openai-compatible'] as const) test(`${kind}: tool-result continuation retains call binding`, async () => {
  const p = profile(kind); let captured: any;
  const adapter = new ConfiguredModelAdapter({ profile: p, credentials: credential, fetch: async (_, init) => { captured = JSON.parse(init?.body as string); return Response.json(response(p)); } });
  const r = request(); r.input.push({ role: 'assistant', toolCall: { id: 'previous', name: 'sum', arguments: { a: 2, b: 3 } } }, { role: 'tool', callId: 'previous', content: '5' }); await complete(adapter, r);
  const encoded = JSON.stringify(captured); assert.ok(encoded.includes('sum')); assert.ok(encoded.includes('5')); if (kind !== 'ollama') assert.ok(encoded.includes('previous')); else assert.equal(captured.messages.at(-1).tool_name, 'sum');
});
test('loopback HTTP fixture actually receives only the frozen request; no credentials are needed', async () => {
  let captured = '', auth: string | undefined; const p = profile('ollama');
  const server = createServer((req, res) => { auth = req.headers.authorization; req.on('data', c => captured += c); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response(p))); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { const address = server.address(); assert.ok(address && typeof address !== 'string'); p.baseUrl = `http://127.0.0.1:${address.port}`; const a = new ConfiguredModelAdapter({ profile: p, credentials: { status: async () => { throw Error('must not read a key'); }, read: async () => { throw Error('must not read a key'); } } }); assert.equal((await a.status()).configured, true); assert.equal((await complete(a)).turn.toolCalls.length, 1); assert.equal(auth, undefined); assert.equal(JSON.parse(captured).options.num_predict, 128); }
  finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
test('invalid or multiple tool calls never reach execution, while usage remains accounted', async () => {
  for (const mutate of [(r: any) => r.choices[0].message.tool_calls[0].function.name = 'shell', (r: any) => r.choices[0].message.tool_calls[0].function.arguments = '{"a":2,"b":3,"command":"oops"}', (r: any) => r.choices[0].message.tool_calls.push(r.choices[0].message.tool_calls[0]), (r: any) => r.choices[0].message.tool_calls[0].function.arguments = '{', (r: any) => r.choices[0].message.tool_calls[0].function.arguments = '{"a":"2","b":3}']) {
    const p = profile(), raw = response(p); mutate(raw); const a = new ConfiguredModelAdapter({ profile: p, credentials: credential, fetch: async () => Response.json(raw) }); await assert.rejects(complete(a), (e: any) => e.code === 'model_tool_invalid' && e.usage.totalTokens === 84);
  }
});
test('mismatched model, invalid usage, hidden reasoning and truncated responses fail closed', async () => {
  for (const [mutate, code] of [ [(r: any) => r.model = 'different-model', 'model_response_invalid'], [(r: any) => delete r.usage, 'model_usage_invalid'], [(r: any) => r.usage.total_tokens = 1, 'model_usage_invalid'], [(r: any) => r.choices[0].finish_reason = 'length', 'model_incomplete'], [(r: any) => r.choices[0].message.reasoning_content = 'unsupported reasoning', 'model_response_invalid'], [(r: any) => { r.usage.completion_tokens = 129; r.usage.total_tokens = 193; }, 'model_reservation_exceeded'] ] as const) {
    const p = profile(), raw = response(p); mutate(raw); const a = new ConfiguredModelAdapter({ profile: p, credentials: credential, fetch: async () => Response.json(raw) }); await assert.rejects(complete(a), (e: any) => e.code === code);
  }
});
test('cancel, timeout, redirects, oversized bodies and provider errors are bounded and never retried', async () => {
  const p = profile(); let calls = 0; const a = new ConfiguredModelAdapter({ profile: p, credentials: credential, timeoutMs: 10, fetch: async () => { calls++; return await new Promise<Response>(() => {}); } });
  await assert.rejects(complete(a), (e: any) => e.code === 'model_timeout'); assert.equal(calls, 1);
  const b = new ConfiguredModelAdapter({ profile: p, credentials: credential, fetch: async () => { throw Error('unexpected dispatch'); } }), prepared = b.prepare(request()), abort = new AbortController(); abort.abort(); await assert.rejects(b.quote(prepared, { signal: abort.signal }), (e: any) => e.code === 'model_cancelled');
  for (const [r, code] of [[new Response('', { status: 302, headers: { location: 'https://outside.invalid' } }), 'model_http'], [new Response('', { status: 429 }), 'model_rate_limited'], [new Response('', { status: 401 }), 'model_credentials'], [new Response('x'.repeat(524289)), 'model_response_limit']] as const) { let count = 0; const c = new ConfiguredModelAdapter({ profile: p, credentials: credential, fetch: async () => { count++; return r; } }); await assert.rejects(complete(c), (e: any) => e.code === code); assert.equal(count, 1); }
});
test('a real HTTP redirect is refused before its destination sees any traffic', async () => {
  let targetCalls = 0; const target = createServer((_, res) => { targetCalls++; res.end('{}'); }); await new Promise<void>(r => target.listen(0, '127.0.0.1', r)); const address = target.address(); assert.ok(address && typeof address !== 'string');
  const redirect = createServer((_, res) => { res.writeHead(307, { location: `http://127.0.0.1:${address.port}/secret` }); res.end(); }); await new Promise<void>(r => redirect.listen(0, '127.0.0.1', r)); const redirectAddress = redirect.address(); assert.ok(redirectAddress && typeof redirectAddress !== 'string');
  try { const p = profile(); p.baseUrl = `http://127.0.0.1:${redirectAddress.port}/v1`; p.authentication = 'api-key'; const a = new ConfiguredModelAdapter({ profile: p, credentials: credential }); await assert.rejects(complete(a), (e: any) => e.code === 'model_network'); assert.equal(targetCalls, 0); }
  finally { await Promise.all([target, redirect].map(s => new Promise<void>(r => s.close(() => r())))); }
});
test('profiles require explicit valid prices, allowed endpoints and supported limits', () => {
  assert.equal(validateProviderInput(input()).baseUrl, 'http://localhost:1234/v1');
  for (const patch of [{ baseUrl: 'http://example.com/v1' }, { baseUrl: 'https://user:pass@example.com/v1' }, { baseUrl: 'https://example.com/v1?key=secret' }, { baseUrl: 'file:///tmp/model' }, { baseUrl: 'https://example.com/v1', billing: 'local' }, { toolCalling: false }, { maxInputTokens: 100 }, { maxOutputTokens: 100000 }, { billing: 'metered', inputUsdPerMillion: 0 }, { model: 'model\nsecret' }, { extra: 'hidden' }]) assert.throws(() => validateProviderInput({ ...input(), ...patch }));
  assert.throws(() => validateProviderInput({ ...input('openai'), baseUrl: 'https://other.invalid/v1' }));
  const p = profile(); assert.notEqual(providerCredentialAccount(p), providerCredentialAccount({ ...p, baseUrl: 'https://other.invalid/v1' })); assert.notEqual(providerCredentialAccount(p), providerCredentialAccount({ ...p, selectionId: providerSelectionId(p.id, 2), revision: 2 }));
  assert.throws(() => new MacKeychainCredentials({ helperPath: '/unused', account: 'owner' }));
  assert.equal(configuredCostMicrousd({ ...input(), inputUsdPerMillion: 0.000001, outputUsdPerMillion: 0.000001 }, 1, 1), 1);
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-providers-'))), filePath = join(root, 'control', 'model-providers.json'), keys = new Map<string, string>();
  const legacy = new ConfiguredModelAdapter({ profile: profile('openai'), credentials: credential, fetch: async () => { throw Error('not called'); } });
  const config = { filePath, legacyAdapter: legacy, credentials: (p: ModelProviderProfile) => { const id = providerCredentialAccount(p); return { status: async () => ({ configured: keys.has(id), message: keys.has(id) ? null : 'Key missing' }), read: async () => { const key = keys.get(id); if (!key) throw Error('missing'); return key; }, save: async (key: string) => { keys.set(id, key); }, remove: async () => { keys.delete(id); } }; } };
  return { root, keys, config, registry: new ProviderRegistry(config) };
}
test('registry revisions survive restart, keep old tasks immutable and never persist keys', async () => {
  const f = await fixture(); try {
    const secret = 'synthetic-test-key'; await f.registry.save({ ...input(), authentication: 'api-key' }, { key: secret }); const first = (await f.registry.state()).profiles[0]; assert.equal(first.configured, true); assert.equal(first.tested, false); assert.ok(f.registry.options().some(m => m.id === first.selectionId));
    await f.registry.save({ ...input(), label: 'Changed', model: 'second-model', authentication: 'api-key' }, { id: first.id, expectedRevision: first.revision }); const second = (await f.registry.state()).profiles[0]; assert.equal(second.revision, 2); assert.equal(second.configured, true); assert.equal(f.registry.profile(first.selectionId).model, 'fixture-pinned'); assert.equal((await f.registry.resolve(first.selectionId).status()).model, first.selectionId);
    assert.notEqual(first.selectionId, second.selectionId); assert.equal((await stat(f.config.filePath)).mode & 0o777, 0o600); assert.ok(!(await readFile(f.config.filePath, 'utf8')).includes(secret));
    const reloaded = new ProviderRegistry(f.config); assert.equal(reloaded.profile(first.selectionId).model, 'fixture-pinned'); assert.equal(reloaded.options().at(-1)?.id, second.selectionId);
    reloaded.archive(second.id, second.revision); assert.equal(reloaded.selectable(second.selectionId), false); assert.equal(reloaded.profile(second.selectionId).model, 'second-model');
    await assert.rejects(reloaded.save(input(), { id: second.id, expectedRevision: 1 }), /changed/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('endpoint changes never reuse a stored credential and removing a current key does not change old tasks', async () => {
  const f = await fixture(); try {
    await f.registry.save({ ...input(), authentication: 'api-key' }, { key: 'synthetic-key' }); const first = (await f.registry.state()).profiles[0];
    await f.registry.save({ ...input(), baseUrl: 'http://localhost:5678/v1', authentication: 'api-key' }, { id: first.id, expectedRevision: 1 }); const second = (await f.registry.state()).profiles[0]; assert.equal(second.configured, false); assert.equal((await f.registry.resolve(first.selectionId).status()).configured, true);
    await f.registry.removeKey(first.selectionId); assert.equal((await f.registry.resolve(first.selectionId).status()).configured, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('owner controller rejects secret-bearing unknown fields and mutations during work', async () => {
  const f = await fixture(); try { let active = true; const c = new ProviderController(f.registry, () => active); await assert.rejects(c.handle({ type: 'providers.save', profile: input() }), /Pause/); assert.deepEqual((await c.handle({ type: 'providers.state' })).profiles, []); active = false; await assert.rejects(c.handle({ type: 'providers.state', key: 'bad' })); await c.handle({ type: 'providers.save', profile: input() }); assert.equal((await c.handle({ type: 'providers.state' })).profiles.length, 1); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
test('registry rejects malformed or symlinked persisted metadata', async () => {
  const f = await fixture(); try { await f.registry.save(input()); const actual = f.config.filePath; await writeFile(actual, '{"version":1,"profiles":[],"heads":[],"key":"bad"}'); assert.throws(() => new ProviderRegistry(f.config)); await rm(actual); const elsewhere = join(f.root, 'other'); await writeFile(elsewhere, '{}'); await symlink(elsewhere, actual); assert.throws(() => new ProviderRegistry(f.config)); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('an expired historical key can be repaired for its exact revision without changing saved model settings', async () => {
  const f = await fixture(); try {
    await f.registry.save({ ...input(), authentication: 'api-key' }, { key: 'old-synthetic-key' }); const first = (await f.registry.state()).profiles[0];
    await f.registry.save({ ...input(), authentication: 'api-key', model: 'new-model', baseUrl: 'http://localhost:9999/v1' }, { id: first.id, expectedRevision: 1 }); const second = (await f.registry.state()).profiles[0];
    const before = await readFile(f.config.filePath, 'utf8'), controller = new ProviderController(f.registry, () => false);
    await controller.handle({ type: 'providers.saveKey', selectionId: first.selectionId, key: 'repaired-synthetic-key' });
    assert.equal(await readFile(f.config.filePath, 'utf8'), before); assert.equal((await f.registry.resolve(first.selectionId).status()).configured, true); assert.equal((await f.registry.resolve(second.selectionId).status()).configured, false);
    assert.equal(await f.config.credentials(first).read(), 'repaired-synthetic-key'); assert.equal((await f.registry.state()).history?.[0].selectionId, first.selectionId);
    await assert.rejects(new ProviderController(f.registry, () => true).handle({ type: 'providers.saveKey', selectionId: first.selectionId, key: 'another-synthetic-key' }), /Pause/);
    await assert.rejects(controller.handle({ type: 'providers.saveKey', selectionId: first.selectionId, key: 'bad\nkey' }));
    assert.equal(await f.config.credentials(first).read(), 'repaired-synthetic-key');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
