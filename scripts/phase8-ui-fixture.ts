/** Synthetic fixture only. No network/credentials/LLM server. Refuses existing roots.
 * npx tsx scripts/phase8-ui-fixture.ts [new-folder-name] */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../packages/coordinator';
import { ProviderRegistry, type ProviderCredentialStore } from '../packages/model-adapters/registry';
import { DEFAULT_MODEL } from '../packages/model-adapters/pricing';
import type { ModelAdapter, ModelRequest, ModelTurn, PreparedTurn } from '../packages/model-adapters/types';
import { SECURITY_REVIEW_ROLES, type SecurityReviewRole } from '../packages/contracts/security-review';

const name=process.argv[2]||'phase8-ui-20260930';
if(!/^[A-Za-z0-9_-]{1,80}$/.test(name))throw Error('Choose a new folder name directly inside .test-data; paths are not accepted.');
const parent=resolve('.test-data'),root=join(parent,name);
await mkdir(parent,{recursive:true,mode:0o700});
const info=await lstat(parent);if(!info.isDirectory()||info.isSymbolicLink())throw Error('The fixture parent must be a real directory.');
try{await mkdir(root,{mode:0o700});}catch(cause){if((cause as NodeJS.ErrnoException).code==='EEXIST')throw Error('Refusing existing fixture root: '+root);throw cause;}
function report(role:SecurityReviewRole,inputs:{versionId:string;displayName:string}[]):string{
 const titles={code_review:'Synthetic code review',evidence_review:'Synthetic independent evidence review',synthesis:'Synthetic team review summary'};
 const findings={code_review:'Potential authorization gap in this isolated example: getOrderSummary returns a selected order total without comparing ownerUserId with currentUserId.',evidence_review:'Supported at function scope: the illustrative function contains no ownership comparison. Insufficient evidence: routing, authentication and upstream authorization are absent. This is not a verified live vulnerability.',synthesis:'Both reviewers identify one potential static weakness. They agree that the missing deployment and authorization context prevents a claim about an exploitable live system.'};
 return ['# '+titles[role],'','**Synthetic UI fixture. No real target, paid model call or live finding verification.**','','## Findings',findings[role],'','## Evidence','In sample-api.ts, the order lookup and return check only that an order exists. This is an observation of an imported example, not a deployed service.','',...inputs.map(input=>'- '+input.displayName+': artifact:'+input.versionId),'','## Impact','If a real deployment exposed this function without a separate authorization layer, another owner’s order total might be returned. No deployment or request was examined.','','## Remediation','Validate identity and object ownership before returning order information. Add owner, non-owner and missing-record unit tests. These are proposed defensive checks; they were not executed.','','## Coverage','Reviewed only the exact selected files and explicitly approved handoff reports above. Every input fit the read limit. No browser, server, shell, credentials or exploit was used. A deterministic local test adapter wrote these reports; no LLM server was contacted. Do not present this demonstration as a verified security assessment.',''].join('\n');
}
class FixtureAdapter implements ModelAdapter{
 pending=new Map<string,ModelRequest>();calls=0;
 constructor(readonly selection:string){}
 async status(){return{configured:true,message:'Synthetic scripted fixture; no server or paid API used.',provider:'ollama',model:this.selection};}
 prepare(request:ModelRequest):PreparedTurn{const body=JSON.stringify(request),prepared=Object.freeze({id:randomUUID(),model:this.selection,requestHash:createHash('sha256').update(body).digest('hex'),requestBytes:Buffer.byteLength(body),maxOutputTokens:request.maxOutputTokens});this.pending.set(prepared.id,structuredClone(request));return prepared;}
 async quote(prepared:PreparedTurn){return{inputTokens:100,outputTokens:prepared.maxOutputTokens,maxCostMicrousd:0};}
 async complete(prepared:PreparedTurn):Promise<ModelTurn>{
  const request=this.pending.get(prepared.id)!;assert.ok(request);this.calls++;
  const ctx=JSON.parse((request.input[0] as {content:string}).content);assert.ok(ctx.securityReview,'Only scoped synthetic reviews may use this adapter.');
  const reads=new Set(ctx.savedObservations.filter((entry:any)=>entry.tool==='read_file').map((entry:any)=>entry.result.version.id));
  const unread=ctx.inputs.find((input:any)=>!reads.has(input.versionId)),saved=ctx.savedObservations.filter((entry:any)=>entry.tool==='save_report').at(-1);
  const tool=saved?{name:'finish',arguments:{outputVersionId:saved.result.versionId,summary:'Synthetic static review fixture complete. No live-system verification or paid model request occurred.'}}:unread?{name:'read_file',arguments:{versionId:unread.versionId}}:{name:'save_report',arguments:{name:ctx.securityReview.role+'-synthetic-report.md',content:report(ctx.securityReview.role,ctx.inputs),evidenceIds:ctx.evidence.filter((entry:any)=>entry.tool==='read_file').map((entry:any)=>entry.evidenceId)}};
  assert.ok(request.tools.some(definition=>definition.name===tool.name));
  return{responseId:'synthetic_'+randomUUID(),text:'',toolCalls:[{id:'call_'+randomUUID(),...tool}],usage:{inputTokens:100,outputTokens:80,cachedInputTokens:0,totalTokens:180},costMicrousd:0};
 }
 discard(prepared:PreparedTurn){this.pending.delete(prepared.id);}
}
const credentials:ProviderCredentialStore={async status(){return{configured:false,message:'No fixture key.'};},async read(){throw Error('No credentials in this fixture.');},async save(){throw Error('No credentials in this fixture.');},async remove(){throw Error('No credentials in this fixture.');}};
const legacy:ModelAdapter={async status(){return{configured:false,message:'Disabled for fixture.',provider:'openai',model:DEFAULT_MODEL};},prepare(){throw Error('Legacy models disabled.');},async quote(){throw Error('Legacy models disabled.');},async complete(){throw Error('Legacy models disabled.');},discard(){}};
const registry=new ProviderRegistry({filePath:join(root,'control','model-providers.json'),legacyAdapter:legacy,credentials:()=>credentials,fetch:async()=>{throw Error('Network forbidden in fixture.');}});
await registry.save({label:'Synthetic fixture — server not running',kind:'ollama',baseUrl:'http://127.0.0.1:65534',model:'synthetic-static-review',authentication:'none',billing:'local',inputUsdPerMillion:0,outputUsdPerMillion:0,maxInputTokens:32768,maxOutputTokens:4096,toolCalling:true});
const profile=(await registry.state()).profiles[0],adapter=new FixtureAdapter(profile.selectionId);
const c=new Coordinator({dataRoot:root,modelAdapter:legacy,modelResolver:selection=>{if(selection!==profile.selectionId)throw Error('Only synthetic model allowed.');registry.profile(selection);return adapter;},modelCatalog:()=>registry.options()});
let proof:Record<string,unknown>|undefined;
try{
 await c.live.ready;c.handle({type:'settings.update',settings:{driverEnabled:false}});
 const project=c.projects.handle({type:'projects.create',name:'Synthetic review lab',description:'UI fixture only. No live targets or verification. The saved local-model profile has no running server.'}).projects.find(project=>project.name==='Synthetic review lab')!;
 const agentIds:string[]=[];
 for(const label of ['Fixture code reviewer','Fixture evidence reviewer','Fixture report editor']){const before=new Set(c.snapshot().agents.map(agent=>agent.id));c.projects.handle({type:'projects.agent.create',projectId:project.id,name:label,instructions:'Synthetic imported-evidence demonstration. Never claim live deployment verification.'});agentIds.push(c.snapshot().agents.find(agent=>!before.has(agent.id))!.id);}
 const sourcePath=join(root,'sample-api.ts');
 await writeFile(sourcePath,['// SYNTHETIC TRAINING FIXTURE. Not mounted to any server.','// Missing owner comparison is an intentional static-review illustration.','type Order = { ownerUserId: string; total: number };','export function getOrderSummary(','  request: { currentUserId: string; orderId: string },','  orders: Record<string, Order>,',') {','  const order = orders[request.orderId];','  if (!order) return null;','  return { id: request.orderId, total: order.total };','}',''].join('\n'),{mode:0o600,flag:'wx'});
 const original=(await c.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:agentIds[0],taskId:null},paths:[sourcePath]})).versionIds[0];
 const sourceVersionId=(await c.artifacts.publish({principal:{kind:'owner'},versionId:original})).versionIds[0];
 c.projects.handle({type:'projects.brief.save',projectId:project.id,expectedRevision:0,content:'Synthetic defensive static-review fixture. Findings are illustrative and conditional. No live target, provider API or exploit execution.',knowledgeVersionIds:[sourceVersionId]});
 const members=SECURITY_REVIEW_ROLES.map((role,i)=>({role,agentId:agentIds[i],model:profile.selectionId,limits:{maxCostUsd:0.2,maxModelCalls:8,maxToolSteps:12,maxActiveSeconds:90,maxTokens:20000}}));
 const scope='Review only the owner-selected synthetic sample. Demonstrate conditional findings, independent checking, exact handoffs and a final report. No live vulnerability is established.';
 const first=await c.securityReviews.handle({type:'securityReview.create',title:'Synthetic sample — completed review',scope,sourceVersionIds:[sourceVersionId],members,idempotencyKey:randomUUID()}),completedTeamId=first.createdTeamId!;
 for(let index=0;index<3;index++){
  const member=c.securityReviews.state().teams.find(team=>team.id===completedTeamId)!.members[index];assert.equal(member.preparation,'ready',member.error||'Inputs unprepared');
  await c.live.handle({type:'live.start',taskId:member.taskId!});
  for(let n=0;;n++){const task=c.snapshot().tasks.find(task=>task.id===member.taskId)!;if(!(await c.live.state()).busy&&['succeeded','paused','failed','cancelled'].includes(task.state)){assert.equal(task.state,'succeeded',(await c.live.state()).tasks.find(task=>task.taskId===member.taskId)?.lastError||'Fixture failed');break;}if(n>=1000)throw Error('Fixture exceeded ten seconds.');await new Promise(resolve=>setTimeout(resolve,10));}
  const done=c.securityReviews.state().teams.find(team=>team.id===completedTeamId)!.members[index];assert.ok(done.resultVersionId);assert.equal((await c.results.checkQuality(done.taskId!,done.resultVersionId!)).canFinish,true);
  if(index<2){await c.results.handle({type:'results.accept',taskId:done.taskId!,versionId:done.resultVersionId!,revision:0,idempotencyKey:randomUUID()});await c.securityReviews.handle({type:'securityReview.prepareNext',teamId:completedTeamId,fromTaskId:done.taskId!,versionId:done.resultVersionId!,publishOutput:true,idempotencyKey:randomUUID()});}
 }
 const next=await c.securityReviews.handle({type:'securityReview.create',title:'Synthetic follow-up — not started',scope:scope+' Intentionally paused. The fixture model endpoint has no running server.',sourceVersionIds:[sourceVersionId],members,idempotencyKey:randomUUID()});
 const complete=c.securityReviews.state().teams.find(team=>team.id===completedTeamId)!;
 proof={fixtureOnly:true,createdAt:new Date().toISOString(),dataRoot:root,projectId:project.id,agentIds,sourceVersionId,modelSelectionId:profile.selectionId,providerServerRunning:false,completedTeamId,pausedTeamId:next.createdTeamId,scriptedModelCalls:adapter.calls,paidApiCalls:0,networkRequests:0,liveFindingsVerified:false,completedTaskIds:complete.members.map(member=>member.taskId),outputVersionIds:complete.members.map(member=>member.resultVersionId),approvedHandoffs:complete.handoffs.length,results:c.results.state().results.map(result=>({taskId:result.taskId,versionId:result.version.id,name:result.version.displayName,review:result.review.state})),instructions:'Launch with AW_DATA_ROOT set to dataRoot. Completed results and exports are available. The follow-up team stays paused; the illustrative local-model profile has no running server. No real keys were used.'};
}finally{await c.shutdown();}
if(proof){
 const db=new DatabaseSync(join(root,'control','agent-workspaces.sqlite'),{readOnly:true});
 try{const enabledTasks=Number(db.prepare('SELECT count(*) AS n FROM live_task_config WHERE enabled<>0').get()!.n),enabledRoutines=Number(db.prepare('SELECT count(*) AS n FROM routines WHERE enabled<>0').get()!.n);assert.equal(enabledTasks,0);assert.equal(enabledRoutines,0);assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);proof={...proof,enabledTasks,enabledRoutines,databaseIntegrity:'ok'};}finally{db.close();}
 await writeFile(join(root,'fixture-proof.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(proof,null,2));
}
