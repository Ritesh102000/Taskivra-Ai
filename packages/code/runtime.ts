import type { CodeRuntimeStatus } from '../contracts/code';

/** Host-only manifests. Neither renderer commands nor payload logs can supply these paths. */
export interface CodeSeedFile {
  area: 'workspace' | 'shared'; path: string; sourcePath: string; bytes: number; sha256: string;
}
export interface CodeExportFile { path: string; sourcePath: string; bytes: number; sha256: string }
export interface CodeResourceLimits {
  memoryMiB: number; workspaceMiB: number; tmpMiB: number; pids: number;
  timeoutSeconds: number; logBytes: number; exportBytes: number; files: number;
}
export interface CodeOutcome {
  exitCode: number | null; reason: 'exited' | 'timeout' | 'log_limit' | 'oom' | 'stopped' | 'runtime_lost';
  startedAt: number; finishedAt: number; durationMs: number;
  logsTruncated: boolean;
}
export interface CodeHandle {
  readonly info: { containerId: string; imageDigest: string };
  run(options: { argv: string[]; cwd: '/workspace'; signal: AbortSignal; onLog: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void }): Promise<CodeOutcome>;
  export(options: { destination: string; signal: AbortSignal }): Promise<CodeExportFile[]>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export interface CodeRuntime {
  status(): Promise<CodeRuntimeStatus>;
  launch(options: { executionId: string; agentId: string; taskId: string; files: CodeSeedFile[]; limits: CodeResourceLimits; signal: AbortSignal }): Promise<CodeHandle>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}
export const DEFAULT_CODE_RESOURCES: CodeResourceLimits = {
  memoryMiB: 1024, workspaceMiB: 512, tmpMiB: 128, pids: 256,
  timeoutSeconds: 120, logBytes: 1024 * 1024, exportBytes: 512 * 1024 * 1024, files: 4096,
};
export const unavailableCodeRuntime: CodeRuntime = {
  async status() { return { ready: false, message: 'Start Docker Desktop and prepare the code runtime images.', imageDigest: null, packages: [] }; },
  async launch() { throw new Error('runtime_unavailable'); },
  async reconcile() {}, async close() {},
};
