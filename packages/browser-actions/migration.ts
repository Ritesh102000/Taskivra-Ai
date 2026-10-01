export const BROWSER_ACTIONS_MIGRATION = `
CREATE TABLE browser_action_proposals (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(id),
 session_id TEXT NOT NULL REFERENCES browser_sessions(id), generation INTEGER NOT NULL, tab_id TEXT NOT NULL,
 page_revision INTEGER NOT NULL, url TEXT NOT NULL, target_json TEXT NOT NULL, action_json TEXT NOT NULL,
 reason TEXT NOT NULL, expected_effect TEXT NOT NULL, authority_hash TEXT NOT NULL,
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','declined','stale','dispatching','completed','outcome_unknown')),
 account_confirmation TEXT, error TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 dispatch_run_id TEXT REFERENCES runs(id), resolution_json TEXT, UNIQUE(task_id,request_key)
) STRICT;
CREATE INDEX browser_action_task ON browser_action_proposals(task_id,state,created_at);
`;
