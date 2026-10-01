export const SECURITY_REVIEW_MIGRATION=`
CREATE TABLE security_review_teams (
 id TEXT PRIMARY KEY,title TEXT NOT NULL,scope TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id),
 source_version_ids TEXT NOT NULL,created_at INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL
) STRICT;
CREATE TABLE security_review_members (
 team_id TEXT NOT NULL REFERENCES security_review_teams(id),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
 role TEXT NOT NULL CHECK(role IN ('code_review','evidence_review','synthesis')),agent_id TEXT NOT NULL REFERENCES agents(id),
 task_id TEXT UNIQUE REFERENCES tasks(id),model TEXT NOT NULL,limits_json TEXT NOT NULL,input_version_ids TEXT NOT NULL DEFAULT '[]',
 preparation TEXT NOT NULL CHECK(preparation IN ('waiting_handoff','preparing','ready','failed')),error TEXT,
 PRIMARY KEY(team_id,ordinal),UNIQUE(team_id,role),UNIQUE(team_id,agent_id)
) STRICT;
CREATE TABLE security_review_handoffs (
 id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES security_review_teams(id),from_task_id TEXT NOT NULL REFERENCES tasks(id),
 to_task_id TEXT NOT NULL REFERENCES tasks(id),source_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
 published_version_id TEXT REFERENCES artifact_versions(id),state TEXT NOT NULL CHECK(state IN ('preparing','ready','failed')),
 created_at INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
 UNIQUE(team_id,from_task_id),UNIQUE(team_id,to_task_id)
) STRICT;
`;
