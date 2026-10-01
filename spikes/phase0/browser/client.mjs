import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { FrameDecoder, encodeFrame, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from './protocol.mjs';

const exec = promisify(execFile);
export const defaultImage = 'agent-workspaces-phase0-browser:1.63.0';
export function browserRunArgs({ name, ownerNonce = '', image = defaultImage, network, proxy = 'http://egress:3128', seccomp = fileURLToPath(new URL('./seccomp.json', import.meta.url)) }) {
  if (!name || !network || ['host', 'bridge', 'none'].includes(network)) throw new Error('Dedicated isolated internal network required');
  return ['run', '--rm', '--pull=never', '-i', '--init', '--name', name, '--label', 'agent-workspaces.phase=0',
    '--label', `agent-workspaces.phase0.browser-owner=${ownerNonce}`,
    '--network', network, '--dns=127.0.0.1', '--dns-search=.', '--dns-opt=timeout:1', '--dns-opt=attempts:1',
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1',
    '--user=1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt', `seccomp=${seccomp}`,
    '--ipc=private', '--shm-size=512m', '--memory=2g', '--memory-swap=2g', '--cpus=2', '--pids-limit=256', '--ulimit', 'nofile=4096:4096',
    '--tmpfs', '/profile:rw,nosuid,nodev,noexec,size=256m,mode=700,uid=1000,gid=1000',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777',
    '--log-driver=none', '--env', `BROWSER_PROXY_SERVER=${proxy}`, image];
}

export class BrowserClient {
  constructor(child, { name, ownerNonce, runtimeExec = exec } = {}) {
    this.child = child; this.name = name; this.pending = new Map(); this.generation = 1; this.controller = 'agent'; this.diagnosticsBytes = 0; this.closed = false; this.failed = false;
    this.ownerNonce = ownerNonce; this.runtimeExec = runtimeExec;
    const decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.readyTimer = setTimeout(() => this.fail(new Error('Browser startup timed out')), 45000);
    child.stdout.on('data', bytes => {
      try {
        for (const frame of decoder.push(bytes)) {
          if (frame.type === 'ready') { clearTimeout(this.readyTimer); this.generation = frame.generation; this.controller = frame.controller; this.readyResolve(frame); continue; }
          if (frame.type === 'fatal') { this.fail(new Error(frame.error)); continue; }
          const item = this.pending.get(frame.id); if (!item) continue;
          this.pending.delete(frame.id); clearTimeout(item.timer);
          // Concurrent responses can arrive out of order; generation must never go backwards.
          if (frame.generation >= this.generation) { this.generation = frame.generation; this.controller = frame.controller; }
          if (frame.ok) item.resolve(frame); else item.reject(Object.assign(new Error(frame.error), { code: frame.error }));
        }
      } catch { this.fail(new Error('Invalid browser transport')); }
    });
    child.stderr.on('data', bytes => { this.diagnosticsBytes += bytes.length; if (this.diagnosticsBytes > 1024 * 1024) this.fail(new Error('Browser diagnostic output exceeded limit')); });
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    child.on('exit', () => { this.closed = true; this.fail(new Error('Browser worker exited')); });
  }
  request(method, params = {}, { actor = 'agent', generation = this.generation } = {}) {
    if (this.closed || this.failed) return Promise.reject(new Error('Browser worker unavailable'));
    if (this.pending.size >= 32) return Promise.reject(new Error('Too many pending requests'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let frame;
      try { frame = encodeFrame({ id, actor, generation, method, params }, MAX_REQUEST_BYTES); } catch (error) { reject(error); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser action outcome unknown')); void this.stop(); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame, error => { if (error) this.fail(error); });
    });
  }
  fail(error) {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.readyTimer); this.readyReject(error);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (!this.closed && !this.stopping) void this.stop();
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.fail(new Error('Browser worker stopped'));
    this.stopPromise = this.stopOwned();
    return this.stopPromise;
  }
  async stopOwned() {
    this.child.stdin.end();
    if (this.name && this.ownerNonce) {
      const inspected = await this.runtimeExec('docker', ['inspect', '--format', '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}', this.name], { timeout: 5000, maxBuffer: 65536 }).catch(() => null);
      if (inspected) {
        try {
          const owned = JSON.parse(inspected.stdout);
          if (owned.labels?.['agent-workspaces.phase0.browser-owner'] === this.ownerNonce && /^[a-f0-9]{64}$/.test(owned.id)) {
            await this.runtimeExec('docker', ['stop', '--timeout', '3', owned.id], { timeout: 8000 }).catch(() => {});
          }
        } catch { /* Ownership could not be established; never stop a named foreign container. */ }
      }
    }
    if (!this.closed) this.child.kill('SIGTERM');
  }
  static async launch(config) {
    const inspectedNetwork = await exec('docker', ['network', 'inspect', '--format', '{"internal":{{json .Internal}},"options":{{json .Options}}}', config.network], { timeout: 10000, maxBuffer: 65536 });
    const topology = JSON.parse(inspectedNetwork.stdout);
    if (!topology.internal || topology.options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') throw new Error('Verified isolated internal network required');
    const inspected = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', config.image || defaultImage], { timeout: 10000 });
    const image = inspected.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('A verified local image is required');
    const ownerNonce = randomUUID();
    const child = spawn('docker', browserRunArgs({ ...config, image, ownerNonce }), { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } });
    const client = new BrowserClient(child, { ...config, ownerNonce }); client.imageId = image; return client;
  }
}
