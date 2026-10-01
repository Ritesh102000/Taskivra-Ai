import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, realpath, stat, copyFile, symlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore, validateManifest, PROFILE_LIMIT, CHUNK, type ProfileFile } from '../../packages/browser-runtime/profiles';
import { browserCreateArgs } from '../../packages/browser-runtime/index';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'aw-profile-'))), key=randomBytes(32), store=new ProfileStore(root,key,'owner');
  const contents=new Map([['Default/Cookies',Buffer.from('credential-fixture-cookie-DO-NOT-STORE-AS-TEXT')],['Default/Large',randomBytes(CHUNK*2+17)],['Empty',Buffer.alloc(0)]]);
  const files=[...contents].map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}));
  const read=async(method:string,params:object)=>{assert.equal(method,'profile.read');const p=params as {path:string;offset:number;length:number};return{base64:contents.get(p.path)!.subarray(p.offset,p.offset+p.length).toString('base64')};};
  return {root,key,store,contents,files,read,close:()=>rm(root,{recursive:true,force:true})};
}

test('profile checkpoints are ciphertext-only and restore exact bounded files including empty/chunk boundaries',async()=>{
  const f=await fixture();try {
    let reserved=0,released=0;const store=new ProfileStore(f.root,f.key,'owner',async bytes=>{reserved=bytes;return async()=>{released++;};});
    await store.save('agent-a',f.files,f.read);
    const path=join(f.root,'control/browser-profiles/agent-a.enc'),ciphertext=await readFile(path);
    assert.equal(ciphertext.includes(f.contents.get('Default/Cookies')!),false);assert.equal(ciphertext.includes(Buffer.from('Default/Cookies')),false);
    assert.equal((await stat(path)).mode&0o777,0o600);assert.ok(reserved>CHUNK*2);assert.equal(released,1);
    const restored=new Map<string,Buffer>(), declarations=new Set<string>();let finish=false;
    assert.equal(await store.restore('agent-a',async(method,params)=>{
      const p=params as ProfileFile&{offset:number;base64:string};
      if(method==='profile.restore.file'){assert.equal(declarations.has(p.path),false);declarations.add(p.path);restored.set(p.path,Buffer.alloc(0));}
      if(method==='profile.restore.chunk'){assert.equal(p.offset,restored.get(p.path)!.length);const chunk=Buffer.from(p.base64,'base64');assert.ok(chunk.length<=CHUNK);restored.set(p.path,Buffer.concat([restored.get(p.path)!,chunk]));}
      if(method==='profile.restore.finish')finish=true;
      return{};
    }),true);
    assert.equal(finish,true);assert.deepEqual(restored,f.contents);assert.deepEqual(await readdir(join(f.root,'control/browser-profiles')),['agent-a.enc']);
  }finally{await f.close();}
});

test('tampering, wrong installation key, swapped agent bundles and truncation release no plaintext to worker',async()=>{
  const f=await fixture();try{
    await f.store.save('agent-a',f.files,f.read);const path=join(f.root,'control/browser-profiles/agent-a.enc'),original=await readFile(path);let calls=0;const request=async()=>{calls++;return{};};
    const tampered=Buffer.from(original);tampered[tampered.length-20]^=1;await writeFile(path,tampered);
    await assert.rejects(f.store.restore('agent-a',request));assert.equal(calls,0);
    await writeFile(path,original);await assert.rejects(new ProfileStore(f.root,randomBytes(32),'owner').restore('agent-a',request));assert.equal(calls,0);
    await copyFile(path,join(f.root,'control/browser-profiles/agent-b.enc'));await assert.rejects(f.store.restore('agent-b',request));assert.equal(calls,0);
    await writeFile(path,original.subarray(0,100));await assert.rejects(f.store.restore('agent-a',request));assert.equal(calls,0);
  }finally{await f.close();}
});

test('failed checkpoint copy preserves the previous encrypted login and cleans staging/release reservation',async()=>{
  const f=await fixture();try{
    await f.store.save('agent-a',f.files,f.read);const path=join(f.root,'control/browser-profiles/agent-a.enc'),original=await readFile(path);let released=0;
    const store=new ProfileStore(f.root,f.key,'owner',async()=>async()=>{released++;});
    await assert.rejects(store.save('agent-a',f.files,async()=>({base64:'invalid'})));
    assert.deepEqual(await readFile(path),original);assert.equal(released,1);assert.deepEqual(await readdir(join(f.root,'control/browser-profiles')),['agent-a.enc']);
    await rm(path);await symlink(join(f.root,'outside'),path);await assert.rejects(f.store.restore('agent-a',async()=>({})));
  }finally{await f.close();}
});

test('manifest rejects path escapes, duplicates, invalid schema, entry count and 256 MiB overflow',()=>{
  const entry={path:'Default/Cookies',bytes:1,sha256:'a'.repeat(64)};
  for(const path of ['../outside','/absolute','Default/../escape','Default\\Cookies','a//b','a\0b','a/./b'])assert.throws(()=>validateManifest([{...entry,path}]));
  for(const raw of [[{...entry,bytes:PROFILE_LIMIT+1}],[{...entry,bytes:-1}],[{...entry,sha256:'invalid'}],[{...entry,extra:'bad'}],[entry,entry],Array.from({length:4097},(_,n)=>({...entry,path:String(n)})),[{...entry,path:'a'},{...entry,path:'a/b'}]])assert.throws(()=>validateManifest(raw));
});

test('browser runtime Docker arguments enforce namespace, memory, process, filesystem and DNS limits',()=>{
  const args=browserCreateArgs({name:'fixture',owner:'owner',run:'run',image:'sha256:'+'a'.repeat(64),network:'b'.repeat(64),seccompPath:'/trusted/seccomp.json',generation:7});
  for(const expected of ['--read-only','--user=1000:1000','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=2g','--memory-swap=2g','--pids-limit=256','--shm-size=512m','--ipc=private','--dns=127.0.0.1','--pull=never'])assert.ok(args.includes(expected),expected);
  assert.ok(args.includes('/profile:rw,nosuid,nodev,noexec,size=256m,mode=700,uid=1000,gid=1000'));
  assert.ok(args.includes('/transfers:rw,nosuid,nodev,noexec,size=256m,mode=700,uid=1000,gid=1000'));
  assert.equal(args.some(value=>['--privileged','--mount','--volume','-v','-p','--publish','--network=host','--ipc=host','--pid=host'].includes(value)),false);
  assert.equal(args.some(value=>value.includes('docker.sock')||value.includes('SYS_ADMIN')),false);
});
