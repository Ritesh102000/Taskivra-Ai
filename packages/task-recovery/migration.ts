export const TASK_RECOVERY_MIGRATION = `
CREATE TABLE task_recovery_incidents (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation='browser_read'), code TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('waiting','retrying','recovered','exhausted','cancelled','interrupted')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2), next_attempt_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, owner_pid INTEGER NOT NULL,
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1))
) STRICT;
CREATE INDEX task_recovery_task ON task_recovery_incidents(task_id,created_at);
`;
