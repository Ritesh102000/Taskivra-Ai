import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Coordinator, type RunClaim } from '../../packages/coordinator';
import { Persistence } from '../../packages/persistence';
import { BrowserActionService } from '../../packages/browser-actions';
import type { BrowserActionProposal } from '../../packages/contracts/browser-actions';
import type { BrowserState } from '../../packages/contracts/browser';
import type { LivePolicy } from '../../packages/contracts/live';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { DEFAULT_MODEL } from '../../packages/model-adapters/pricing';

async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'aw-reviewed-browser-')), dataRoot = join(root, 'data'); let now = Date.now();
 const c = new Coordinator({ dataRoot, now: () => now }); await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
 const agent = c.handle({ type: 'agents.create', name: 'Browser review fixture', instructions: '' }).agents[0];
 const policy: LivePolicy = { mode: 'workspace', allowedOrigins: ['https://example.com'], browserInteraction: 'reviewed_actions' };
 const taskId = c.createLiveTask({ type: 'live.createTask', agentId: agent.id, objective: 'Prepare the reviewed record.', completionCriteria: 'Check the record on the website and report actual evidence.', model: DEFAULT_MODEL, limits: DEFAULT_LIVE_LIMITS, policy });
 const p = new Persistence(dataRoot, now), decisions: string[] = [], calls: { method: string; params: Record<string, unknown> }[] = [];
 const session = p.db.prepare('SELECT id FROM browser_sessions WHERE agent_id=?').get(agent.id)!;
 const state: BrowserState = { agentId: agent.id, taskId, sessionId: String(session.id), lifecycle: 'ready', controller: 'agent', generation: 4, revision: 2, activeTabId: 'tab1', tabs: [{ id: 'tab1', title: 'Record', url: 'https://example.com/record/1', revision: 9 }], frame: null, targets: [{ ref: 'field1', kind: 'input', label: 'Record title' }, { ref: 'button1', kind: 'button', label: 'Save record' }, { ref: 'select1', kind: 'select', label: 'Status' }], downloads: [], error: null, requestId: null, profile: { mode: 'remember', saved: true, savedAt: now }, runtime: { ready: true, message: null, backend: 'desktop_chrome' } };
 let outcome: 'ok' | 'unknown' | 'stale' = 'ok', gate: (() => Promise<void>) | null = null;
 const browser = {
  async handle() { return structuredClone(state); },
  async agentAction(_claim: RunClaim, _session: string, _generation: number, method: string, params: Record<string, unknown>, beforeDispatch?: () => void) {
   if (gate) await gate(); beforeDispatch?.(); calls.push({ method, params });
   if (outcome === 'unknown') throw new Error('transport_lost');
   if (outcome === 'stale') throw Object.assign(new Error('The runtime refused a stale DOM reference.'), { code: 'stale_observation' });
   return { tabs: structuredClone(state.tabs), selectedTabId: 'tab1', targets: structuredClone(state.targets), text: 'The command returned. Actual business outcome still needs checking.' };
  },
 };
 const service = () => new BrowserActionService({ persistence: p, browser, authorize: claim => c.authorizeRun(claim), now: () => now, onDecision: id => decisions.push(id) });
 const s = service();
 const claim = () => { p.db.prepare("UPDATE tasks SET state='queued' WHERE id=?").run(taskId); p.db.prepare('UPDATE live_task_config SET enabled=1 WHERE task_id=?').run(taskId); const r = c.claimNext(undefined, 'live'); p.db.prepare('UPDATE live_task_config SET enabled=0 WHERE task_id=?').run(taskId); assert.ok(r); return r; };
 const run = claim();
 const request = (kind: 'fill' | 'click' | 'select' = 'fill', value = '  Approved title  ') => ({ action: { kind, ref: kind === 'fill' ? 'field1' : kind === 'click' ? 'button1' : 'select1', revision: 9, ...(kind === 'click' ? {} : { value }) }, reason: 'Use the owner-requested record title.', expectedEffect: 'The page may save the record immediately.', idempotencyKey: randomUUID() });
 const approve = (a: BrowserActionProposal, target = s) => target.handle({ type: 'browserActions.decide', actionId: a.id, revision: a.revision, decision: 'approve', accountConfirmation: 'Owner-confirmed business workspace' });
 return { c, p, s, state, taskId, agent, policy, run, calls, decisions, service, claim, request, approve,
  advance(ms: number) { now += ms; }, unknown() { outcome = 'unknown'; }, stale() { outcome = 'stale'; }, gate(value: (() => Promise<void>) | null) { gate = value; },
  wait(run: RunClaim) { p.db.prepare("UPDATE tasks SET state='waiting' WHERE id=?").run(taskId); p.db.prepare("UPDATE runs SET state='waiting' WHERE id=?").run(run.runId); },
  async close() { await s.drain(); p.close(); await c.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('read-only and ordinary workspace tasks cannot request website effects', async () => {
 const f = await fixture(); try {
  for (const policy of [{ mode: 'read_only_browser', allowedOrigins: ['https://example.com'], browserInteraction: 'reviewed_actions' }, { mode: 'workspace', allowedOrigins: ['https://example.com'] }, { ...f.policy, mailAccount: 'owner@gmail.com' }]) {
   f.p.db.prepare('UPDATE live_task_config SET policy_json=? WHERE task_id=?').run(JSON.stringify(policy), f.taskId);
   await assert.rejects(f.s.request(f.run, f.request()), /Read-only tasks cannot change/);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.s.state().actions.length, 0);
 } finally { await f.close(); }
});

test('one owner approval binds exact bytes and survives wait/resume under a new run only once', async () => {
 const f = await fixture(); try {
  const request = f.request(), action = await f.s.request(f.run, request, { onPending: () => f.wait(f.run) });
  assert.equal(action.state, 'pending'); assert.ok(f.s.blockingReason(f.taskId)); assert.equal(f.calls.length, 0);
  await f.approve(action); const next = f.claim(); assert.notEqual(next.runId, f.run.runId);
  const freshService = f.service(), applied = await freshService.apply(next, action.id);
  assert.equal(applied.action.state, 'completed'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'page.fill'); assert.equal(f.calls[0].params.value, '  Approved title  ');
  assert.equal((await freshService.apply(next, action.id)).replayed, true); assert.equal(f.calls.length, 1);
  assert.equal(freshService.context(f.taskId)[0].accountConfirmation, 'Owner-confirmed business workspace');
 } finally { await f.close(); }
});

test('request retries are idempotent and stale owner decisions or changed payloads cannot broaden approval', async () => {
 const f = await fixture(); try {
  const raw = f.request(), a = await f.s.request(f.run, raw); assert.equal((await f.s.request(f.run, raw)).id, a.id);
  await assert.rejects(f.s.request(f.run, { ...raw, action: { ...raw.action, value: 'Changed value' } }), /different details/);
  await f.approve(a); await assert.rejects(f.approve(a), /changed/);
  await assert.rejects(f.s.request(f.run, f.request()), /approved action/);
  assert.equal(f.s.state().actions.length, 1); assert.equal(f.calls.length, 0);
 } finally { await f.close(); }
});

test('two concurrent attempts consume a single approval at most once', async () => {
 const f = await fixture(); try {
  const a = await f.s.request(f.run, f.request('select', 'ready')); await f.approve(a);
  const outcomes = await Promise.allSettled([f.s.apply(f.run, a.id), f.s.apply(f.run, a.id)]);
  assert.ok(outcomes.some(r => r.status === 'fulfilled')); assert.equal(f.calls.length, 1); assert.equal(f.s.state().actions[0].state, 'completed');
 } finally { await f.close(); }
});

test('page URL, revision, controller generation, target and owner corrections invalidate an approved action', async () => {
 for (const change of ['url', 'revision', 'generation', 'target', 'owner', 'policy', 'project'] as const) {
  const f = await fixture(); try {
   const a = await f.s.request(f.run, f.request('click')); await f.approve(a);
   if (change === 'url') f.state.tabs[0].url = 'https://example.com/record/2';
   if (change === 'revision') f.state.tabs[0].revision++;
   if (change === 'generation') f.state.generation++;
   if (change === 'target') f.state.targets[1].label = 'Delete record';
   if (change === 'owner') f.p.db.prepare("INSERT INTO task_messages(id,task_id,role,content,created_at) VALUES (?,?,'owner','Stop, use a different record.',?)").run(randomUUID(), f.taskId, Date.now());
   if (change === 'project') f.c.projects.handle({type:'projects.brief.save',projectId:f.c.projects.agent(f.agent.id),expectedRevision:0,content:'Do not change the record.',knowledgeVersionIds:[]});
   if (change === 'policy') f.p.db.prepare('UPDATE live_task_config SET policy_json=? WHERE task_id=?').run(JSON.stringify({ ...f.policy, browserInteraction: undefined }), f.taskId);
   await assert.rejects(f.s.apply(f.run, a.id)); assert.equal(f.calls.length, 0); assert.equal(f.s.state().actions[0].state, 'stale');
  } finally { await f.close(); }
 }
});

test('new owner instruction while queued is checked at the authoritative dispatch boundary', async () => {
 const f = await fixture(); try {
  const a = await f.s.request(f.run, f.request()); await f.approve(a);
  f.gate(async () => { f.p.db.prepare("INSERT INTO task_messages(id,task_id,role,content,created_at) VALUES (?,?,'owner','Do not send this value.',?)").run(randomUUID(), f.taskId, Date.now()); });
  await assert.rejects(f.s.apply(f.run, a.id), /instructions changed/); assert.equal(f.calls.length, 0);
 } finally { await f.close(); }
});

test('uncertain effects are durable, block new proposals, and never replay even after an owner check', async () => {
 const f = await fixture(); try {
  const a = await f.s.request(f.run, f.request('click')); await f.approve(a); f.unknown();
  const applied = await f.s.apply(f.run, a.id); assert.equal(applied.action.state, 'outcome_unknown'); assert.ok(f.s.blockingReason(f.taskId));
  const again = f.service(); assert.equal((await again.apply(f.run, a.id)).replayed, true); assert.equal(f.calls.length, 1);
  await assert.rejects(again.request(f.run, f.request()), /pending browser action/);
  await again.handle({ type: 'browserActions.resolveUnknown', actionId: a.id, revision: applied.action.revision, outcome: 'checked_done', note: 'Owner checked the website and found record 123 saved.' });
  assert.equal(again.blockingReason(f.taskId), null); assert.equal((await again.apply(f.run, a.id)).replayed, true); assert.equal(f.calls.length, 1);
  assert.equal(again.context(f.taskId)[0].resolution?.outcome, 'checked_done');
 } finally { await f.close(); }
});

test('interrupted dispatch recovers as unknown without sending anything and expiry wakes the decision hook', async () => {
 const f = await fixture(); try {
  const a = await f.s.request(f.run, f.request()); await f.approve(a);
  f.p.db.prepare("UPDATE browser_action_proposals SET state='dispatching',dispatch_run_id=? WHERE id=?").run(f.run.runId, a.id);
  f.wait(f.run); const recovered = f.service(); recovered.reconcile();
  assert.equal(recovered.context(f.taskId)[0].state, 'outcome_unknown'); assert.ok(recovered.blockingReason(f.taskId)); assert.equal(f.calls.length, 0);
 } finally { await f.close(); }
 const f2 = await fixture(); try {
  const a = await f2.s.request(f2.run, f2.request()); f2.advance(600_001); f2.s.reconcile();
  assert.equal(f2.s.context(f2.taskId)[0].state, 'stale'); assert.equal(f2.s.blockingReason(f2.taskId), null); assert.deepEqual(f2.decisions, [f2.taskId]);
  await assert.rejects(f2.approve(a)); assert.equal(f2.calls.length, 0);
 } finally { await f2.close(); }
});

test('a runtime stale-DOM refusal is recorded as no action, without an uncertain-effect blocker or replay', async () => {
 const f = await fixture(); try {
  const a = await f.s.request(f.run, f.request('click')); await f.approve(a); f.stale();
  await assert.rejects(f.s.apply(f.run, a.id), /stale DOM/); assert.equal(f.s.state().actions[0].state, 'stale'); assert.equal(f.s.blockingReason(f.taskId), null);
  await assert.rejects(f.s.apply(f.run, a.id), /approve/); assert.equal(f.calls.length, 1);
 } finally { await f.close(); }
});

test('unsafe targets, private profiles, unauthorized sites and arbitrary methods never create an approval', async () => {
 const f = await fixture(); try {
  await assert.rejects(f.s.request(f.run, { ...f.request(), action: { kind: 'key', ref: 'field1', revision: 9, value: 'Enter' } }));
  await assert.rejects(f.s.request(f.run, { ...f.request(), action: { kind: 'fill', ref: 'field1', revision: 9, value: 'value', selector: '#field' } }));
  f.state.targets[0].label = 'One time password'; await assert.rejects(f.s.request(f.run, f.request()), /human browser control/); f.state.targets[0].label = 'Record title';
  f.state.agentId = 'personal-profile'; await assert.rejects(f.s.request(f.run, f.request())); f.state.agentId = f.agent.id;
  f.state.tabs[0].url = 'https://foreign.example/account'; await assert.rejects(f.s.request(f.run, f.request()));
  f.state.tabs[0].url = 'https://example.com/login'; await assert.rejects(f.s.request(f.run, f.request()));
  assert.equal(f.calls.length, 0); assert.equal(f.s.state().actions.length, 0);
 } finally { await f.close(); }
});

test('proposal and pending checkpoint are one transaction, and a rejected approval never dispatches', async () => {
 const f = await fixture(); try {
  await assert.rejects(f.s.request(f.run, f.request(), { onPending: () => { throw new Error('injected_checkpoint_failure'); } }), /injected/);
  assert.equal(f.s.state().actions.length, 0);
  const a = await f.s.request(f.run, f.request('select', 'ready'));
  await f.s.handle({ type: 'browserActions.decide', actionId: a.id, revision: a.revision, decision: 'decline', accountConfirmation: '' });
  await assert.rejects(f.s.apply(f.run, a.id), /approve/); assert.equal(f.calls.length, 0);
 } finally { await f.close(); }
});
