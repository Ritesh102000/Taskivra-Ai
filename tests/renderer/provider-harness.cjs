// Only this custom main runs. No application main/preload, Keychain or browser stores.
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const temp=process.env.IMPROVEMENT_RENDERER_PROFILE||mkdtempSync(join(tmpdir(),'r18-provider-'));
app.setPath('userData',temp);app.setPath('sessionData',join(temp,'session'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const js=script=>win.webContents.executeJavaScript(script,true);
 await win.loadFile(join(__dirname,'provider-fixture.html'));await pause(150);
 const assert=require('node:assert/strict');
 const output={boundary:'Mounted actual ProviderSettings in isolated synthetic renderer; custom main, temporary userData, no production bridge or stores',initial:await js(`({loading:document.body.innerText.includes('Loading saved'),addEnabled:!document.querySelector('button').disabled})`)};
 await js(`document.querySelector('button').click()`);await pause(70);
 await js(`document.querySelector('input[type=checkbox]').click()`);await pause(70);
 output.checkbox=await js(`(()=>{const e=document.querySelector('input[type=checkbox]'),r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return{width:r.width,height:r.height,labelWidth:p.width,computedWidth:getComputedStyle(e).width,minHeight:getComputedStyle(e).minHeight};})()`);
 await js(`document.querySelector('.provider-checkbox').scrollIntoView({block:'center'})`);
 writeFileSync(join(process.cwd(),'.test-data/improvements/provider-checkbox.png'),(await win.webContents.capturePage()).toPNG());
 await js(`document.querySelector('.provider-form').requestSubmit()`);await pause(150);
 output.afterSave=await js(`({success:document.body.innerText.includes('Connection saved'),loading:document.body.innerText.includes('Loading saved'),commands:fixture.commands(),savedLabel:fixture.saved()?.label})`);
 await js('fixture.release()');await pause(100);
 output.afterLateRead=await js(`({success:document.body.innerText.includes('Connection saved'),cards:[...document.querySelectorAll('.provider-card strong')].map(e=>e.textContent),commands:fixture.commands()})`);
 await js('fixture.fail()');await pause(100);
 output.failedInitialRead=await js(`({emptyClaim:document.body.innerText.includes('No additional connections yet'),errorVisible:document.body.innerText.includes('Synthetic list failure'),buttons:[...document.querySelectorAll('button')].map(e=>e.textContent),cards:document.querySelectorAll('.provider-card').length})`);
 output.contrast={};for(const theme of ['light','dark']){await js(`document.documentElement.dataset.theme='${theme}'`);output.contrast[theme]=await js(`(()=>{const e=document.querySelector('.provider-note'),s=getComputedStyle(e);return{color:s.color,fontSize:s.fontSize,fontWeight:s.fontWeight,background:getComputedStyle(e.closest('.settings-section')).backgroundColor};})()`);}
 assert.equal(output.afterLateRead.cards.includes('OpenAI'),true);assert.equal(output.failedInitialRead.emptyClaim,false);assert.equal(output.checkbox.width,16);assert.equal(output.checkbox.height,16);
 writeFileSync(join(process.cwd(),'.test-data/improvements/provider-rendered-evidence.json'),JSON.stringify(output,null,2)+'\n');win.destroy();app.quit();
}).catch(e=>{process.stderr.write(e.stack+'\n');app.exit(1)});
app.on('will-quit',()=>{rmSync(temp,{recursive:true,force:true})});
