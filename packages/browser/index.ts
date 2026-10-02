import {googleBrowserRejected} from '../agent-loop/troubleshooting';
import { randomUUID, createHash } from 'node:crypto';
import { open, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type { BrowserCommand, BrowserState, BrowserTab } from '../contracts/browser';
import { browserURL, parseBrowserCommand } from '../contracts/browser-validation';
import type { RunClaim } from '../coordinator/index';
import type { Persistence } from '../persistence/index';
import type { ArtifactService } from '../artifacts/index';
import { ensureManagedDirectory, assertManagedPath } from '../artifacts/safe-io';
import { unavailableRuntime, type BrowserHandle, type BrowserRuntime } from './runtime';

type Row = Record<string, string | number | null>;
type Observation = { tabs: BrowserTab[]; selectedTabId: string | null; targets?: BrowserState['targets']; text?: string; permissions?:{permission:string}[]; frame?: {jpegBase64:string;width:number;height:number;revision:number;tabId:string}|null };
type Download = {id:string;name:string;bytes:number;completed:boolean;status:string;sha256?:string;tabId:string;origin:string};
type Entry = {state:BrowserState;handle?:BrowserHandle;wireGeneration:number;tail:Promise<unknown>;pending?:number;closing?:Promise<void>;launchToken?:string};
export class BrowserError extends Error { constructor(readonly code:string, message:string, options?:ErrorOptions) { super(message,options); } }
function fail(code='stale_browser', message='The browser changed. Refresh its view before continuing.'):never { throw new BrowserError(code,message); }
const workerErrorMessages:Readonly<Record<string,string>>={
  extension_setup_required:'Prepare this agent’s Chrome profile and load the Agent Workspaces extension, then refresh.',
  extension_disconnected:'This agent’s Chrome connection stopped. Open its dedicated profile and reconnect before continuing.',
  native_transfer_unsupported:'Managed file transfers are available in the container browser. Close this session and choose that browser type to use them.',
  auth_page:'This page requires human login. Take control and sign in directly in the dedicated Chrome window.',
  stale_observation:'The page changed after this view was captured. Refresh the view before entering more input.',
  navigation_failed:'Navigation did not complete within the browser deadline. Refresh the page and check its current state before continuing.',
  stale_generation:'Browser control changed before the action completed. Refresh the view and check who has control.',
  fresh_observation_required:'A fresh page observation is required before another action. Refresh the browser view.',
  unknown_tab:'This tab is no longer available in the current session. Refresh the view or select another tab.',
  observation_unavailable:'A stable page view could not be captured. The last action may have completed; refresh the view and check the page before continuing.',
  human_login_required:'This page needs you to enter login details. Take control and sign in through the browser.',
  permission_denied:'The current browser controller cannot perform this action. Check who has control and refresh the view.',
  controller_busy:'A browser handoff is already in progress. Wait for the controller to change.',
  invalid_coordinate:'The pointer position does not fit the current browser viewport. Refresh the view before clicking again.',
  invalid_key:'That keyboard shortcut is not supported by this browser viewer.',
  invalid_scroll:'The scroll input exceeds the current browser limits. Try a smaller scroll.',
  invalid_target:'The selected page element is no longer suitable for this action. Refresh the view.',
  tab_limit:'This browser has reached its six-tab limit. Close a tab before opening another.',
  frame_too_large:'The page image exceeds the viewer limit. Open another tab or a simpler page.',
  queue_full:'The browser input queue is full. Wait for the current action and refresh the view.',
  browser_queue_full:'The browser input queue is full. Wait for the current action and refresh the view.',
  upload_origin_mismatch:'The website upload destination changed. Refresh the view and confirm the destination again.',
  upload_hash_mismatch:'The staged upload failed its integrity check. Choose the file version again.',
  transfer_limit:'The browser transfer limit was reached. Save downloads or close the browser before another transfer.',
  download_pending:'This download has not finished. Wait until it is ready to save.',
  unknown_download:'This download is no longer available in the browser. Check the private files list.',
  outcome_unknown:'The action outcome is uncertain after a control change. It was not retried. Refresh the view and check the page.',
  browser_action_outcome_unknown:'The browser stopped responding, so the action outcome is uncertain. It was not retried. Reconnect and check the page.',
  browser_transport_lost:'The browser connection was lost. Reconnect and check the page before repeating any action.',
  browser_worker_exited:'The browser worker stopped. Reopen the browser to restore its last saved profile.',
  browser_worker_unavailable:'The browser worker is unavailable. Reopen the browser to restore its last saved profile.',
  browser_worker_stopped:'The browser worker was stopped. Reopen it when you are ready to continue.',
  browser_action_failed:'The browser could not complete this action. Refresh the view and check the page before continuing; the action was not retried.',
};
function safeWorkerError(error:unknown):BrowserError {
  const value=error&&typeof error==='object'&&'code'in error?error.code:error instanceof Error?error.message:null;
  const code=typeof value==='string'&&Object.hasOwn(workerErrorMessages,value)?value:'browser_action_failed';
  return new BrowserError(code,workerErrorMessages[code]);
}

const finished=new Set(['succeeded','failed','cancelled']);
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(value);
function alive(pid:number):boolean { try{process.kill(pid,0);return true;}catch{return false;} }

/** Trusted broker. Owner frames and inputs live only in memory; no generic worker RPC crosses IPC. */
export class BrowserService {
  readonly ready:Promise<void>;
  private entries=new Map<string,Entry>();
  private stopped=false;
  private runtimeStatus:BrowserState['runtime']={ready:false,message:'Checking the local browser runtime.'};
  private recoveryProblem=false;
  constructor(private options:{persistence:Persistence;artifacts:ArtifactService;instanceId:string;assertTaskAllowed?:(taskId:string)=>void;authorize:(claim:RunClaim)=>void;runtime?:BrowserRuntime;now?:()=>number;onChanged?:()=>void}) {
    this.ready=this.reconcile();
  }
  private get runtime(){return this.options.runtime||unavailableRuntime;}
  private now(){return (this.options.now||Date.now)();}
  private row(sql:string,...args:SQLInputValue[]){return this.options.persistence.db.prepare(sql).get(...args) as Row|undefined;}
  private rows(sql:string,...args:SQLInputValue[]){return this.options.persistence.db.prepare(sql).all(...args) as Row[];}
  private write(sql:string,...args:SQLInputValue[]){this.options.persistence.db.prepare(sql).run(...args);}
  private transaction<T>(work:()=>T):T{return this.options.persistence.transaction(work);}
  private event(type:string,entry:Entry,payload:Record<string,unknown>={}){this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)',type,entry.state.sessionId,entry.state.revision,JSON.stringify({agentId:entry.state.agentId,taskId:entry.state.taskId,generation:entry.state.generation,...payload}),this.now());}
  private async reconcile(){
    await this.options.artifacts.ready;
    if(this.stopped)return;
    try{await this.runtime.reconcile();}catch{this.recoveryProblem=true;this.runtimeStatus={ready:false,message:'Previous browser cleanup could not finish. Start the selected browser runtime and refresh the browser panel.'};}
    if(this.stopped)return;
    for(const row of this.rows("SELECT * FROM browser_sessions WHERE lifecycle IN ('starting','ready','closing')")) {
      if(row.owner_pid&&alive(Number(row.owner_pid)))continue;
      this.write("UPDATE browser_sessions SET lifecycle='disconnected',controller='none',controller_generation=controller_generation+1,revision=revision+1,owner_instance=NULL,owner_pid=NULL,last_error='The previous browser stopped. Reopen it to restore its last saved profile.' WHERE id=?",row.id);
      this.write("UPDATE browser_tool_calls SET state='outcome_unknown',finished_at=? WHERE session_id=? AND state='dispatched'",this.now(),row.id);
      this.write("UPDATE browser_downloads SET state='failed' WHERE session_id=? AND version_id IS NULL",row.id);
    }
  }
  private entry(agentId:string):Entry {
    if(this.stopped)fail('closed','The browser service is shutting down.');
    const row=this.row('SELECT * FROM browser_sessions WHERE agent_id=?',agentId);if(!row)fail('not_found','Select an existing agent.');
    if(row.owner_instance&&row.owner_instance!==this.options.instanceId&&alive(Number(row.owner_pid)))fail('browser_owned','Another coordinator owns this browser.');
    const existing=this.entries.get(agentId);
    if(existing&&(existing.handle||existing.state.lifecycle==='starting'||existing.state.revision>=Number(row.revision)))return existing;
    const lifecycle=['disconnected','error'].includes(String(row.lifecycle))?row.lifecycle as 'disconnected'|'error':'idle';
    const entry:Entry={wireGeneration:Math.max(1,Number(row.controller_generation)),tail:Promise.resolve(),state:{agentId,sessionId:String(row.id),taskId:row.task_id?String(row.task_id):null,lifecycle,controller:'none',generation:Math.max(1,Number(row.controller_generation)),revision:Number(row.revision),activeTabId:null,tabs:[],frame:null,targets:[],downloads:[],error:row.last_error?String(row.last_error):null,requestId:null,profile:{mode:'remember',saved:!!row.profile_saved_at,savedAt:row.profile_saved_at?Number(row.profile_saved_at):null},runtime:this.runtimeStatus}};
    this.entries.set(agentId,entry);return entry;
  }
  private changed(entry:Entry,event?:string){
    if(this.stopped)return;
    const s=entry.state;
    this.transaction(()=>{
      const row=this.row('SELECT * FROM browser_sessions WHERE id=?',s.sessionId)!;
      if(row.owner_instance&&row.owner_instance!==this.options.instanceId&&alive(Number(row.owner_pid)))fail('browser_owned','Another coordinator owns this browser.');
      if(event==='browser.starting'){
        const occupied=this.rows("SELECT owner_pid FROM browser_sessions WHERE id<>? AND lifecycle IN ('starting','ready','closing')",s.sessionId).filter(r=>alive(Number(r.owner_pid)));
        if(occupied.length>=2)fail('browser_capacity','Two browsers are already open. Close one before opening another.');
        s.generation=Math.max(s.generation,Number(row.controller_generation)+1);entry.wireGeneration=s.generation;
      }
      s.revision=Math.max(s.revision,Number(row.revision))+1;
      this.write('UPDATE browser_sessions SET task_id=?,controller=?,controller_generation=?,lifecycle=?,revision=?,profile_saved_at=?,last_error=?,owner_instance=?,owner_pid=? WHERE id=?',s.taskId,s.controller,s.generation,s.lifecycle,s.revision,s.profile.savedAt,s.error,entry.handle||s.lifecycle==='starting'?this.options.instanceId:null,entry.handle||s.lifecycle==='starting'?process.pid:null,s.sessionId);
      if(event)this.event(event,entry);
    });this.options.onChanged?.();
  }
  private state(entry:Entry):BrowserState {

    const request=entry.state.taskId?this.row("SELECT id FROM input_requests WHERE task_id=? AND type='browser_handoff' AND state='open'",entry.state.taskId):null;
    entry.state.requestId=request?String(request.id):null;
    entry.state.downloads=this.rows('SELECT * FROM browser_downloads WHERE session_id=? ORDER BY created_at,id',entry.state.sessionId).map(r=>({id:String(r.id),name:String(r.name),bytes:Number(r.bytes),state:r.state as BrowserState['downloads'][number]['state'],...(r.version_id?{versionId:String(r.version_id)}:{})}));
    return structuredClone(entry.state);
  }
  private check(entry:Entry,command:{sessionId:string;generation:number},human=false){
    if(this.stopped||entry.state.sessionId!==command.sessionId||entry.state.generation!==command.generation||entry.state.lifecycle!=='ready'||!entry.handle)fail();
    if(human&&entry.state.controller!=='human')fail('controller_required','Take control before using browser inputs.');
    if(entry.state.controller==='transitioning')fail();
  }
  private page(entry:Entry,command:{tabId:string;revision?:number}){
    const tab=entry.state.tabs.find(t=>t.id===command.tabId);if(!tab)fail('unknown_tab','That tab does not belong to this browser.');
    if(command.revision!==undefined&&(entry.state.activeTabId!==command.tabId||tab.revision!==command.revision))fail('stale_observation','The page changed. Refresh its view before acting.');
  }
  private queue<T>(entry:Entry,work:()=>Promise<T>):Promise<T>{if((entry.pending||0)>=32)return Promise.reject(new BrowserError('browser_busy','The browser has too many pending actions. Wait for the current actions to finish.'));entry.pending=(entry.pending||0)+1;const result=entry.tail.then(work).finally(()=>{entry.pending!--;});entry.tail=result.catch(()=>{});return result;}
  private observation(entry:Entry,raw:unknown,persist=false){
    const v=raw as Observation;
    if(!v||!Array.isArray(v.tabs)||v.tabs.length>6||v.tabs.some(t=>!safeId(t.id)||typeof t.url!=='string'||t.url.length>4096||typeof t.title!=='string'||t.title.length>200||!Number.isSafeInteger(t.revision)))fail('invalid_observation','The browser returned an invalid view.');
    const selected=v.tabs.find(t=>t.id===v.selectedTabId);
    if(new Set(v.tabs.map(t=>t.id)).size!==v.tabs.length||(v.tabs.length? !selected:v.selectedTabId!==null))fail('invalid_observation');
    if(v.targets&&(!Array.isArray(v.targets)||v.targets.length>150||v.targets.some(t=>!safeId(t.ref)||!['input','file','select','button','link'].includes(t.kind)||typeof t.label!=='string'||t.label.length>160)))fail('invalid_observation');
    if(v.frame){const f=v.frame;if(!selected||f.tabId!==selected.id||f.revision!==selected.revision||![f.width,f.height].every(n=>Number.isInteger(n)&&n>0&&n<=4096)||typeof f.jpegBase64!=='string'||f.jpegBase64.length>Math.ceil(2*1024*1024/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.jpegBase64))fail('invalid_observation');}
    entry.state.tabs=v.tabs;entry.state.activeTabId=v.selectedTabId;entry.state.targets=v.targets||entry.state.targets;
    const frame=v.frame;
    entry.state.frame=frame?{dataUrl:`data:image/jpeg;base64,${frame.jpegBase64}`,width:frame.width,height:frame.height,revision:frame.revision,tabId:frame.tabId,generation:entry.state.generation}:null;
    if(persist&&entry.state.controller==='agent')this.transaction(()=>{
      this.write('DELETE FROM browser_tabs WHERE session_id=?',entry.state.sessionId);
      for(const tab of v.tabs){let url:string;try{const parsed=new URL(browserURL(tab.url));parsed.search='';parsed.hash='';url=parsed.href;}catch{continue;}
        this.write("INSERT INTO browser_tabs(id,session_id,permitted_url,title,observation_revision,lifecycle) VALUES (?,?,?,?,?,'open')",tab.id,entry.state.sessionId,url,tab.title,tab.revision);
      }
    });
    if(persist)this.capabilityRequests(entry,v.permissions||[]);
    this.changed(entry);
  }
  private async request(entry:Entry,method:string,params:Record<string,unknown>,actor:'owner'|'human'|'agent'='owner'){
    if(!entry.handle)fail();
    try{return await entry.handle.request(method,params,{actor,generation:entry.wireGeneration});}
    catch(error){throw safeWorkerError(error);}
  }
  private disconnected(entry:Entry){
    if(this.stopped||entry.state.lifecycle==='closing'||entry.state.lifecycle==='idle')return;
    const handle=entry.handle;entry.handle=undefined;void handle?.stop().catch(()=>{});entry.state.lifecycle='disconnected';entry.state.controller='none';entry.state.generation++;entry.state.frame=null;entry.state.tabs=[];entry.state.activeTabId=null;entry.state.targets=[];
    entry.state.error='This browser stopped. Reopen it to restore its last saved profile; uncertain actions will not be replayed.';
    this.write("UPDATE browser_tool_calls SET state='outcome_unknown',finished_at=? WHERE session_id=? AND state='dispatched'",this.now(),entry.state.sessionId);
    this.write("UPDATE browser_downloads SET state='failed' WHERE session_id=? AND version_id IS NULL",entry.state.sessionId);
    this.changed(entry,'browser.disconnected');
  }
  async handle(raw:unknown):Promise<BrowserState>{
    const command=parseBrowserCommand(raw);await this.ready;const entry=this.entry(command.agentId);
    if(command.type==='browser.state'){
      try{if(this.recoveryProblem){await this.runtime.reconcile();this.recoveryProblem=false;}entry.state.runtime=await this.runtime.status(command.agentId);}catch{entry.state.runtime={...entry.state.runtime,ready:false,message:'The selected browser runtime is unavailable. Check its setup and refresh.'};}
      return this.state(entry);
    }
    if(command.type==='browser.open'){await this.open(entry,command.taskId);return this.state(entry);}
    this.check(entry,command);
    if(command.type==='browser.close'){await this.closeEntry(entry);return this.state(entry);}
    if(command.type==='browser.takeControl'||command.type==='browser.returnControl') {await this.control(entry,command.type==='browser.takeControl');return this.state(entry);}
    if(command.type==='browser.requestLogin') {await this.requestLogin(entry,command.taskId);return this.state(entry);}
    await this.queue(entry,async()=>{
      this.check(entry,command);
      if(command.type==='browser.observe'){await this.observe(entry);return;}
      if(command.type==='browser.saveDownload'){await this.saveDownload(entry,command.downloadId);return;}
      this.check(entry,command,true);
      if('tabId'in command)this.page(entry,command);
      if(command.type==='browser.upload'){await this.upload(entry,command);return;}
      let method:string,params:Record<string,unknown>;
      switch(command.type){
        case'browser.newTab':method='tabs.open';params={url:command.url};break;
        case'browser.selectTab':method='page.observe';params={tab:command.tabId};break;
        case'browser.closeTab':method='tabs.close';params={tab:command.tabId};break;
        case'browser.navigate':method='page.navigate';params={tab:command.tabId,url:command.url};break;
        case'browser.pointer':method='page.click';params={tab:command.tabId,revision:command.revision,x:command.x,y:command.y};break;
        case'browser.key':method='page.key';params={tab:command.tabId,revision:command.revision,key:command.key};break;
        case'browser.text':method='page.key';params={tab:command.tabId,revision:command.revision,text:command.text};break;
        case'browser.scroll':method='page.scroll';params={tab:command.tabId,revision:command.revision,x:command.x,y:command.y};break;
        default:return fail();
      }
      const reply=await this.request(entry,method,params,'human');this.check(entry,command,true);
      this.observation(entry,reply.result);
      await this.downloads(entry);
    });return this.state(entry);
  }
  private async open(entry:Entry,taskId:string,beforeDispatch?:()=>void){
    this.options.assertTaskAllowed?.(taskId);
    let preflightRejected=false;
    if(this.recoveryProblem){try{await this.runtime.reconcile();this.recoveryProblem=false;}catch{fail('browser_recovery_required','Start the selected runtime and refresh the panel so the previous session can be cleaned up safely.');}}
    if(entry.state.lifecycle==='ready'){if(entry.state.taskId!==taskId)fail('task_mismatch','Close this browser before attaching it to another task.');return;}
    if(['starting','closing'].includes(entry.state.lifecycle))fail('browser_busy','Wait for the browser operation to finish.');
    const task=this.row('SELECT * FROM tasks WHERE id=? AND agent_id=?',taskId,entry.state.agentId);if(!task)fail('not_found','Select a task belonging to this agent.');
    if([...this.entries.values()].filter(e=>['ready','starting','closing'].includes(e.state.lifecycle)).length>=2)fail('browser_capacity','Two browsers are already open. Close one before opening another.');
    entry.state.lifecycle='starting';entry.state.controller='none';entry.state.activeTabId=null;entry.state.tabs=[];entry.state.frame=null;entry.state.targets=[];entry.state.taskId=taskId;entry.state.error=null;entry.state.generation++;entry.wireGeneration=entry.state.generation;this.changed(entry,'browser.starting');
    const generation=entry.state.generation,launchToken=randomUUID();entry.launchToken=launchToken;
    try{
      entry.state.runtime=await this.runtime.status(entry.state.agentId);
      if(!entry.state.runtime.ready)fail('browser_setup_required',entry.state.runtime.message||'Complete setup for this agent’s browser first.');
      if(entry.state.generation!==generation||entry.state.lifecycle!=='starting'||this.stopped)return;
      try{beforeDispatch?.();}catch(error){preflightRejected=true;throw error;}
      const handle=await this.runtime.launch({agentId:entry.state.agentId,sessionId:entry.state.sessionId,initialGeneration:generation,onExit:()=>{if(entry.launchToken===launchToken)this.disconnected(entry);}});
      if(entry.state.generation!==generation||entry.state.lifecycle!=='starting'||this.stopped){await handle.stop();return;}
      entry.handle=handle;entry.state.lifecycle='ready';entry.state.controller='agent';entry.state.runtime={...await this.runtime.status(entry.state.agentId),ready:true,message:null};
      await this.observe(entry,'agent');await this.observe(entry);this.changed(entry,'browser.opened');
    }catch(error){await entry.handle?.stop().catch(()=>{});entry.handle=undefined;if(this.stopped)return;if(preflightRejected){entry.state.lifecycle='idle';entry.state.controller='none';entry.state.error=null;this.changed(entry,'browser.open_superseded');throw error;}entry.state.lifecycle='error';entry.state.controller='none';entry.state.error=entry.state.runtime.backend==='local_lab'?'The training browser could not start ('+(error instanceof BrowserError?error.code:'runtime_start')+'). Saved progress is kept.':entry.state.runtime.backend==='desktop_chrome'?'The dedicated Chrome session could not connect. Complete extension setup for this agent and refresh.':'The isolated browser could not start. Check Docker Desktop, runtime images, and available storage.';this.changed(entry,'browser.open_failed');throw new BrowserError('browser_start_failed',entry.state.error,{cause:error});}
  }
  private async observe(entry:Entry,actor:'owner'|'agent'='owner'){
    const generation=entry.state.generation;
    const method=actor==='owner'&&entry.state.controller==='agent'?'page.peek':'page.observe';
    const result=await this.request(entry,method,entry.state.activeTabId?{tab:entry.state.activeTabId}:{},actor);
    if(entry.state.lifecycle!=='ready'||entry.state.generation!==generation)fail();
    this.observation(entry,result.result,actor==='agent');await this.downloads(entry);return result.result;
  }
  private async control(entry:Entry,take:boolean){
    if(entry.state.controller!==(take?'agent':'human'))fail('controller_required',take?'This browser is already under owner control.':'Take control before returning it.');
    const old=entry.wireGeneration;entry.state.controller='transitioning';entry.state.generation++;entry.state.frame=null;entry.state.targets=[];this.changed(entry,'browser.control_transition');
    try{
      // Send immediately: worker fences its in-flight result and queued old-generation actions.
      const reply=await entry.handle!.request(take?'control.take':'control.release',entry.state.activeTabId?{tab:entry.state.activeTabId}:{},{actor:'owner',generation:old});
      if(entry.state.lifecycle!=='ready'||this.stopped)fail();entry.wireGeneration=reply.generation;entry.state.generation=reply.generation;entry.state.controller=reply.controller;
      if(take)this.observation(entry,(reply.result as {observation:unknown}).observation);
      else{
        // Native owner login can finish in a new tab. Validate its redacted selection before the fresh read.
        if(entry.state.runtime.backend==='desktop_chrome')this.observation(entry,(reply.result as {observation:unknown}).observation);
        await this.observe(entry,'agent');this.fulfillLogin(entry);await this.observe(entry);
      }
      this.changed(entry,take?'browser.owner_control':'browser.agent_control');
    }catch(error){this.disconnected(entry);throw error;}
  }
  private async requestLogin(entry:Entry,taskId:string){
    this.options.assertTaskAllowed?.(taskId);
    if(entry.state.taskId!==taskId)fail('task_mismatch','The login request must belong to this browser task.');
    this.transaction(()=>{
      const task=this.row('SELECT * FROM tasks WHERE id=?',taskId)!;if(finished.has(String(task.state)))fail('invalid_state','A finished task cannot request a login.');
      if(!this.row("SELECT id FROM input_requests WHERE task_id=? AND type='browser_handoff' AND state='open'",taskId)){
        this.write("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?,'browser_handoff','Complete a browser login','Take control, finish the login, then return control to resume from a fresh page view.','open',?,?)",randomUUID(),taskId,`browser:${randomUUID()}`,this.now());
        this.write("UPDATE tasks SET state=CASE WHEN state IN ('paused','pausing') THEN 'paused' ELSE 'waiting' END,waiting_reason='browser_handoff',generation=generation+1,revision=revision+1,updated_at=? WHERE id=?",this.now(),taskId);
        this.write("UPDATE runs SET state='waiting',finished_at=?,lease_until=? WHERE task_id=? AND state='running'",this.now(),this.now(),taskId);
        this.write("UPDATE tool_calls SET state='outcome_unknown',finished_at=? WHERE run_id IN (SELECT id FROM runs WHERE task_id=?) AND state IN ('planned','dispatched')",this.now(),taskId);
      }
    });this.changed(entry,'browser.login_requested');if(entry.state.controller==='agent')await this.control(entry,true);
  }
  private fulfillLogin(entry:Entry){
    this.transaction(()=>{
      const task=this.row('SELECT * FROM tasks WHERE id=?',entry.state.taskId);if(!task||finished.has(String(task.state)))return;
      for(const request of this.rows("SELECT * FROM input_requests WHERE task_id=? AND type='browser_handoff' AND state='open'",task.id)){
        const revision=Number(request.revision)+1;
        this.write("UPDATE input_requests SET state='fulfilled',revision=?,response_revision=?,response='Browser control returned after a fresh observation.' WHERE id=?",revision,request.revision,request.id);
        this.write('INSERT OR IGNORE INTO resume_receipts(request_id,fulfillment_revision,continuation_key,created_at) VALUES (?,?,?,?)',request.id,revision,request.continuation_key,this.now());
      }
      const blocker=this.row("SELECT type FROM input_requests WHERE task_id=? AND blocking=1 AND state NOT IN ('fulfilled','cancelled','superseded') LIMIT 1",task.id);
      const dependency=this.row("SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? AND t.state<>'succeeded' LIMIT 1",task.id);
      const reason=blocker?String(blocker.type):dependency?'dependency':null;
      this.write("UPDATE tasks SET state=CASE WHEN state='waiting' AND ? IS NULL THEN 'queued' ELSE state END,waiting_reason=?,revision=revision+1,updated_at=? WHERE id=?",reason,reason,this.now(),task.id);
    });
  }
  private async downloads(entry:Entry):Promise<Download[]>{
    const reply=await this.request(entry,'download.list',{});const list=reply.result as Download[];
    if(!Array.isArray(list)||list.length>32)fail('invalid_download','The browser returned an invalid download list.');
    for(const item of list){if(!safeId(item.id)||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>100*1024*1024)fail('invalid_download');
      const name=String(item.name).replace(/[\\/:\x00-\x1f]/g,'_').slice(0,180)||'download';
      this.write("INSERT INTO browser_downloads(id,session_id,task_id,tab_id,name,bytes,sha256,state,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET bytes=excluded.bytes,sha256=excluded.sha256,state=CASE WHEN browser_downloads.state IN ('saved','saving') THEN browser_downloads.state ELSE excluded.state END",item.id,entry.state.sessionId,entry.state.taskId,item.tabId||entry.state.activeTabId,name,item.bytes,item.sha256||null,item.status==='failed'?'failed':item.completed?'ready':'pending',this.now());
    }return list;
  }
  private async saveDownload(entry:Entry,id:string,authorize?:()=>void){
    authorize?.();const item=(await this.downloads(entry)).find(item=>item.id===id);authorize?.();const prior=this.row('SELECT * FROM browser_downloads WHERE session_id=? AND id=?',entry.state.sessionId,id);
    if(prior?.version_id){if(item)await this.request(entry,'download.ack',{id});return;}
    if(!item||!item.completed||item.status==='failed'||!/^[a-f0-9]{64}$/.test(item.sha256||'')||!safeId(item.tabId))fail('download_not_ready','The download is not ready to save.');
    const release=await this.options.artifacts.reserveExternal('browser-download',item.bytes);const stage=release.directory;
    let file:Awaited<ReturnType<typeof open>>|undefined;
    try{
      await assertManagedPath(this.options.persistence.dataRoot,stage);authorize?.();const path=join(stage,String(prior!.name));file=await open(path,'wx',0o600);const hash=createHash('sha256');let offset=0;
      this.write("UPDATE browser_downloads SET state='saving' WHERE session_id=? AND id=?",entry.state.sessionId,id);this.changed(entry);
      while(offset<item.bytes){authorize?.();const data=(await this.request(entry,'download.read',{id,offset,length:Math.min(128*1024,item.bytes-offset)})).result as {offset:number;base64:string};authorize?.();const bytes=Buffer.from(data.base64,'base64');if(data.offset!==offset||!bytes.length||bytes.length>128*1024||offset+bytes.length>item.bytes)fail('download_integrity');await file.writeFile(bytes);hash.update(bytes);offset+=bytes.length;}
      await file.sync();await file.close();file=undefined;if(hash.digest('hex')!==item.sha256)fail('download_integrity','The download failed its integrity check.');
      authorize?.();const result=await this.options.artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:entry.state.agentId,taskId:entry.state.taskId},paths:[path],beforeCommit:authorize,browserSource:{sessionId:entry.state.sessionId,downloadId:id,tabId:item.tabId,origin:item.origin}});
      this.write("UPDATE browser_downloads SET state='saved',version_id=? WHERE session_id=? AND id=?",result.versionIds[0],entry.state.sessionId,id);this.changed(entry,'browser.download_saved');
      await this.request(entry,'download.ack',{id});
    }catch(error){this.write("UPDATE browser_downloads SET state='ready' WHERE session_id=? AND id=? AND version_id IS NULL",entry.state.sessionId,id);throw error;}
    finally{await file?.close();await rm(stage,{recursive:true,force:true});await release();}
  }
  private async upload(entry:Entry,command:Extract<BrowserCommand,{type:'browser.upload'}>,authorize?:()=>void,beforeTransfer?:()=>void){
    const guard=()=>{if(authorize){authorize();this.check(entry,command);if(entry.state.controller!=='agent')fail('permission_denied');}else this.check(entry,command,true);};
    const tab=entry.state.tabs.find(t=>t.id===command.tabId)!;
    if(new URL(tab.url).origin!==command.destinationOrigin||!entry.state.targets.some(t=>t.ref===command.ref&&t.kind==='file'))fail('upload_grant','Refresh the page and confirm a file input and current destination.');
    if(!this.row('SELECT 1 FROM task_artifacts WHERE task_id=? AND version_id=?',entry.state.taskId,command.versionId))fail('upload_grant','Attach this exact file version to the browser task before uploading.');
    const stage=await this.options.artifacts.stageForBrowser({kind:'agent',agentId:entry.state.agentId},command.versionId);let id:string|undefined;
    try{
      guard();beforeTransfer?.();this.page(entry,command);
      this.event('browser.upload_authorized',entry,{versionId:command.versionId,destinationOrigin:command.destinationOrigin});
      const start=await this.request(entry,'upload.begin',{name:stage.version.displayName,bytes:stage.version.bytes,sha256:stage.version.sha256,versionId:command.versionId,tab:command.tabId,revision:command.revision,ref:command.ref,origin:command.destinationOrigin});id=(start.result as {id:string}).id;
      const file=await open(stage.path,'r');try{let offset=0;const buffer=Buffer.alloc(128*1024);while(offset<stage.version.bytes){guard();const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,stage.version.bytes-offset),offset);if(!bytesRead)fail('upload_integrity');guard();beforeTransfer?.();await this.request(entry,'upload.chunk',{id,offset,base64:buffer.subarray(0,bytesRead).toString('base64')});offset+=bytesRead;}}finally{await file.close();}
      guard();beforeTransfer?.();const done=await this.request(entry,'upload.finish',{id});id=undefined;guard();this.observation(entry,(done.result as {observation:unknown}).observation);this.event('browser.upload_completed',entry,{versionId:command.versionId,destinationOrigin:command.destinationOrigin});
    }finally{if(id)await this.request(entry,'upload.abort',{id}).catch(()=>{});await stage.release();}
  }
  private capabilityRequests(entry:Entry,permissions:{permission:string}[]){
    if(!entry.state.taskId)return;
    const allowed=new Set(['geolocation','camera','microphone','notifications','clipboard']);
    this.transaction(()=>{
      const task=this.row('SELECT * FROM tasks WHERE id=?',entry.state.taskId);if(!task||finished.has(String(task.state)))return;
      for(const item of permissions.slice(0,32)){
        if(!allowed.has(item.permission))continue;
        const continuation=`browser-permission:${entry.state.sessionId}:${item.permission}`;
        if(this.row('SELECT 1 FROM input_requests WHERE task_id=? AND continuation_key=?',task.id,continuation))continue;
        this.write("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?,'clarification',?,?,'open',?,?)",randomUUID(),task.id,`Browser capability unavailable: ${item.permission}`,`The page requested ${item.permission}, which this isolated browser does not support. Describe an alternative way to continue. Replying does not enable this permission.`,continuation,this.now());
        this.write("UPDATE tasks SET state=CASE WHEN state IN ('paused','pausing') THEN 'paused' ELSE 'waiting' END,waiting_reason='clarification',generation=generation+1,revision=revision+1,updated_at=? WHERE id=?",this.now(),task.id);
        this.write("UPDATE runs SET state='waiting',finished_at=?,lease_until=? WHERE task_id=? AND state='running'",this.now(),this.now(),task.id);
        this.event('browser.capability_unavailable',entry);
      }
    });
  }
  async agentUpload(claim:RunClaim,input:{versionId:string;destinationOrigin:string;ref:string;revision:number},beforeDispatch?:()=>void):Promise<BrowserState>{
    await this.ready;this.options.authorize(claim);const entry=this.entry(claim.agentId);
    if(entry.state.taskId!==claim.taskId||entry.state.controller!=='agent'||!entry.state.activeTabId)fail('permission_denied');
    const guard=()=>{this.options.authorize(claim);if(!this.row('SELECT 1 FROM run_artifact_bindings WHERE run_id=? AND version_id=?',claim.runId,input.versionId))fail('upload_grant');
      const granted=this.rows('SELECT capability_json FROM request_capability_grants WHERE task_id=? AND revoked_at IS NULL',claim.taskId).some(row=>{const cap=JSON.parse(String(row.capability_json));return cap.name==='browser_upload'&&cap.origin===input.destinationOrigin&&Array.isArray(cap.versionIds)&&cap.versionIds.includes(input.versionId);});if(!granted)fail('upload_grant');};guard();
    const command={type:'browser.upload' as const,agentId:claim.agentId,sessionId:entry.state.sessionId,generation:entry.state.generation,tabId:entry.state.activeTabId,...input};
    await this.queue(entry,()=>this.upload(entry,command,guard,beforeDispatch));return this.state(entry);
  }
  async agentOpen(claim:RunClaim,beforeDispatch?:()=>void):Promise<BrowserState>{
    await this.ready;this.options.authorize(claim);const entry=this.entry(claim.agentId);
    beforeDispatch?.();await this.open(entry,claim.taskId,beforeDispatch);this.options.authorize(claim);
    if(entry.state.taskId!==claim.taskId||entry.state.controller!=='agent')fail('permission_denied','This run does not control this browser.');
    return this.state(entry);
  }
  private downloadGuard(claim:RunClaim,entry:Entry,beforeDispatch?:()=>void){
    this.options.authorize(claim);beforeDispatch?.();
    if(entry.state.taskId!==claim.taskId||entry.state.agentId!==claim.agentId||entry.state.controller!=='agent'||entry.state.lifecycle!=='ready')fail('permission_denied','This run does not control the assigned browser.');
    if(entry.state.runtime.supportsTransfers===false||entry.state.runtime.backend==='desktop_chrome')fail('native_transfer_unsupported',workerErrorMessages.native_transfer_unsupported);
    const row=this.row('SELECT policy_json FROM live_task_config WHERE task_id=?',claim.taskId);const policy=row?JSON.parse(String(row.policy_json)):null;
    if(!policy||policy.mode!=='workspace'||policy.mailAccount)fail('permission_denied','Read-only tasks cannot import browser downloads.');
    return policy.allowedOrigins as string[];
  }
  /** Agent sees only completed/pending downloads from explicitly allowed origins in its assigned session. */
  async agentDownloads(claim:RunClaim,beforeDispatch?:()=>void){
    await this.ready;const entry=this.entry(claim.agentId);this.downloadGuard(claim,entry,beforeDispatch);
    return this.queue(entry,async()=>{this.downloadGuard(claim,entry,beforeDispatch);const list=await this.downloads(entry);const origins=this.downloadGuard(claim,entry,beforeDispatch);
      return list.filter(item=>origins.includes(item.origin)).map(item=>({id:item.id,name:String(item.name).replace(/[\\/:\x00-\x1f]/g,'_').slice(0,180),bytes:item.bytes,completed:item.completed,status:item.status,origin:item.origin,tabId:item.tabId}));});
  }
  /** Save checked bytes privately, then bind only that exact version to this live run. */
  async agentSaveDownload(claim:RunClaim,downloadId:string,beforeDispatch?:()=>void){
    if(!safeId(downloadId))fail('invalid_download');await this.ready;const entry=this.entry(claim.agentId);this.downloadGuard(claim,entry,beforeDispatch);
    return this.queue(entry,async()=>{
      const guard=()=>{this.downloadGuard(claim,entry,beforeDispatch);};guard();
      const list=await this.downloads(entry);guard();const item=list.find(item=>item.id===downloadId);
      const prior=this.row('SELECT d.task_id,d.version_id,v.provenance FROM browser_downloads d LEFT JOIN artifact_versions v ON v.id=d.version_id WHERE d.session_id=? AND d.id=?',entry.state.sessionId,downloadId);
      const origin=item?.origin||(prior?.provenance?JSON.parse(String(prior.provenance)).browserSource?.origin:null);
      if(prior?.task_id!==claim.taskId||!origin||!this.downloadGuard(claim,entry,beforeDispatch).includes(origin))fail('permission_denied','This download does not belong to this task at an approved website.');
      await this.saveDownload(entry,downloadId,guard);guard();const saved=this.row('SELECT version_id FROM browser_downloads WHERE session_id=? AND id=?',entry.state.sessionId,downloadId);
      if(!saved?.version_id)fail('download_not_ready','The download was not saved.');const versionId=String(saved.version_id);
      const readyForTask=!!this.row("SELECT 1 FROM task_artifacts WHERE task_id=? AND version_id=? AND role='input'",claim.taskId,versionId);
      if(readyForTask)this.transaction(()=>{guard();this.write('INSERT OR IGNORE INTO run_artifact_bindings(run_id,version_id) VALUES (?,?)',claim.runId,versionId);});
      return{downloadId,versionId,readyForTask,message:readyForTask?'Saved privately and available to this run.':'Saved privately; input staging is pending until the code workspace is free.'};
    });
  }
  async agentRequestLogin(claim:RunClaim,sessionId:string,generation:number,beforeDispatch?:()=>void):Promise<void>{
    await this.ready;this.options.authorize(claim);const entry=this.entry(claim.agentId);this.check(entry,{sessionId,generation});
    if(entry.state.taskId!==claim.taskId||entry.state.controller!=='agent')fail('permission_denied');
    beforeDispatch?.();await this.requestLogin(entry,claim.taskId);
  }
  /** Called only by an authenticated coordinator worker, never renderer IPC. */
  async agentAction(claim:RunClaim,sessionId:string,generation:number,method:string,params:Record<string,unknown>,beforeDispatch?:()=>void):Promise<unknown>{
    await this.ready;this.options.authorize(claim);const entry=this.entry(claim.agentId);
    const guard=()=>{this.options.authorize(claim);this.check(entry,{sessionId,generation});if(entry.state.taskId!==claim.taskId||entry.state.controller!=='agent')fail('permission_denied','This run does not control this browser.');};guard();
    if(!['tabs.list','tabs.open','tabs.close','page.observe','page.navigate','page.click','page.fill','page.select','page.key','page.scroll','page.gmailUnread'].includes(method))fail('permission_denied','This browser tool is not available.');
    return this.queue(entry,async()=>{
      guard();beforeDispatch?.();const id=randomUUID();this.write("INSERT INTO browser_tool_calls(id,session_id,task_id,run_id,generation,method,state,created_at) VALUES (?,?,?,?,?,?,'dispatched',?)",id,sessionId,claim.taskId,claim.runId,generation,method,this.now());
      try{const result=await this.request(entry,method,params,'agent');guard();if(method!=='tabs.list'&&method!=='page.gmailUnread')this.observation(entry,result.result,true);this.write("UPDATE browser_tool_calls SET state='succeeded',finished_at=? WHERE id=? AND state='dispatched'",this.now(),id);return result.result;}
      catch(error){const refused=error instanceof BrowserError&&['stale_observation','invalid_target','permission_denied','human_login_required'].includes(error.code);if(!this.stopped)this.write("UPDATE browser_tool_calls SET state=?,finished_at=? WHERE id=? AND state='dispatched'",refused?'failed':'outcome_unknown',this.now(),id);throw error;}
    });
  }
  diagnostics():{taskId:string;code:'google_browser_rejected'}[]{return [...this.entries.values()].filter(e=>e.state.taskId&&e.state.tabs.some(t=>googleBrowserRejected(t.url))).map(e=>({taskId:e.state.taskId!,code:'google_browser_rejected'}));}
  stopForTask(taskId:string):Promise<void>{const entry=[...this.entries.values()].find(e=>e.state.taskId===taskId);return entry?this.closeEntry(entry):Promise.resolve();}
  private closeEntry(entry:Entry):Promise<void>{
    if(entry.closing)return entry.closing;
    if(!entry.handle){if(entry.state.lifecycle!=='starting')return Promise.resolve();entry.state.lifecycle='idle';entry.state.controller='none';entry.state.generation++;this.changed(entry);return Promise.resolve();}
    const handle=entry.handle;const preempt=entry.state.controller==='agent'?handle.request('control.take',entry.state.activeTabId?{tab:entry.state.activeTabId}:{},{actor:'owner',generation:entry.wireGeneration}).then(reply=>{entry.wireGeneration=reply.generation;}).catch(()=>{}):Promise.resolve();entry.state.lifecycle='closing';entry.state.controller='transitioning';entry.state.generation++;entry.state.frame=null;entry.state.targets=[];this.changed(entry,'browser.closing');
    // Fencing is immediate. Closing runs after admitted transfers have settled.
    const work=this.queue(entry,async()=>{
      try{
        await preempt;
        for(const item of await this.downloads(entry)){
          if(item.completed&&item.status!=='failed')await this.saveDownload(entry,item.id);
          else {if(!item.completed)await this.request(entry,'download.cancel',{id:item.id});await this.request(entry,'download.ack',{id:item.id});}
        }
        const profile=await handle.close({saveProfile:true});entry.state.profile={mode:'remember',saved:profile.saved,savedAt:profile.savedAt||entry.state.profile.savedAt};entry.state.error=profile.cleanupPending?'The latest profile was saved. Browser cleanup still needs attention; refresh runtime setup before starting another session.':null;
      }catch{await handle.stop().catch(()=>{});entry.state.error='The browser stopped before its latest profile or downloads could be saved. Its last saved profile is preserved.';}
      finally{entry.handle=undefined;entry.state.lifecycle=entry.state.error?'disconnected':'idle';entry.state.controller='none';entry.state.tabs=[];entry.state.activeTabId=null;entry.state.frame=null;entry.state.targets=[];this.changed(entry,'browser.closed');}
    });entry.closing=work.finally(()=>{entry.closing=undefined;});return entry.closing;
  }
  async shutdown(){await this.ready;await Promise.all([...this.entries.values()].map(e=>this.closeEntry(e)));await this.runtime.close();this.stopped=true;}
  abandon(){this.stopped=true;for(const entry of this.entries.values())void entry.handle?.stop().catch(()=>{});}
}
