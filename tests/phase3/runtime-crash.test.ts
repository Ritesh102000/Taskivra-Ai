import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerBrowserRuntimeFactory } from '../../packages/browser-runtime/index';
const exec=promisify(execFile);

test('a real coordinator SIGKILL leaves journaled Docker resources that startup removes by data-root ownership', {skip:process.env.AW_DOCKER_TESTS!=='1',timeout:60_000},async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'aw-runtime-process-crash-'))),key=randomBytes(32);
  const owner=createHash('sha256').update(root).digest('hex'),filter=`label=io.agent-workspaces.browser.owner=${owner}`;
  const factory=new DockerBrowserRuntimeFactory({dataRoot:root,profileKey:key,seccompPath:resolve('containers/browser/seccomp.json'),testFixture:true});
  const ids=async(kind:'container'|'network')=>(await exec('docker',[kind,'ls',...(kind==='container'?['-a']:[]),'--no-trunc','--format','{{.ID}}','--filter',filter],{timeout:10_000})).stdout.trim().split('\n').filter(Boolean);
  try{
    const childSource=`
      import { writeSync } from 'node:fs';
      import { DockerBrowserRuntimeFactory } from ${JSON.stringify(new URL('../../packages/browser-runtime/index.ts',import.meta.url).href)};
      const config=JSON.parse(process.argv[1]);config.profileKey=Buffer.from(config.profileKey,'base64');
      const factory=new DockerBrowserRuntimeFactory(config);
      const handle=await factory.launch({agentId:'crash-agent',sessionId:'crash-session',initialGeneration:71});
      writeSync(1,JSON.stringify({containerId:handle.info.containerId,networkId:handle.info.networkId})+'\\n');
      process.kill(process.pid,'SIGKILL');
    `;
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',childSource,JSON.stringify({dataRoot:root,profileKey:key.toString('base64'),seccompPath:resolve('containers/browser/seccomp.json'),testFixture:true})],{encoding:'utf8',timeout:30_000,killSignal:'SIGKILL',maxBuffer:1024*1024});
    assert.equal(child.error,undefined,child.stderr);assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(child.status,null);
    const launched=JSON.parse(child.stdout.trim());assert.match(launched.containerId,/^[a-f0-9]{64}$/);
    const journals=await readdir(join(root,'control/browser-runtime'));assert.equal(journals.filter(name=>name.endsWith('.json')).length,2);
    for(const name of journals.filter(name=>name.endsWith('.json'))){const journal=JSON.parse(await readFile(join(root,'control/browser-runtime',name),'utf8'));assert.equal(journal.pid,child.pid);assert.equal(journal.owner,owner);assert.ok(journal.resources.every((resource:{id:string})=>/^[a-f0-9]{64}$/.test(resource.id)));}
    const before={containers:await ids('container'),networks:await ids('network')};assert.ok(before.containers.length>=2);assert.equal(before.networks.length,3);
    await factory.reconcile();
    assert.deepEqual(await ids('container'),[]);assert.deepEqual(await ids('network'),[]);assert.deepEqual(await readdir(join(root,'control/browser-runtime')),[]);
    if(process.env.AW_RUNTIME_EVIDENCE==='1'){
      await mkdir('packages/browser-runtime/evidence',{recursive:true});await writeFile('packages/browser-runtime/evidence/process-crash.json',JSON.stringify({recordedAt:new Date().toISOString(),signal:child.signal,journals:2,resourcesBefore:{containers:before.containers.length,networks:before.networks.length},resourcesAfter:{containers:0,networks:0},checks:{selfSigkillAfterReady:true,durableCreationJournal:true,matchingOwnerAndImmutableIDs:true,startupCleanup:true},limitations:['The separate foreign-label regression uses a deterministic CLI fixture; no unrelated Docker resource is modified.']},null,2));
    }
  }finally{await factory.reconcile();await factory.close();await rm(root,{recursive:true,force:true});}
});
