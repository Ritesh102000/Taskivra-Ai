// Synthetic renderer only. No production main/preload, persistence, credentials or runtimes.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FilesProvider, TaskFiles, SharedLibrary } from '../../apps/desktop/renderer/Files';
import { ProviderSettings } from '../../apps/desktop/renderer/ProviderSettings';
import '../../apps/desktop/renderer/styles.css';
const w = window as any;
const noEvent = () => () => {};
const agent = (id:string) => ({id,name:'Agent '+id,instructions:'Synthetic',workspaceId:id,enabled:true,createdAt:1});
const task = (id:string,state='paused') => ({id,agentId:id==='taskB'?'B':'A',objective:id,completionCriteria:'Synthetic result',state,executionMode:'live',revision:1,waitingReason:state==='waiting'?'files':null,scenario:'complete',checkpoint:0,generation:0,createdAt:1,updatedAt:1});
const file = (id:string,owner:string) => ({id,artifactId:id,version:1,displayName:id+'.txt',ownerAgentId:owner,producerTaskId:null,visibility:'shared',bytes:10,sha256:'a'.repeat(64),mime:'text/plain',format:'txt',createdAt:1,status:'ready',sourceVersionId:null});
const snapshot:any = {agents:[agent('A'),agent('B')],tasks:[task('taskA','waiting'),task('taskB')],messages:[],requests:[{id:'requestA',taskId:'taskA',agentId:'A',type:'files',title:'Supply source',reason:'A required file',state:'checking',revision:1,response:null,createdAt:1}],events:[],settings:{theme:'light',driverEnabled:false,maxActiveAgents:2},runtime:{mode:'live',dataRoot:'/synthetic-only',schemaVersion:1},artifacts:[file('ProjectA-file','A'),file('ProjectB-file','B')],taskArtifacts:[],workspaceSnapshots:[],storage:{usedBytes:20,budgetBytes:2147483648}};
const run = (id:string) => ({taskId:id,model:'unconfigured',modelConfigured:false,policy:{mode:'workspace',allowedOrigins:[]},limits:{maxCostUsd:2,maxModelCalls:30,maxToolSteps:50,maxTokens:150000,maxActiveSeconds:600},enabled:false,calls:0,steps:0,inputTokens:0,outputTokens:0,costUsd:0,reservedUsd:0,activeSeconds:0,lastError:null,resultVersionId:null,reviewOnly:true});
let rejectRequests=true;
const requestList = () => snapshot.requests.map(r=>({...r,kind:'files',legacy:false,slots:[{id:'slot1',key:'source',label:'Source',required:true,state:'checking',revision:1,candidateVersionId:null,explanation:null,constraints:{formats:['txt']}}]}));
const callbacks:Function[]=[];
const projectState:any = {defaultProjectId:'personal-workspace',verifiedAccounts:{gmail:null,googleWorkspace:null},projects:['A','B'].map(id=>({id,name:'Project '+id,description:'Synthetic',agentIds:[id],taskIds:['task'+id],artifactIds:['Project'+id+'-file'],brief:null,gmailAccount:null,googleWorkspaceAccount:null,createdAt:1,updatedAt:1}))};
const bridge:any = {
 onChanged:(fn:Function)=>{callbacks.push(fn);return()=>{};},onLiveChanged:noEvent,onRequestsChanged:noEvent,onGmailChanged:noEvent,onGoogleWorkspaceChanged:noEvent,
 command:async()=>snapshot,live:async()=>({tasks:snapshot.tasks.map(t=>run(t.id)),credentialConfigured:true,legacyCredentialConfigured:false,models:[{id:'other-configured',label:'Other configured',configured:true},{id:'unconfigured',label:'Unavailable selected',configured:false}],defaultModel:'other-configured',busy:false}),
 requests:async()=>{if(rejectRequests)throw Error('Synthetic request list failure');return requestList();},projects:async()=>projectState,
 workflows:async()=>({recipes:[],saved:[]}),collaboration:async()=>({policies:[],dependencies:[],messages:[],publications:[],board:[]}),browserActions:async()=>({actions:[],attentionCount:0}),
 gmail:async()=>({configured:false,connectedAccount:null,connecting:false}),modelProviders:async()=>({profiles:[],history:[]}),
 preview:async(id:string)=>({version:snapshot.artifacts.find(v=>v.id===id),text:'Synthetic bytes',truncated:false,note:null}),files:async()=>({snapshot}),importDroppedFiles:async()=>({snapshot}),
};
w.agentWorkspaces=bridge;
const root=createRoot(document.getElementById('root')!);
const frame=(children:React.ReactNode)=><FilesProvider bridge={bridge} snapshot={snapshot} onSnapshot={()=>{}}>{children}</FilesProvider>;
w.fixture={snapshot,bridge,async app(){const {default:App}=await import('../../apps/desktop/renderer/App');root.render(<App/>);},files(){snapshot.tasks=[task('taskA'),task('taskB')];root.render(frame(<TaskFiles task={snapshot.tasks[0]}/>));},library(){root.render(frame(<SharedLibrary/>));},provider(fail=false){root.render(<div className="page-scroll"><ProviderSettings api={{command:async()=>{if(fail)throw Error('Synthetic provider load failure');return {profiles:[],history:[]} as any;}}} active={false} onChanged={()=>{}}/></div>);},requestState(value:string){snapshot.requests[0].state=value;callbacks.forEach(fn=>fn());},repairRequests(){rejectRequests=false;callbacks.forEach(fn=>fn());},state(value:string){snapshot.tasks[0].state=value;callbacks.forEach(fn=>fn());},failures(){snapshot.tasks=Array.from({length:6},(_,i)=>task('Failure '+(i+1),'failed'));snapshot.requests=[];callbacks.forEach(fn=>fn());}};
w.fixtureReady=true;
