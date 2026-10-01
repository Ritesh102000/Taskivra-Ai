import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {FLEET_LAB_URL,type FleetLabStatus} from '../contracts/fleet';

export const LAB_ORIGIN=new URL(FLEET_LAB_URL).origin;
export function labURL(value:unknown):string {
 if(typeof value!=='string'||value.length>4096)throw new Error('Use a bounded training website URL.');
 const u=new URL(value,LAB_ORIGIN+'/');
 if(u.origin!==LAB_ORIGIN||u.username||u.password||/[\x00-\x1f\\]/.test(value))throw new Error('Only the app-owned training website is available.');
 return u.href;
}
export function labInteractionURL(value:unknown):string {
 const href=labURL(value),u=new URL(href);
 if(/\.(?:m?js|cjs|css|map|html?|env)$/i.test(u.pathname)||/(?:^|\/)(?:__lab|\.git|\.env|package\.json)(?:\/|$)/i.test(u.pathname))throw new Error('Implementation assets and lab control endpoints are not website testing inputs.');
 return href;
}
export interface LabRequest {url:string;method:'GET'|'POST'|'PUT'|'DELETE';headers:Record<string,string>;body?:string}
/** A curl-shaped local HTTP checker, not a host shell. No files or subprocess input. */
export function parseLabCommand(json:string):LabRequest {
 if(typeof json!=='string'||Buffer.byteLength(json)>12000)throw new Error('Local terminal input is too long.');
 const v=JSON.parse(json);if(!Array.isArray(v)||v.length<2||v.length>20||v.some(x=>typeof x!=='string'||x.length>8192)||v[0]!=='curl')throw new Error('Use a JSON curl argument array.');
 let url:string|undefined,method:LabRequest['method']='GET',body:string|undefined;const headers:Record<string,string>={};
 for(let i=1;i<v.length;i++){
  const a=v[i];if(a==='-i'||a==='--include'||a==='-s'||a==='--silent')continue;
  if(a==='-X'||a==='--request'){const m=v[++i];if(!['GET','POST','PUT','DELETE'].includes(m))throw new Error('Unsupported HTTP method.');method=m;}
  else if(a==='-H'||a==='--header'){const h=v[++i];if(typeof h!=='string')throw new Error('Missing header.');const split=h.indexOf(':');const name=h.slice(0,split).trim().toLowerCase(),value=h.slice(split+1).trim();if(split<1||!['content-type','accept'].includes(name)||/[\r\n]/.test(value)||value.length>200)throw new Error('Only content-type and accept headers are supported.');headers[name]=value;}
  else if(a==='-d'||a==='--data'||a==='--data-raw'){const b=v[++i];if(typeof b!=='string'||b.startsWith('@')||Buffer.byteLength(b)>8192)throw new Error('Only a small inline request body is supported.');body=b;if(method==='GET')method='POST';}
  else if(a.startsWith('-'))throw new Error('This option is unavailable in the local terminal.');
  else {if(url)throw new Error('Use one training URL per request.');url=labInteractionURL(a);}
 }
 if(!url)throw new Error('Include the training website URL.');
 if(body!==undefined&&!headers['content-type'])headers['content-type']='application/json';
 return{url,method,headers,...(body===undefined?{}:{body})};
}
export interface LocalLabPort {start():Promise<FleetLabStatus>;status():FleetLabStatus;command(agentId:string,argvJson:string,signal?:AbortSignal):Promise<unknown>}
export class LocalLabController implements LocalLabPort {
 private child:ChildProcess|null=null;private verified=false;private pending:Promise<FleetLabStatus>|null=null;private nonce='';private problem='Start the synthetic training website.';
 constructor(private options:{serverPath:string;executable?:string;cookies?:(agentId:string)=>Promise<string>}){}
 status():FleetLabStatus{return{ready:this.verified&&!!this.child&&this.child.exitCode===null,siteUrl:FLEET_LAB_URL,message:this.problem};}
 start():Promise<FleetLabStatus>{if(this.status().ready)return Promise.resolve(this.status());if(this.pending)return this.pending;this.pending=this.launch().finally(()=>{this.pending=null;});return this.pending;}
 private async launch(){
  const occupied=await fetch(LAB_ORIGIN+'/__lab/health',{signal:AbortSignal.timeout(800)}).then(()=>true).catch(()=>false);
  if(occupied){this.problem='Port 4318 is already in use. Stop that process before starting the app-owned training website.';return this.status();}
  this.nonce=randomUUID();this.verified=false;
  const child=spawn(this.options.executable||process.execPath,[this.options.serverPath],{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',ELECTRON_RUN_AS_NODE:'1',AW_LAB_INSTANCE_NONCE:this.nonce},stdio:['ignore','ignore','pipe']});this.child=child;
  child.stderr?.on('data',()=>{this.problem='The training website could not start. Check the local lab setup.';});
  child.on('error',()=>{this.verified=false;this.problem='The training website process could not start.';});
  child.on('exit',()=>{if(this.child===child){this.verified=false;this.child=null;this.problem='The training website has stopped.';}});
  for(let i=0;i<40;i++){
   if(child.exitCode!==null)break;
   const health=await fetch(LAB_ORIGIN+'/__lab/health',{signal:AbortSignal.timeout(400)}).then(r=>r.json()).catch(()=>null) as {labId?:string;instanceNonce?:string}|null;
   if(health?.labId==='harbor-desk'&&health.instanceNonce===this.nonce){this.verified=true;this.problem='Harbor Desk is running with synthetic data. New agent browsers begin logged out.';return this.status();}
   await new Promise(r=>setTimeout(r,100));
  }
  child.kill('SIGTERM');this.problem='The app could not verify its own training website.';return this.status();
 }
 async command(agentId:string,argvJson:string,signal?:AbortSignal){
  if(!this.status().ready)throw new Error('Start the app-owned training website first.');
  const request=parseLabCommand(argvJson),cookie=await this.options.cookies?.(agentId)||'';
  const started=Date.now(),response=await fetch(request.url,{method:request.method,headers:{...request.headers,...(cookie?{cookie}:{})},body:request.body,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
  const reader=response.body?.getReader();let body='';let bytes=0,truncated=false;const decoder=new TextDecoder();
  try{if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;const take=Math.min(chunk.value.length,24000-bytes);body+=decoder.decode(chunk.value.slice(0,take),{stream:true});bytes+=take;if(take<chunk.value.length||bytes>=24000){truncated=true;await reader.cancel();break;}}body+=decoder.decode();}finally{reader?.releaseLock();}
  if(!this.status().ready||signal?.aborted)throw new Error('The training website or task stopped.');
  const headers=Object.fromEntries(['content-type','cache-control','location'].flatMap(key=>response.headers.has(key)?[[key,response.headers.get(key)!]]:[]));
  return{source:'local_lab_http',url:request.url,method:request.method,status:response.status,headers,body,bytes,truncated,redirectFollowed:false,elapsedMs:Date.now()-started,sourceEvidence:true,coverage:'One bounded HTTP response from the app-owned synthetic website, using only this agent’s local session cookies. No host shell, filesystem or external target access.'};
 }
 async close(){this.verified=false;const child=this.child;this.child=null;if(!child)return;await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
}
