export const DEFAULT_PROJECT_ID = 'personal-workspace';
/** Source-of-truth labels plus database guards; UI filtering is never the access boundary. */
export const PROJECTS_MIGRATION = `
CREATE TABLE projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO projects VALUES ('personal-workspace','Personal workspace','Existing agents, tasks and files.',0,0);
CREATE TABLE project_agents (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id), project_id TEXT NOT NULL REFERENCES projects(id)
) STRICT;
CREATE INDEX project_agent_members ON project_agents(project_id,agent_id);
INSERT INTO project_agents SELECT id,'personal-workspace' FROM agents;
CREATE TABLE project_artifacts (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id), project_id TEXT NOT NULL REFERENCES projects(id)
) STRICT;
CREATE INDEX project_artifact_members ON project_artifacts(project_id,artifact_id);
INSERT INTO project_artifacts SELECT id,'personal-workspace' FROM artifacts;
CREATE TABLE project_briefs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL CHECK(revision>0),
 content TEXT NOT NULL, knowledge_version_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, UNIQUE(project_id,revision)
) STRICT;
CREATE TABLE project_gmail_accounts (
 project_id TEXT PRIMARY KEY REFERENCES projects(id), account TEXT NOT NULL, bound_at INTEGER NOT NULL
) STRICT;
CREATE TABLE project_google_workspace_accounts (
 project_id TEXT PRIMARY KEY REFERENCES projects(id), account TEXT NOT NULL, bound_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER project_agent_created AFTER INSERT ON agents BEGIN
 INSERT INTO project_agents VALUES(NEW.id,'personal-workspace');
END;
CREATE TRIGGER project_agent_move BEFORE UPDATE ON project_agents WHEN NEW.project_id!=OLD.project_id BEGIN
 SELECT RAISE(ABORT,'project_agent_immutable') WHERE
 EXISTS(SELECT 1 FROM tasks WHERE agent_id=OLD.agent_id) OR
 EXISTS(SELECT 1 FROM artifacts WHERE owner_agent_id=OLD.agent_id) OR
 EXISTS(SELECT 1 FROM browser_sessions WHERE agent_id=OLD.agent_id AND (profile_ref IS NOT NULL OR controller!='none' OR lifecycle!='not_provisioned'));
END;
CREATE TRIGGER project_agent_identity BEFORE UPDATE OF agent_id ON project_agents BEGIN SELECT RAISE(ABORT,'project_agent_immutable'); END;
CREATE TRIGGER project_agent_remove BEFORE DELETE ON project_agents BEGIN SELECT RAISE(ABORT,'project_agent_immutable'); END;
CREATE TRIGGER project_task_owner BEFORE UPDATE OF agent_id ON tasks WHEN NEW.agent_id!=OLD.agent_id BEGIN SELECT RAISE(ABORT,'project_task_immutable'); END;
CREATE TRIGGER project_artifact_created AFTER INSERT ON artifacts BEGIN
 INSERT INTO project_artifacts VALUES(NEW.id,COALESCE(
 (SELECT project_id FROM project_artifacts WHERE artifact_id=NEW.published_from_artifact_id),
 (SELECT project_id FROM project_agents WHERE agent_id=NEW.owner_agent_id),
 (SELECT p.project_id FROM tasks t JOIN project_agents p ON p.agent_id=t.agent_id WHERE t.id=NEW.producer_task_id),
 'personal-workspace'));
END;
CREATE TRIGGER project_artifact_owner BEFORE INSERT ON artifacts WHEN NEW.owner_agent_id IS NOT NULL AND NEW.producer_task_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM project_agents a JOIN tasks t ON t.id=NEW.producer_task_id JOIN project_agents b ON b.agent_id=t.agent_id WHERE a.agent_id=NEW.owner_agent_id AND a.project_id=b.project_id);
END;
CREATE TRIGGER project_artifact_identity BEFORE UPDATE OF owner_agent_id,producer_task_id,published_from_artifact_id ON artifacts
 WHEN NEW.owner_agent_id IS NOT OLD.owner_agent_id OR NEW.producer_task_id IS NOT OLD.producer_task_id OR NEW.published_from_artifact_id IS NOT OLD.published_from_artifact_id BEGIN SELECT RAISE(ABORT,'project_artifact_immutable'); END;
CREATE TRIGGER project_artifact_move BEFORE UPDATE ON project_artifacts BEGIN SELECT RAISE(ABORT,'project_artifact_immutable'); END;
CREATE TRIGGER project_artifact_remove BEFORE DELETE ON project_artifacts BEGIN SELECT RAISE(ABORT,'project_artifact_immutable'); END;
CREATE TRIGGER project_version_source BEFORE INSERT ON artifact_versions WHEN NEW.source_version_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM project_artifacts a JOIN artifact_versions v ON v.id=NEW.source_version_id JOIN project_artifacts b ON b.artifact_id=v.artifact_id WHERE a.artifact_id=NEW.artifact_id AND a.project_id=b.project_id);
END;
CREATE TRIGGER project_task_artifact BEFORE INSERT ON task_artifacts BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN project_agents a ON a.agent_id=t.agent_id JOIN artifact_versions v ON v.id=NEW.version_id JOIN project_artifacts b ON b.artifact_id=v.artifact_id WHERE t.id=NEW.task_id AND a.project_id=b.project_id);
END;
CREATE TRIGGER project_task_artifact_update BEFORE UPDATE OF task_id,version_id ON task_artifacts BEGIN SELECT RAISE(ABORT,'project_binding_immutable'); END;
CREATE TRIGGER project_run_artifact BEFORE INSERT ON run_artifact_bindings BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM runs r JOIN project_agents a ON a.agent_id=r.agent_id JOIN artifact_versions v ON v.id=NEW.version_id JOIN project_artifacts b ON b.artifact_id=v.artifact_id WHERE r.id=NEW.run_id AND a.project_id=b.project_id);
END;
CREATE TRIGGER project_run_artifact_update BEFORE UPDATE ON run_artifact_bindings BEGIN SELECT RAISE(ABORT,'project_binding_immutable'); END;
CREATE TRIGGER project_pending_artifact BEFORE INSERT ON task_artifact_deliveries BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN project_agents a ON a.agent_id=t.agent_id JOIN artifact_versions v ON v.id=NEW.version_id JOIN project_artifacts b ON b.artifact_id=v.artifact_id WHERE t.id=NEW.task_id AND a.project_id=b.project_id);
END;
CREATE TRIGGER project_pending_artifact_update BEFORE UPDATE OF task_id,version_id ON task_artifact_deliveries BEGIN SELECT RAISE(ABORT,'project_binding_immutable'); END;
CREATE TRIGGER project_dependency BEFORE INSERT ON task_dependencies BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN project_agents a ON a.agent_id=t.agent_id JOIN tasks u ON u.id=NEW.depends_on_task_id JOIN project_agents b ON b.agent_id=u.agent_id WHERE t.id=NEW.task_id AND a.project_id=b.project_id);
END;
CREATE TRIGGER project_message BEFORE INSERT ON agent_messages BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM project_agents a JOIN project_agents b ON b.agent_id=NEW.recipient WHERE a.agent_id=NEW.sender AND a.project_id=b.project_id);
 SELECT RAISE(ABORT,'project_boundary') WHERE EXISTS(SELECT 1 FROM json_each(NEW.task_refs) j LEFT JOIN tasks t ON t.id=j.value LEFT JOIN project_agents a ON a.agent_id=t.agent_id WHERE a.project_id IS NOT (SELECT project_id FROM project_agents WHERE agent_id=NEW.sender));
 SELECT RAISE(ABORT,'project_boundary') WHERE EXISTS(SELECT 1 FROM json_each(NEW.artifact_refs) j LEFT JOIN artifact_versions v ON v.id=j.value LEFT JOIN project_artifacts a ON a.artifact_id=v.artifact_id WHERE a.project_id IS NOT (SELECT project_id FROM project_agents WHERE agent_id=NEW.sender));
END;
CREATE TRIGGER project_publication BEFORE INSERT ON collaboration_publications BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM project_agents a JOIN artifact_versions v ON v.id=NEW.version_id JOIN project_artifacts b ON b.artifact_id=v.artifact_id WHERE a.agent_id=NEW.recipient_agent_id AND a.project_id=b.project_id);
END;
CREATE TRIGGER project_grant BEFORE INSERT ON artifact_grants WHEN NEW.permitted_agent_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'project_boundary') WHERE NOT EXISTS(SELECT 1 FROM project_agents a JOIN project_artifacts b ON b.artifact_id=NEW.artifact_id WHERE a.agent_id=NEW.permitted_agent_id AND a.project_id=b.project_id);
END;
CREATE TRIGGER project_brief_update BEFORE UPDATE ON project_briefs BEGIN SELECT RAISE(ABORT,'project_brief_immutable'); END;
`;
