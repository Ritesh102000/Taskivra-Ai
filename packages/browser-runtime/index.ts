import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, rename, rm, realpath, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertManagedPath, ensureManagedDirectory } from '../artifacts/safe-io';
import { ProfileStore } from './profiles';
import { BrowserTransport } from './transport';
import type { BrowserHandle, FactoryOptions, LaunchOptions, RuntimeFactory, RequestOptions } from './types';
export type * from './types';

const execute = promisify(execFile);
const OWNER = 'io.agent-workspaces.browser.owner', RUN = 'io.agent-workspaces.browser.run';
const activeRuns = new Set<string>();
const ownerBrokerMethods = new Set(['page.observe', 'page.peek', 'tabs.list', 'upload.begin', 'upload.chunk', 'upload.finish', 'upload.abort', 'download.list', 'download.read', 'download.ack', 'download.cancel']);
interface Resource { kind: 'container' | 'network'; name: string; id: string | null }
interface Journal { version: 3; owner: string; run: string; pid: number; resources: Resource[] }
const identifier = (value: string) => { if (!/^[a-zA-Z0-9_-]{1,96}$/.test(value)) throw new Error('browser_identity_invalid'); return value; };
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

export function browserCreateArgs(input: { name: string; owner: string; run: string; image: string; network: string; seccompPath: string; generation: number; testFixture?: boolean }): string[] {
  return ['container', 'create', '--pull=never', '-i', '--init', '--name', input.name,
    '--label', `${OWNER}=${input.owner}`, '--label', `${RUN}=${input.run}`,
    '--network', input.network, '--dns=127.0.0.1', '--dns-search=.', '--dns-opt=timeout:1', '--dns-opt=attempts:1',
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1',
    '--user=1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt', `seccomp=${input.seccompPath}`,
    '--ipc=private', '--shm-size=512m', '--memory=2g', '--memory-swap=2g', '--cpus=2', '--pids-limit=256', '--ulimit', 'nofile=4096:4096',
    '--tmpfs', '/profile:rw,nosuid,nodev,noexec,size=256m,mode=700,uid=1000,gid=1000',
    '--tmpfs', '/transfers:rw,nosuid,nodev,noexec,size=256m,mode=700,uid=1000,gid=1000',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777', '--log-driver=none',
    '--env', 'BROWSER_PROXY_SERVER=http://egress:3128', '--env', `BROWSER_INITIAL_GENERATION=${input.generation}`,
    ...(input.testFixture ? ['--env', 'BROWSER_TEST_FIXTURE=1'] : []), input.image];
}
function proxyRestrictions(): string[] {
  return ['--read-only', '--user=65532:65532', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=128m', '--memory-swap=128m', '--pids-limit=64', '--cpus=0.5',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=8m', '--sysctl', 'net.ipv4.ip_forward=0', '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1', '--log-driver=none'];
}

/** No containers start in the constructor, status, or startup reconciliation. */
export class DockerBrowserRuntimeFactory implements RuntimeFactory {
  private readonly options: FactoryOptions;
  private root = '';
  private owner = '';
  private profiles!: ProfileStore;
  private initialized?: Promise<void>;
  private handles = new Map<string, BrowserHandle>();
  private launching = new Set<string>();
  private launchTasks = new Set<Promise<BrowserHandle>>();
  private closing = false;
  private cleanupDebt = new Set<string>();
  private fixture?: { journal: Journal; network: string; ip: string };
  private fixturePromise?: Promise<{ journal: Journal; network: string; ip: string }>;
  constructor(options: FactoryOptions) {
    if (typeof options.profileKey !== 'function' && options.profileKey.byteLength !== 32) throw new Error('browser_profile_key_invalid');
    this.options = { ...options, profileKey: typeof options.profileKey === 'function' ? options.profileKey : Buffer.from(options.profileKey) };
  }
  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      this.root = await realpath(this.options.dataRoot);
      if (!this.options.dockerPath) {
        const bundledDocker = '/Applications/Docker.app/Contents/Resources/bin/docker';
        try { await access(bundledDocker, constants.X_OK); this.options.dockerPath = bundledDocker; } catch { this.options.dockerPath = 'docker'; }
      }
      this.owner = createHash('sha256').update(this.root).digest('hex');
      await ensureManagedDirectory(this.root, 'control/browser-runtime');
      this.profiles = new ProfileStore(this.root, this.options.profileKey, this.owner, this.options.reserveStorage);
    })();
  }
  private async docker(args: string[], timeout = 15_000): Promise<string> {
    try { return (await execute(this.options.dockerPath || 'docker', args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout.trim(); }
    catch { throw new Error('browser_runtime_command_failed'); }
  }
  private async image(name: string, label: string): Promise<string> {
    const data = JSON.parse(await this.docker(['image', 'inspect', name]))[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(data.Id) || data.Config?.Labels?.[label] !== '3') throw new Error('browser_runtime_setup_required');
    return data.Id;
  }
  async status(): Promise<{ ready: boolean; message: string | null }> {
    try {
      await this.initialize(); await this.docker(['version', '--format', '{{.Server.Version}}']);
      await this.image(this.options.browserImage || 'agent-workspaces-browser:3', 'io.agent-workspaces.browser.protocol');
      await this.image(this.options.egressImage || 'agent-workspaces-egress:3', 'io.agent-workspaces.egress.policy');
      const profile = await stat(this.options.seccompPath); if (!profile.isFile()) throw new Error('seccomp_missing');
      return { ready: true, message: null };
    } catch { return { ready: false, message: 'Start Docker Desktop and run the explicit browser runtime setup command. No images are downloaded by the app.' }; }
  }
  private journalPath(journal: Journal): string { return join(this.root, 'control/browser-runtime', `${journal.run}.json`); }
  private async save(journal: Journal): Promise<void> {
    const path = this.journalPath(journal), temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await assertManagedPath(this.root, temp, { allowMissingLeaf: true });
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
    const directory = await open(join(this.root, 'control/browser-runtime'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async journal(): Promise<Journal> {
    const journal: Journal = { version: 3, owner: this.owner, run: randomUUID(), pid: process.pid, resources: [] };
    activeRuns.add(journal.run); await this.save(journal); return journal;
  }
  private name(journal: Journal, role: string): string { return `awp3-${this.owner.slice(0, 10)}-${journal.run.slice(0, 8)}-${role}`; }
  private labels(journal: Journal): string[] { return ['--label', `${OWNER}=${this.owner}`, '--label', `${RUN}=${journal.run}`]; }
  private async resource(journal: Journal, kind: Resource['kind'], role: string, create: (name: string) => string[]): Promise<Resource> {
    if (this.closing) throw new Error('browser_runtime_closed');
    const entry: Resource = { kind, name: this.name(journal, role), id: null };
    journal.resources.push(entry); await this.save(journal); // Persist intent before creating anything.
    const id = await this.docker(create(entry.name), 30_000);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('browser_runtime_invalid_id');
    entry.id = id; await this.save(journal);
    if (this.closing) throw new Error('browser_runtime_closed');
    return entry;
  }
  private async network(journal: Journal, role: string, internal: boolean): Promise<Resource> {
    return this.resource(journal, 'network', role, name => ['network', 'create', '--driver=bridge', ...this.labels(journal),
      ...(internal ? ['--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--opt', 'com.docker.network.bridge.gateway_mode_ipv6=isolated'] : []), name]);
  }
  private async cleanup(journal: Journal): Promise<void> {
    const failures: string[] = [];
    for (const entry of [...journal.resources].sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'container' ? -1 : 1)) {
      let data;
      try {
        const listing = await this.docker([entry.kind, 'ls', ...(entry.kind === 'container' ? ['-a'] : []), '--no-trunc', '--format', '{{.ID}}', '--filter', `label=${OWNER}=${this.owner}`, '--filter', `label=${RUN}=${journal.run}`]);
        const ids = listing.split('\n').filter(Boolean);
        // A missing journal ID may be the crash between create and recording its ID.
        if (entry.id && !ids.includes(entry.id)) {
          const foreign = await this.docker([entry.kind, 'inspect', entry.id]).catch(() => '');
          if (foreign) throw new Error('browser_cleanup_ownership_mismatch');
          continue;
        }
        if (!entry.id) {
          const matching = await this.docker([entry.kind, 'inspect', entry.name]).catch(() => '');
          if (!matching) continue;
          data = JSON.parse(matching)[0];
        } else data = JSON.parse(await this.docker([entry.kind, 'inspect', entry.id]))[0];
        const labels = entry.kind === 'container' ? data.Config?.Labels : data.Labels;
        if (labels?.[OWNER] !== this.owner || labels?.[RUN] !== journal.run || !/^[a-f0-9]{64}$/.test(data.Id) || (entry.id && data.Id !== entry.id)) throw new Error('browser_cleanup_ownership_mismatch');
        await this.docker([entry.kind, 'rm', ...(entry.kind === 'container' ? ['-f'] : []), data.Id], 15_000);
      } catch { failures.push(entry.kind); }
    }
    if (failures.length) {this.cleanupDebt.add(journal.run);throw new Error('browser_cleanup_incomplete');}
    this.cleanupDebt.delete(journal.run);
    activeRuns.delete(journal.run); await rm(this.journalPath(journal), { force: true });
  }
  private async testSite(image: string): Promise<{ journal: Journal; network: string; ip: string }> {
    return this.fixturePromise ??= (async () => {
      const journal = await this.journal();
      try {
        const network = await this.network(journal, 'fixture-net', true);
        const fixture = await this.resource(journal, 'container', 'fixture', name => ['container', 'create', '--pull=never', '--name', name, ...this.labels(journal), ...proxyRestrictions(), '--network', network.id!, image, '/opt/agent-egress/fixture.py']);
        await this.docker(['container', 'start', fixture.id!]);
        const data = JSON.parse(await this.docker(['container', 'inspect', fixture.id!]))[0];
        const ip = Object.values(data.NetworkSettings.Networks)[0] as { IPAddress: string };
        return this.fixture = { journal, network: network.id!, ip: ip.IPAddress };
      } catch (error) { await this.cleanup(journal); throw error; }
    })();
  }
  launch(options: LaunchOptions): Promise<BrowserHandle> {
    const work = this.provision(options); this.launchTasks.add(work);
    void work.finally(() => this.launchTasks.delete(work)).catch(() => {});
    return work;
  }
  private async provision(options: LaunchOptions): Promise<BrowserHandle> {
    identifier(options.sessionId); identifier(options.agentId);
    if (!Number.isSafeInteger(options.initialGeneration) || options.initialGeneration < 1) throw new Error('browser_generation_invalid');
    if (this.closing || this.handles.has(options.agentId) || this.launching.has(options.agentId)) throw new Error('browser_session_busy');
    if (this.handles.size + this.launching.size + this.cleanupDebt.size >= 2) throw new Error('browser_capacity_full');
    this.launching.add(options.agentId);
    let journal: Journal | undefined, transport: BrowserTransport | undefined, stopOwned: (() => Promise<void>) | undefined;
    try {
      if (!(await this.status()).ready) throw new Error('browser_runtime_setup_required');
      // Unlock only for actual browser work, before creating a journal or container.
      this.profiles.unlock();
      journal = await this.journal();
      const image = await this.image(this.options.browserImage || 'agent-workspaces-browser:3', 'io.agent-workspaces.browser.protocol');
      const proxyImage = await this.image(this.options.egressImage || 'agent-workspaces-egress:3', 'io.agent-workspaces.egress.policy');
      const internal = await this.network(journal, 'browser', true), outbound = await this.network(journal, 'outbound', false);
      const topology = JSON.parse(await this.docker(['network', 'inspect', internal.id!]))[0];
      if (!topology.Internal || topology.EnableIPv6 || topology.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') throw new Error('browser_network_invalid');
      const octets = String(topology.IPAM.Config[0].Subnet).split('/')[0].split('.'); octets[3] = String(Number(octets[3]) + 2); const proxyIp = octets.join('.');
      const fixture = this.options.testFixture ? await this.testSite(proxyImage) : undefined;
      const proxy = await this.resource(journal, 'container', 'proxy', name => ['container', 'create', '--pull=never', '--name', name, ...this.labels(journal!), ...proxyRestrictions(),
        '--network', `name=${internal.id},alias=egress,ip=${proxyIp}`, '--network', `name=${outbound.id},gw-priority=1`,
        ...(fixture ? ['--network', fixture.network, '--env', 'EGRESS_TEST_ONLY=1', '--env', `EGRESS_TEST_FIXTURE_IP=${fixture.ip}`] : []),
        '--env', `EGRESS_BIND=${proxyIp}`, '--dns-opt=timeout:2', '--dns-opt=attempts:1', proxyImage]);
      await this.docker(['container', 'start', proxy.id!]);
      const worker = await this.resource(journal, 'container', 'worker', name => browserCreateArgs({ name, owner: this.owner, run: journal!.run, image, network: internal.id!, seccompPath: resolve(this.options.seccompPath), generation: options.initialGeneration, testFixture: this.options.testFixture }));
      const child = spawn(this.options.dockerPath || 'docker', ['container', 'start', '-ai', worker.id!], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } });
      let stopping = false, stopPromise: Promise<void> | undefined;
      const stop = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        stopping = true;
        stopPromise = (async () => { transport?.dispose(); await this.cleanup(journal!); this.handles.delete(options.agentId); })().catch(error => { stopPromise = undefined; throw error; });
        return stopPromise;
      };
      stopOwned = stop;
      transport = new BrowserTransport(child, () => { if (!stopping) { options.onExit?.(); void stop().catch(() => {}); } });
      await transport.ready;
      const broker = async (method: string, params: object): Promise<unknown> => {
        if (this.closing) throw new Error('browser_runtime_closed');
        return (await transport!.request(method, params, { actor: 'broker', generation: transport!.generation })).result;
      };
      const restored = await this.profiles.restore(options.agentId, broker);
      if (!restored) { await broker('profile.restore.begin', {}); await broker('profile.restore.finish', {}); }
      const launched = await broker('session.launch', {}) as { sandbox: unknown };
      if (this.closing) { await stop(); throw new Error('browser_runtime_closed'); }
      const handle: BrowserHandle = {
        info: { containerId: worker.id!, imageId: image, networkId: internal.id!, restored, sandbox: launched.sandbox },
        request: (method: string, params: object, requestOptions: RequestOptions) => {
          if (/^(?:profile\.|session\.)/.test(method)) return Promise.reject(new Error('browser_permission_denied'));
          const actor = requestOptions.actor === 'owner' && ownerBrokerMethods.has(method) ? 'broker' : requestOptions.actor;
          return transport!.request(method, params, { ...requestOptions, actor });
        },
        close: async ({ saveProfile }) => {
          let savedAt: number | undefined;
          try {
            if (saveProfile) {
              const result = await broker('session.close', {}) as { profile?: { files?: unknown } };
              savedAt = await this.profiles.save(options.agentId, result.profile?.files, broker);
            }
            } catch(error) {await stop().catch(()=>{});throw error;}
          let cleanupPending=false;try{await stop();}catch{cleanupPending=true;}
          return { saved: savedAt !== undefined, ...(savedAt !== undefined ? { savedAt } : {}),cleanupPending };
        }, stop,
      };
      this.handles.set(options.agentId, handle); return handle;
    } catch (error) { if (stopOwned) await stopOwned(); else if (journal) await this.cleanup(journal); throw error; }
    finally { this.launching.delete(options.agentId); }
  }
  async reconcile(): Promise<void> {
    await this.initialize();
    await this.profiles.reconcile();
    const abandoned: Journal[] = [];
    for (const name of await readdir(join(this.root, 'control/browser-runtime'))) {
      const temporary = /^[a-f0-9-]{36}\.json\.([0-9]+)\.[a-f0-9-]{36}\.tmp$/.exec(name);
      if (temporary) {
        const pid = Number(temporary[1]);
        if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) {
          const path = join(this.root, 'control/browser-runtime', name); await assertManagedPath(this.root, path); await rm(path);
        }
        continue;
      }
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(this.root, 'control/browser-runtime', name); await assertManagedPath(this.root, path);
      const bytes = await readFile(path); if (bytes.length > 256 * 1024) throw new Error('browser_journal_invalid');
      const journal = JSON.parse(bytes.toString()) as Journal;
      if (journal.version !== 3 || journal.owner !== this.owner || name !== `${journal.run}.json` || !Array.isArray(journal.resources) || journal.resources.length > 16 || !Number.isSafeInteger(journal.pid) || journal.pid < 1) throw new Error('browser_journal_invalid');
      for (const entry of journal.resources) if (!['container', 'network'].includes(entry.kind) || !entry.name.startsWith(`awp3-${this.owner.slice(0, 10)}-${journal.run.slice(0, 8)}-`) || (entry.id !== null && !/^[a-f0-9]{64}$/.test(entry.id))) throw new Error('browser_journal_invalid');
      if (activeRuns.has(journal.run) || (journal.pid !== process.pid && alive(journal.pid))) continue;
      abandoned.push(journal);
    }
    // Test-only shared fixture networks outlive all per-agent proxies attached to them.
    abandoned.sort((a, b) => Number(a.resources.some(r => r.name.endsWith('-fixture-net'))) - Number(b.resources.some(r => r.name.endsWith('-fixture-net'))));
    for (const journal of abandoned) await this.cleanup(journal);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.launchTasks]);
    const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.stop()));
    try {
      if (this.fixture) await this.cleanup(this.fixture.journal);
      if (results.some(result => result.status === 'rejected')) throw new Error('browser_cleanup_incomplete');
    } finally {
      this.profiles?.close();
      if(typeof this.options.profileKey!=='function')this.options.profileKey.fill(0);
    }
  }
}
