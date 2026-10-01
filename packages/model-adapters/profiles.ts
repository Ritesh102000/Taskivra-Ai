import { createHash } from 'node:crypto';
import type { ModelProviderInput, ModelProviderProfile } from '../contracts/model-providers';
export class ProviderConfigurationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProviderConfigurationError'; }
}
function fail(message = 'Check the connection fields and model limits.'): never { throw new ProviderConfigurationError('provider_invalid', message); }
const fields = ['label', 'kind', 'baseUrl', 'model', 'authentication', 'billing', 'inputUsdPerMillion', 'outputUsdPerMillion', 'maxInputTokens', 'maxOutputTokens', 'toolCalling'];
export function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function isLoopback(host: string): boolean { return ['localhost', '127.0.0.1', '[::1]'].includes(host.toLowerCase()); }
export function normalizeProviderUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || value.trim() !== value || /[\s\\]/.test(value)) fail('Use a complete HTTPS API base URL, or HTTP on localhost.');
  let url: URL; try { url = new URL(value); } catch { return fail('Use a complete API base URL.'); }
  if (url.username || url.password || url.search || url.hash || !url.hostname || !['https:', 'http:'].includes(url.protocol)) fail('API URLs cannot include credentials, query parameters or fragments.');
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) fail('Remote model servers must use HTTPS. HTTP is allowed only on localhost.');
  if (/%2f|%5c|%2e/i.test(url.pathname)) fail('Use a plain API path without encoded separators.');
  return url.href.replace(/\/+$/, '');
}
export function validateProviderInput(value: unknown): ModelProviderInput {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail();
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.trim() !== value.label || value.label.length > 80 || /[\x00-\x1f\x7f]/.test(value.label)) fail('Give this connection a short name.');
  if (!['openai', 'anthropic', 'ollama', 'openai-compatible'].includes(value.kind as string) || !['api-key', 'none'].includes(value.authentication as string) || !['metered', 'local'].includes(value.billing as string)) fail();
  if (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,191}$/.test(value.model)) fail('Enter the exact model identifier supported by your server.');
  const baseUrl = normalizeProviderUrl(value.baseUrl), url = new URL(baseUrl);
  if (value.kind === 'openai' && baseUrl !== 'https://api.openai.com/v1') fail('OpenAI connections use https://api.openai.com/v1. Choose a compatible server for other endpoints.');
  if (value.kind === 'anthropic' && baseUrl !== 'https://api.anthropic.com/v1') fail('Claude connections use https://api.anthropic.com/v1.');
  if (['openai', 'anthropic'].includes(value.kind as string) && (value.authentication !== 'api-key' || value.billing !== 'metered')) fail('Cloud OpenAI and Claude require an API key and declared pricing.');
  if (value.billing === 'local' && !isLoopback(url.hostname)) fail('No provider-fee mode is available only for an explicitly configured localhost server.');
  for (const field of ['inputUsdPerMillion', 'outputUsdPerMillion']) if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0 || value[field] > 10_000 || Math.abs(value[field] * 1_000_000 - Math.round(value[field] * 1_000_000)) > 0.00001) fail('Enter nonnegative USD prices with at most six decimal places.');
  if (value.billing === 'local' && (value.inputUsdPerMillion !== 0 || value.outputUsdPerMillion !== 0)) fail('Local mode records zero provider fees; hardware and electricity costs are not measured.');
  if (value.billing === 'metered' && (!(value.inputUsdPerMillion as number) || !(value.outputUsdPerMillion as number))) fail('Enter both provider prices before enabling a metered model.');
  if (!Number.isSafeInteger(value.maxInputTokens) || (value.maxInputTokens as number) < 1024 || (value.maxInputTokens as number) > 200_000 || !Number.isSafeInteger(value.maxOutputTokens) || (value.maxOutputTokens as number) < 64 || (value.maxOutputTokens as number) > 4096 || value.toolCalling !== true) fail('Use a tool-capable model, 1,024–200,000 reserved input tokens and 64–4,096 output tokens.');
  return { ...value, baseUrl } as unknown as ModelProviderInput;
}
export function providerSelectionId(id: string, revision: number): string { return `profile:${id}:${revision}`; }
export function providerCredentialAccount(profile: ModelProviderProfile): string {
  // Every immutable endpoint revision has a separate Keychain item. Never reuse a key at a changed URL.
  return 'provider-' + createHash('sha256').update(`${profile.selectionId}\n${profile.baseUrl}\n${profile.kind}`).digest('hex');
}
export function configuredCostMicrousd(profile: ModelProviderInput, inputTokens: number, outputTokens: number): number {
  if (![inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2_000_000)) throw new ProviderConfigurationError('provider_usage_invalid', 'The provider returned invalid usage.');
  const numerator = BigInt(inputTokens) * BigInt(Math.round(profile.inputUsdPerMillion * 1_000_000)) + BigInt(outputTokens) * BigInt(Math.round(profile.outputUsdPerMillion * 1_000_000));
  const result = Number((numerator + 999_999n) / 1_000_000n);
  if (!Number.isSafeInteger(result)) fail(); return result;
}
