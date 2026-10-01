export interface TroubleshootingNote {code:string;message:string;action:string;attempts:number;recovered:boolean;at:number}
/** Only the known Google rejection route is authoritative, never arbitrary page instructions. */
export function googleBrowserRejected(raw:unknown):boolean {
  if(typeof raw!=='string')return false;
  try{const url=new URL(raw);return url.origin==='https://accounts.google.com'&&/^\/(?:v\d+\/)?signin\/rejected\/?$/.test(url.pathname);}catch{return false;}
}
const transient=new Set(['observation_unavailable','stale_observation','fresh_observation_required','browser_transport_lost','browser_worker_exited','browser_worker_unavailable']);
export function recoverableReadError(error:unknown):string|null {
  const code=error&&typeof error==='object'&&'code'in error?error.code:null;
  return typeof code==='string'&&transient.has(code)?code:null;
}
