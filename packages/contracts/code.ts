export type CodeLanguage = 'python' | 'node' | 'shell';
export type CodeLifecycle = 'preparing' | 'running' | 'exporting' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface CodeExecution {
  cleanupState?: 'pending' | 'resolved';
  id: string; taskId: string; agentId: string; origin: 'owner' | 'agent';
  runtime: CodeLanguage; source: string; command: string; cwd: '/workspace';
  lifecycle: CodeLifecycle; imageDigest: string | null; timeoutSeconds: number;
  startedAt: number; finishedAt: number | null; durationMs: number | null;
  exitCode: number | null; error: string | null; reason: string | null;
  stdout: string; stderr: string; logsTruncated: boolean; inputs: CodeInput[];
  workspaceCommitted: boolean; workspaceRevision: number | null; outputVersionIds: string[];
}
export interface CodeInput {
  versionId: string; displayName: string; containerPath: string; bytes: number;
  visibility: 'private' | 'shared';
}
export interface CodeRuntimeStatus {
  ready: boolean; message: string | null;
  imageDigest: string | null;
  packages: { runtime: 'python' | 'node'; name: string; version: string }[];
}
export interface CodeDependency {
  requestId: string; revision: number; runtime: 'python' | 'node';
  packageName: string; version: string | null; reason: string;
  state: 'open' | 'fulfilled' | 'cancelled';
}
export interface CodeState {
  taskId: string; agentId: string; executions: CodeExecution[]; inputs: CodeInput[];
  workspaceRevision: number; activeExecutionId: string | null;
  workspaceChangesError?:string;
  workspaceChanges?:{revision:number;parentRevision:number|null;added:string[];removed:string[];modified:string[]};
  effectiveLimits?:{resources:{memoryMiB:number;workspaceMiB:number;tmpMiB:number;pids:number;timeoutSeconds:number;logBytes:number;exportBytes:number;files:number};sourceBytes:number;storageBudgetBytes:number};
  history?:{beforeExecutionId:string|null;hasMore:boolean};
  runtime: CodeRuntimeStatus; dependencies: CodeDependency[];
}
export type CodeCommand =
  | { type: 'code.state'; taskId: string }
  | { type:'code.history';taskId:string;beforeExecutionId?:string;executionId?:string }
  | { type: 'code.execute'; taskId: string; runtime: CodeLanguage; source: string; timeoutSeconds: number; inputVersionIds: string[] }
  | { type: 'code.stop'; taskId: string; executionId: string }
  | { type: 'code.requestDependency'; taskId: string; runtime: 'python' | 'node'; packageName: string; version: string; reason: string }
  | { type: 'code.resolveDependency'; taskId: string; requestId: string; revision: number };
export const CODE_CHANNEL = 'agent-workspaces:code';
export const CODE_CHANGED_CHANNEL = 'agent-workspaces:code-changed';
export const CODE_LIMITS = {
  sourceBytes: 64 * 1024, timeoutSeconds: 120, logBytes: 1024 * 1024,
  executions: 250, inputs: 128, workspaceBytes: 512 * 1024 * 1024,
  exportFiles: 4096, dependencies: 8,
} as const;
