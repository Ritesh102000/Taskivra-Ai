/** Portable data only. Browser profiles, cookies, Keychain and runtime journals are excluded. */
export interface RecoveryEntry {
  path: string;
  bytes: number;
  sha256: string;
  kind: 'database' | 'artifact' | 'workspace' | 'configuration';
}
export interface RecoveryManifest {
  format: 'agent-workspaces-backup';
  version: 1;
  id: string;
  appVersion: string;
  schemaVersion: number;
  createdAt: number;
  files: RecoveryEntry[];
  totalBytes: number;
  exclusions: string[];
}
export interface RecoveryBackupResult {
  directory: string;
  manifest: RecoveryManifest;
}
export interface RecoveryRestoreResult {
  dataRoot: string;
  backupId: string;
  restoredFiles: number;
  pausedTasks: number;
  requiresReview: true;
}
