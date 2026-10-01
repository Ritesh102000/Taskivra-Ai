'use strict';
const token = location.hash.slice(1); history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
let controller = 'agent', selected = null, revision = null, dimensions = { width: 1120, height: 760 }, busy = false;
const inputQueue = [];
function status(text) { $('status').textContent = text; }
function controls() { $('controller').textContent = `Controller: ${controller === 'human' ? 'You' : 'Agent'}`; $('control').textContent = controller === 'human' ? 'Return to agent' : 'Take control'; for (const id of ['refresh','close','go','new','tabs','url']) $(id).disabled = busy || inputQueue.length > 0 || controller !== 'human'; $('control').disabled = busy || inputQueue.length > 0; }
function observation(value) {
  if (!value) return;
  selected = value.tab; revision = value.revision; dimensions = value.viewport;
  $('url').value = value.url;
  if (value.screenshot) { $('screen').src = `data:${value.screenshot.mime};base64,${value.screenshot.base64}`; $('screen').hidden = false; $('empty').hidden = true; }
}
function tabs(value) { $('tabs').replaceChildren(...value.map(t => { const option = document.createElement('option'); option.value = t.id; option.textContent = t.title || t.url || 'New tab'; return option; })); if (selected) $('tabs').value = selected; }
async function rpc(method, params = {}) {
  if (busy) return null;
  busy = true; controls(); status(method.startsWith('control.') ? 'Finishing current browser action…' : 'Working…');
  try {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Viewer-Token': token }, body: JSON.stringify({ method, params }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    controller = result.controller; const value = result.result;
    if (Array.isArray(value)) tabs(value); else if (value?.tabs) { tabs(value.tabs); observation(value.observation); } else if (value?.tab) observation(value);
    status(controller === 'human' ? 'You control this browser.' : 'Returned to agent with a fresh observation.');
    return result;
  } catch (error) { status(error.message); return null; }
  finally { busy = false; controls(); }
}
async function refreshTabs() { if (controller === 'human') await rpc('tabs.list'); }
function enqueueInput(value) {
  if (controller !== 'human') return;
  if (inputQueue.length >= 256) { status('Input queue full. Wait before typing more.'); return; }
  const last = inputQueue.at(-1);
  if (value.text && last?.text && last.tab === selected && last.text.length + value.text.length <= 8192) last.text += value.text;
  else inputQueue.push({ ...value, tab: selected });
  controls(); void drainInput();
}
let draining = false;
async function drainInput() {
  if (draining) return; draining = true;
  try {
    while (inputQueue.length && controller === 'human') {
      if (busy) { await new Promise(resolve => setTimeout(resolve, 20)); continue; }
      const value = inputQueue.shift();
      const result = await rpc('page.key', { ...value, revision });
      if (!result) { inputQueue.length = 0; status('Input stopped after a failed action. Refresh the page before continuing.'); break; }
    }
  } finally { draining = false; controls(); }
}
$('control').onclick = async () => { await rpc(controller === 'human' ? 'control.release' : 'control.take', selected ? { tab: selected } : {}); if (controller === 'human') { await refreshTabs(); if (!selected && $('tabs').value) { selected = $('tabs').value; await rpc('page.observe', {tab:selected}); } } else { $('screen').removeAttribute('src'); $('screen').hidden = true; $('empty').hidden = false; $('empty').textContent = 'Agent has control. Take control to see the current page.'; } };
$('new').onclick = async () => { await rpc('tabs.open', { url: $('url').value }); await refreshTabs(); };
$('navigation').onsubmit = async event => { event.preventDefault(); await rpc(selected ? 'page.navigate' : 'tabs.open', {tab:selected,url:$('url').value}); await refreshTabs(); };
$('refresh').onclick = () => selected && rpc('page.observe', {tab:selected});
$('tabs').onchange = () => { selected = $('tabs').value; void rpc('page.observe', {tab:selected}); };
$('close').onclick = async () => { const old = selected; selected = null; await rpc('tabs.close', {tab:old}); if ($('tabs').value) {selected=$('tabs').value; await rpc('page.observe',{tab:selected});} else { $('screen').hidden=true; $('empty').hidden=false; } };
const screen = $('screen');
screen.onclick = async event => { if (controller !== 'human') return; const rect=screen.getBoundingClientRect(); await rpc('page.click',{tab:selected,revision,x:(event.clientX-rect.left)*dimensions.width/rect.width,y:(event.clientY-rect.top)*dimensions.height/rect.height}); screen.focus(); };
screen.onkeydown = event => { if (controller !== 'human' || event.isComposing) return; if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='v') return; event.preventDefault(); const p={}; if(event.key.length===1 && !event.metaKey && !event.ctrlKey) p.text=event.key; else { const names={Meta:'Meta',Control:'Control',Alt:'Alt',Shift:'Shift',' ':'Space'}; const key=names[event.key]||event.key; if(['Meta','Control','Shift','Alt'].includes(key))return; p.key=[event.ctrlKey||event.metaKey?'Control':null,event.altKey?'Alt':null,event.shiftKey?'Shift':null,key].filter(Boolean).join('+'); } enqueueInput(p); };
screen.onpaste = event => { event.preventDefault(); if (controller==='human') enqueueInput({text:event.clipboardData.getData('text/plain').slice(0,8192)}); };
screen.oncompositionend = event => { if(event.data) enqueueInput({text:event.data.slice(0,8192)}); };
screen.onwheel = event => { event.preventDefault(); if(controller==='human'&&!busy) void rpc('page.scroll',{tab:selected,revision,x:Math.max(-2000,Math.min(2000,event.deltaX)),y:Math.max(-2000,Math.min(2000,event.deltaY))}); };
controls();
