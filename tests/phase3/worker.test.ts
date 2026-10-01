import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, link, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-ignore Browser worker is an intentionally dependency-free ESM boundary.
import { FrameDecoder, encodeFrame, SessionController, ProtocolError, MAX_REQUEST_BYTES, CHUNK_BYTES, validateRequest, permittedURL, permittedTabURL } from '../../workers/browser/protocol.mjs';
// @ts-ignore Host tests exercise pure byte boundaries, never Chromium or arbitrary payload code.
import { ProfileStore, TransferStore, safePath, decodeChunk } from '../../workers/browser/files.mjs';
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const matches=(code:string)=>(e:any)=>e instanceof ProtocolError&&e.code===code;
const req=(method:string,actor='agent',generation=11,params={})=>({id:'request',method,actor,generation,params});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'aw-browser-worker-'));return{root,close:()=>rm(root,{recursive:true,force:true})};}

test('framing accepts bounded fragmented chunks and rejects oversized/truncated/flooded frames',()=>{
  const value=req('tabs.list'),encoded=encodeFrame(value,MAX_REQUEST_BYTES),decoder=new FrameDecoder();let found:any[]=[];
  for(let n=0;n<encoded.length;n+=3)found.push(...decoder.push(encoded.subarray(n,n+3)));decoder.end();assert.deepEqual(found,[value]);
  assert.throws(()=>new FrameDecoder().push(Buffer.from([0,8,0,0])),matches('invalid_frame_length'));
  const partial=new FrameDecoder();partial.push(encoded.subarray(0,8));assert.throws(()=>partial.end(),matches('truncated_frame'));
  assert.throws(()=>new FrameDecoder().push(Buffer.concat(Array(33).fill(encoded))),matches('queue_full'));
});
test('the method surface rejects eval, selectors, shell, foreign roles and unsupported URLs',()=>{
  for(const method of ['page.evaluate','cdp.send','shell','profile.list','cookies.get'])assert.throws(()=>validateRequest(req(method)),matches('unknown_method'));
  assert.throws(()=>validateRequest(req('page.click','agent',11,{tab:'tab',selector:'#password',revision:1})),matches('invalid_params'));
  assert.throws(()=>validateRequest(req('profile.read','human')),matches('permission_denied'));
  assert.throws(()=>validateRequest(req('upload.begin','agent')),matches('permission_denied'));
  assert.throws(()=>validateRequest(req('page.fill','broker')),matches('permission_denied'));
  for(const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,a','ftp://host/file','https://user:secret@example.com/'])assert.throws(()=>permittedURL(url),matches('permission_denied'));
  assert.equal(permittedURL('https://example.com/a'),'https://example.com/a');
  assert.equal(permittedTabURL('about:blank'),'about:blank');for(const url of ['about:blank?x','about:config','about:blank#x'])assert.throws(()=>permittedTabURL(url),matches('permission_denied'));assert.throws(()=>permittedURL('about:blank'),matches('permission_denied'));
});
test('owner peek is broker-only and cannot satisfy an agent fresh-observation fence',async()=>{
  for(const actor of ['agent','human','owner'])assert.throws(()=>validateRequest(req('page.peek',actor,11,{tab:'tab'})),matches('permission_denied'));
  validateRequest(req('page.peek','broker',11,{tab:'tab'}));
  const c=new SessionController(11);let effects=0;
  await c.submit(req('page.peek','broker'),async()=>({frame:'owner view'}));
  await assert.rejects(c.submit(req('page.key'),async()=>effects++),matches('fresh_observation_required'));
  await c.submit(req('page.observe'),async()=>({revision:9}));
  await c.submit(req('page.peek','broker'),async()=>({frame:'same revision'}));
  await c.submit(req('page.key'),async()=>effects++);assert.equal(effects,1);
});
test('persisted generations fence stale actors and return-to-agent requires a new observation',async()=>{
  const c=new SessionController(11);let effects=0;
  await assert.rejects(c.submit(req('tabs.open'),async()=>effects++),matches('fresh_observation_required'));
  await c.submit(req('page.observe'),async()=>({revision:1}));await c.submit(req('tabs.open'),async()=>effects++);
  const took=await c.submit(req('control.take','owner'),async()=>({}));assert.equal(took.generation,12);assert.equal(took.controller,'human');
  await assert.rejects(c.submit(req('page.key','agent',11),async()=>effects++),matches('stale_generation'));
  await assert.rejects(c.submit(req('page.key','agent',12),async()=>effects++),matches('permission_denied'));
  await c.submit(req('control.release','owner',12),async()=>({}));
  await assert.rejects(c.submit(req('page.key','agent',13),async()=>effects++),matches('fresh_observation_required'));
  await c.submit(req('page.observe','broker',13),async()=>({}));await assert.rejects(c.submit(req('page.key','agent',13),async()=>effects++),matches('fresh_observation_required'));
  await c.submit(req('page.observe','agent',13),async()=>({}));await c.submit(req('page.key','agent',13),async()=>effects++);assert.equal(effects,2);
});
test('takeover fences queued work and suppresses the in-flight result before revealing human state',async()=>{
  const c=new SessionController(11);await c.submit(req('page.observe'),async()=>({}));let settle!:()=>void,started!:()=>void,effects=0;
  const running=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>settle=resolve);
  const first=c.submit(req('page.key'),async()=>{started();await gate;return{secret:'never returned'};});await running;
  const queued=c.submit(req('page.key'),async()=>effects++),take=c.submit(req('control.take','owner'),async()=>({}));
  const firstCheck=assert.rejects(first,matches('outcome_unknown')),queuedCheck=assert.rejects(queued,matches('stale_generation'));settle();await Promise.all([firstCheck,queuedCheck,take]);assert.equal(effects,0);assert.equal(c.state().controller,'human');
});
test('profile restore checks paths, ordered chunks, complete content and post-close read identity',async()=>{
  const f=await fixture();try{const p=new ProfileStore(f.root),bytes=Buffer.from('cookie content');await p.begin();await p.add({path:'Default/Cookies',bytes:bytes.length,sha256:hash(bytes)});
    await assert.rejects(p.chunk({path:'Default/Cookies',offset:1,base64:bytes.toString('base64')}),matches('invalid_offset'));
    await p.chunk({path:'Default/Cookies',offset:0,base64:bytes.toString('base64')});await p.finish();p.launch();const checkpoint=await p.manifest();assert.equal(checkpoint.bytes,bytes.length);assert.equal(checkpoint.files[0].sha256,hash(bytes));
    assert.equal(Buffer.from((await p.read({path:'Default/Cookies',offset:0,length:CHUNK_BYTES})).base64,'base64').toString(),'cookie content');
    await writeFile(join(f.root,'Default/Cookies'),'changed');await assert.rejects(p.read({path:'Default/Cookies',offset:0,length:10}),matches('file_changed'));
  }finally{await f.close();}
});
test('profile manifests reject links, sparse oversized content, traversal and restore hash mismatch',async()=>{
  for(const path of ['../outside','a/../../b','/absolute','a\\b','a//b','./a','a/./b','a\0b'])assert.throws(()=>safePath(path));
  for(const type of ['symlink','hardlink','oversized','hash']){const f=await fixture();try{const p=new ProfileStore(f.root);
    if(type==='hash'){await p.begin({files:[{path:'Cookies',bytes:1,sha256:hash('x')}]});await p.chunk({path:'Cookies',offset:0,base64:Buffer.from('y').toString('base64')});await assert.rejects(p.finish(),matches('profile_hash_mismatch'));continue;}
    p.launch();if(type==='oversized'){const file=await open(join(f.root,'Huge'),'wx');await file.truncate(256*1024*1024+1);await file.close();}
    else{await writeFile(join(f.root,'Original'),'content');if(type==='symlink')await symlink('Original',join(f.root,'Cookies'));else await link(join(f.root,'Original'),join(f.root,'Cookies'));}
    await assert.rejects(p.manifest(),matches(type==='oversized'?'file_limit':'unsafe_file'));
  }finally{await f.close();}}
});
test('bounded chunks reject invalid base64 and uploads require exact immutable bytes',async()=>{
  assert.throws(()=>decodeChunk(Buffer.alloc(CHUNK_BYTES+1).toString('base64')),matches('invalid_chunk'));assert.throws(()=>decodeChunk('YQ==\n'),matches('invalid_chunk'));assert.throws(()=>decodeChunk(''),matches('invalid_chunk'));
  const f=await fixture();try{const t=new TransferStore(f.root);await t.init();const bytes=Buffer.from('authorized input'),upload=await t.begin({name:'input.txt',bytes:bytes.length,sha256:hash(bytes),versionId:'version_1'});
    await assert.rejects(t.finish(upload.id),matches('incomplete_upload'));await t.chunk({id:upload.id,offset:0,base64:bytes.toString('base64')});const ready=await t.finish(upload.id);assert.deepEqual(await readFile(ready.full),bytes);
    await writeFile(ready.full,'tampered');await assert.rejects(t.finish(upload.id),matches('upload_hash_mismatch'));await t.abort(upload.id);assert.equal(t.held(),0);
    await assert.rejects(t.begin({name:'../secret',bytes:1,sha256:hash('x'),versionId:'version_1'}),matches('unsafe_name'));
    await assert.rejects(t.begin({name:'too-big',bytes:100*1024*1024+1,sha256:hash('x'),versionId:'version_1'}),matches('file_limit'));
  }finally{await f.close();}
});
test('downloads expose IDs and checked chunks, require completion before ack, and reject changed bytes',async()=>{
  const f=await fixture();try{const t=new TransferStore(f.root);await t.init();let deleted=0;const driver={cancel:async()=>{},delete:async()=>{deleted++;}},item=t.addDownload(driver,'report.txt');
    await assert.rejects(t.read({id:item.id,offset:0}),matches('download_pending'));await assert.rejects(t.ack(item.id),matches('download_pending'));
    const path=join(f.root,'downloads','opaque-id');await writeFile(path,'result');await t.completeDownload(item,path);assert.equal(t.list()[0].sha256,hash('result'));assert.equal('path'in t.list()[0],false);
    const read=await t.read({id:item.id,offset:0});assert.equal(Buffer.from(read.base64,'base64').toString(),'result');assert.equal(read.eof,true);
    await writeFile(path,'changed');await assert.rejects(t.read({id:item.id,offset:0}),matches('file_changed'));await t.ack(item.id);assert.equal(deleted,1);assert.deepEqual(t.list(),[]);
    const pending=t.addDownload(driver,'pending.txt');await t.cancel(pending.id);assert.equal(t.list()[0].completed,true);assert.equal(t.list()[0].status,'failed');await t.ack(pending.id);assert.deepEqual(t.list(),[]);
  }finally{await f.close();}
});
