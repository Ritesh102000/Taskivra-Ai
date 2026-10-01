import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fitModelInput, serializeAgentContext } from '../../packages/agent-loop/context';
import { buildAgentPrompt } from '../../packages/agent-loop/prompts';
import { FLEET_TOOLS, LAB_TOOLS, toolsForPolicy } from '../../packages/agent-loop/tools';
import { FLEET_LAB_LEAD_TOOLS } from '../../packages/fleet';
import { FLEET_LAB_URL } from '../../packages/contracts/fleet';
import { LiveError } from '../../packages/contracts/live-validation';
import { ConfiguredModelAdapter, ModelAdapterError, configuredCostMicrousd, providerSelectionId } from '../../packages/model-adapters';
import type { ModelProviderProfile } from '../../packages/contracts/model-providers';
import type { ModelAdapter, ModelMessage, FunctionTool } from '../../packages/model-adapters/types';

const policy = { mode: 'workspace' as const, allowedOrigins: [new URL(FLEET_LAB_URL).origin], browserInteraction: 'reviewed_actions' as const };
const labTools = [...toolsForPolicy(policy), ...FLEET_TOOLS, ...LAB_TOOLS].filter(tool => FLEET_LAB_LEAD_TOOLS.includes(tool.name));
const prompt = buildAgentPrompt('execute', labTools, 'fleet_lab');
const compactTools: FunctionTool[] = [{ name: 'observe', description: 'Read a synthetic source.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }];
const bytes = (input: ModelMessage[], instructions = prompt.instructions, tools = labTools) => Buffer.byteLength(JSON.stringify({ instructions, input, tools }));
const decoded = (input: ModelMessage[]) => JSON.parse((input[0] as { content: string }).content);
const contextLimit = (error: unknown) => error instanceof LiveError && error.code === 'context_limit' && /No (?:model )?request was sent/.test(error.message);

function fixture() {
 return {
  ownerTask: { objective: 'Compare synthetic public journeys using browser evidence.', completionCriteria: 'Preserve exact evidence and disclose coverage.', instructions: 'Never broaden the target or budget.' },
  ownerReplies: [{ id: 'owner-reply-1', sequence: 1, content: 'Use fictional data only.' }],
  ownerReplyOrder: 'A larger sequence is newer.',
  policy,
  usage: { taskId: 'task-exact', calls: 4, maxCalls: 20, maxCostUsd: 1 },
  inputs: [{ versionId: 'handoff-exact', displayName: 'peer-report.md' }],
  requests: [{ id: 'request-exact', revision: 2, state: 'fulfilled' }],
  producedOutputs: [{ outputVersionId: 'own-output-exact', name: 'report.md' }],
  evidence: [{ evidenceId: 'receipt-current', tool: 'lab_observe' }],
  project: null,
  outputRequirements: { sections: ['Findings', 'Evidence', 'Impact', 'Remediation', 'Coverage'] },
  collaboration: { policies: [], board: [], inbox: [], publications: [], sharedArtifacts: [], dependencies: [], limits: { board: 50, inbox: 50, publications: 50, artifacts: 50 } },
  fleet: { mode: 'local_website', targetUrl: FLEET_LAB_URL, isLeader: true, revision: 2, items: [{ id: 'item-exact', roleKey: 'catalog', state: 'completed', publishedVersionId: 'handoff-exact' }], messages: [] as unknown[], revisions: [] as unknown[] },
  savedObservations: [] as unknown[],
 };
}
function message(source: ReturnType<typeof fixture>): ModelMessage { return { role: 'user', content: serializeAgentContext(source) }; }
function adapter() {
 const id = randomUUID();
 const profile: ModelProviderProfile = { id, revision: 1, selectionId: providerSelectionId(id, 1), createdAt: 1, label: 'Synthetic OpenAI fixture', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'fixture-pinned', authentication: 'api-key', billing: 'metered', inputUsdPerMillion: 1.25, outputUsdPerMillion: 5, maxInputTokens: 32768, maxOutputTokens: 512, toolCalling: true };
 let keyReads = 0, networkCalls = 0;
 const model: ModelAdapter = new ConfiguredModelAdapter({ profile, credentials: { async status() { return { configured: false, message: null }; }, async read() { keyReads++; throw Error('No key access in this test.'); } }, fetch: async () => { networkCalls++; throw Error('No model requests in this test.'); } });
 return { model, profile, activity: () => ({ keyReads, networkCalls }) };
}

test('input fitting leaves a complete request unchanged when no ceiling applies or its exact bytes fit', () => {
 const input: ModelMessage[] = [message(fixture()), { role: 'user', content: JSON.stringify({ ownerUpdates: [{ id: 'update-exact', sequence: 2, content: 'Keep this correction.' }] }) }];
 const before = structuredClone(input);
 assert.equal(fitModelInput(input, prompt.instructions, labTools), input);
 assert.equal(fitModelInput(input, prompt.instructions, labTools, bytes(input)), input);
 assert.deepEqual(input, before);
});

test('configured input fitting preserves recent browser handles, owner intent and separate corrections without widening reservations', async () => {
 const source = fixture();
 const recent = { tool: 'lab_observe', evidenceId: 'receipt-current', result: { tabId: 'tab-exact', revision: 17, url: FLEET_LAB_URL + 'catalog', text: 'Observed synthetic catalog; no verified flaw.', targets: [{ ref: 'control-exact', kind: 'button', label: 'Inspect synthetic item' }], fullPageVerified: false } };
 source.savedObservations = [{ tool: 'lab_observe', evidenceId: 'old-1', result: { text: 'Old snapshot '.repeat(1800) } }, { tool: 'lab_observe', evidenceId: 'old-2', result: { text: 'Older snapshot '.repeat(1700) } }, recent];
 const input: ModelMessage[] = [message(source), { role: 'user', content: JSON.stringify({ ownerUpdates: [{ id: 'correction-exact', sequence: 8, content: 'Stop after the public catalog. Do not change account settings.' }] }) }];
 const original = structuredClone(input), f = adapter();
 assert.equal(f.model.limits?.requestInputBytes, f.profile.maxInputTokens);
 assert.ok(bytes(input) > f.profile.maxInputTokens, 'Repeated page snapshots must reproduce the configured limit.');
 assert.throws(() => f.model.prepare({ instructions: prompt.instructions, input, tools: labTools, maxOutputTokens: 128 }), error => error instanceof ModelAdapterError && error.code === 'model_request_limit');
 const fitted = fitModelInput(input, prompt.instructions, labTools, f.model.limits?.requestInputBytes), context = decoded(fitted), prepared = f.model.prepare({ instructions: prompt.instructions, input: fitted, tools: labTools, maxOutputTokens: 128 });
 assert.ok(bytes(fitted) <= f.profile.maxInputTokens);
 assert.deepEqual(context.savedObservations, [recent]);
 assert.equal(context.contextWindow.partial, true);
 assert.equal(context.contextWindow.omitted.savedObservations, 2);
 assert.match(context.contextWindow.historyScope, /Missing history is not proof/);
 for (const key of ['ownerTask', 'ownerReplies', 'ownerReplyOrder', 'policy', 'usage', 'inputs', 'requests', 'producedOutputs', 'evidence', 'fleet', 'outputRequirements'] as const) assert.deepEqual(context[key], source[key]);
 assert.deepEqual(fitted[1], input[1]);
 assert.deepEqual(input, original);
 const quote = await f.model.quote(prepared, { signal: new AbortController().signal });
 assert.equal(quote.inputTokens, f.profile.maxInputTokens);
 assert.equal(quote.outputTokens, 128);
 assert.equal(quote.maxCostMicrousd, configuredCostMicrousd(f.profile, f.profile.maxInputTokens, 128));
 f.model.discard(prepared);
 assert.deepEqual(f.activity(), { keyReads: 0, networkCalls: 0 });
});

test('fitting uses escaped UTF-8 request bytes and can discard another old entry when a feasible request exists', () => {
 const source = fixture(), recent = { tool: 'lab_observe', result: { tabId: 'tab-current', revision: 5, targets: [{ ref: 'ref-current', kind: 'button', label: 'Current control' }], text: 'Fresh source 📂' } };
 source.savedObservations = [{ tool: 'lab_observe', result: { text: '\n"\\资料📂'.repeat(1200) } }, recent];
 const input = [message(source)], instructions = 'Keep exact current controls.', remaining = 24000;
 // A recent-only request demonstrably fits. Escaping the historical JSON adds
 // enough bytes that estimating only its inner content length is insufficient.
 const recentOnly = fixture(); recentOnly.savedObservations = [recent];
 assert.ok(bytes([message(recentOnly)], instructions, compactTools) < remaining);
 assert.ok(bytes(input, instructions, compactTools) > remaining);
 const fitted = fitModelInput(input, instructions, compactTools, remaining);
 assert.ok(bytes(fitted, instructions, compactTools) <= remaining);
 assert.deepEqual(decoded(fitted).savedObservations, [recent]);
 assert.equal(decoded(fitted).contextWindow.omitted.savedObservations, 1);
});

test('a second fit preserves omission disclosure from the previous context window', () => {
 const source = fixture();
 source.savedObservations = Array.from({ length: 8 }, (_, index) => ({ index, text: 'prior page '.repeat(1400) }));
 const first = message(source), firstContext = JSON.parse((first as { content: string }).content);
 assert.ok(firstContext.contextWindow.omitted.savedObservations > 0);
 const fitted = fitModelInput([first], 'Preserve owner intent.', compactTools, 10000), final = decoded(fitted);
 assert.equal(final.contextWindow.partial, true);
 assert.equal(final.contextWindow.omitted.savedObservations, source.savedObservations.length - final.savedObservations.length);
 assert.deepEqual(final.ownerTask, source.ownerTask);
 assert.deepEqual(final.evidence, source.evidence);
});

test('mandatory context and corrections that cannot fit fail closed instead of becoming excerpts', () => {
 const source = fixture(); source.ownerTask.instructions = 'Required owner scope 📂'.repeat(1800); source.savedObservations = [{ text: 'Optional prior page.' }];
 const input = [message(source)], original = structuredClone(input);
 assert.throws(() => fitModelInput(input, 'Preserve scope.', compactTools, 14000), contextLimit);
 assert.deepEqual(input, original);
 const correction: ModelMessage = { role: 'user', content: JSON.stringify({ ownerUpdates: [{ id: 'owner-exact', content: 'Required correction '.repeat(1400) }] }) };
 assert.throws(() => fitModelInput([message(fixture()), correction], 'Preserve corrections.', compactTools, 12000), contextLimit);
 assert.throws(() => fitModelInput([{ role: 'user', content: 'Mandatory input '.repeat(1400) }], 'Required instructions.', compactTools, 12000), contextLimit);
});

test('fitting preserves exact assistant/tool call binding and other required messages', () => {
 const source = fixture(); source.savedObservations = [{ text: 'Optional page '.repeat(2000) }];
 const input: ModelMessage[] = [message(source), { role: 'assistant', toolCall: { id: 'call-exact', name: 'observe', arguments: {} } }, { role: 'tool', callId: 'call-exact', content: 'Bounded result with an exact receipt.' }, { role: 'user', content: JSON.stringify({ ownerUpdates: [{ id: 'new-owner', content: 'Retain tool call identity.' }] }) }];
 const fitted = fitModelInput(input, 'Preserve all required messages.', compactTools, 12000);
 assert.deepEqual(fitted.slice(1), input.slice(1));
 assert.ok(bytes(fitted, 'Preserve all required messages.', compactTools) <= 12000);
 assert.deepEqual(decoded(fitted).savedObservations, []);
});

test('long fleet messages and revisions cannot displace the latest browser controls during either context fit', () => {
 const source = fixture(), current = { tool: 'lab_observe', evidenceId: 'receipt-current', result: { tabId: 'tab-current', revision: 77, url: FLEET_LAB_URL + 'catalog', text: 'Observed synthetic public catalog. '.repeat(45), targets: Array.from({ length: 5 }, (_, index) => ({ ref: 'control-' + index, kind: 'button', label: 'Current catalog action ' + index })), fullPageVerified: false } };
 source.savedObservations = [
  { tool: 'lab_open', evidenceId: 'older-open', result: { tabId: 'tab-current', revision: 71, text: 'Loading public page. '.repeat(200), targets: [{ ref: 'expired-loading-control', kind: 'link', label: 'Old link' }] } },
  { tool: 'lab_observe', evidenceId: 'older-view', result: { tabId: 'tab-current', revision: 73, text: 'Old public catalog. '.repeat(250), targets: [{ ref: 'expired-catalog-control', kind: 'button', label: 'Old control' }] } },
  current,
  { tool: 'read_file', evidenceId: 'newer-report-read', result: { text: 'An optional peer report excerpt. '.repeat(150) } },
 ];
 source.fleet.messages = Array.from({ length: 12 }, (_, index) => ({ id: 'peer-message-' + index, content: 'A prior hypothesis and proposed follow-up. '.repeat(22), createdAt: index }));
 source.fleet.revisions = Array.from({ length: 3 }, (_, index) => ({ revision: index + 1, summary: 'Earlier plan coverage. '.repeat(27), createdAt: index }));
 const original = structuredClone(source), serialized = serializeAgentContext(source, 9500), first = JSON.parse(serialized);
 assert.deepEqual(first.savedObservations, [current], 'Current page handles survive even when a later file receipt is optional.');
 assert.ok(first.contextWindow.omitted.fleetMessages > 0, 'The budget must force trimming peer context instead of page controls.');
 assert.equal(first.contextWindow.omitted.savedObservations, 3);
 assert.equal(first.contextWindow.omitted.fleetMessages, source.fleet.messages.length - first.fleet.messages.length);
 assert.deepEqual(first.fleet.items, source.fleet.items);
 assert.deepEqual(first.ownerTask, source.ownerTask);
 assert.deepEqual(first.evidence, source.evidence);
 assert.deepEqual(source, original);
 const input = [message(source)], fitted = fitModelInput(input, prompt.instructions, labTools, 32768), final = decoded(fitted);
 assert.ok(bytes(input) > 32768, 'The adapter fit must actually run.');
 assert.ok(bytes(fitted) <= 32768);
 assert.deepEqual(final.savedObservations, [current]);
 assert.ok(final.contextWindow.omitted.fleetMessages > 0);
 assert.equal(final.contextWindow.omitted.savedObservations, 3);
 assert.equal(final.contextWindow.omitted.fleetMessages, source.fleet.messages.length - final.fleet.messages.length);
 assert.equal(final.contextWindow.omitted.fleetRevisions, source.fleet.revisions.length - final.fleet.revisions.length);
 assert.deepEqual(final.fleet.items, source.fleet.items);
 assert.deepEqual(final.ownerTask, source.ownerTask);
 assert.deepEqual(final.evidence, source.evidence);
});

test('a current browser observation that cannot fit fails instead of silently dropping its exact handles', () => {
 const source = fixture(), current = { tool: 'browser_tab_observe', evidenceId: 'receipt-current', result: { tabId: 'tab-required', revision: 19, text: 'Current public source. '.repeat(1000), targets: [{ ref: 'required-current-ref', kind: 'button', label: 'Current action' }], fullPageVerified: false } };
 source.savedObservations = [{ tool: 'read_file', result: { text: 'Optional older receipt.' } }, current];
 source.fleet.messages = [{ content: 'Optional peer speculation. '.repeat(500) }];
 source.fleet.revisions = [{ revision: 1, summary: 'Optional prior plan. '.repeat(150) }];
 const original = structuredClone(source);
 assert.throws(() => serializeAgentContext(source, 5000), contextLimit);
 const input: ModelMessage[] = [{ role: 'user', content: JSON.stringify(source) }], before = structuredClone(input);
 assert.throws(() => fitModelInput(input, 'Preserve current browser handles.', compactTools, 5000), contextLimit);
 assert.deepEqual(source, original);
 assert.deepEqual(input, before);
});
