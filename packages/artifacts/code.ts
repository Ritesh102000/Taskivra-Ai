import type { CodeInput } from '../contracts/code';
import type { CodeExportFile, CodeSeedFile } from '../code/runtime';

/** All callbacks and source paths originate in the trusted coordinator, never IPC payloads. */
export interface CodeWorkspaceOptions {
  taskId: string; agentId: string; executionId: string; versionIds: string[];
  assertCurrent: () => void;
}
export interface CodeWorkspaceReceipt { revisionId: string; revision: number; outputVersionIds: string[] }
export interface CodeWorkspaceLease {
  files: CodeSeedFile[]; inputs: CodeInput[];
  baseRevision: string | null; baseRevisionNumber: number;
  commit(files: CodeExportFile[], options: {
    assertCurrent: () => void;
    /** Called within the artifact metadata transaction; must be synchronous and not start a transaction. */
    onCommit?: (receipt: CodeWorkspaceReceipt) => void;
  }): Promise<CodeWorkspaceReceipt>;
  release(): Promise<void>;
}
export interface CodeWorkspaceFile { path: string; bytes: number; sha256: string }

export function codeWorkspacePath(path: string): string {
  if (typeof path !== 'string' || path.length > 512 || /[\\\x00-\x1f\x7f]/.test(path)) throw new Error('unsafe_workspace_path');
  const parts = path.split('/');
  if (parts.length < 2 || !['inputs', 'work', 'outputs'].includes(parts[0]) || parts.some(p => !p || p === '.' || p === '..')) throw new Error('unsafe_workspace_path');
  return path;
}
