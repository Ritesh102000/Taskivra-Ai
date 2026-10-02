import type { CredentialStatus } from './credentials';
export interface FunctionTool { name: string; description: string; parameters: Record<string, unknown> }
export interface ModelToolCall { id: string; name: string; arguments: Record<string, unknown> }
export type ModelMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; toolCall: ModelToolCall }
  | { role: 'tool'; callId: string; content: string };
export interface ModelRequest { instructions: string; input: ModelMessage[]; tools: FunctionTool[]; maxOutputTokens: number }
/** Safe identity only. The adapter privately retains the frozen request bytes. */
export interface PreparedTurn { readonly id: string; readonly model: string; readonly requestHash: string; readonly requestBytes: number; readonly maxOutputTokens: number }
export interface ModelQuote { inputTokens: number; outputTokens: number; maxCostMicrousd: number }
export interface ModelUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number }
export interface ModelTurn { responseId: string; text: string; toolCalls: ModelToolCall[]; usage: ModelUsage; costMicrousd: number }
export interface ModelStatus extends CredentialStatus { provider: string; model: string }
export interface ModelAdapter {
  readonly limits?: { readonly maxInputTokens: number; readonly maxOutputTokens: number; readonly requestInputBytes?:number };
  status(): Promise<ModelStatus>;
  prepare(request: ModelRequest): PreparedTurn;
  localQuote?(prepared:PreparedTurn):ModelQuote;
  quote(prepared: PreparedTurn, options: { signal: AbortSignal }): Promise<ModelQuote>;
  complete(prepared: PreparedTurn, options: { signal: AbortSignal }): Promise<ModelTurn>;
  /** Adapter-owned evidence for this exact generation attempt; unknown adapters retain holds. */
  generationWasNotDispatched?(prepared:PreparedTurn):boolean;
  discard(prepared: PreparedTurn): void;
}
export type ModelErrorCode = 'model_request_invalid' | 'model_request_limit' | 'model_schema_invalid' | 'model_credentials' | 'model_cancelled' | 'model_timeout' | 'model_network' | 'model_http' | 'model_rate_limited' | 'model_response_limit' | 'model_response_invalid' | 'model_tool_invalid' | 'model_incomplete' | 'model_refusal' | 'model_quote_required' | 'model_already_used' | 'model_capacity' | 'model_usage_invalid' | 'model_reservation_exceeded';
export class ModelAdapterError extends Error {
  constructor(readonly code: ModelErrorCode, readonly usage: ModelUsage | null = null, readonly costMicrousd: number | null = null) {
    const message = {
      model_request_invalid: 'The model request is invalid.', model_request_limit: 'The model request exceeded its local size limit.', model_schema_invalid: 'The tool definition does not satisfy the strict supported schema.',
      model_credentials: 'The selected model key is unavailable in macOS Keychain.', model_cancelled: 'The model request was cancelled; no retry was sent.', model_timeout: 'The model request timed out; its outcome may be billable. No retry was sent.',
      model_network: 'The model connection failed; its outcome may be billable. No retry was sent.', model_http: 'The model provider rejected the request. Check the model and account configuration.', model_rate_limited: 'The model provider rate-limited the request. No retry was sent.',
      model_response_limit: 'The model response exceeded the local byte limit.', model_response_invalid: 'The model response was not valid for this protocol.', model_tool_invalid: 'The model requested an unknown tool or invalid arguments.',
      model_incomplete: 'The model did not complete its response; no tool was dispatched.', model_refusal: 'The model declined the request; no tool was dispatched.', model_quote_required: 'Count and reserve this exact request before generation.',
      model_already_used: 'This model generation attempt has already been dispatched.', model_capacity: 'Too many model requests are pending.', model_usage_invalid: 'The provider returned invalid token usage.', model_reservation_exceeded: 'Provider usage exceeded the counted reservation; stop further model requests.',
    }[code];
    super(message); this.name = 'ModelAdapterError';
  }
}
