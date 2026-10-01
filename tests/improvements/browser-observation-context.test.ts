import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import type { BrowserHandle, BrowserRuntime } from '../../packages/browser/runtime';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { DEFAULT_MODEL, maxCostMicrousd, usageCostMicrousd, type ModelAdapter, type ModelRequest, type PreparedTurn } from '../../packages/model-adapters';

// Exercise the real browser service -> live receipt -> next model context path,
// without a browser process, credentials or a model API request.
async function observedContext(observation: Record<string, unknown>, attemptReport = false) {
 const root = await mkdtemp(join(tmpdir(), 'aw-observation-context-'));
 const requests: ModelRequest[] = [];
 const adapter: ModelAdapter = {
  async status() { return { configured: true, message: null, provider: 'openai', model: DEFAULT_MODEL }; },
  prepare(request) {
   requests.push(structuredClone(request)); const text = JSON.stringify(request);
   return { id: randomUUID(), model: DEFAULT_MODEL, requestHash: createHash('sha256').update(text).digest('hex'), requestBytes: Buffer.byteLength(text), maxOutputTokens: request.maxOutputTokens };
  },
  async quote(prepared: PreparedTurn) { return { inputTokens: 100, outputTokens: prepared.maxOutputTokens, maxCostMicrousd: maxCostMicrousd(DEFAULT_MODEL, 100, prepared.maxOutputTokens) }; },
  async complete() {
   const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0 };
   let name = 'user_request', args: Record<string, unknown> = { requestJson: JSON.stringify({ kind: 'clarification', title: 'Choose source', reason: 'A broader source is required.', continuation: 'await-source' }) };
   if (requests.length === 1) { name = 'browser_observe'; args = {}; }
   else if (attemptReport) {
    const context = JSON.parse((requests.at(-1)!.input[0] as { content: string }).content);
    if (requests.length === 2) { name = 'save_report'; args = { name: 'coverage.md', content: 'This report covers only the returned main-document text; complete-page coverage is unverified.', evidenceIds: [context.evidence.find((item: { tool: string }) => item.tool === 'browser_observe').evidenceId] }; }
    if (requests.length === 3) { name = 'finish'; args = { outputVersionId: context.producedOutputs[0]?.outputVersionId ?? 'missing-output', summary: 'Report of the bounded observation, with incomplete page coverage disclosed.' }; }
   }
   return { responseId: randomUUID(), text: '', toolCalls: [{ id: randomUUID(), name, arguments: args }], usage, costMicrousd: usageCostMicrousd(DEFAULT_MODEL, usage) };
  },
  discard() {},
 };
 const runtime: BrowserRuntime = {
  async status() { return { ready: true, message: null }; }, async reconcile() {}, async close() {},
  async launch({ initialGeneration }): Promise<BrowserHandle> {
   let revision = 1;
   return {
    async request(method) {
     const tab = { id: 'tab-1', url: String(observation.url ?? 'https://example.com/'), title: 'Fixture', revision: ++revision };
     return { generation: initialGeneration, controller: 'agent', result: method === 'download.list' ? [] : { tabs: [tab], selectedTabId: tab.id, tab: tab.id, url: tab.url, title: tab.title, revision, targets: [], frame: null, ...observation } };
    },
    async stop() {}, async close() { return { saved: true }; },
   };
  },
 };
 const coordinator = new Coordinator({ dataRoot: join(root, 'app'), modelAdapter: adapter, browserRuntime: runtime });
 try {
  await coordinator.live.ready; coordinator.handle({ type: 'settings.update', settings: { driverEnabled: false } });
  const agent = coordinator.handle({ type: 'agents.create', name: 'Coverage fixture', instructions: '' }).agents[0];
  await coordinator.live.handle({ type: 'live.createTask', agentId: agent.id, objective: 'Read the approved source.', completionCriteria: 'Report the verified observation coverage.', model: DEFAULT_MODEL, policy: { mode: 'read_only_browser', allowedOrigins: ['https://example.com'] }, limits: DEFAULT_LIVE_LIMITS });
  const task = coordinator.snapshot().tasks[0]; await coordinator.live.handle({ type: 'live.start', taskId: task.id });
  for (let i = 0; i < 500; i++) {
   const live = await coordinator.live.state(), current = coordinator.snapshot().tasks.find(t => t.id === task.id)!;
   if (!live.busy && !['queued', 'running', 'pausing', 'recovering'].includes(current.state)) break;
   await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(requests.length >= 2, 'The observation must reach a second model turn.');
  const context = JSON.parse((requests[1].input[0] as { content: string }).content);
  if (attemptReport) {
   const db = new DatabaseSync(coordinator.databasePath);
   try { return { result: context.savedObservations.find((item: { tool: string }) => item.tool === 'browser_observe').result, taskState: coordinator.snapshot().tasks.find(t => t.id === task.id)?.state, modelTurns: requests.length, receipts: db.prepare('SELECT tool_name,state,result_json FROM live_tool_receipts WHERE task_id=? ORDER BY rowid').all(task.id), outputCount: db.prepare("SELECT COUNT(*) AS count FROM task_artifacts WHERE task_id=? AND role='output'").get(task.id)!.count }; }
   finally { db.close(); }
  }
  assert.equal(requests.length, 2); assert.equal(coordinator.snapshot().tasks.find(t => t.id === task.id)?.state, 'waiting');
  return context.savedObservations.find((item: { tool: string }) => item.tool === 'browser_observe').result;
 } finally { await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); }
}

test('a short browser snapshot remains bounded evidence, not a claim of full-page coverage', async () => {
 const result = await observedContext({ text: 'Visible source.' });
 assert.equal(result.text, 'Visible source.'); assert.equal(result.returnedTextChars, 15);
 assert.equal(result.textTruncated, null); assert.equal(result.textLimitReached, false);
 assert.equal(result.fullPageVerified, false); assert.equal(result.textLimitChars, 16000);
 assert.match(result.coverage, /frames and unloaded content may be absent/i);
});

test('an upstream 16k snapshot reports the reached limit without inventing omitted length', async () => {
 const result = await observedContext({ text: 'x'.repeat(16000) });
 assert.equal(result.text.length, 16000); assert.equal(result.returnedTextChars, 16000);
 assert.equal(result.textLimitReached, true); assert.equal(result.textTruncated, null);
 assert.equal(result.fullPageVerified, false); assert.equal(result.totalTextChars, undefined);
 assert.match(result.coverage, /not pagination through omitted text/);
});

test('local clipping is explicitly marked before the observation reaches the model', async () => {
 const result = await observedContext({ text: 'x'.repeat(16000) + 'OMITTED-TAIL' });
 assert.equal(result.text.length, 16000); assert.equal(result.text.includes('OMITTED-TAIL'), false);
 assert.equal(result.textTruncated, true); assert.equal(result.textLimitReached, true);
 assert.equal(result.fullPageVerified, false);
});

test('an explicit upstream truncation flag is preserved even when returned text is short', async () => {
 const result = await observedContext({ text: 'Partial excerpt', textTruncated: true });
 assert.equal(result.textTruncated, true); assert.equal(result.textLimitReached, false);
 assert.equal(result.fullPageVerified, false);
});

test('an off-origin login redirect does not expose query tokens or page content', async () => {
 const result = await observedContext({ url: 'https://accounts.example.net/login?token=PRIVATE-CANARY', text: 'PRIVATE-CANARY', title: 'PRIVATE-CANARY', targets: [{ ref: 'private-ref', kind: 'button', label: 'PRIVATE-CANARY' }] });
 assert.equal(result.loginOrRedirect, true); assert.equal(result.url, 'https://accounts.example.net');
 assert.equal(result.text, undefined); assert.equal(result.title, undefined); assert.equal(result.targets, undefined);
 assert.equal(JSON.stringify(result).includes('PRIVATE-CANARY'), false);
});

for (const flag of ['humanLoginRequired', 'nativeHumanControl']) test(`${flag} gives the model only redacted handoff context`, async () => {
 const result = await observedContext({ url: 'https://example.com/login?token=PRIVATE-CANARY', text: 'PRIVATE-CANARY', title: 'PRIVATE-CANARY', [flag]: true });
 assert.equal(result.loginOrRedirect, true); assert.equal(result[flag], true); assert.equal(result.url, 'https://example.com');
 assert.equal(result.text, undefined); assert.equal(result.title, undefined); assert.equal(result.targets, undefined);
 assert.equal(JSON.stringify(result).includes('PRIVATE-CANARY'), false);
});

test('a redacted login receipt cannot ground a report or finish the task', async () => {
 const result = await observedContext({ url: 'https://accounts.example.net/login', text: 'Login required' }, true);
 assert.equal(result.result.loginOrRedirect, true); assert.equal(result.outputCount, 0);
 assert.equal(result.taskState, 'waiting'); assert.equal(result.modelTurns, 4);
 assert.deepEqual(result.receipts.map((receipt: { tool_name: string; state: string }) => [receipt.tool_name, receipt.state]), [['browser_observe', 'succeeded'], ['save_report', 'failed'], ['finish', 'failed'], ['user_request', 'succeeded']]);
 assert.equal(JSON.parse(result.receipts[1].result_json).code, 'missing_evidence');
});

test('bounded source text remains eligible evidence for a report that discloses its limits', async () => {
 const result = await observedContext({ text: 'A partial but relevant source excerpt.', textTruncated: true }, true);
 assert.equal(result.result.fullPageVerified, false); assert.equal(result.result.textTruncated, true);
 assert.equal(result.outputCount, 1); assert.equal(result.taskState, 'succeeded'); assert.equal(result.modelTurns, 3);
 assert.deepEqual(result.receipts.map((receipt: { tool_name: string; state: string }) => [receipt.tool_name, receipt.state]), [['browser_observe', 'succeeded'], ['save_report', 'succeeded'], ['finish', 'succeeded']]);
});
