import type { LiveLimits, LivePolicy } from './live';
import type { FileSlotSpec } from './requests';
import type { ReadinessCapability } from './readiness';

export type WorkflowCategory = 'business' | 'developer' | 'personal';
export interface WorkflowInput {
  id: string;
  label: string;
  kind: 'text' | 'multiline' | 'websites' | 'email';
  placeholder?: string;
  required: boolean;
  defaultValue?: string;
}
export interface WorkflowDraft {
  objective: string;
  completionCriteria: string;
  policy: LivePolicy;
}
/** Immutable, content-addressed procedure. It carries requirements, never access grants. */
export interface WorkflowProcedure {
  schemaVersion: 1;
  versionId: string;
  inputs: WorkflowInput[];
  objectiveTemplate: string;
  completionTemplate: string;
  mode: LivePolicy['mode'];
  sourcesField?: string;
  accountField?: string;
  fileSlots: FileSlotSpec[];
  requiredCapabilities: Exclude<ReadinessCapability, 'model' | 'inputs'>[];
  output: { format?: 'markdown'; filename: string; sections: string[] };
  example: { label: string; inputs: Record<string, string>; output: string };
}
export interface WorkflowDefinition {
  id: string;
  source: 'builtin' | 'saved';
  title: string;
  description: string;
  category: WorkflowCategory;
  outcome: string;
  tools: string[];
  inputs: WorkflowInput[];
  savedDraft?: WorkflowDraft;
  createdAt?: number;
  procedure?: WorkflowProcedure;
}
export interface WorkflowState {
  recipes: WorkflowDefinition[];
  saved: WorkflowDefinition[];
  prepared?: WorkflowDraft;
  createdTaskId?: string;
  assignedTaskId?: string;
  parameterizedTaskIds?: string[];
}
export type WorkflowCommand =
  | { type: 'workflows.state' }
  | { type: 'workflows.preview'; workflowId: string; values: Record<string, string> }
  | { type: 'workflows.createTask'; workflowId: string; values: Record<string, string>; agentId: string; model: string; limits: LiveLimits; idempotencyKey: string; mailDetail?: boolean }
  | { type: 'workflows.saveFromTask'; taskId: string; title: string; description: string; category: WorkflowCategory; idempotencyKey: string; parameterized?: boolean }
  | { type: 'workflows.assignInputs'; taskId: string; assignments: { slotKey: string; versionId: string }[] }
  | { type: 'workflows.delete'; workflowId: string };
export const WORKFLOWS_CHANNEL = 'agent-workspaces:workflows';
