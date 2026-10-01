import { CommandValidationError } from './validation';
import { REQUEST_LIMITS, type CapabilitySpec, type FileConstraints, type FileSlotSpec, type ReplanResult, type RequestCommand, type UserRequestSpec } from './requests';
const formats=['txt','md','csv','json','pdf','png','jpeg','xlsx','binary'];
function fail(message='This request contains missing, unsupported, or oversized fields.'):never{throw new CommandValidationError(message);}
function obj(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();return value as Record<string,unknown>;}
function keys(v:Record<string,unknown>,allowed:string[],required=allowed){if(Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k)))fail();}
function text(v:unknown,max=1000):string{if(typeof v!=='string'||!v.trim()||v.includes('\0')||Buffer.byteLength(v)>max)fail();return v;}
function id(v:unknown):string{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(v))fail();return v;}
function number(v:unknown,min:number,max:number):number{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)fail();return Number(v);}
function strings(v:unknown,max=32,length=256):string[]{if(!Array.isArray(v)||v.length>max)fail();const result=v.map(x=>text(x,length));if(new Set(result).size!==result.length)fail();return result;}
function bounded(raw:unknown,max=64000){let bytes;try{bytes=Buffer.byteLength(JSON.stringify(raw));}catch{fail();}if(bytes>max)fail();}
export function parseFileConstraints(raw:unknown):FileConstraints{
  const v=obj(raw);keys(v,['formats','minBytes','maxBytes','textIncludes','csv','json'],['formats']);
  const selected=strings(v.formats,9,16);if(!selected.length||selected.some(x=>!formats.includes(x)))fail('Choose supported formats.');
  const result:FileConstraints={formats:selected as FileConstraints['formats']};
  if(v.minBytes!==undefined)result.minBytes=number(v.minBytes,0,100*1024*1024);
  if(v.maxBytes!==undefined)result.maxBytes=number(v.maxBytes,1,100*1024*1024);
  if((result.minBytes||0)>(result.maxBytes||100*1024*1024))fail();
  if(v.textIncludes!==undefined){if(selected.some(x=>!['txt','md','csv','json'].includes(x)))fail('Literal text checks require UTF-8 text formats.');result.textIncludes=strings(v.textIncludes,16,256);}
  if(v.csv!==undefined){
    if(selected.length!==1||selected[0]!=='csv')fail('CSV checks require a CSV-only slot.');
    const csv=obj(v.csv);keys(csv,['requiredColumns','minRows','maxRows','equals'],['requiredColumns']);
    result.csv={requiredColumns:strings(csv.requiredColumns,64,128)};
    if(csv.minRows!==undefined)result.csv.minRows=number(csv.minRows,0,10000);
    if(csv.maxRows!==undefined)result.csv.maxRows=number(csv.maxRows,0,10000);
    if((result.csv.minRows||0)>(result.csv.maxRows??10000))fail();
    if(csv.equals!==undefined){if(!Array.isArray(csv.equals)||csv.equals.length>16)fail();result.csv.equals=csv.equals.map(raw=>{const item=obj(raw);keys(item,['column','value']);return{column:text(item.column,128),value:typeof item.value==='string'&&Buffer.byteLength(item.value)<=256&&!item.value.includes('\0')?item.value:fail()};});}
  }
  if(v.json!==undefined){
    if(selected.length!==1||selected[0]!=='json')fail('JSON checks require a JSON-only slot.');
    const json=obj(v.json);keys(json,['requiredKeys','equals'],['requiredKeys']);result.json={requiredKeys:strings(json.requiredKeys,64,128)};
    if(json.equals!==undefined){if(!Array.isArray(json.equals)||json.equals.length>16)fail();result.json.equals=json.equals.map(raw=>{const item=obj(raw);keys(item,['path','value']);if(!Array.isArray(item.path)||!item.path.length||item.path.length>16)fail();const path=item.path.map(key=>text(key,128));const value=item.value;if(value!==null&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isFinite(value))&&!(typeof value==='string'&&Buffer.byteLength(value)<=256&&!value.includes('\0')))fail();return{path,value:value as string|number|boolean|null};});}
  }
  return result;
}
export function parseCapability(raw:unknown):CapabilitySpec{
  const v=obj(raw);keys(v,['name','origin','versionIds'],['name','versionIds']);
  if(!['browser_upload','artifact_publish'].includes(String(v.name))||!Array.isArray(v.versionIds)||!v.versionIds.length||v.versionIds.length>32)fail();
  const versionIds=v.versionIds.map(id);if(new Set(versionIds).size!==versionIds.length)fail();
  const result:CapabilitySpec={name:v.name as CapabilitySpec['name'],versionIds};
  if(v.name==='browser_upload'){
    const origin=text(v.origin,2048);let url;try{url=new URL(origin);}catch{fail();}
    if(!['http:','https:'].includes(url.protocol)||url.origin!==origin)fail('Choose one exact HTTP or HTTPS destination origin.');result.origin=origin;
  }else if(v.origin!==undefined)fail();return result;
}
export function parseUserRequest(raw:unknown):UserRequestSpec{
  bounded(raw);const v=obj(raw),base={title:text(v.title,160),reason:text(v.reason,2000),continuation:id(v.continuation)};
  if(v.kind==='files'){
    keys(v,['kind','title','reason','continuation','slots']);if(!Array.isArray(v.slots)||!v.slots.length||v.slots.length>REQUEST_LIMITS.slots)fail();
    const slots:FileSlotSpec[]=v.slots.map(raw=>{const s=obj(raw);keys(s,['key','label','required','constraints']);if(typeof s.required!=='boolean')fail();return{key:id(s.key),label:text(s.label,160),required:s.required,constraints:parseFileConstraints(s.constraints)};});
    if(new Set(slots.map(s=>s.key)).size!==slots.length||!slots.some(s=>s.required))fail('A file request needs distinct slots and at least one required slot.');return{...base,kind:'files',slots};
  }
  if(v.kind==='capability'){keys(v,['kind','title','reason','continuation','capability']);return{...base,kind:'capability',capability:parseCapability(v.capability)};}
  if(v.kind==='clarification'||v.kind==='browser_handoff'){keys(v,['kind','title','reason','continuation']);return{...base,kind:v.kind};}
  return fail();
}
export function parseRequestCommand(raw:unknown):RequestCommand{
  bounded(raw);const v=obj(raw);
  if(v.type==='requests.list'){keys(v,['type','taskId']);return{type:v.type,taskId:v.taskId===null?null:id(v.taskId)};}
  const requestId=id(v.requestId),revision=number(v.revision,1,Number.MAX_SAFE_INTEGER);
  if(v.type==='requests.assign'){
    keys(v,['type','requestId','revision','assignments']);if(!Array.isArray(v.assignments)||!v.assignments.length||v.assignments.length>REQUEST_LIMITS.assignments)fail();
    const assignments=v.assignments.map(raw=>{const a=obj(raw);keys(a,['slotId','slotRevision','versionId']);return{slotId:id(a.slotId),slotRevision:number(a.slotRevision,1,Number.MAX_SAFE_INTEGER),versionId:id(a.versionId)};});
    if(new Set(assignments.map(a=>a.slotId)).size!==assignments.length)fail();return{type:v.type,requestId,revision,assignments};
  }
  if(v.type==='requests.reply'){keys(v,['type','requestId','revision','response']);return{type:v.type,requestId,revision,response:text(v.response,REQUEST_LIMITS.responseBytes)};}
  if(v.type==='requests.decide'){keys(v,['type','requestId','revision','decision']);if(v.decision!=='accept'&&v.decision!=='decline')fail();return{type:v.type,requestId,revision,decision:v.decision};}
  return fail();
}
export function parseReplanResult(raw:unknown):ReplanResult{
  bounded(raw);const v=obj(raw);
  if(v.kind==='keep_blocked'){keys(v,['kind','message']);return{kind:v.kind,message:text(v.message,2000)};}
  if(v.kind==='reduced_scope'){keys(v,['kind','description','completionCriteria','waiveSlotKeys']);const waiveSlotKeys=strings(v.waiveSlotKeys,REQUEST_LIMITS.slots,96).map(id);if(!waiveSlotKeys.length)fail();return{kind:v.kind,description:text(v.description,2000),completionCriteria:text(v.completionCriteria,4000),waiveSlotKeys};}
  return fail();
}
export const parseUserRequestSpec=parseUserRequest;
