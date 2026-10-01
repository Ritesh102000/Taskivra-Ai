/** Read-only readiness checks never call a model, open a browser, or change access. */
export type ReadinessCapability = 'model' | 'browser' | 'code' | 'gmail' | 'google_workspace' | 'documents' | 'inputs';
export type ReadinessStatus = 'verified' | 'configured' | 'not_tested' | 'needs_setup' | 'needs_input' | 'checking' | 'unavailable';
export type ReadinessAction = 'settings' | 'browser' | 'files' | 'runtime' | 'projects';
export type ReadinessTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'workflow'; workflowId: string; values: Record<string, string>; agentId?: string; model: string };
export interface ReadinessItem {
  id: ReadinessCapability;
  label: string;
  status: ReadinessStatus;
  blocking: boolean;
  detail: string;
  action?: ReadinessAction;
  actionLabel?: string;
  checkedAt: number;
}
export interface WorkflowInputCheck {
  slotKey: string;
  label: string;
  required: boolean;
  versionId: string | null;
  status: 'accepted' | 'missing' | 'rejected' | 'unavailable';
  detail: string;
}
export interface ReadinessState {
  outcome: string;
  status: 'ready' | 'ready_with_limits' | 'needs_attention';
  checks: ReadinessItem[];
  inputSlots: WorkflowInputCheck[];
  checkedAt: number;
  paidProbePerformed: false;
  notes: string[];
}
export type ReadinessCommand = { type: 'readiness.check'; target: ReadinessTarget };
export const READINESS_CHANNEL = 'agent-workspaces:readiness';
