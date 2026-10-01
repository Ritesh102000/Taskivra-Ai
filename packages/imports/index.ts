import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {ArtifactService} from '../artifacts';
/** Copies bounded connector bytes and their hash receipt into private immutable storage.
 * The synchronous authority fence runs again inside the artifact metadata transaction. */
export async function importSelectedBytes(artifacts:ArtifactService,input:{agentId:string;taskId?:string;filename:string;bytes:Buffer;source:unknown},check:()=>void=()=>{}){
 let receipt:Buffer|undefined,content:Buffer|undefined,reservation:Awaited<ReturnType<ArtifactService['reserveExternal']>>|undefined;
 try{
  check();
  if(!Buffer.isBuffer(input.bytes)||!input.bytes.length||input.bytes.length>1024*1024)throw new Error('Select a nonempty input up to one MiB.');
  if(!/^[-A-Za-z0-9_]{1,96}$/.test(input.agentId)||input.taskId!==undefined&&!/^[-A-Za-z0-9_]{1,96}$/.test(input.taskId))throw new Error('Choose a valid private agent and task destination.');
  const source=input.source as {sha256?:unknown;bytes?:unknown};
  if(!source||typeof source!=='object'||source.bytes!==input.bytes.length||source.sha256!==createHash('sha256').update(input.bytes).digest('hex'))throw new Error('The selected input does not match its source receipt.');
  const name=input.filename.replace(/[\\/:\x00-\x1f\x7f]/g,'_').trim().slice(0,150);
  if(!name||name==='.'||name==='..')throw new Error('The selected input has an invalid filename.');
  receipt=Buffer.from(JSON.stringify(input.source,null,2));if(receipt.length>65536)throw new Error('Import receipt is too large.');
  content=Buffer.from(input.bytes);input.bytes.fill(0);
  reservation=await artifacts.reserveExternal('selected-connector-input',(content.length+receipt.length)*3+65536);
  check();const path=join(reservation.directory,name),receiptPath=join(reservation.directory,'source-receipt-'+randomUUID()+'.json');await writeFile(path,content,{mode:0o600,flag:'wx'});await writeFile(receiptPath,receipt,{mode:0o600,flag:'wx'});check();
  return await artifacts.importFiles({principal:{kind:'owner'},target:{scope:'private',agentId:input.agentId,taskId:input.taskId||null},paths:[path,receiptPath],beforeCommit:check});
 }finally{if(Buffer.isBuffer(input.bytes))input.bytes.fill(0);content?.fill(0);receipt?.fill(0);await reservation?.();}
}
