import { createHash, randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { RunClaim } from '../coordinator';
import type { TaskState } from '../contracts';
import type { AgentCollaborationContext, AgentInboxMessage, AgentMessageInput, CollaborationPolicy, CollaborationState, PublicationNotice, SharedArtifact, SharedBoardTask, TaskDependency } from '../contracts/collaboration';
import { ArtifactService, FILE_LIMITS } from '../artifacts';
import { Persistence } from '../persistence';
import { ProjectAccess } from '../projects';
import { id, ids, messageInput, parseCollaborationCommand, record } from './validation';

type Row = Record<string,string|number|null>;
const TERMINAL=new Set(['succeeded','failed','cancelled']);
export const COLLABORATION_LIMITS={board:100,inbox:50,publications:50,artifacts:100,messages:2000,messageBytes:4*1024*1024,dependencies:1000,eventBatch:500} as const;
export class CollaborationError extends Error { constructor(readonly code:string,message:string){super(message);this.name='CollaborationError';} }
function fail(code:string,message:string):never{throw new CollaborationError(code,message);}
interface Options {persistence:Persistence;artifacts:ArtifactService;authorize:(claim:RunClaim)=>void;now?:()=>number;onChanged?:()=>void}

/** Trusted coordinator service. Models receive reconstructed references, never raw events or task text. */
export class CollaborationService {
 readonly ready:Promise<void>;
 private closed=false;
 private readonly now:()=>number;
 private readonly pending=new Set<Promise<unknown>>();
 constructor(private readonly options:Options){this.now=options.now||Date.now;this.ready=options.artifacts.ready.then(()=>{if(!this.closed)this.reconcile();});}
 private get db(){return this.options.persistence.db;}
 private get projects(){return new ProjectAccess(this.db);}
 private row(sql:string,...args:SQLInputValue[]):Row|undefined{return this.db.prepare(sql).get(...args) as Row|undefined;}
 private rows(sql:string,...args:SQLInputValue[]):Row[]{return this.db.prepare(sql).all(...args) as Row[];}
 private write(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).run(...args);}
 private open(){if(this.closed)fail('closed','Collaboration is closing.');}
 private tx<T>(fn:()=>T):T{this.open();return this.options.persistence.transaction(fn);}
 private changed(){try{this.options.onChanged?.();}catch{/* UI notification cannot roll back a committed effect. */}}
 private event(type:string,aggregateId:string,revision:number,payload:object){this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)',type,aggregateId,revision,JSON.stringify(payload),this.now());}
 private task(taskId:string):Row{const task=this.row('SELECT * FROM tasks WHERE id=?',id(taskId));if(!task)fail('not_found','The selected task does not exist.');return task;}
 private agent(agentId:string){if(!this.row('SELECT 1 FROM agents WHERE id=?',id(agentId)))fail('not_found','The selected agent does not exist.');}
 private check(claim:RunClaim){this.open();this.options.authorize(claim);}
 private policy(taskId:string):CollaborationPolicy{
  const row=this.row('SELECT * FROM collaboration_policies WHERE task_id=?',taskId);
  return row?{taskId,revision:Number(row.revision),visibility:row.visibility as 'private'|'shared',summary:String(row.summary),peerAgentIds:JSON.parse(String(row.peer_agent_ids))}:{taskId,revision:1,visibility:'private',summary:'',peerAgentIds:[]};
 }
 private visible(taskId:string,agentId:string):boolean{const task=this.task(taskId),policy=this.policy(taskId);return this.projects.canSeeTask(agentId,taskId)&&(task.agent_id===agentId||(policy.visibility==='shared'&&policy.peerAgentIds.includes(agentId)));}
 private shared(versionId:string,viewer?:string):SharedArtifact{
  const row=this.row(`SELECT v.*,a.display_name,a.visibility,a.owner_agent_id,a.producer_task_id FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.id=?`,id(versionId));
  if(!row||row.visibility!=='shared')fail('permission_denied','Only an explicitly shared file version can be referenced or consumed.');
  if(viewer&&!this.projects.canReadVersion(viewer,versionId))fail('permission_denied','This file belongs to another project.');
  if(row.status!=='ready')fail('artifact_unavailable','This shared version is missing or changed. Choose a verified version.');
  const producer=row.producer_task_id===null?null:String(row.producer_task_id);
  return{versionId:String(row.id),artifactId:String(row.artifact_id),version:Number(row.version_number),displayName:String(row.display_name),bytes:Number(row.bytes),sha256:String(row.sha256),format:String(row.format),mime:String(row.mime),createdAt:Number(row.created_at),producerTaskId:producer&&(!viewer||this.visible(producer,viewer))?producer:null,ownerAgentId:row.owner_agent_id===null?null:String(row.owner_agent_id)};
 }
 private sharedList(viewer?:string,limit:number=COLLABORATION_LIMITS.artifacts):SharedArtifact[]{return viewer?this.projects.sharedVersionIds(viewer,limit).map(versionId=>this.shared(versionId,viewer)):this.rows("SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.visibility='shared' AND v.status='ready' ORDER BY v.created_at DESC,v.rowid DESC LIMIT ?",limit).map(r=>this.shared(String(r.id)));}
 private dependency(row:Row):TaskDependency{
  const parent=this.task(String(row.depends_on_task_id));let status:TaskDependency['status']='pending';
  if(parent.state==='failed')status='upstream_failed';else if(parent.state==='cancelled')status='upstream_cancelled';
  else if(parent.state==='succeeded'){
   status='ready';if(row.required_artifact_version!==null){const version=this.row("SELECT v.status,a.visibility,a.producer_task_id FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.id=?",row.required_artifact_version);if(!version||version.status!=='ready'||version.visibility!=='shared'||version.producer_task_id!==parent.id)status='artifact_unavailable';}
  }
  const explanations={pending:'Waiting for the upstream task to succeed.',ready:'The upstream task and required shared version are ready.',upstream_failed:'The upstream task failed. The owner must revise or remove this dependency.',upstream_cancelled:'The upstream task was cancelled. The owner must revise or remove this dependency.',artifact_unavailable:'The required exact shared version is unavailable. The owner must choose a verified version.'};
  return{taskId:String(row.task_id),dependsOnTaskId:String(row.depends_on_task_id),requiredVersionId:row.required_artifact_version===null?null:String(row.required_artifact_version),status,explanation:explanations[status]};
 }
 private dependencies(taskId?:string):TaskDependency[]{return this.rows('SELECT * FROM task_dependencies'+(taskId?' WHERE task_id=?':'')+' ORDER BY task_id,depends_on_task_id',...(taskId?[taskId]:[])).map(r=>this.dependency(r));}
 dependencyBlocker(taskId:string):string|null{
  const deps=this.dependencies(taskId);if(deps.some(d=>d.status==='upstream_failed'||d.status==='upstream_cancelled'))return'dependency_failed';
  if(deps.some(d=>d.status==='artifact_unavailable'))return'dependency_artifact';return deps.some(d=>d.status!=='ready')?'dependency':null;
 }
 private blocked(taskId:string):string|null{const input=this.row("SELECT type FROM input_requests WHERE task_id=? AND blocking=1 AND state NOT IN ('fulfilled','cancelled','superseded') ORDER BY created_at,id LIMIT 1",taskId);return input?String(input.type):this.dependencyBlocker(taskId);}
 private board(viewer?:string):SharedBoardTask[]{
  return this.rows("SELECT t.*,a.name FROM tasks t JOIN agents a ON a.id=t.agent_id JOIN collaboration_policies p ON p.task_id=t.id WHERE p.visibility='shared' ORDER BY t.updated_at DESC,t.id").filter(row=>!viewer||this.visible(String(row.id),viewer)).slice(0,COLLABORATION_LIMITS.board).map(row=>({taskId:String(row.id),agentId:String(row.agent_id),agentName:String(row.name),summary:this.policy(String(row.id)).summary,state:row.state as TaskState,revision:Number(row.revision),dependencies:this.dependencies(String(row.id)).filter(d=>!viewer||this.visible(d.dependsOnTaskId,viewer)),publishedVersionIds:this.rows("SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.producer_task_id=? AND a.visibility='shared' AND v.status='ready' ORDER BY v.created_at DESC LIMIT 32",row.id).map(v=>String(v.id))}));
 }
 private message(row:Row):AgentInboxMessage{return{id:String(row.id),senderAgentId:String(row.sender),recipientAgentId:String(row.recipient),sourceTaskId:String(row.source_task_id),origin:row.origin as 'owner'|'agent',kind:row.kind as AgentInboxMessage['kind'],body:String(row.shareable_body),taskIds:JSON.parse(String(row.task_refs)),versionIds:JSON.parse(String(row.artifact_refs)),createdAt:Number(row.created_at),readAt:row.read_at===null?null:Number(row.read_at)};}
 private messageVisible(row:Row,agentId:string){
  if(row.recipient!==agentId||row.source_task_id===null||!this.visible(String(row.source_task_id),agentId))return false;
  return (JSON.parse(String(row.task_refs)) as string[]).every(taskId=>this.visible(taskId,agentId))&&(JSON.parse(String(row.artifact_refs)) as string[]).every(versionId=>this.projects.canReadVersion(agentId,versionId));
 }
 private inbox(agentId?:string):AgentInboxMessage[]{
  const rows=this.rows("SELECT * FROM agent_messages WHERE source_task_id IS NOT NULL"+(agentId?' AND recipient=?':'')+' ORDER BY (read_at IS NULL) DESC,created_at DESC,rowid DESC',...(agentId?[agentId]:[]));
  return rows.filter(row=>!agentId||this.messageVisible(row,agentId)).slice(0,agentId?COLLABORATION_LIMITS.inbox:COLLABORATION_LIMITS.messages).map(row=>this.message(row));
 }
 private publications(agentId?:string):PublicationNotice[]{
  return this.rows("SELECT p.* FROM collaboration_publications p JOIN artifact_versions v ON v.id=p.version_id JOIN artifacts a ON a.id=v.artifact_id WHERE v.status='ready' AND a.visibility='shared'"+(agentId?' AND p.recipient_agent_id=?':'')+' ORDER BY (p.read_at IS NULL) DESC,p.created_at DESC,p.id DESC LIMIT ?',...(agentId?[agentId]:[]),agentId?COLLABORATION_LIMITS.publications:500).map(row=>({id:String(row.id),eventId:Number(row.event_id),recipientAgentId:String(row.recipient_agent_id),versionId:String(row.version_id),artifact:this.shared(String(row.version_id),agentId),createdAt:Number(row.created_at),readAt:row.read_at===null?null:Number(row.read_at)}));
 }
 state():CollaborationState{this.open();return{policies:this.rows('SELECT id FROM tasks ORDER BY created_at,id').map(t=>this.policy(String(t.id))),board:this.board(),inbox:this.inbox(),publications:this.publications(),dependencies:this.dependencies(),sharedArtifacts:this.sharedList(undefined,FILE_LIMITS.versions)};}
 context(claim:RunClaim):AgentCollaborationContext{
  this.check(claim);this.reconcile();this.check(claim);
  return{policies:[this.policy(claim.taskId)],board:this.board(claim.agentId),inbox:this.inbox(claim.agentId),publications:this.publications(claim.agentId),dependencies:this.dependencies(claim.taskId).filter(d=>this.visible(d.dependsOnTaskId,claim.agentId)),sharedArtifacts:this.sharedList(claim.agentId),limits:{board:COLLABORATION_LIMITS.board,inbox:COLLABORATION_LIMITS.inbox,publications:COLLABORATION_LIMITS.publications,artifacts:COLLABORATION_LIMITS.artifacts}};
 }
 discover(claim:RunClaim):SharedArtifact[]{this.check(claim);return this.sharedList(claim.agentId);}
 private setPolicy(command:Extract<ReturnType<typeof parseCollaborationCommand>,{type:'collaboration.policy'}>){
  const task=this.task(command.taskId),current=this.policy(command.taskId);if(current.revision!==command.revision)fail('stale_revision','This collaboration policy changed. Refresh before saving.');
  for(const peer of command.peerAgentIds){this.agent(peer);this.projects.same(this.projects.agent(peer),this.projects.task(command.taskId));if(peer===task.agent_id)fail('invalid_policy','Choose other agents as collaborators.');}
  this.write('INSERT INTO collaboration_policies(task_id,revision,visibility,summary,peer_agent_ids,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,visibility=excluded.visibility,summary=excluded.summary,peer_agent_ids=excluded.peer_agent_ids,updated_at=excluded.updated_at',command.taskId,current.revision+1,command.visibility,command.summary,JSON.stringify(command.peerAgentIds),this.now());
  this.write('UPDATE tasks SET sharing_policy=?,revision=revision+1,updated_at=? WHERE id=?',command.visibility,this.now(),command.taskId);
  this.event('collaboration.policy_changed',command.taskId,current.revision+1,{taskId:command.taskId});
 }
 private addDependency(taskId:string,parentId:string,requiredVersionId:string|null){
  this.task(taskId);this.task(parentId);if(taskId===parentId)fail('dependency_cycle','A task cannot depend on itself.');
  this.projects.same(this.projects.task(taskId),this.projects.task(parentId));
  if(requiredVersionId!==null){const version=this.shared(requiredVersionId);if(version.producerTaskId!==parentId)fail('invalid_dependency','The required shared version must be produced by that upstream task.');}
  const existing=this.row('SELECT * FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?',taskId,parentId);
  if(existing){if(existing.required_artifact_version!==requiredVersionId)fail('conflict','Remove the existing dependency before choosing a different version.');return;}
  if(Number(this.row('SELECT COUNT(*) AS n FROM task_dependencies')!.n)>=COLLABORATION_LIMITS.dependencies)fail('capacity_limit','The saved dependency limit was reached. Remove unused dependencies first.');
  try{this.write('INSERT INTO task_dependencies(task_id,depends_on_task_id,required_artifact_version) VALUES (?,?,?)',taskId,parentId,requiredVersionId);}catch(error){if(String(error).includes('dependency_cycle'))fail('dependency_cycle','This dependency would create a cycle.');throw error;}
  this.event('dependency.added',taskId,Number(this.task(taskId).revision),{taskId,dependsOnTaskId:parentId,requiredVersionId});
 }
 private editable(taskId:string){const task=this.task(taskId);if(TERMINAL.has(String(task.state)))fail('invalid_state','Completed or cancelled tasks cannot accept new collaboration work.');if(['running','pausing','recovering'].includes(String(task.state)))fail('task_busy','Pause this task before changing its dependencies.');return task;}
 private sendLocked(taskId:string,input:AgentMessageInput,origin:'owner'|'agent',body:string):AgentInboxMessage{
  const task=this.task(taskId);if(TERMINAL.has(String(task.state)))fail('invalid_state','Completed or cancelled tasks cannot send new messages.');this.agent(input.recipientAgentId);
  this.projects.same(this.projects.task(taskId),this.projects.agent(input.recipientAgentId));
  const policy=this.policy(taskId);if(policy.visibility!=='shared'||!policy.peerAgentIds.includes(input.recipientAgentId))fail('permission_denied','The owner must share this task with the recipient before a handoff.');
  for(const ref of input.taskIds)if(!this.visible(ref,input.recipientAgentId)||!this.visible(ref,String(task.agent_id)))fail('permission_denied','Every task reference must be visible to both agents.');
  for(const version of input.versionIds){this.shared(version,String(task.agent_id));this.shared(version,input.recipientAgentId);}
  const payload=JSON.stringify({recipientAgentId:input.recipientAgentId,kind:input.kind,taskIds:input.taskIds,versionIds:input.versionIds,body}),hash=createHash('sha256').update(payload).digest('hex');
  const existing=this.row('SELECT * FROM agent_messages WHERE source_task_id=? AND origin=? AND idempotency_key=?',taskId,origin,input.idempotencyKey);
  if(existing){if(existing.payload_hash!==hash)fail('idempotency_conflict','This message key was already used for different references.');return this.message(existing);}
  const counts=this.row('SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(shareable_body AS BLOB))+length(CAST(task_refs AS BLOB))+length(CAST(artifact_refs AS BLOB))),0) AS bytes FROM agent_messages')!;
  if(Number(counts.n)>=COLLABORATION_LIMITS.messages||Number(counts.bytes)+Buffer.byteLength(payload)>COLLABORATION_LIMITS.messageBytes)fail('capacity_limit','The saved collaboration inbox limit was reached.');
  const messageId=randomUUID();this.write("INSERT INTO agent_messages(id,sender,recipient,task_refs,shareable_body,artifact_refs,delivery_status,created_at,source_task_id,origin,kind,idempotency_key,payload_hash) VALUES (?,?,?,?,?,?,'delivered',?,?,?,?,?,?)",messageId,task.agent_id,input.recipientAgentId,JSON.stringify(input.taskIds),body,JSON.stringify(input.versionIds),this.now(),taskId,origin,input.kind,input.idempotencyKey,hash);
  this.event('message.delivered',messageId,1,{messageId,senderAgentId:task.agent_id,recipientAgentId:input.recipientAgentId,origin});return this.message(this.row('SELECT * FROM agent_messages WHERE id=?',messageId)!);
 }
 send(claim:RunClaim,raw:unknown):AgentInboxMessage{
  const input=messageInput(raw);const result=this.tx(()=>{this.check(claim);const descriptions={handoff:'Shared references are ready for this handoff.',update:'The agent shared a reference update.',question:'The agent requests attention to these shared references.'};return this.sendLocked(claim.taskId,input,'agent',descriptions[input.kind]);});this.changed();return result;
 }
 private ackLocked(agentId:string,messageIds:string[],publicationIds:string[]){
  this.agent(agentId);
  for(const messageId of messageIds){const row=this.row('SELECT * FROM agent_messages WHERE id=?',messageId);if(!row||row.recipient!==agentId)fail('permission_denied','Only the recipient can acknowledge this inbox item.');}
  for(const publicationId of publicationIds){if(!this.row('SELECT 1 FROM collaboration_publications WHERE id=? AND recipient_agent_id=?',publicationId,agentId))fail('permission_denied','Only the recipient can acknowledge this publication.');}
  for(const messageId of messageIds)this.write("UPDATE agent_messages SET read_at=COALESCE(read_at,?),delivery_status='read' WHERE id=?",this.now(),messageId);
  for(const publicationId of publicationIds)this.write('UPDATE collaboration_publications SET read_at=COALESCE(read_at,?) WHERE id=?',this.now(),publicationId);
 }
 ack(claim:RunClaim,messageIds:unknown,publicationIds:unknown=[]):{acknowledged:number}{const messages=ids(messageIds,100),publications=ids(publicationIds,100);this.tx(()=>{this.check(claim);this.ackLocked(claim.agentId,messages,publications);});this.changed();return{acknowledged:messages.length+publications.length};}
 private async consumeInternal(taskId:string,versionId:string,claim?:RunClaim):Promise<SharedArtifact&{pinned:true;alreadyPinned:boolean}>{
  this.open();const task=this.task(taskId);if(TERMINAL.has(String(task.state)))fail('invalid_state','Completed or cancelled tasks cannot accept new inputs.');if(claim)this.check(claim);
  const before=this.shared(versionId,String(task.agent_id));await this.options.artifacts.readForValidation(String(task.agent_id),versionId,false);
  const result=this.tx(()=>{
   if(claim)this.check(claim);const current=this.task(taskId);if(TERMINAL.has(String(current.state)))fail('invalid_state','The task stopped before the shared input could be pinned.');
   const artifact=this.shared(versionId,String(task.agent_id));if(artifact.sha256!==before.sha256)fail('artifact_unavailable','The shared version changed during verification.');
   if(this.row('SELECT 1 FROM code_workspace_leases WHERE task_id=?',taskId))fail('workspace_busy','Wait for code to finish before consuming a new shared input.');
   const previous=claim?this.row('SELECT b.version_id FROM run_artifact_bindings b JOIN artifact_versions v ON v.id=b.version_id WHERE b.run_id=? AND v.artifact_id=? AND b.version_id<>?',claim.runId,artifact.artifactId,versionId):undefined;
   if(previous)fail('version_pinned','This run already uses another immutable version of that file. Pause and explicitly update the task for a future run.');
   const pinned=!!this.row('SELECT 1 FROM task_artifacts WHERE task_id=? AND version_id=?',taskId,versionId);
   const counts=this.row("SELECT COUNT(*) AS n,COALESCE(SUM(v.bytes),0) AS bytes FROM task_artifacts b JOIN artifact_versions v ON v.id=b.version_id WHERE b.task_id=? AND b.role='input'",taskId)!;
   if(!pinned&&(Number(counts.n)>=4096||Number(counts.bytes)+artifact.bytes>FILE_LIMITS.workspace))fail('capacity_limit','The task input limit is 512 MiB and 4,096 files.');
   // Explicit owner updates apply after the active run releases its prior version.
   if(!claim){
    if(this.row("SELECT 1 FROM runs r JOIN run_artifact_bindings b ON b.run_id=r.id JOIN artifact_versions v ON v.id=b.version_id WHERE r.task_id=? AND r.state='running' AND v.artifact_id=? AND v.id<>?",taskId,artifact.artifactId,versionId))fail('version_pinned','Pause the task before updating an input version that its active run still uses.');
    this.write("DELETE FROM task_artifacts WHERE task_id=? AND role='input' AND version_id IN (SELECT id FROM artifact_versions WHERE artifact_id=? AND id<>?)",taskId,artifact.artifactId,versionId);
   }
   this.write("INSERT OR IGNORE INTO task_artifacts(task_id,version_id,role,created_at) VALUES (?,?,'input',?)",taskId,versionId,this.now());
   if(claim)this.write('INSERT OR IGNORE INTO run_artifact_bindings(run_id,version_id) VALUES (?,?)',claim.runId,versionId);
   const receipt=this.write('INSERT OR IGNORE INTO collaboration_consumptions(task_id,version_id,run_id,created_at) VALUES (?,?,?,?)',taskId,versionId,claim?.runId||null,this.now());
   if(receipt.changes)this.event('artifact.consumed',taskId,Number(current.revision),{taskId,versionId});
   return{...artifact,pinned:true as const,alreadyPinned:pinned};
  });this.changed();return result;
 }
 consume(claim:RunClaim,raw:unknown){const value=record(raw,['versionId']),versionId=id(value.versionId);this.check(claim);return this.track(this.consumeInternal(claim.taskId,versionId,claim));}
 private track<T>(promise:Promise<T>):Promise<T>{this.pending.add(promise);promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise));return promise;}
 waitFor(claim:RunClaim,raw:unknown,onCommit?:(result:{waiting:boolean;dependency:TaskDependency})=>void):{waiting:boolean;dependency:TaskDependency}{
  const value=record(raw,['dependsOnTaskId','requiredVersionId'],['requiredVersionId']),parentId=id(value.dependsOnTaskId),versionId=value.requiredVersionId===undefined||value.requiredVersionId===null?null:id(value.requiredVersionId);
  const result=this.tx(()=>{
   this.check(claim);if(!this.visible(parentId,claim.agentId))fail('permission_denied','This upstream task is not shared with the agent.');
   this.addDependency(claim.taskId,parentId,versionId);const dependency=this.dependency(this.row('SELECT * FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?',claim.taskId,parentId)!);
   const reason=this.blocked(claim.taskId);
   const callback:unknown=onCommit?.({waiting:!!reason,dependency});if(callback&&typeof callback==='object'&&'then'in callback){void Promise.resolve(callback).catch(()=>{});fail('invalid_callback','The checkpoint callback must finish in the transaction.');}
   if(reason){
    this.write("UPDATE runs SET state='waiting',finished_at=? WHERE id=?",this.now(),claim.runId);
    this.write("UPDATE tasks SET state='waiting',waiting_reason=?,revision=revision+1,generation=generation+1,updated_at=? WHERE id=?",reason,this.now(),claim.taskId);
    this.event('task.state_changed',claim.taskId,Number(this.task(claim.taskId).revision),{state:'waiting',waitingReason:reason,generation:Number(this.task(claim.taskId).generation)});
   }
   return{waiting:!!reason,dependency};
  });this.changed();return result;
 }
 /** Domain events are delivered at least once; unique recipient/version receipts make publication replay harmless. */
 reconcile():void{
  this.open();let changed=false;
  this.tx(()=>{
   const cursor=Number(this.row("SELECT last_event_id FROM event_cursors WHERE consumer_id='collaboration:publications:v1'")?.last_event_id||0);
   const events=this.rows('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?',cursor,COLLABORATION_LIMITS.eventBatch);
   for(const event of events){
    if(event.type!=='artifact.published'&&event.type!=='artifact.imported')continue;
    let payload:Record<string,unknown>;try{payload=JSON.parse(String(event.payload));}catch{continue;}
    if(!payload||typeof payload.versionId!=='string')continue;
    const version=this.row("SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.id=? AND a.visibility='shared' AND v.status='ready'",payload.versionId);if(!version)continue;
    for(const agent of this.rows('SELECT id FROM agents WHERE enabled=1')){
     if(!this.projects.canReadVersion(String(agent.id),String(version.id)))continue;
     const receipt=this.write('INSERT OR IGNORE INTO collaboration_publications(id,event_id,recipient_agent_id,version_id,created_at) VALUES (?,?,?,?,?)',randomUUID(),event.id,agent.id,version.id,event.created_at);if(receipt.changes)changed=true;
    }
   }
   if(events.length)this.write("INSERT INTO event_cursors(consumer_id,last_event_id) VALUES ('collaboration:publications:v1',?) ON CONFLICT(consumer_id) DO UPDATE SET last_event_id=excluded.last_event_id",events.at(-1)!.id);
   const dependencies=this.dependencies();
   for(const dependency of dependencies){
    const prior=this.row('SELECT status FROM collaboration_dependency_status WHERE task_id=? AND depends_on_task_id=?',dependency.taskId,dependency.dependsOnTaskId);
    if(prior?.status!==dependency.status){
     this.write('INSERT INTO collaboration_dependency_status(task_id,depends_on_task_id,status,updated_at) VALUES (?,?,?,?) ON CONFLICT(task_id,depends_on_task_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at',dependency.taskId,dependency.dependsOnTaskId,dependency.status,this.now());
     this.event('dependency.status_changed',dependency.taskId,Number(this.task(dependency.taskId).revision),dependency);changed=true;
    }
   }
   // Include former dependents so removing the final edge can release a waiting task.
   const taskIds=new Set([...dependencies.map(d=>d.taskId),...this.rows("SELECT id FROM tasks WHERE waiting_reason IN ('dependency','dependency_failed','dependency_artifact')").map(t=>String(t.id))]);
   for(const taskId of taskIds){
    const task=this.task(taskId);if(TERMINAL.has(String(task.state))||['running','pausing','recovering'].includes(String(task.state)))continue;
    const reason=this.blocked(taskId);let state=String(task.state);
    if(state==='queued'&&reason)state='waiting';else if(state==='waiting'&&!reason)state='queued';
    if(state!==task.state||reason!==task.waiting_reason){
     this.write('UPDATE tasks SET state=?,waiting_reason=?,revision=revision+1,updated_at=? WHERE id=?',state,reason,this.now(),taskId);
     this.event(state===task.state?'task.blockers_changed':'task.state_changed',taskId,Number(task.revision)+1,{state,waitingReason:reason,generation:Number(task.generation)});changed=true;
    }
   }
  });if(changed)this.changed();
 }
 async handle(raw:unknown):Promise<CollaborationState>{
  await this.ready;this.open();const command=parseCollaborationCommand(raw);
  if(command.type==='collaboration.consume')await this.track(this.consumeInternal(command.taskId,command.versionId));
  else if(command.type!=='collaboration.state')this.tx(()=>{
   if(command.type==='collaboration.policy')this.setPolicy(command);
   else if(command.type==='collaboration.dependency.add'){this.editable(command.taskId);this.addDependency(command.taskId,command.dependsOnTaskId,command.requiredVersionId);}
   else if(command.type==='collaboration.dependency.remove'){this.editable(command.taskId);const removed=this.write('DELETE FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?',command.taskId,command.dependsOnTaskId);if(removed.changes)this.event('dependency.removed',command.taskId,Number(this.task(command.taskId).revision),{taskId:command.taskId,dependsOnTaskId:command.dependsOnTaskId});}
   else if(command.type==='collaboration.send')this.sendLocked(command.taskId,messageInput({recipientAgentId:command.recipientAgentId,kind:command.kind,taskIds:command.taskIds,versionIds:command.versionIds,idempotencyKey:command.idempotencyKey}),'owner',command.body);
   else if(command.type==='collaboration.ack')this.ackLocked(command.agentId,command.messageIds,command.publicationIds||[]);
  });
  this.reconcile();if(command.type!=='collaboration.state')this.changed();return this.state();
 }
 async shutdown(){this.closed=true;await Promise.allSettled([...this.pending]);}
 close(){this.closed=true;}
}
