import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Coordinator } from '../../packages/coordinator/index';
import { BrowserError } from '../../packages/browser/index';
import type { BrowserHandle, BrowserReply, BrowserRuntime } from '../../packages/browser/runtime';
import type { NativeChromeRuntime } from '../../packages/native-browser/index';
import type { BrowserBackend } from '../../packages/contracts/browser-setup';
import type { BrowserState } from '../../packages/contracts/browser';
import { BrowserRuntimeRouter, BrowserSetupController } from '../../apps/desktop/main/browser-setup-controller';

type Launch = Parameters<BrowserRuntime['launch']>[0];
type RequestOptions = Parameters<BrowserHandle['request']>[2];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class FixtureHandle implements BrowserHandle {
  generation: number;
  controller: 'agent' | 'human' = 'agent';
  stopped = false;
  tabId = randomUUID();
  revision = 1;
  calls: string[] = [];
  constructor(readonly options: Launch) { this.generation = options.initialGeneration; }
  private observation() {
    this.revision++;
    const tabs = [{ id: this.tabId, title: 'Synthetic setup fixture', url: 'https://fixture.example.test/', revision: this.revision }];
    return { tabs, selectedTabId: this.tabId, targets: [], text: 'Synthetic page', frame: this.controller === 'human' ? null : { jpegBase64: Buffer.from('synthetic-image').toString('base64'), width: 800, height: 600, tabId: this.tabId, revision: this.revision } };
  }
  async request(method: string, _params: Record<string, unknown>, options: RequestOptions): Promise<BrowserReply> {
    assert.equal(options.generation, this.generation);
    assert.equal(this.stopped, false);
    this.calls.push(method);
    if (method === 'control.take' || method === 'control.release') {
      this.generation++;
      this.controller = method === 'control.take' ? 'human' : 'agent';
      return { controller: this.controller, generation: this.generation, result: { observation: this.observation() } };
    }
    return { controller: this.controller, generation: this.generation, result: method === 'download.list' ? [] : this.observation() };
  }
  async close() { this.stopped = true; return { saved: true, savedAt: 1 }; }
  async stop() { this.stopped = true; }
}
class FixtureRuntime implements BrowserRuntime {
  handles: FixtureHandle[] = [];
  cleanupFailure = false;
  cleanupCalls = 0;
  ready = true;
  constructor(readonly kind: BrowserBackend) {}
  async status() { return { ready: this.ready, message: this.ready ? null : 'Fixture unavailable', backend: this.kind, supportsTransfers: this.kind === 'docker' }; }
  async reconcile() { this.cleanupCalls++; if (this.cleanupFailure) throw new Error('fixture_cleanup_unavailable'); }
  async launch(options: Launch) { const handle = new FixtureHandle(options); this.handles.push(handle); return handle; }
  async close() { await Promise.all(this.handles.map(handle => handle.stop())); }
}
class FixtureNative extends FixtureRuntime {
  setupCalls: string[] = [];
  opened: { agentId: string; setup: boolean }[] = [];
  statusCalls: string[] = [];
  registered = true;
  connected = true;
  setupGate: ReturnType<typeof deferred> | null = null;
  setupEntered: ReturnType<typeof deferred> | null = null;
  constructor() { super('desktop_chrome'); }
  async agentStatus(agentId: string) {
    this.statusCalls.push(agentId);
    return { backend: 'desktop_chrome' as const, registered: this.registered, connected: this.connected, setupRequired: !this.connected, extensionPath: '/synthetic/extension', message: this.connected ? null : 'Load the fixture extension.' };
  }
  async setup(agentId: string) { this.setupCalls.push(agentId); this.setupEntered?.resolve(); await this.setupGate?.promise; this.registered = true; return this.agentStatus(agentId); }
  async openProfile(agentId: string, options: { setup?: boolean } = {}) { this.opened.push({ agentId, setup: Boolean(options.setup) }); }
}
const asNative = (runtime: FixtureNative) => runtime as unknown as NativeChromeRuntime;
async function fixture(options: { defaultBackend?: BrowserBackend; dockerCleanupFails?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aw-browser-setup-'));
  const dataRoot = join(root, 'app');
  await mkdir(join(dataRoot, 'control'), { recursive: true });
  const native = new FixtureNative(), docker = new FixtureRuntime('docker');
  docker.cleanupFailure = options.dockerCleanupFails ?? false;
  const router = new BrowserRuntimeRouter({ dataRoot, desktop: asNative(native), docker, defaultBackend: options.defaultBackend });
  const c = new Coordinator({ dataRoot, browserRuntime: router });
  await c.browser.ready;
  c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
  const agent = c.handle({ type: 'agents.create', name: 'Setup fixture', instructions: '' }).agents[0];
  const task = c.handle({ type: 'tasks.create', agentId: agent.id, objective: 'Synthetic browser setup test', completionCriteria: '', scenario: 'complete' }).tasks[0];
  const controller = new BrowserSetupController(c, router, asNative(native));
  return { root, dataRoot, native, docker, router, c, agent, task, controller, close: async () => { native.setupGate?.resolve(); await c.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const isCode = (code: string) => (error: unknown) => error instanceof BrowserError && error.code === code;
const bound = (state: BrowserState) => ({ agentId: state.agentId, sessionId: state.sessionId, generation: state.generation });

test('native is the default; status polling never prepares profiles or opens windows; selection persists per agent', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 4; n++) {
      const status = await f.controller.handle({ type: 'browserSetup.state', agentId: f.agent.id });
      assert.equal(status.backend, 'desktop_chrome');
      assert.equal(status.ready, true);
      assert.equal(status.supportsTransfers, false);
    }
    assert.deepEqual(f.native.setupCalls, []); assert.deepEqual(f.native.opened, []); assert.equal(f.native.handles.length, 0);
    const selected = await f.controller.handle({ type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'docker' });
    assert.equal(selected.backend, 'docker'); assert.equal(selected.supportsTransfers, true);
    const savedPath = join(f.dataRoot, 'control', 'browser-backends.json');
    assert.deepEqual(JSON.parse(await readFile(savedPath, 'utf8')), { [f.agent.id]: 'docker' });
    assert.equal((await lstat(savedPath)).mode & 0o777, 0o600);
    const reopened = new BrowserRuntimeRouter({ dataRoot: f.dataRoot, desktop: asNative(f.native), docker: f.docker });
    assert.equal(reopened.selected(f.agent.id), 'docker');
    assert.equal(reopened.selected(randomUUID()), 'desktop_chrome');
    assert.deepEqual(f.native.opened, []);
  } finally { await f.close(); }
});

test('Docker fixture default routes launch to Docker and saved native selection overrides it', async () => {
  const f = await fixture({ defaultBackend: 'docker' });
  try {
    assert.equal((await f.controller.handle({ type: 'browserSetup.state', agentId: f.agent.id })).backend, 'docker');
    let browser = await f.c.browser.handle({ type: 'browser.open', agentId: f.agent.id, taskId: f.task.id });
    assert.equal(f.docker.handles.length, 1); assert.equal(f.native.handles.length, 0);
    browser = await f.c.browser.handle({ type: 'browser.close', ...bound(browser) });
    await f.controller.handle({ type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'desktop_chrome' });
    const reopened = new BrowserRuntimeRouter({ dataRoot: f.dataRoot, desktop: asNative(f.native), docker: f.docker, defaultBackend: 'docker' });
    assert.equal(reopened.selected(f.agent.id), 'desktop_chrome');
    await f.c.browser.handle({ type: 'browser.open', agentId: f.agent.id, taskId: f.task.id });
    assert.equal(f.native.handles.length, 1);
  } finally { await f.close(); }
});

test('unavailable Docker cleanup fences Docker only and recovers without disabling native Chrome', async () => {
  const f = await fixture({ dockerCleanupFails: true });
  try {
    assert.equal((await f.router.status(f.agent.id)).ready, true);
    let browser = await f.c.browser.handle({ type: 'browser.open', agentId: f.agent.id, taskId: f.task.id });
    assert.equal(f.native.handles.length, 1);
    browser = await f.c.browser.handle({ type: 'browser.close', ...bound(browser) });
    await f.controller.handle({ type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'docker' });
    assert.equal((await f.router.status(f.agent.id)).ready, false);
    await assert.rejects(f.router.launch({ agentId: f.agent.id, sessionId: randomUUID(), initialGeneration: 1, onExit() {} }), isCode('browser_recovery_required'));
    assert.equal(f.docker.handles.length, 0);
    f.docker.cleanupFailure = false;
    assert.equal((await f.router.status(f.agent.id)).ready, true);
    await f.router.launch({ agentId: f.agent.id, sessionId: randomUUID(), initialGeneration: 1, onExit() {} });
    assert.equal(f.docker.handles.length, 1);
  } finally { await f.close(); }
});

test('backend switching rejects both agent-owned and human-owned open sessions, then succeeds after close', async () => {
  const f = await fixture();
  try {
    let browser = await f.c.browser.handle({ type: 'browser.open', agentId: f.agent.id, taskId: f.task.id });
    await assert.rejects(f.controller.handle({ type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'docker' }), isCode('browser_busy'));
    browser = await f.c.browser.handle({ type: 'browser.takeControl', ...bound(browser) });
    assert.equal(browser.controller, 'human');
    await assert.rejects(f.controller.handle({ type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'docker' }), isCode('browser_busy'));
    assert.equal(f.router.selected(f.agent.id), 'desktop_chrome');
    await f.c.browser.handle({ type: 'browser.close', ...bound(browser) });
    assert.equal((await f.controller.handle({ type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'docker' })).backend, 'docker');
  } finally { await f.close(); }
});

test('a running task with no open browser blocks backend changes and profile opening until paused', async () => {
  const f = await fixture();
  try {
    assert.ok(f.c.claimNext());
    for (const command of [{ type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'docker' }, { type: 'browserSetup.openProfile', agentId: f.agent.id }, { type: 'browserSetup.prepare', agentId: f.agent.id }]) await assert.rejects(f.controller.handle(command), isCode('browser_busy'));
    assert.deepEqual(f.native.opened, []); assert.deepEqual(f.native.setupCalls, []);
    f.c.handle({ type: 'tasks.pause', taskId: f.task.id }); f.c.tick();
    assert.equal(f.c.snapshot().tasks[0].state, 'paused');
    await f.controller.handle({ type: 'browserSetup.prepare', agentId: f.agent.id });
    assert.deepEqual(f.native.opened, [{ agentId: f.agent.id, setup: true }]);
  } finally { await f.close(); }
});

test('a separate coordinator cannot switch or open the live browser owned by its peer', async () => {
  const f = await fixture();
  let peer: Coordinator | undefined;
  try {
    await f.c.browser.handle({ type: 'browser.open', agentId: f.agent.id, taskId: f.task.id });
    const native = new FixtureNative(), docker = new FixtureRuntime('docker');
    const router = new BrowserRuntimeRouter({ dataRoot: f.dataRoot, desktop: asNative(native), docker });
    peer = new Coordinator({ dataRoot: f.dataRoot, browserRuntime: router });
    await peer.browser.ready;
    const controller = new BrowserSetupController(peer, router, asNative(native));
    await assert.rejects(controller.handle({ type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'docker' }), isCode('browser_owned'));
    await assert.rejects(controller.handle({ type: 'browserSetup.openProfile', agentId: f.agent.id }), isCode('browser_owned'));
    assert.deepEqual(native.opened, []); assert.deepEqual(native.setupCalls, []);
    assert.equal(f.native.handles[0].stopped, false);
    assert.equal(router.selected(f.agent.id), 'desktop_chrome');
  } finally { await peer?.shutdown(); await f.close(); }
});

test('manual profile opening requires human control of an active browser and never follows background polling', async () => {
  const f = await fixture();
  try {
    let browser = await f.c.browser.handle({ type: 'browser.open', agentId: f.agent.id, taskId: f.task.id });
    assert.ok(f.c.claimNext());
    await assert.rejects(f.controller.handle({ type: 'browserSetup.openProfile', agentId: f.agent.id }), isCode('browser_busy'));
    assert.deepEqual(f.native.opened, []);
    browser = await f.c.browser.handle({ type: 'browser.takeControl', ...bound(browser) });
    await f.controller.handle({ type: 'browserSetup.openProfile', agentId: f.agent.id });
    assert.deepEqual(f.native.opened, [{ agentId: f.agent.id, setup: false }]);
    for (let n = 0; n < 3; n++) await f.controller.handle({ type: 'browserSetup.state', agentId: f.agent.id });
    assert.equal(f.native.opened.length, 1);
    browser = await f.c.browser.handle({ type: 'browser.returnControl', ...bound(browser) });
    await assert.rejects(f.controller.handle({ type: 'browserSetup.openProfile', agentId: f.agent.id }), isCode('browser_busy'));
    assert.equal(f.native.opened.length, 1);
  } finally { await f.close(); }
});

test('extra paths, unknown actions, unsupported backends and unknown agents fail before setup effects', async () => {
  const f = await fixture();
  try {
    for (const command of [null, [], { type: 'browserSetup.openProfile', agentId: f.agent.id, path: '/private/forged' }, { type: 'browserSetup.prepare', agentId: f.agent.id, permission: 'all' }, { type: 'browserSetup.selectBackend', agentId: f.agent.id, backend: 'arbitrary' }, { type: 'browserSetup.shell', agentId: f.agent.id }, Object.assign(Object.create({ inherited: true }), { type: 'browserSetup.prepare', agentId: f.agent.id })]) await assert.rejects(f.controller.handle(command), isCode('invalid_command'));
    await assert.rejects(f.controller.handle({ type: 'browserSetup.prepare', agentId: randomUUID() }), isCode('not_found'));
    assert.deepEqual(f.native.setupCalls, []); assert.deepEqual(f.native.opened, []);
  } finally { await f.close(); }
});

test('setup rechecks ownership after async preparation and refuses duplicate in-flight commands', async () => {
  const f = await fixture();
  try {
    f.native.setupGate = deferred(); f.native.setupEntered = deferred();
    const preparing = f.controller.handle({ type: 'browserSetup.prepare', agentId: f.agent.id });
    await f.native.setupEntered.promise;
    await assert.rejects(f.controller.handle({ type: 'browserSetup.openProfile', agentId: f.agent.id }), isCode('browser_busy'));
    assert.ok(f.c.claimNext());
    f.native.setupGate.resolve();
    await assert.rejects(preparing, isCode('browser_busy'));
    assert.equal(f.native.setupCalls.length, 1); assert.deepEqual(f.native.opened, []);
  } finally { await f.close(); }
});
