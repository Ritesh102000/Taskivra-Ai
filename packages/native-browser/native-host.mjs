// stdout is reserved exclusively for Chrome's bounded native-messaging frames.
import {readFile,realpath,lstat} from 'node:fs/promises';
import {writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {createConnection} from 'node:net';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Decoder,encode} from './framing.mjs';
const configPath=process.argv[2],origin=process.argv[3];
let socket,stage='configuration',ending=false;
function diagnostic(code){if(typeof configPath!=='string'||!configPath.endsWith('/.agent-workspaces-bridge.json'))return;const path=join(dirname(configPath),'.agent-workspaces-bridge-diagnostic.json'),temporary=`${path}.${process.pid}.tmp`;try{writeFileSync(temporary,JSON.stringify({code,pid:process.pid,ppid:process.ppid,at:Date.now(),argumentCount:process.argv.length}),{mode:0o600,flag:'wx'});renameSync(temporary,path);}catch{}finally{try{unlinkSync(temporary);}catch{}}}
diagnostic('host_started');
function stop(code){if(ending)return;ending=true;socket?.destroy();if(code){const safe=/^[a-z_]{1,48}$/.test(code)?code:'host_failed';diagnostic(safe);process.stderr.write(`agent-browser:${safe}\n`);process.stdout.write(encode({type:'bridge.error',code:safe}),()=>process.exit(1));setTimeout(()=>process.exit(1),100).unref();}else process.exit(0);}
try{
  const st=await lstat(configPath);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid())throw Error();
  const cfg=JSON.parse(await readFile(configPath,'utf8'));
  stage='extension_origin';if(origin!==`chrome-extension://${cfg.extensionId}/`)throw Error();
  stage='profile_verifier';const profile=execFileSync(join(dirname(fileURLToPath(import.meta.url)),'bin/profile-parent'),[String(process.ppid)],{encoding:'utf8',maxBuffer:8192,timeout:3000,stdio:['ignore','pipe','ignore']});
  stage='profile_mismatch';if(await realpath(profile)!==await realpath(cfg.profile)||resolve(profile)!==resolve(cfg.profile))throw Error();
  stage='socket_connect';socket=createConnection(cfg.socketPath);socket.on('error',()=>stop('app_unreachable'));
  const upstream=new Decoder(),downstream=new Decoder();
  socket.once('connect',()=>{diagnostic('socket_connected');socket.write(encode({type:'hello',agentId:cfg.agentId,token:cfg.token,profile:cfg.profile,origin}));});
  socket.on('data',chunk=>{try{for(const value of downstream.push(chunk)){if(value.type==='bridge.connected')diagnostic('connected');const frame=encode(value);if(process.stdout.writableLength+frame.length>2*1024*1024)throw Error();process.stdout.write(frame);}}catch{stop('invalid_app_frame');}});
  process.stdin.on('data',chunk=>{try{for(const value of upstream.push(chunk)){const frame=encode(value);if(socket.writableLength+frame.length>2*1024*1024)throw Error();socket.write(frame);}}catch{stop('invalid_extension_frame');}});
  process.stdin.on('end',()=>stop());socket.on('close',()=>stop('app_disconnected'));process.stdout.on('error',()=>stop());
}catch{stop(stage);}
