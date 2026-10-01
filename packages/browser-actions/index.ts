import { createHash, randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { Persistence } from '../persistence';
import type { BrowserService } from '../browser';
import type { BrowserState } from '../contracts/browser';
import type { RunClaim } from '../coordinator';
import type { BrowserActionProposal, BrowserActionSpec, BrowserActionsState } from '../contracts/browser-actions';
import { identity, number, record, string } from '../contracts/live-validation';

type Row = Record<string, string | number | null>;
const EXPIRES_MS = 10 * 60_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
export class BrowserActionError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'BrowserActionError'; } }
function fail(code: string, message: string): never { throw new BrowserActionError(code, message); }
function exactText(raw: unknown, max: number): string {
 if (typeof raw !== 'string' || Buffer.byteLength(raw) > max || raw.includes('\0')) return fail('invalid_command', 'The entered value is missing, too long, or contains unsupported characters.');
 return raw; // Spaces and empty values can be intentional; never silently trim form data.
}
function actionSpec(raw: unknown): BrowserActionSpec {
 const v = record(raw, ['kind', 'ref', 'revision', 'value']);
 const ref = identity(v.ref), revision = number(v.revision, 1, Number.MAX_SAFE_INTEGER);
 if (v.kind === 'click') { record(v, ['kind', 'ref', 'revision']); return { kind: 'click', ref, revision }; }
 if (v.kind === 'fill' || v.kind === 'select') return { kind: v.kind, ref, revision, value: exactText(v.value, 8192) };
 return fail('invalid_command', 'Only a reviewed click, field value, or selection is supported.');
}
function sensitiveURL(raw: string): boolean {
 try { const u = new URL(raw); return /^(accounts|login|signin)\./i.test(u.hostname) || /(?:^|\/)(?:login|signin|sign-in|oauth|authorize|auth)(?:\/|$)/i.test(u.pathname); } catch { return true; }
}

/** Exact one-action approvals. An approval never widens a task's site or profile authority. */
export class BrowserActionService {
 private ownerQueue: Promise<unknown> = Promise.resolve();
 private active = new Set<Promise<unknown>>();
 constructor(private options: {
  persistence: Persistence; browser: Pick<BrowserService, 'handle' | 'agentAction'>;
  authorize: (claim: RunClaim) => void; now?: () => number;
  onDecision?: (taskId: string) => void; onChanged?: () => void;
 }) {}
 private get db() { return this.options.persistence.db; }
 private now() { return (this.options.now || Date.now)(); }
 private row(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).get(...args) as Row | undefined; }
 private rows(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).all(...args) as Row[]; }
 private write(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
 private tx<T>(work: () => T): T { return this.options.persistence.transaction(work); }
 private changed() { this.options.onChanged?.(); }
 private event(type: string, r: Row) { this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)', type, r.id, r.revision, JSON.stringify({ taskId: r.task_id, actionId: r.id }), this.now()); }
 private required(id: string): Row { return this.row('SELECT * FROM browser_action_proposals WHERE id=?', id) || fail('not_found', 'This browser action is no longer available.'); }
 private view(r: Row): BrowserActionProposal { return {
  id: String(r.id), taskId: String(r.task_id), agentId: String(r.agent_id), revision: Number(r.revision), state: r.state as BrowserActionProposal['state'],
  sessionId: String(r.session_id), generation: Number(r.generation), tabId: String(r.tab_id), pageRevision: Number(r.page_revision), url: String(r.url),
  target: JSON.parse(String(r.target_json)), action: JSON.parse(String(r.action_json)), reason: String(r.reason), expectedEffect: String(r.expected_effect),
  accountConfirmation: r.account_confirmation === null ? null : String(r.account_confirmation), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), error: r.error === null ? null : String(r.error),
  resolution: r.resolution_json === null ? null : JSON.parse(String(r.resolution_json)),
 }; }
 private task(taskId: string): Row {
  return this.row('SELECT t.*,l.policy_json FROM tasks t JOIN live_task_config l ON l.task_id=t.id WHERE t.id=?', taskId) || fail('not_found', 'Choose an existing live task.');
 }
 private authority(taskId: string): string {
  const task = this.task(taskId), policy = JSON.parse(String(task.policy_json));
  if (terminal.has(String(task.state)) || policy.mode !== 'workspace' || policy.mailAccount || policy.browserInteraction !== 'reviewed_actions') fail('permission_denied', 'The owner must choose reviewed browser actions when creating this task. Read-only tasks cannot change websites.');
  const ownerMessages = this.row("SELECT max(rowid) AS latest FROM task_messages WHERE task_id=? AND role='owner'", taskId)?.latest ?? null;
  const project = this.row('SELECT p.project_id,COALESCE((SELECT MAX(revision) FROM project_briefs b WHERE b.project_id=p.project_id),0) AS brief_revision FROM project_agents p WHERE p.agent_id=?', task.agent_id);
  return hash({ objective: task.objective, criteria: task.completion_criteria, policy: task.policy_json, ownerMessages, project });
 }
 private policyURL(taskId: string, raw: string) {
  const policy = JSON.parse(String(this.task(taskId).policy_json)); let url: URL;
  try { url = new URL(raw); } catch { return fail('permission_denied', 'Observe an allowed HTTPS page before requesting an action.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !policy.allowedOrigins.includes(url.origin) || sensitiveURL(raw)) fail('permission_denied', 'This page is outside the approved websites or requires human login.');
 }
 private async current(agentId: string): Promise<BrowserState> { return this.options.browser.handle({ type: 'browser.state', agentId }); }
 private checkBrowser(r: Row, state: BrowserState) {
  const tab = state.tabs.find(t => t.id === r.tab_id), target = JSON.parse(String(r.target_json));
  if (state.agentId !== r.agent_id || state.taskId !== r.task_id || state.sessionId !== r.session_id || state.generation !== r.generation || state.lifecycle !== 'ready' || state.controller !== 'agent' || state.activeTabId !== r.tab_id || !tab || tab.url !== r.url || tab.revision !== r.page_revision || !state.targets.some(t => t.ref === target.ref && t.kind === target.kind && t.label === target.label)) fail('stale_action', 'The browser page or its control changed. Observe it again and request a new approval.');
  if (r.expires_at !== undefined && Number(r.expires_at) <= this.now()) fail('stale_action', 'This approval expired. Observe the page and request a new approval.');
  this.policyURL(String(r.task_id), tab.url);
  if (this.authority(String(r.task_id)) !== r.authority_hash) fail('stale_action', 'The owner instructions or task permissions changed. Request a new approval.');
 }
 private status(id: string, state: BrowserActionProposal['state'], error: string | null = null) { this.write('UPDATE browser_action_proposals SET state=?,error=?,revision=revision+1,updated_at=? WHERE id=?', state, error, this.now(), id); this.event('browser_action.' + state, this.required(id)); }
 reconcile() {
  const changedTasks = new Set<string>();
  this.tx(() => {
   for (const r of this.rows("SELECT a.* FROM browser_action_proposals a JOIN tasks t ON t.id=a.task_id WHERE a.state IN ('pending','approved') AND (a.expires_at<=? OR t.state IN ('succeeded','failed','cancelled'))", this.now())) { this.status(String(r.id), 'stale', 'This approval expired or the task closed. Observe the page and request a new approval.'); changedTasks.add(String(r.task_id)); }
   // Recovery can never establish whether a submitted action reached the website.
   for (const r of this.rows("SELECT a.* FROM browser_action_proposals a WHERE a.state='dispatching' AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=a.dispatch_run_id AND r.state='running' AND r.lease_until>?)", this.now())) this.status(String(r.id), 'outcome_unknown', 'The previous browser action may have reached the website. It will not be sent again. Check the website before continuing.');
  });
  for (const taskId of changedTasks) this.options.onDecision?.(taskId);
 }
 state(taskId: string | null = null): BrowserActionsState {
  this.reconcile();
  const attention = "(state='pending' OR (state='outcome_unknown' AND resolution_json IS NULL))";
  return { actions: this.rows('SELECT * FROM browser_action_proposals' + (taskId ? ' WHERE task_id=?' : '') + ' ORDER BY ' + attention + ' DESC,created_at DESC,id LIMIT 100', ...(taskId ? [taskId] : [])).map(r => this.view(r)), attentionCount: Number(this.row('SELECT COUNT(*) AS n FROM browser_action_proposals WHERE '+attention+(taskId?' AND task_id=?':''),...(taskId?[taskId]:[]))?.n||0) };
 }
 context(taskId: string) { return this.state(taskId).actions.slice(0, 8).map(a => ({
  id: a.id, state: a.state, revision: a.revision, url: a.url.slice(0, 1024), urlTruncated: a.url.length > 1024,
  target: a.target, action: { kind: a.action.kind, ref: a.action.ref, revision: a.action.revision, ...('value' in a.action ? { valuePreview: a.action.value.slice(0, 256), valueTruncated: a.action.value.length > 256 } : {}) },
  expectedEffect: a.expectedEffect.slice(0, 240), expectedEffectTruncated: a.expectedEffect.length > 240,
  accountConfirmation: a.accountConfirmation, error: a.error, expiresAt: a.expiresAt,
  resolution: a.resolution ? { ...a.resolution, note: a.resolution.note.slice(0, 400), noteTruncated: a.resolution.note.length > 400 } : null,
 })); }
 blockingReason(taskId: string): string | null {
  const r = this.row("SELECT state FROM browser_action_proposals WHERE task_id=? AND (state IN ('pending','dispatching') OR (state='outcome_unknown' AND resolution_json IS NULL)) ORDER BY created_at LIMIT 1", taskId);
  return r ? r.state === 'outcome_unknown' ? 'Check the website and resolve the uncertain browser action before continuing.' : 'Waiting for review of an exact browser action.' : null;
 }
 request(claim: RunClaim, raw: unknown, hooks: { beforeDispatch?: () => void; onPending?: (proposal: BrowserActionProposal) => void } = {}): Promise<BrowserActionProposal> {
  return this.track(this.propose(claim, raw, hooks));
 }
 private async propose(claim: RunClaim, raw: unknown, hooks: { beforeDispatch?: () => void; onPending?: (proposal: BrowserActionProposal) => void }) {
  this.options.authorize(claim); hooks.beforeDispatch?.(); const v = record(raw, ['action', 'reason', 'expectedEffect', 'idempotencyKey']);
  const action = actionSpec(v.action), reason = string(v.reason, 1200), expectedEffect = string(v.expectedEffect, 1200), key = identity(v.idempotencyKey), requestHash = hash({ action, reason, expectedEffect });
  const authority = this.authority(claim.taskId), state = await this.current(claim.agentId); this.reconcile();
  return this.tx(() => {
   this.options.authorize(claim); hooks.beforeDispatch?.();
   const previous = this.row('SELECT * FROM browser_action_proposals WHERE task_id=? AND request_key=?', claim.taskId, key);
   if (previous) { if (previous.request_hash !== requestHash) fail('conflict', 'This action request key was already used for different details.'); return this.view(previous); }
   if (this.blockingReason(claim.taskId)) fail('browser_action_pending', 'Finish the pending browser action review before requesting another.');
   if (this.row("SELECT 1 FROM browser_action_proposals WHERE task_id=? AND state='approved'", claim.taskId)) fail('browser_action_pending', 'Apply or refresh the approved action before requesting another.');
   if (Number(this.row('SELECT count(*) AS n FROM browser_action_proposals WHERE task_id=?', claim.taskId)!.n) >= 200) fail('action_limit', 'This task reached its browser action review limit.');
   const tab = state.tabs.find(t => t.id === state.activeTabId), target = state.targets.find(t => t.ref === action.ref);
   if (!tab || !target || tab.revision !== action.revision) fail('stale_action', 'Choose a target from the most recent page observation.');
   if (action.kind === 'fill' && target.kind !== 'input' || action.kind === 'select' && target.kind !== 'select' || action.kind === 'click' && !['button', 'link', 'input'].includes(target.kind)) fail('invalid_target', 'That page element cannot perform this action.');
   if (/password|one[ -]?time|api[ -]?key|secret|security[ -]?code|card[ -]?number/i.test(target.label) || (target as { password?: boolean }).password) fail('human_login_required', 'Enter credentials and sensitive authentication details through human browser control.');
   const id = randomUUID();
   const r: Row = { id, task_id: claim.taskId, agent_id: claim.agentId, session_id: state.sessionId, generation: state.generation, tab_id: tab.id, page_revision: tab.revision, url: tab.url, target_json: JSON.stringify(target), authority_hash: authority };
   this.checkBrowser(r, state);
   this.write("INSERT INTO browser_action_proposals(id,task_id,agent_id,session_id,generation,tab_id,page_revision,url,target_json,action_json,reason,expected_effect,authority_hash,request_key,request_hash,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)", id, claim.taskId, claim.agentId, state.sessionId, state.generation, tab.id, tab.revision, tab.url, JSON.stringify(target), JSON.stringify(action), reason, expectedEffect, authority, key, requestHash, this.now(), this.now() + EXPIRES_MS, this.now());
   this.event('browser_action.requested', this.required(id)); const result = this.view(this.required(id)); hooks.onPending?.(result); this.changed(); return result;
  });
 }
 apply(claim: RunClaim, actionId: string, beforeDispatch?: () => void): Promise<{ action: BrowserActionProposal; observation?: unknown; replayed: boolean }> {
  return this.track(this.dispatch(claim, identity(actionId), beforeDispatch));
 }
 private async dispatch(claim: RunClaim, id: string, beforeDispatch?: () => void) {
  this.options.authorize(claim); beforeDispatch?.(); this.reconcile(); let r = this.required(id);
  if (r.task_id !== claim.taskId || r.agent_id !== claim.agentId) fail('permission_denied', 'This action belongs to another task or agent.');
  if (r.state === 'completed' || r.state === 'outcome_unknown') return { action: this.view(r), replayed: true };
  if (r.state !== 'approved') fail('approval_required', 'The owner must approve this exact action before it can run.');
  const state = await this.current(claim.agentId); this.options.authorize(claim); beforeDispatch?.();
  try { this.checkBrowser(r, state); } catch (error) { this.tx(() => { if (this.required(id).state === 'approved') this.status(id, 'stale', 'The page, control, or owner instructions changed. Request a fresh approval.'); }); this.changed(); throw error; }
  const action = JSON.parse(String(r.action_json)) as BrowserActionSpec;
  const params = { tab: r.tab_id, revision: r.page_revision, ref: action.ref, ...('value' in action ? { value: action.value } : {}) };
  let dispatched = false;
  try {
   const observation = await this.options.browser.agentAction(claim, String(r.session_id), Number(r.generation), 'page.' + action.kind, params, () => {
    this.options.authorize(claim); beforeDispatch?.();
    this.tx(() => {
     r = this.required(id);
     if (r.state !== 'approved' || Number(r.expires_at) <= this.now()) fail('approval_required', 'This action approval was consumed or expired.');
     if (this.authority(claim.taskId) !== r.authority_hash) fail('stale_action', 'Owner instructions changed before dispatch. Request a fresh approval.');
     this.write('UPDATE browser_action_proposals SET dispatch_run_id=? WHERE id=?', claim.runId, id); this.status(id, 'dispatching'); dispatched = true;
    });
   });
   this.tx(() => { if (this.required(id).state === 'dispatching') this.status(id, 'completed'); }); this.changed();
   return { action: this.view(this.required(id)), observation, replayed: false };
  } catch (error) {
   const refusedBeforeEffect = ['stale_observation', 'fresh_observation_required'].includes(String((error as { code?: unknown })?.code));
   this.tx(() => {
    const current = this.required(id);
    if (dispatched && current.state === 'dispatching') this.status(id, refusedBeforeEffect ? 'stale' : 'outcome_unknown', refusedBeforeEffect ? 'The browser refused this action before changing the page. Observe it again and request a fresh approval.' : 'This action may have reached the website. It was not retried. Check the website and record its outcome.');
    else if (current.state === 'approved') this.status(id, 'stale', 'The browser or its authorization changed before dispatch. Request a fresh approval.');
   }); this.changed();
   if (dispatched && !refusedBeforeEffect) return { action: this.view(this.required(id)), replayed: false };
   throw error;
  }
 }
 handle(raw: unknown): Promise<BrowserActionsState> {
  const work = this.ownerQueue.then(() => this.ownerCommand(raw)); this.ownerQueue = work.catch(() => undefined); return work;
 }
 private async ownerCommand(raw: unknown): Promise<BrowserActionsState> {
  const v = record(raw, ['type', 'taskId', 'actionId', 'revision', 'decision', 'accountConfirmation', 'outcome', 'note']);
  if (v.type === 'browserActions.list') { record(v, ['type', 'taskId']); return this.state(v.taskId === null ? null : identity(v.taskId)); }
  const id = identity(v.actionId), revision = number(v.revision, 1, Number.MAX_SAFE_INTEGER); this.reconcile(); const old = this.required(id);
  if (v.type === 'browserActions.decide') {
   record(v, ['type', 'actionId', 'revision', 'decision', 'accountConfirmation']);
   if (!['approve', 'decline'].includes(String(v.decision))) fail('invalid_command', 'Choose approve or decline.');
   const account = v.decision === 'approve' ? string(v.accountConfirmation, 254) : exactText(v.accountConfirmation, 254);
   const state = v.decision === 'approve' ? await this.current(String(old.agent_id)) : null;
   if (state) try { this.checkBrowser(old, state); } catch (error) {
    this.tx(() => { const r = this.required(id); if (r.revision === revision && r.state === 'pending') this.status(id, 'stale', 'The page, control, or owner instructions changed. Request a fresh approval.'); });
    this.options.onDecision?.(String(old.task_id)); this.changed(); throw error;
   }
   this.tx(() => {
    const r = this.required(id); if (r.revision !== revision || r.state !== 'pending') fail('stale_action', 'This review changed. Refresh it before deciding.');
    if (state) this.checkBrowser(r, state);
    this.write('UPDATE browser_action_proposals SET account_confirmation=? WHERE id=?', v.decision === 'approve' ? account : null, id);
    this.status(id, v.decision === 'approve' ? 'approved' : 'declined');
   });
  } else if (v.type === 'browserActions.resolveUnknown') {
   record(v, ['type', 'actionId', 'revision', 'outcome', 'note']);
   if (!['checked_done', 'checked_not_done'].includes(String(v.outcome))) fail('invalid_command', 'Record the outcome checked on the website.');
   const note = string(v.note, 1200);
   this.tx(() => { const r = this.required(id); if (r.revision !== revision || r.state !== 'outcome_unknown' || r.resolution_json) fail('stale_action', 'This uncertain outcome changed. Refresh before recording your check.');
    this.write('UPDATE browser_action_proposals SET resolution_json=?,revision=revision+1,updated_at=? WHERE id=?', JSON.stringify({ outcome: v.outcome, note, at: this.now() }), this.now(), id); this.event('browser_action.owner_checked', this.required(id)); });
  } else fail('invalid_command', 'This browser action command is not supported.');
  this.options.onDecision?.(String(old.task_id)); this.changed(); return this.state(String(old.task_id));
 }
 private track<T>(work: Promise<T>): Promise<T> { this.active.add(work); void work.finally(() => this.active.delete(work)).catch(() => undefined); return work; }
 async drain() { await this.ownerQueue; await Promise.allSettled([...this.active]); }
}
