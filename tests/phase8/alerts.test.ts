import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import type {Persistence} from '../../packages/persistence';
import type {ArtifactService} from '../../packages/artifacts';
import {RoutineAlertService} from '../../packages/routines/alerts';
import {ROUTINE_ALERTS_MIGRATION} from '../../packages/routines/migration';
import {compareResults} from '../../packages/routines/comparison';

test('CSV compares values independently of quoting, column order and row order, retaining duplicates',()=>{
 const before={format:'csv',text:'name,price\r\nApple,10\r\nPear,8\r\nPear,8\r\n'},after={format:'csv',text:'"price","name"\n8,Pear\n10,Apple\n8,Pear\n'};
 assert.equal(compareResults(before,after).added,0);assert.equal(compareResults(before,after).removed,0);
 const delta=compareResults(before,{format:'csv',text:'name,price\nApple,11\nPear,8\n'});assert.equal(delta.added,1);assert.equal(delta.removed,2);
 assert.notEqual(delta.baselineHash,delta.resultHash);assert.throws(()=>compareResults(before,{format:'csv',text:'name,price\n"broken'}),/quoting/);
});
test('Markdown wrapping and heading depth are ignored, while code indentation, links and numbers remain visible',()=>{
 const a={format:'markdown',text:'# Findings\n\nPrice is 10\nand stays [here](https://example.com/a).\n'},b={format:'markdown',text:'## Findings\n\nPrice   is 10 and stays [here](https://example.com/a).\n'};
 assert.equal(compareResults(a,b).resultHash,compareResults(a,b).baselineHash);
 assert.equal(compareResults(a,{...b,text:b.text.replace('/a','/b')}).added,1);
 assert.equal(compareResults(a,{...b,text:b.text.replace('10','11')}).added,1);
 const code={format:'markdown',text:'```python\nif flag:\n    work()\n```'};assert.equal(compareResults(code,{...code,text:code.text.replace('    work','work')}).added,1);
 assert.throws(()=>compareResults(a,{format:'pdf',text:'binary'}),/support comparison/);
});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE tasks(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT,updated_at INTEGER);
 CREATE TABLE artifact_versions(id TEXT PRIMARY KEY);
 CREATE TABLE live_task_config(task_id TEXT PRIMARY KEY,result_version_id TEXT);
 CREATE TABLE result_reviews(task_id TEXT,version_id TEXT,state TEXT,updated_at INTEGER);
 CREATE TABLE routines(id TEXT PRIMARY KEY,source_task_id TEXT,definition_json TEXT);
 CREATE TABLE routine_occurrences(id TEXT PRIMARY KEY,routine_id TEXT,task_id TEXT,due_at INTEGER);
 CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,aggregate_id TEXT,aggregate_revision INTEGER,payload TEXT,created_at INTEGER);
 CREATE TABLE owner_notices(id INTEGER PRIMARY KEY,event_id INTEGER UNIQUE,task_id TEXT,kind TEXT,created_at INTEGER,seen INTEGER DEFAULT 0);
 INSERT INTO tasks VALUES ('source','agent','succeeded',1);
 INSERT INTO artifact_versions VALUES ('base');
 INSERT INTO live_task_config VALUES ('source','base');
 INSERT INTO result_reviews VALUES ('source','base','accepted',1);
 INSERT INTO routines VALUES ('routine','source','{"resultVersionId":"base"}');`);db.exec(ROUTINE_ALERTS_MIGRATION);
 const persistence={db,transaction<T>(work:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}} as Persistence;
 let now=10,unavailable=false;const files=new Map<string,{text:string;format:string;producerTaskId:string}>([['base',{text:'# Price\n\n10 USD',format:'markdown',producerTaskId:'source'}]]);
 const artifacts={async readForValidation(_agent:string,id:string){if(unavailable)throw Error('private storage error');const f=files.get(id);if(!f)throw Error('missing');return{text:f.text,version:{id,format:f.format,producerTaskId:f.producerTaskId}};}} as unknown as ArtifactService;
 const service=new RoutineAlertService({persistence,artifacts,now:()=>now});service.setEnabled('routine',true);
 function result(task:string,text:string,format='markdown'){
  now+=10;const version=task+'-version';db.prepare("INSERT INTO tasks VALUES (?,'agent','succeeded',?)").run(task,now);db.prepare('INSERT INTO artifact_versions VALUES (?)').run(version);db.prepare('INSERT INTO live_task_config VALUES (?,?)').run(task,version);db.prepare('INSERT INTO routine_occurrences VALUES (?,?,?,?)').run(task+'-occurrence','routine',task,now);files.set(version,{text,format,producerTaskId:task});return version;
 }
 return{db,service,result,setUnavailable:()=>{unavailable=true;},accept(task:string){db.prepare("INSERT INTO result_reviews VALUES (?,?,'accepted',?)").run(task,task+'-version',now);},tick:()=>service.reconcile(()=>{}),close:()=>db.close()};
}
test('result changes create durable in-app notices once; equivalent or repeated changes remain quiet',async()=>{
 const f=fixture();try{
  f.result('unchanged','## Price\n\n10   USD');await f.tick();assert.equal(f.service.state().alerts.length,0);assert.equal(f.service.comparison('unchanged')?.state,'unchanged');
  f.result('changed','## Price\n\n11 USD');await f.tick();await f.tick();assert.equal(f.service.state().alerts.length,1);assert.equal(f.service.state().unreadAlerts,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM owner_notices').get()!.n,1);
  f.result('repeat','## Price\n\n11 USD');await f.tick();assert.equal(f.service.state().alerts.length,1);assert.equal(f.service.comparison('repeat')?.state,'changed');
  const alert=f.service.state().alerts[0];assert.equal(alert.baselineVersionId,'base');f.service.acknowledge(alert.id);assert.equal(f.service.state().unreadAlerts,0);assert.equal(f.db.prepare('SELECT seen FROM owner_notices').get()!.seen,1);
 }finally{f.close();}
});
test('a previously accepted occurrence becomes the next baseline and detects a later reversal',async()=>{
 const f=fixture();try{f.result('first','11 USD');await f.tick();f.accept('first');f.result('second','11 USD');await f.tick();assert.equal(f.service.comparison('second')?.state,'unchanged');assert.equal(f.service.comparison('second')?.baselineVersionId,'first-version');f.result('third','# Price\n\n10 USD');await f.tick();assert.equal(f.service.state().alerts.length,2);assert.equal(f.service.state().alerts[0].baselineTaskId,'first');}finally{f.close();}
});
test('unsupported or unreadable results are unavailable, never silently unchanged',async()=>{
 const f=fixture();try{f.result('pdf','data','pdf');await f.tick();assert.equal(f.service.comparison('pdf')?.state,'unavailable');f.setUnavailable();f.result('missing','changed');await f.tick();assert.equal(f.service.comparison('missing')?.state,'unavailable');assert.equal(f.service.state().alerts.length,0);assert.doesNotMatch(JSON.stringify(f.service.comparison('missing')),/private storage error/);}finally{f.close();}
});
test('disable and revoked acceptance fence comparisons; paused reads cannot publish an alert',async()=>{
 const f=fixture();try{f.result('one','Changed');f.service.setEnabled('routine',false);await f.tick();assert.equal(f.service.comparison('one'),undefined);f.service.setEnabled('routine',true);f.db.prepare('DELETE FROM result_reviews').run();await f.tick();assert.equal(f.service.comparison('one'),undefined);
  f.db.prepare("INSERT INTO result_reviews VALUES ('source','base','accepted',1)").run();let checks=0;await assert.rejects(f.service.reconcile(()=>{if(++checks>1)throw Error('Paused');}),/Paused/);assert.equal(f.service.state().alerts.length,0);assert.equal(f.service.comparison('one'),undefined);
 }finally{f.close();}
});
