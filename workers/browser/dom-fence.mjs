// Created by Playwright as a retained, non-global JS handle. Page content receives
// neither an action API nor a reference to this observer's private revision.
export function createDOMFence() {
 let revision=1;
 const observer=new MutationObserver(()=>revision++);
 observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
 const read=()=>{if(observer.takeRecords().length)revision++;return revision;};
 return {read,close(){observer.disconnect();},act(el,expected,action){
  // Revision check and dispatch share one JavaScript turn. Playwright's automatic
  // locator waiting must not move an approved action onto a subsequently changed page.
  if(read()!==expected||!el?.isConnected)return{error:'stale_observation'};
  if(/^(accounts|login|signin)\./i.test(location.hostname)||/(?:^|\/)(?:login|signin|sign-in|oauth|authorize|auth)(?:\/|$)/i.test(location.pathname)||document.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="current-password"],input[autocomplete="new-password"]'))return{error:'human_login_required'};
  if(el.disabled||!el.getClientRects().length||el.matches('input[type="file"],input[type="hidden"]'))return{error:'invalid_target'};
  if(action.kind==='click'){
   const link=el.closest('a[href]');if(link){let u;try{u=new URL(link.href);}catch{return{error:'permission_denied'};}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return{error:'permission_denied'};}
   el.click();
  }else if(action.kind==='fill'){
   if(!el.matches('input,textarea,[contenteditable="true"]')||el.readOnly||typeof action.value!=='string'||action.value.length>8192)return{error:'invalid_target'};
   if(el.isContentEditable)el.textContent=action.value;else{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,action.value);}
   el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
  }else if(action.kind==='select'){
   if(!el.matches('select')||el.multiple||typeof action.value!=='string'||action.value.length>8192||Array.from(el.options).filter(o=>o.value===action.value&&!o.disabled&&!o.parentElement?.disabled).length!==1)return{error:'invalid_target'};
   Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,action.value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
  }else return{error:'unknown_method'};
  revision++;return{acted:true};
 }};
}
