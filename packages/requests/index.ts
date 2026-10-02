import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { Persistence } from '../persistence/index';
import type { ArtifactService } from '../artifacts/index';
import type { RunClaim } from '../coordinator/index';
import { parseRequestCommand, parseUserRequest, parseReplanResult } from '../contracts/request-validation';
import { REQUEST_LIMITS, type ExactCapabilityGrant, type CapabilitySpec, type FileConstraints, type ReplanClaim, type ReplanResult, type RequestCommand, type RequestSlot, type UserRequest, type UserRequestSpec, type ValidationResult } from '../contracts/requests';
import { validateContent } from './validation';
type Row=Record<string,string|number|null>;
const closedStates=['fulfilled','cancelled','superseded'],terminal=['succeeded','failed','cancelled'];
const alive=(pid:number)=>{try{process.kill(pid,0);return pid>0;}catch{return false;}};
export class RequestError extends Error {constructor(readonly code:string,message:string){super(message);this.name='RequestError';}}
function fail(code:string,message:string):never{throw new RequestError(code,message);}
export interface RequestServiceOptions {
  persistence:Persistence;artifacts:ArtifactService;authorize:(claim:RunClaim)=>void;now?:()=>number;onChanged?:()=>void;
  applyCapability?:(taskId:string,capability:CapabilitySpec)=>void;
  autoValidate?:boolean;
  validate?:(text:string,constraints:FileConstraints)=>Promise<ValidationResult>;
  fault?:(point:'before_validation_commit'|'after_validation_commit'|'before_fulfillment_commit')=>void;
}
/** Durable requests share the coordinator database; untrusted candidates are data-only worker inputs. */
export class RequestService {
  readonly ready:Promise<void>;readonly instanceId=randomUUID();
  private closed=false;private draining?:Promise<number>;
  constructor(private options:RequestServiceOptions){this.ready=(async()=>{await options.artifacts.ready;if(this.closed)return;this.reconcile();this.kick();})();}
  private now(){return(this.options.now||Date.now)();}
  private row(sql:string,...values:SQLInputValue[]){return this.options.persistence.db.prepare(sql).get(...values) as Row|undefined;}
  private rows(sql:string,...values:SQLInputValue[]){return this.options.persistence.db.prepare(sql).all(...values) as Row[];}
  private write(sql:string,...values:SQLInputValue[]){return this.options.persistence.db.prepare(sql).run(...values);}
  private tx<T>(fn:()=>T):T{if(this.closed)fail('closed','The request service is closing.');return this.options.persistence.transaction(fn);}
  private changed(){if(!this.closed)this.options.onChanged?.();}
  private event(type:string,request:Row,payload:object={}){this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)',type,request.id,request.revision,JSON.stringify({taskId:request.task_id,realRequests:true,...payload}),this.now());}
  private request(id:string):Row{const row=this.row('SELECT i.*,d.kind,d.spec_json,d.payload_json,d.source_run_id,d.parent_request_id,d.parent_revision,d.replan_count,t.agent_id,t.state AS task_state FROM input_requests i LEFT JOIN request_details d ON d.request_id=i.id JOIN tasks t ON t.id=i.task_id WHERE i.id=?',id);if(!row)fail('not_found','This request no longer exists.');return row;}
  private current(id:string,revision?:number):Row{const row=this.request(id);if(!row.kind)fail('legacy_request','Use the existing browser, dependency, or clarification control for this request.');if(terminal.includes(String(row.task_state))||closedStates.includes(String(row.state)))fail('request_closed','This request is closed; late input cannot restart its task.');if(revision!==undefined&&row.revision!==revision)fail('stale_revision','This request changed. Refresh it before responding.');return row;}
  private blocker(taskId:string):string|null{
    const request=this.row("SELECT type FROM input_requests WHERE task_id=? AND blocking=1 AND state NOT IN ('fulfilled','cancelled','superseded') ORDER BY created_at,id LIMIT 1",taskId);
    if(request)return String(request.type);
    return this.row("SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? AND t.state<>'succeeded'",taskId)?'dependency':null;
  }
  private updateTask(taskId:string){
    const task=this.row('SELECT * FROM tasks WHERE id=?',taskId)!;if(terminal.includes(String(task.state)))return;
    const reason=this.blocker(taskId),state=task.state==='waiting'&&!reason?'queued':task.state;
    this.write('UPDATE tasks SET state=?,waiting_reason=?,revision=revision+1,updated_at=? WHERE id=?',state,reason,this.now(),taskId);
    this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)','task.blockers_changed',taskId,Number(task.revision)+1,JSON.stringify({waitingReason:reason,state,realRequests:true}),this.now());
  }
  private view(row:Row):UserRequest{
    const gmailConnection=!!this.row('SELECT 1 FROM gmail_connection_requests WHERE request_id=?',row.id);
    const payload=JSON.parse(String(row.payload_json||'{}'));
    const slots:RequestSlot[]=this.rows('SELECT * FROM request_slots WHERE request_id=? ORDER BY rowid',row.id).map(s=>({id:String(s.id),key:String(s.slot_key),label:String(s.label||s.slot_key),required:Boolean(s.required),constraints:JSON.parse(String(s.constraints_json)),state:s.state as RequestSlot['state'],candidateVersionId:s.candidate_version_id===null?null:String(s.candidate_version_id),revision:Number(s.revision),explanation:s.explanation===null?null:String(s.explanation)}));
    return{replan:{used:Number(row.replan_count||0),limit:REQUEST_LIMITS.replansPerRequest,remaining:Math.max(0,REQUEST_LIMITS.replansPerRequest-Number(row.replan_count||0)),status:Number(row.replan_count||0)>=REQUEST_LIMITS.replansPerRequest?'exhausted':'available'},legacy:!row.kind&&!gmailConnection,id:String(row.id),taskId:String(row.task_id),agentId:String(row.agent_id),type:row.type as UserRequest['type'],kind:(gmailConnection?'gmail_connection':row.kind||(row.type==='permission_change'?'capability':row.type)) as UserRequest['kind'],title:String(row.title),reason:String(row.reason),state:row.state as UserRequest['state'],revision:Number(row.revision),continuationKey:String(row.continuation_key),slots,response:row.response===null?null:String(row.response),createdAt:Number(row.created_at),...(row.kind==='capability'?{capability:payload.capability}:{}),...(row.kind==='reduced_scope'?{reducedScope:payload,parentRequestId:String(row.parent_request_id),parentRevision:Number(row.parent_revision)}:{})};
  }
  list(taskId?:string):UserRequest[]{
    if(this.closed)fail('closed','The request service is closing.');
    return this.rows(`SELECT i.*,d.kind,d.payload_json,d.parent_request_id,d.parent_revision,d.replan_count,t.agent_id FROM input_requests i LEFT JOIN request_details d ON d.request_id=i.id JOIN tasks t ON t.id=i.task_id ${taskId?'WHERE i.task_id=?':''} ORDER BY i.created_at,i.rowid`,...(taskId?[taskId]:[])).map(row=>this.view(row));
  }
  createForAgent(claim:RunClaim,raw:UserRequestSpec|unknown,options:{onCreate?:(request:UserRequest)=>void}={}):UserRequest{
    const spec=parseUserRequest(raw);
    if(spec.kind==='browser_handoff')fail('browser_handoff_required','Use the browser service to create a request tied to the live browser session.');
    const result=this.tx(()=>{
      const prior=this.row('SELECT id FROM input_requests WHERE task_id=? AND continuation_key=?',claim.taskId,spec.continuation);
      if(prior){
        const saved=this.request(String(prior.id)),run=this.row('SELECT * FROM runs WHERE id=?',claim.runId);
        if(saved.source_run_id!==claim.runId||saved.spec_json!==JSON.stringify(spec)||!run||run.task_id!==claim.taskId||run.agent_id!==claim.agentId||run.worker_id!==claim.workerId||run.fencing_generation!==claim.generation)fail('request_conflict','This continuation already identifies a different request.');return this.view(saved);
      }
      this.options.authorize(claim);
      if(this.row("SELECT 1 FROM code_executions WHERE task_id=? AND lifecycle IN ('preparing','running','exporting','stopping')",claim.taskId))fail('task_busy','Wait for the code execution before requesting input.');
      if(Number(this.row('SELECT COUNT(*) AS n FROM input_requests WHERE task_id=?',claim.taskId)!.n)>=REQUEST_LIMITS.requestsPerTask||Number(this.row("SELECT COUNT(*) AS n FROM input_requests WHERE task_id=? AND state NOT IN ('fulfilled','cancelled','superseded')",claim.taskId)!.n)>=REQUEST_LIMITS.openPerTask)fail('request_limit','This task has reached its request limit.');
      if(spec.kind==='capability')for(const id of spec.capability.versionIds)this.options.artifacts.getForAgent(claim.agentId,id);
      const requestId=randomUUID(),type=spec.kind==='capability'?'permission_change':spec.kind;
      this.write("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?,?,?,?,'open',?,?)",requestId,claim.taskId,type,spec.title,spec.reason,spec.continuation,this.now());
      this.write('INSERT INTO request_details(request_id,kind,spec_json,payload_json,source_run_id) VALUES (?,?,?,?,?)',requestId,spec.kind,JSON.stringify(spec),JSON.stringify(spec.kind==='capability'?{capability:spec.capability}:{}),claim.runId);
      if(spec.kind==='files')for(const slot of spec.slots)this.write("INSERT INTO request_slots(id,request_id,slot_key,label,required,constraints_json,state) VALUES (?,?,?,?,?,?,'missing')",randomUUID(),requestId,slot.key,slot.label,slot.required?1:0,JSON.stringify(slot.constraints));
      const request=this.request(requestId),view=this.view(request);options.onCreate?.(view);
      this.write("UPDATE runs SET state='waiting',finished_at=?,lease_until=? WHERE id=?",this.now(),this.now(),claim.runId);
      this.write("UPDATE tasks SET state='waiting',waiting_reason=?,generation=generation+1,revision=revision+1,updated_at=? WHERE id=?",type,this.now(),claim.taskId);
      this.write("INSERT INTO task_messages(id,task_id,role,content,created_at) VALUES (?,?,'agent',?,?)",randomUUID(),claim.taskId,`${spec.title}\n${spec.reason}`,this.now());
      this.event('input.requested',request,{agentId:claim.agentId,kind:spec.kind});return view;
    });this.changed();return result;
  }
  grants(taskId?:string):ExactCapabilityGrant[]{
    if(taskId!==undefined&&(!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)||!this.row('SELECT 1 FROM tasks WHERE id=?',taskId)))fail('not_found','Choose an existing task.');
    return this.rows('SELECT * FROM request_capability_grants'+(taskId?' WHERE task_id=?':'')+' ORDER BY granted_at,request_id LIMIT 200',...(taskId?[taskId]:[])).map(row=>{const capability=JSON.parse(String(row.capability_json)) as CapabilitySpec,task=this.row('SELECT t.state,t.agent_id,l.policy_json FROM tasks t LEFT JOIN live_task_config l ON l.task_id=t.id WHERE t.id=?',row.task_id);let reason=row.revoked_at!==null?'The owner revoked future use.':!task||terminal.includes(String(task.state))?'The task ended; this is historical authority.':'';
      if(!reason){try{for(const versionId of capability.versionIds){this.options.artifacts.getForAgent(String(task!.agent_id),versionId);if(!this.row("SELECT 1 FROM task_artifacts b JOIN artifact_versions v ON v.id=b.version_id WHERE b.task_id=? AND b.version_id=? AND v.status='ready'",row.task_id,versionId))reason='An exact granted version is unavailable or detached.';}if(capability.name==='browser_upload'){const policy=JSON.parse(String(task!.policy_json));if(!policy.allowedOrigins?.includes(capability.origin))reason='The exact upload origin is outside current policy.';}}catch{reason='Current source or project authority is unavailable.';}}
      return{requestId:String(row.request_id),taskId:String(row.task_id),capability,grantedAt:Number(row.granted_at),revokedAt:row.revoked_at===null?null:Number(row.revoked_at),currentAuthority:!reason,authorityReason:reason||'Current exact authority for future task use; execution still requires fresh authorization.'};});
  }
  revokeGrant(requestId:string):ExactCapabilityGrant[]{
    return this.tx(()=>{const grant=this.row('SELECT * FROM request_capability_grants WHERE request_id=?',requestId);if(!grant)fail('not_found','Choose an existing exact grant.');
      const task=this.row('SELECT state FROM tasks WHERE id=?',grant!.task_id);
      if(!task||!['paused','waiting','succeeded','failed','cancelled'].includes(String(task.state))||this.row("SELECT 1 FROM runs WHERE task_id=? AND state='running'",grant!.task_id))fail('task_busy','Pause the task and wait for the active operation to stop before revoking future use.');
      if(grant!.revoked_at===null){this.write('UPDATE request_capability_grants SET revoked_at=? WHERE request_id=? AND revoked_at IS NULL',this.now(),requestId);this.event('input.capability_revoked',this.request(requestId),{futureUseOnly:true});}
      return this.grants(String(grant!.task_id));
    });
  }
  async handle(raw:unknown):Promise<UserRequest[]>{
    const command=parseRequestCommand(raw);await this.ready;
    if(command.type==='requests.list')return this.list(command.taskId||undefined);
    if(command.type==='requests.assign')this.assign(command);
    else if(command.type==='requests.reply')this.reply(command);
    else this.decide(command);
    this.changed();this.kick();return this.list();
  }
  private assign(command:Extract<RequestCommand,{type:'requests.assign'}>){this.tx(()=>{
    const request=this.request(command.requestId);if(request.kind!=='files')fail('wrong_request_type','This request has no file slots.');
    // Retry of the exact owner selection is a receipt read, not a second candidate revision.
    const replay=command.assignments.every(a=>{const slot=this.row('SELECT * FROM request_slots WHERE id=? AND request_id=?',a.slotId,request.id);return slot&&slot.revision===a.slotRevision+1&&slot.candidate_version_id===a.versionId;});
    if(replay)return;
    this.current(command.requestId,command.revision);
    for(const assignment of command.assignments){
      const slot=this.row('SELECT * FROM request_slots WHERE id=? AND request_id=?',assignment.slotId,request.id);
      if(!slot||slot.revision!==assignment.slotRevision)fail('stale_slot','This slot changed. Choose its current revision.');
      if(slot.state==='accepted')fail('accepted_slot','This slot is already accepted. Replace only slots that need correction.');
      this.options.artifacts.getForAgent(String(request.agent_id),assignment.versionId);
    }
    for(const assignment of command.assignments){
      const revision=assignment.slotRevision+1,candidateId=randomUUID();
      this.write("UPDATE slot_candidates SET state='superseded' WHERE slot_id=? AND state IN ('checking','rejected')",assignment.slotId);
      this.write("UPDATE request_validation_jobs SET state='cancelled',finished_at=? WHERE slot_id=? AND state IN ('queued','running')",this.now(),assignment.slotId);
      this.write("UPDATE request_slots SET candidate_version_id=?,revision=?,state='checking',explanation=NULL WHERE id=?",assignment.versionId,revision,assignment.slotId);
      this.write("INSERT INTO slot_candidates(id,slot_id,slot_revision,version_id,state,created_at) VALUES (?,?,?,?,'checking',?)",candidateId,assignment.slotId,revision,assignment.versionId,this.now());
      this.write("INSERT INTO request_validation_jobs(id,request_id,slot_id,candidate_id,slot_revision,state,created_at) VALUES (?,?,?,?,?,'queued',?)",randomUUID(),request.id,assignment.slotId,candidateId,revision,this.now());
    }
    this.write("UPDATE input_requests SET state='checking',revision=revision+1 WHERE id=?",request.id);this.cancelReplans(String(request.id));this.supersedeProposals(String(request.id));this.event('input.candidates_assigned',this.request(String(request.id)),{slotIds:command.assignments.map(a=>a.slotId)});
  });}
  private cancelReplans(requestId:string){this.write("UPDATE request_replan_jobs SET state='cancelled',finished_at=? WHERE request_id=? AND state IN ('queued','running')",this.now(),requestId);}
  private supersedeProposals(requestId:string,exceptId=''){
    for(const child of this.rows("SELECT i.id FROM input_requests i JOIN request_details d ON d.request_id=i.id WHERE d.parent_request_id=? AND i.id<>? AND i.state NOT IN ('fulfilled','cancelled','superseded')",requestId,exceptId)){
      this.write("UPDATE input_requests SET state='superseded',revision=revision+1 WHERE id=?",child.id);this.event('input.superseded',this.request(String(child.id)),{parentChanged:true});
    }
  }
  private finish(requestId:string){
    const request=this.current(requestId);this.options.fault?.('before_fulfillment_commit');
    const revision=Number(request.revision)+1;
    this.write("UPDATE input_requests SET state='fulfilled',revision=? WHERE id=?",revision,requestId);
    this.write('INSERT INTO resume_receipts(request_id,fulfillment_revision,continuation_key,created_at) VALUES (?,?,?,?)',requestId,revision,request.continuation_key,this.now());
    this.write("UPDATE request_validation_jobs SET state='cancelled',finished_at=? WHERE request_id=? AND state IN ('queued','running')",this.now(),requestId);
    this.write("UPDATE slot_candidates SET state='superseded' WHERE state='checking' AND slot_id IN (SELECT id FROM request_slots WHERE request_id=?)",requestId);
    this.write("UPDATE request_slots SET state='missing',candidate_version_id=NULL,revision=revision+1 WHERE request_id=? AND state='checking'",requestId);
    this.cancelReplans(requestId);this.supersedeProposals(requestId);this.event('input.fulfilled',this.request(requestId));this.updateTask(String(request.task_id));
  }
  private ownerReply(request:Row,revision:number,response:string,action:'reply'|'accept'|'decline'):boolean{
    const prior=this.row('SELECT * FROM request_owner_replies WHERE request_id=? AND request_revision=?',request.id,revision);
    if(prior){if(prior.response!==response||prior.action!==action)fail('stale_revision','A different response already used this request revision.');return false;}
    this.current(String(request.id),revision);
    const totals=this.row("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes FROM task_messages WHERE role='owner'")!;
    const perTask=this.row("SELECT COUNT(*) AS count FROM task_messages WHERE role='owner' AND task_id=?",request.task_id)!;
    if(Number(totals.count)>=2000||Number(perTask.count)>=100||Number(totals.bytes)+Buffer.byteLength(response)>4*1024*1024)fail('capacity_limit','The conversation storage limit was reached. Existing tasks can still be paused or cancelled.');
    this.write('INSERT INTO request_owner_replies(id,request_id,request_revision,response,action,created_at) VALUES (?,?,?,?,?,?)',randomUUID(),request.id,revision,response,action,this.now());
    this.write('UPDATE input_requests SET response=?,response_revision=?,revision=revision+1 WHERE id=?',response,revision,request.id);
    this.write("INSERT INTO task_messages(id,task_id,role,content,created_at) VALUES (?,?,'owner',?,?)",randomUUID(),request.task_id,response,this.now());
    this.event('input.owner_replied',this.request(String(request.id)),{action});return true;
  }
  private queueReplan(requestId:string){
    const request=this.request(requestId);this.cancelReplans(requestId);this.supersedeProposals(requestId);
    if(Number(request.replan_count)>=REQUEST_LIMITS.replansPerRequest){this.event('input.replan_limit',request);return;}
    const reply=this.row('SELECT id FROM request_owner_replies WHERE request_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',requestId)!;
    this.write("INSERT INTO request_replan_jobs(id,request_id,request_revision,reply_id,state,created_at) VALUES (?,?,?,?,'queued',?)",randomUUID(),requestId,request.revision,reply.id,this.now());
    this.write('UPDATE request_details SET replan_count=replan_count+1 WHERE request_id=?',requestId);this.event('input.replan_queued',request);
  }
  retryFailedReplan(requestId:string,revision:number):void{
    this.tx(()=>{const request=this.current(requestId,revision);if(!['files','capability'].includes(String(request.kind)))fail('unsupported_replan','Only a blocked file or capability request can be repaired.');
      if(request.task_state!=='waiting')fail('invalid_state','The task must still be waiting for this request.');
      if(this.row("SELECT 1 FROM request_replan_jobs WHERE request_id=? AND state IN ('queued','running')",requestId))fail('replan_busy','A request review is already queued or running.');
      if(Number(request.replan_count)>=REQUEST_LIMITS.replansPerRequest)fail('replan_limit','The bounded request-review allowance is exhausted. The saved reply remains available.');
      if(!this.row('SELECT 1 FROM request_owner_replies WHERE request_id=?',requestId))fail('missing_reply','Save an explanation before requesting repair.');
      const job=this.row("SELECT j.id FROM request_replan_jobs j JOIN request_owner_replies r ON r.id=j.reply_id WHERE j.request_id=? AND j.request_revision=? AND j.state='completed' ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1",requestId,revision);if(!job)fail('stale_replan','No completed current request review can be repaired.');
      this.write("UPDATE request_replan_jobs SET state='queued',owner_id=NULL,owner_pid=NULL,generation=generation+1,lease_until=0,finished_at=NULL WHERE id=?",job.id);this.write('UPDATE request_details SET replan_count=replan_count+1 WHERE request_id=?',requestId);this.event('input.replan_repair_queued',request);
    });this.changed();
  }
  private reply(command:Extract<RequestCommand,{type:'requests.reply'}>){this.tx(()=>{
    const request=this.request(command.requestId);if(!this.ownerReply(request,command.revision,command.response,'reply'))return;
    if(request.kind==='clarification')this.finish(String(request.id));else if(request.kind==='files'||request.kind==='capability')this.queueReplan(String(request.id));
  });}
  private decide(command:Extract<RequestCommand,{type:'requests.decide'}>){this.tx(()=>{
    const request=this.request(command.requestId);
    if(!['capability','reduced_scope'].includes(String(request.kind)))fail('wrong_request_type','Use file validation or a clarification answer for this request.');
    if(!this.ownerReply(request,command.revision,command.decision,command.decision))return;
    if(command.decision==='decline'){
      if(request.kind==='reduced_scope'){this.write("UPDATE input_requests SET state='cancelled' WHERE id=?",request.id);this.updateTask(String(request.task_id));}
      else{this.write("UPDATE input_requests SET state='needs_correction' WHERE id=?",request.id);this.queueReplan(String(request.id));}return;
    }
    if(request.kind==='capability'){
      if(!this.options.applyCapability)fail('unsupported_capability','This capability has no configured grant handler. No permission was changed.');
      const capability=JSON.parse(String(request.payload_json)).capability as CapabilitySpec;
      for(const id of capability.versionIds)this.options.artifacts.getForAgent(String(request.agent_id),id);
      this.options.applyCapability(String(request.task_id),capability);
      this.write('INSERT INTO request_capability_grants(request_id,task_id,capability_json,granted_at) VALUES (?,?,?,?)',request.id,request.task_id,JSON.stringify(capability),this.now());
      this.event('input.capability_granted',this.request(String(request.id)),{capability});
    }else{
      const parent=this.current(String(request.parent_request_id),Number(request.parent_revision)),proposal=JSON.parse(String(request.payload_json));
      this.write("UPDATE input_requests SET state='superseded',revision=revision+1 WHERE id=?",parent.id);
      this.write("UPDATE request_validation_jobs SET state='cancelled',finished_at=? WHERE request_id=? AND state IN ('queued','running')",this.now(),parent.id);
      this.cancelReplans(String(parent.id));this.supersedeProposals(String(parent.id),String(request.id));this.write('UPDATE tasks SET completion_criteria=? WHERE id=?',proposal.completionCriteria,request.task_id);
      this.event('input.reduced_scope_accepted',this.request(String(request.id)),{parentRequestId:parent.id,description:proposal.description,waiveSlotKeys:proposal.waiveSlotKeys});
      this.event('input.superseded',this.request(String(parent.id)),{explicitOwnerAcceptance:true});
    }
    this.finish(String(request.id));
  });}
  private kick(){if(this.options.autoValidate===false||this.closed)return;queueMicrotask(()=>{void this.drainValidations().catch(()=>undefined);});}
  private reconcile(){this.tx(()=>{
    for(const row of this.rows("SELECT * FROM request_validation_jobs WHERE state='running'"))if(!alive(Number(row.owner_pid))||Number(row.lease_until)<=this.now())this.write("UPDATE request_validation_jobs SET state='queued',owner_id=NULL,owner_pid=NULL,lease_until=0 WHERE id=?",row.id);
    for(const row of this.rows("SELECT * FROM request_replan_jobs WHERE state='running'"))if(!alive(Number(row.owner_pid))||Number(row.lease_until)<=this.now())this.write("UPDATE request_replan_jobs SET state='queued',owner_id=NULL,owner_pid=NULL,lease_until=0 WHERE id=?",row.id);
    this.write("UPDATE request_validation_jobs SET state='cancelled',finished_at=? WHERE state IN ('queued','running') AND request_id IN (SELECT i.id FROM input_requests i JOIN tasks t ON t.id=i.task_id WHERE i.state IN ('fulfilled','cancelled','superseded') OR t.state IN ('succeeded','failed','cancelled'))",this.now());
    this.write("UPDATE request_replan_jobs SET state='cancelled',finished_at=? WHERE state IN ('queued','running') AND request_id IN (SELECT i.id FROM input_requests i JOIN tasks t ON t.id=i.task_id WHERE i.state IN ('fulfilled','cancelled','superseded') OR t.state IN ('succeeded','failed','cancelled'))",this.now());
  });}
  async drainValidations(limit=32):Promise<number>{
    await this.ready;if(this.closed)return 0;if(this.draining)return this.draining;
    const work=(async()=>{let done=0;while(!this.closed&&done<limit){this.reconcile();const job=this.tx(()=>{
      if(this.row("SELECT 1 FROM request_validation_jobs WHERE state='running'"))return null;
      const row=this.row("SELECT j.*,c.version_id,s.constraints_json,i.task_id,t.agent_id FROM request_validation_jobs j JOIN slot_candidates c ON c.id=j.candidate_id JOIN request_slots s ON s.id=j.slot_id JOIN input_requests i ON i.id=j.request_id JOIN tasks t ON t.id=i.task_id WHERE j.state='queued' ORDER BY j.created_at,j.rowid LIMIT 1");if(!row)return null;
      const generation=Number(row.generation)+1;this.write("UPDATE request_validation_jobs SET state='running',owner_id=?,owner_pid=?,generation=?,lease_until=?,attempts=attempts+1 WHERE id=?",this.instanceId,process.pid,generation,this.now()+30000,row.id);return{...row,generation} as Row;
    });if(!job)break;let result:ValidationResult;
      try{
        const constraints=JSON.parse(String(job.constraints_json)) as FileConstraints,content=Boolean(constraints.textIncludes?.length||constraints.csv||constraints.json);
        const data=await this.options.artifacts.readForValidation(String(job.agent_id),String(job.version_id),content);
        const format=data.version.format==='text'?'txt':data.version.format==='markdown'?'md':data.version.format;
        if(!constraints.formats.includes(format as FileConstraints['formats'][number]))result={accepted:false,explanation:`Wrong format: expected ${constraints.formats.join(', ')}; received ${data.version.format}.`};
        else if(data.version.bytes<(constraints.minBytes||0)||data.version.bytes>(constraints.maxBytes||100*1024*1024))result={accepted:false,explanation:'File size is outside the requested range.'};
        else result=content?await(this.options.validate||validateContent)(data.text!,constraints):{accepted:true,explanation:'Format, size, and checksum checks passed. No semantic content check was requested.'};
      }catch(cause){result={accepted:false,explanation:(cause as {code?:string})?.code==='validation_limit'?'Content validation supports complete UTF-8 files up to 1 MiB.':'The candidate is missing, changed, unsafe, or could not be validated.'};}
      if(this.closed)break;
      this.tx(()=>{
        const current=this.row('SELECT * FROM request_validation_jobs WHERE id=?',job.id),slot=this.row('SELECT * FROM request_slots WHERE id=?',job.slot_id),request=this.request(String(job.request_id));
        if(!current||current.state!=='running'||current.owner_id!==this.instanceId||current.generation!==job.generation||Number(current.lease_until)<=this.now()||!slot||slot.revision!==job.slot_revision||slot.candidate_version_id!==job.version_id||closedStates.includes(String(request.state))||terminal.includes(String(request.task_state)))return;
        if(typeof result.accepted!=='boolean'||typeof result.explanation!=='string'||Buffer.byteLength(result.explanation)>2000)result={accepted:false,explanation:'The validator returned an invalid result.'};
        this.options.fault?.('before_validation_commit');
        this.write("UPDATE request_validation_jobs SET state='completed',finished_at=?,owner_id=NULL,owner_pid=NULL WHERE id=?",this.now(),job.id);
        this.write('UPDATE slot_candidates SET state=?,explanation=?,checked_at=? WHERE id=?',result.accepted?'accepted':'rejected',result.explanation,this.now(),job.candidate_id);
        this.write('UPDATE request_slots SET state=?,explanation=? WHERE id=?',result.accepted?'accepted':'needs_replacement',result.explanation,job.slot_id);
        if(result.accepted)this.write("INSERT OR IGNORE INTO task_artifacts(task_id,version_id,role,created_at) VALUES (?,?,'input',?)",request.task_id,job.version_id,this.now());
        this.write('UPDATE input_requests SET revision=revision+1 WHERE id=?',request.id);this.cancelReplans(String(request.id));this.supersedeProposals(String(request.id));
        this.event('input.slot_checked',this.request(String(request.id)),{slotId:job.slot_id,slotRevision:job.slot_revision,accepted:result.accepted,versionId:job.version_id,explanation:result.explanation});
        const slots=this.rows('SELECT state,required FROM request_slots WHERE request_id=?',request.id);
        if(slots.filter(s=>s.required).every(s=>s.state==='accepted'))this.finish(String(request.id));
        else{const state=slots.some(s=>s.state==='checking')?'checking':slots.some(s=>s.state==='accepted')?'partial':slots.some(s=>s.state==='needs_replacement')?'needs_correction':'open';this.write('UPDATE input_requests SET state=? WHERE id=?',state,request.id);}
      });this.options.fault?.('after_validation_commit');done++;this.changed();
    }return done;})();this.draining=work;try{return await work;}finally{this.draining=undefined;}
  }
  claimReplan({taskIds}:{taskIds?:string[]}={}):ReplanClaim|null{
    return this.tx(()=>{
      if(this.row("SELECT 1 FROM request_replan_jobs WHERE state='running' AND lease_until>?",this.now()))return null;
      this.write("UPDATE request_replan_jobs SET state='queued',owner_id=NULL,owner_pid=NULL WHERE state='running' AND lease_until<=?",this.now());
      const active=Number(this.row("SELECT (SELECT COUNT(*) FROM runs WHERE state='running')+(SELECT COUNT(*) FROM request_replan_jobs WHERE state='running' AND lease_until>?) AS n",this.now())!.n);
      if(active>=Number(this.row('SELECT max_active_agents FROM settings WHERE id=1')!.max_active_agents))return null;
      const jobs=this.rows("SELECT j.*,i.task_id,t.agent_id,r.response FROM request_replan_jobs j JOIN input_requests i ON i.id=j.request_id JOIN tasks t ON t.id=i.task_id JOIN request_owner_replies r ON r.id=j.reply_id WHERE j.state='queued' AND t.state='waiting' AND i.state NOT IN ('fulfilled','cancelled','superseded') AND NOT EXISTS (SELECT 1 FROM runs active WHERE active.agent_id=t.agent_id AND active.state='running') ORDER BY j.created_at,j.rowid");
      const job=jobs.find(j=>!taskIds||taskIds.includes(String(j.task_id)));if(!job)return null;
      const request=this.request(String(job.request_id));if(request.revision!==job.request_revision){this.write("UPDATE request_replan_jobs SET state='cancelled' WHERE id=?",job.id);return null;}
      const generation=Number(job.generation)+1,leaseUntil=this.now()+120000;
      this.write("UPDATE request_replan_jobs SET state='running',owner_id=?,owner_pid=?,generation=?,lease_until=? WHERE id=?",this.instanceId,process.pid,generation,leaseUntil,job.id);
      return{id:String(job.id),requestId:String(job.request_id),requestRevision:Number(job.request_revision),taskId:String(job.task_id),agentId:String(job.agent_id),response:String(job.response),request:this.view(request),ownerId:this.instanceId,generation,leaseUntil};
    });
  }
  /** Broker guard: repeat before quote/dispatch and inside authoritative effects. */
  authorizeReplan(claim:ReplanClaim):void{
    if(this.closed)fail('closed','The request service is closing.');
    const job=this.row('SELECT * FROM request_replan_jobs WHERE id=?',claim.id),request=this.current(claim.requestId,claim.requestRevision);
    if(!job||job.request_id!==claim.requestId||job.request_revision!==claim.requestRevision||job.state!=='running'||job.owner_id!==this.instanceId||claim.ownerId!==this.instanceId||job.generation!==claim.generation||Number(job.lease_until)<=this.now()||request.task_state!=='waiting'||request.task_id!==claim.taskId||request.agent_id!==claim.agentId)fail('stale_replan','This replan no longer owns the waiting request.');
  }
  renewReplan(claim:ReplanClaim):ReplanClaim{
    return this.tx(()=>{this.authorizeReplan(claim);const leaseUntil=this.now()+120000;this.write('UPDATE request_replan_jobs SET lease_until=? WHERE id=?',leaseUntil,claim.id);return{...claim,leaseUntil};});
  }
  /** Release only this exact attempt; never reset a newer coordinator's replan. */
  releaseReplan(claim:ReplanClaim):boolean{
    return this.tx(()=>{
      const job=this.row('SELECT * FROM request_replan_jobs WHERE id=?',claim.id);
      if(!job||job.request_id!==claim.requestId||job.request_revision!==claim.requestRevision||job.state!=='running'||job.owner_id!==this.instanceId||claim.ownerId!==this.instanceId||job.generation!==claim.generation)return false;
      const request=this.request(claim.requestId);if(request.task_id!==claim.taskId||request.agent_id!==claim.agentId)return false;
      const cancelled=terminal.includes(String(request.task_state))||closedStates.includes(String(request.state))||request.revision!==claim.requestRevision;
      this.write("UPDATE request_replan_jobs SET state=?,owner_id=NULL,owner_pid=NULL,generation=generation+1,lease_until=0,finished_at=? WHERE id=?",cancelled?'cancelled':'queued',cancelled?this.now():null,claim.id);return true;
    });
  }
  completeReplan(claim:ReplanClaim,raw:ReplanResult|unknown):UserRequest[]{
    const result=parseReplanResult(raw);this.tx(()=>{
      this.authorizeReplan(claim);const job=this.row('SELECT * FROM request_replan_jobs WHERE id=?',claim.id)!,request=this.current(claim.requestId,claim.requestRevision);
      if(result.kind==='reduced_scope'){
        if(request.kind!=='files')fail('unsupported_replan','Reduced file scope requires a file request.');
        const slots=this.rows('SELECT * FROM request_slots WHERE request_id=?',request.id);
        if(result.waiveSlotKeys.some(key=>!slots.some(s=>s.slot_key===key&&s.required&&s.state!=='accepted')))fail('unsupported_replan','Only currently missing required slots can be proposed for omission.');
        if(slots.some(s=>s.required&&s.state!=='accepted'&&!result.waiveSlotKeys.includes(String(s.slot_key))))fail('unsupported_replan','The reduced outcome must explicitly account for every unaccepted required slot.');
        const proposalId=randomUUID();
        this.write("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?,'permission_change','Approve a reduced outcome',?,'open',?,?)",proposalId,request.task_id,result.description,`scope:${claim.id}`,this.now());
        const payload={description:result.description,completionCriteria:result.completionCriteria,waiveSlotKeys:result.waiveSlotKeys};
        this.write("INSERT INTO request_details(request_id,kind,spec_json,payload_json,parent_request_id,parent_revision) VALUES (?,'reduced_scope',?,?,?,?)",proposalId,JSON.stringify(result),JSON.stringify(payload),request.id,request.revision);
        this.event('input.reduced_scope_proposed',this.request(proposalId),{parentRequestId:request.id});
      }else{
        this.write("INSERT INTO task_messages(id,task_id,role,content,created_at) VALUES (?,?,'agent',?,?)",randomUUID(),request.task_id,result.message,this.now());
        this.event('input.replan_completed',request,{blockersPreserved:true});
      }
      this.write("UPDATE request_replan_jobs SET state='completed',finished_at=? WHERE id=?",this.now(),job.id);
    });this.changed();return this.list();
  }
  async shutdown(){this.close();await this.draining?.catch(()=>undefined);}
  close(){
    if(this.closed)return;this.closed=true;
    this.options.persistence.transaction(()=>{
      this.write("UPDATE request_validation_jobs SET state='queued',owner_id=NULL,owner_pid=NULL,generation=generation+1,lease_until=0 WHERE state='running' AND owner_id=?",this.instanceId);
      this.write("UPDATE request_replan_jobs SET state='queued',owner_id=NULL,owner_pid=NULL,generation=generation+1,lease_until=0 WHERE state='running' AND owner_id=?",this.instanceId);
    });
  }
}
