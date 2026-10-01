export interface ProjectSpace {
  id: string; name: string; description: string; createdAt: number; updatedAt: number;
  agentIds: string[]; taskIds: string[]; artifactIds: string[];
  brief: ProjectBrief | null; gmailAccount: string | null; googleWorkspaceAccount: string | null;
}
export interface ProjectBrief {
  id: string; projectId: string; revision: number; content: string;
  knowledgeVersionIds: string[]; createdAt: number;
}
export interface ProjectsState { projects: ProjectSpace[]; defaultProjectId: string; verifiedAccounts: { gmail: string | null; googleWorkspace: string | null } }
export type ProjectCommand =
  | { type: 'projects.state' }
  | { type: 'projects.create'; name: string; description: string }
  | { type: 'projects.agent.create'; projectId: string; name: string; instructions: string }
  | { type: 'projects.brief.save'; projectId: string; expectedRevision: number; content: string; knowledgeVersionIds: string[] }
  | { type: 'projects.gmail.bind'; projectId: string; account: string | null }
  | { type: 'projects.google_workspace.bind'; projectId: string; account: string | null };
export const PROJECTS_CHANNEL = 'agent-workspaces:projects';
