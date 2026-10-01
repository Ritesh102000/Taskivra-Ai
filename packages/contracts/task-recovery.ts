export const TASK_RECOVERY_CHANNEL = 'agent-workspaces:task-recovery';
export interface TaskRecoveryIncident {
  id: string; taskId: string; runId: string; operation: 'browser_read';
  code: string; state: 'waiting' | 'retrying' | 'recovered' | 'exhausted' | 'cancelled' | 'interrupted';
  attempts: number; nextAttemptAt: number | null; createdAt: number; updatedAt: number; acknowledged: boolean;
  message: string;
}
export interface TaskRecoveryState { incidents: TaskRecoveryIncident[]; needsAttention: number; maxRetriesPerIncident: number; maxRetriesPerTask: number }
export type TaskRecoveryCommand = {type: 'taskRecovery.state'} | {type: 'taskRecovery.acknowledge'; id: string};
export interface TaskRecoveryBridge {taskRecovery(command: TaskRecoveryCommand): Promise<TaskRecoveryState>}
