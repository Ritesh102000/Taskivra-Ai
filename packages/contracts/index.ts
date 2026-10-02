import type {RepositorySnapshotCommand,RepositorySnapshotPreview} from './repository-snapshot';
import type {FleetCommand,FleetState} from './fleet';
import type {SecurityReviewCommand,SecurityReviewState} from './security-review';
import type {ModelProviderCommand,ModelProviderState} from './model-providers';
import type {TaskRecoveryCommand,TaskRecoveryState} from './task-recovery';
import type {ReportExportCommand,ReportExportResult} from './results';
import type {GmailReviewCommand,GmailSearchPage,GmailThreadResult,GmailAttachmentReceipt} from './gmail-review';
import type {GoogleWorkspaceCommand,GoogleWorkspaceState,GoogleImportResult} from './google-workspace';
import type {BrowserActionsCommand,BrowserActionsState} from './browser-actions';
import type {RoutineCommand,RoutineState} from './routines';
import type {ProjectCommand,ProjectsState} from './projects';
import type { RecoveryCommand, RecoveryState } from './recovery-ui';
import type { ResultsCommand, ResultsState } from './results';
import type { ReadinessCommand, ReadinessState } from './readiness';
import type { ModelConnectionCommand, ModelConnectionState } from './model-connection';
/** Only owner-app commands cross this bridge. No worker RPC or arbitrary I/O. */
import type { BrowserCommand, BrowserState } from './browser';
import type { CodeCommand, CodeState } from './code';
import type { RequestCommand, UserRequest } from './requests';
import type { LiveCommand, LiveState } from './live';
import type { GmailState } from './gmail';
import type { CollaborationCommand, CollaborationState } from './collaboration';
import type { BrowserSetupCommand, BrowserSetupState } from './browser-setup';
import type { WorkflowCommand, WorkflowState } from './workflows';
export * from './workflows';
export * from './browser';
export * from './code';
export * from './requests';
export * from './live';
export * from './gmail';
export * from './collaboration';
export * from './browser-setup';
export const COLLABORATION_CHANNEL='agent-workspaces:collaboration';
export type TaskState = 'queued' | 'running' | 'waiting' | 'pausing' | 'paused' | 'recovering' | 'succeeded' | 'failed' | 'cancelled';
export type Scenario = 'clarification' | 'complete' | 'failure';
export interface Agent {
  archived?:boolean;
  id: string; name: string; instructions: string; workspaceId: string;
  enabled: boolean; createdAt: number;
}
export interface Task {
  archived?:boolean;
  executionMode: 'simulation'|'live';
  id: string; agentId: string; objective: string; completionCriteria: string;
  state: TaskState; revision: number; waitingReason: string | null;
  scenario: Scenario; checkpoint: number; generation: number;
  createdAt: number; updatedAt: number;
}
export interface TaskMessage {
  id: string; taskId: string; role: 'owner' | 'agent' | 'system';
  content: string; createdAt: number;
  /** Present only for live owner updates. Incorporated means read by a valid model turn. */
  deliveryState?: 'pending' | 'incorporated'; incorporatedAt?: number;
}
export interface InputRequest {
  legacy?: boolean;
  id: string; taskId: string; agentId: string; type: 'files' | 'clarification' | 'browser_handoff' | 'permission_change';
  title: string; reason: string; state: 'open' | 'partial' | 'checking' | 'needs_correction' | 'fulfilled' | 'cancelled' | 'superseded';
  revision: number; response: string | null; createdAt: number;
}
export interface DomainEvent {
  id: number; type: string; aggregateId: string; aggregateRevision: number;
  payload: Record<string, unknown>; createdAt: number;
}
export interface Settings {
  theme: 'system' | 'light' | 'dark';
  driverEnabled: boolean;
  maxActiveAgents: number;
}
export interface Snapshot {
  agents: Agent[]; tasks: Task[]; messages: TaskMessage[];
  requests: InputRequest[]; events: DomainEvent[]; settings: Settings;
  runtime: { mode: 'simulation'|'mixed'|'live'; dataRoot: string; schemaVersion: number };
  artifacts: ArtifactVersion[];
  taskArtifacts: TaskArtifact[];
  workspaceSnapshots: WorkspaceSnapshot[];
  storage: { usedBytes: number; budgetBytes: number };
}
export interface ArtifactVersion {
  id: string; artifactId: string; version: number; displayName: string;
  ownerAgentId: string | null; producerTaskId: string | null;
  visibility: 'private' | 'shared'; bytes: number; sha256: string; mime: string;
  format: string; createdAt: number; status: 'ready' | 'missing' | 'corrupt';
  sourceVersionId: string | null;
  browserSource?: { origin: string };
  codeSource?: { executionId: string; inputVersionIds: string[] };
}
export interface TaskArtifact { taskId: string; versionId: string; role: 'input' | 'output' }
export interface WorkspaceSnapshot { id: string; taskId: string; revision: number; bytes: number; fileCount: number; createdAt: number }
export interface ImportTarget { scope: 'private' | 'shared'; agentId: string | null; taskId: string | null }
export type FileCommand =
  | RepositorySnapshotCommand
  | { type: 'files.pick'; target: ImportTarget; artifactId?: string }
  | { type: 'artifacts.publish'; versionId: string }
  | { type: 'artifacts.use'; versionId: string; taskId: string }
  | { type: 'artifacts.export' | 'artifacts.repair'; versionId: string }
  | { type: 'storage.updateBudget'; budgetBytes: number };
export interface FileActionResult {
  snapshot: Snapshot; versionIds?: string[]; exported?: boolean; cancelled?: boolean;
  warnings?: string[]; repositoryPreview?:RepositorySnapshotPreview;
}
export interface ArtifactPreview {
  version: ArtifactVersion; text: string | null; truncated: boolean; note: string;
}
export type Command =
  | { type: 'snapshot' }
  | { type: 'agents.create'; name: string; instructions: string }
  | { type: 'tasks.create'; agentId: string; objective: string; completionCriteria: string; scenario: Scenario }
  | { type: 'tasks.message'; taskId: string; content: string }
  | { type: 'tasks.pause' | 'tasks.resume' | 'tasks.cancel'; taskId: string }
  | { type: 'requests.respond'; requestId: string; revision: number; response: string }
  | { type: 'settings.update'; settings: Partial<Settings> }
  | { type: 'simulation.step' };
export const GRANTS_CHANNEL = 'agent-workspaces:grants';
export type GrantsCommand = {type:'grants.list';taskId:string|null} | {type:'grants.revoke';requestId:string};
export interface AppBridge {
  taskHistory?(command:import('./history').TaskHistoryCommand):Promise<import('./history').TaskHistoryState>;
  grants?(command: GrantsCommand): Promise<import('./requests').ExactCapabilityGrant[]>;
  fleet(command:FleetCommand):Promise<FleetState>;
  securityReview(command:SecurityReviewCommand):Promise<SecurityReviewState>;
  modelProviders(command:ModelProviderCommand):Promise<ModelProviderState>;
  taskRecovery(command:TaskRecoveryCommand):Promise<TaskRecoveryState>;
  reportExport(command:ReportExportCommand):Promise<ReportExportResult>;
  gmailReview(command:GmailReviewCommand):Promise<{search?:GmailSearchPage;thread?:GmailThreadResult;imported?:{versionIds:string[];source:GmailAttachmentReceipt}}>;
  googleWorkspace(command:GoogleWorkspaceCommand):Promise<{state:GoogleWorkspaceState;imported?:GoogleImportResult}>;
  googleWorkspaceImportClient():Promise<{state:GoogleWorkspaceState;cancelled:boolean}>;
  onGoogleWorkspaceChanged(callback:()=>void):()=>void;
  browserActions(command:BrowserActionsCommand):Promise<BrowserActionsState>;
  routines(command:RoutineCommand):Promise<RoutineState>;
  projects(command:ProjectCommand):Promise<ProjectsState>;
  recovery(command: RecoveryCommand): Promise<RecoveryState>;
  results(command: ResultsCommand): Promise<ResultsState>;
  readiness(command: ReadinessCommand): Promise<ReadinessState>;
  modelConnection(command: ModelConnectionCommand): Promise<ModelConnectionState>;
  workflows(command: WorkflowCommand): Promise<WorkflowState>;
  collaboration(command: CollaborationCommand): Promise<CollaborationState>;
  browserSetup(command: BrowserSetupCommand): Promise<BrowserSetupState>;
  command(command: Command): Promise<Snapshot>;
  onChanged(callback: () => void): () => void;
  files(command: FileCommand): Promise<FileActionResult>;
  preview(versionId: string): Promise<ArtifactPreview>;
  importDroppedFiles(target: ImportTarget, files: File[]): Promise<FileActionResult>;
  browser(command: BrowserCommand): Promise<BrowserState>;
  onBrowserChanged(callback: () => void): () => void;
  code(command: CodeCommand): Promise<CodeState>;
  onCodeChanged(callback: () => void): () => void;
  requests(command: RequestCommand): Promise<UserRequest[]>;
  requestPick(command: RequestPick): Promise<{ requests: UserRequest[]; cancelled: boolean }>;
  onRequestsChanged(callback: () => void): () => void;
  live(command: LiveCommand): Promise<LiveState>;
  onLiveChanged(callback: () => void): () => void;
  gmail(command: GmailOwnerCommand): Promise<GmailState>;
  gmailImportClient(): Promise<{ state: GmailState; cancelled: boolean }>;
  onGmailChanged(callback: () => void): () => void;
}
export type GmailOwnerCommand = { type: 'gmail.verify' } | { type: 'gmail.state' } | { type: 'gmail.connect'; taskId: string } | { type: 'gmail.disconnect' };
export const GMAIL_IMPORT_CHANNEL = 'agent-workspaces:gmail-import-client';
export interface RequestPick { requestId: string; revision: number; slotId: string; slotRevision: number }
export const REQUEST_PICK_CHANNEL = 'agent-workspaces:request-pick';
export type CommandResult = { ok: true; snapshot: Snapshot } | { ok: false; error: { code: string; message: string } };
export const COMMAND_CHANNEL = 'agent-workspaces:command';
export const CHANGED_CHANNEL = 'agent-workspaces:changed';
export const FILES_CHANNEL = 'agent-workspaces:files';
export const DROP_CHANNEL = 'agent-workspaces:drop-files';
export const PREVIEW_CHANNEL = 'agent-workspaces:preview';

export {HISTORY_CHANNEL} from './history';
export type {TaskHistoryCommand,TaskHistoryState} from './history';
