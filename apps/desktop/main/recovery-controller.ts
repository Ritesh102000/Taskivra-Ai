import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RecoveryService } from '../../../packages/recovery';
import type { RecoveryState } from '../../../packages/contracts/recovery-ui';
export class RecoveryController {
  constructor(private service: RecoveryService, private pick: (purpose:'backup'|'source'|'restore')=>Promise<string|null>) {}
  async handle(raw:unknown):Promise<RecoveryState> {
    if(!raw || typeof raw!=='object' || Array.isArray(raw) || Object.keys(raw).length!==1) throw new Error('Choose a recovery action.');
    const type=(raw as {type?:string}).type;
    if(!['recovery.backup','recovery.verify','recovery.restore'].includes(type||'')) throw new Error('Choose a recovery action.');
    const action=type!.slice(9) as RecoveryState['action'];
    const source=await this.pick(action==='backup'?'backup':'source');
    if(!source)return{action,cancelled:true,message:'No files changed.'};
    const suffix=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
    if(action==='backup') {
      const result=await this.service.createBackup(join(source,'Agent Workspaces Backup '+suffix));
      return{action,directory:result.directory,files:result.manifest.files.length,bytes:result.manifest.totalBytes,message:'Backup verified. Tasks stay paused until you resume them. Browser logins and Keychain credentials are excluded.'};
    }
    if(action==='verify') {
      const result=await this.service.verifyBackup(source);
      return{action,directory:result.directory,files:result.manifest.files.length,bytes:result.manifest.totalBytes,message:'Backup files and checksums are valid.'};
    }
    const parent=await this.pick('restore');
    if(!parent)return{action,cancelled:true,message:'Restore cancelled. Your current workspace is unchanged.'};
    const result=await this.service.restoreBackup(source,join(parent,'Agent Workspaces Restored '+suffix));
    return{action,directory:result.dataRoot,files:result.restoredFiles,pausedTasks:result.pausedTasks,message:'Restored to a separate folder. Your current workspace is unchanged. The restored copy has execution disabled and requires connection review before use.'};
  }
}
