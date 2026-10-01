import {createHash,randomUUID} from 'node:crypto';
import type {SQLInputValue} from 'node:sqlite';
import type {Persistence} from '../persistence';
import type {ArtifactService} from '../artifacts';
import type {LiveCommand,LiveLimits,LivePolicy} from '../contracts/live';
import type {Routine,RoutineState,RoutineTiming} from '../contracts/routines';
import {identity,number,record,string,parseLimits,parsePolicy} from '../contracts/live-validation';
import {nextOccurrence,localParts} from './timing';
import {RoutineAlertService} from './alerts';
type Row=Record<string,string|number|null>;
type Definition={command:Extract<LiveCommand,{type:'live.createTask'}>;workflow:Row;inputs:string[];slots:{slot_key:string;version_id:string}[];resultVersionId:string};
export class RoutineError extends Error{constructor(readonly code:string,message:string){super(message);}}
const fail=(message:string):never=>{throw new RoutineError('routine_unavailable',message);};
export class RoutineService {
 private work:Promise<void>|null=null;private suspended=false;
 private readonly ownerId=randomUUID();
 private readonly alerts:RoutineAlertService;
 constructor(private options:{persistence:Persistence;artifacts:ArtifactService;assertReuseSource?:(taskId:string)=>void;createTask:(command:Definition['command'],callback:(id:string)=>void)=>string;preflight:(id:string)=>Promise<void>;start:(id:string)=>Promise<unknown>;now?:()=>number}){this.alerts=new RoutineAlertService(options);}
 private get db(){return this.options.persistence.db;}private now(){return(this.options.now||Date.now)();}
 private row(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).get(...args) as Row|undefined;}
 private rows(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).all(...args) as Row[];}
 private write(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).run(...args);}
 private event(type:string,id:string,taskId?:string){this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,1,?,?)',type,id,JSON.stringify({routineId:id,taskId}),this.now());}
 private display(r:Row):Routine {const d=JSON.parse(String(r.definition_json)) as Definition;return{id:String(r.id),title:String(r.title),sourceTaskId:String(r.source_task_id),agentId:String(r.agent_id),enabled:Boolean(r.enabled),timing:JSON.parse(String(r.timing_json)),nextRun:Number(r.next_run),expiresAt:Number(r.expires_at),monthlyCapUsd:Number(r.monthly_cap_microusd)/1e6,limits:d.command.limits,lastError:r.last_error===null?null:String(r.last_error),createdAt:Number(r.created_at),alertsEnabled:this.alerts.enabled(String(r.id))};}
 state():RoutineState {return{...this.alerts.state(),routines:this.rows('SELECT * FROM routines ORDER BY created_at DESC').map(r=>this.display(r)),occurrences:this.rows(`SELECT o.*,l.cost_microusd,t.state AS task_state FROM routine_occurrences o LEFT JOIN live_task_config l ON l.task_id=o.task_id LEFT JOIN tasks t ON t.id=o.task_id ORDER BY o.created_at DESC,o.id LIMIT 200`).map(r=>({id:String(r.id),routineId:String(r.routine_id),dueAt:Number(r.due_at),taskId:r.task_id===null?null:String(r.task_id),state:r.state==='dispatched'?String(r.task_state):String(r.state),reason:r.reason===null?null:String(r.reason),costUsd:Number(r.cost_microusd||0)/1e6,...(r.task_id?{comparison:this.alerts.comparison(String(r.task_id))}:{})})),eligible:this.rows(`SELECT t.id,t.objective,l.result_version_id FROM tasks t JOIN live_task_config l ON l.task_id=t.id JOIN result_reviews r ON r.task_id=t.id AND r.version_id=l.result_version_id JOIN workflow_task_origins w ON w.task_id=t.id WHERE t.state='succeeded' AND r.state='accepted' AND w.definition_json IS NOT NULL AND json_extract(l.policy_json,'$.mode')='read_only_browser' ORDER BY t.updated_at DESC LIMIT 100`).map(r=>({taskId:String(r.id),title:String(r.objective),versionId:String(r.result_version_id)}))};}
 handle(raw:unknown):RoutineState {return this.options.persistence.transaction(()=>this.handleCommand(raw));}
 private handleCommand(raw:unknown):RoutineState {
 const input=record(raw,['type','sourceTaskId','title','timing','expiresAt','monthlyCapUsd','limits','idempotencyKey','id','enabled','alertsEnabled']);
 if(input.type==='routines.state'){record(input,['type']);return this.state();}
 if(this.suspended)fail('Workspace recovery is in progress.');
 if(input.type==='routines.acknowledgeAlert'){record(input,['type','id']);this.alerts.acknowledge(identity(input.id));this.event('routine.alert_reviewed',identity(input.id));return this.state();}
 if(input.type==='routines.setAlerts'){record(input,['type','id','enabled']);if(typeof input.enabled!=='boolean')fail('Choose whether to show change alerts.');this.alerts.setEnabled(identity(input.id),input.enabled as boolean);this.event('routine.alerts_updated',identity(input.id));return this.state();}
 if(input.type==='routines.pauseAll'){record(input,['type']);this.pauseAll();this.event('routines.paused','all');return this.state();}
 if(input.type==='routines.setEnabled') {record(input,['type','id','enabled']);const id=identity(input.id);if(typeof input.enabled!=='boolean')fail('Choose enabled or paused.');const row=this.row('SELECT * FROM routines WHERE id=?',id);if(!row)fail('This routine no longer exists.');if(input.enabled&&Number(row!.expires_at)<=this.now())fail('This routine has expired. Create a new reviewed schedule.');this.write('UPDATE routines SET enabled=?,next_run=?,last_error=NULL WHERE id=?',input.enabled?1:0,nextOccurrence(this.now(),JSON.parse(String(row!.timing_json))),id);if(!input.enabled)this.write('UPDATE routine_preparation_claims SET lease_until=0 WHERE occurrence_id IN (SELECT id FROM routine_occurrences WHERE routine_id=?)',id);this.event('routine.updated',id);return this.state();}
 if(input.type!=='routines.create')fail('Choose a supported routine action.');
 record(input,['type','sourceTaskId','title','timing','expiresAt','monthlyCapUsd','limits','idempotencyKey','alertsEnabled']);
 if(input.alertsEnabled!==undefined&&typeof input.alertsEnabled!=='boolean')fail('Choose whether to show change alerts.');
 const key=identity(input.idempotencyKey),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex'),existing=this.row('SELECT request_hash FROM routines WHERE idempotency_key=?',key);if(existing){if(existing.request_hash!==hash)fail('This save belongs to a different schedule.');return this.state();}
 if(Number(this.row('SELECT count(*) AS n FROM routines')!.n)>=50)fail('The saved routine limit is 50.');
 const sourceId=identity(input.sourceTaskId);this.options.assertReuseSource?.(sourceId);const title=string(input.title,100),limits=parseLimits(input.limits),timingInput=record(input.timing,['timezone','hour','minute','weekdays']);
 const timezone=string(timingInput.timezone,80);try{localParts(this.now(),timezone);}catch{return fail('Choose a valid timezone.');}
 if(!Array.isArray(timingInput.weekdays)||!timingInput.weekdays.length||timingInput.weekdays.length>7)fail('Select at least one weekday.');
 const weekdays=[...new Set((timingInput.weekdays as unknown[]).map(d=>number(d,0,6)))];if(weekdays.some(d=>!Number.isInteger(d)))fail('Invalid weekday.');
 const timing:RoutineTiming={timezone,hour:number(timingInput.hour,0,23),minute:number(timingInput.minute,0,59),weekdays};if(!Number.isInteger(timing.hour)||!Number.isInteger(timing.minute))fail('Choose a whole minute.');
 const expiresAt=number(input.expiresAt,this.now()+60000,this.now()+366*86400000),monthlyCap=number(input.monthlyCapUsd,0.01,1000,false);
 if(limits.maxCostUsd>monthlyCap)fail('The monthly cap must cover one run.');
 const source=this.row(`SELECT t.*,l.model,l.policy_json,l.result_version_id,l.limits_json FROM tasks t JOIN live_task_config l ON l.task_id=t.id JOIN result_reviews r ON r.task_id=t.id AND r.version_id=l.result_version_id WHERE t.id=? AND t.state='succeeded' AND r.state='accepted'`,sourceId);
 if(!source)fail('Accept a completed result before scheduling it.');
 const policy=parsePolicy(JSON.parse(String(source!.policy_json)));if(policy.mode!=='read_only_browser')fail('Local routines currently support reviewed read-only website and mail jobs.');
 const originalLimits=JSON.parse(String(source!.limits_json)) as LiveLimits;
 if(Object.keys(limits).some(k=>limits[k as keyof LiveLimits]>originalLimits[k as keyof LiveLimits]))fail('Scheduled limits cannot exceed the reviewed run.');
 const workflow=this.row('SELECT * FROM workflow_task_origins WHERE task_id=? AND definition_json IS NOT NULL',sourceId);if(!workflow)fail('Use a task with a saved versioned workflow.');
 const inputs=this.rows("SELECT version_id FROM task_artifacts WHERE task_id=? AND role='input'",sourceId).map(r=>String(r.version_id));if(inputs.length>32)fail('A routine supports at most 32 pinned input versions.');
 const slots=this.rows('SELECT slot_key,version_id FROM workflow_input_assignments WHERE task_id=?',sourceId) as {slot_key:string;version_id:string}[];
 const definition:Definition={command:{type:'live.createTask',agentId:String(source!.agent_id),objective:String(source!.objective),completionCriteria:String(source!.completion_criteria),model:String(source!.model),policy,limits},workflow:workflow!,inputs,slots,resultVersionId:String(source!.result_version_id)};
 const id=randomUUID();this.write('INSERT INTO routines VALUES (?,?,?,?,1,?,?,?,?,?,NULL,?,?,?)',id,title,sourceId,source!.agent_id,JSON.stringify(timing),nextOccurrence(this.now(),timing),expiresAt,Math.round(monthlyCap*1e6),JSON.stringify(definition),this.now(),key,hash);this.alerts.setEnabled(id,input.alertsEnabled===true);this.event('routine.created',id);return this.state();
 }
 tick(){if(this.suspended||this.work)return;this.work=this.iterate().catch(()=>{}).finally(()=>{this.work=null;});}
 async drain(){await this.work;}
 async suspend(){this.suspended=true;await this.drain();}
 resume(){this.suspended=false;}
 pauseAll(){this.write('UPDATE routines SET enabled=0');this.write('UPDATE routine_preparation_claims SET lease_until=0');}
 blockingReason(taskId:string):string|null{
  const row=this.row("SELECT o.state,r.enabled,r.expires_at,c.lease_until,c.owner_pid FROM routine_occurrences o JOIN routines r ON r.id=o.routine_id LEFT JOIN routine_preparation_claims c ON c.occurrence_id=o.id WHERE o.task_id=? AND o.state IN ('preparing','blocked','dispatching')",taskId);
  if(!row)return null;
  if(row.state==='dispatching'&&row.enabled===1&&Number(row.expires_at)>this.now()&&this.claimAlive(row)&&!this.suspended)return null;
  return 'Open Routines to inspect this run. Its inputs, approval or setup did not finish.';
 }
 private claimAlive(row:Row):boolean{
  if(Number(row.lease_until)<=this.now()||!Number.isSafeInteger(Number(row.owner_pid))||Number(row.owner_pid)<=0)return false;
  try{process.kill(Number(row.owner_pid),0);return true;}catch{return false;}
 }
 private assertPreparation(occurrence:string,routineId:string){
  const row=this.row('SELECT c.*,r.enabled,r.expires_at,r.source_task_id,r.definition_json,o.state FROM routine_preparation_claims c JOIN routine_occurrences o ON o.id=c.occurrence_id JOIN routines r ON r.id=o.routine_id WHERE c.occurrence_id=? AND o.routine_id=?',occurrence,routineId);
  if(this.suspended||!row||row.owner_id!==this.ownerId||Number(row.lease_until)<=this.now()||!['preparing','dispatching'].includes(String(row.state))||row.enabled!==1||Number(row.expires_at)<=this.now())fail('Routine was paused, expired or lost its preparation lease before dispatch.');
  const definition=JSON.parse(String(row!.definition_json)) as Definition;
  if(!this.row("SELECT 1 FROM result_reviews WHERE task_id=? AND version_id=? AND state='accepted'",row!.source_task_id,definition.resultVersionId))fail('The source result is no longer accepted.');
 }
 private reconcilePreparation(){
  this.options.persistence.transaction(()=>{
   for(const row of this.rows("SELECT o.id,o.routine_id,c.owner_id,c.owner_pid,c.lease_until FROM routine_occurrences o LEFT JOIN routine_preparation_claims c ON c.occurrence_id=o.id WHERE o.state IN ('preparing','dispatching')")){
    if(row.owner_id&&this.claimAlive(row))continue;
    this.write("UPDATE routine_occurrences SET state='blocked',reason='Preparation or dispatch was interrupted. Review this occurrence; it will not replay automatically.' WHERE id=?",row.id);
    this.write("UPDATE routines SET enabled=0,last_error='An interrupted occurrence needs review.' WHERE id=?",row.routine_id);
    this.write('DELETE FROM routine_preparation_claims WHERE occurrence_id=?',row.id);
   }
  });
 }
 private reserve(routineId:string):{id:string;occurrence:string;definition:Definition}|null{
  return this.options.persistence.transaction(()=>{
   const r=this.row('SELECT * FROM routines WHERE id=? AND enabled=1 AND next_run<=?',routineId,this.now());if(!r||this.suspended)return null;
   const id=String(r.id),due=Number(r.next_run),timing=JSON.parse(String(r.timing_json)) as RoutineTiming,day=localParts(due,timing.timezone).date,definition=JSON.parse(String(r.definition_json)) as Definition,occurrence=randomUUID();
   this.write('UPDATE routines SET next_run=? WHERE id=?',nextOccurrence(this.now(),timing),id);
   if(this.row('SELECT id FROM routine_occurrences WHERE routine_id=? AND local_day=?',id,day))return null;
   let reason:string|null=null;
   if(Number(r.expires_at)<=this.now()){reason='Schedule expired.';this.write('UPDATE routines SET enabled=0 WHERE id=?',id);}
   else if(!this.row("SELECT 1 FROM result_reviews WHERE task_id=? AND version_id=? AND state='accepted'",r.source_task_id,definition.resultVersionId)){reason='The source result is no longer accepted. Review it before scheduling again.';this.write('UPDATE routines SET enabled=0 WHERE id=?',id);}
   else if(this.now()-due>15*60000)reason='Mac or app unavailable at the scheduled time. Missed occurrence skipped.';
   else if(this.row("SELECT 1 FROM routine_occurrences o LEFT JOIN tasks t ON t.id=o.task_id WHERE o.routine_id=? AND (o.state IN ('preparing','dispatching') OR t.state NOT IN ('succeeded','failed','cancelled'))",id))reason='Previous run still needs to finish or be stopped. No overlapping run started.';
   const reserved=Number(this.row(`SELECT COALESCE(SUM(CASE WHEN t.state IN ('succeeded','failed','cancelled') THEN COALESCE(l.cost_microusd,0)+COALESCE(l.reserved_microusd,0) ELSE MAX(o.reserved_microusd,COALESCE(l.cost_microusd,0)+COALESCE(l.reserved_microusd,0)) END),0) AS total FROM routine_occurrences o LEFT JOIN tasks t ON t.id=o.task_id LEFT JOIN live_task_config l ON l.task_id=o.task_id WHERE o.routine_id=? AND substr(o.local_day,1,7)=?`,id,day.slice(0,7))!.total);
   const budget=Math.round(definition.command.limits.maxCostUsd*1e6);
   if(!reason&&reserved+budget>Number(r.monthly_cap_microusd))reason='Monthly estimated-spend cap would be exceeded.';
   this.write('INSERT INTO routine_occurrences(id,routine_id,local_day,due_at,task_id,state,reason,reserved_microusd,created_at) VALUES (?,?,?,?,NULL,?,?,?,?)',occurrence,id,day,due,reason?'skipped':'preparing',reason,reason?0:budget,this.now());
   if(reason)return null;
   this.write('INSERT INTO routine_preparation_claims VALUES (?,?,?,?)',occurrence,this.ownerId,process.pid,this.now()+60_000);
   return{id,occurrence,definition};
  });
 }
 private async iterate(){
  this.reconcilePreparation();
  await this.alerts.reconcile(()=>{if(this.suspended)fail('Routine comparison stopped while the workspace was paused.');});
  for(const r of this.rows('SELECT * FROM routines WHERE enabled=1 AND next_run<=? ORDER BY next_run,id',this.now())){
   if(this.suspended)break;
   const reserved=this.reserve(String(r.id));if(!reserved)continue;
   const {id,occurrence,definition}=reserved;
   let taskId:string|null=null;
   const heartbeat=setInterval(()=>{try{this.write('UPDATE routine_preparation_claims SET lease_until=? WHERE occurrence_id=? AND owner_id=? AND lease_until>?',this.now()+60_000,occurrence,this.ownerId,this.now());}catch{/* A lost DB/lease fails the next dispatch fence. */}},1000);heartbeat.unref();
   try {
    taskId=this.options.createTask(definition.command,created=>{
     this.assertPreparation(occurrence,id);
     this.write("UPDATE routine_occurrences SET task_id=? WHERE id=? AND state='preparing'",created,occurrence);
     this.write('INSERT INTO workflow_task_origins(task_id,workflow_id,title,created_at,definition_json) VALUES (?,?,?,?,?)',created,definition.workflow.workflow_id,definition.workflow.title,this.now(),definition.workflow.definition_json);
    });
    for(const versionId of definition.inputs){this.assertPreparation(occurrence,id);const result=await this.options.artifacts.useInTask({principal:{kind:'owner'},taskId,versionId});this.assertPreparation(occurrence,id);if(result.deliveryDeferred)fail('Input staging is busy.');}
    for(const slot of definition.slots)this.write('INSERT INTO workflow_input_assignments VALUES (?,?,?,?)',taskId,slot.slot_key,slot.version_id,this.now());
    await this.options.preflight(taskId);
    this.assertPreparation(occurrence,id);
    this.write("UPDATE routine_occurrences SET state='dispatching' WHERE id=?",occurrence);
    await this.options.start(taskId);
    this.write("UPDATE routine_occurrences SET state='dispatched' WHERE id=? AND state='dispatching'",occurrence);
    this.event('routine.dispatched',id,taskId);
   }catch{
    this.write("UPDATE routine_occurrences SET state='blocked',reason='Setup, exact inputs, pause or expiry need review. Routine paused; this occurrence will not retry automatically.' WHERE id=?",occurrence);
    this.write("UPDATE routines SET enabled=0,last_error='Open the blocked occurrence and review setup before creating a new run.' WHERE id=?",id);this.event('routine.blocked',id,taskId||undefined);
   }finally{clearInterval(heartbeat);this.write('DELETE FROM routine_preparation_claims WHERE occurrence_id=? AND owner_id=?',occurrence,this.ownerId);}
  }
 }
}
