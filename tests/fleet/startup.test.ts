import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {DockerBrowserRuntimeFactory} from '../../packages/browser-runtime';
import {ProfileStore} from '../../packages/browser-runtime/profiles';

test('fleet-only startup and browser cleanup do not unlock unused saved logins',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'aw-fleet-startup-')));let unlocks=0;
 const factory=new DockerBrowserRuntimeFactory({dataRoot:root,seccompPath:join(root,'unused.json'),dockerPath:'/usr/bin/false',profileKey:()=>{unlocks++;throw Error('owner unlock required');}});
 try{await factory.reconcile();assert.equal((await factory.status()).ready,false);assert.equal(unlocks,0);
  factory.status=async()=>({ready:true,message:null});
  await assert.rejects(factory.launch({sessionId:'test-session',agentId:'test-agent',initialGeneration:1}),/owner unlock required/);
  assert.equal(unlocks,1);assert.deepEqual(await readdir(join(root,'control/browser-runtime')),[],'No launch journal or external resources are created before unlock.');
 }finally{await factory.close();await rm(root,{recursive:true,force:true});}
});

test('lazy browser unlock preserves authenticated ciphertext and exact restoration',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'aw-lazy-profile-'))),key=randomBytes(32),payload=Buffer.from('synthetic saved session, not a real credential');let unlocks=0;
 const store=new ProfileStore(root,()=>{unlocks++;return key;},'fixture-owner');
 try{await store.reconcile();assert.equal(unlocks,0);
  await store.save('fixture',[{path:'Default/Cookies',bytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')}],async()=>({base64:payload.toString('base64')}));
  const encrypted=await readFile(join(root,'control/browser-profiles/fixture.enc'));assert.equal(encrypted.includes(payload),false);
  const chunks:Buffer[]=[];assert.equal(await store.restore('fixture',async(method,raw)=>{if(method==='profile.restore.chunk')chunks.push(Buffer.from((raw as {base64:string}).base64,'base64'));return{};}),true);
  assert.deepEqual(Buffer.concat(chunks),payload);assert.equal(unlocks,1);store.close();assert.throws(()=>store.unlock(),/closed/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
