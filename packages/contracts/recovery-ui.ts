export const RECOVERY_CHANNEL = 'agent-workspaces:recovery';
export type RecoveryCommand = {type:'recovery.backup'} | {type:'recovery.verify'} | {type:'recovery.restore'};
export interface RecoveryState { cancelled?: boolean; action: 'backup'|'verify'|'restore'; directory?:string; files?:number; bytes?:number; pausedTasks?:number; message:string }
