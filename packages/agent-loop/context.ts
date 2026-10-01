import type {ModelMessage,FunctionTool} from '../model-adapters/types';
import type { AgentCollaborationContext } from '../contracts/collaboration';
import { liveFail } from '../contracts/live-validation';

export const AGENT_CONTEXT_BYTES = 58_000;
type Context = {
 ownerTask: unknown; ownerReplies: unknown[]; policy: unknown; usage: unknown;
 inputs: unknown[]; requests: unknown[]; producedOutputs: unknown[]; evidence: unknown[];
 collaboration: AgentCollaborationContext; savedObservations: unknown[];
 fleet?: {messages:unknown[];revisions:unknown[]} | null;
 contextWindow?: {partial?:boolean;omitted?:Partial<Record<'savedObservations'|'publications'|'sharedArtifacts'|'board'|'inbox'|'fleetMessages'|'fleetRevisions',number>>};
};

/** Preserve owner intent and exact handles. Trim data collections, never wrap the
 * entire context in an excerpt that silently drops the task or its constraints. */
export function serializeAgentContext(source: Context, bytes = AGENT_CONTEXT_BYTES, measure:(text:string)=>number = text=>Buffer.byteLength(text)): string {
 const context = structuredClone(source);
 const omitted = { savedObservations: 0, publications: 0, sharedArtifacts: 0, board: 0, inbox: 0, ...(source.fleet?{fleetMessages:0,fleetRevisions:0}:{}) };
 for(const key of Object.keys(omitted) as (keyof typeof omitted)[]){
  const prior=source.contextWindow?.omitted?.[key];
  if(typeof prior==='number'&&Number.isSafeInteger(prior)&&prior>0)omitted[key]=prior;
 }
 const window = { partial: source.contextWindow?.partial===true||Object.values(omitted).some(n=>n>0), omitted, historyScope: 'At most 8 recent saved entries; catalog lists may also be bounded by the service. Missing history is not proof that an action never occurred.' };
 const payload = { ...context, contextWindow: window };
 const size = () => measure(JSON.stringify(payload));
 const trim = (items: unknown[], key: keyof typeof omitted, oldestFirst: boolean) => {
  while (size() > bytes && items.length) {
   if (oldestFirst) items.shift(); else items.pop();
   omitted[key]=(omitted[key]||0)+1; window.partial = true;
  }
 };
 // Keep the newest exact browser state usable. Dropping it before long peer
 // messages can otherwise trap an agent in observe/navigate loops with no refs.
 const latestBrowser=[...context.savedObservations].reverse().find(item=>{
  if(!item||typeof item!=='object')return false;
  const result=(item as {result?:unknown}).result;
  return !!result&&typeof result==='object'&&typeof (result as {tabId?:unknown}).tabId==='string'&&typeof (result as {revision?:unknown}).revision==='number';
 });
 while(size()>bytes){
  const index=context.savedObservations.findIndex(item=>item!==latestBrowser);
  if(index<0)break;
  context.savedObservations.splice(index,1);omitted.savedObservations++;window.partial=true;
 }
 for (const key of ['publications', 'sharedArtifacts', 'board', 'inbox'] as const) trim(context.collaboration[key], key, false);
 if(context.fleet){
  trim(context.fleet.messages,'fleetMessages',true);
  trim(context.fleet.revisions,'fleetRevisions',true);
 }
 const text=JSON.stringify(payload);
 if(measure(text)>bytes)liveFail('context_limit','The required task context is too large to send intact. Shorten the task or agent instructions, or reduce attached inputs before resuming. No model request was sent.');
 return text;
}

export function serializeRequiredContext(context: unknown, bytes = AGENT_CONTEXT_BYTES): string {
 const text = JSON.stringify(context);
 if (Buffer.byteLength(text) > bytes) liveFail('context_limit', 'The required task context is too large to send intact. Shorten the task or agent instructions, or reduce attached inputs before resuming. No model request was sent.');
 return text;
}

/** Fit repeated history to a configured adapter's conservative byte ceiling.
 * The exact source receipts stay saved; owner intent and required handles never become excerpts. */
export function fitModelInput(input:ModelMessage[],instructions:string,tools:FunctionTool[],byteCeiling?:number):ModelMessage[]{
 if(!byteCeiling)return input;
 const size=(messages:ModelMessage[])=>Buffer.byteLength(JSON.stringify({instructions,input:messages,tools}));
 if(size(input)<=byteCeiling)return input;
 const index=input.findIndex(m=>m.role==='user'&&'content' in m&&typeof m.content==='string'&&m.content.includes('"savedObservations"'));
 if(index<0)liveFail('context_limit','The model input cannot fit its configured local size allowance. No request was sent.');
 const entry=input[index];if(!('content' in entry))return input;
 const context=JSON.parse(entry.content) as Context;
 const content=serializeAgentContext(context,byteCeiling,text=>size(input.map((m,i)=>i===index?{...m,content:text}:m)));
 const fitted=input.map((m,i)=>i===index?{...m,content}:m);
 if(size(fitted)>byteCeiling)liveFail('context_limit','The required model context cannot fit the connection allowance. No request was sent.');
 return fitted;
}
