import {randomUUID} from 'node:crypto';
import type {Persistence} from '../persistence';
import type {RunClaim} from '../coordinator';
import {liveFail} from '../contracts/live-validation';
type Row=Record<string,string|number|null>;
/** Connection requests cannot be satisfied by a text reply or model assertion. */
export class GmailRequests {
 constructor(private p:Persistence,private now:()=>number,private authorize:(claim:RunClaim)=>void){}
 private row(sql:string,...values:(string|number)[]){return this.p.db.prepare(sql).get(...values) as Row|undefined;}
 create(claim:RunClaim,account:string,reason:string,onCreate:(id:string)=>void){
  return this.p.transaction(()=>{this.authorize(claim);return this.insert(claim.taskId,account,reason,onCreate);});
 }
 private insert(taskId:string,account:string,reason:string,onCreate:(id:string)=>void){
  const task=this.row('SELECT * FROM tasks WHERE id=?',taskId)!;
  const prior=this.row("SELECT i.id FROM input_requests i JOIN gmail_connection_requests g ON g.request_id=i.id WHERE i.task_id=? AND g.account=? AND i.state NOT IN ('fulfilled','cancelled','superseded')",taskId,account);
  if(prior)return String(prior.id);
  if(Number(this.row('SELECT COUNT(*) AS n FROM input_requests WHERE task_id=?',taskId)!.n)>=32)liveFail('request_limit','This task reached its request limit.');
  const id=randomUUID(),continuation='gmail-connection-'+id;
  this.p.db.prepare("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?,'permission_change','Connect Gmail read-only',?,'open',?,?)").run(id,taskId,reason,continuation,this.now());
  this.p.db.prepare('INSERT INTO gmail_connection_requests(request_id,account) VALUES (?,?)').run(id,account);
  this.p.db.prepare("UPDATE input_requests SET state='superseded',revision=revision+1 WHERE task_id=? AND type='browser_handoff' AND state NOT IN ('fulfilled','cancelled','superseded')").run(taskId);
  this.p.db.prepare("UPDATE tasks SET state=?,waiting_reason='permission_change',generation=generation+1,revision=revision+1,updated_at=? WHERE id=?").run(task.state==='paused'?'paused':'waiting',this.now(),taskId);
  this.p.db.prepare("UPDATE runs SET state='waiting',finished_at=?,lease_until=? WHERE task_id=? AND state='running'").run(this.now(),this.now(),taskId);
  onCreate(id);this.event('input.gmail_connection_requested',id,taskId,1);return id;
 }
 /** Upgrade a known blocked handoff on restart, without launching or controlling its browser. */
 diagnoseSavedHandoff(taskId:string,account:string,reason:string,onCreate:(id:string)=>void){
  return this.p.transaction(()=>{const task=this.row('SELECT state FROM tasks WHERE id=?',taskId);if(!task||!['waiting','paused'].includes(String(task.state)))return;
   if(!this.row("SELECT 1 FROM input_requests WHERE task_id=? AND type='browser_handoff' AND state NOT IN ('fulfilled','cancelled','superseded')",taskId))return;
   return this.insert(taskId,account,reason,onCreate);
  });
 }
 pending(account:string){return (this.p.db.prepare("SELECT i.task_id FROM input_requests i JOIN gmail_connection_requests g ON g.request_id=i.id JOIN tasks t ON t.id=i.task_id WHERE g.account=? AND i.state NOT IN ('fulfilled','cancelled','superseded') AND t.state NOT IN ('succeeded','failed','cancelled')").all(account) as Row[]).map(r=>String(r.task_id));}
 fulfill(taskId:string,account:string){return this.p.transaction(()=>{
  const task=this.row('SELECT * FROM tasks WHERE id=?',taskId);if(!task||['succeeded','failed','cancelled'].includes(String(task.state)))return false;
  const requests=this.p.db.prepare("SELECT i.* FROM input_requests i JOIN gmail_connection_requests g ON g.request_id=i.id WHERE i.task_id=? AND g.account=? AND i.state NOT IN ('fulfilled','cancelled','superseded')").all(taskId,account) as Row[];
  for(const r of requests){const revision=Number(r.revision)+1;this.p.db.prepare("UPDATE input_requests SET state='fulfilled',revision=? WHERE id=?").run(revision,r.id);
   this.p.db.prepare('INSERT INTO resume_receipts(request_id,fulfillment_revision,continuation_key,created_at) VALUES (?,?,?,?)').run(r.id,revision,r.continuation_key,this.now());this.event('input.fulfilled',String(r.id),taskId,revision);}
  if(!requests.length)return false;
  const blocker=this.row("SELECT type FROM input_requests WHERE task_id=? AND blocking=1 AND state NOT IN ('fulfilled','cancelled','superseded') ORDER BY created_at LIMIT 1",taskId);
  const dependency=this.row("SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? AND t.state<>'succeeded'",taskId);
  const reason=blocker?.type||(dependency?'dependency':null),state=task.state==='waiting'&&!reason?'queued':task.state;
  this.p.db.prepare('UPDATE tasks SET state=?,waiting_reason=?,revision=revision+1,updated_at=? WHERE id=?').run(state,reason,this.now(),taskId);return true;
 });}
 private event(type:string,id:string,taskId:string,revision:number){this.p.db.prepare('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)').run(type,id,revision,JSON.stringify({taskId,simulation:false}),this.now());}
}
