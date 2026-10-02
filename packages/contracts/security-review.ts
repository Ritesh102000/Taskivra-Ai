import type {TaskState} from './index';
import type {LiveLimits} from './live';
export const SECURITY_REVIEW_CHANNEL='agent-workspaces:security-review';
export const SECURITY_REVIEW_ROLES=['code_review','evidence_review','synthesis'] as const;
export type SecurityReviewRole=typeof SECURITY_REVIEW_ROLES[number];
export interface SecurityReviewMemberInput {role:SecurityReviewRole;agentId:string;model:string;limits:LiveLimits}
export interface SecurityReviewMember extends SecurityReviewMemberInput {taskId:string|null;preparation:'waiting_handoff'|'preparing'|'ready'|'failed';taskState:TaskState|null;inputVersionIds:string[];resultVersionId:string|null;error:string|null}
export interface SecurityReviewHandoff {id:string;fromTaskId:string;toTaskId:string;sourceVersionId:string;publishedVersionId:string|null;state:'preparing'|'ready'|'failed';createdAt:number}
export interface SecurityReviewTeam {id:string;title:string;scope:string;projectId:string;sourceVersionIds:string[];members:SecurityReviewMember[];handoffs:SecurityReviewHandoff[];createdAt:number;maximumCostUsd:number;costUsd:number;reservedUsd:number}
export interface SecurityReviewState {teams:SecurityReviewTeam[];eligibleSources:{versionId:string;displayName:string;format:string;bytes:number;projectId:string}[];createdTeamId?:string}
export type SecurityReviewCommand=
 |{type:'securityReview.state'}
 |{type:'securityReview.create';title:string;scope:string;sourceVersionIds:string[];members:SecurityReviewMemberInput[];idempotencyKey:string}
 |{type:'securityReview.prepareNext';teamId:string;fromTaskId:string;versionId:string;publishOutput:true;idempotencyKey:string}
 |{type:'securityReview.retryPreparation';teamId:string};
export interface SecurityReviewBridge {securityReview(command:SecurityReviewCommand):Promise<SecurityReviewState>}
