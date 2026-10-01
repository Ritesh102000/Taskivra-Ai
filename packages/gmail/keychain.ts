import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access,lstat} from 'node:fs/promises';
import {GmailError,type GmailSecretKey,type GmailSecretStore} from './index';
/** Fixed native Keychain namespace. No values are placed in argv, logs, files, or the renderer. */
export class MacGmailSecretStore implements GmailSecretStore {
 constructor(private options:{helperPath:string}){}
 private async invoke(command:'read'|'write'|'remove',key:GmailSecretKey,value?:string):Promise<string|null>{
  if(process.platform!=='darwin'||!['client','tokens'].includes(key)||value!==undefined&&Buffer.byteLength(value)>32768)throw new GmailError('keychain_unavailable');
  try{const s=await lstat(this.options.helperPath);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error();await access(this.options.helperPath,constants.X_OK);}catch{throw new GmailError('keychain_unavailable');}
  return new Promise((resolve,reject)=>{const child=spawn(this.options.helperPath,[command,key],{stdio:['pipe','pipe','pipe']});let failed=false,bytes=0,err=0;const chunks:Buffer[]=[];const stop=()=>{failed=true;child.kill('SIGKILL');};const timer=setTimeout(stop,15000);
   child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>32768)stop();else chunks.push(data);});child.stderr.on('data',(data:Buffer)=>{err+=data.length;if(err>2048)stop();});child.once('error',()=>{failed=true;});child.stdin.on('error',()=>{failed=true;});
   child.once('close',code=>{clearTimeout(timer);const result=Buffer.concat(chunks);for(const data of chunks)data.fill(0);try{if(!failed&&code===3&&command==='read'){resolve(null);return;}if(failed||code!==0)throw new GmailError('keychain_unavailable');resolve(command==='read'?new TextDecoder('utf-8',{fatal:true}).decode(result):null);}catch{reject(new GmailError('keychain_unavailable'));}finally{result.fill(0);}});
   if(value!==undefined){const bytes=Buffer.from(value);child.stdin.end(bytes,()=>bytes.fill(0));}else child.stdin.end();
  });
 }
 read(key:GmailSecretKey){return this.invoke('read',key);}
 async write(key:GmailSecretKey,value:string){await this.invoke('write',key,value);const actual=await this.read(key);if(actual!==value)throw new GmailError('keychain_unavailable');}
 async remove(key:GmailSecretKey){await this.invoke('remove',key);}
}
