import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadinessService, parseReadinessCommand, type ReadinessPorts, type ReadinessRequirements } from '../../packages/readiness';

const command = { type: 'readiness.check', target: { kind: 'task', taskId: 'task-fixture' } };
function fixture(required: Partial<ReadinessRequirements> = {}, overrides: Partial<ReadinessPorts> = {}) {
  const calls: string[] = [];
  const ports: ReadinessPorts = {
    resolve: () => ({ outcome: 'A useful report', model: 'fixture-model', agentId: 'agent-fixture', capabilities: [], ...required }),
    model: () => { calls.push('model-status'); return { credentialConfigured: true, models: [{ id: 'fixture-model' }] }; },
    browser: () => { calls.push('browser-status'); return { ready: true, message: null, backend: 'desktop_chrome', extensionConnected: true, setupRequired: false }; },
    code: () => { calls.push('code-status'); return { ready: true, message: null, imageDigest: 'fixture', packages: [] }; },
    projectAccounts: () => ({gmail:'owner@gmail.com',googleWorkspace:null}),
    gmail: () => { calls.push('gmail-status'); return { configured: true, connectedAccount: 'owner@gmail.com', connecting: false, error: null }; },
    ...overrides,
  };
  return { calls, service: new ReadinessService({ ports, now: () => 1000, timeoutMs: 20 }) };
}

test('CSV readiness checks only model and code, without browser or Gmail setup', async () => {
  const f = fixture({ capabilities: ['code'], inputSlots: [{ slotKey: 'current', label: 'Current', required: true, versionId: null, status: 'missing', detail: 'Assign a file.' }] });
  const state = await f.service.handle(command);
  assert.deepEqual(f.calls.sort(), ['code-status', 'model-status']);
  assert.equal(state.status, 'needs_attention');
  assert.equal(state.checks.find(check => check.id === 'inputs')!.blocking, true);
  assert.equal(state.paidProbePerformed, false);
});

test('native Chrome readiness needs no Docker/code check and does not claim website login was tested', async () => {
  const f = fixture({ capabilities: ['browser'] });
  const state = await f.service.handle(command);
  assert.deepEqual(f.calls.sort(), ['browser-status', 'model-status']);
  assert.equal(state.checks.find(check => check.id === 'browser')!.status, 'verified');
  assert.match(state.checks.find(check => check.id === 'browser')!.detail, /No page or sign-in was tested/);
  assert.equal(state.status, 'ready_with_limits');
});

test('disconnected native Chrome remains setup-needed even when the runtime is installed', async () => {
  const f = fixture({ capabilities: ['browser'] }, { browser: () => ({ ready: true, backend: 'desktop_chrome', extensionConnected: false, setupRequired: false, message: null }) });
  const check = (await f.service.handle(command)).checks.find(item => item.id === 'browser')!;
  assert.equal(check.status, 'needs_setup'); assert.equal(check.blocking, true);
  assert.match(check.detail, /reconnect/);
});

test('Gmail readiness uses exact account status and does not require a browser or read messages', async () => {
  const f = fixture({ capabilities: ['gmail'], mailAccount: 'Owner@gmail.com' });
  const state = await f.service.handle(command);
  assert.deepEqual(f.calls.sort(), ['gmail-status', 'model-status']);
  assert.equal(state.checks.find(check => check.id === 'gmail')!.status, 'configured');
  assert.match(state.checks.find(check => check.id === 'gmail')!.detail, /No email was read/);
  const mismatch = fixture({ capabilities: ['gmail'], mailAccount: 'another@gmail.com' });
  assert.equal((await mismatch.service.handle(command)).checks.find(check => check.id === 'gmail')!.blocking, true);
});

test('credential presence is never represented as verified model connectivity', async () => {
  const f = fixture();
  const state = await f.service.handle(command);
  assert.equal(state.checks[0].status, 'configured');
  assert.match(state.checks[0].detail, /have not been tested/);
  assert.equal(state.checks[0].checkedAt, 1000);
  const absent = fixture({}, { model: () => ({ credentialConfigured: false, models: [{ id: 'fixture-model' }] }) });
  assert.equal((await absent.service.handle(command)).checks[0].blocking, true);
});

test('failed and timed-out status ports fail closed without exposing raw errors', async () => {
  const f = fixture({ capabilities: ['code', 'browser'] }, { code: () => { throw Error('/private/secret-path private-token'); }, browser: () => new Promise(() => {}) });
  const state = await f.service.handle(command);
  assert.equal(state.checks.filter(check => check.status === 'unavailable').length, 2);
  assert.equal(state.status, 'needs_attention');
  assert.doesNotMatch(JSON.stringify(state), /private-token|secret-path/);
});

test('manual briefs state unspecified optional requirements instead of checking every tool', async () => {
  const f = fixture({ requirementsUnspecified: true });
  const state = await f.service.handle(command);
  assert.deepEqual(f.calls, ['model-status']);
  assert.match(state.notes.join(' '), /no declared tool requirements/);
});

test('readiness IPC rejects authority, file path and unsupported target fields', () => {
  for (const input of [
    { ...command, token: 'not-a-real-token' },
    { type: 'readiness.repair', target: command.target },
    { type: 'readiness.check', target: { kind: 'task', taskId: '../outside' } },
    { type: 'readiness.check', target: { ...command.target, path: '/private/path' } },
    { type: 'readiness.check', target: { kind: 'workflow', workflowId: 'data-report', model: 'fixture', values: { question: 4 } } },
  ]) assert.throws(() => parseReadinessCommand(input));
});

test('only required rejected file slots block; accepted checks do not imply semantic relevance', async () => {
  const f = fixture({ inputSlots: [{ slotKey: 'needed', label: 'Needed', required: true, versionId: 'v1', status: 'accepted', detail: 'Checked.' }, { slotKey: 'optional', label: 'Optional', required: false, versionId: null, status: 'missing', detail: 'Optional.' }] });
  const state = await f.service.handle(command);
  assert.equal(state.checks.find(check => check.id === 'inputs')!.blocking, false);
  assert.match(state.checks.find(check => check.id === 'inputs')!.detail, /relevance/);
});

test('saved Gmail connection requires the same explicitly approved project account',async()=>{for(const approved of [null,'other@gmail.com']){const f=fixture({capabilities:['gmail'],mailAccount:'owner@gmail.com'},{projectAccounts:()=>({gmail:approved,googleWorkspace:'owner@gmail.com'})});const state=await f.service.handle(command),check=state.checks.find(item=>item.id==='gmail')!;assert.equal(state.status,'needs_attention');assert.equal(check.blocking,true);assert.equal(check.action,'projects');assert.match(check.detail,/explicitly approved/);}const missingPort=fixture({capabilities:['gmail'],mailAccount:'owner@gmail.com'},{projectAccounts:undefined});assert.equal((await missingPort.service.handle(command)).checks.find(item=>item.id==='gmail')!.status,'unavailable');});
test('Gmail approval is checked again and a later revocation cannot reuse prior readiness',async()=>{let account:string|null='owner@gmail.com';const f=fixture({capabilities:['gmail'],mailAccount:'owner@gmail.com'},{projectAccounts:()=>({gmail:account,googleWorkspace:null})});assert.equal((await f.service.handle(command)).status,'ready_with_limits');account=null;assert.equal((await f.service.handle(command)).status,'needs_attention');});
test('explicit Google live-import requirement checks its independent project binding without document reads',async()=>{const state={configured:true,connectedAccount:'owner@gmail.com',connecting:false,error:null,scope:'https://www.googleapis.com/auth/drive.readonly' as const,access:'selected_imports' as const,setupMode:'owner_desktop_client' as const,liveAccessTested:true};let approved:string|null=null;const f=fixture({capabilities:['google_workspace'],googleWorkspaceAccount:'owner@gmail.com'},{googleWorkspace:()=>state,projectAccounts:()=>({gmail:'owner@gmail.com',googleWorkspace:approved})});assert.equal((await f.service.handle(command)).status,'needs_attention');approved='owner@gmail.com';assert.equal((await f.service.handle(command)).status,'ready_with_limits');assert.deepEqual(f.calls,['model-status','model-status']);});
test('PDF and XLSX require both isolated runtime and exact reviewed parser packages; plain jobs do not',async()=>{const packages=[{runtime:'python' as const,name:'pypdf',version:'6.19.0'},{runtime:'python' as const,name:'openpyxl',version:'3.1.5'},{runtime:'python' as const,name:'defusedxml',version:'0.7.1'}];for(const runtime of [{ready:false,imageDigest:'fixture',message:null,packages},{ready:true,imageDigest:null,message:null,packages},{ready:true,imageDigest:'fixture',message:null,packages:packages.slice(0,2)},{ready:true,imageDigest:'fixture',message:null,packages:packages.map(p=>({...p,version:'wrong'}))}]){const f=fixture({capabilities:['documents']},{code:()=>runtime});const check=(await f.service.handle(command)).checks.find(v=>v.id==='documents')!;assert.equal(check.blocking,true);assert.equal(check.action,'runtime');}let checks=0;const ready=fixture({capabilities:['code','documents']},{code:()=>{checks++;return{ready:true,imageDigest:'fixture',message:null,packages};}});assert.equal((await ready.service.handle(command)).checks.find(v=>v.id==='documents')!.status,'verified');assert.equal(checks,1);const plain=fixture();await plain.service.handle(command);assert.deepEqual(plain.calls,['model-status']);});
test('known unavailable or oversized document inputs need replacement before parser setup',async()=>{for(const input of [{format:'pdf' as const,bytes:33*1024*1024,available:true},{format:'xlsx' as const,bytes:1024,available:false}]){const f=fixture({capabilities:['documents'],documentInputs:[input]});const check=(await f.service.handle(command)).checks.find(v=>v.id==='documents')!;assert.equal(check.status,'needs_input');assert.equal(check.action,'files');assert.deepEqual(f.calls,['model-status']);}});
