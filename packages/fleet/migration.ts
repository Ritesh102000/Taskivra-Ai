export const FLEET_MIGRATION=`
CREATE TABLE fleet_runs (
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,objective TEXT NOT NULL,
 source_version_ids TEXT NOT NULL,planner_model TEXT NOT NULL,worker_model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('prepared','running','paused','needs_attention','succeeded','stopped')),
 limits_json TEXT NOT NULL,task_limits_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
 final_task_id TEXT REFERENCES tasks(id),final_version_id TEXT REFERENCES artifact_versions(id),problem TEXT
) STRICT;
CREATE TABLE fleet_members (
 id TEXT PRIMARY KEY,fleet_id TEXT NOT NULL REFERENCES fleet_runs(id),agent_id TEXT NOT NULL REFERENCES agents(id),
 role_key TEXT NOT NULL,name TEXT NOT NULL,goal TEXT NOT NULL,model TEXT NOT NULL,is_lead INTEGER NOT NULL CHECK(is_lead IN (0,1)),
 UNIQUE(fleet_id,role_key),UNIQUE(fleet_id,agent_id)
) STRICT;
CREATE UNIQUE INDEX fleet_one_lead ON fleet_members(fleet_id) WHERE is_lead=1;
CREATE TABLE fleet_items (
 id TEXT PRIMARY KEY,fleet_id TEXT NOT NULL REFERENCES fleet_runs(id),item_key TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,
 role_key TEXT NOT NULL,depends_on_ids TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','cancelled')),
 claimed_task_id TEXT UNIQUE REFERENCES tasks(id),output_version_id TEXT REFERENCES artifact_versions(id),published_version_id TEXT REFERENCES artifact_versions(id),
 revision INTEGER NOT NULL,UNIQUE(fleet_id,item_key)
) STRICT;
CREATE TABLE fleet_tasks (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id),fleet_id TEXT NOT NULL REFERENCES fleet_runs(id),member_id TEXT NOT NULL REFERENCES fleet_members(id),
 kind TEXT NOT NULL CHECK(kind IN ('lead','worker')),item_id TEXT UNIQUE REFERENCES fleet_items(id),
 preparation TEXT NOT NULL CHECK(preparation IN ('preparing','ready','failed')),input_version_ids TEXT NOT NULL DEFAULT '[]',error TEXT
) STRICT;
CREATE INDEX fleet_tasks_by_fleet ON fleet_tasks(fleet_id);
CREATE UNIQUE INDEX fleet_one_lead_task ON fleet_tasks(fleet_id) WHERE kind='lead';
CREATE TABLE fleet_messages (
 id TEXT PRIMARY KEY,fleet_id TEXT NOT NULL REFERENCES fleet_runs(id),from_task_id TEXT NOT NULL REFERENCES tasks(id),
 recipient_role_key TEXT,content TEXT NOT NULL,item_ids TEXT NOT NULL,version_ids TEXT NOT NULL,created_at INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,UNIQUE(fleet_id,idempotency_key)
) STRICT;
CREATE TABLE fleet_plan_revisions (
 fleet_id TEXT NOT NULL REFERENCES fleet_runs(id),revision INTEGER NOT NULL,summary TEXT NOT NULL,created_at INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,PRIMARY KEY(fleet_id,revision),UNIQUE(fleet_id,idempotency_key)
) STRICT;
`;

export const FLEET_LAB_MIGRATION=`
ALTER TABLE fleet_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'imported_evidence' CHECK(mode IN ('imported_evidence','local_website'));
ALTER TABLE fleet_runs ADD COLUMN site_url TEXT CHECK((mode='imported_evidence' AND site_url IS NULL) OR (mode='local_website' AND site_url='http://127.0.0.1:4318/'));
`;
