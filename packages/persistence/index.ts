import {FLEET_MIGRATION,FLEET_LAB_MIGRATION} from '../fleet/migration';
import {SECURITY_REVIEW_MIGRATION} from '../security-review/migration';
import {BROWSER_ACTIONS_MIGRATION} from '../browser-actions/migration';
import { PROJECTS_MIGRATION } from '../projects/migration';
import { TASK_RECOVERY_MIGRATION } from '../task-recovery/migration';
import { ROUTINE_ALERTS_MIGRATION, ROUTINES_MIGRATION, ROUTINE_CLAIMS_MIGRATION } from '../routines/migration';
import { DatabaseSync } from 'node:sqlite';
import { RESULTS_MIGRATION } from '../results/migration';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SCHEMA_VERSION = 24;

/** Owned directories must never resolve through a payload-created symlink. */
export function privateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Application data directory is not a private directory.');
  chmodSync(path, 0o700);
}

const migration = `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL,
  model_config TEXT NOT NULL DEFAULT '{}', policy_id TEXT NOT NULL DEFAULT 'simulation-only',
  workspace_id TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), objective TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','pausing','paused','recovering','succeeded','failed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), waiting_reason TEXT,
  completion_criteria TEXT NOT NULL, sharing_policy TEXT NOT NULL DEFAULT 'private',
  scenario TEXT NOT NULL CHECK(scenario IN ('clarification','complete','failure')),
  checkpoint INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint >= 0), generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX runnable_tasks ON tasks(state,created_at,id);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(id),
  attempt INTEGER NOT NULL CHECK(attempt > 0), worker_id TEXT NOT NULL, lease_until INTEGER NOT NULL,
  fencing_generation INTEGER NOT NULL CHECK(fencing_generation > 0), checkpoint TEXT NOT NULL, usage TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK(state IN ('running','paused','waiting','succeeded','failed','cancelled','interrupted')),
  created_at INTEGER NOT NULL, finished_at INTEGER, UNIQUE(task_id,attempt)
) STRICT;
CREATE UNIQUE INDEX one_active_run_per_agent ON runs(agent_id) WHERE state='running';
CREATE UNIQUE INDEX one_active_run_per_task ON runs(task_id) WHERE state='running';
CREATE TABLE task_messages (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL CHECK(role IN ('owner','agent','system')), content TEXT NOT NULL,
  attachment_refs TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX task_message_order ON task_messages(task_id,created_at,id);
CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id), profile_ref TEXT,
  controller TEXT NOT NULL DEFAULT 'none' CHECK(controller IN ('none','agent','human','transitioning')),
  controller_generation INTEGER NOT NULL DEFAULT 0, lifecycle TEXT NOT NULL DEFAULT 'not_provisioned'
) STRICT;
CREATE TABLE browser_tabs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES browser_sessions(id), permitted_url TEXT NOT NULL,
  title TEXT NOT NULL, observation_revision INTEGER NOT NULL DEFAULT 0, lifecycle TEXT NOT NULL
) STRICT;
CREATE TABLE input_requests (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL CHECK(type IN ('files','clarification','browser_handoff','permission_change')),
  title TEXT NOT NULL, reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','partial','checking','needs_correction','fulfilled','cancelled','superseded')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), continuation_key TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 1 CHECK(blocking IN (0,1)), response TEXT, response_revision INTEGER,
  created_at INTEGER NOT NULL, UNIQUE(task_id,continuation_key)
) STRICT;
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, owner_agent_id TEXT REFERENCES agents(id), producer_task_id TEXT REFERENCES tasks(id),
  visibility TEXT NOT NULL CHECK(visibility IN ('private','shared')), display_name TEXT NOT NULL
) STRICT;
CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), storage_ref TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0), mime TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE request_slots (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES input_requests(id), slot_key TEXT NOT NULL,
  required INTEGER NOT NULL CHECK(required IN (0,1)), constraints_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK(state IN ('missing','uploading','checking','accepted','needs_replacement')),
  candidate_version_id TEXT REFERENCES artifact_versions(id), revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(request_id,slot_key)
) STRICT;
CREATE TABLE artifact_grants (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), version_id TEXT REFERENCES artifact_versions(id),
  permitted_agent_id TEXT REFERENCES agents(id), all_agents INTEGER NOT NULL DEFAULT 0 CHECK(all_agents IN (0,1)),
  granted_by TEXT NOT NULL, CHECK((permitted_agent_id IS NOT NULL AND all_agents=0) OR (permitted_agent_id IS NULL AND all_agents=1))
) STRICT;
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id), depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  required_artifact_version TEXT REFERENCES artifact_versions(id), PRIMARY KEY(task_id,depends_on_task_id), CHECK(task_id<>depends_on_task_id)
) STRICT;
CREATE TRIGGER dependency_cycle_insert BEFORE INSERT ON task_dependencies BEGIN
  SELECT RAISE(ABORT,'dependency_cycle') WHERE EXISTS (
    WITH RECURSIVE upstream(id) AS (
      SELECT NEW.depends_on_task_id UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN upstream u ON d.task_id=u.id
    ) SELECT 1 FROM upstream WHERE id=NEW.task_id
  );
END;
CREATE TRIGGER dependency_cycle_update BEFORE UPDATE ON task_dependencies BEGIN
  SELECT RAISE(ABORT,'dependency_edges_are_immutable');
END;
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES agents(id), recipient TEXT NOT NULL REFERENCES agents(id),
  task_refs TEXT NOT NULL DEFAULT '[]', shareable_body TEXT NOT NULL, artifact_refs TEXT NOT NULL DEFAULT '[]',
  delivery_status TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), generation INTEGER NOT NULL, tool_name TEXT NOT NULL,
  args_ref TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('planned','dispatched','succeeded','failed','outcome_unknown')),
  result_ref TEXT, idempotency_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE TABLE code_executions (
  id TEXT PRIMARY KEY, tool_call_id TEXT NOT NULL REFERENCES tool_calls(id), image_digest TEXT NOT NULL,
  argv TEXT NOT NULL, cwd TEXT NOT NULL, limits_json TEXT NOT NULL, exit_code INTEGER, log_ref TEXT, lifecycle TEXT NOT NULL
) STRICT;
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX aggregate_events ON events(aggregate_id,id);
CREATE TABLE event_cursors (
  consumer_id TEXT PRIMARY KEY, last_event_id INTEGER NOT NULL DEFAULT 0 CHECK(last_event_id >= 0)
) STRICT;
CREATE TABLE resume_receipts (
  request_id TEXT NOT NULL REFERENCES input_requests(id), fulfillment_revision INTEGER NOT NULL,
  continuation_key TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(request_id,fulfillment_revision,continuation_key)
) STRICT;
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), theme TEXT NOT NULL CHECK(theme IN ('system','light','dark')),
  driver_enabled INTEGER NOT NULL CHECK(driver_enabled IN (0,1)), max_active_agents INTEGER NOT NULL CHECK(max_active_agents BETWEEN 1 AND 2)) STRICT;
INSERT INTO settings VALUES (1,'system',1,2);
`;

const artifactMigration = `
ALTER TABLE artifacts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifacts ADD COLUMN published_from_artifact_id TEXT REFERENCES artifacts(id);
CREATE UNIQUE INDEX one_publication_group ON artifacts(published_from_artifact_id) WHERE published_from_artifact_id IS NOT NULL;
ALTER TABLE artifact_versions ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE artifact_versions ADD COLUMN format TEXT NOT NULL DEFAULT 'binary';
ALTER TABLE artifact_versions ADD COLUMN source_version_id TEXT REFERENCES artifact_versions(id);
CREATE UNIQUE INDEX artifact_version_sequence ON artifact_versions(artifact_id,version_number);
CREATE UNIQUE INDEX published_source_once ON artifact_versions(artifact_id,source_version_id) WHERE source_version_id IS NOT NULL;
CREATE TABLE task_artifacts (
  task_id TEXT NOT NULL REFERENCES tasks(id), version_id TEXT NOT NULL REFERENCES artifact_versions(id),
  role TEXT NOT NULL CHECK(role IN ('input','output')), created_at INTEGER NOT NULL, PRIMARY KEY(task_id,version_id)
) STRICT;
CREATE TABLE run_artifact_bindings (
  run_id TEXT NOT NULL REFERENCES runs(id), version_id TEXT NOT NULL REFERENCES artifact_versions(id),
  PRIMARY KEY(run_id,version_id)
) STRICT;
CREATE TABLE workspace_snapshots (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
  storage_ref TEXT NOT NULL UNIQUE, manifest TEXT NOT NULL, bytes INTEGER NOT NULL, file_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','missing','corrupt')), created_at INTEGER NOT NULL,
  UNIQUE(task_id,revision)
) STRICT;
CREATE TABLE workspace_heads (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id)
) STRICT;
CREATE TABLE artifact_operations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staging','finalized','committed','abandoned')),
  manifest TEXT NOT NULL, reserved_bytes INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE artifact_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), budget_bytes INTEGER NOT NULL CHECK(budget_bytes>0),
  used_bytes INTEGER NOT NULL DEFAULT 0, measured_at INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO artifact_settings(id,budget_bytes) VALUES (1,2147483648);
`;

const codeMigration = `
ALTER TABLE code_executions ADD COLUMN task_id TEXT REFERENCES tasks(id);
ALTER TABLE code_executions ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE code_executions ADD COLUMN owner_instance TEXT;
ALTER TABLE code_executions ADD COLUMN owner_pid INTEGER;
ALTER TABLE code_executions ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE code_executions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'python';
ALTER TABLE code_executions ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE code_executions ADD COLUMN started_at INTEGER;
ALTER TABLE code_executions ADD COLUMN finished_at INTEGER;
ALTER TABLE code_executions ADD COLUMN duration_ms INTEGER;
ALTER TABLE code_executions ADD COLUMN reason TEXT;
ALTER TABLE code_executions ADD COLUMN error TEXT;
ALTER TABLE code_executions ADD COLUMN stdout TEXT NOT NULL DEFAULT '';
ALTER TABLE code_executions ADD COLUMN stderr TEXT NOT NULL DEFAULT '';
ALTER TABLE code_executions ADD COLUMN logs_truncated INTEGER NOT NULL DEFAULT 0 CHECK(logs_truncated IN (0,1));
ALTER TABLE code_executions ADD COLUMN workspace_committed INTEGER NOT NULL DEFAULT 0 CHECK(workspace_committed IN (0,1));
ALTER TABLE code_executions ADD COLUMN workspace_revision INTEGER;
ALTER TABLE code_executions ADD COLUMN output_version_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE code_executions ADD COLUMN input_bindings TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX one_active_code_job ON code_executions((1)) WHERE lifecycle IN ('preparing','running','exporting','stopping');
CREATE TABLE code_dependencies (
  request_id TEXT PRIMARY KEY REFERENCES input_requests(id), runtime TEXT NOT NULL CHECK(runtime IN ('python','node')),
  package_name TEXT NOT NULL, version TEXT, reason TEXT NOT NULL
) STRICT;
CREATE TABLE code_workspace_revisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), execution_id TEXT NOT NULL UNIQUE REFERENCES code_executions(id),
  parent_id TEXT REFERENCES code_workspace_revisions(id), revision INTEGER NOT NULL CHECK(revision>0),
  storage_ref TEXT NOT NULL UNIQUE, manifest TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0),
  file_count INTEGER NOT NULL CHECK(file_count>=0), status TEXT NOT NULL CHECK(status IN ('ready','missing','corrupt')),
  output_version_ids TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(task_id,revision)
) STRICT;
CREATE TABLE code_workspace_heads (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), revision_id TEXT NOT NULL REFERENCES code_workspace_revisions(id)
) STRICT;
CREATE TABLE code_workspace_leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(id),
  execution_id TEXT NOT NULL UNIQUE REFERENCES code_executions(id), owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL,
  base_revision_id TEXT REFERENCES code_workspace_revisions(id), input_version_ids TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE task_artifact_deliveries (
  task_id TEXT NOT NULL REFERENCES tasks(id), version_id TEXT NOT NULL REFERENCES artifact_versions(id),
  state TEXT NOT NULL CHECK(state IN ('pending','delivered')), created_at INTEGER NOT NULL, delivered_at INTEGER,
  PRIMARY KEY(task_id,version_id)
) STRICT;
`;

const requestMigration = `
ALTER TABLE request_slots ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE request_slots ADD COLUMN explanation TEXT;
CREATE TABLE request_details (
 request_id TEXT PRIMARY KEY REFERENCES input_requests(id), kind TEXT NOT NULL CHECK(kind IN ('files','clarification','capability','reduced_scope')),
 spec_json TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', source_run_id TEXT REFERENCES runs(id),
 parent_request_id TEXT REFERENCES input_requests(id), parent_revision INTEGER, replan_count INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE slot_candidates (
 id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES request_slots(id), slot_revision INTEGER NOT NULL,
 version_id TEXT NOT NULL REFERENCES artifact_versions(id), state TEXT NOT NULL CHECK(state IN ('checking','accepted','rejected','superseded')),
 explanation TEXT, created_at INTEGER NOT NULL, checked_at INTEGER, UNIQUE(slot_id,slot_revision)
) STRICT;
CREATE TABLE request_validation_jobs (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES input_requests(id), slot_id TEXT NOT NULL REFERENCES request_slots(id),
 candidate_id TEXT NOT NULL UNIQUE REFERENCES slot_candidates(id), slot_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','completed','cancelled')),
 owner_id TEXT, owner_pid INTEGER, generation INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE UNIQUE INDEX one_file_validator ON request_validation_jobs((1)) WHERE state='running';
CREATE TABLE request_owner_replies (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES input_requests(id), request_revision INTEGER NOT NULL,
 response TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('reply','accept','decline')),
 created_at INTEGER NOT NULL, UNIQUE(request_id,request_revision)
) STRICT;
CREATE TABLE request_replan_jobs (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES input_requests(id), request_revision INTEGER NOT NULL,
 reply_id TEXT NOT NULL UNIQUE REFERENCES request_owner_replies(id),
 state TEXT NOT NULL CHECK(state IN ('queued','running','completed','cancelled')),
 owner_id TEXT, owner_pid INTEGER, generation INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE UNIQUE INDEX one_request_replan ON request_replan_jobs((1)) WHERE state='running';
CREATE TABLE request_capability_grants (
 request_id TEXT PRIMARY KEY REFERENCES input_requests(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 capability_json TEXT NOT NULL, granted_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'simulation' CHECK(execution_mode IN ('simulation','live'));
CREATE TABLE live_task_config (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), model TEXT NOT NULL, policy_json TEXT NOT NULL, limits_json TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), calls INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0,
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_microusd INTEGER NOT NULL DEFAULT 0,
 reserved_microusd INTEGER NOT NULL DEFAULT 0, reserved_input_tokens INTEGER NOT NULL DEFAULT 0, reserved_output_tokens INTEGER NOT NULL DEFAULT 0, active_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT, checkpoint TEXT NOT NULL DEFAULT '{}',
 result_version_id TEXT REFERENCES artifact_versions(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE live_model_calls (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
 state TEXT NOT NULL CHECK(state IN ('reserved','completed','uncertain','failed')),
 reserved_microusd INTEGER NOT NULL, quoted_input_tokens INTEGER NOT NULL DEFAULT 0, quoted_output_tokens INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 cost_microusd INTEGER NOT NULL DEFAULT 0, request_hash TEXT NOT NULL,
 owner_pid INTEGER NOT NULL, owner_instance TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE TABLE live_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL CHECK(kind IN ('observation','result','note')), content TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE live_tool_receipts (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id),
 model_call_id TEXT NOT NULL REFERENCES live_model_calls(id), tool_name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('dispatched','succeeded','failed','outcome_unknown')),
 result_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, UNIQUE(model_call_id)
) STRICT;
`;

const collaborationMigration = `
CREATE TABLE collaboration_policies (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 visibility TEXT NOT NULL CHECK(visibility IN ('private','shared')), summary TEXT NOT NULL DEFAULT '',
 peer_agent_ids TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
) STRICT;
ALTER TABLE agent_messages ADD COLUMN source_task_id TEXT REFERENCES tasks(id);
ALTER TABLE agent_messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent' CHECK(origin IN ('owner','agent'));
ALTER TABLE agent_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'update' CHECK(kind IN ('handoff','update','question'));
ALTER TABLE agent_messages ADD COLUMN idempotency_key TEXT;
ALTER TABLE agent_messages ADD COLUMN payload_hash TEXT;
ALTER TABLE agent_messages ADD COLUMN read_at INTEGER;
CREATE UNIQUE INDEX collaboration_message_once ON agent_messages(source_task_id,origin,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX collaboration_inbox ON agent_messages(recipient,created_at,id);
CREATE TABLE collaboration_publications (
 id TEXT PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
 version_id TEXT NOT NULL REFERENCES artifact_versions(id), created_at INTEGER NOT NULL, read_at INTEGER,
 UNIQUE(recipient_agent_id,event_id), UNIQUE(recipient_agent_id,version_id)
) STRICT;
CREATE INDEX collaboration_publication_inbox ON collaboration_publications(recipient_agent_id,created_at,id);
CREATE TABLE collaboration_consumptions (
 task_id TEXT NOT NULL REFERENCES tasks(id), version_id TEXT NOT NULL REFERENCES artifact_versions(id),
 run_id TEXT REFERENCES runs(id), created_at INTEGER NOT NULL, PRIMARY KEY(task_id,version_id)
) STRICT;
CREATE TABLE collaboration_dependency_status (
 task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(task_id,depends_on_task_id), FOREIGN KEY(task_id,depends_on_task_id) REFERENCES task_dependencies(task_id,depends_on_task_id) ON DELETE CASCADE
) STRICT;
`;

export class Persistence {
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly db: DatabaseSync;

  constructor(dataRoot: string, now: number) {
    const selected = resolve(dataRoot);
    mkdirSync(selected, { recursive: true, mode: 0o700 });
    this.dataRoot = realpathSync(selected);
    let incompleteRecovery = false;
    try { lstatSync(join(this.dataRoot, '.recovery-incomplete')); incompleteRecovery = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (incompleteRecovery) throw new Error('This recovery did not finish. Choose a complete data root or restore the backup into a new location.');
    for (const name of ['control', 'private', 'artifacts', 'staging', 'backups']) privateDirectory(join(this.dataRoot, name));
    this.databasePath = join(this.dataRoot, 'control', 'agent-workspaces.sqlite');
    if (existsSync(this.databasePath) && (!lstatSync(this.databasePath).isFile() || lstatSync(this.databasePath).isSymbolicLink())) {
      throw new Error('The coordinator database must be a regular local file.');
    }
    this.db = new DatabaseSync(this.databasePath);
    chmodSync(this.databasePath, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    try {
      this.transaction(() => {
        const current = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
        if (current > SCHEMA_VERSION) throw new Error('This database was created by a newer application.');
        if (current === 0) {
          this.db.exec(migration);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(1, now);
          this.db.exec('PRAGMA user_version=1');
        }
        if (current < 2) {
          this.db.exec(artifactMigration);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(2, now);
          this.db.exec('PRAGMA user_version=2');
        }
        if (current < 3) {
          this.db.exec(`
            ALTER TABLE browser_sessions ADD COLUMN task_id TEXT REFERENCES tasks(id);
            ALTER TABLE browser_sessions ADD COLUMN selected_tab_id TEXT;
            ALTER TABLE browser_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE browser_sessions ADD COLUMN profile_saved_at INTEGER;
            ALTER TABLE browser_sessions ADD COLUMN last_error TEXT;
            ALTER TABLE browser_sessions ADD COLUMN owner_instance TEXT;
            ALTER TABLE browser_sessions ADD COLUMN owner_pid INTEGER;
            CREATE TABLE browser_downloads (
              id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES browser_sessions(id),
              task_id TEXT NOT NULL REFERENCES tasks(id), tab_id TEXT NOT NULL,
              name TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('pending','ready','saving','saved','failed')),
              version_id TEXT REFERENCES artifact_versions(id), created_at INTEGER NOT NULL,
              PRIMARY KEY(session_id,id)
            ) STRICT;
            CREATE TABLE browser_tool_calls (
              id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES browser_sessions(id),
              task_id TEXT REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
              generation INTEGER NOT NULL, method TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('dispatched','succeeded','failed','outcome_unknown')),
              created_at INTEGER NOT NULL, finished_at INTEGER
            ) STRICT;
            CREATE UNIQUE INDEX browser_download_import_once ON artifact_versions(json_extract(provenance,'$.browserDownloadKey')) WHERE json_extract(provenance,'$.browserDownloadKey') IS NOT NULL;
          `);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(3, now);
          this.db.exec('PRAGMA user_version=3');
        }
        if (current < 4) {
          this.db.exec(codeMigration);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(4, now);
          this.db.exec('PRAGMA user_version=4');
        }
        if (current < 5) {
          this.db.exec(requestMigration);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(5, now);
          this.db.exec('PRAGMA user_version=5');
        }
        if(current<6){
          this.db.exec(`CREATE TABLE gmail_connection_requests (
            request_id TEXT PRIMARY KEY REFERENCES input_requests(id), account TEXT NOT NULL
          ) STRICT;`);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(6,now);
          this.db.exec('PRAGMA user_version=6');
        }
        if(current<7){
          this.db.exec(collaborationMigration);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(7,now);
          this.db.exec('PRAGMA user_version=7');
        }
        if(current<8){
          this.db.exec(`
            ALTER TABLE task_messages ADD COLUMN delivery_state TEXT CHECK(delivery_state IN ('pending','incorporated'));
            ALTER TABLE task_messages ADD COLUMN incorporated_at INTEGER;
            CREATE INDEX task_message_delivery ON task_messages(task_id,delivery_state,created_at,id);
            CREATE TABLE saved_workflows (
              id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
              category TEXT NOT NULL CHECK(category IN ('business','developer','personal')),
              draft_json TEXT NOT NULL, created_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE workflow_receipts (
              idempotency_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('create','save')),
              request_hash TEXT NOT NULL, result_id TEXT NOT NULL, created_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE workflow_task_origins (
              task_id TEXT PRIMARY KEY REFERENCES tasks(id), workflow_id TEXT NOT NULL,
              title TEXT NOT NULL, created_at INTEGER NOT NULL
            ) STRICT;
          `);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(8,now);
          this.db.exec('PRAGMA user_version=8');
        }
        if(current<9){
          this.db.exec(RESULTS_MIGRATION);
          this.db.exec(`
            ALTER TABLE saved_workflows ADD COLUMN definition_json TEXT;
            ALTER TABLE workflow_task_origins ADD COLUMN definition_json TEXT;
            CREATE TABLE workflow_input_assignments (
              task_id TEXT NOT NULL REFERENCES tasks(id), slot_key TEXT NOT NULL,
              version_id TEXT NOT NULL REFERENCES artifact_versions(id), assigned_at INTEGER NOT NULL,
              PRIMARY KEY(task_id,slot_key)
            ) STRICT;
          `);
          this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(9,now);
          this.db.exec('PRAGMA user_version=9');
        }
        if(current<10){this.db.exec(ROUTINES_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(10,now);this.db.exec('PRAGMA user_version=10');}
        if(current<11){this.db.exec(PROJECTS_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(11,now);this.db.exec('PRAGMA user_version=11');}
        if(current<12){this.db.exec(BROWSER_ACTIONS_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(12,now);this.db.exec('PRAGMA user_version=12');}
        if(current<13){this.db.exec(ROUTINE_CLAIMS_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(13,now);this.db.exec('PRAGMA user_version=13');}
        if(current<14){this.db.exec(TASK_RECOVERY_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(14,now);this.db.exec('PRAGMA user_version=14');}
        if(current<15){this.db.exec(ROUTINE_ALERTS_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(15,now);this.db.exec('PRAGMA user_version=15');}
        if(current<16){this.db.exec(SECURITY_REVIEW_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(16,now);this.db.exec('PRAGMA user_version=16');}
        if(current<17){this.db.exec(FLEET_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(17,now);this.db.exec('PRAGMA user_version=17');}
        if(current<18){this.db.exec(FLEET_LAB_MIGRATION);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(18,now);this.db.exec('PRAGMA user_version=18');}
        if(current<19){this.db.exec(`CREATE TABLE IF NOT EXISTS fleet_followups(fleet_id TEXT PRIMARY KEY REFERENCES fleet_runs(id),source_fleet_id TEXT NOT NULL REFERENCES fleet_runs(id),source_revision INTEGER NOT NULL,source_final_version_id TEXT REFERENCES artifact_versions(id));CREATE TABLE IF NOT EXISTS fleet_message_links(message_id TEXT PRIMARY KEY REFERENCES fleet_messages(id),reply_to_message_id TEXT NOT NULL REFERENCES fleet_messages(id));`);this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(19,now);}if(current<20){this.db.exec('CREATE TABLE IF NOT EXISTS fleet_source_manifests(fleet_id TEXT PRIMARY KEY REFERENCES fleet_runs(id),manifest_json TEXT NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL)');this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(20,now);}if(current<21){this.db.exec('CREATE TABLE IF NOT EXISTS task_archives(task_id TEXT PRIMARY KEY REFERENCES tasks(id),archived_at INTEGER NOT NULL)');this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(21,now);}if(current<22){this.db.exec('CREATE TABLE IF NOT EXISTS agent_archives(agent_id TEXT PRIMARY KEY REFERENCES agents(id),archived_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS fleet_archives(fleet_id TEXT PRIMARY KEY REFERENCES fleet_runs(id),archived_at INTEGER NOT NULL)');this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(22,now);}if(current<23){this.db.exec("ALTER TABLE code_executions ADD COLUMN cleanup_state TEXT NOT NULL DEFAULT 'resolved' CHECK(cleanup_state IN ('pending','resolved'));UPDATE code_executions SET cleanup_state='pending' WHERE reason='cleanup_failed' OR lifecycle IN ('preparing','running','exporting','stopping')");this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(23,now);}if(current<24){this.db.exec('CREATE TABLE repository_snapshot_receipts(preview_id TEXT PRIMARY KEY,identity TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id),agent_id TEXT NOT NULL REFERENCES agents(id),private_version_id TEXT REFERENCES artifact_versions(id),version_id TEXT REFERENCES artifact_versions(id))');this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(24,now);}this.db.exec('PRAGMA user_version=24');
      });
    } catch (error) { this.db.close(); throw error; }
  }

  /** Prefer for new callers: rejects statically inferred promises and detects thenables at runtime.
   * No signature can cancel external work already started by a callback. */
  transactionSync<T>(callback:()=>T extends PromiseLike<unknown>?never:T):T{return this.transaction(callback) as T;}
  readTransactionSync<T>(callback:()=>T extends PromiseLike<unknown>?never:T):T{return this.readTransaction(callback) as T;}

  transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); if(result && (typeof result==='object'||typeof result==='function') && typeof (result as {then?:unknown}).then==='function') throw new Error('Transaction callbacks must be synchronous; already-started external work cannot be cancelled.'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  readTransaction<T>(callback: () => T): T {
    this.db.exec('BEGIN');
    try { const result = callback(); if(result && (typeof result==='object'||typeof result==='function') && typeof (result as {then?:unknown}).then==='function') throw new Error('Transaction callbacks must be synchronous; already-started external work cannot be cancelled.'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void { this.db.close(); }
}
