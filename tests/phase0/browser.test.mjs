import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, encodeFrame, SessionController, permittedURL } from '../../spikes/phase0/browser/protocol.mjs';
import { browserRunArgs, BrowserClient } from '../../spikes/phase0/browser/client.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const req = (method = 'page.observe', generation = 1, actor = 'agent') => ({ id: 'request-1', method, generation, actor, params: {} });
test('framing reconstructs split headers/bodies and coalesced frames', () => {
  const decoder = new FrameDecoder(); const combined = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: '✓' })]); const result = [];
  for (const byte of combined) result.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(result, [{ a: 1 }, { b: '✓' }]); decoder.end();
});
test('framing rejects declared oversized messages before receiving their payload', () => {
  const header = Buffer.alloc(4); header.writeUInt32BE(2 ** 30);
  assert.throws(() => new FrameDecoder().push(header), /invalid_frame_length/);
  const decoder = new FrameDecoder(); decoder.push(Buffer.from([0, 0])); assert.throws(() => decoder.end(), /truncated_frame/);
});
test('handoff fences queued agent actions and waits for current action before claiming ownership', async () => {
  const controller = new SessionController(); let finish; let started;
  const signal = new Promise(resolve => { started = resolve; });
  const running = controller.submit(req(), () => new Promise(resolve => { finish = resolve; started(); }));
  await signal;
  let queuedExecuted = false;
  const queued = controller.submit(req(), async () => { queuedExecuted = true; });
  const runningRejected = assert.rejects(running, /outcome_unknown/); const queuedRejected = assert.rejects(queued, /stale_generation/);
  const takeover = controller.submit(req('control.take', 1, 'owner'), async () => 'handoff ready');
  assert.deepEqual(controller.state(), { controller: 'transitioning', generation: 2 });
  await assert.rejects(controller.submit(req(), async () => {}), /stale_generation/);
  finish('sensitive old frame'); await runningRejected; await queuedRejected;
  assert.equal((await takeover).controller, 'human'); assert.equal(queuedExecuted, false);
  await assert.rejects(controller.submit(req('page.observe', 2, 'agent'), async () => {}), /permission_denied/);
});
test('only owner can change control and returning fences stale human actions', async () => {
  const controller = new SessionController();
  await assert.rejects(controller.submit(req('control.take'), async () => {}), /permission_denied/);
  await controller.submit(req('control.take', 1, 'owner'), async () => {});
  const result = await controller.submit(req('control.release', 2, 'owner'), async () => ({ fresh: true }));
  assert.deepEqual(result, { controller: 'agent', generation: 3, result: { fresh: true } });
  await assert.rejects(controller.submit(req('page.key', 2, 'human'), async () => {}), /stale_generation/);
});
test('model cannot request arbitrary evaluation or non-web URL schemes', async () => {
  assert.throws(() => new SessionController().submit(req('page.evaluate'), async () => {}), /unknown_method/);
  for (const url of ['file:///etc/passwd', 'chrome://version', 'javascript:alert(1)', 'https://user:secret@example.com']) assert.throws(() => permittedURL(url));
  assert.equal(permittedURL('https://example.com'), 'https://example.com/');
});
test('launch contract has only bounded tmpfs and no published ports, bind mounts or namespace sharing', () => {
  const args = browserRunArgs({ name: 'test', network: 'isolated-agent' });
  for (const forbidden of ['--privileged', '--network=host', '--ipc=host', '--pid=host', '--no-sandbox', '--cap-add', '-v', '--volume', '--publish', '-p']) assert.ok(!args.includes(forbidden));
  for (const required of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--ipc=private', '--memory=2g', '--memory-swap=2g', '--log-driver=none']) assert.ok(args.includes(required));
  assert.throws(() => browserRunArgs({ name: 'test', network: 'host' }), /isolated/);
});
test('cleanup never stops a preexisting container with a different launch owner nonce', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const calls = [];
  const client = new BrowserClient(child, { name: 'occupied-name', ownerNonce: 'new-owner', runtimeExec: async (...args) => { calls.push(args); return { stdout: JSON.stringify({ id: 'a'.repeat(64), labels: { 'agent-workspaces.phase0.browser-owner': 'original-owner' } }) }; } });
  child.stdout.write(encodeFrame({type:'ready',generation:1,controller:'agent'})); await client.ready;
  await client.stop();
  assert.equal(calls.length, 1); assert.equal(calls[0][1][0], 'inspect');
});
