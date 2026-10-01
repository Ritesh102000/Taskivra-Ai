import type { TaskState } from './index';

export interface CollaborationPolicy {
  taskId: string; revision: number; visibility: 'private' | 'shared';
  /** Owner-written shareable description, never copied from a private objective. */
  summary: string; peerAgentIds: string[];
}
export interface SharedArtifact {
  versionId: string; artifactId: string; version: number; displayName: string;
  bytes: number; sha256: string; format: string; mime: string; createdAt: number;
  /** Null when the producer task is outside the recipient's shared board. */
  producerTaskId: string | null; ownerAgentId: string | null;
}
export interface TaskDependency {
  taskId: string; dependsOnTaskId: string; requiredVersionId: string | null;
  status: 'pending' | 'ready' | 'upstream_failed' | 'upstream_cancelled' | 'artifact_unavailable';
  /** Fixed backend explanation: no private objective or logs. */
  explanation: string;
}
export interface SharedBoardTask {
  taskId: string; agentId: string; agentName: string; summary: string; state: TaskState;
  revision: number; dependencies: TaskDependency[]; publishedVersionIds: string[];
}
export type CollaborationMessageKind = 'handoff' | 'update' | 'question';
export interface AgentInboxMessage {
  id: string; senderAgentId: string; recipientAgentId: string; sourceTaskId: string;
  origin: 'owner' | 'agent'; kind: CollaborationMessageKind; body: string;
  taskIds: string[]; versionIds: string[]; createdAt: number; readAt: number | null;
}
export interface PublicationNotice {
  id: string; eventId: number; recipientAgentId: string; versionId: string;
  artifact: SharedArtifact; createdAt: number; readAt: number | null;
}
export interface CollaborationState {
  policies: CollaborationPolicy[]; board: SharedBoardTask[];
  inbox: AgentInboxMessage[]; publications: PublicationNotice[];
  dependencies: TaskDependency[]; sharedArtifacts: SharedArtifact[];
}
export interface AgentCollaborationContext extends CollaborationState {
  /** Fixed bounds; callers must not interpret a bounded view as a complete history. */
  limits: { board: number; inbox: number; publications: number; artifacts: number };
}
export interface AgentMessageInput {
  recipientAgentId: string; kind: CollaborationMessageKind;
  taskIds: string[]; versionIds: string[]; idempotencyKey: string;
}
export type CollaborationCommand =
  | { type: 'collaboration.state' }
  | { type: 'collaboration.policy'; taskId: string; revision: number; visibility: 'private' | 'shared'; summary: string; peerAgentIds: string[] }
  | { type: 'collaboration.dependency.add'; taskId: string; dependsOnTaskId: string; requiredVersionId: string | null }
  | { type: 'collaboration.dependency.remove'; taskId: string; dependsOnTaskId: string }
  | ({ type: 'collaboration.send'; taskId: string; body: string } & AgentMessageInput)
  | { type: 'collaboration.ack'; agentId: string; messageIds: string[]; publicationIds?: string[] }
  | { type: 'collaboration.consume'; taskId: string; versionId: string };
