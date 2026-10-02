// This fixed function runs in the extension's isolated world. No model source,
// selector, JS expression, or script URL is ever evaluated.
export function pageCommand(command) {
 const problem=code=>({error:code});
 const sensitive=()=>/^(accounts|login|signin)\./i.test(location.hostname)||/(?:^|\/)(?:login|signin|sign-in|oauth|authorize|auth)(?:\/|$)/i.test(location.pathname)||!!document.querySelector('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"]');
 const key='__agentWorkspacesIsolatedWorldV1';
 if(command.type==='clear'){const old=globalThis[key];old?.observer.disconnect();old?.refs.clear();delete globalThis[key];return{cleared:true};}
 let state=globalThis[key];if(!state){state={documentId:crypto.randomUUID(),revision:1,refs:new Map()};state.observer=new MutationObserver(()=>{state.revision++;state.refs.clear();});state.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});globalThis[key]=state;}
 const flush=()=>{if(state.observer.takeRecords().length){state.revision++;state.refs.clear();}};flush();
  if(sensitive())return{documentId:state.documentId,revision:state.revision,sensitive:true,text:'',title:'Login requires owner control',targets:[]};
 if(command.type==='inspect'||command.type==='peek'){
  const targets=[];let traversalLimitReached=false;if(command.type==='inspect'){
   state.refs.clear();const nodes=document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]');traversalLimitReached=nodes.length>2000;
   for(const el of Array.from(nodes).slice(0,2000)){if(targets.length>=150)break;if(!el.getClientRects().length||el.disabled||el.tagName==='INPUT'&&['password','hidden','file'].includes(el.type))continue;
    const kind=el.matches('input,textarea,[contenteditable="true"]')?'input':el.matches('select')?'select':el.matches('a,[role="link"]')?'link':'button';const ref=crypto.randomUUID();state.refs.set(ref,el);targets.push({ref,kind,label:(el.getAttribute('aria-label')||el.labels?.[0]?.textContent||el.getAttribute('placeholder')||el.textContent||el.tagName).slice(0,160)});
   }
  }
  return{documentId:state.documentId,revision:state.revision,sensitive:false,limits:{targetLimit:150,traversalLimit:2000,targetLimitReached:targets.length===150,traversalLimitReached},text:command.type==='inspect'?(document.body?.innerText||'').slice(0,16000):'',title:document.title.slice(0,200),targets,width:Math.max(1,Math.min(4096,innerWidth)),height:Math.max(1,Math.min(4096,innerHeight))};
 }
 if(command.documentId!==state.documentId||command.revision!==state.revision)return problem('stale_observation');
 let el;if(command.ref){el=state.refs.get(command.ref);if(!el?.isConnected)return problem('stale_observation');if(el.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"]'))return problem('human_login_required');}
 if(command.type==='click'){
  if(!el)return problem('invalid_target');const link=el.closest('a[href]');if(link){let u;try{u=new URL(link.href);}catch{return problem('permission_denied');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return problem('permission_denied');}
  el.click();
 }else if(command.type==='fill'){
  if(el?.readOnly||el?.disabled||!el?.matches('input,textarea,[contenteditable="true"]')||typeof command.value!=='string'||command.value.length>8192)return problem('invalid_target');
  if(el.isContentEditable)el.textContent=command.value;else{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,command.value);}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
 }else if(command.type==='select'){
  if(!el?.matches('select')||el.multiple||typeof command.value!=='string'||command.value.length>8192)return problem('invalid_target');
  const matching=Array.from(el.options).filter(o=>o.value===command.value&&!o.disabled&&!o.parentElement?.disabled);if(matching.length!==1)return problem('invalid_target');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,command.value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
 }else if(command.type==='scroll')window.scrollBy(command.x,command.y);
 else if(command.type==='key'){
  // Browser shortcuts, clipboard, file pickers and arbitrary native key events
  // are intentionally absent. Form submission is an explicit bounded action.
  const active=document.activeElement;if(!active||active.matches('input[type="password"],input[autocomplete="one-time-code"]'))return problem('human_login_required');
  if(command.key==='Enter'&&active.form)active.form.requestSubmit();else if(command.key==='Escape')active.blur();else return problem('unsupported_key');
 }else return problem('unknown_method');
 state.revision++;state.refs.clear();return{acted:true};
}
