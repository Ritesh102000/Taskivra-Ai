import type {GoogleWorkspaceService} from '../../../packages/google-workspace';
import {parseGoogleWorkspaceCommand,GoogleWorkspaceError} from '../../../packages/google-workspace';
import type {Coordinator} from '../../../packages/coordinator';
import {importSelectedBytes} from '../../../packages/imports';
export class GoogleWorkspaceController {
 constructor(private service:GoogleWorkspaceService,private coordinator:Coordinator){}
 async handle(raw:unknown){const command=parseGoogleWorkspaceCommand(raw),projects=this.coordinator.projects;
  if(command.type==='googleWorkspace.state')return{state:await this.service.status()};
  if(command.type==='googleWorkspace.disconnect')return{state:await this.service.disconnect()};
  if(command.type==='googleWorkspace.verify'){const state=await this.service.status();if(!state.connectedAccount)throw new GoogleWorkspaceError('account_mismatch');return{state:await this.service.verifyConnection(state.connectedAccount)};}
  if(command.type==='googleWorkspace.connect'){
   if(!projects.state().projects.some(p=>p.id===command.projectId))throw new GoogleWorkspaceError('invalid_command');
   const account=command.account,approved=projects.googleWorkspaceAccount(command.projectId);if(approved&&approved!==account.toLowerCase())throw new GoogleWorkspaceError('account_mismatch');return{state:await this.service.connect(account)};
  }
  const account=projects.googleWorkspaceAccount(command.projectId);if(!account)throw new GoogleWorkspaceError('account_mismatch','Verify a Google account and approve it for this project in Projects before importing.');
  const check=()=>{
   if(this.coordinator.maintenanceActive||projects.agent(command.agentId)!==command.projectId||projects.googleWorkspaceAccount(command.projectId)!==account)throw new GoogleWorkspaceError('account_mismatch');
   if(command.taskId){const task=projects.db.prepare('SELECT agent_id,state FROM tasks WHERE id=?').get(command.taskId);if(!task||task.agent_id!==command.agentId||!['paused','waiting'].includes(String(task.state)))throw new GoogleWorkspaceError('invalid_command','Choose a paused or waiting task belonging to this project agent.');}
  };
  check();const selected=await this.service.importSelected(account,command.selection);try{check();
  const result=await importSelectedBytes(this.coordinator.artifacts,{agentId:command.agentId,taskId:command.taskId,...selected},check);
  return{state:await this.service.status(),imported:{versionIds:result.versionIds,receipt:selected.source}};
  }finally{selected.bytes.fill(0);}
 }
}
