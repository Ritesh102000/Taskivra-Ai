import { ModelAdapterError, type ModelUsage } from './types';
/** Official standard-tier pricing verified 2026-09-11; no cached discount is needed for reservations. */
export const MODEL_CHOICES = [{
  provider: 'openai', id: 'gpt-4.1-mini-2025-04-14', label: 'GPT-4.1 mini',
  inputUsdPerMillion: 0.4, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 1.6,
  contextTokens: 1_047_576, maxOutputTokens: 32768,
  pricingVerifiedAt: '2026-09-11', pricingSource: 'https://developers.openai.com/api/docs/pricing',
  modelSource: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
}] as const;
export const DEFAULT_MODEL = MODEL_CHOICES[0].id;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export function modelChoice(id: string) { const choice = MODEL_CHOICES.find(m => m.id === id); if (!choice) throw new ModelAdapterError('model_request_invalid'); return choice; }
const integer = (n: number) => { if (!Number.isSafeInteger(n) || n < 0 || n > 2_000_000) throw new ModelAdapterError('model_usage_invalid'); return BigInt(n); };
/** Integer microdollars, rounded upward; one USD = 1,000,000 microdollars. */
export function maxCostMicrousd(model: string, inputTokens: number, outputTokens: number): number {
  modelChoice(model); return Number((integer(inputTokens) * 4n + integer(outputTokens) * 16n + 9n) / 10n);
}
export function usageCostMicrousd(model: string, usage: ModelUsage): number {
  modelChoice(model);
  if (usage.cachedInputTokens > usage.inputTokens || usage.totalTokens !== usage.inputTokens + usage.outputTokens) throw new ModelAdapterError('model_usage_invalid');
  return Number((integer(usage.inputTokens - usage.cachedInputTokens) * 4n + integer(usage.cachedInputTokens) + integer(usage.outputTokens) * 16n + 9n) / 10n);
}
