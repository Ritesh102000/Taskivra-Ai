import type {LiveLimits} from './live';
export const ROUTINES_CHANNEL='agent-workspaces:routines';
export interface RoutineTiming { timezone:string; hour:number; minute:number; weekdays:number[] }
export interface Routine {id:string;title:string;sourceTaskId:string;agentId:string;enabled:boolean;timing:RoutineTiming;nextRun:number;expiresAt:number;monthlyCapUsd:number;limits:LiveLimits;lastError:string|null;createdAt:number;alertsEnabled:boolean}
export interface RoutineResultChange {added:number;removed:number;addedExamples:string[];removedExamples:string[];unit:'rows'|'sections';format:'csv'|'markdown';baselineHash:string;resultHash:string}
export interface RoutineAlert {id:string;routineId:string;taskId:string;versionId:string;baselineTaskId:string;baselineVersionId:string;createdAt:number;seen:boolean;change:RoutineResultChange}
export interface RoutineComparison {taskId:string;versionId:string;baselineVersionId:string;state:'changed'|'unchanged'|'unavailable';message:string;createdAt:number}
export interface RoutineOccurrence {id:string;routineId:string;dueAt:number;taskId:string|null;state:string;reason:string|null;costUsd:number;comparison?:RoutineComparison}
export interface RoutineState {routines:Routine[];occurrences:RoutineOccurrence[];eligible:{taskId:string;title:string;versionId:string}[];alerts:RoutineAlert[];unreadAlerts:number}
export type RoutineCommand={type:'routines.state'}|{type:'routines.create';sourceTaskId:string;title:string;timing:RoutineTiming;expiresAt:number;monthlyCapUsd:number;limits:LiveLimits;idempotencyKey:string;alertsEnabled?:boolean}|{type:'routines.setEnabled';id:string;enabled:boolean}|{type:'routines.pauseAll'}|{type:'routines.setAlerts';id:string;enabled:boolean}|{type:'routines.acknowledgeAlert';id:string};
