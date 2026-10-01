import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator';
import { ProjectsService } from '../../packages/projects';
import { DEFAULT_PROJECT_ID } from '../../packages/projects/migration';
import { Persistence } from '../../packages/persistence';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aw-projects-')), c = new Coordinator({ dataRoot: join(root, 'data') });
  await c.collaboration.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
  const project = (name: string) => { const before = new Set(c.projects.state().projects.map(item => item.id)); return c.projects.handle({ type: 'projects.create', name, description: `${name} private context` }).projects.find(item => !before.has(item.id))!; };
  const agent = (projectId: string, name: string) => { const before = new Set(c.snapshot().agents.map(item => item.id)); c.projects.handle({ type: 'projects.agent.create', projectId, name, instructions: `${name} private instructions` }); return c.snapshot().agents.find(item => !before.has(item.id))!; };
  const task = (agentId: string) => { const before = new Set(c.snapshot().tasks.map(item => item.id)); return c.handle({ type: 'tasks.create', agentId, objective: `${agentId} private objective`, completionCriteria: 'Keep separate', scenario: 'complete' }).tasks.find(item => !before.has(item.id))!; };
  const publish = async (agentId: string, taskId: string, content: string) => { const path = join(root, `${randomUUID()}.txt`); await writeFile(path, content); const privateId = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId, taskId }, paths: [path] })).versionIds[0]; const sharedId = (await c.artifacts.publish({ principal: { kind: 'owner' }, versionId: privateId })).versionIds[0]; return { privateId, sharedId }; };
  const policy = (taskId: string, peer: string) => c.collaboration.handle({ type: 'collaboration.policy', taskId, revision: 1, visibility: 'shared', summary: `Approved summary for ${taskId}`, peerAgentIds: [peer] });
  const db = new DatabaseSync(c.databasePath); db.exec('PRAGMA foreign_keys=ON');
  return { root, c, db, project, agent, task, publish, policy, close: async () => { db.close(); await c.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('three client projects isolate published reads, collaboration context, consumption, messages and dependencies', async () => {
  const f = await fixture();
  try {
    const clients = [];
    for (const label of ['Client A', 'Client B', 'Client C']) {
      const project = f.project(label), writer = f.agent(project.id, `${label} writer`), reader = f.agent(project.id, `${label} reader`);
      const source = f.task(writer.id), destination = f.task(reader.id), files = await f.publish(writer.id, source.id, `${label} confidential price and facts`);
      await f.policy(source.id, reader.id);
      f.c.projects.handle({ type: 'projects.brief.save', projectId: project.id, expectedRevision: 0, content: `${label} approved rules`, knowledgeVersionIds: [files.sharedId] });
      clients.push({ project, writer, reader, source, destination, ...files });
    }
    const [a, b, c] = clients;
    const run = f.c.claimNext(f.c.instanceId, 'simulation', f.c.snapshot().agents.filter(agent => agent.id !== a.reader.id).map(agent => agent.id))!;
    assert.ok(run); f.c.collaboration.reconcile();
    const context = f.c.collaboration.context(run), serialized = JSON.stringify(context);
    assert.equal(context.sharedArtifacts.length, 1); assert.equal(context.sharedArtifacts[0].versionId, a.sharedId);
    assert.equal(context.publications.length, 1); assert.equal(context.publications[0].versionId, a.sharedId);
    assert.equal(context.board.length, 1); assert.equal(context.board[0].taskId, a.source.id);
    for (const other of [b, c]) {
      for (const sensitiveId of [other.sharedId, other.privateId, other.source.id, other.writer.id]) assert.ok(!serialized.includes(sensitiveId));
      await assert.rejects(f.c.artifacts.preview({ principal: { kind: 'agent', agentId: a.reader.id }, versionId: other.sharedId }), /not permitted|permission|project/i);
      await assert.rejects(f.c.artifacts.useInTask({ principal: { kind: 'owner' }, taskId: a.destination.id, versionId: other.sharedId }), /not permitted|permission|project/i);
      await assert.rejects(f.c.collaboration.consume(run, { versionId: other.sharedId }), /another project/);
      await assert.rejects(f.c.collaboration.handle({ type: 'collaboration.policy', taskId: a.source.id, revision: 2, visibility: 'shared', summary: 'Cross client', peerAgentIds: [other.reader.id] }), /within their project/);
      await assert.rejects(f.c.collaboration.handle({ type: 'collaboration.dependency.add', taskId: a.source.id, dependsOnTaskId: other.source.id, requiredVersionId: null }), /within their project/);
      assert.throws(() => f.c.collaboration.send(run, { recipientAgentId: other.reader.id, kind: 'handoff', taskIds: [], versionIds: [], idempotencyKey: randomUUID() }), /within their project/);
      assert.throws(() => f.c.projects.handle({ type: 'projects.brief.save', projectId: a.project.id, expectedRevision: 1, content: 'Wrong client source', knowledgeVersionIds: [other.sharedId] }), /within their project/);
    }
    assert.match((await f.c.artifacts.preview({ principal: { kind: 'agent', agentId: a.reader.id }, versionId: a.sharedId })).text!, /Client A confidential/);
    await f.c.collaboration.consume(run, { versionId: a.sharedId });
    assert.equal(f.c.projects.context(a.reader.id).ownerReviewedBrief, 'Client A approved rules');
    assert.deepEqual(f.c.projects.context(a.reader.id).knowledge.map(item => item.versionId), [a.sharedId]);
    assert.throws(() => f.c.projects.handle({ type: 'projects.brief.save', projectId: a.project.id, expectedRevision: 1, content: '', knowledgeVersionIds: [a.privateId] }), /Publish a verified/);
  } finally { await f.close(); }
});

test('database guards refuse direct cross-project binding or membership changes after work exists', async () => {
  const f = await fixture();
  try {
    const p = f.project('A'), q = f.project('B'), a = f.agent(p.id, 'A'), b = f.agent(q.id, 'B'), ta = f.task(a.id), tb = f.task(b.id), file = await f.publish(a.id, ta.id, 'Keep in A');
    assert.throws(() => f.c.projects.assignNewAgent(a.id, q.id), /existing work cannot change clients/);
    assert.throws(() => f.db.prepare('UPDATE project_agents SET project_id=? WHERE agent_id=?').run(q.id, a.id), /project_agent_immutable/);
    assert.throws(() => f.db.prepare("INSERT INTO task_artifacts VALUES(?,?,'input',1)").run(tb.id, file.sharedId), /project_boundary/);
    assert.throws(() => f.db.prepare('INSERT INTO task_dependencies VALUES(?,?,NULL)').run(tb.id, ta.id), /project_boundary/);
    assert.throws(() => f.db.prepare("INSERT INTO agent_messages(id,sender,recipient,shareable_body,delivery_status,created_at) VALUES(?,?,?,'wrong client','delivered',1)").run(randomUUID(), a.id, b.id), /project_boundary/);
    assert.throws(() => f.db.prepare('UPDATE tasks SET agent_id=? WHERE id=?').run(b.id, ta.id), /project_task_immutable/);
    assert.equal(f.c.projects.agent(a.id), p.id);
  } finally { await f.close(); }
});

test('owner-reviewed briefs are versioned and Gmail approval cannot grant Drive access or another project account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-project-account-')), p = new Persistence(join(root, 'data'), 1);
  try {
    p.db.exec("INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES('a','A','','a',1)");
    p.db.exec("INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,created_at,updated_at) VALUES('t','a','Read mail','paused','','complete',1,1)");
    let verifiedGmail: string | null = 'owner@example.com', verifiedDrive: string | null = null;
    const projects = new ProjectsService({ persistence: p, verifiedGmailAccount: () => verifiedGmail, verifiedGoogleWorkspaceAccount: () => verifiedDrive });
    assert.equal(projects.agent('a'), DEFAULT_PROJECT_ID);
    assert.throws(() => projects.assertGmailAccount('t', 'owner@example.com'), /owner must connect/);
    projects.handle({ type: 'projects.gmail.bind', projectId: DEFAULT_PROJECT_ID, account: 'owner@example.com' });
    projects.assertGmailAccount('t', 'owner@example.com');
    assert.throws(() => projects.assertGmailAccount('t', 'other@example.com'), /owner must connect/);
    assert.throws(() => projects.handle({ type: 'projects.google_workspace.bind', projectId: DEFAULT_PROJECT_ID, account: 'owner@example.com' }), /selected service/);
    assert.throws(() => projects.assertGoogleWorkspaceAccount('t', 'owner@example.com'), /owner must connect/);
    verifiedDrive = 'drive@example.com';
    projects.handle({ type: 'projects.google_workspace.bind', projectId: DEFAULT_PROJECT_ID, account: verifiedDrive });
    projects.assertGoogleWorkspaceAccount('t', verifiedDrive);
    verifiedGmail = null;
    projects.handle({ type: 'projects.gmail.bind', projectId: DEFAULT_PROJECT_ID, account: null });
    assert.throws(() => projects.assertGmailAccount('t', 'owner@example.com'), /owner must connect/);
    for (let revision = 0; revision < 2; revision++) projects.handle({ type: 'projects.brief.save', projectId: DEFAULT_PROJECT_ID, expectedRevision: revision, content: `Approved version ${revision + 1}`, knowledgeVersionIds: [] });
    assert.equal(Number(p.db.prepare('SELECT COUNT(*) AS n FROM project_briefs').get()!.n), 2);
    assert.equal(projects.context('a').briefRevision, 2);
    assert.throws(() => projects.handle({ type: 'projects.brief.save', projectId: DEFAULT_PROJECT_ID, expectedRevision: 1, content: 'Stale edit', knowledgeVersionIds: [] }), /changed/);
  } finally { p.close(); await rm(root, { recursive: true, force: true }); }
});
