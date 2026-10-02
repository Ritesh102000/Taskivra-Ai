// Custom isolated Electron harness; deliberately never imports the app main process.
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const temp=process.env.IMPROVEMENT_RENDERER_PROFILE || mkdtempSync(join(tmpdir(),'r16-renderer-'));
app.setPath('userData',temp);
app.setPath('sessionData',join(temp,'session'));
const result={boundary:'Actual React renderer, synthetic bridge only, custom main, temporary userData; no production stores or runtimes',cases:{}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.on('console-message',(_event,...args)=>{if(String(args).includes('Error'))process.stderr.write(String(args)+'\n');});
 const js=s=>win.webContents.executeJavaScript(s,true);
 const click=async text=>{await js(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.click();})()`);await delay(100);};
 await win.loadFile(join(__dirname,'renderer-fixture.html'));await delay(200);
 await js('fixture.app()');await delay(300);
 await js(`document.querySelectorAll('.primary-nav button')[6].click()`);await delay(100);await js(`document.querySelector('.task-row').click()`);await delay(100);
 result.cases.failedRequestTaskDetail=await js(`({closed:document.body.innerText.includes('REQUEST CLOSED'),genericResponse:!!document.querySelector('#answer-requestA'),requestLoadErrorVisible:document.body.innerText.includes('Synthetic request list failure'),text:document.querySelector('.request-card')?.innerText,reviewOnlyCopy:document.body.innerText.includes('Open Security review')})`);
 await js(`fixture.requestState('open')`);await delay(100);result.cases.openFileFallback=await js(`({genericResponse:!!document.querySelector('#answer-requestA'),slotControl:document.body.innerText.includes('Choose file from Mac')})`);
 await js('fixture.repairRequests()');await delay(150);
 result.cases.repairedRequests=await js(`({structured:document.body.innerText.includes('FILES NEEDED'),checking:document.body.innerText.includes('Checking file'),oldLoadErrorVisible:document.body.innerText.includes('Synthetic request list failure')})`);
 await js(`fixture.state('paused')`);await delay(100);
 result.cases.modelGating=await js(`([...document.querySelectorAll('button')].filter(e=>e.textContent.trim()==='Run agent').map(e=>({disabled:e.disabled,parent:e.parentElement.className})))`);
 await click('Overview');await js('fixture.failures()');await delay(100);
 await click('See all task details →');
 result.cases.attentionOverflow=await js(`({caughtUp:document.body.innerText.includes('You’re all caught up'),hasSixth:document.body.innerText.includes('Failure 6'),heading:document.querySelector('h1')?.innerText})`);
 await js('fixture.files()');await delay(100);await click('From shared library');
 result.cases.sharedPicker=await js(`([...document.querySelectorAll('.file-use-choice strong')].map(e=>e.textContent))`);
 await js('fixture.library()');await delay(100);await js(`document.querySelector('.library-version-row').click()`);await delay(100);await click('Use in task');
 result.cases.destinationPicker=await js(`([...document.querySelectorAll('dialog option')].map(e=>e.textContent))`);
 await js('fixture.provider(true)');await delay(200);
 result.cases.providerLoadFailure=await js(`({emptyClaim:document.body.innerText.includes('No additional connections yet'),errorVisible:document.body.innerText.includes('Synthetic provider load failure'),addEnabled:[...document.querySelectorAll('button')].find(e=>e.textContent==='Add connection')?.disabled===false})`);
 result.cases.providerContrast={};
 for(const theme of ['light','dark']){
  await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
  result.cases.providerContrast[theme]=await js(`(()=>{const e=document.querySelector('.provider-note');const c=getComputedStyle(e);let p=e;const backgrounds=[];while(p){const b=getComputedStyle(p).backgroundColor;if(b!=='rgba(0, 0, 0, 0)')backgrounds.push({tag:p.tagName,class:p.className,color:b});p=p.parentElement;}return {text:e.textContent,color:c.color,fontSize:c.fontSize,fontWeight:c.fontWeight,backgrounds};})()`);
 }
 await click('Add connection');
 result.cases.providerCheckbox=await js(`(()=>{const label=document.querySelector('.provider-checkbox');const input=label.querySelector('input');const rect=e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height});return {label:rect(label),input:rect(input),inputDisplay:getComputedStyle(input).display,inputWidth:getComputedStyle(input).width,labelWidth:getComputedStyle(label).width};})()`);
 const assert=require('node:assert/strict');assert.equal(result.cases.failedRequestTaskDetail.closed,false);assert.equal(result.cases.openFileFallback.genericResponse,false);assert.equal(result.cases.repairedRequests.structured,true);assert.equal(result.cases.repairedRequests.oldLoadErrorVisible,false);assert(result.cases.modelGating.every(v=>v.disabled));assert.equal(result.cases.attentionOverflow.hasSixth,true);assert.equal(result.cases.attentionOverflow.caughtUp,false);assert.deepEqual(result.cases.sharedPicker,['ProjectA-file.txt v1']);assert.equal(result.cases.providerLoadFailure.emptyClaim,false);
 writeFileSync(join(process.cwd(),'.test-data/improvements/renderer-evidence.json'),JSON.stringify(result,null,2)+'\n');win.destroy();app.quit();
}).catch(error=>{process.stderr.write(error.stack+'\n');app.exit(1);});
app.on('will-quit',()=>{try{rmSync(temp,{recursive:true,force:true});}catch{}});
