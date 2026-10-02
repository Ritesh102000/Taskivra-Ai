import type { TaskState } from './index';
import type {LiveLimits} from './live';

export const FLEET_CHANNEL='agent-workspaces:fleet';
export const FLEET_LAB_URL='http://127.0.0.1:4318/';
export type FleetMode='imported_evidence'|'local_website';
export interface FleetLabStatus {ready:boolean;siteUrl:string;message:string}
export interface FleetLimits {
 maxAgents:number; maxConcurrent:number; maxWorkItems:number; maxPlanRevisions:number;
 maxCostUsd:number; maxModelCalls:number; maxTokens:number; maxActiveSeconds:number;
}
export const DEFAULT_FLEET_LIMITS:Readonly<FleetLimits>=Object.freeze({maxAgents:4,maxConcurrent:2,maxWorkItems:8,maxPlanRevisions:3,maxCostUsd:5,maxModelCalls:100,maxTokens:500000,maxActiveSeconds:1800});
export const DEFAULT_FLEET_TASK_LIMITS:Readonly<LiveLimits>=Object.freeze({maxCostUsd:2,maxModelCalls:30,maxToolSteps:50,maxActiveSeconds:600,maxTokens:150000});
export type FleetStatus='prepared'|'running'|'paused'|'needs_attention'|'succeeded'|'stopped';
export interface FleetMember {id:string;agentId:string;roleKey:string;name:string;goal:string;model:string;isLead:boolean}
export interface FleetTask {taskId:string;memberId:string;kind:'lead'|'worker';itemId:string|null;state:TaskState;preparation:'preparing'|'ready'|'failed';inputVersionIds:string[];resultVersionId:string|null;error:string|null}
export interface FleetItem {id:string;key:string;title:string;description:string;roleKey:string;dependsOnIds:string[];state:'pending'|'claimed'|'completed'|'cancelled';claimedTaskId:string|null;outputVersionId:string|null;publishedVersionId:string|null;revision:number}
export interface FleetMessage {id:string;fromTaskId:string;recipientRoleKey:string|null;content:string;itemIds:string[];versionIds:string[];createdAt:number;replyToMessageId?:string|null}
export interface FleetPlanRevision {revision:number;summary:string;createdAt:number}
export interface Fleet {
 id:string;projectId:string;title:string;objective:string;sourceVersionIds:string[];plannerModel:string;workerModel:string;mode:FleetMode;siteUrl:string|null;
 archivedAt?:number|null;status:FleetStatus;limits:FleetLimits;taskLimits:LiveLimits;revision:number;createdAt:number;
 members:FleetMember[];tasks:FleetTask[];items:FleetItem[];messages:FleetMessage[];revisions:FleetPlanRevision[];
 costUsd:number;reservedUsd:number;modelCalls:number;totalTokens:number;activeSeconds:number;
 lineage?:{sourceFleetId:string;sourceRevision:number;sourceFinalVersionId:string|null}|null;sourceManifest?:{sha256:string;entries:unknown[]}|null;
 finalTaskId:string|null;finalVersionId:string|null;problem:string|null;
}
export interface FleetState {nextCursor?:string|null;fleets:Fleet[];eligibleSources:{versionId:string;displayName:string;format:string;bytes:number;projectId:string}[];lab?:FleetLabStatus;createdFleetId?:string;mailbox?:{messages:FleetMessage[];nextCursor:string|null}}
export type FleetCommand=
 |{type:'fleet.state';projectId?:string;sourceVersionIds?:string[];archived?:boolean;beforeFleetId?:string;fleetId?:string}
 |{type:'fleet.archive';fleetId:string;archived:boolean}
 |{type:'fleet.followup';fleetId:string;objective:string;limits:FleetLimits;taskLimits:LiveLimits;idempotencyKey:string}
 |{type:'fleet.mailbox';fleetId:string;taskId:string;beforeMessageId?:string;messageId?:string}
 |{type:'fleet.labStart'}
 |{type:'fleet.create';projectId:string;objective:string;sourceVersionIds:string[];plannerModel:string;workerModel:string;limits:FleetLimits;taskLimits:LiveLimits;idempotencyKey:string;mode?:FleetMode}
 |{type:'fleet.start'|'fleet.pause'|'fleet.stop';fleetId:string};
export interface FleetBridge {fleet(command:FleetCommand):Promise<FleetState>}
