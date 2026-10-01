import {NativeSession} from './session.mjs';
import {fail} from './policy.mjs';
let port=null,session=null,connectionGeneration=0,connecting=false,authenticated=false,lastError=null;
const knownError=error=>typeof error?.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)?error.code:'browser_failed';
async function connect(){
 if(port||connecting)return;connecting=true;let channel;const generation=++connectionGeneration;
 try{channel=chrome.runtime.connectNative('com.agent_workspaces.browser');port=channel;
  channel.onMessage.addListener(message=>{if(message?.type==='bridge.connected'){authenticated=true;lastError=null;return;}if(message?.type==='bridge.error'){lastError=/^[a-z_]{1,48}$/.test(message.code)?message.code:'host_failed';return;}void processMessage(message,channel,generation);});
  channel.onDisconnect.addListener(()=>{const reason=chrome.runtime.lastError?.message||'';if(port!==channel)return;lastError=lastError||(/not found/i.test(reason)?'host_not_registered':/forbidden/i.test(reason)?'extension_origin':/exited/i.test(reason)?'host_exited':'app_disconnected');authenticated=false;port=null;connectionGeneration++;const previous=session;session=null;void previous?.end();});
 }catch{port=null;authenticated=false;lastError='native_messaging_unavailable';}finally{connecting=false;}
}
async function processMessage(message,channel,generation){
 if(!message||typeof message.id!=='string'||typeof message.method!=='string'||!message.params||Object.keys(message).some(k=>!['id','method','params'].includes(k)))return channel.disconnect();
 let result,error;try{
  if(message.method==='session.bind'){if(session)fail('session_already_running');const next=new NativeSession(chrome,message.params.sessionId,message.params.generation);session=next;await next.initialize();result={bound:true};}
  else if(message.method==='session.request'){if(!session||message.params.sessionId!==session.id)fail('session_not_running');result=await session.request(message.params.request);}
  else if(message.method==='session.end'){if(session&&message.params.sessionId===session.id){const previous=session;session=null;await previous.end();}result={closed:true};}
  else if(message.method==='owner.setup'){if(session&&session.control.controller!=='human')fail('permission_denied');const tab=await chrome.tabs.create({url:'chrome://extensions/',active:true});await chrome.windows.update(tab.windowId,{focused:true});result={opened:true};}
  else if(message.method==='owner.show'){if(session&&session.control.controller!=='human')fail('permission_denied');if(session)await session.show();else{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url?.startsWith('https:')||t.url==='about:blank');if(tab){await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});}else await chrome.windows.create({url:'about:blank',focused:true});}result={opened:true};}
  else fail('unknown_method');
 }catch(err){error=knownError(err);}
 if(port===channel&&generation===connectionGeneration){try{channel.postMessage({id:message.id,...(error?{error}:{result})});}catch{channel.disconnect();}}
}
chrome.runtime.onInstalled.addListener(()=>void connect());chrome.runtime.onStartup.addListener(()=>void connect());
chrome.alarms.create('agent-workspaces-connect',{periodInMinutes:0.5});chrome.alarms.onAlarm.addListener(a=>{if(a.name==='agent-workspaces-connect')void connect();});
chrome.tabs.onCreated.addListener(tab=>session?.created(tab));
chrome.tabs.onUpdated.addListener((id,change)=>session?.updated(id,change));chrome.tabs.onRemoved.addListener(id=>session?.removed(id));
chrome.runtime.onMessage.addListener((message,_sender,respond)=>{if(message?.type==='bridge.status'){respond({connected:authenticated,controller:session?.control.controller||'none',error:lastError});void connect();}});
void connect();
