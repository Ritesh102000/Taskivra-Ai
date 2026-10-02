import { createHash, randomUUID } from 'node:crypto';
import type { ModelProviderProfile } from '../contracts/model-providers';
import type { CredentialProvider } from './credentials';
import { argumentsMatch, validToolName, validateToolDefinitions } from './schema';
import { configuredCostMicrousd, isRecord, validateProviderInput } from './profiles';
import { MODEL_LIMITS } from './openai';
import { ModelAdapterError, type FunctionTool, type ModelAdapter, type ModelMessage, type ModelQuote, type ModelRequest, type ModelToolCall, type ModelTurn, type ModelUsage, type PreparedTurn } from './types';
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(v);
const bounded = (v: unknown, n: number): v is string => typeof v === 'string' && Buffer.byteLength(v) <= n;
const check = (s: AbortSignal) => { if (s.aborted) throw new ModelAdapterError('model_cancelled'); };
interface Entry { public: PreparedTurn; body: string; tools: FunctionTool[]; createdAt: number; quote: ModelQuote | null }
export interface ConfiguredAdapterOptions { profile: ModelProviderProfile; credentials: CredentialProvider; fetch?: typeof globalThis.fetch; timeoutMs?: number }
function validatedMessages(messages: ModelMessage[]): ModelMessage[] {
  if (!Array.isArray(messages) || !messages.length || messages.length > MODEL_LIMITS.messages) throw new ModelAdapterError('model_request_invalid');
  const seen = new Set<string>(); let pending: string | null = null;
  for (const m of messages) {
    if (!isRecord(m)) throw new ModelAdapterError('model_request_invalid');
    if (m.role === 'assistant' && 'toolCall' in m) {
      const call = m.toolCall;
      if (pending || Object.keys(m).sort().join(',') !== 'role,toolCall' || !isRecord(call) || Object.keys(call).sort().join(',') !== 'arguments,id,name' || !identifier(call.id) || seen.has(call.id) || !validToolName(call.name) || !isRecord(call.arguments) || Buffer.byteLength(JSON.stringify(call.arguments)) > MODEL_LIMITS.argumentsBytes) throw new ModelAdapterError('model_request_invalid');
      seen.add(call.id); pending = call.id;
    } else if (m.role === 'tool') {
      if (Object.keys(m).sort().join(',') !== 'callId,content,role' || m.callId !== pending || !pending || !bounded(m.content, 65536)) throw new ModelAdapterError('model_request_invalid');
      pending = null;
    } else if (pending || !['user', 'assistant'].includes(m.role) || Object.keys(m).sort().join(',') !== 'content,role' || !('content' in m) || !bounded(m.content, 65536)) throw new ModelAdapterError('model_request_invalid');
  }
  if (pending) throw new ModelAdapterError('model_request_invalid'); return messages;
}
function payload(profile: ModelProviderProfile, request: ModelRequest, tools: FunctionTool[]): object {
  const history = validatedMessages(request.input), base = { model: profile.model, stream: false };
  if (profile.kind === 'openai') return { ...base, instructions: request.instructions, store: false, service_tier: 'default', truncation: 'disabled', max_output_tokens: request.maxOutputTokens, parallel_tool_calls: false,
    tools: tools.map(tool => ({ type: 'function', ...tool, strict: true })),
    input: history.map(m => m.role === 'tool' ? { type: 'function_call_output', call_id: m.callId, output: m.content } : 'toolCall' in m ? { type: 'function_call', call_id: m.toolCall.id, name: m.toolCall.name, arguments: JSON.stringify(m.toolCall.arguments) } : m) };
  if (profile.kind === 'anthropic') return { ...base, system: request.instructions, max_tokens: request.maxOutputTokens,
    ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })), tool_choice: { type: 'auto', disable_parallel_tool_use: true } } : {}),
    messages: history.map(m => m.role === 'tool' ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.content }] } : 'toolCall' in m ? { role: 'assistant', content: [{ type: 'tool_use', id: m.toolCall.id, name: m.toolCall.name, input: m.toolCall.arguments }] } : m) };
  const native = profile.kind === 'ollama'; const callNames = new Map(history.filter(m => 'toolCall' in m).map(m => [(m as { toolCall: ModelToolCall }).toolCall.id, (m as { toolCall: ModelToolCall }).toolCall.name]));
  return { ...base, ...(native ? { think: false, options: { num_predict: request.maxOutputTokens, num_ctx: profile.maxInputTokens + profile.maxOutputTokens } } : { max_tokens: request.maxOutputTokens, parallel_tool_calls: false }),
    ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { ...t, ...(!native ? { strict: true } : {}) } })) } : {}),
    messages: [{ role: 'system', content: request.instructions }, ...history.map(m => m.role === 'tool' ? { role: 'tool', ...(native ? { tool_name: callNames.get(m.callId) } : { tool_call_id: m.callId }), content: m.content } : 'toolCall' in m ? { role: 'assistant', content: '', tool_calls: [{ ...(native ? {} : { id: m.toolCall.id, type: 'function' }), function: { name: m.toolCall.name, arguments: native ? m.toolCall.arguments : JSON.stringify(m.toolCall.arguments) } }] } : m)] };
}
function tokens(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_000_000) throw new ModelAdapterError('model_usage_invalid'); return value as number;
}
function usageFor(raw: Record<string, unknown>, profile: ModelProviderProfile): ModelUsage {
  let input: number, output: number, cached = 0;
  if (profile.kind === 'ollama') { input = tokens(raw.prompt_eval_count); output = tokens(raw.eval_count); cached = tokens(raw.prompt_eval_cached_count ?? 0); }
  else {
    if (!isRecord(raw.usage)) throw new ModelAdapterError('model_usage_invalid'); const u = raw.usage;
    if (profile.kind === 'anthropic') {
      // No caching is requested. Sum all input buckets at the configured full input rate.
      cached = tokens(u.cache_read_input_tokens ?? 0); input = tokens(u.input_tokens) + cached + tokens(u.cache_creation_input_tokens ?? 0); output = tokens(u.output_tokens);
    } else if (profile.kind === 'openai') { input = tokens(u.input_tokens); output = tokens(u.output_tokens); cached = isRecord(u.input_tokens_details) ? tokens(u.input_tokens_details.cached_tokens ?? 0) : 0; if (tokens(u.total_tokens) !== input + output) throw new ModelAdapterError('model_usage_invalid'); }
    else { input = tokens(u.prompt_tokens); output = tokens(u.completion_tokens); cached = isRecord(u.prompt_tokens_details) ? tokens(u.prompt_tokens_details.cached_tokens ?? 0) : 0; if (tokens(u.total_tokens) !== input + output) throw new ModelAdapterError('model_usage_invalid'); }
  }
  if (input > 2_000_000 || cached > input || input + output > 2_000_000) throw new ModelAdapterError('model_usage_invalid');
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, totalTokens: input + output };
}
export function parseConfiguredResponse(raw: unknown, profile: ModelProviderProfile, quote: ModelQuote, tools: FunctionTool[], turnId: string): ModelTurn {
  if (!isRecord(raw) || raw.model !== profile.model) throw new ModelAdapterError('model_response_invalid');
  const usage = usageFor(raw, profile), cost = configuredCostMicrousd(profile, usage.inputTokens, usage.outputTokens);
  const fail = (code: ConstructorParameters<typeof ModelAdapterError>[0]): never => { throw new ModelAdapterError(code, usage, cost); };
  if (usage.inputTokens > quote.inputTokens || usage.outputTokens > quote.outputTokens || cost > quote.maxCostMicrousd) fail('model_reservation_exceeded');
  let responseId: string = '', body: string = ''; const calls: ModelToolCall[] = [];
  function call(id: unknown, name: unknown, args: unknown, json: boolean) {
    if (calls.length || !identifier(id) || !validToolName(name)) fail('model_tool_invalid');
    const tool = tools.find(t => t.name === name); if (!tool) fail('model_tool_invalid');
    if (json) { if (!bounded(args, MODEL_LIMITS.argumentsBytes)) fail('model_tool_invalid'); try { args = JSON.parse(args as string); } catch { fail('model_tool_invalid'); } }
    if (!isRecord(args) || Buffer.byteLength(JSON.stringify(args)) > MODEL_LIMITS.argumentsBytes || !argumentsMatch(args, tool!.parameters)) fail('model_tool_invalid');
    calls.push({ id: id as string, name: name as string, arguments: args as Record<string, unknown> });
  }
  function content(value: unknown) { if (!bounded(value, MODEL_LIMITS.textBytes)) fail('model_response_limit'); body += (body ? '\n' : '') + value; }
  if (profile.kind === 'openai') {
    if (raw.status !== 'completed') fail('model_incomplete'); if (raw.service_tier !== undefined && raw.service_tier !== 'default') fail('model_response_invalid');
    if (!identifier(raw.id) || !Array.isArray(raw.output) || raw.output.length > 16) fail('model_response_invalid'); responseId = raw.id as string;
    for (const item of raw.output as unknown[]) {
      if (!isRecord(item) || (item.status !== undefined && item.status !== 'completed')) fail('model_response_invalid');
      const x = item as Record<string, unknown>;
      if (x.type === 'function_call') call(x.call_id, x.name, x.arguments, true);
      else if (x.type === 'message' && x.role === 'assistant' && Array.isArray(x.content) && x.content.length <= 8) for (const part of x.content) {
        if (!isRecord(part)) fail('model_response_invalid'); if (part.type === 'refusal') fail('model_refusal'); if (part.type !== 'output_text') fail('model_response_invalid'); content(part.text);
      } else fail('model_response_invalid');
    }
  } else if (profile.kind === 'anthropic') {
    if (!['end_turn', 'tool_use'].includes(raw.stop_reason as string)) fail(raw.stop_reason === 'refusal' ? 'model_refusal' : 'model_incomplete');
    if (!identifier(raw.id) || raw.type !== 'message' || raw.role !== 'assistant' || !Array.isArray(raw.content) || raw.content.length > 16) fail('model_response_invalid'); responseId = raw.id as string;
    for (const part of raw.content as unknown[]) {
      if (!isRecord(part)) fail('model_response_invalid'); const x = part as Record<string, unknown>;
      if (x.type === 'tool_use') call(x.id, x.name, x.input, false); else if (x.type === 'text') content(x.text); else fail('model_response_invalid');
    }
    if ((raw.stop_reason === 'tool_use') !== !!calls.length) fail('model_response_invalid');
  } else {
    let message: Record<string, unknown>;
    if (profile.kind === 'ollama') {
      if (raw.done !== true || (raw.done_reason !== undefined && raw.done_reason !== 'stop')) fail('model_incomplete');
      if (!isRecord(raw.message)) fail('model_response_invalid'); message = raw.message as Record<string, unknown>; responseId = turnId;
      if (message.thinking !== undefined && message.thinking !== '') fail('model_response_invalid');
    } else {
      if (!identifier(raw.id) || !Array.isArray(raw.choices) || raw.choices.length !== 1 || !isRecord(raw.choices[0])) fail('model_response_invalid');
      const choice = (raw.choices as Record<string, unknown>[])[0];
      if (!['stop', 'tool_calls'].includes(choice.finish_reason as string)) fail(choice.finish_reason === 'content_filter' ? 'model_refusal' : 'model_incomplete');
      if (!isRecord(choice.message)) fail('model_response_invalid'); message = choice.message as Record<string, unknown>; responseId = raw.id as string;
      if (message.refusal) fail('model_refusal');
      if (message.function_call || message.reasoning_content || message.reasoning) fail('model_response_invalid');
    }
    if (message.role !== 'assistant') fail('model_response_invalid'); if (message.content !== null && message.content !== undefined) content(message.content);
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 1) fail('model_tool_invalid');
      for (const value of message.tool_calls as unknown[]) {
        if (!isRecord(value) || !isRecord(value.function)) fail('model_tool_invalid'); const x = value as Record<string, unknown>, f = x.function as Record<string, unknown>;
        if (profile.kind !== 'ollama' && x.type !== 'function') fail('model_tool_invalid'); call(profile.kind === 'ollama' ? `ollama_${turnId.replaceAll('-', '')}` : x.id, f.name, f.arguments, profile.kind !== 'ollama');
      }
    }
    if (profile.kind === 'openai-compatible') { const choice = (raw.choices as Record<string, unknown>[])[0]; if ((choice.finish_reason === 'tool_calls') !== !!calls.length) fail('model_response_invalid'); }
  }
  if (Buffer.byteLength(body) > MODEL_LIMITS.textBytes || (!body.trim() && !calls.length)) fail('model_response_invalid');
  return { responseId, text: body, toolCalls: calls, usage, costMicrousd: cost };
}
/** Uses declared full input ceilings for reservations; never guesses tokenization or silently retries. */
export class ConfiguredModelAdapter implements ModelAdapter {
  readonly profile: Readonly<ModelProviderProfile>; readonly limits: Readonly<{ maxInputTokens: number; maxOutputTokens: number }>; private entries = new Map<string, Entry>(); private used = new WeakSet<PreparedTurn>(); private transport: typeof globalThis.fetch; private timeout: number;
  private generationDispatch = new WeakMap<PreparedTurn, boolean>();
  generationWasNotDispatched(prepared:PreparedTurn):boolean{return this.generationDispatch.get(prepared)===false;}
  constructor(private options: ConfiguredAdapterOptions) {
    const { id, revision, selectionId, createdAt, ...input } = options.profile; validateProviderInput(input);
    this.profile = Object.freeze(structuredClone(options.profile)); this.limits = Object.freeze({ maxInputTokens: this.profile.maxInputTokens, maxOutputTokens: this.profile.maxOutputTokens, requestInputBytes:this.profile.maxInputTokens }); this.transport = options.fetch ?? globalThis.fetch; this.timeout = options.timeoutMs ?? 45_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 120_000) throw new ModelAdapterError('model_request_invalid');
  }
  async status() { const state = this.profile.authentication === 'none' ? { configured: true, message: 'No API key required. Server availability and model tool support are checked when a task runs.' } : await this.options.credentials.status(); return { ...state, provider: this.profile.kind, model: this.profile.selectionId }; }
  prepare(request: ModelRequest): PreparedTurn {
    for (const [id, e] of this.entries) if (Date.now() - e.createdAt > 300_000) this.entries.delete(id); if (this.entries.size >= MODEL_LIMITS.pending) throw new ModelAdapterError('model_capacity');
    try {
      if (!isRecord(request) || Object.keys(request).sort().join(',') !== 'input,instructions,maxOutputTokens,tools' || !bounded(request.instructions, 32768) || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 64 || request.maxOutputTokens > this.profile.maxOutputTokens) throw new ModelAdapterError('model_request_invalid');
      validateToolDefinitions(request.tools); const toolList: FunctionTool[] = structuredClone(request.tools), body = JSON.stringify(payload(this.profile, request, toolList));
      if (Buffer.byteLength(body) > MODEL_LIMITS.requestBytes) throw new ModelAdapterError('model_request_limit');
      // A byte ceiling is a deliberately loose input guard, not a provider token count. The full configured input ceiling is reserved below.
      if (Buffer.byteLength(JSON.stringify({ instructions: request.instructions, input: request.input, tools: request.tools })) > this.profile.maxInputTokens) throw new ModelAdapterError('model_request_limit');
      const prepared = Object.freeze({ id: randomUUID(), model: this.profile.selectionId, requestHash: createHash('sha256').update(body).digest('hex'), requestBytes: Buffer.byteLength(body), maxOutputTokens: request.maxOutputTokens });
      this.entries.set(prepared.id, { public: prepared, body, tools: toolList, createdAt: Date.now(), quote: null }); this.generationDispatch.set(prepared,false); return prepared;
    } catch (e) { if (e instanceof ModelAdapterError) throw e; throw new ModelAdapterError('model_request_invalid'); }
  }
  private entry(prepared: PreparedTurn) { if (this.used.has(prepared)) throw new ModelAdapterError('model_already_used'); const e = this.entries.get(prepared.id); if (!e || e.public !== prepared || Date.now() - e.createdAt > 300_000) throw new ModelAdapterError('model_request_invalid'); return e; }
  localQuote(prepared:PreparedTurn):ModelQuote{this.entry(prepared);return{inputTokens:this.profile.maxInputTokens,outputTokens:prepared.maxOutputTokens,maxCostMicrousd:configuredCostMicrousd(this.profile,this.profile.maxInputTokens,prepared.maxOutputTokens)};}
  async quote(prepared: PreparedTurn, { signal }: { signal: AbortSignal }): Promise<ModelQuote> {
    check(signal); const e = this.entry(prepared); e.quote ??= Object.freeze({ inputTokens: this.profile.maxInputTokens, outputTokens: prepared.maxOutputTokens, maxCostMicrousd: configuredCostMicrousd(this.profile, this.profile.maxInputTokens, prepared.maxOutputTokens) }); return { ...e.quote };
  }
  async complete(prepared: PreparedTurn, { signal }: { signal: AbortSignal }): Promise<ModelTurn> {
    check(signal); const e = this.entry(prepared); if (!e.quote) throw new ModelAdapterError('model_quote_required'); this.used.add(prepared);
    const timeout = new AbortController(), combined = AbortSignal.any([signal, timeout.signal]); let timedOut = false, key = ''; const timer = setTimeout(() => { timedOut = true; timeout.abort(); }, this.timeout);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.profile.kind === 'anthropic') headers['anthropic-version'] = '2023-06-01';
      if (this.profile.authentication === 'api-key') {
        try { key = await abortable(this.options.credentials.read(), combined); } catch { throw new ModelAdapterError('model_credentials'); }
        if (!/^[\x21-\x7e]{8,1024}$/.test(key)) throw new ModelAdapterError('model_credentials');
        headers[this.profile.kind === 'anthropic' ? 'x-api-key' : 'Authorization'] = this.profile.kind === 'anthropic' ? key : 'Bearer ' + key;
      }
      check(combined); const suffix = this.profile.kind === 'openai' ? '/responses' : this.profile.kind === 'anthropic' ? '/messages' : this.profile.kind === 'ollama' ? '/api/chat' : '/chat/completions';
      this.generationDispatch.set(prepared,true);
      const fetching = this.transport(this.profile.baseUrl + suffix, { method: 'POST', redirect: 'error', headers, body: e.body, signal: combined });
      void fetching.then(r => { if (combined.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
      const response = await abortable(fetching, combined); key = ''; check(combined);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ModelAdapterError(response.status === 429 ? 'model_rate_limited' : [401, 403].includes(response.status) ? 'model_credentials' : 'model_http'); }
      const declared = response.headers.get('content-length'); if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MODEL_LIMITS.responseBytes)) { void response.body?.cancel().catch(() => {}); throw new ModelAdapterError('model_response_limit'); }
      if (!response.body) throw new ModelAdapterError('model_response_invalid');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); }; combined.addEventListener('abort', cancel, { once: true });
      try { while (true) { check(combined); const next = await abortable(reader.read(), combined); if (next.done) break; size += next.value.byteLength; if (size > MODEL_LIMITS.responseBytes) { cancel(); throw new ModelAdapterError('model_response_limit'); } chunks.push(next.value); } }
      finally { combined.removeEventListener('abort', cancel); reader.releaseLock(); }
      check(combined); let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new ModelAdapterError('model_response_invalid'); }
      return parseConfiguredResponse(raw, this.profile, e.quote, e.tools, prepared.id);
    } catch (error) { if (signal.aborted) throw new ModelAdapterError('model_cancelled'); if (timedOut) throw new ModelAdapterError('model_timeout'); if (error instanceof ModelAdapterError) throw error; throw new ModelAdapterError('model_network'); }
    finally { key = ''; clearTimeout(timer); this.entries.delete(prepared.id); }
  }
  discard(prepared: PreparedTurn) { if (this.entries.get(prepared.id)?.public === prepared) this.entries.delete(prepared.id); this.used.add(prepared); }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(new ModelAdapterError('model_cancelled')); }
  return new Promise((resolve, reject) => { const abort = () => reject(new ModelAdapterError('model_cancelled')); signal.addEventListener('abort', abort, { once: true }); promise.then(v => { signal.removeEventListener('abort', abort); resolve(v); }, e => { signal.removeEventListener('abort', abort); reject(e); }); });
}
