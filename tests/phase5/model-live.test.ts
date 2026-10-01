import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OpenAIResponsesAdapter, MacKeychainCredentials, DEFAULT_MODEL } from '../../packages/model-adapters';

test('explicit opt-in: one bounded synthetic OpenAI count and strict function call', { skip: process.env.AW_MODEL_LIVE_TEST !== '1' }, async () => {
  const credentials = new MacKeychainCredentials({ helperPath: resolve('packages/model-adapters/bin/keychain-helper') });
  const adapter = new OpenAIResponsesAdapter({ credentials });
  assert.equal((await adapter.status()).configured, true);
  const prepared = adapter.prepare({
    instructions: 'This is a synthetic protocol check. Call probe_ready exactly once with ready=true. Do not add text.',
    input: [{ role: 'user', content: 'Verify the tool protocol now.' }], maxOutputTokens: 128,
    tools: [{ name: 'probe_ready', description: 'Confirm this synthetic protocol check.', parameters: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false } }],
  });
  try {
    const signal = new AbortController().signal;
    const quote = await adapter.quote(prepared, { signal });
    assert.ok(quote.inputTokens < 1000); assert.ok(quote.maxCostMicrousd < 10_000);
    const result = await adapter.complete(prepared, { signal });
    assert.equal(result.toolCalls.length, 1); assert.equal(result.toolCalls[0].name, 'probe_ready'); assert.deepEqual(result.toolCalls[0].arguments, { ready: true });
    assert.ok(result.costMicrousd <= quote.maxCostMicrousd);
    if (process.env.AW_MODEL_EVIDENCE === '1') {
      const directory = resolve('packages/model-adapters/evidence'); await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, 'live-probe.json'), JSON.stringify({ checkedAt: new Date().toISOString(), model: DEFAULT_MODEL, synthetic: true, generationRequests: 1, countRequests: 1, quote, usage: result.usage, costMicrousd: result.costMicrousd, strictToolCallVerified: true, credentialSource: 'macOS Keychain; key omitted', store: false, parallelToolCalls: false }, null, 2) + '\n', { mode: 0o600 });
    }
  } finally { adapter.discard(prepared); }
});
