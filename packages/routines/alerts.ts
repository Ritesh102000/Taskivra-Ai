import {randomUUID} from 'node:crypto';
import type {SQLInputValue} from 'node:sqlite';
import type {Persistence} from '../persistence';
import type {ArtifactService} from '../artifacts';
import type {RoutineAlert,RoutineComparison,RoutineResultChange} from '../contracts/routines';
import {compareResults} from './comparison';
type Row=Record<string,string|number|null>;
/** Local content-change detection only. No remote source is refreshed and no model is called. */
export class RoutineAlertService {
 private scanOffset=0;
 constructor(private options:{persistence:Persistence;artifacts:ArtifactService;now?:()=>number}){}
 private get db(){return this.options.persistence.db;}private now(){return(this.options.now||Date.now)();}
 private row(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).get(...args) as Row|undefined;}
 private rows(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).all(...args) as Row[];}
 private write(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).run(...args);}
 enabled(id:string){return this.row('SELECT enabled FROM routine_alert_settings WHERE routine_id=?',id)?.enabled===1;}
 setEnabled(id:string,enabled:boolean){
  if(!this.row('SELECT 1 FROM routines WHERE id=?',id))throw Error('This routine no longer exists.');
  if(enabled===this.enabled(id))return;
  this.write('INSERT INTO routine_alert_settings VALUES (?,?,?) ON CONFLICT(routine_id) DO UPDATE SET enabled=excluded.enabled,enabled_since=excluded.enabled_since',id,enabled?1:0,this.now());
 }
 acknowledge(id:string){
  const r=this.row('SELECT task_id FROM routine_change_alerts WHERE id=?',id);if(!r)throw Error('This alert no longer exists.');
  this.write('UPDATE routine_change_alerts SET seen=1 WHERE id=?',id);
  this.write("UPDATE owner_notices SET seen=1 WHERE kind='routine_change' AND event_id IN (SELECT id FROM events WHERE json_extract(payload,'$.alertId')=?)",id);
 }
 state(input:{beforeAlertId?:string;alertId?:string;unreadOnly?:boolean}={}):{alerts:RoutineAlert[];unreadAlerts:number;alertPage:{hasMore:boolean;beforeAlertId:string|null}}{
  let selected:Row[];const unread=input.unreadOnly?'AND seen=0':'';
  if(input.alertId){selected=this.rows('SELECT * FROM routine_change_alerts WHERE id=?',input.alertId);if(!selected.length)throw Error('This alert no longer exists.');}
  else if(input.beforeAlertId){const cursor=this.row('SELECT * FROM routine_change_alerts WHERE id=?',input.beforeAlertId);if(!cursor)throw Error('This alert history cursor no longer exists.');selected=this.rows(`SELECT * FROM routine_change_alerts WHERE (seen>? OR (seen=? AND (created_at<? OR (created_at=? AND id>?)))) ${unread} ORDER BY seen ASC,created_at DESC,id LIMIT 101`,cursor.seen,cursor.seen,cursor.created_at,cursor.created_at,cursor.id);}
  else selected=this.rows(`SELECT * FROM routine_change_alerts WHERE 1=1 ${unread} ORDER BY seen ASC,created_at DESC,id LIMIT 101`);
  return{alertPage:{hasMore:selected.length>100,beforeAlertId:String(selected.slice(0,100).at(-1)?.id||'')||null},alerts:selected.slice(0,100).map(r=>({id:String(r.id),routineId:String(r.routine_id),taskId:String(r.task_id),versionId:String(r.version_id),baselineTaskId:String(r.baseline_task_id),baselineVersionId:String(r.baseline_version_id),createdAt:Number(r.created_at),seen:Boolean(r.seen),change:JSON.parse(String(r.change_json)) as RoutineResultChange})),unreadAlerts:Number(this.row('SELECT count(*) AS n FROM routine_change_alerts WHERE seen=0')!.n)};
 }

 comparison(taskId:string):RoutineComparison|undefined{const r=this.row('SELECT * FROM routine_result_comparisons WHERE task_id=? ORDER BY created_at DESC LIMIT 1',taskId);return r?{taskId,versionId:String(r.version_id),baselineVersionId:String(r.baseline_version_id),state:r.state as RoutineComparison['state'],message:String(r.message),createdAt:Number(r.created_at)}:undefined;}
 private baseline(candidate:Row):Row|undefined{
  return this.row(`SELECT t.id AS task_id,l.result_version_id AS version_id FROM routine_occurrences o JOIN tasks t ON t.id=o.task_id JOIN live_task_config l ON l.task_id=t.id JOIN result_reviews rr ON rr.task_id=t.id AND rr.version_id=l.result_version_id
    WHERE o.routine_id=? AND o.due_at<? AND t.state='succeeded' AND rr.state='accepted' AND rr.updated_at<=? ORDER BY o.due_at DESC,o.id DESC LIMIT 1`,candidate.routine_id,candidate.due_at,candidate.completed_at)
    ||this.row("SELECT r.source_task_id AS task_id,json_extract(r.definition_json,'$.resultVersionId') AS version_id FROM routines r JOIN result_reviews rr ON rr.task_id=r.source_task_id AND rr.version_id=json_extract(r.definition_json,'$.resultVersionId') WHERE r.id=? AND rr.state='accepted'",candidate.routine_id);
 }
 async reconcile(check:()=>void):Promise<void>{
  const candidates=this.rows(`SELECT o.routine_id,o.due_at,t.id AS task_id,t.agent_id,t.updated_at AS completed_at,l.result_version_id AS version_id FROM routine_occurrences o JOIN tasks t ON t.id=o.task_id JOIN live_task_config l ON l.task_id=t.id JOIN routine_alert_settings s ON s.routine_id=o.routine_id
    WHERE t.state='succeeded' AND l.result_version_id IS NOT NULL AND s.enabled=1 AND t.updated_at>=s.enabled_since AND NOT EXISTS(SELECT 1 FROM routine_result_comparisons c WHERE c.task_id=t.id AND c.version_id=l.result_version_id) ORDER BY o.due_at,o.id LIMIT 20 OFFSET ?`,this.scanOffset);
  this.scanOffset=candidates.length===20?this.scanOffset+20:0;
  for(const c of candidates){
   check();const baseline=this.baseline(c);if(!baseline)continue;
   let change:RoutineResultChange|null=null,state:RoutineComparison['state']='unavailable',message='The complete result could not be compared. Review both versions; this does not mean unchanged.';
   try{
    const before=await this.options.artifacts.readForValidation(String(c.agent_id),String(baseline.version_id),true);check();
    const after=await this.options.artifacts.readForValidation(String(c.agent_id),String(c.version_id),true);check();
    if(before.version.producerTaskId!==baseline.task_id||after.version.producerTaskId!==c.task_id||before.text===null||after.text===null)throw Error('The exact output version is unavailable.');
    change=compareResults({text:before.text,format:before.version.format},{text:after.text,format:after.version.format});
    state=change.resultHash===change.baselineHash?'unchanged':'changed';
    message=state==='unchanged'?'No content difference after whitespace and CSV row-order normalization.':'Content differs from the earlier accepted result. Review the sources before treating this as a real-world change.';
   }catch{check();}
   check();
   this.options.persistence.transaction(()=>{
    if(!this.enabled(String(c.routine_id))||this.row("SELECT state FROM tasks WHERE id=?",c.task_id)?.state!=='succeeded'||this.row('SELECT result_version_id FROM live_task_config WHERE task_id=?',c.task_id)?.result_version_id!==c.version_id)return;
    const current=this.baseline(c);if(!current||current.task_id!==baseline.task_id||current.version_id!==baseline.version_id)return;
    const inserted=this.write('INSERT OR IGNORE INTO routine_result_comparisons VALUES (?,?,?,?,?,?,?,?)',c.task_id,c.version_id,c.routine_id,baseline.task_id,baseline.version_id,state,message,this.now());
    if(!inserted.changes||state!=='changed'||!change)return;
    const id=randomUUID(),added=this.write('INSERT OR IGNORE INTO routine_change_alerts VALUES (?,?,?,?,?,?,?,?,?,0)',id,c.routine_id,c.task_id,c.version_id,baseline.task_id,baseline.version_id,change.resultHash,JSON.stringify(change),this.now());
    if(!added.changes)return;
    const event=this.write("INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES ('routine.result_changed',?,1,?,?)",c.routine_id,JSON.stringify({routineId:c.routine_id,taskId:c.task_id,alertId:id,versionId:c.version_id,baselineVersionId:baseline.version_id}),this.now());
    this.write("INSERT INTO owner_notices(event_id,task_id,kind,created_at) VALUES (?,?,'routine_change',?)",event.lastInsertRowid,c.task_id,this.now());
   });
  }
 }
}
