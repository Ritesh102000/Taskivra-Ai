// Explicit invocation only: requires an already provisioned isolated egress topology.
// This test sends synthetic fixture input; it never stores screenshots or typed values.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserClient } from '../../spikes/phase0/browser/client.mjs';

const exec = promisify(execFile);
const network = process.env.BROWSER_NETWORK;
const networkB = process.env.BROWSER_NETWORK_B;
const fixture = process.env.BROWSER_FIXTURE_URL || 'http://fixture.agent-workspaces.test:8080';
if (!network) throw new Error('Set BROWSER_NETWORK to an existing isolated Phase 0 fixture network');
if (networkB === network) throw new Error('Two agents require two distinct isolated networks');
const started = Date.now();
const report = { kind: 'phase0-browser', startedAt: new Date().toISOString(), status: 'running', checks: {}, limitations: ['Synthetic login only; owner-required website/MFA not supplied.', 'Temporary bounded profile; persistent profile retention and quota remain unresolved.', 'Screenshots and credentials are intentionally absent from this report.'] };
const client = await BrowserClient.launch({ name: `aw-phase0-browser-a-${process.pid}`, network, proxy: process.env.BROWSER_PROXY_SERVER || 'http://egress:3128' });
let peer;
try {
  const ready = await client.ready;
  report.imageId = client.imageId; report.sandbox = ready.sandbox;
  assert.equal(ready.sandbox.namespaceSandbox, true); assert.equal(ready.sandbox.seccompBpfSandbox, true);
  report.checks.sandbox = true;
  const inspected = JSON.parse((await exec('docker', ['inspect', client.name])).stdout)[0];
  const host = inspected.HostConfig;
  assert.equal(inspected.Config.User, '1000:1000'); assert.equal(host.ReadonlyRootfs, true); assert.equal(host.Privileged, false);
  assert.equal(host.IpcMode, 'private'); assert.equal(host.ShmSize, 512 * 1024 ** 2); assert.equal(host.Memory, 2 * 1024 ** 3); assert.equal(host.MemorySwap, host.Memory);
  assert.deepEqual(host.CapDrop, ['ALL']); assert.ok(host.SecurityOpt.some(x => x.startsWith('no-new-privileges')));
  assert.ok(!host.Binds?.length); assert.ok(!Object.keys(host.PortBindings || {}).length);
  assert.ok(!inspected.Config.Env.some(x => /OPENAI|API_KEY|TOKEN|SECRET/.test(x)));
  assert.equal(host.LogConfig.Type, 'none');
  report.checks.runtimeBoundary = true;
  const first = (await client.request('tabs.open', {url:fixture})).result;
  const second = (await client.request('tabs.open', {url:`${fixture}/account`})).result;
  assert.notEqual(first.tab, second.tab); assert.match(first.title, /Agent Workspaces/); assert.match(second.text, /signed out/);
  assert.ok(Buffer.from(first.screenshot.base64, 'base64').subarray(0, 2).equals(Buffer.from([255,216])));
  report.checks.twoTabsAndJpegFrame = true;
  await assert.rejects(client.request('page.observe', {tab:'forged-tab-id'}), /unknown_tab/);
  await assert.rejects(client.request('page.click', {tab:first.tab, revision:0, x:10,y:10}), /stale_observation/);
  report.checks.forgedTabAndStaleObservationRejected = true;
  const before = client.generation;
  const human = await client.request('control.take', {tab:first.tab}, {actor:'owner'});
  assert.equal(human.controller, 'human'); assert.ok(human.generation > before);
  await assert.rejects(client.request('page.observe', {tab:first.tab}), /permission_denied/);
  await assert.rejects(client.request('page.observe', {tab:first.tab}, {actor:'agent',generation:before}), /stale_generation/);
  report.checks.exclusiveHumanControl = true;
  let observation = human.result.observation;
  const input = async (method, params) => { const r = await client.request(method, {tab:first.tab,revision:observation.revision,...params}, {actor:'human'}); observation=r.result; return observation; };
  // Pixel click and keyboard are the viewer's bounded input primitives. A
  // semantic focus then types synthetic values without exposing arbitrary eval.
  await input('page.click', {x:12,y:12});
  await input('page.click', {selector:'input[name=username]'});
  await input('page.key', {text:'fixtureA'});
  await input('page.key', {key:'Tab'});
  await input('page.key', {text:'synthetic-only-password'});
  await input('page.key', {key:'Tab'});
  await input('page.key', {key:'Enter'});
  // Regression: navigation caused by Enter must re-observe without repeating
  // the key/submission. The key response itself must be a coherent new page.
  assert.match(observation.url, /\/account$/);
  assert.match(observation.text, /Account: fixtureA/);
  report.checks.enterNavigationObservation = true;
  observation = (await client.request('page.observe', {tab:first.tab}, {actor:'human'})).result;
  assert.match(observation.text, /Account: fixtureA/);
  report.checks.pointerKeyboardSyntheticLogin = true;
  const humanGeneration = client.generation;
  const released = await client.request('control.release', {tab:first.tab}, {actor:'owner'});
  assert.equal(released.controller,'agent'); assert.ok(released.result.observation.revision > observation.revision); assert.match(released.result.observation.text,/Account: fixtureA/);
  await assert.rejects(client.request('page.key',{tab:first.tab,text:'late'}, {actor:'human',generation:humanGeneration}), /stale_generation/);
  report.checks.freshObservationAfterReturn = true;
  const sameSession = (await client.request('page.navigate', {tab:second.tab,url:`${fixture}/account`})).result;
  assert.match(sameSession.text,/Account: fixtureA/); report.checks.cookiesSharedOnlyWithinAgent = true;
  if (networkB) {
    peer = await BrowserClient.launch({name:`aw-phase0-browser-b-${process.pid}`, network:networkB, proxy:process.env.BROWSER_PROXY_SERVER || 'http://egress:3128'});
    await peer.ready;
    const peerPage = (await peer.request('tabs.open',{url:`${fixture}/account`})).result;
    assert.match(peerPage.text,/signed out/);
    report.checks.separateAgentCookieIsolation = true;
    report.concurrency = JSON.parse(`[${(await exec('docker',['stats','--no-stream','--format','{{json .}}',client.name,peer.name])).stdout.trim().split('\n').join(',')}]`);
    report.concurrencyNote = 'Two simultaneous browser workers on separate networks, synthetic fixture only; not a production load benchmark.';
  }
  const rootWrite = await exec('docker',['exec',client.name,'node','-e',"require('fs').writeFileSync('/opt/root-write-probe','x')"]).then(()=>true,()=>false);
  assert.equal(rootWrite,false); report.checks.readOnlyRootEnforced = true;
  report.status='passed';
} catch (error) { report.status='failed'; report.error=error.code || error.message; process.exitCode=1; }
finally { await peer?.stop(); await client.stop(); report.durationMs=Date.now()-started; process.stdout.write(`${JSON.stringify(report,null,2)}\n`); }
