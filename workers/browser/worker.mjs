import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FrameDecoder, encodeFrame, SessionController, ProtocolError, permittedURL, permittedTabURL, boundedString, integer, opaque, fail, FILE_BYTES } from './protocol.mjs';
import { ProfileStore, TransferStore } from './files.mjs';
import {readGmailListing} from './gmail.mjs';
import { sandboxEvidence } from './sandbox.mjs';
import { createDOMFence } from './dom-fence.mjs';

const viewport={width:1120,height:760},MAX_TABS=6;
const controller=new SessionController(Number(process.env.BROWSER_INITIAL_GENERATION));
const profile=new ProfileStore(),transfers=new TransferStore();
const pages=new Map(),revisions=new Map(),targets=new Map(),domFences=new Map(),permissions=[],retiredHandles=new Set();
let context,phase='restore',selectedTabId=null,shuttingDown=false,writes=Promise.resolve(),downloadTimer,queuedWriteBytes=0;
function send(value){const frame=encodeFrame(value);if(queuedWriteBytes+frame.length>8*1024*1024)fail('response_queue_full');queuedWriteBytes+=frame.length;writes=writes.then(()=>new Promise((resolve,reject)=>process.stdout.write(frame,e=>e?reject(e):resolve()))).finally(()=>{queuedWriteBytes-=frame.length;});return writes;}
function getPage(id){opaque(id);const page=pages.get(id);if(!page||page.isClosed())fail('unknown_tab');return page;}
function active(){if(phase!=='running')fail('session_not_running');}
function invalidate(id){revisions.set(id,(revisions.get(id)||0)+1);const known=targets.get(id);targets.delete(id);for(const item of known?.values()||[])retiredHandles.add(item.handle);}
async function executeAndDispose(req){try{return await execute(req);}finally{const retired=[...retiredHandles];retiredHandles.clear();await Promise.allSettled(retired.map(handle=>handle.dispose()));}}
function current(p,check=true){active();const page=getPage(p.tab);if(check&&p.revision!==revisions.get(p.tab))fail('stale_observation');return page;}
function target(p,kind){current(p);opaque(p.ref);const item=targets.get(p.tab)?.get(p.ref);if(!item||item.revision!==p.revision)fail('stale_observation');if(kind&&!kind.includes(item.kind))fail('invalid_target');return item.handle;}
async function domFence(id){let fence=domFences.get(id);if(!fence){const handle=await getPage(id).evaluateHandle(createDOMFence);fence={handle,observed:null};domFences.set(id,fence);}return fence;}
async function readDOM(id){return(await domFence(id)).handle.evaluate(f=>f.read());}
function dropDOM(id){const fence=domFences.get(id);domFences.delete(id);if(fence)retiredHandles.add(fence.handle);}
async function freshDOM(p){current(p);const fence=domFences.get(p.tab);if(!fence||fence.observed===null)fail('stale_observation');let actual;try{actual=await readDOM(p.tab);}catch{invalidate(p.tab);dropDOM(p.tab);fail('stale_observation');}if(actual!==fence.observed){invalidate(p.tab);fail('stale_observation');}}
async function reviewedAction(p,kind){await freshDOM(p);const handle=target(p,kind==='fill'?['input']:kind==='select'?['select']:undefined),fence=domFences.get(p.tab);const result=await getPage(p.tab).evaluate(({state,el,revision,action})=>state.act(el,revision,action),{state:fence.handle,el:handle,revision:fence.observed,action:{kind,...(kind==='click'?{}:{value:boundedString(p.value,8192)})}});if(result?.error)fail(result.error);if(!result?.acted)fail('outcome_unknown');}
function origin(raw){try{return new URL(permittedURL(raw)).origin;}catch{fail('permission_denied');}}
function register(page){
  for(const [id,known]of pages)if(known===page)return id;
  if(pages.size>=MAX_TABS){void page.close();return null;}
  const id=randomUUID();pages.set(id,page);revisions.set(id,1);selectedTabId??=id;
  page.on('framenavigated',frame=>{if(frame===page.mainFrame()){invalidate(id);dropDOM(id);if(page.url()!=='about:blank')try{permittedURL(page.url());}catch{void page.close();}}});
  page.on('close',()=>{invalidate(id);dropDOM(id);pages.delete(id);revisions.delete(id);if(selectedTabId===id)selectedTabId=pages.keys().next().value||null;});
  page.on('dialog',dialog=>void dialog.dismiss());
  page.on('download',download=>{
    let pageOrigin=null;try{pageOrigin=origin(page.url());}catch{}
    const item=transfers.addDownload(download,download.suggestedFilename(),{tabId:id,origin:pageOrigin});if(!item)return;
    void (async()=>{try{const path=await download.path();if(!path)fail('download_failed');await transfers.completeDownload(item,path);}catch{item.completed=true;item.status='failed';item.bytes=0;await download.cancel().catch(()=>{});await download.delete().catch(()=>{});}})();
  });return id;
}
async function tabs(){return Promise.all([...pages].map(async([id,page])=>({id,url:page.url().slice(0,4096),title:(await page.title().catch(()=>'' )).slice(0,200),revision:revisions.get(id)})));}
async function semanticTargets(page,id,revision){
  const group=await page.evaluateHandle(()=>{
    const found=[],walker=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_ELEMENT);let node=walker.currentNode,visited=0;
    while(node&&visited++<10000&&found.length<150){
      if(node.matches('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')&&(node.getClientRects().length||node.matches('input[type="file"]')))found.push(node);
      node=walker.nextNode();
    }return found;
  });
  const map=new Map(),result=[];
  try{for(const [key,value]of await group.getProperties()){
    if(!/^\d+$/.test(key)){await value.dispose();continue;}const handle=value.asElement();if(!handle){await value.dispose();continue;}
    const metadata=await handle.evaluate(el=>{
      const tag=el.tagName.toLowerCase(),type=(el.getAttribute('type')||'').toLowerCase();
      const kind=tag==='input'&&type==='file'?'file':tag==='input'||tag==='textarea'||el.isContentEditable?'input':tag==='select'?'select':tag==='a'?'link':'button';
      return{kind,label:(el.getAttribute('aria-label')||el.labels?.[0]?.textContent||el.getAttribute('placeholder')||el.getAttribute('title')||el.textContent||type||tag).slice(0,160),password:type==='password'};
    });
    const ref=randomUUID();map.set(ref,{handle,kind:metadata.kind,revision});result.push({ref,...metadata});
  }}finally{await group.dispose();}
  targets.set(id,map);return result;
}
async function observe(id,actor,includeScreenshot=true){
  active();id=id||selectedTabId;if(!id)fail('unknown_tab');const page=getPage(id);selectedTabId=id;
  const deadline=Date.now()+8000;
  for(let attempt=0;attempt<4&&Date.now()<deadline;attempt++){
    await delay(attempt?75:25);const before=revisions.get(id),url=page.url();
    try{
      await page.waitForLoadState('domcontentloaded',{timeout:Math.max(1,Math.min(2000,deadline-Date.now()))});
      const domBefore=await readDOM(id),title=(await page.title()).slice(0,200),text=await page.evaluate(()=>document.body?.innerText?.slice(0,16000)||'');
      invalidate(id);const revision=revisions.get(id),refs=await semanticTargets(page,id,revision);let frame=null;
      if(includeScreenshot&&actor!=='agent'){
        // Hiding the caret writes temporary inline styles to editable elements, which
        // would invalidate this freshly returned observation through our DOM fence.
        const jpeg=await page.screenshot({type:'jpeg',quality:55,caret:'initial',timeout:Math.max(1,Math.min(3000,deadline-Date.now()))});if(jpeg.length>2*1024*1024)fail('frame_too_large');
        frame={jpegBase64:jpeg.toString('base64'),...viewport,revision,tabId:id};
      }
      if(page.url()!==url||revisions.get(id)!==revision||revision!==before+1||await readDOM(id)!==domBefore)continue;
      domFences.get(id).observed=domBefore;
      return{tabs:await tabs(),selectedTabId:id,tab:id,url:url.slice(0,4096),title,text,revision,targets:refs,frame,permissions:[...permissions]};
    }catch(error){if(page.isClosed())fail('unknown_tab');if(error instanceof ProtocolError&&error.code==='frame_too_large')throw error;}
  }fail('observation_unavailable');
}
async function peek(id){
  active();id=id||selectedTabId;const page=getPage(id);
  for(let attempt=0;attempt<3;attempt++){
    const revision=revisions.get(id),url=page.url();const jpeg=await page.screenshot({type:'jpeg',quality:55,caret:'initial',timeout:3000});
    if(jpeg.length>2*1024*1024)fail('frame_too_large');
    if(revisions.get(id)!==revision||page.url()!==url)continue;
    return{tabs:await tabs(),selectedTabId:id,frame:{jpegBase64:jpeg.toString('base64'),...viewport,revision,tabId:id}};
  }fail('observation_unavailable');
}
async function gmailUnread(p){
  const page=current(p,false),account=boundedString(p.account,254).toLowerCase();
  if(!/^[a-z0-9._%+-]+@gmail\.com$/.test(account)||new URL(page.url()).origin!=='https://mail.google.com')fail('permission_denied');
  let result;
  for(let attempt=0;attempt<12;attempt++){
    result=await page.evaluate(readGmailListing,account);
    if(result.accountVerified&&result.listingVerified)break;await delay(500);
  }
  return result;
}
function coordinate(value,max){if(!Number.isFinite(value)||value<0||value>=max)fail('invalid_coordinate');return value;}
async function uploadDestination(p){
  const page=current(p),handle=target(p,['file']),allowed=origin(p.origin);if(p.origin!==allowed||origin(page.url())!==allowed)fail('upload_origin_mismatch');
  const details=await handle.evaluate(el=>({file:el.tagName==='INPUT'&&el.type==='file',connected:el.isConnected,formAction:el.form?.action||location.href,origin:location.origin,overrides:el.form?[...el.form.elements].filter(node=>node.hasAttribute('formaction')).slice(0,151).map(node=>node.formAction):[]}));
  if(!details.file||!details.connected||details.origin!==allowed||origin(details.formAction)!==allowed||details.overrides.length>150||details.overrides.some(action=>origin(action)!==allowed))fail('upload_origin_mismatch');return handle;
}
async function inspectDownloads(){
  if(phase!=='running')return;let total=[...transfers.uploads.values()].reduce((n,i)=>n+i.bytes,0),over=false;
  try{for(const name of await readdir('/transfers/downloads')){const stat=await lstat(join('/transfers/downloads',name));if(!stat.isFile()||stat.nlink!==1||stat.size>FILE_BYTES)over=true;total+=stat.size;}if(total>transfers.totalLimit)over=true;}catch{return;}
  if(over)for(const item of transfers.downloads.values())if(!item.completed){await transfers.cancel(item.id).catch(()=>{});await item.download.delete().catch(()=>{});}
}
async function launch(){
  if(phase!=='restore')fail('session_state');profile.launch();
  const proxy=new URL(process.env.BROWSER_PROXY_SERVER||'');if(proxy.protocol!=='http:'||proxy.username||proxy.password)fail('invalid_proxy_configuration');
  context=await chromium.launchPersistentContext('/profile',{
    headless:true,chromiumSandbox:true,viewport,acceptDownloads:true,downloadsPath:'/transfers/downloads',permissions:[],serviceWorkers:'block',
    ignoreDefaultArgs:['--disable-dev-shm-usage'],proxy:{server:proxy.href},
    args:['--proxy-bypass-list=<-loopback>','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-quic','--deny-permission-prompts'],timeout:30000,
  });
  context.setDefaultTimeout(6000);context.setDefaultNavigationTimeout(12000);
  const sandbox=await sandboxEvidence(context);
  await context.clearPermissions();
  await context.route('**/*',route=>{try{permittedURL(route.request().url());return route.continue();}catch{return route.abort('blockedbyclient');}});
  await context.exposeBinding('__awPageChanged',({page})=>{for(const [id,known]of pages)if(known===page){invalidate(id);break;}});
  await context.exposeBinding('__awPermissionDenied',({frame},permission)=>{
    if(!['geolocation','camera','microphone','notifications','clipboard'].includes(permission)||permissions.length>=32)return;
    let value;try{value=new URL(frame.url()).origin;}catch{return;}
    if(!permissions.some(p=>p.permission===permission&&p.origin===value))permissions.push({permission,origin:value,state:'denied',source:'page_report'});
  });
  await context.addInitScript(()=>{
    // MutationObserver already batches synchronous changes. A timer here would
    // deliver old load mutations after returning a fresh observation to the owner.
    new MutationObserver(()=>{try{void globalThis.__awPageChanged();}catch{}}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
    const report=kind=>{try{void globalThis.__awPermissionDenied(kind);}catch{}};
    if(navigator.geolocation){navigator.geolocation.getCurrentPosition=(_ok,bad)=>{report('geolocation');bad?.({code:1,message:'Permission denied by workspace policy'});};navigator.geolocation.watchPosition=(_ok,bad)=>{report('geolocation');bad?.({code:1,message:'Permission denied by workspace policy'});return 0;};}
    if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=async options=>{if(options?.video)report('camera');if(options?.audio)report('microphone');throw new DOMException('Permission denied','NotAllowedError');};
    if(globalThis.Notification)Notification.requestPermission=async()=>{report('notifications');return'denied';};
  });
  phase='running';for(const page of context.pages())register(page);context.on('page',register);if(!pages.size)register(await context.newPage());
  downloadTimer=setInterval(()=>void inspectDownloads(),100);downloadTimer.unref();
  return{sandbox,observation:await observe(selectedTabId,'broker'),phase};
}
async function closeSession(p){
  if(phase!=='running')fail('session_state');if(p.discardPending!==undefined&&typeof p.discardPending!=='boolean')fail('invalid_params');
  if(transfers.downloads.size&&!p.discardPending)fail('downloads_pending');
  if(p.discardPending)await transfers.discard();else for(const id of [...transfers.uploads.keys()])await transfers.abort(id);
  clearInterval(downloadTimer);await context.close();phase='closed';const manifest=await profile.manifest();return{phase,profile:manifest};
}
async function execute(req){
  const p=req.params;
  switch(req.method){
    case 'session.launch':try{return await launch();}catch{phase='failed';await context?.close().catch(()=>{});fail('browser_startup_or_sandbox_failed');}case 'session.status':return{phase,tabs:phase==='running'?await tabs():[],downloads:transfers.list()};case 'session.close':return closeSession(p);
    case 'profile.restore.begin':return profile.begin(p);case 'profile.restore.file':return profile.add(p);case 'profile.restore.chunk':return profile.chunk(p);case 'profile.restore.finish':return profile.finish();case 'profile.read':if(phase!=='closed')fail('profile_not_closed');return profile.read(p);
    case 'tabs.list':active();return tabs();
    case 'tabs.open':{active();if(pages.size>=MAX_TABS)fail('tab_limit');const url=permittedTabURL(p.url),page=await context.newPage(),id=register(page);if(url!=='about:blank')try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:12000});}catch{if(page.isClosed())fail('unknown_tab');}return observe(id,req.actor);}
    case 'tabs.close':current(p,false);await getPage(p.tab).close();if(!pages.size)register(await context.newPage());return{tabs:await tabs(),selectedTabId};
    case 'page.navigate':{const page=current(p,false);await page.goto(permittedURL(p.url),{waitUntil:'domcontentloaded',timeout:12000});return observe(p.tab,req.actor);}
    case 'page.observe':return observe(p.tab,req.actor,p.screenshot!==false);
    case 'page.peek':return peek(p.tab);
    case 'page.gmailUnread':return gmailUnread(p);
    case 'page.click':{const page=current(p);if(p.ref!==undefined){if(p.x!==undefined||p.y!==undefined)fail('invalid_params');if(req.actor==='agent')await reviewedAction(p,'click');else await target(p).click({timeout:6000});}else{if(req.actor!=='human')fail('permission_denied');await page.mouse.click(coordinate(p.x,viewport.width),coordinate(p.y,viewport.height));}return observe(p.tab,req.actor);}
    case 'page.fill':{if(req.actor==='agent')await reviewedAction(p,'fill');else await target(p,['input']).fill(boundedString(p.value,8192),{timeout:6000});return observe(p.tab,req.actor);}
    case 'page.select':{if(req.actor==='agent')await reviewedAction(p,'select');else await target(p,['select']).selectOption({value:boundedString(p.value,8192)},{timeout:6000});return observe(p.tab,req.actor);}
    case 'page.key':{const page=current(p);if(req.actor==='agent'&&await page.evaluate(()=>document.activeElement?.matches('input[type="password"]')))fail('human_login_required');if(p.text!==undefined){if(p.key!==undefined)fail('invalid_params');await page.keyboard.insertText(boundedString(p.text,8192));}else{const key=boundedString(p.key,80);if(!/^(?:(?:Control|Meta|Alt|Shift)\+){0,3}(?:Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Space|[a-zA-Z0-9])$/.test(key))fail('invalid_key');await page.keyboard.press(key);}return observe(p.tab,req.actor);}
    case 'page.scroll':{const page=current(p);if(![p.x,p.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=2000))fail('invalid_scroll');await page.mouse.wheel(p.x,p.y);return observe(p.tab,req.actor);}
    case 'control.take':active();return{observation:await observe(p.tab||selectedTabId,'human')};
    case 'control.release':active();for(const id of pages.keys())invalidate(id);return{tabs:await tabs(),selectedTabId,requiresFreshObservation:true};
    case 'upload.begin':await uploadDestination(p);return transfers.begin({...p,generation:req.generation});
    case 'upload.chunk':active();return transfers.chunk(p);
    case 'upload.finish':{active();const item=await transfers.finish(p.id);if(item.generation!==req.generation)fail('stale_generation');const input=await uploadDestination(item);await input.setInputFiles(item.full,{timeout:6000});transfers.attached(item.id);return{uploaded:true,versionId:item.versionId,observation:await observe(item.tab,'broker')};}
    case 'upload.abort':return transfers.abort(p.id);
    case 'download.list':return transfers.list();case 'download.read':return transfers.read(p);case 'download.ack':return transfers.ack(p.id);case 'download.cancel':return transfers.cancel(p.id);
    default:fail('unknown_method');
  }
}
async function shutdown(code=0){if(shuttingDown)return;shuttingDown=true;clearInterval(downloadTimer);await context?.close().catch(()=>{});await writes.catch(()=>{});process.exit(code);}
try{
  if(process.platform!=='linux'||process.getuid()===0)fail('non_root_linux_required');await transfers.init();
  await send({type:'ready',protocol:3,phase,...controller.state(),limits:{tabs:MAX_TABS,viewport,chunkBytes:128*1024,fileBytes:FILE_BYTES,profileBytes:256*1024*1024}});
  const decoder=new FrameDecoder();
  process.stdin.on('data',chunk=>{try{for(const req of decoder.push(chunk)){try{controller.submit(req,()=>executeAndDispose(req)).then(result=>send({id:req.id,ok:true,...result}),error=>send({id:req.id,ok:false,...controller.state(),error:error instanceof ProtocolError?error.code:'browser_action_failed'})).catch(()=>shutdown(1));}catch{void send({type:'fatal',error:'invalid_request'}).finally(()=>shutdown(1));}}}catch{void send({type:'fatal',error:'invalid_frame'}).finally(()=>shutdown(1));}});
  process.stdin.on('end',()=>{try{decoder.end();void shutdown();}catch{void shutdown(1);}});process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
}catch{await send({type:'fatal',error:'browser_startup_or_sandbox_failed'});await shutdown(1);}
