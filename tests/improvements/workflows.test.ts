import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../packages/persistence';
import { Coordinator } from '../../packages/coordinator';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { DEFAULT_MODEL } from '../../packages/model-adapters/pricing';
import { prepareWorkflow, WORKFLOW_RECIPES, workflowWebsites } from '../../packages/workflows/catalog';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aw-workflows-')), dataRoot = join(root, 'app');
  const instances: Coordinator[] = [];
  const create = async () => { const c = new Coordinator({ dataRoot }); instances.push(c); await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } }); return c; };
  const c = await create(), agent = c.handle({ type: 'agents.create', name: 'Workflow fixture', instructions: '' }).agents[0];
  return { root, c, agent, create, async close() { for (const instance of instances) await instance.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const values: Record<string, Record<string, string>> = {
  'competitor-brief': { focus: 'Compare supported features.', websites: 'https://example.com/pricing\nhttps://example.com/help' },
  'data-report': { question: 'Which values changed?', files: 'Two CSV files' },
  'code-review': { focus: 'Find defects in input handling.', files: 'Source text and JSON fixtures' },
  'website-review': { focus: 'Check clarity for new readers.', websites: 'https://example.com/help' },
  'gmail-triage': { account: 'Owner@gmail.com', focus: 'Deadlines and direct requests.' },
  'decision-research': { question: 'Compare the course prerequisites.', websites: 'https://example.com/course' },
};
function creation(agentId: string, workflowId = 'competitor-brief', input = values[workflowId], key = randomUUID()) {
  return { type: 'workflows.createTask', workflowId, values: input, agentId, model: DEFAULT_MODEL, limits: { ...DEFAULT_LIVE_LIMITS }, idempotencyKey: key };
}

test('all six starters create paused tasks with specific outcomes and no grants, jobs or model calls', async () => {
  const f = await fixture();
  try {
    assert.deepEqual([...new Set(WORKFLOW_RECIPES.map(item => item.category))].sort(), ['business', 'developer', 'personal']);
    for (const recipe of WORKFLOW_RECIPES) {
      const result = f.c.workflows.handle(creation(f.agent.id, recipe.id));
      const task = f.c.snapshot().tasks.find(item => item.id === result.createdTaskId)!;
      const run = (await f.c.live.state()).tasks.find(item => item.taskId === task.id)!;
      assert.equal(task.state, 'paused'); assert.equal(run.enabled, false); assert.equal(run.calls, 0); assert.equal(run.steps, 0);
      assert.equal(f.c.snapshot().events.find(event => event.type === 'workflow.task_prepared' && event.aggregateId === task.id)!.payload.workflowId, recipe.id);
      assert.ok(task.completionCriteria.length > 30); assert.ok(task.objective.length > 100);
      assert.equal(f.c.snapshot().taskArtifacts.length, 0);
      assert.equal(f.c.snapshot().requests.length, 0);
      assert.equal(f.c.collaboration.state().policies.find(item => item.taskId === task.id)?.visibility, 'private');
      if (recipe.id === 'gmail-triage') { assert.equal(run.policy.mailAccount, 'owner@gmail.com'); assert.equal(run.policy.mode, 'read_only_browser'); }
    }
    assert.equal(f.c.snapshot().tasks.length, 6);
    const db = new DatabaseSync(f.c.databasePath);
    try {
      for (const table of ['runs', 'live_model_calls', 'request_capability_grants', 'code_executions']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_sessions WHERE lifecycle<>'not_provisioned'").get()!.n, 0);
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('preview is pure and URLs grant only canonical deduplicated origins', async () => {
  const f = await fixture();
  try {
    const result = f.c.workflows.handle({ type: 'workflows.preview', workflowId: 'competitor-brief', values: values['competitor-brief'] });
    assert.deepEqual(result.prepared!.policy, { mode: 'read_only_browser', allowedOrigins: ['https://example.com'] });
    assert.match(result.prepared!.objective, /https:\/\/example.com\/pricing/);
    assert.equal(f.c.snapshot().tasks.length, 0);
    assert.deepEqual(workflowWebsites('https://EXAMPLE.com/page').origins, ['https://example.com']);
  } finally { await f.close(); }
});

test('required inputs, website protocols, account scope and authority fields fail before creation', async () => {
  const f = await fixture();
  try {
    const invalid = [
      creation(f.agent.id, 'competitor-brief', { focus: 'Compare', websites: '' }),
      creation(f.agent.id, 'competitor-brief', { focus: 'Compare', websites: 'http://example.com' }),
      creation(f.agent.id, 'competitor-brief', { focus: 'Compare', websites: 'https://user:password@example.com' }),
      creation(f.agent.id, 'competitor-brief', { focus: 'Compare', websites: 'https://127.0.0.1' }),
      creation(f.agent.id, 'competitor-brief', { focus: 'Compare', websites: 'https://machine.local' }),
      creation(f.agent.id, 'competitor-brief', { focus: 'Compare', websites: 'https://example.com', policy: 'unlimited' }),
      creation(f.agent.id, 'gmail-triage', { account: 'someone@example.com', focus: 'Inbox' }),
      { ...creation(f.agent.id), limits: { ...DEFAULT_LIVE_LIMITS, maxCostUsd: 1000 } },
      { ...creation(f.agent.id), allowedPaths: ['/Users/owner'] },
      { ...creation(f.agent.id), model: 'invented-model' },
    ];
    for (const command of invalid) assert.throws(() => f.c.workflows.handle(command));
    assert.equal(f.c.snapshot().tasks.length, 0);
    assert.equal((await f.c.live.state()).tasks.length, 0);
  } finally { await f.close(); }
});

test('creation receipts replay after restart without duplicate tasks and reject changed details', async () => {
  const f = await fixture();
  try {
    const command = creation(f.agent.id), first = f.c.workflows.handle(command);
    assert.equal(f.c.workflows.handle({ ...command, values: { websites: command.values.websites, focus: command.values.focus } }).createdTaskId, first.createdTaskId);
    assert.throws(() => f.c.workflows.handle({ ...command, limits: { ...DEFAULT_LIVE_LIMITS, maxCostUsd: 2 } }), /different details/);
    await f.c.shutdown(); const next = await f.create();
    assert.equal(next.workflows.handle(command).createdTaskId, first.createdTaskId);
    assert.equal(next.snapshot().tasks.length, 1);
    assert.equal((await next.live.state()).tasks[0].enabled, false);
  } finally { await f.close(); }
});

test('receipt failure rolls back task, model config, messages and provenance together', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.c.databasePath);
    try { db.exec("CREATE TRIGGER reject_workflow_receipt BEFORE INSERT ON workflow_receipts BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END;"); } finally { db.close(); }
    assert.throws(() => f.c.workflows.handle(creation(f.agent.id)), /fixture_receipt_failure/);
    assert.equal(f.c.snapshot().tasks.length, 0); assert.equal(f.c.snapshot().messages.length, 0); assert.equal((await f.c.live.state()).tasks.length, 0);
  } finally { await f.close(); }
});

test('saved workflows retain only the reviewed brief and base policy; reruns get no private files or grants', async () => {
  const f = await fixture();
  try {
    const original = f.c.workflows.handle(creation(f.agent.id, 'data-report')).createdTaskId!;
    const path = join(f.root, 'private.txt'); await writeFile(path, 'private fixture');
    await f.c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: f.agent.id, taskId: original }, paths: [path] });
    f.c.handle({ type: 'tasks.message', taskId: original, content: 'A private follow-up that must not become a template.' });
    const save = { type: 'workflows.saveFromTask', taskId: original, title: 'Monthly data review', description: 'Repeat the analysis with fresh files.', category: 'business', idempotencyKey: randomUUID() };
    const saved = f.c.workflows.handle(save).saved[0];
    assert.equal(f.c.workflows.handle(save).saved.length, 1);
    assert.equal(JSON.stringify(saved).includes('private follow-up'), false);
    assert.equal(JSON.stringify(saved).includes('private.txt'), false);
    await f.c.shutdown(); const next = await f.create();
    const agent = next.handle({ type: 'agents.create', name: 'Another private agent', instructions: '' }).agents.at(-1)!;
    const created = next.workflows.handle(creation(agent.id, saved.id, {})).createdTaskId!;
    assert.equal(next.snapshot().tasks.find(item => item.id === created)!.agentId, agent.id);
    assert.equal(next.snapshot().taskArtifacts.filter(item => item.taskId === created).length, 0);
    assert.equal(next.snapshot().messages.filter(item => item.taskId === created && item.deliveryState).length, 0);
    assert.equal((await next.live.state()).tasks.find(item => item.taskId === created)!.calls, 0);
    assert.equal(next.workflows.handle({ type: 'workflows.delete', workflowId: saved.id }).saved.length, 0);
    assert.equal(next.snapshot().tasks.length, 2);
    assert.throws(() => next.workflows.handle(creation(agent.id, saved.id, {})), /no longer available/);
  } finally { await f.close(); }
});

test('migration from version seven preserves task state and legacy messages without pretending they were incorporated', async () => {
  const f = await fixture();
  try {
    const taskId = f.c.workflows.handle(creation(f.agent.id)).createdTaskId!;
    const before = f.c.snapshot(); await f.c.shutdown();
    const db = new DatabaseSync(f.c.databasePath);
    try { db.exec('PRAGMA foreign_keys=OFF'); for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'project_%'").all())db.exec('DROP TRIGGER '+String(row.name)); for(const name of ['fleet_messages','fleet_plan_revisions','fleet_tasks','fleet_items','fleet_members','fleet_runs','security_review_handoffs','security_review_members','security_review_teams','task_recovery_incidents','routine_change_alerts','routine_result_comparisons','routine_alert_settings','browser_action_proposals','project_briefs','project_gmail_accounts','project_google_accounts','project_google_workspace_accounts','project_artifacts','project_agents','projects','owner_notices','notice_settings','routine_preparation_claims','routine_occurrences','routines','result_actions','result_revision_jobs','result_reviews','workflow_input_assignments'])db.exec('DROP TABLE IF EXISTS '+name); db.exec('DROP TABLE workflow_task_origins; DROP TABLE workflow_receipts; DROP TABLE saved_workflows; DROP INDEX task_message_delivery; ALTER TABLE task_messages DROP COLUMN incorporated_at; ALTER TABLE task_messages DROP COLUMN delivery_state; DELETE FROM schema_migrations WHERE version>=8; PRAGMA user_version=7;'); } finally { db.close(); }
    const next = await f.create();
    assert.equal(next.snapshot().runtime.schemaVersion, SCHEMA_VERSION); assert.deepEqual(next.snapshot().messages, before.messages);
    assert.equal(next.snapshot().tasks.find(item => item.id === taskId)!.state, 'paused');
    assert.equal((await next.live.state()).tasks[0].enabled, false);
  } finally { await f.close(); }
});
