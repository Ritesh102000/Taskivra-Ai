import type {Coordinator} from '../../../packages/coordinator';
import {GmailError} from '../../../packages/gmail';
import {parseGmailReviewCommand} from '../../../packages/gmail/review';
import {importSelectedBytes} from '../../../packages/imports';
export class GmailReviewController {
 constructor(private c:Coordinator){}
 async handle(raw:unknown){const command=parseGmailReviewCommand(raw),task=this.c.snapshot().tasks.find(t=>t.id===command.taskId),config=(await this.c.live.state()).tasks.find(t=>t.taskId===command.taskId);
  if(!task||!config?.policy.mailAccount||config.policy.mailDetail!=='threads_and_attachments'||!this.c.gmail)throw new GmailError('invalid_command');
  const account=config.policy.mailAccount;const check=()=>{this.c.projects.assertGmailAccount(task.id,account);if(this.c.maintenanceActive)throw new GmailError('busy');};check();
  if(command.type==='gmailReview.search'){const search=await this.c.gmail.searchReadonly(account,{taskId:task.id,query:command.query,cursor:command.cursor});check();return{search};}
  if(command.type==='gmailReview.thread'){const thread=await this.c.gmail.readThreadReadonly(account,{taskId:task.id,threadId:command.threadId});check();return{thread};}
  if(!['paused','waiting'].includes(task.state))throw new GmailError('busy');
  const selected=await this.c.gmail.readAttachmentReadonly(account,{taskId:task.id,messageId:command.messageId,attachmentId:command.attachmentId});try{check();
  const imported=await importSelectedBytes(this.c.artifacts,{agentId:task.agentId,taskId:task.id,...selected},()=>{check();const state=this.c.projects.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id)?.state;if(!state||!['paused','waiting'].includes(String(state)))throw new GmailError('busy');});return{imported:{versionIds:imported.versionIds,source:selected.source}};}finally{selected.bytes.fill(0);}
 }
}
