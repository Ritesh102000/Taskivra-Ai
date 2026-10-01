/** Include in the next coordinator-owned schema migration, never run ad hoc in a renderer. */
export const RESULTS_MIGRATION = `
CREATE TABLE result_reviews (
 task_id TEXT NOT NULL REFERENCES tasks(id), version_id TEXT NOT NULL REFERENCES artifact_versions(id),
 state TEXT NOT NULL CHECK(state IN ('accepted','changes_requested')),
 revision INTEGER NOT NULL CHECK(revision>0), feedback TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
 PRIMARY KEY(task_id,version_id)
) STRICT;
CREATE TABLE result_revision_jobs (
 id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL REFERENCES tasks(id),
 source_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
 task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), input_version_ids TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('preparing','ready','failed')), error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE result_actions (
 idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id), version_id TEXT NOT NULL REFERENCES artifact_versions(id),
 revision_job_id TEXT REFERENCES result_revision_jobs(id), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX result_revision_source ON result_revision_jobs(source_task_id,source_version_id,created_at);
`;
