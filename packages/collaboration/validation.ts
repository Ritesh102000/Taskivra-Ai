import { CommandValidationError } from '../contracts/validation';
import type { AgentMessageInput, CollaborationCommand } from '../contracts/collaboration';
export function fail(): never { throw new CommandValidationError('Collaboration fields are missing, unsupported, or exceed their limits.'); }
export function record(value:unknown,fields:string[],optional:string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!fields.includes(key))||fields.some(key=>!optional.includes(key)&&!Object.hasOwn(value,key))||Object.values(descriptors).some(d=>!('value'in d)))fail();
 return value as Record<string,unknown>;
}
export function id(value:unknown):string {if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(value))fail();return value;}
export function ids(value:unknown,max=16):string[]{if(!Array.isArray(value)||value.length>max)fail();const result=value.map(id);if(new Set(result).size!==result.length)fail();return result;}
function text(value:unknown,max:number):string {if(typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value)>max)fail();return value;}
function revision(value:unknown):number {if(!Number.isSafeInteger(value)||Number(value)<1)fail();return Number(value);}
export function messageInput(value:unknown):AgentMessageInput{
 const v=record(value,['recipientAgentId','kind','taskIds','versionIds','idempotencyKey']);
 if(!['handoff','update','question'].includes(String(v.kind)))fail();
 return{recipientAgentId:id(v.recipientAgentId),kind:v.kind as AgentMessageInput['kind'],taskIds:ids(v.taskIds),versionIds:ids(v.versionIds),idempotencyKey:id(v.idempotencyKey)};
}
export function parseCollaborationCommand(value:unknown):CollaborationCommand{
 if(!value||typeof value!=='object'||Array.isArray(value))fail();
 const type=Object.getOwnPropertyDescriptor(value,'type')?.value;
 if(type==='collaboration.state'){record(value,['type']);return{type};}
 if(type==='collaboration.policy'){
  const v=record(value,['type','taskId','revision','visibility','summary','peerAgentIds']);
  if(v.visibility!=='private'&&v.visibility!=='shared')fail();const summary=text(v.summary,240).trim();if(v.visibility==='shared'&&!summary)fail();
  return{type,taskId:id(v.taskId),revision:revision(v.revision),visibility:v.visibility,summary,peerAgentIds:ids(v.peerAgentIds,32)};
 }
 if(type==='collaboration.dependency.add'){const v=record(value,['type','taskId','dependsOnTaskId','requiredVersionId']);return{type,taskId:id(v.taskId),dependsOnTaskId:id(v.dependsOnTaskId),requiredVersionId:v.requiredVersionId===null?null:id(v.requiredVersionId)};}
 if(type==='collaboration.dependency.remove'){const v=record(value,['type','taskId','dependsOnTaskId']);return{type,taskId:id(v.taskId),dependsOnTaskId:id(v.dependsOnTaskId)};}
 if(type==='collaboration.send'){
  const v=record(value,['type','taskId','body','recipientAgentId','kind','taskIds','versionIds','idempotencyKey']);
  return{type,taskId:id(v.taskId),body:text(v.body,1000).trim(),...messageInput({recipientAgentId:v.recipientAgentId,kind:v.kind,taskIds:v.taskIds,versionIds:v.versionIds,idempotencyKey:v.idempotencyKey})};
 }
 if(type==='collaboration.ack'){const v=record(value,['type','agentId','messageIds','publicationIds'],['publicationIds']);return{type,agentId:id(v.agentId),messageIds:ids(v.messageIds,100),...(v.publicationIds===undefined?{}:{publicationIds:ids(v.publicationIds,100)})};}
 if(type==='collaboration.consume'){const v=record(value,['type','taskId','versionId']);return{type,taskId:id(v.taskId),versionId:id(v.versionId)};}
 return fail();
}
