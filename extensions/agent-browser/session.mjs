import {Controller,fail,ID,validURL,sensitiveURL} from './policy.mjs';
import {pageCommand} from './page.mjs';
import {readGmailListing} from './gmail.mjs';
export class NativeSession {
 constructor(api,sessionId,generation){if(!ID.test(sessionId)||!Number.isSafeInteger(generation)||generation<1)fail('invalid_session');this.api=api;this.id=sessionId;this.control=new Controller(generation);this.tabs=new Map();this.selected=null;this.attached=new Set();}
 async initialize(){await this.adopt();if(this.control.closed)fail('session_not_running');if(!this.tabs.size)await this.newTab('about:blank');}
 async adopt(){const tabs=await this.api.tabs.query({});if(this.control.closed)fail('session_not_running');for(const tab of tabs){if(this.tabs.size>=6)break;try{validURL(tab.url,{blank:true});this.register(tab);}catch{}}}
 async selectReturnedTab(guard){
  // Query only after owner control ends. Selecting our opaque reference never activates Chrome.
  const active=await this.api.tabs.query({active:true,lastFocusedWindow:true});guard();
  for(const tab of active){try{validURL(tab.url,{blank:true});}catch{continue;}
   const record=[...this.tabs.values()].find(r=>r.chromeId===tab.id);
   if(record){this.selected=record.id;return;}
  }
 }
 register(tab){if(this.control.closed)fail('session_not_running');if(!Number.isInteger(tab.id))fail('unknown_tab');for(const record of this.tabs.values())if(record.chromeId===tab.id)return record;const record={id:crypto.randomUUID(),chromeId:tab.id,revision:1,url:tab.url||'about:blank',title:(tab.title||'').slice(0,200),documentId:null,domRevision:null,targets:[]};this.tabs.set(record.id,record);this.selected??=record.id;return record;}
 async settle(record,guard){const deadline=Date.now()+5000;while(Date.now()<deadline){guard();const tab=await this.api.tabs.get(record.chromeId);if(tab.status!=='loading'&&!tab.pendingUrl)return;await new Promise(resolve=>setTimeout(resolve,75));}guard();fail('navigation_failed');}
 async newTab(url){if(this.control.closed)fail('session_not_running');validURL(url,{blank:true});if(this.tabs.size>=6)fail('tab_limit');const existing=await this.api.tabs.query({});if(this.control.closed)fail('session_not_running');const normal=existing.find(t=>typeof t.windowId==='number');let tab;if(normal)tab=await this.api.tabs.create({windowId:normal.windowId,url,active:false});else{const window=await this.api.windows.create({url,focused:false,type:'normal'});tab=window.tabs?.[0];}if(!tab)fail('unknown_tab');if(this.control.closed){await this.api.tabs.remove(tab.id).catch(()=>{});fail('session_not_running');}return this.register(tab);}
 created(tab){if(this.control.closed||this.control.controller!=='agent')return;try{validURL(tab.url||'about:blank',{blank:true});if(this.tabs.size>=6)throw Error();this.register(tab);}catch{void this.api.tabs.remove(tab.id).catch(()=>{});}}
 record(id){const record=this.tabs.get(id||this.selected);if(!record)fail('unknown_tab');return record;}
 invalidate(record){record.revision++;record.targets=[];record.documentId=null;record.domRevision=null;}
 updated(chromeId,change){const record=[...this.tabs.values()].find(t=>t.chromeId===chromeId);if(!record)return;if(change.status==='loading'||change.url)this.invalidate(record);if(this.control.controller==='human')return;if(change.url){try{record.url=validURL(change.url,{blank:true});}catch{void this.api.tabs.remove(chromeId).catch(()=>{});}}if(change.title)record.title=String(change.title).slice(0,200);}
 removed(chromeId){for(const [id,record]of this.tabs)if(record.chromeId===chromeId){this.tabs.delete(id);if(this.selected===id)this.selected=this.tabs.keys().next().value||null;}}
 summaries(){return [...this.tabs.values()].map(r=>({id:r.id,url:r.sensitive||sensitiveURL(r.url)?new URL(r.url).origin:r.url,title:r.sensitive||sensitiveURL(r.url)?'Login requires owner control':r.title,revision:r.revision}));}
 redacted(){return{tabs:[...this.tabs.values()].map(r=>({id:r.id,url:'about:blank',title:'Open in Chrome',revision:r.revision})),selectedTabId:this.selected,targets:[],text:'',frame:null,nativeHumanControl:true};}
 async content(record,command){const results=await this.api.scripting.executeScript({target:{tabId:record.chromeId,frameIds:[0]},world:'ISOLATED',func:pageCommand,args:[command]});const result=results?.[0]?.result;if(!result)fail('observation_unavailable');if(result.error)fail(result.error);return result;}
 async inspect(record,{peek=false,guard=()=>{}}={}){
  guard();const tab=await this.api.tabs.get(record.chromeId);guard();record.url=validURL(tab.url,{blank:true});record.title=(tab.title||'').slice(0,200);
  if(record.url==='about:blank')return{documentId:'blank',revision:1,sensitive:false,text:'',targets:[],width:1120,height:760};
  const read=await this.content(record,{type:peek?'peek':'inspect'});guard();record.sensitive=read.sensitive;
  if(read.documentId!==record.documentId||read.revision!==record.domRevision){record.revision++;record.targets=[];}
  if(!peek){record.documentId=read.documentId;record.domRevision=read.revision;record.targets=read.targets||[];}
  return read;
 }
 async observe(tabId,guard,peek=false){
  const record=this.record(tabId);if(!peek)this.selected=record.id;
  let read;for(let attempt=0;attempt<3;attempt++){try{read=await this.inspect(record,{peek,guard});break;}catch(error){guard();if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,100));}}let frame=null;
  if(peek&&!read.sensitive&&!sensitiveURL(record.url)&&record.url!=='about:blank'){
   const revision=record.revision;try{
    guard();await this.api.debugger.attach({tabId:record.chromeId},'1.3');this.attached.add(record.chromeId);guard();
    const image=await this.api.debugger.sendCommand({tabId:record.chromeId},'Page.captureScreenshot',{format:'jpeg',quality:45,fromSurface:true,captureBeyondViewport:false});guard();
    const after=await this.content(record,{type:'peek'});guard();if(!after.sensitive&&after.documentId===read.documentId&&after.revision===read.revision&&revision===record.revision&&typeof image?.data==='string'&&image.data.length<=700*1024)frame={jpegBase64:image.data,width:read.width,height:read.height,revision,tabId:record.id};
   }catch(error){guard();/* Unsupported screenshots leave a real DOM observation, never an invented frame. */}
   finally{await this.detach(record.chromeId);}
  }
  return{tabs:this.summaries(),selectedTabId:record.id,tab:record.id,url:read.sensitive?new URL(record.url).origin:record.url,title:read.sensitive?'Login requires owner control':read.title||record.title,text:peek?'':read.text||'',revision:record.revision,limits:read.limits,targets:peek?record.targets:read.targets||[],frame,permissions:[],...(read.sensitive?{humanLoginRequired:true}:{} )};
 }
 async detach(tabId){if(!this.attached.has(tabId))return;try{await this.api.debugger.detach({tabId});}catch{}const targets=await this.api.debugger.getTargets();if(targets.some(target=>target.tabId===tabId&&target.attached))fail('debugger_detach_failed');this.attached.delete(tabId);}
 async clear(){for(const record of this.tabs.values()){this.invalidate(record);try{if(record.url!=='about:blank')await this.content(record,{type:'clear'});}catch{}}await Promise.all([...this.attached].map(id=>this.detach(id)));const owned=new Set([...this.tabs.values()].map(record=>record.chromeId));const targets=await this.api.debugger.getTargets();if(targets.some(target=>owned.has(target.tabId)&&target.attached))fail('debugger_detach_failed');}
 async end(){this.control.end();await this.control.tail;try{await this.clear();}finally{const ids=[...this.tabs.values()].map(record=>record.chromeId);this.tabs.clear();this.selected=null;await Promise.all(ids.map(id=>this.api.tabs.remove(id).catch(()=>{})));}}
 async show(){let record=this.tabs.get(this.selected);if(!record)record=[...this.tabs.values()][0];if(record){const tab=await this.api.tabs.get(record.chromeId);await this.api.tabs.update(record.chromeId,{active:true});await this.api.windows.update(tab.windowId,{focused:true});}else await this.api.windows.create({url:'about:blank',focused:true});}
 request(request){return this.control.submit(request,guard=>this.execute(request,guard));}
 async execute(request,guard){
  const {method,params:p}=request;
  if(method==='control.take'){await this.clear();guard();return{observation:this.redacted(),debuggerDetached:true};}
  if(method==='control.release'){await this.clear();guard();await this.adopt();guard();if(!this.tabs.size)await this.newTab('about:blank');guard();await this.selectReturnedTab(guard);return{observation:this.redacted(),debuggerDetached:true};}
  if(method==='download.list')return[];
  if(this.control.controller!=='agent'){if(['page.observe','page.peek','tabs.list'].includes(method))return method==='tabs.list'?this.redacted().tabs:this.redacted();fail('native_manual_control');}
  if(method==='tabs.list')return this.summaries();
  if(method==='tabs.open'){const record=await this.newTab(p.url);guard();await this.settle(record,guard);return this.observe(record.id,guard);}
  if(method==='tabs.close'){const record=this.record(p.tab);await this.api.tabs.remove(record.chromeId);guard();this.removed(record.chromeId);if(!this.tabs.size)await this.newTab('about:blank');guard();return this.observe(this.selected,guard);}
  if(method==='page.observe'||method==='page.peek')return this.observe(p.tab,guard,method==='page.peek');
  const record=this.record(p.tab);
  if(method==='page.navigate'){const url=validURL(p.url);guard();await this.api.tabs.update(record.chromeId,{url});this.invalidate(record);record.url=url;guard();await this.settle(record,guard);return this.observe(record.id,guard);}
  if(method==='page.gmailUnread'){
   if(new URL(record.url).origin!=='https://mail.google.com'||typeof p.account!=='string'||!/^[a-z0-9._%+-]+@gmail\.com$/i.test(p.account))fail('permission_denied');guard();const result=await this.api.scripting.executeScript({target:{tabId:record.chromeId,frameIds:[0]},world:'ISOLATED',func:readGmailListing,args:[p.account.toLowerCase()]});guard();return result?.[0]?.result||fail('observation_unavailable');
  }
  if(!Number.isSafeInteger(p.revision)||p.revision!==record.revision||!record.documentId)fail('stale_observation');
  if(sensitiveURL(record.url))fail('human_login_required');
  const action={type:method.slice(5),documentId:record.documentId,revision:record.domRevision};
  if(method==='page.click'||method==='page.fill'||method==='page.select'){if(!ID.test(p.ref)||!record.targets.some(t=>t.ref===p.ref))fail('stale_observation');action.ref=p.ref;if(method==='page.fill'||method==='page.select'){if(typeof p.value!=='string'||p.value.length>8192||p.value.includes('\0'))fail('invalid_params');action.value=p.value;}}
  else if(method==='page.scroll'){if(![p.x,p.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=10000))fail('invalid_params');action.x=p.x;action.y=p.y;}
  else if(method==='page.key'){if(p.text!==undefined||!['Enter','Escape'].includes(p.key))fail('unsupported_key');action.key=p.key;}
  else fail('unknown_method');
  guard();const outcome=await this.content(record,action);guard();if(outcome.sensitive)fail('human_login_required');this.invalidate(record);return this.observe(record.id,guard);
 }
}
