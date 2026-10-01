import {lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {BrowserRuntime} from '../../../packages/browser/runtime';
import type {NativeChromeRuntime} from '../../../packages/native-browser';
import type {Coordinator} from '../../../packages/coordinator';
import type {BrowserBackend,BrowserSetupState} from '../../../packages/contracts/browser-setup';
import {BrowserError} from '../../../packages/browser';

const id=(v:unknown):string=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(v))throw new BrowserError('invalid_command','Select an existing agent.');return v;};
const backend=(v:unknown):BrowserBackend=>{if(v!=='desktop_chrome'&&v!=='docker')throw new BrowserError('invalid_command','Choose a supported browser.');return v;};

/** Runtime selection is trusted local configuration, never a renderer-supplied path. */
export class BrowserRuntimeRouter implements BrowserRuntime {
 private selections:Record<string,BrowserBackend>={};private readonly path:string;
 constructor(readonly options:{dataRoot:string;desktop:NativeChromeRuntime;docker:BrowserRuntime;defaultBackend?:BrowserBackend}){
  this.path=join(options.dataRoot,'control','browser-backends.json');
  try{const stat=lstatSync(this.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error('Invalid browser settings.');const saved=JSON.parse(readFileSync(this.path,'utf8'));if(!saved||typeof saved!=='object'||Array.isArray(saved))throw new Error('Invalid browser settings.');for(const [key,value]of Object.entries(saved))this.selections[id(key)]=backend(value);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 selected(agentId:string):BrowserBackend{return this.selections[id(agentId)]||this.options.defaultBackend||'desktop_chrome';}
 select(agentId:string,value:BrowserBackend){const next={...this.selections,[id(agentId)]:backend(value)},temporary=`${this.path}.${randomUUID()}.tmp`;try{writeFileSync(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});renameSync(temporary,this.path);this.selections=next;}finally{try{unlinkSync(temporary);}catch{}}}
 private runtime(agentId:string){return this.selected(agentId)==='desktop_chrome'?this.options.desktop:this.options.docker;}
 async status(agentId?:string){if(!agentId)return this.options.desktop.status();const selected=this.selected(agentId);if(this.cleanupErrors[selected]){try{await this.runtime(agentId).reconcile();this.cleanupErrors[selected]=false;}catch{return{ready:false,message:'Previous browser cleanup is incomplete. Start the selected runtime and refresh.',backend:selected,supportsTransfers:selected==='docker'};}}return{...await this.runtime(agentId).status(agentId),backend:selected,supportsTransfers:selected==='docker'};}
 async launch(options:Parameters<BrowserRuntime['launch']>[0]){const status=await this.status(options.agentId);if(!status.ready)throw new BrowserError('browser_recovery_required',status.message||'The selected runtime is unavailable.');return this.runtime(options.agentId).launch(options);}
 async reconcile(){
  // Native startup must not depend on Docker. A failed Docker cleanup fences Docker only.
  const results=await Promise.allSettled([this.options.desktop.reconcile(),this.options.docker.reconcile()]);
  this.cleanupErrors={desktop_chrome:results[0].status==='rejected',docker:results[1].status==='rejected'};
 }
 private cleanupErrors={desktop_chrome:false,docker:false};
 async readyFor(agentId:string){const selected=this.selected(agentId);if(this.cleanupErrors[selected]){try{await this.runtime(agentId).reconcile();this.cleanupErrors[selected]=false;}catch{return{ready:false,message:'Previous browser cleanup is incomplete. Start the selected browser runtime and refresh.',backend:selected};}}return this.status(agentId);}
 async close(){await Promise.allSettled([this.options.desktop.close(),this.options.docker.close()]);}
}

export class BrowserSetupController {
 private busy=new Set<string>();
 constructor(private coordinator:Coordinator,private router:BrowserRuntimeRouter,private native:NativeChromeRuntime){}
 private async state(agentId:string):Promise<BrowserSetupState>{
  const selected=this.router.selected(agentId),runtime=await this.router.readyFor(agentId);
  if(selected==='docker')return{agentId,backend:selected,ready:runtime.ready,message:runtime.message,registered:false,extensionConnected:false,setupRequired:false,supportsTransfers:true};
  const profile=await this.native.agentStatus(agentId);
  return{agentId,backend:selected,ready:runtime.ready&&profile.connected,message:runtime.ready?profile.message:runtime.message,registered:profile.registered,extensionConnected:profile.connected,setupRequired:profile.setupRequired,supportsTransfers:false,extensionPath:profile.extensionPath,health:runtime.ready?profile.health:'runtime_unavailable',extensionInstalled:profile.extensionInstalled,profileRunning:profile.profileRunning};
 }
 private async guard(agentId:string,switching=false){
  const browser=await this.coordinator.browser.handle({type:'browser.state',agentId});
  if(switching?['ready','starting','closing'].includes(browser.lifecycle):browser.controller==='agent'||browser.controller==='transitioning'||['starting','closing'].includes(browser.lifecycle))throw new BrowserError('browser_busy',switching?'Close this browser before changing its browser type.':'Take control before opening this Chrome window.');
  if((switching||browser.controller!=='human')&&this.coordinator.snapshot().tasks.some(t=>t.agentId===agentId&&['running','pausing','recovering'].includes(t.state)))throw new BrowserError('browser_busy','Pause this agent’s running task before changing its browser setup.');
 }
 async handle(raw:unknown):Promise<BrowserSetupState>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))throw new BrowserError('invalid_command','Choose a browser setup action.');
  const value=raw as Record<string,unknown>,agentId=id(value.agentId);
  if(!this.coordinator.snapshot().agents.some(a=>a.id===agentId))throw new BrowserError('not_found','Select an existing agent.');
  if(!['browserSetup.state','browserSetup.prepare','browserSetup.openProfile','browserSetup.selectBackend'].includes(String(value.type))||Object.keys(value).some(k=>!['type','agentId',...(value.type==='browserSetup.selectBackend'?['backend']:[])].includes(k)))throw new BrowserError('invalid_command','Choose a browser setup action.');
  if(value.type==='browserSetup.state')return this.state(agentId);
  if(this.busy.has(agentId))throw new BrowserError('browser_busy','Wait for browser setup to finish.');this.busy.add(agentId);
  try{
   if(value.type==='browserSetup.selectBackend'){const selected=backend(value.backend);await this.guard(agentId,true);this.router.select(agentId,selected);}
   else{if(this.router.selected(agentId)!=='desktop_chrome')throw new BrowserError('invalid_command','Choose dedicated Chrome first.');await this.guard(agentId);await this.native.setup(agentId);await this.guard(agentId);await this.native.openProfile(agentId,{setup:value.type==='browserSetup.prepare'});}
   return this.state(agentId);
  }catch(error){if(error instanceof BrowserError)throw error;throw new BrowserError('browser_setup_failed','Chrome setup could not finish. Run the native browser setup check and try again.');}
  finally{this.busy.delete(agentId);}
 }
}
