export type RequestKind = 'files' | 'clarification' | 'browser_handoff' | 'capability' | 'reduced_scope' | 'gmail_connection';
export type RequestState = 'open' | 'partial' | 'checking' | 'needs_correction' | 'fulfilled' | 'cancelled' | 'superseded';
export type SlotState = 'missing' | 'uploading' | 'checking' | 'accepted' | 'needs_replacement';
export type Scalar = string | number | boolean | null;
export interface FileConstraints {
  formats: ('txt' | 'md' | 'csv' | 'json' | 'pdf' | 'png' | 'jpeg' | 'xlsx' | 'binary')[];
  minBytes?: number; maxBytes?: number;
  textIncludes?: string[];
  csv?: { requiredColumns: string[]; minRows?: number; maxRows?: number; equals?: { column: string; value: string }[] };
  json?: { requiredKeys: string[]; equals?: { path: string[]; value: Scalar }[] };
}
export interface FileSlotSpec { key: string; label: string; required: boolean; constraints: FileConstraints }
export interface CapabilitySpec { name: 'browser_upload' | 'artifact_publish'; origin?: string; versionIds: string[] }
export type UserRequestSpec = { title: string; reason: string; continuation: string } & (
  | { kind: 'files'; slots: FileSlotSpec[] }
  | { kind: 'clarification' }
  | { kind: 'capability'; capability: CapabilitySpec }
  | { kind: 'browser_handoff' }
);
export interface RequestSlot extends FileSlotSpec {
  id: string; state: SlotState; candidateVersionId: string | null; revision: number; explanation: string | null;
}
export interface ReducedScopeProposal { description: string; completionCriteria: string; waiveSlotKeys: string[] }
export interface UserRequest {
  legacy?: boolean;
  id: string; taskId: string; agentId: string;
  type: 'files' | 'clarification' | 'browser_handoff' | 'permission_change'; kind: RequestKind;
  title: string; reason: string; state: RequestState; revision: number; continuationKey: string;
  slots: RequestSlot[]; response: string | null; createdAt: number;
  capability?: CapabilitySpec; reducedScope?: ReducedScopeProposal;
  parentRequestId?: string; parentRevision?: number;
}
export type RequestCommand =
  | { type: 'requests.list'; taskId: string | null }
  | { type: 'requests.assign'; requestId: string; revision: number; assignments: { slotId: string; slotRevision: number; versionId: string }[] }
  | { type: 'requests.reply'; requestId: string; revision: number; response: string }
  | { type: 'requests.decide'; requestId: string; revision: number; decision: 'accept' | 'decline' };
export interface ReplanClaim {
  id: string; requestId: string; requestRevision: number; taskId: string; agentId: string;
  response: string; request: UserRequest; ownerId: string; generation: number; leaseUntil: number;
}
export type ReplanResult = { kind: 'keep_blocked'; message: string } | ({ kind: 'reduced_scope' } & ReducedScopeProposal);
export interface ValidationResult { accepted: boolean; explanation: string }
export const REQUEST_LIMITS = { slots: 16, requestsPerTask: 32, openPerTask: 8, assignments: 16, responseBytes: 8000, validationBytes: 1024 * 1024, replansPerRequest: 3, validationMs: 2000 } as const;
export const REQUEST_CHANNEL = 'agent-workspaces:requests';
export const REQUEST_CHANGED_CHANNEL = 'agent-workspaces:requests-changed';
