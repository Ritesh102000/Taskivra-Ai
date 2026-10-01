export function fail(code){throw Object.assign(new Error(code),{code});}
export const ID=/^[a-zA-Z0-9_-]{1,96}$/;
const schemas={
 'tabs.list':[],'tabs.open':['url'],'tabs.close':['tab'],
 'page.observe':['tab','screenshot'],'page.peek':['tab'],'page.navigate':['tab','url'],
 'page.click':['tab','revision','ref'],'page.fill':['tab','revision','ref','value'],'page.select':['tab','revision','ref','value'],
 'page.key':['tab','revision','text','key'],'page.scroll':['tab','revision','x','y'],
 'page.gmailUnread':['tab','account'],'control.take':['tab'],'control.release':['tab'],
 'download.list':[],
};
export function validURL(raw,{blank=false}={}){if(blank&&raw==='about:blank')return raw;if(typeof raw!=='string'||raw.length>4096)fail('invalid_url');let u;try{u=new URL(raw);}catch{fail('invalid_url');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)fail('permission_denied');return u.href;}
export function sensitiveURL(raw){try{const u=new URL(raw);return /^(accounts|login|signin)\./i.test(u.hostname)||/(?:^|\/)(?:login|signin|sign-in|oauth|authorize|auth)(?:\/|$)/i.test(u.pathname);}catch{return true;}}
export function validateRequest(r){if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['method','params','actor','generation'].includes(k)))fail('invalid_request');if(!schemas[r.method])fail(r.method?.startsWith('upload.')||r.method?.startsWith('download.')?'native_transfer_unsupported':'unknown_method');if(!['agent','owner','human'].includes(r.actor)||!Number.isSafeInteger(r.generation)||r.generation<1)fail('invalid_request');if(!r.params||typeof r.params!=='object'||Array.isArray(r.params)||Object.keys(r.params).some(k=>!schemas[r.method].includes(k)))fail('invalid_params');if(r.actor==='human')fail('native_manual_control');if(r.method.startsWith('control.')&&r.actor!=='owner')fail('permission_denied');if(['page.peek','download.list'].includes(r.method)&&r.actor!=='owner')fail('permission_denied');if(r.actor==='owner'&&!['control.take','control.release','page.peek','page.observe','tabs.list','download.list'].includes(r.method))fail('permission_denied');return r;}
export class Controller {
 constructor(generation){this.generation=generation;this.controller='agent';this.tail=Promise.resolve();this.pending=0;this.freshRequired=true;this.closed=false;}
 end(){this.closed=true;this.generation++;this.controller='human';this.freshRequired=true;}
 submit(raw,work){const r=validateRequest(raw);if(this.closed)fail('session_not_running');if(r.generation!==this.generation)fail('stale_generation');if(this.pending>=16)fail('queue_full');const control=r.method.startsWith('control.');if(control){if(this.controller!==(r.method==='control.take'?'agent':'human'))fail('controller_busy');this.generation++;this.controller='transitioning';this.freshRequired=true;}else if(r.actor==='agent'&&this.controller!=='agent')fail('permission_denied');const admitted=this.generation;this.pending++;
 const guard=()=>{if(this.closed||admitted!==this.generation||(!control&&r.actor==='agent'&&this.controller!=='agent'))fail('outcome_unknown');};
 const result=this.tail.then(async()=>{guard();if(control)this.controller=r.method==='control.take'?'human':'agent';if(r.actor==='agent'&&this.freshRequired&&!['page.observe','tabs.list'].includes(r.method))fail('fresh_observation_required');const result=await work(guard);guard();if(r.actor==='agent'&&r.method==='page.observe')this.freshRequired=false;return{controller:this.controller,generation:this.generation,result};});this.tail=result.catch(()=>{}).finally(()=>this.pending--);return result;
 }
}
