import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Persistence} from '../../packages/persistence/index';
import {ArtifactService} from '../../packages/artifacts/index';
import {RequestService,type RequestServiceOptions} from '../../packages/requests/index';
import type {RunClaim} from '../../packages/coordinator/index';
import type {UserRequest,UserRequestSpec} from '../../packages/contracts/requests';
export const claim:RunClaim={runId:'run-a',taskId:'task-a',agentId:'agent-a',workerId:'worker-a',generation:1,leaseUntil:8e15};
export const filesSpec:UserRequestSpec={kind:'files',title:'Compare the two periods',reason:'Both exact periods are required.',continuation:'two-periods',slots:[
 {key:'current',label:'Current period',required:true,constraints:{formats:['csv'],csv:{requiredColumns:['period','value'],minRows:1,equals:[{column:'period',value:'2025'}]}}},
 {key:'prior',label:'Prior period',required:true,constraints:{formats:['csv'],csv:{requiredColumns:['period','value'],minRows:1,equals:[{column:'period',value:'2024'}]}}}
]};
export const oneFileSpec:UserRequestSpec={kind:'files',title:'Provide evidence',reason:'Need the exact input.',continuation:'one-file',slots:[{key:'evidence',label:'Evidence',required:true,constraints:{formats:['txt'],textIncludes:['required marker']}}]};
export async function fixture(extra:Partial<RequestServiceOptions>={}){
 const root=await mkdtemp(join(tmpdir(),'aw-phase5-requests-')),dataRoot=join(root,'app');
 const p=new Persistence(dataRoot,Date.now());
 p.db.prepare('INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES (?,?,?,?,?)').run('agent-a','Agent A','','workspace-a',Date.now());
 p.db.prepare('INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES (?,?,?,?,?)').run('agent-b','Agent B','','workspace-b',Date.now());
 p.db.prepare("INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,generation,created_at,updated_at) VALUES (?,?,'Compare inputs','running','Compare both periods','complete',1,?,?)").run('task-a','agent-a',Date.now(),Date.now());
 p.db.prepare("INSERT INTO runs(id,task_id,agent_id,attempt,worker_id,lease_until,fencing_generation,checkpoint,state,created_at) VALUES (?,?,?,1,?,?,1,'{}','running',?)").run(claim.runId,claim.taskId,claim.agentId,claim.workerId,claim.leaseUntil,Date.now());
 const artifacts=new ArtifactService({persistence:p});
 const authorize=(c:RunClaim)=>{const row=p.db.prepare('SELECT r.*,t.generation,t.state AS task_state FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?').get(c.runId);assert.ok(row&&row.state==='running'&&row.task_state==='running'&&row.task_id===c.taskId&&row.agent_id===c.agentId&&row.worker_id===c.workerId&&row.generation===c.generation&&row.fencing_generation===c.generation&&Number(row.lease_until)>Date.now(),'stale run claim');};
 const requests=new RequestService({persistence:p,artifacts,authorize,autoValidate:false,...extra});await requests.ready;
 let counter=0;
 const put=async(name:string,contents:string,agentId='agent-a')=>{const path=join(root,`${++counter}-${name}`);await writeFile(path,contents);return(await artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId,taskId:null},paths:[path]})).versionIds[0];};
 const view=(id?:string)=>{const all=requests.list();return(id?all.find(r=>r.id===id):all[0])!;};
 const assign=async(request:UserRequest,indices:number[],ids:string[])=>{const cmd={type:'requests.assign' as const,requestId:request.id,revision:request.revision,assignments:indices.map((index,i)=>({slotId:request.slots[index].id,slotRevision:request.slots[index].revision,versionId:ids[i]}))};await requests.handle(cmd);return cmd;};
 const count=(table:string)=>Number(p.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
 const close=async()=>{await requests.shutdown();artifacts.close();await artifacts.drain();p.close();await rm(root,{recursive:true,force:true});};
 return{root,dataRoot,p,artifacts,requests,put,view,assign,count,close,authorize};
}
