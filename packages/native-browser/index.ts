import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer,createConnection,type Socket,type Server} from 'node:net';
import {access,chmod,lstat,mkdir,readFile,realpath,readdir,unlink,writeFile,rename,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserRuntime,BrowserHandle,BrowserReply} from '../browser/runtime';
import {Decoder,encode} from './framing.mjs';
import {describeProfileHealth,profileExtensionInstalled,profileIsRunning} from './health';
import type {BrowserHealth} from '../contracts/browser-setup';
export type NativeProfileStatus={backend:'desktop_chrome';registered:boolean;connected:boolean;taskReady?:boolean;extensionPath:string;setupRequired:boolean;message:string|null;health:BrowserHealth;extensionInstalled:boolean|null;profileRunning:boolean|null};
type Options={dataRoot:string;extensionPath:string;hostPath:string;nodePath?:string;chromePath?:string;onChanged?:()=>void;bridgeInstallRoot?:string};
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
type Connection={compatible?:boolean;socket:Socket;agentId:string;pending:Map<string,Pending>;send:(method:string,params:Record<string,unknown>)=>Promise<any>;handle?:Handle};
export function compatibleExtension(value:unknown):boolean {const v=value as {protocol?:unknown;capabilities?:unknown};return !!v&&v.protocol===1&&Array.isArray(v.capabilities)&&['generation-fence','dom-fence','readonly-fill','navigation-completion','owner-handoff'].every(c=>(v.capabilities as unknown[]).includes(c));}
const ID=/^[a-zA-Z0-9_-]{1,96}$/;
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
async function privateFile(path:string,content:string|Uint8Array,mode:number){
  try{const old=await lstat(path);if(!old.isFile()||old.isSymbolicLink()||old.nlink!==1||old.uid!==process.getuid?.())fail('unsafe_profile');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=`${path}.${randomUUID()}.tmp`;const file=await open(temporary,'wx',mode);try{await file.writeFile(content);await file.sync();}finally{await file.close();}try{await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
}
async function secureDir(path:string){await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid?.())fail('unsafe_profile');await chmod(path,0o700);}
class Handle implements BrowserHandle {
  stopped=false;generation:number;
  constructor(readonly runtime:NativeChromeRuntime,readonly connection:Connection,readonly sessionId:string,readonly onExit:()=>void,generation:number){this.generation=generation;}
  async request(method:string,params:Record<string,unknown>,options:{actor:'agent'|'human'|'owner';generation:number}):Promise<BrowserReply>{
    if(this.stopped||this.connection.handle!==this)fail('session_not_running');
    if(options.generation!==this.generation)fail('stale_generation');
    const old=this.generation;
    // Local fence closes admission immediately, before waiting for the extension.
    if(method==='control.take'||method==='control.release')this.generation++;
    try{const reply=await this.connection.send('session.request',{sessionId:this.sessionId,request:{method,params,...options}});
      if(this.stopped||this.connection.handle!==this)fail('outcome_unknown');
      if(!reply||!['agent','human','transitioning'].includes(reply.controller)||reply.generation!==this.generation)fail('outcome_unknown');
      return reply;
    }catch(error){if(this.generation!==old&&!this.stopped){await this.stop();this.onExit();}throw error;}
  }
  async close(_options:{saveProfile:boolean}){await this.stop();return{saved:true,savedAt:Date.now()};}
  async stop(){if(this.stopped)return;this.stopped=true;this.generation++;if(this.connection.handle===this)this.connection.handle=undefined;try{await this.connection.send('session.end',{sessionId:this.sessionId});}catch{this.connection.socket.destroy();}}
  lost(){if(this.stopped)return;this.stopped=true;this.generation++;this.onExit();}
}
export class NativeChromeRuntime implements BrowserRuntime {
  private root:string;private readonly installRoot:string;private readonly socketPath:string;private readonly chromePath:string;
  private server?:Server;private ownsSocket=false;private init?:Promise<void>;private closed=false;
  private allowedOrigin:string|null=null;private connections=new Map<string,Connection>();private profileTokens=new Map<string,string>();private profileProblems=new Set<string>();
  constructor(readonly options:Options){this.root=resolve(options.dataRoot,'native-browser');this.installRoot=options.bridgeInstallRoot||join(homedir(),'Library/Application Support/Agent Workspaces/runtime/browser-bridge',createHash('sha256').update(this.root).digest('hex').slice(0,24));this.chromePath=options.chromePath||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';this.socketPath=join('/tmp',`aw-native-${process.getuid?.()||0}-${createHash('sha256').update(this.root).digest('hex').slice(0,16)}`,'bridge.sock');}
  private installation(agentId:string){if(!ID.test(agentId))fail('invalid_agent');return join(this.installRoot,agentId);}
  private profile(agentId:string){if(!ID.test(agentId))fail('invalid_agent');return join(this.root,'profiles',agentId);}
  private async prerequisites(){if(process.platform!=='darwin')fail('desktop_chrome_requires_mac');await Promise.all([access(this.chromePath,constants.X_OK),access(join(dirname(this.options.hostPath),'bin/native-host'),constants.X_OK),access(join(this.options.extensionPath,'manifest.json'),constants.R_OK)]);}
  async status(agentId?:string){try{await this.prerequisites();const profile=agentId?await this.agentStatus(agentId):null;return{ready:true,message:profile?.message||null,backend:'desktop_chrome' as const,setupRequired:profile?.setupRequired??false,extensionConnected:profile?.connected??false,supportsTransfers:false};}catch{return{ready:false,message:'Install Google Chrome and build the desktop browser bridge, then prepare this agent’s profile.',backend:'desktop_chrome' as const,setupRequired:true,extensionConnected:false,supportsTransfers:false};}}
  async reconcile(){await this.ensure();}
  private ensure(){if(this.init)return this.init;const work=this.initialize().catch(async error=>{if(this.server){for(const c of this.connections.values())c.socket.destroy();this.connections.clear();await new Promise<void>(resolve=>this.server!.close(()=>resolve()));this.server=undefined;if(this.ownsSocket)await unlink(this.socketPath).catch(()=>{});this.ownsSocket=false;}this.init=undefined;throw error;});this.init=work;return work;}
  private async initialize(){
    if(this.closed)fail('runtime_closed');this.allowedOrigin=`chrome-extension://${await this.extensionId()}/`;await secureDir(this.root);this.root=await realpath(this.root);await secureDir(dirname(this.socketPath));
    try{const stat=await lstat(this.socketPath);if(!stat.isSocket()||stat.uid!==process.getuid?.())fail('unsafe_socket');
      const alive=await new Promise<boolean>(res=>{const probe=createConnection(this.socketPath);probe.once('connect',()=>{probe.destroy();res(true);});probe.once('error',()=>res(false));probe.setTimeout(500,()=>{probe.destroy();res(true);});});if(alive)fail('runtime_owned');await unlink(this.socketPath);
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    this.server=createServer(socket=>this.accept(socket));await new Promise<void>((res,rej)=>{this.server!.once('error',rej);this.server!.listen(this.socketPath,()=>{this.server!.off('error',rej);this.ownsSocket=true;res();});});await chmod(this.socketPath,0o600);
    // Refresh only our own existing profile registrations after an app restart.
    for(const id of await readdir(join(this.root,'profiles')).catch(()=>[])){if(ID.test(id))try{await this.register(id);this.profileProblems.delete(id);}catch{this.profileProblems.add(id);this.profileTokens.delete(id);}}
  }
  private async extensionId(){const manifest=JSON.parse(await readFile(join(this.options.extensionPath,'manifest.json'),'utf8'));if(typeof manifest.key!=='string')fail('extension_manifest');return [...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest().subarray(0,16)].map(n=>String.fromCharCode(97+(n>>4),97+(n&15))).join('');}
  private async register(agentId:string){
    await secureDir(join(this.root,'profiles'));const profile=this.profile(agentId);await secureDir(profile);if(await realpath(profile)!==profile)fail('unsafe_profile');
    const manifestDir=join(profile,'NativeMessagingHosts');await secureDir(manifestDir);
    const token=this.profileTokens.get(agentId)||randomBytes(32).toString('hex');this.profileTokens.set(agentId,token);
    const extensionId=await this.extensionId();await secureDir(this.installRoot);const installation=this.installation(agentId);await secureDir(installation);if(await realpath(installation)!==installation)fail('unsafe_profile');
    const configPath=join(installation,'host-config.json'),executable=join(installation,'native-host');
    await privateFile(configPath,JSON.stringify({agentId,profile,token,extensionId,socketPath:this.socketPath}),0o600);
    await privateFile(executable,await readFile(join(dirname(this.options.hostPath),'bin/native-host')),0o700);
    await privateFile(join(manifestDir,'com.agent_workspaces.browser.json'),JSON.stringify({name:'com.agent_workspaces.browser',description:'Dedicated Agent Workspaces browser bridge',path:executable,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]},null,2),0o600);
  }
  async setup(agentId:string):Promise<NativeProfileStatus>{if(this.closed)fail('runtime_closed');await this.prerequisites();await this.ensure();await this.register(agentId);this.profileProblems.delete(agentId);return this.agentStatus(agentId);}
  async agentStatus(agentId:string):Promise<NativeProfileStatus>{
    const profile=this.profile(agentId),registered=await access(join(profile,'NativeMessagingHosts/com.agent_workspaces.browser.json')).then(()=>true,()=>false),connected=this.connections.has(agentId);
    const connection=this.connections.get(agentId);if(connection&&connection.compatible===undefined){try{connection.compatible=compatibleExtension(await connection.send('bridge.capabilities',{}));}catch{connection.compatible=false;}}
    const [extensionInstalled,profileRunning]=connected?[true,true]:await Promise.all([this.extensionId().then(id=>profileExtensionInstalled(profile,id)).catch(()=>null),profileIsRunning(profile)]);
    const health=describeProfileHealth({registered,connected,damaged:this.profileProblems.has(agentId),installed:extensionInstalled,running:profileRunning});
    return{backend:'desktop_chrome',registered,connected,taskReady:connected&&connection?.compatible===true,extensionPath:resolve(this.options.extensionPath),extensionInstalled,profileRunning,...health,...(connected&&!this.connections.get(agentId)?.compatible?{message:'Chrome is connected. Reload the extension to verify compatibility before running tasks.'}:{})};
  }
  async openProfile(agentId:string,{setup=false}:{setup?:boolean}={}):Promise<NativeProfileStatus>{await this.setup(agentId);const connection=this.connections.get(agentId);if(connection){await connection.send(setup?'owner.setup':'owner.show',{});}else this.startChrome(agentId,setup?'chrome://extensions/':'about:blank');return this.agentStatus(agentId);}
  private startChrome(agentId:string,ownerURL?:string){const args=[`--user-data-dir=${this.profile(agentId)}`,'--no-first-run','--no-default-browser-check',...(ownerURL?['--new-window',ownerURL]:['--no-startup-window'])];const executable=ownerURL?'/usr/bin/open':this.chromePath;const launchArgs=ownerURL?['-n','-a',resolve(this.chromePath,'../../..'),'--args',...args]:args;const child=spawn(executable,launchArgs,{detached:true,stdio:'ignore'});child.on('error',()=>this.options.onChanged?.());child.unref();}
  async launch(options:{sessionId:string;agentId:string;initialGeneration:number;onExit:()=>void}):Promise<BrowserHandle>{
    if(!ID.test(options.sessionId)||!Number.isSafeInteger(options.initialGeneration)||options.initialGeneration<1)fail('invalid_session');await this.setup(options.agentId);
    if(!this.connections.has(options.agentId))this.startChrome(options.agentId);
    const deadline=Date.now()+10_000;while(!this.connections.has(options.agentId)&&Date.now()<deadline&&!this.closed)await delay(100);
    const connection=this.connections.get(options.agentId);if(!connection)fail('extension_setup_required');if(connection.handle)fail('session_already_running');
    if(!compatibleExtension(await connection.send('bridge.capabilities',{})))fail('extension_reload_required');connection.compatible=true;
    const handle=new Handle(this,connection,options.sessionId,options.onExit,options.initialGeneration);connection.handle=handle;
    try{await connection.send('session.bind',{sessionId:options.sessionId,generation:options.initialGeneration});if(this.closed||handle.stopped)fail('runtime_closed');return handle;}catch(error){connection.handle=undefined;await handle.stop();throw error;}
  }
  private accept(socket:Socket){
    const decoder=new Decoder();let connection:Connection|undefined,authenticated=false,closed=false;const timer=setTimeout(()=>socket.destroy(),3000);
    socket.on('error',()=>socket.destroy());socket.on('close',()=>{if(closed)return;closed=true;clearTimeout(timer);if(connection){for(const p of connection.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(new Error('extension_disconnected'),{code:'extension_disconnected'}));}connection.pending.clear();if(this.connections.get(connection.agentId)===connection)this.connections.delete(connection.agentId);connection.handle?.lost();this.options.onChanged?.();}});
    socket.on('data',chunk=>{try{for(const raw of decoder.push(chunk)){
      const value=raw as Record<string,any>;
      if(!authenticated){if(!value||value.type!=='hello'||!ID.test(value.agentId)||value.profile!==this.profile(value.agentId)||typeof value.token!=='string'||value.token.length!==64||!this.profileTokens.has(value.agentId)||value.token!==this.profileTokens.get(value.agentId)||value.origin!==this.allowedOrigin)fail('invalid_host');
        // A valid host is already attested by the native wrapper; reject competing hosts.
        if(this.connections.has(value.agentId))fail('duplicate_host');authenticated=true;clearTimeout(timer);
        connection={socket,agentId:value.agentId,pending:new Map(),send:(method,params)=>new Promise((res,rej)=>{
          if(socket.destroyed||connection!.pending.size>=16)return rej(Object.assign(new Error('bridge_unavailable'),{code:'bridge_unavailable'}));const id=randomUUID();
          const timeout=setTimeout(()=>{connection!.pending.delete(id);rej(Object.assign(new Error('outcome_unknown'),{code:'outcome_unknown'}));socket.destroy();},15_000);
          connection!.pending.set(id,{resolve:res,reject:rej,timer:timeout});try{socket.write(encode({id,method,params}));}catch(error){clearTimeout(timeout);connection!.pending.delete(id);rej(error);socket.destroy();}
        })};this.connections.set(value.agentId,connection);socket.write(encode({type:'bridge.connected'}));this.options.onChanged?.();continue;
      }
      if(!value||typeof value.id!=='string')fail('invalid_reply');const p=connection!.pending.get(value.id);if(!p)continue;connection!.pending.delete(value.id);clearTimeout(p.timer);
      if(value.error){const code=typeof value.error==='string'&&/^[a-z_]{1,64}$/.test(value.error)?value.error:'browser_failed';p.reject(Object.assign(new Error(code),{code}));}else p.resolve(value.result);
    }}catch{socket.destroy();}});
  }
  async close(){if(this.closed)return;this.closed=true;await Promise.allSettled([...this.connections.values()].map(c=>c.handle?.stop()));for(const c of this.connections.values())c.socket.destroy();this.connections.clear();if(this.server){await new Promise<void>(res=>this.server!.close(()=>res()));await unlink(this.socketPath).catch(()=>{});}}
}
