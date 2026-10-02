import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IpcAdmission,isValidatedStopControl} from '../../apps/desktop/main/ipc-admission';
import {COMMAND_CHANNEL,LIVE_CHANNEL,CODE_CHANNEL,BROWSER_CHANNEL} from '../../packages/contracts';
import {Coordinator} from '../../packages/coordinator';

test('read burst cannot consume finite validated interruption reserve',()=>{
 const admission=new IpcAdmission();for(let n=0;n<256;n++)assert.equal(admission.admit(COMMAND_CHANNEL,{type:'snapshot'},10000),true);assert.equal(admission.admit(COMMAND_CHANNEL,{type:'snapshot'},10000),false);
 assert.equal(isValidatedStopControl(COMMAND_CHANNEL,{type:'tasks.cancel',taskId:'a',unexpected:true}),false);
 for(let n=0;n<32;n++)assert.equal(admission.admit(COMMAND_CHANNEL,{type:'tasks.pause',taskId:'a'},10000),true);assert.equal(admission.admit(COMMAND_CHANNEL,{type:'tasks.pause',taskId:'a'},10000),false);
 assert.equal(admission.admit(LIVE_CHANNEL,{type:'live.stop',taskId:'a'},15000),true);
 assert.equal(isValidatedStopControl(CODE_CHANNEL,{type:'code.stop',taskId:'a',executionId:'b'}),true);
 assert.equal(isValidatedStopControl(BROWSER_CHANNEL,{type:'browser.close',agentId:'a',sessionId:'b',generation:1}),true);
});
test('actual notifyChanges retries failed observer without relabeling committed command',async()=>{
 const root=mkdtempSync(join(tmpdir(),'notify-boundary-')),coordinator=new Coordinator({dataRoot:root});
 try{await coordinator.live.ready;const source=readFileSync(new URL('../../apps/desktop/main/main.ts',import.meta.url),'utf8');const body=source.slice(source.indexOf('function notifyChanges(): void {'),source.indexOf('function bundledAssets()')).replace(': void','');let sends=0,fail=true;
 const window={isDestroyed:()=>false,webContents:{send:()=>{if(fail)throw Error('synthetic transport');sends++;}}};const notify=new Function('coordinator','window','CHANGED_CHANNEL',`let lastEventId=-1;${body};return notifyChanges;`)(coordinator,window,'changed');
 const result=coordinator.handle({type:'agents.create',name:'Committed',instructions:''});notify();assert.equal(result.agents.length,1);assert.equal(coordinator.snapshot().agents.length,1);assert.equal(sends,0);fail=false;notify();assert.equal(sends,1);notify();assert.equal(sends,1);
 }finally{await coordinator.shutdown();rmSync(root,{recursive:true,force:true});}
});
test('main registrations preserve preload invoke parity and explicit recovery lifecycle exception',async()=>{
 const main=readFileSync(new URL('../../apps/desktop/main/main.ts',import.meta.url),'utf8'),preload=readFileSync(new URL('../../apps/desktop/main/preload.ts',import.meta.url),'utf8');const registered=new Set<string>(),invoked=new Set<string>();
 const normalized=(value:string)=>value.replace(/\s+/g,'').replaceAll('"',"'");
 for(const match of main.matchAll(/registerIpc\(([^,]+),/g)){const value=match[1];if(value==='channel'){const before=main.slice(0,match.index);const starts=[...before.matchAll(/for\s*\(/g)];const group=before.slice(starts.at(-1)!.index);for(const name of group.match(/\b[A-Z_]+CHANNEL\b/g)||[])registered.add(name);}else if(value!=='channel:string')registered.add(normalized(value));}
 for(const match of preload.matchAll(/(?:fileInvoke(?:<[^>]+>)?|ipcRenderer\.invoke)\(([^,]+),/g))if(!normalized(match[1]).startsWith('channel'))invoked.add(normalized(match[1]));
 assert.deepEqual([...registered].sort(),[...invoked].sort());assert.ok(registered.size>=30);
 const source=main;assert.match(source,/IPC_LIFECYCLE_EXCEPTIONS=new Set\(\[RECOVERY_CHANNEL\]\)/);assert.match(source,/registerIpc\(RECOVERY_CHANNEL,[\s\S]*?\},false\)/);assert.match(source,/Duplicate IPC registration/);
});
