import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanBrowserObservation,cleanBrowserTabs} from '../../packages/agent-loop/browser-results';
import {toolsForPolicy} from '../../packages/agent-loop/tools';
import {isSourceReceipt} from '../../packages/agent-loop/evidence';
import {buildAgentPrompt} from '../../packages/agent-loop/prompts';
import type {LivePolicy} from '../../packages/contracts/live';

const policy:LivePolicy={mode:'workspace',allowedOrigins:['https://fixture.example.test']};
const observation={tab:'tab1',url:'https://fixture.example.test/report',title:'Report',revision:7,targets:[],text:'Known text'};
test('escaped and multibyte browser content preserves usable handles inside the receipt limit',()=>{
 const targets=Array.from({length:150},(_,i)=>({ref:'target_'+i,kind:'button',label:'\u0001😀'.repeat(50),untrustedExtra:'must disappear'}));
 const result=cleanBrowserObservation({...observation,text:'\u0001😀'.repeat(7000),targets},policy);
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=20*1024);assert.equal(result.tabId,'tab1');assert.equal(result.revision,7);
 assert.equal(result.textTruncated,true);assert.equal(result.targetsTruncated,true);assert.equal(result.fullPageVerified,false);
 assert.ok((result.targets as unknown[]).length>0);assert.equal((result.targets as {ref:string}[])[0].ref,'target_0');assert.equal(JSON.stringify(result).includes('must disappear'),false);
 assert.equal(Buffer.from(String(result.text)).toString(),String(result.text));assert.equal(result.returnedTextChars,String(result.text).length);
});
test('same-origin login and owner control observations redact query, title, targets and body',()=>{
 for(const raw of [{...observation,url:'https://fixture.example.test/login?token=CANARY'},{...observation,nativeHumanControl:true}]){
  const result=cleanBrowserObservation({...raw,title:'CANARY',text:'CANARY',targets:[{ref:'target',kind:'input',label:'CANARY'}]},policy);
  assert.equal(result.loginOrRedirect,true);assert.equal(JSON.stringify(result).includes('CANARY'),false);assert.equal(isSourceReceipt('browser_tab_observe',result),false);
 }
});
test('tab inventory redacts login/off-origin content, keeps all six opaque IDs and bounds long URLs',()=>{
 const tabs=Array.from({length:6},(_,i)=>({id:'tab'+i,revision:1,title:'😀'.repeat(90),url:'https://fixture.example.test/'+ 'x'.repeat(3900)}));
 tabs[0]={id:'tab0',revision:3,title:'CANARY',url:'https://fixture.example.test/login?token=CANARY'};
 tabs[1]={id:'tab1',revision:3,title:'CANARY',url:'https://outside.example.test/?token=CANARY'};
 const result=cleanBrowserTabs(tabs,policy);assert.equal(result.tabs.length,6);assert.ok(Buffer.byteLength(JSON.stringify(result))<9*1024);assert.equal(result.compacted,true);
 assert.deepEqual(result.tabs.map(t=>t.tabId),tabs.map(t=>t.id));assert.equal(result.tabs[0].readable,false);assert.equal(result.tabs[1].url,null);assert.equal(JSON.stringify(result).includes('CANARY'),false);
 assert.throws(()=>cleanBrowserTabs([...tabs,tabs[0]],policy),{code:'invalid_observation'});
});
test('only fresh tab observations count as evidence; metadata and private imports require file reading',()=>{
 for(const tool of ['browser_tab_open','browser_tab_observe'])assert.equal(isSourceReceipt(tool,cleanBrowserObservation(observation,policy)),true);
 for(const tool of ['browser_tabs','browser_tab_close','browser_downloads','browser_save_download'])assert.equal(isSourceReceipt(tool,{sourceEvidence:false}),false);
});
test('tool exposure and prompt match owner policy; Gmail has no general browser tools',()=>{
 const workspace=toolsForPolicy(policy),readOnly=toolsForPolicy({...policy,mode:'read_only_browser'}),mail=toolsForPolicy({...policy,mode:'read_only_browser',mailAccount:'fixture@example.test'});
 for(const name of ['browser_tabs','browser_tab_open','browser_tab_observe','browser_tab_close']){assert.ok(workspace.some(t=>t.name===name));assert.ok(readOnly.some(t=>t.name===name));assert.ok(!mail.some(t=>t.name===name));}
 for(const name of ['browser_downloads','browser_save_download']){assert.ok(workspace.some(t=>t.name===name));assert.ok(!readOnly.some(t=>t.name===name));assert.ok(!mail.some(t=>t.name===name));}
 const prompt=buildAgentPrompt('execute',workspace).instructions;assert.match(prompt,/six tabs/);assert.match(prompt,/Native Chrome download transfers are unsupported/);assert.match(prompt,/not treat inventory/);
});
