import { constants } from 'node:fs';
import { open, lstat, mkdir, readdir, unlink, rm, rmdir } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CHUNK_BYTES, FILE_BYTES, PROFILE_BYTES, PROFILE_FILES, fail, integer, opaque, boundedString } from './protocol.mjs';

export function safePath(path) {
  boundedString(path,512);
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(s=>!s||s==='.'||s==='..') || path.split('/').length>32) fail('unsafe_path');
  return path;
}
export function safeName(name) { boundedString(name,200); if (!name || /[/\\\x00-\x1f]/.test(name) || name==='.'||name==='..') fail('unsafe_name'); return name; }
export function hashValue(value) { if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('invalid_hash');return value; }
export function decodeChunk(value) {
  if(typeof value!=='string'||value.length>Math.ceil(CHUNK_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('invalid_chunk');
  const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>CHUNK_BYTES||bytes.toString('base64')!==value)fail('invalid_chunk');return bytes;
}
function same(a,b) { return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&b.isFile()&&b.nlink===1n; }
async function guarded(root,path,{directory=false,createParents=false,missing=false}={}) {
  safePath(path);const parts=path.split('/');let current=root;
  const base=await lstat(root);if(!base.isDirectory()||base.isSymbolicLink())fail('unsafe_path');
  for(let n=0;n<parts.length;n++){
    current=join(current,parts[n]);const parent=n<parts.length-1||directory;
    if(parent&&createParents)await mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const stat=await lstat(current).catch(e=>{if(missing&&n===parts.length-1&&e.code==='ENOENT')return null;throw e;});
    if(!stat)return current;if(stat.isSymbolicLink()||(parent&&!stat.isDirectory())||(!parent&&(!stat.isFile()||stat.nlink!==1)))fail('unsafe_file');
  }
  return current;
}
async function openRegular(root,path) {
  const full=await guarded(root,path),before=await lstat(full,{bigint:true}),handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat({bigint:true});if(!same(before,stat))fail('file_changed');return{handle,stat,full};}catch(e){await handle.close();throw e;}
}
async function hashFile(root,path,maxBytes) {
  const source=await openRegular(root,path);
  try{const bytes=Number(source.stat.size);integer(bytes,0,maxBytes,'file_limit');const hash=createHash('sha256'),buffer=Buffer.alloc(CHUNK_BYTES);let offset=0;
    while(offset<bytes){const result=await source.handle.read(buffer,0,Math.min(buffer.length,bytes-offset),offset);if(!result.bytesRead)fail('file_changed');hash.update(buffer.subarray(0,result.bytesRead));offset+=result.bytesRead;}
    if(!same(source.stat,await source.handle.stat({bigint:true}))||!same(source.stat,await lstat(source.full,{bigint:true})))fail('file_changed');
    return{bytes,sha256:hash.digest('hex'),stat:source.stat};
  }finally{await source.handle.close();}
}
async function readChunk(root,path,expected,offset,length) {
  integer(offset,0,expected.bytes);integer(length,1,CHUNK_BYTES);const source=await openRegular(root,path);
  try{if(!same(expected.stat,source.stat))fail('file_changed');const buffer=Buffer.alloc(Math.min(length,expected.bytes-offset));const result=await source.handle.read(buffer,0,buffer.length,offset);
    if(result.bytesRead!==buffer.length||!same(expected.stat,await source.handle.stat({bigint:true}))||!same(expected.stat,await lstat(source.full,{bigint:true})))fail('file_changed');
    return{offset,base64:buffer.toString('base64'),eof:offset+buffer.length===expected.bytes};
  }finally{await source.handle.close();}
}

export class ProfileStore {
  constructor(root='/profile') { this.root=root;this.restoring=false;this.started=false;this.finished=false;this.files=new Map();this.total=0;this.checkpoint=null; }
  async begin({files=[]}={}) {
    if(this.started||this.restoring)fail('profile_state');if(!Array.isArray(files)||files.length>PROFILE_FILES)fail('profile_limit');
    if((await readdir(this.root)).length)fail('profile_not_empty');this.restoring=true;
    for(const file of files)await this.add(file);return{files:this.files.size,bytes:this.total};
  }
  async add(file) {
    if(!this.restoring||this.started)fail('profile_state');if(!file||Object.keys(file).some(k=>!['path','bytes','sha256'].includes(k)))fail('invalid_manifest');
    const path=safePath(file.path),bytes=integer(file.bytes,0,PROFILE_BYTES,'profile_limit'),sha256=hashValue(file.sha256);
    if(this.files.has(path)||this.files.size>=PROFILE_FILES||this.total+bytes>PROFILE_BYTES)fail('profile_limit');
    const full=await guarded(this.root,path,{createParents:true,missing:true});const handle=await open(full,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.close();
    this.files.set(path,{bytes,sha256,offset:0,hash:createHash('sha256')});this.total+=bytes;return{path,bytes};
  }
  async chunk({path,offset,base64}) {
    if(!this.restoring||this.started)fail('profile_state');safePath(path);const item=this.files.get(path);if(!item)fail('unknown_profile_file');
    const bytes=decodeChunk(base64);if(offset!==item.offset||offset+bytes.length>item.bytes)fail('invalid_offset');
    const full=await guarded(this.root,path),handle=await open(full,constants.O_WRONLY|constants.O_NOFOLLOW);
    try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==offset)fail('file_changed');const result=await handle.write(bytes,0,bytes.length,offset);if(result.bytesWritten!==bytes.length)fail('file_write_failed');}finally{await handle.close();}
    item.hash.update(bytes);item.offset+=bytes.length;return{path,offset:item.offset};
  }
  async finish() {
    if(!this.restoring||this.started)fail('profile_state');for(const [path,item]of this.files){if(item.offset!==item.bytes||item.hash.digest('hex')!==item.sha256)fail('profile_hash_mismatch');const verified=await hashFile(this.root,path,PROFILE_BYTES);if(verified.sha256!==item.sha256)fail('profile_hash_mismatch');}
    this.restoring=false;this.finished=true;return{files:this.files.size,bytes:this.total};
  }
  launch() { if(this.started||this.restoring)fail('profile_state');this.started=true; }
  async manifest() {
    if(!this.started)fail('profile_state');const found=new Map();let bytes=0,entries=0;
    const visit=async(folder='')=>{for(const entry of await readdir(join(this.root,folder),{withFileTypes:true})){
      if(++entries>PROFILE_FILES*2)fail('profile_limit');const path=folder?`${folder}/${entry.name}`:entry.name;safePath(path);
      if(!folder&&['SingletonLock','SingletonCookie','SingletonSocket'].includes(entry.name)){await unlink(join(this.root,path)).catch(e=>{if(e.code!=='ENOENT')throw e;});continue;}
      if(entry.isDirectory()){await guarded(this.root,path,{directory:true});await visit(path);continue;}
      if(found.size>=PROFILE_FILES)fail('profile_limit');const item=await hashFile(this.root,path,PROFILE_BYTES);bytes+=item.bytes;if(bytes>PROFILE_BYTES)fail('profile_limit');found.set(path,item);
    }};await visit();this.checkpoint=found;return{files:[...found].map(([path,item])=>({path,bytes:item.bytes,sha256:item.sha256})),bytes};
  }
  async read({path,offset,length=CHUNK_BYTES}) { safePath(path);if(!this.checkpoint)fail('profile_not_closed');const file=this.checkpoint.get(path);if(!file)fail('unknown_profile_file');return readChunk(this.root,path,file,offset,length); }
}

export class TransferStore {
  constructor(root='/transfers') { this.root=root;this.uploads=new Map();this.downloads=new Map();this.totalLimit=128*1024*1024; }
  held() { return [...this.uploads.values()].reduce((n,i)=>n+i.bytes,0)+[...this.downloads.values()].reduce((n,i)=>n+i.bytes,0); }
  async init() { await mkdir(join(this.root,'uploads'),{mode:0o700,recursive:true});await mkdir(join(this.root,'downloads'),{mode:0o700,recursive:true}); }
  async begin(params) {
    const bytes=integer(params.bytes,0,FILE_BYTES,'file_limit');safeName(params.name);hashValue(params.sha256);opaque(params.versionId);
    if(this.uploads.size+this.downloads.size>=32||this.held()+bytes>this.totalLimit)fail('transfer_limit');
    const id=randomUUID(),path=`uploads/${id}/${params.name}`,full=await guarded(this.root,path,{createParents:true,missing:true});const handle=await open(full,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.close();
    this.uploads.set(id,{...params,id,path,bytes,offset:0});return{id,chunkBytes:CHUNK_BYTES};
  }
  async chunk({id,offset,base64}) {
    opaque(id);const item=this.uploads.get(id);if(!item)fail('unknown_upload');const bytes=decodeChunk(base64);if(offset!==item.offset||offset+bytes.length>item.bytes)fail('invalid_offset');
    const full=await guarded(this.root,item.path),handle=await open(full,constants.O_WRONLY|constants.O_NOFOLLOW);
    try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==offset)fail('file_changed');const result=await handle.write(bytes,0,bytes.length,offset);if(result.bytesWritten!==bytes.length)fail('file_write_failed');}finally{await handle.close();}
    item.offset+=bytes.length;return{id,offset:item.offset};
  }
  async finish(id) {
    opaque(id);const item=this.uploads.get(id);if(!item)fail('unknown_upload');if(item.attached)fail('upload_already_attached');if(item.offset!==item.bytes)fail('incomplete_upload');const verified=await hashFile(this.root,item.path,FILE_BYTES);if(verified.sha256!==item.sha256)fail('upload_hash_mismatch');return{...item,full:await guarded(this.root,item.path)};
  }
  attached(id) { const item=this.uploads.get(id);if(!item)fail('unknown_upload');item.attached=true; }
  async abort(id) { opaque(id);const item=this.uploads.get(id);if(!item)fail('unknown_upload');await unlink(join(this.root,item.path));await rmdir(join(this.root,'uploads',id));this.uploads.delete(id);return{}; }
  addDownload(download,name,provenance={}) {
    if(this.downloads.size+this.uploads.size>=32){void download.cancel();return null;}
    try{safeName(name);}catch{name='download.bin';}
    const id=randomUUID(),item={id,name,tabId:provenance.tabId||null,origin:provenance.origin||null,bytes:0,completed:false,status:'pending',download};this.downloads.set(id,item);return item;
  }
  async completeDownload(item,path) {
    if(item.cancelled)fail('download_cancelled');
    const rel=relative(this.root,path);safePath(rel);if(!rel.startsWith('downloads/'))fail('unsafe_path');
    const verified=await hashFile(this.root,rel,FILE_BYTES);item.bytes=verified.bytes;if(this.held()>this.totalLimit)fail('transfer_limit');
    if(item.cancelled)fail('download_cancelled');
    Object.assign(item,{path:rel,...verified,completed:true,status:'complete'});
  }
  list() { return [...this.downloads.values()].map(({id,name,tabId,origin,bytes,completed,status,sha256})=>({id,name,tabId,origin,bytes,completed,status,...(sha256?{sha256}:{})})); }
  async read({id,offset,length=CHUNK_BYTES}) { opaque(id);const item=this.downloads.get(id);if(!item)fail('unknown_download');if(!item.completed||item.status!=='complete')fail('download_pending');return readChunk(this.root,item.path,item,offset,length); }
  async cancel(id) { opaque(id);const item=this.downloads.get(id);if(!item)fail('unknown_download');item.cancelled=true;await item.download.cancel();item.completed=true;item.status='failed';item.bytes=0;return{}; }
  async ack(id) { opaque(id);const item=this.downloads.get(id);if(!item)fail('unknown_download');if(!item.completed)fail('download_pending');await item.download.delete().catch(()=>{});if(item.path)await rm(join(this.root,item.path),{force:true});this.downloads.delete(id);return{}; }
  async discard() { for(const item of this.downloads.values())await item.download.cancel().catch(()=>{});for(const id of [...this.uploads.keys()])await this.abort(id);this.downloads.clear(); }
}
