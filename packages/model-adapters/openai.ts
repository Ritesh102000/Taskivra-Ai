import { createHash, randomUUID } from 'node:crypto';
import type { CredentialProvider } from './credentials';
import { argumentsMatch, validToolName, validateToolDefinitions } from './schema';
import { DEFAULT_MODEL, maxCostMicrousd, modelChoice, usageCostMicrousd } from './pricing';
import { ModelAdapterError, type FunctionTool, type ModelAdapter, type ModelMessage, type ModelQuote, type ModelRequest, type ModelToolCall, type ModelTurn, type ModelUsage, type PreparedTurn } from './types';

export const MODEL_LIMITS = { requestBytes: 128 * 1024, responseBytes: 512 * 1024, argumentsBytes: 16 * 1024, textBytes: 32 * 1024, inputTokens: 200_000, outputTokens: 4096, messages: 64, pending: 8, timeoutMs: 45_000, quoteTimeoutMs: 20_000 } as const;
const ENDPOINT = 'https://api.openai.com/v1/responses';
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(v);
function check(signal: AbortSignal): void { if (signal.aborted) throw new ModelAdapterError('model_cancelled'); }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && Buffer.byteLength(value) <= maximum; }
interface Entry { public: PreparedTurn; body: string; countBody: string; tools: FunctionTool[]; createdAt: number; quoteAttempted: boolean; quote: ModelQuote | null }
export interface OpenAIAdapterOptions { credentials: CredentialProvider; model?: string; /** Dependency injection for local tests; endpoints remain fixed. */ fetch?: typeof globalThis.fetch; timeoutMs?: number; quoteTimeoutMs?: number }

function inputItems(messages: ModelMessage[]): object[] {
  if (!Array.isArray(messages) || !messages.length || messages.length > MODEL_LIMITS.messages) throw new ModelAdapterError('model_request_invalid');
  const calls = new Set<string>(), pending = new Set<string>();
  const result = messages.map(message => {
    if (!object(message)) throw new ModelAdapterError('model_request_invalid');
    if (message.role === 'assistant' && 'toolCall' in message) {
      const call = message.toolCall;
      if (Object.keys(message).sort().join(',') !== 'role,toolCall' || !object(call) || !identifier(call.id) || calls.has(call.id) || !validToolName(call.name) || !object(call.arguments)) throw new ModelAdapterError('model_request_invalid');
      const args = JSON.stringify(call.arguments); if (Buffer.byteLength(args) > MODEL_LIMITS.argumentsBytes) throw new ModelAdapterError('model_request_limit');
      calls.add(call.id); pending.add(call.id); return { type: 'function_call', call_id: call.id, name: call.name, arguments: args };
    }
    if (message.role === 'tool') {
      if (Object.keys(message).sort().join(',') !== 'callId,content,role' || !identifier(message.callId) || !pending.delete(message.callId) || !text(message.content, 64 * 1024)) throw new ModelAdapterError('model_request_invalid');
      return { type: 'function_call_output', call_id: message.callId, output: message.content };
    }
    if (!['user', 'assistant'].includes(message.role) || Object.keys(message).sort().join(',') !== 'content,role' || !('content' in message) || !text(message.content, 64 * 1024)) throw new ModelAdapterError('model_request_invalid');
    return { role: message.role, content: message.content };
  });
  if (pending.size) throw new ModelAdapterError('model_request_invalid'); return result;
}
function readUsage(response: Record<string, unknown>): ModelUsage {
  if (!object(response.usage)) throw new ModelAdapterError('model_usage_invalid');
  const raw = response.usage;
  const cached = object(raw.input_tokens_details) ? raw.input_tokens_details.cached_tokens ?? 0 : 0;
  for (const value of [raw.input_tokens, raw.output_tokens, raw.total_tokens, cached]) if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_000_000) throw new ModelAdapterError('model_usage_invalid');
  if ((cached as number) > (raw.input_tokens as number) || raw.total_tokens !== (raw.input_tokens as number) + (raw.output_tokens as number)) throw new ModelAdapterError('model_usage_invalid');
  return { inputTokens: raw.input_tokens as number, outputTokens: raw.output_tokens as number, totalTokens: raw.total_tokens as number, cachedInputTokens: cached as number };
}
export function parseModelResponse(raw: unknown, model: string, quote: ModelQuote, tools: FunctionTool[]): ModelTurn {
  if (!object(raw) || raw.model !== model || (raw.service_tier !== undefined && raw.service_tier !== 'default')) throw new ModelAdapterError('model_response_invalid');
  const usage = readUsage(raw), cost = usageCostMicrousd(model, usage);
  function fail(code: ConstructorParameters<typeof ModelAdapterError>[0]): never { throw new ModelAdapterError(code, usage, cost); }
  if (usage.inputTokens > quote.inputTokens || usage.outputTokens > quote.outputTokens || cost > quote.maxCostMicrousd) fail('model_reservation_exceeded');
  if (raw.status !== 'completed') fail('model_incomplete');
  if (!identifier(raw.id) || !Array.isArray(raw.output) || raw.output.length > 16) fail('model_response_invalid');
  const calls: ModelToolCall[] = []; const messages: string[] = [];
  for (const item of raw.output) {
    if (!object(item) || (item.status !== undefined && item.status !== 'completed')) fail('model_response_invalid');
    if (item.type === 'function_call') {
      if (calls.length || !identifier(item.call_id) || !validToolName(item.name) || !text(item.arguments, MODEL_LIMITS.argumentsBytes)) fail('model_tool_invalid');
      const tool = tools.find(tool => tool.name === item.name); if (!tool) fail('model_tool_invalid');
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch { fail('model_tool_invalid'); }
      if (!object(args) || !argumentsMatch(args, tool.parameters)) fail('model_tool_invalid');
      calls.push({ id: item.call_id, name: item.name, arguments: args });
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length > 8) fail('model_response_invalid');
      for (const content of item.content) {
        if (!object(content)) fail('model_response_invalid');
        if (content.type === 'refusal') fail('model_refusal');
        if (content.type !== 'output_text' || !text(content.text, MODEL_LIMITS.textBytes)) fail('model_response_invalid');
        messages.push(content.text);
      }
    } else {
      // No provider built-in tools or hidden/raw reasoning enters the coordinator.
      fail('model_response_invalid');
    }
  }
  const output = messages.join('\n'); if (Buffer.byteLength(output) > MODEL_LIMITS.textBytes || (!output.trim() && !calls.length)) fail('model_response_invalid');
  return { responseId: raw.id as string, text: output, toolCalls: calls, usage, costMicrousd: cost };
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  private readonly model: string;
  private readonly entries = new Map<string, Entry>(); private readonly used = new WeakSet<PreparedTurn>();
  private readonly transport: typeof globalThis.fetch;
  private readonly timeout: number; private readonly quoteTimeout: number;
  constructor(private readonly options: OpenAIAdapterOptions) {
    this.model = options.model || DEFAULT_MODEL; modelChoice(this.model); this.transport = options.fetch || globalThis.fetch;
    this.timeout = options.timeoutMs ?? MODEL_LIMITS.timeoutMs; this.quoteTimeout = options.quoteTimeoutMs ?? MODEL_LIMITS.quoteTimeoutMs;
    if (![this.timeout, this.quoteTimeout].every(n => Number.isSafeInteger(n) && n >= 10 && n <= 45000)) throw new ModelAdapterError('model_request_invalid');
  }
  async status() { return { ...await this.options.credentials.status(), provider: 'openai', model: this.model }; }
  prepare(request: ModelRequest): PreparedTurn {
    for (const [id, entry] of this.entries) if (Date.now() - entry.createdAt > 300_000) this.entries.delete(id);
    if (this.entries.size >= MODEL_LIMITS.pending) throw new ModelAdapterError('model_capacity');
    try {
      if (!object(request) || Object.keys(request).sort().join(',') !== 'input,instructions,maxOutputTokens,tools' || !text(request.instructions, 32 * 1024) || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 64 || request.maxOutputTokens > MODEL_LIMITS.outputTokens) throw new ModelAdapterError('model_request_invalid');
      validateToolDefinitions(request.tools);
      const tools: FunctionTool[] = JSON.parse(JSON.stringify(request.tools));
      const shared = { model: this.model, instructions: request.instructions, input: inputItems(request.input), tools: tools.map(tool => ({ type: 'function', ...tool, strict: true })), parallel_tool_calls: false, tool_choice: 'auto', truncation: 'disabled' };
      const countBody = JSON.stringify(shared), body = JSON.stringify({ ...shared, store: false, stream: false, service_tier: 'default', max_output_tokens: request.maxOutputTokens });
      if (Buffer.byteLength(body) > MODEL_LIMITS.requestBytes) throw new ModelAdapterError('model_request_limit');
      const prepared = Object.freeze({ id: randomUUID(), model: this.model, requestHash: createHash('sha256').update(body).digest('hex'), requestBytes: Buffer.byteLength(body), maxOutputTokens: request.maxOutputTokens });
      this.entries.set(prepared.id, { public: prepared, body, countBody, tools, createdAt: Date.now(), quoteAttempted: false, quote: null }); return prepared;
    } catch (error) { if (error instanceof ModelAdapterError) throw error; throw new ModelAdapterError('model_request_invalid'); }
  }
  private entry(prepared: PreparedTurn): Entry {
    if (this.used.has(prepared)) throw new ModelAdapterError('model_already_used');
    const entry = this.entries.get(prepared.id); if (!entry || entry.public !== prepared || Date.now() - entry.createdAt > 300_000) throw new ModelAdapterError('model_request_invalid'); return entry;
  }
  private async post(path: string, body: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    check(signal); let key = '';
    const local = new AbortController(), combined = AbortSignal.any([signal, local.signal]); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; local.abort(); }, timeoutMs);
    try {
      try { key = await abortable(this.options.credentials.read(), combined); } catch { throw new ModelAdapterError('model_credentials'); }
      check(combined); if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key)) throw new ModelAdapterError('model_credentials');
      const fetching = this.transport(ENDPOINT + path, { method: 'POST', redirect: 'error', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body, signal: combined });
      // Even a custom transport resolving after cancellation must release its body.
      void fetching.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await abortable(fetching, combined);
      key = ''; check(combined);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ModelAdapterError(response.status === 429 ? 'model_rate_limited' : response.status === 401 || response.status === 403 ? 'model_credentials' : 'model_http'); }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MODEL_LIMITS.responseBytes)) { void response.body?.cancel().catch(() => {}); throw new ModelAdapterError('model_response_limit'); }
      if (!response.body) throw new ModelAdapterError('model_response_invalid');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      combined.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          check(combined); const next = await abortable(reader.read(), combined); if (next.done) break;
          bytes += next.value.byteLength; if (bytes > MODEL_LIMITS.responseBytes) { cancel(); throw new ModelAdapterError('model_response_limit'); } chunks.push(next.value);
        }
      } finally { combined.removeEventListener('abort', cancel); reader.releaseLock(); }
      check(combined);
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new ModelAdapterError('model_response_invalid'); }
    } catch (error) {
      if (signal.aborted) throw new ModelAdapterError('model_cancelled');
      if (timedOut) throw new ModelAdapterError('model_timeout');
      if (error instanceof ModelAdapterError) throw error;
      // Never retain a fetch/HTTP error object, which can contain headers or request bodies.
      throw new ModelAdapterError('model_network');
    } finally { key = ''; clearTimeout(timer); }
  }
  async quote(prepared: PreparedTurn, { signal }: { signal: AbortSignal }): Promise<ModelQuote> {
    check(signal); const entry = this.entry(prepared);
    if (entry.quote) return { ...entry.quote };
    if (entry.quoteAttempted) throw new ModelAdapterError('model_already_used'); entry.quoteAttempted = true;
    const response = await this.post('/input_tokens', entry.countBody, signal, this.quoteTimeout);
    if (!object(response) || response.object !== 'response.input_tokens' || !Number.isSafeInteger(response.input_tokens) || (response.input_tokens as number) < 0 || (response.input_tokens as number) > MODEL_LIMITS.inputTokens) throw new ModelAdapterError('model_usage_invalid');
    entry.quote = Object.freeze({ inputTokens: response.input_tokens as number, outputTokens: prepared.maxOutputTokens, maxCostMicrousd: maxCostMicrousd(this.model, response.input_tokens as number, prepared.maxOutputTokens) });
    return { ...entry.quote };
  }
  async complete(prepared: PreparedTurn, { signal }: { signal: AbortSignal }): Promise<ModelTurn> {
    check(signal); const entry = this.entry(prepared); if (!entry.quote) throw new ModelAdapterError('model_quote_required');
    this.used.add(prepared);
    try { return parseModelResponse(await this.post('', entry.body, signal, this.timeout), this.model, entry.quote, entry.tools); }
    finally { this.entries.delete(prepared.id); }
  }
  discard(prepared: PreparedTurn): void { if (this.entries.get(prepared.id)?.public === prepared) this.entries.delete(prepared.id); this.used.add(prepared); }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(new ModelAdapterError('model_cancelled')); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ModelAdapterError('model_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
