import {BrowserWindow,session,type Session} from 'electron';
import {randomUUID} from 'node:crypto';
import type {BrowserRuntime,BrowserHandle,BrowserReply} from '../../../packages/browser/runtime';
import {LAB_ORIGIN,labURL,labInteractionURL,type LocalLabController} from '../../../packages/local-lab';
import {pageCommand} from '../../../extensions/agent-browser/page.mjs';

type Page={id:string;window:BrowserWindow;revision:number;documentId:string;url:string;title:string};
/** Dedicated ephemeral sessions for the bundled synthetic site; never personal profiles. */
export class ElectronLabRuntime implements BrowserRuntime {
 private handles=new Map<string,{handle:BrowserHandle;partition:Session}>();
 constructor(private lab:LocalLabController){}
 async status(){return{ready:this.lab.status().ready,message:this.lab.status().message,backend:'local_lab' as const,setupRequired:false,supportsTransfers:false};}
 async cookies(agentId:string){const entry=this.handles.get(agentId);if(!entry)return'';return(await entry.partition.cookies.get({url:LAB_ORIGIN})).map(c=>`${c.name}=${c.value}`).join('; ');}
 async reconcile(){}
 async close(){await Promise.allSettled([...this.handles.values()].map(x=>x.handle.stop()));this.handles.clear();await this.lab.close();}
 async launch(options:Parameters<BrowserRuntime['launch']>[0]):Promise<BrowserHandle>{
  if(!this.lab.status().ready||this.handles.has(options.agentId))throw new Error('lab_browser_unavailable');
  const partitionName='lab-'+randomUUID(),partition=session.fromPartition(partitionName,{cache:false});
  partition.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));partition.setPermissionCheckHandler(()=>false);
  partition.webRequest.onBeforeRequest((details,cb)=>{let allowed=false;try{allowed=new URL(details.url).origin===LAB_ORIGIN;}catch{}cb({cancel:!allowed});});
  partition.on('will-download',event=>event.preventDefault());
  let generation=options.initialGeneration,controller:BrowserReply['controller']='agent',closed=false;const pages=new Map<string,Page>();let active='';
  const guard=()=>{if(closed||!this.lab.status().ready)throw new Error('lab_browser_closed');};
  const make=async(url:string)=>{
   guard();if(pages.size>=6)throw new Error('tab_limit');const id=randomUUID();
   const window=new BrowserWindow({width:1040,height:760,show:false,title:'Harbor Desk — Agent lab browser',webPreferences:{partition:partitionName,sandbox:true,nodeIntegration:false,contextIsolation:true,devTools:false,webSecurity:true}});
   const page:Page={id,window,revision:1,documentId:'',url:labInteractionURL(url),title:'Harbor Desk'};pages.set(id,page);active=id;
   window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   window.webContents.on('will-navigate',(event,target)=>{try{labURL(target);}catch{event.preventDefault();}});
   window.webContents.on('will-redirect',(event,target)=>{try{labURL(target);}catch{event.preventDefault();}});
   window.on('closed',()=>{pages.delete(id);if(active===id)active=pages.keys().next().value||'';if(!closed&&!pages.size){closed=true;this.handles.delete(options.agentId);options.onExit();}});
   await window.loadURL(page.url);guard();window.showInactive();return page;
  };
  const execute=async(page:Page,command:Record<string,unknown>)=>{
   guard();labURL(page.window.webContents.getURL());
   const result=await page.window.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${pageCommand.toString()})(${JSON.stringify(command)})`}]) as Record<string,unknown>;
   guard();if(result.error)throw new Error(String(result.error));return result;
  };
  const observe=async(page:Page,peek=false)=>{
   if(!page||page.window.isDestroyed())throw new Error('unknown_tab');
   const data=await execute(page,{type:peek?'peek':'inspect'});page.revision=Number(data.revision);page.documentId=String(data.documentId);page.url=labURL(page.window.webContents.getURL());page.title=String(data.title).slice(0,200);
   const shot=await page.window.webContents.capturePage();const resized=shot.getSize().width>1400?shot.resize({width:1400}):shot;const size=resized.getSize(),jpeg=resized.toJPEG(65);
   return{tabs:[...pages.values()].map(p=>({id:p.id,url:p.url,title:p.title,revision:p.revision})),selectedTabId:page.id,tab:page.id,url:page.url,title:page.title,revision:page.revision,text:data.text,...(!peek?{targets:data.targets}:{}),humanLoginRequired:data.sensitive===true,...(jpeg.length<=2*1024*1024&&size.width>0&&size.height>0&&!data.sensitive?{frame:{jpegBase64:jpeg.toString('base64'),...size,tabId:page.id,revision:page.revision}}:{})};
  };
  const afterNavigation=async(page:Page)=>{
   // loadURL ends before client-side startup requests/rendering. Give a loading
   // document a bounded chance to expose real controls before returning it.
   const deadline=Date.now()+2000;
   while(Date.now()<deadline){
    const data=await execute(page,{type:'inspect'});
    if(Array.isArray(data.targets)&&data.targets.length||data.sensitive===true)break;
    await new Promise(resolve=>setTimeout(resolve,80));guard();
   }
   return observe(page);
  };
  const stop=async()=>{if(closed)return;closed=true;this.handles.delete(options.agentId);for(const p of pages.values())if(!p.window.isDestroyed())p.window.destroy();pages.clear();await partition.clearStorageData();};
  const handle:BrowserHandle={stop,close:async()=>{await stop();return{saved:false};},request:async(method,params,actor)=>{
   guard();if(actor.generation!==generation)throw new Error('stale_generation');
   if(method==='control.take'||method==='control.release'){
    if(actor.actor!=='owner')throw new Error('permission_denied');controller=method==='control.take'?'human':'agent';generation++;if(controller==='human'){const current=pages.get(typeof params.tab==='string'?params.tab:active);current?.window.show();current?.window.focus();}
    const page=pages.get(typeof params.tab==='string'?params.tab:active);return{controller,generation,result:{observation:page?await observe(page):{tabs:[],selectedTabId:null,targets:[]}}};
   }
   if(actor.actor==='agent'&&controller!=='agent'||actor.actor==='human'&&controller!=='human')throw new Error('controller_required');
   const fence=generation;let result:unknown;
   const page=pages.get(typeof params.tab==='string'?params.tab:active);
   if(method==='download.list')result=[];
   else if(method==='tabs.list')result=[...pages.values()].map(p=>({id:p.id,url:p.url,title:p.title,revision:p.revision}));
   else if(method==='tabs.open')result=await afterNavigation(await make(labInteractionURL(params.url)));
   else if(method==='tabs.close'){
    if(!page)throw new Error('unknown_tab');if(pages.size<=1)throw new Error('Keep one tab open; use lab_close to close the browser.');page.window.destroy();result=await observe(pages.get(active)!);
   }else if(method==='page.observe'||method==='page.peek')result=await observe(page!,method==='page.peek');
   else if(method==='page.navigate'){
    if(!page)throw new Error('unknown_tab');await page.window.loadURL(labInteractionURL(params.url));result=await afterNavigation(page);
   }else if(['page.click','page.fill','page.select','page.scroll','page.key'].includes(method)){
    if(!page)throw new Error('unknown_tab');if(params.revision!==page.revision)throw new Error('stale_observation');
    const command={type:method.slice(5),documentId:page.documentId,revision:params.revision,...(params.ref?{ref:params.ref}:{}),...(params.value!==undefined?{value:params.value}:{}),...(method==='page.scroll'?{x:Number(params.x)||0,y:Number(params.y)||0}:{}),...(method==='page.key'?{key:params.key}:{})};
    await execute(page,command);await new Promise(r=>setTimeout(r,180));result=await observe(page);
   }else throw new Error('unsupported_lab_method');
   guard();if(fence!==generation)throw new Error('controller_changed');return{controller,generation,result};
  }};
  this.handles.set(options.agentId,{handle,partition});try{await make(LAB_ORIGIN+'/');return handle;}catch(error){await stop();throw error;}
 }
}
