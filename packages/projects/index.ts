import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Persistence } from '../persistence';
import type { ProjectBrief, ProjectCommand, ProjectsState } from '../contracts/projects';
import { DEFAULT_PROJECT_ID } from './migration';

export class ProjectError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProjectError'; }
}
function fail(code: string, message: string): never { throw new ProjectError(code, message); }
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || /\x00/.test(value) || (required && !value.trim())) fail('invalid_project', 'Enter a valid project name or instruction.');
  return value.trim();
}
function id(value: unknown): string { const result = text(value, 96, true); if (!/^[A-Za-z0-9_-]+$/.test(result)) fail('invalid_project', 'Invalid project reference.'); return result; }
/** Shared service-layer boundary, including calls which bypass the owner renderer. */
export class ProjectAccess {
  constructor(readonly db: DatabaseSync) {}
  private value(sql: string, ...values: SQLInputValue[]): string {
    const row = this.db.prepare(sql).get(...values);
    if (!row) fail('project_boundary', 'This item is not available in the selected project.');
    return String(row.project_id);
  }
  agent(agentId: string): string { return this.value('SELECT project_id FROM project_agents WHERE agent_id=?', agentId); }
  task(taskId: string): string { return this.value('SELECT p.project_id FROM tasks t JOIN project_agents p ON p.agent_id=t.agent_id WHERE t.id=?', taskId); }
  artifact(artifactId: string): string { return this.value('SELECT project_id FROM project_artifacts WHERE artifact_id=?', artifactId); }
  version(versionId: string): string { return this.value('SELECT p.project_id FROM artifact_versions v JOIN project_artifacts p ON p.artifact_id=v.artifact_id WHERE v.id=?', versionId); }
  same(first: string, second: string): void { if (first !== second) fail('project_boundary', 'Keep files, messages and task dependencies within their project. Export and deliberately reimport a copy to another project.'); }
  assertAgentVersion(agentId: string, versionId: string): void { this.same(this.agent(agentId), this.version(versionId)); }
  canReadVersion(agentId: string, versionId: string): boolean { try { return this.agent(agentId) === this.version(versionId); } catch { return false; } }
  canSeeTask(agentId: string, taskId: string): boolean { try { return this.agent(agentId) === this.task(taskId); } catch { return false; } }
  /** Call before LIMIT so another project's recent files cannot starve this project's context. */
  sharedVersionIds(agentId: string, limit: number): string[] {
    const project = this.agent(agentId);
    return this.db.prepare("SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id JOIN project_artifacts p ON p.artifact_id=a.id WHERE p.project_id=? AND a.visibility='shared' AND v.status='ready' ORDER BY v.created_at DESC,v.rowid DESC LIMIT ?").all(project, Math.min(2000, Math.max(1, limit))).map(row => String(row.id));
  }
}
type Options = {
  persistence: Persistence;
  now?: () => number;
  /** Trusted callback: insert an agent and its empty browser session inside the current transaction. */
  createAgent?: (input: { name: string; instructions: string }) => string;
  /** Read the currently connected/verified account; no token material may be returned. */
  verifiedGmailAccount?: () => string | null;
  verifiedGoogleWorkspaceAccount?: () => string | null;
};
export class ProjectsService extends ProjectAccess {
  private readonly now: () => number;
  constructor(private readonly options: Options) { super(options.persistence.db); this.now = options.now || Date.now; }
  private project(projectId: string) { const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id(projectId)); if (!row) fail('not_found', 'Project not found.'); return row; }
  private brief(projectId: string): ProjectBrief | null {
    const row = this.db.prepare('SELECT * FROM project_briefs WHERE project_id=? ORDER BY revision DESC LIMIT 1').get(projectId);
    return row ? { id: String(row.id), projectId, revision: Number(row.revision), content: String(row.content), knowledgeVersionIds: JSON.parse(String(row.knowledge_version_ids)), createdAt: Number(row.created_at) } : null;
  }
  state(): ProjectsState {
    return { defaultProjectId: DEFAULT_PROJECT_ID, verifiedAccounts: { gmail: this.options.verifiedGmailAccount?.() ?? null, googleWorkspace: this.options.verifiedGoogleWorkspaceAccount?.() ?? null }, projects: this.db.prepare('SELECT * FROM projects ORDER BY created_at,id').all().map(row => {
      const projectId = String(row.id);
      return { id: projectId, name: String(row.name), description: String(row.description), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), agentIds: this.db.prepare('SELECT agent_id FROM project_agents WHERE project_id=? ORDER BY agent_id').all(projectId).map(item => String(item.agent_id)), taskIds: this.db.prepare('SELECT t.id FROM tasks t JOIN project_agents p ON p.agent_id=t.agent_id WHERE p.project_id=? ORDER BY t.created_at,t.id').all(projectId).map(item => String(item.id)), artifactIds: this.db.prepare('SELECT artifact_id FROM project_artifacts WHERE project_id=? ORDER BY artifact_id').all(projectId).map(item => String(item.artifact_id)), brief: this.brief(projectId), gmailAccount: this.gmailAccount(projectId), googleWorkspaceAccount: this.googleWorkspaceAccount(projectId) };
    }) };
  }
  /** Only a newly-created, unused agent can be assigned. Database triggers guard this invariant too. */
  assignNewAgent(agentId: string, projectId: string): void {
    this.project(projectId); this.agent(id(agentId));
    if (this.db.prepare('SELECT 1 FROM tasks WHERE agent_id=?').get(agentId) || this.db.prepare('SELECT 1 FROM artifacts WHERE owner_agent_id=?').get(agentId)) fail('project_agent_immutable', 'Create a new agent for this project; existing work cannot change clients.');
    this.db.prepare('UPDATE project_agents SET project_id=? WHERE agent_id=?').run(projectId, agentId);
  }
  gmailAccount(projectId: string): string | null { return this.db.prepare('SELECT account FROM project_gmail_accounts WHERE project_id=?').get(projectId)?.account as string | undefined ?? null; }
  googleWorkspaceAccount(projectId: string): string | null { return this.db.prepare('SELECT account FROM project_google_workspace_accounts WHERE project_id=?').get(projectId)?.account as string | undefined ?? null; }
  assertGmailAccount(taskId: string, account: string): void {
    if (this.gmailAccount(this.task(taskId)) !== account.trim().toLowerCase()) fail('project_account_required', 'The owner must connect and approve this Gmail account for this project before the agent can read mail.');
  }
  assertGoogleWorkspaceAccount(taskId: string, account: string): void {
    if (this.googleWorkspaceAccount(this.task(taskId)) !== account.trim().toLowerCase()) fail('project_account_required', 'The owner must connect and approve this Drive account for this project before importing Drive or Sheets files.');
  }
  /** Owner-authored context only. Shared knowledge references still need explicit task input grants. */
  context(agentId: string) {
    const projectId = this.agent(agentId), project = this.project(projectId), brief = this.brief(projectId);
    const knowledge = (brief?.knowledgeVersionIds || []).flatMap(versionId => {
      const row = this.db.prepare("SELECT v.id,v.sha256,v.bytes,a.display_name FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.id=? AND v.status='ready' AND a.visibility='shared'").get(versionId);
      return row && this.canReadVersion(agentId, versionId) ? [{ versionId, displayName: String(row.display_name), sha256: String(row.sha256), bytes: Number(row.bytes) }] : [];
    });
    return { projectId, name: String(project.name), briefRevision: brief?.revision ?? 0, ownerReviewedBrief: brief?.content || '', knowledge, gmailAccount: this.gmailAccount(projectId) };
  }
  handle(raw: unknown): ProjectsState {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_project', 'Invalid project action.');
    const command = raw as ProjectCommand;
    if (command.type === 'projects.state') return this.state();
    this.options.persistence.transaction(() => {
      let changedProjectId:string;
      if (command.type === 'projects.create') {
        if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n) >= 100) fail('capacity_limit', 'The limit is 100 saved projects.');
        const name = text(command.name, 80, true), description = text(command.description, 2000), now = this.now();
        changedProjectId=randomUUID();
        this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(changedProjectId, name, description, now, now);
      } else if (command.type === 'projects.agent.create') {
        this.project(command.projectId);changedProjectId=command.projectId;
        if (!this.options.createAgent) fail('unavailable', 'Project agent creation is not connected.');
        const agentId = this.options.createAgent({ name: text(command.name, 80, true), instructions: text(command.instructions, 8000) });
        this.assignNewAgent(agentId, command.projectId);
      } else if (command.type === 'projects.brief.save') {
        this.project(command.projectId);changedProjectId=command.projectId;
        const current = this.brief(command.projectId);
        if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== (current?.revision ?? 0)) fail('stale_revision', 'The project brief changed. Refresh before saving.');
        const content = text(command.content, 8000);
        if (!Array.isArray(command.knowledgeVersionIds) || command.knowledgeVersionIds.length > 20 || new Set(command.knowledgeVersionIds).size !== command.knowledgeVersionIds.length) fail('invalid_project', 'Choose at most 20 distinct project-shared references.');
        for (const versionId of command.knowledgeVersionIds) {
          this.same(command.projectId, this.version(id(versionId)));
          if (!this.db.prepare("SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.id=? AND a.visibility='shared' AND v.status='ready'").get(versionId)) fail('project_boundary', 'Publish a verified file within this project before approving it as shared knowledge.');
        }
        const now = this.now();
        this.db.prepare('INSERT INTO project_briefs VALUES(?,?,?,?,?,?)').run(randomUUID(), command.projectId, (current?.revision ?? 0) + 1, content, JSON.stringify(command.knowledgeVersionIds), now);
        this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, command.projectId);
      } else if (command.type === 'projects.gmail.bind' || command.type === 'projects.google_workspace.bind') {
        this.project(command.projectId);changedProjectId=command.projectId;
        const table = command.type === 'projects.gmail.bind' ? 'project_gmail_accounts' : 'project_google_workspace_accounts';
        const verified = command.type === 'projects.gmail.bind' ? this.options.verifiedGmailAccount?.() : this.options.verifiedGoogleWorkspaceAccount?.();
        if (command.account === null) this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(command.projectId);
        else {
          const account = text(command.account, 254, true).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account) || verified?.toLowerCase() !== account) fail('project_account_required', 'Connect this exact account for the selected service before approving it for a project.');
          this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET account=excluded.account,bound_at=excluded.bound_at`).run(command.projectId, account, this.now());
        }
      } else fail('invalid_project', 'Unknown project action.');
      this.db.prepare('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,1,?,?)').run(command.type,changedProjectId,JSON.stringify({projectId:changedProjectId}),this.now());
    });
    return this.state();
  }
}
