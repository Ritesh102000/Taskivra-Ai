export const ROUTINES_MIGRATION=`
CREATE TABLE routines (
 id TEXT PRIMARY KEY,title TEXT NOT NULL,source_task_id TEXT NOT NULL REFERENCES tasks(id),agent_id TEXT NOT NULL REFERENCES agents(id),
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),timing_json TEXT NOT NULL,next_run INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 monthly_cap_microusd INTEGER NOT NULL,definition_json TEXT NOT NULL,last_error TEXT,created_at INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL
) STRICT;
CREATE TABLE routine_occurrences (
 id TEXT PRIMARY KEY,routine_id TEXT NOT NULL REFERENCES routines(id),local_day TEXT NOT NULL,due_at INTEGER NOT NULL,
 task_id TEXT UNIQUE REFERENCES tasks(id),state TEXT NOT NULL,reason TEXT,reserved_microusd INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
 UNIQUE(routine_id,local_day)
) STRICT;
CREATE TABLE notice_settings (id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,quiet_start INTEGER NOT NULL DEFAULT 22,quiet_end INTEGER NOT NULL DEFAULT 8,timezone TEXT NOT NULL DEFAULT 'UTC',event_cursor INTEGER NOT NULL DEFAULT 0) STRICT;
INSERT INTO notice_settings(id,event_cursor) SELECT 1,COALESCE(MAX(id),0) FROM events;
CREATE TABLE owner_notices (id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER UNIQUE NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,created_at INTEGER NOT NULL,seen INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0) STRICT;
`;
export const ROUTINE_CLAIMS_MIGRATION=`
CREATE TABLE routine_preparation_claims (
 occurrence_id TEXT PRIMARY KEY REFERENCES routine_occurrences(id), owner_id TEXT NOT NULL,
 owner_pid INTEGER NOT NULL, lease_until INTEGER NOT NULL
) STRICT;
`;
export const ROUTINE_ALERTS_MIGRATION=`
CREATE TABLE routine_alert_settings (
 routine_id TEXT PRIMARY KEY REFERENCES routines(id), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), enabled_since INTEGER NOT NULL
) STRICT;
CREATE TABLE routine_result_comparisons (
 task_id TEXT NOT NULL REFERENCES tasks(id), version_id TEXT NOT NULL REFERENCES artifact_versions(id),
 routine_id TEXT NOT NULL REFERENCES routines(id), baseline_task_id TEXT NOT NULL REFERENCES tasks(id),
 baseline_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
 state TEXT NOT NULL CHECK(state IN ('changed','unchanged','unavailable')), message TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(task_id,version_id)
) STRICT;
CREATE TABLE routine_change_alerts (
 id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 version_id TEXT NOT NULL REFERENCES artifact_versions(id), baseline_task_id TEXT NOT NULL REFERENCES tasks(id),
 baseline_version_id TEXT NOT NULL REFERENCES artifact_versions(id), normalized_hash TEXT NOT NULL,
 change_json TEXT NOT NULL, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0 CHECK(seen IN (0,1)),
 UNIQUE(routine_id,baseline_version_id,normalized_hash)
) STRICT;
CREATE INDEX routine_change_alerts_attention ON routine_change_alerts(seen,created_at);
`;
