import type { ArtifactPreview, ArtifactVersion } from './index';
import type { LiveLimits } from './live';

export interface ResultReview {
  state: 'unreviewed' | 'accepted' | 'changes_requested';
  revision: number;
  feedback: string;
  updatedAt: number | null;
}
export interface ResultItem {
  taskId: string; agentId: string; objective: string; completionCriteria: string;
  version: ArtifactVersion; costUsd: number; limits: LiveLimits; model: string;
  review: ResultReview;
  revisionOf: { taskId: string; versionId: string } | null;
}
export interface ResultRevisionJob {
  id: string; sourceTaskId: string; sourceVersionId: string; taskId: string;
  state: 'preparing' | 'ready' | 'failed'; error: string | null;
  inputVersionIds: string[]; createdAt: number;
}
export interface ResultEvidence {
  id: string; tool: string; label: string; createdAt: number;
}
export interface ResultQualityCheck {
  id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string;
}
export interface ResultQuality {
  checkerVersion: string; sourceVersionId: string; sourceSha256: string; checkedAt: number;
  status: 'pass' | 'warn' | 'fail'; canFinish: boolean;
  coverage: { complete: boolean; checkedBytes: number; sourceBytes: number };
  checks: ResultQualityCheck[];
  /** Structural checks are not semantic or factual certification. */
  limitation: string;
}
export interface ResultDetail {
  result: ResultItem; preview: ArtifactPreview; inputs: ArtifactVersion[]; supportingOutputs?:ArtifactVersion[];
  evidence: ResultEvidence[]; totalEvidence: number; evidenceTruncated: boolean;
  /** Technical receipts are not a factual or semantic judgment. */
  integrity: 'verified'; criteriaStatus: 'needs_owner_review' | 'accepted_by_owner' | 'changes_requested';
  quality: ResultQuality;
  /** Omitted by older services; ordinary results remain revisable by default. */
  canRequestChanges?: boolean;
  provenance?: {inputRoles:{slotKey:string;versionId:string|null}[];routine:{routineId:string;occurrenceKey:string}|null;assessment:{checkerVersion:string;sourceVersionId:string;sourceSha256:string;checkedAt:number};acceptance:ResultReview};
}
export interface ResultsState {
  results: ResultItem[]; revisionJobs: ResultRevisionJob[]; detail?: ResultDetail;
  createdTaskId?: string;
}
export type ResultsCommand =
  | { type: 'results.state'; beforeTaskId?:string }
  | { type: 'results.inspect'; taskId: string; versionId?: string }
  | { type: 'results.accept'; taskId: string; versionId: string; revision: number; idempotencyKey: string }
  | { type: 'results.requestChanges'; taskId: string; versionId: string; revision: number; feedback: string; limits: LiveLimits; idempotencyKey: string }
  | { type: 'results.retryPreparation'; revisionId: string };
export const RESULTS_CHANNEL = 'agent-workspaces:results';

/** Kept separate until the main owner-only bridge integrates this service. */
export interface ResultsBridge { results(command: ResultsCommand): Promise<ResultsState> }

export type ReportExportFormat = 'pdf' | 'docx' | 'xlsx';
export interface ReportExportCommand { type: 'results.exportReport'; taskId: string; versionId: string; format: ReportExportFormat }
export interface ReportExportResult { cancelled: boolean; format: ReportExportFormat; sourceVersionId: string; sourceSha256: string; bytes?: number; sha256?: string; message: string }
export interface ReportExportBridge { reportExport(command: ReportExportCommand): Promise<ReportExportResult> }
export const REPORT_EXPORT_CHANNEL = 'agent-workspaces:report-export';
