export interface LiveLimits { maxCostUsd:number; maxModelCalls:number; maxToolSteps:number; maxActiveSeconds:number; maxTokens:number }
export interface LivePolicy { mode:'workspace'|'read_only_browser'; allowedOrigins:string[]; mailAccount?:string; browserInteraction?:'reviewed_actions'; mailDetail?:'threads_and_attachments' }
export interface LiveTaskState {
 taskId:string; model:string; modelConfigured?:boolean; modelLabel?:string; reviewOnly?:boolean; policy:LivePolicy; limits:LiveLimits; enabled:boolean; calls:number; steps:number;
 inputTokens:number; outputTokens:number; costUsd:number; reservedUsd:number; activeSeconds:number;
 lastError:string|null; resultVersionId:string|null;
 troubleshooting?:{code:string;message:string;action:string;attempts:number;recovered:boolean;at:number}[];
}
export interface LiveState {
 legacyCredentialConfigured?:boolean; credentialConfigured:boolean; models:{id:string;label:string;inputUsdPerMillion:number;outputUsdPerMillion:number;configured?:boolean;provider?:string;local?:boolean}[];
 defaultModel:string; tasks:LiveTaskState[]; busy:boolean;
}
export type LiveCommand = {type:'live.state'}
 | {type:'live.createTask';agentId:string;objective:string;completionCriteria:string;model:string;policy:LivePolicy;limits:LiveLimits}
 | {type:'live.start'|'live.pause'|'live.stop';taskId:string};
export const LIVE_CHANNEL='agent-workspaces:live';
export const LIVE_CHANGED_CHANNEL='agent-workspaces:live-changed';
export const DEFAULT_LIVE_LIMITS:LiveLimits={maxCostUsd:1,maxModelCalls:40,maxToolSteps:80,maxActiveSeconds:900,maxTokens:200_000};
