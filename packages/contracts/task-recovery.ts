export const TASK_RECOVERY_CHANNEL = 'agent-workspaces:task-recovery';
export interface TaskRecoveryIncident {
  id: string; taskId: string; runId: string; operation: 'browser_read';
  code: string; state: 'waiting' | 'retrying' | 'recovered' | 'exhausted' | 'cancelled' | 'interrupted';
  attempts: number; nextAttemptAt: number | null; createdAt: number; updatedAt: number; acknowledged: boolean;
  message: string;
}
export interface TaskRecoveryState { incidents: TaskRecoveryIncident[]; page?:{hasMore:boolean;beforeIncidentId:string|null}; needsAttention: number; maxRetriesPerIncident: number; maxRetriesPerTask: number }
export type TaskRecoveryCommand = {type: 'taskRecovery.state';beforeIncidentId?:string;incidentId?:string} | {type: 'taskRecovery.acknowledge'; id: string};
export interface TaskRecoveryBridge {taskRecovery(command: TaskRecoveryCommand): Promise<TaskRecoveryState>}
