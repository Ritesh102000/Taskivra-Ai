import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIResponsesAdapter, MODEL_LIMITS, parseModelResponse, DEFAULT_MODEL, maxCostMicrousd, usageCostMicrousd, ModelAdapterError, type FunctionTool, type ModelRequest, type ModelQuote } from '../../packages/model-adapters';
import { argumentsMatch, validateToolDefinitions } from '../../packages/model-adapters/schema';
import { WORKSPACE_TOOLS, COMMON_TOOLS, GMAIL_TOOL, REPLAN_TOOL } from '../../packages/agent-loop/tools';

const tools: FunctionTool[] = [{ name: 'read_file', description: 'Read a pinned file.', parameters: { type: 'object', properties: { versionId: { type: 'string', minLength: 1, maxLength: 64 }, mode: { type: ['string', 'null'], enum: ['text', null] } }, required: ['versionId', 'mode'], additionalProperties: false } }];
const request = (): ModelRequest => ({ instructions: 'Use only the supplied tools.', input: [{ role: 'user', content: 'Read the pinned file.' }], tools: structuredClone(tools), maxOutputTokens: 2048 });
const quote: ModelQuote = { inputTokens: 100, outputTokens: 2048, maxCostMicrousd: maxCostMicrousd(DEFAULT_MODEL, 100, 2048) };
function response(extra: Record<string, unknown> = {}) { return { id: 'resp_fixture', model: DEFAULT_MODEL, status: 'completed', service_tier: 'default', output: [{ type: 'function_call', name: 'read_file', call_id: 'call_fixture', arguments: JSON.stringify({ versionId: 'version_fixture', mode: 'text' }) }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } }, ...extra }; }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const liveSignal = () => new AbortController().signal;
function fixture(handler: (url: string, init: RequestInit) => Promise<Response> | Response = url => json(url.endsWith('/input_tokens') ? { object: 'response.input_tokens', input_tokens: 100 } : response()), time = 1000) {
  let reads = 0, statuses = 0; const calls: { url: string; init: RequestInit }[] = [];
  const adapter = new OpenAIResponsesAdapter({ credentials: { async status() { statuses++; return { configured: true, message: null }; }, async read() { reads++; return 'sk-synthetic_no_real_credential'; } }, timeoutMs: time, quoteTimeoutMs: time, fetch: (async (url, init) => { calls.push({ url: String(url), init: init! }); return handler(String(url), init!); }) as typeof fetch });
  return { adapter, calls, get reads() { return reads; }, get statuses() { return statuses; } };
}
function code(expected: string) { return (error: unknown) => { assert.ok(error instanceof ModelAdapterError); assert.equal(error.code, expected); assert.doesNotMatch(error.message, /synthetic_no_real_credential|untrusted-provider-body/); return true; }; }

test('prepare and status do not read credentials or contact the provider', async () => {
  const f = fixture(), prepared = f.adapter.prepare(request());
  assert.equal(f.reads, 0); assert.equal(f.calls.length, 0); assert.equal(prepared.model, DEFAULT_MODEL);
  assert.deepEqual(Object.keys(prepared).sort(), ['id', 'maxOutputTokens', 'model', 'requestBytes', 'requestHash']);
  assert.match(prepared.requestHash, /^[0-9a-f]{64}$/); assert.ok(Object.isFrozen(prepared));
  assert.equal((await f.adapter.status()).configured, true); assert.equal(f.statuses, 1); assert.equal(f.reads, 0); assert.equal(f.calls.length, 0);
});

test('exact quote precedes single-use generation and frozen request bytes cannot be changed', async () => {
  const f = fixture(), source = request(), prepared = f.adapter.prepare(source);
  source.instructions = 'changed'; source.tools[0].parameters = {}; source.input[0] = { role: 'user', content: 'changed' };
  await assert.rejects(f.adapter.complete(prepared, { signal: liveSignal() }), code('model_quote_required'));
  await assert.rejects(f.adapter.quote({ ...prepared }, { signal: liveSignal() }), code('model_request_invalid'));
  const counted = await f.adapter.quote(prepared, { signal: liveSignal() }); assert.deepEqual(counted, quote); counted.inputTokens = 0;
  assert.deepEqual(await f.adapter.quote(prepared, { signal: liveSignal() }), quote); assert.equal(f.calls.length, 1);
  const turn = await f.adapter.complete(prepared, { signal: liveSignal() });
  assert.equal(turn.toolCalls[0].arguments.versionId, 'version_fixture'); assert.equal(turn.costMicrousd, 69);
  assert.equal(f.calls.length, 2); assert.equal(f.reads, 2);
  const countBody = JSON.parse(f.calls[0].init.body as string), generationBody = JSON.parse(f.calls[1].init.body as string);
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/responses/input_tokens'); assert.equal(f.calls[1].url, 'https://api.openai.com/v1/responses');
  assert.equal(generationBody.store, false); assert.equal(generationBody.stream, false); assert.equal(generationBody.service_tier, 'default'); assert.equal(generationBody.parallel_tool_calls, false);
  assert.equal(generationBody.instructions, 'Use only the supplied tools.'); assert.equal(generationBody.tools[0].strict, true); assert.equal(generationBody.tools[0].type, 'function'); assert.equal(generationBody.max_output_tokens, 2048);
  const { store: _s, stream: _st, service_tier: _tier, max_output_tokens: _m, ...tokenizable } = generationBody; assert.deepEqual(tokenizable, countBody);
  assert.equal(f.calls[1].init.redirect, 'error'); assert.equal('previous_response_id' in generationBody, false); assert.equal('reasoning' in generationBody, false);
  await assert.rejects(f.adapter.complete(prepared, { signal: liveSignal() }), code('model_already_used')); assert.equal(f.calls.length, 2);
});

test('concurrent duplicate generation is fenced before the second fetch', async () => {
  let release!: (response: Response) => void;
  const f = fixture(url => url.endsWith('/input_tokens') ? json({ object: 'response.input_tokens', input_tokens: 100 }) : new Promise(resolve => { release = resolve; }));
  const p = f.adapter.prepare(request()); await f.adapter.quote(p, { signal: liveSignal() }); const first = f.adapter.complete(p, { signal: liveSignal() });
  await assert.rejects(f.adapter.complete(p, { signal: liveSignal() }), code('model_already_used'));
  await new Promise(resolve => setImmediate(resolve)); release(json(response())); await first; assert.equal(f.calls.length, 2);
});

test('discard invalidates a prepared request and pending capacity is bounded', async () => {
  const f = fixture(); const pending = Array.from({ length: MODEL_LIMITS.pending }, () => f.adapter.prepare(request()));
  assert.throws(() => f.adapter.prepare(request()), code('model_capacity')); f.adapter.discard(pending[0]);
  f.adapter.prepare(request()); await assert.rejects(f.adapter.quote(pending[0], { signal: liveSignal() }), code('model_already_used')); assert.equal(f.calls.length, 0);
});

test('current coordinator tool schemas satisfy the strict supported subset', () => {
  validateToolDefinitions([...WORKSPACE_TOOLS, ...COMMON_TOOLS, GMAIL_TOOL, REPLAN_TOOL]);
});

test('strict nested schema validation denies missing, extra and invalid fields', () => {
  validateToolDefinitions(tools);
  for (const args of [{ versionId: 'a' }, { versionId: 'a', mode: 'text', extra: true }, { versionId: 2, mode: null }, { versionId: '', mode: null }, { versionId: 'a', mode: 'binary' }, JSON.parse('{"versionId":"a","mode":null,"__proto__":{}}')]) assert.equal(argumentsMatch(args, tools[0].parameters), false);
  assert.equal(argumentsMatch({ versionId: 'a', mode: null }, tools[0].parameters), true);
  const nested = { type: 'object', properties: { rows: { type: 'array', maxItems: 2, items: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['count'], additionalProperties: false } } }, required: ['rows'], additionalProperties: false };
  validateToolDefinitions([{ name: 'nested', description: '', parameters: nested }]);
  for (const value of [{ rows: [{ count: 1.5 }] }, { rows: [{ count: 0 }] }, { rows: [{ count: 1, extra: true }] }, { rows: [{ count: 1 }, { count: 2 }, { count: 3 }] }]) assert.equal(argumentsMatch(value, nested), false);
});

test('unsupported schema keywords, optional object keys and built-in tools are rejected before network', () => {
  const invalid = [
    { ...tools[0], parameters: { ...tools[0].parameters, additionalProperties: true } },
    { ...tools[0], parameters: { ...tools[0].parameters, required: ['versionId'] } },
    { ...tools[0], parameters: { ...tools[0].parameters, $ref: 'untrusted' } },
    { ...tools[0], name: 'browser.eval' },
    { type: 'web_search' },
  ];
  const f = fixture(); for (const tool of invalid) assert.throws(() => f.adapter.prepare({ ...request(), tools: [tool as FunctionTool] }), code('model_schema_invalid')); assert.equal(f.reads, 0); assert.equal(f.calls.length, 0);
});

test('local request and message bounds fail before authentication', () => {
  const f = fixture();
  for (const extra of [{ maxOutputTokens: 0 }, { maxOutputTokens: 4097 }, { input: [] }, { input: [{ role: 'system', content: 'override' }] }, { input: [{ role: 'user', content: 'x'.repeat(65537) }] }]) assert.throws(() => f.adapter.prepare({ ...request(), ...extra } as ModelRequest), code('model_request_invalid'));
  assert.throws(() => f.adapter.prepare({ ...request(), input: [{ role: 'user', content: 'x'.repeat(65536) }, { role: 'assistant', content: 'y'.repeat(65536) }] }), code('model_request_limit'));
  assert.equal(f.calls.length, 0); assert.equal(f.reads, 0);
});

test('stateless tool history needs paired opaque call IDs and contains no reasoning', async () => {
  const f = fixture(), r = request(); r.input.push({ role: 'assistant', toolCall: { id: 'call_a', name: 'read_file', arguments: { versionId: 'a', mode: null } } }, { role: 'tool', callId: 'call_a', content: 'safe file text' });
  const p = f.adapter.prepare(r); await f.adapter.quote(p, { signal: liveSignal() });
  const input = JSON.parse(f.calls[0].init.body as string).input; assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'call_a', output: 'safe file text' });
  r.input.pop(); assert.throws(() => f.adapter.prepare(r), code('model_request_invalid'));
  assert.throws(() => f.adapter.prepare({ ...request(), input: [{ role: 'tool', callId: 'unknown', content: 'unpaired' }] }), code('model_request_invalid'));
});

test('unknown tools, multiple calls and invalid arguments retain known usage without dispatch', () => {
  const output = response().output as Record<string, unknown>[];
  const bad = [[{ ...output[0], name: 'shell' }], [output[0], { ...output[0], call_id: 'second' }], [{ ...output[0], arguments: '{' }], [{ ...output[0], arguments: JSON.stringify({ versionId: 'a', mode: null, extra: true }) }], [{ ...output[0], arguments: '"scalar"' }]];
  for (const items of bad) assert.throws(() => parseModelResponse(response({ output: items }), DEFAULT_MODEL, quote, tools), error => { code('model_tool_invalid')(error); assert.equal((error as ModelAdapterError).usage?.totalTokens, 120); assert.equal((error as ModelAdapterError).costMicrousd, 69); return true; });
});

test('raw reasoning, built-in tool results, refusals and incomplete output cannot enter the coordinator', () => {
  for (const item of [{ type: 'reasoning', summary: [], encrypted_content: 'opaque' }, { type: 'web_search_call', status: 'completed' }]) assert.throws(() => parseModelResponse(response({ output: [item] }), DEFAULT_MODEL, quote, tools), code('model_response_invalid'));
  assert.throws(() => parseModelResponse(response({ status: 'incomplete' }), DEFAULT_MODEL, quote, tools), code('model_incomplete'));
  assert.throws(() => parseModelResponse(response({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'declined' }] }] }), DEFAULT_MODEL, quote, tools), code('model_refusal'));
  const turn = parseModelResponse(response({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Readable answer', annotations: [] }] }] }), DEFAULT_MODEL, quote, tools); assert.equal(turn.text, 'Readable answer'); assert.deepEqual(turn.toolCalls, []);
});

test('model identity, tier, usage and exact reservation cannot be silently altered', () => {
  for (const extra of [{ model: 'other-model' }, { service_tier: 'priority' }]) assert.throws(() => parseModelResponse(response(extra), DEFAULT_MODEL, quote, tools), code('model_response_invalid'));
  for (const usage of [null, { input_tokens: -1, output_tokens: 20, total_tokens: 19 }, { input_tokens: 100, output_tokens: 20, total_tokens: 121 }, { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 101 } }]) assert.throws(() => parseModelResponse(response({ usage }), DEFAULT_MODEL, quote, tools), code('model_usage_invalid'));
  assert.throws(() => parseModelResponse(response(), DEFAULT_MODEL, { ...quote, inputTokens: 99 }, tools), error => { code('model_reservation_exceeded')(error); assert.equal((error as ModelAdapterError).costMicrousd, 69); return true; });
});

test('standard price reserves uncached input, rounds upward and discounts only verified cache usage', () => {
  assert.equal(maxCostMicrousd(DEFAULT_MODEL, 1_000_000, 0), 400_000); assert.equal(maxCostMicrousd(DEFAULT_MODEL, 0, 1_000_000), 1_600_000); assert.equal(maxCostMicrousd(DEFAULT_MODEL, 1, 0), 1);
  assert.equal(usageCostMicrousd(DEFAULT_MODEL, { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }), 100_000);
  assert.throws(() => maxCostMicrousd('unpriced-model', 100, 100), code('model_request_invalid'));
  assert.throws(() => maxCostMicrousd(DEFAULT_MODEL, NaN, 10), code('model_usage_invalid'));
});

test('HTTP errors neither retry nor expose response bodies or headers', async () => {
  for (const [status, expected] of [[429, 'model_rate_limited'], [401, 'model_credentials'], [403, 'model_credentials'], [500, 'model_http']] as const) {
    const f = fixture(() => new Response('untrusted-provider-body', { status })), p = f.adapter.prepare(request());
    await assert.rejects(f.adapter.quote(p, { signal: liveSignal() }), code(expected)); await assert.rejects(f.adapter.quote(p, { signal: liveSignal() }), code('model_already_used')); assert.equal(f.calls.length, 1);
  }
});

test('invalid count response cannot authorize generation', async () => {
  for (const count of [{ object: 'wrong', input_tokens: 100 }, { object: 'response.input_tokens', input_tokens: 200001 }, { object: 'response.input_tokens', input_tokens: 0.5 }]) {
    const f = fixture(() => json(count)), p = f.adapter.prepare(request()); await assert.rejects(f.adapter.quote(p, { signal: liveSignal() }), code('model_usage_invalid')); await assert.rejects(f.adapter.complete(p, { signal: liveSignal() }), code('model_quote_required')); assert.equal(f.calls.length, 1);
  }
});

test('caller cancellation before dispatch reads neither key nor network', async () => {
  const f = fixture(), p = f.adapter.prepare(request()), controller = new AbortController(); controller.abort();
  await assert.rejects(f.adapter.quote(p, { signal: controller.signal }), code('model_cancelled')); assert.equal(f.reads, 0); assert.equal(f.calls.length, 0);
});

test('timeout bounds a transport that never returns and does not retry', async () => {
  const f = fixture(() => new Promise(() => {}), 20), p = f.adapter.prepare(request());
  await assert.rejects(f.adapter.quote(p, { signal: liveSignal() }), code('model_timeout')); assert.equal(f.calls.length, 1);
});

test('caller abort interrupts a stalled response body and releases its reader', async () => {
  let cancelled = false;
  const f = fixture(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }))), p = f.adapter.prepare(request()), controller = new AbortController();
  const result = f.adapter.quote(p, { signal: controller.signal }); await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
  await assert.rejects(result, code('model_cancelled')); assert.equal(cancelled, true); assert.equal(f.calls.length, 1);
});

test('response byte limit applies to streamed bodies without content-length', async () => {
  let cancelled = false;
  const f = fixture(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MODEL_LIMITS.responseBytes + 1)); }, cancel() { cancelled = true; } }))), p = f.adapter.prepare(request());
  await assert.rejects(f.adapter.quote(p, { signal: liveSignal() }), code('model_response_limit')); assert.equal(cancelled, true);
  const declared = fixture(() => new Response('x', { headers: { 'content-length': String(MODEL_LIMITS.responseBytes + 1) } })); await assert.rejects(declared.adapter.quote(declared.adapter.prepare(request()), { signal: liveSignal() }), code('model_response_limit'));
});

test('malformed JSON/UTF8 and network objects return static safe errors', async () => {
  for (const body of ['{malformed', new Uint8Array([0xff])]) { const f = fixture(() => new Response(body)), p = f.adapter.prepare(request()); await assert.rejects(f.adapter.quote(p, { signal: liveSignal() }), code('model_response_invalid')); }
  const f = fixture(() => { throw new Error('untrusted-provider-body sk-synthetic_no_real_credential'); }); await assert.rejects(f.adapter.quote(f.adapter.prepare(request()), { signal: liveSignal() }), code('model_network'));
});

test('generation timeout is an unknown single-use outcome and cannot be replayed', async () => {
  const f = fixture(url => url.endsWith('/input_tokens') ? json({ object: 'response.input_tokens', input_tokens: 100 }) : new Promise(() => {}), 20), p = f.adapter.prepare(request()); await f.adapter.quote(p, { signal: liveSignal() });
  await assert.rejects(f.adapter.complete(p, { signal: liveSignal() }), error => { code('model_timeout')(error); assert.equal((error as ModelAdapterError).usage, null); return true; }); await assert.rejects(f.adapter.complete(p, { signal: liveSignal() }), code('model_already_used')); assert.equal(f.calls.length, 2);
});

test('credential read is bounded by the same request timeout and does not initiate fetch after expiry', async () => {
  let called = false;
  const adapter = new OpenAIResponsesAdapter({ credentials: { async status() { return { configured: true, message: null }; }, async read() { return new Promise(() => {}); } }, timeoutMs: 20, quoteTimeoutMs: 20, fetch: (async () => { called = true; return json({}); }) as typeof fetch });
  await assert.rejects(adapter.quote(adapter.prepare(request()), { signal: liveSignal() }), code('model_timeout')); assert.equal(called, false);
});
