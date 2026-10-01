import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { assertManagedPath, ensureManagedDirectory } from '../artifacts/safe-io';
import type { CodeRuntimeStatus } from '../contracts/code';
import type { CodeRuntime, CodeHandle, CodeOutcome, CodeResourceLimits } from '../code/runtime';
import { MAX_BYTES, MAX_FILES, receiveExport, sendSeed, validateSeedFiles } from './protocol';

const execute = promisify(execFile);
const OWNER = 'io.agent-workspaces.code.owner', RUN = 'io.agent-workspaces.code.run';
const IMAGE_LABEL = 'io.agent-workspaces.code.protocol';
const active = new Set<string>();
interface Journal { version: 4; owner: string; run: string; pid: number; name: string; id: string | null }
export interface CodeFactoryOptions { dataRoot: string; dockerPath?: string; image?: string }
type Launch = Parameters<CodeRuntime['launch']>[0];
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const check = (signal: AbortSignal): void => { if (signal.aborted) throw new Error('code_stopped'); };
function validIdentity(value: string): void { if (!/^[a-zA-Z0-9_-]{1,96}$/.test(value)) throw new Error('code_identity_invalid'); }
export function validateLimits(limits: CodeResourceLimits): void {
  const bounds: Record<keyof CodeResourceLimits, [number, number]> = {
    memoryMiB: [128, 1024], workspaceMiB: [1, 512], tmpMiB: [1, 128], pids: [16, 256],
    timeoutSeconds: [1, 120], logBytes: [1024, 1024 * 1024], exportBytes: [1, MAX_BYTES], files: [1, MAX_FILES],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) { const value = limits[key as keyof CodeResourceLimits]; if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('code_limits_invalid'); }
  if (limits.exportBytes > limits.workspaceMiB * 1024 * 1024) throw new Error('code_limits_invalid');
}
export function codeCreateArgs(input: { name: string; owner: string; run: string; image: string; limits: CodeResourceLimits; sharedBytes: number }): string[] {
  const l = input.limits; validateLimits(l);
  return ['container', 'create', '--pull=never', '--platform=linux/arm64', '--name', input.name,
    '--label', `${OWNER}=${input.owner}`, '--label', `${RUN}=${input.run}`, '--network=none', '--read-only',
    '--cap-drop=ALL', '--cap-add=KILL', '--security-opt=no-new-privileges', '--user=0:0',
    `--memory=${l.memoryMiB}m`, `--memory-swap=${l.memoryMiB}m`, '--cpus=1', `--pids-limit=${l.pids}`,
    '--ipc=private', '--shm-size=1m', '--ulimit', 'core=0:0', '--ulimit', 'nofile=256:256', '--log-driver=none',
    '--tmpfs', `/workspace:rw,noexec,nosuid,nodev,size=${l.workspaceMiB}m,nr_inodes=${l.files * 2 + 128},uid=10000,gid=10000,mode=0755`,
    '--tmpfs', `/shared:rw,noexec,nosuid,nodev,size=${Math.max(1, Math.ceil(input.sharedBytes / 1024 / 1024))}m,nr_inodes=${l.files * 2 + 128},uid=0,gid=0,mode=0755`,
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${l.tmpMiB}m,nr_inodes=1024,mode=1777`,
    '--env', 'PYTHONDONTWRITEBYTECODE=1', input.image];
}

/** Fresh, isolated container per execution. Constructors and status never start a container or pull an image. */
export class DockerCodeRuntimeFactory implements CodeRuntime {
  private options: CodeFactoryOptions;
  private root = ''; private owner = ''; private initialized?: Promise<void>;
  private handles = new Set<CodeHandle>(); private pending = new Set<Promise<CodeHandle>>();
  private shutdown = new AbortController(); private busy = false; private uncertainCreation = false;
  constructor(options: CodeFactoryOptions) { this.options = { ...options }; }
  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      this.root = await realpath(this.options.dataRoot);
      if (!this.options.dockerPath) {
        const bundled = '/Applications/Docker.app/Contents/Resources/bin/docker';
        try { await access(bundled, constants.X_OK); this.options.dockerPath = bundled; } catch { this.options.dockerPath = 'docker'; }
      }
      this.owner = createHash('sha256').update(this.root).digest('hex');
      await ensureManagedDirectory(this.root, 'control/code-runtime');
    })();
  }
  private async docker(args: string[], timeout = 15_000): Promise<string> {
    try { return (await execute(this.options.dockerPath || 'docker', args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout.trim(); }
    catch { throw new Error('code_runtime_command_failed'); }
  }
  private async image(): Promise<{ id: string; packages: CodeRuntimeStatus['packages'] }> {
    const data = JSON.parse(await this.docker(['image', 'inspect', this.options.image || 'agent-workspaces-code:4']))[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(data.Id) || data.Architecture !== 'arm64' || data.Config?.Labels?.[IMAGE_LABEL] !== '4' || data.Config?.Volumes) throw new Error('code_runtime_setup_required');
    const packageText = data.Config?.Labels?.['io.agent-workspaces.code.packages'];
    if (typeof packageText !== 'string' || packageText.length > 32768) throw new Error('code_image_packages_invalid');
    const packages = JSON.parse(packageText);
    if (!Array.isArray(packages) || packages.length > 128 || packages.some(p => !p || !['python', 'node'].includes(p.runtime) || typeof p.name !== 'string' || !/^[a-zA-Z0-9_@./-]{1,128}$/.test(p.name) || typeof p.version !== 'string' || !/^[a-zA-Z0-9.+_-]{1,128}$/.test(p.version))) throw new Error('code_image_packages_invalid');
    return { id: data.Id, packages };
  }
  async status(): Promise<CodeRuntimeStatus> {
    if (this.uncertainCreation) return { ready: false, message: 'Code runtime cleanup must be reconciled before another execution can start.', imageDigest: null, packages: [] };
    try { await this.initialize(); await this.docker(['version', '--format', '{{.Server.Version}}']); const image = await this.image(); return { ready: true, message: null, imageDigest: image.id, packages: image.packages }; }
    catch { return { ready: false, message: 'Start Docker Desktop and run npm run code:setup. The app never downloads runtime images.', imageDigest: null, packages: [] }; }
  }
  private journalPath(journal: Journal): string { return join(this.root, 'control/code-runtime', `${journal.run}.json`); }
  private async save(journal: Journal): Promise<void> {
    const path = this.journalPath(journal), temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await assertManagedPath(this.root, temp, { allowMissingLeaf: true });
    const file = await open(temp, 'wx', 0o600); try { await file.writeFile(JSON.stringify(journal)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path); const directory = await open(join(this.root, 'control/code-runtime'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async owned(journal: Journal): Promise<any | null> {
    const ids = (await this.docker(['container', 'ls', '-a', '--no-trunc', '--format', '{{.ID}}', '--filter', `label=${OWNER}=${this.owner}`, '--filter', `label=${RUN}=${journal.run}`])).split('\n').filter(Boolean);
    if (journal.id && !ids.includes(journal.id)) {
      const foreign = await this.docker(['container', 'inspect', journal.id]).catch(() => '');
      if (foreign) throw new Error('code_cleanup_ownership_mismatch'); return null;
    }
    const raw = await this.docker(['container', 'inspect', journal.id || journal.name]).catch(() => '');
    if (!raw) { if (journal.id && ids.includes(journal.id)) throw new Error('code_cleanup_inspect_failed'); return null; }
    const data = JSON.parse(raw)[0];
    if (data.Config?.Labels?.[OWNER] !== this.owner || data.Config?.Labels?.[RUN] !== journal.run || !/^[a-f0-9]{64}$/.test(data.Id) || (journal.id && journal.id !== data.Id)) throw new Error('code_cleanup_ownership_mismatch');
    return data;
  }
  private async cleanup(journal: Journal, preserveIntent = false): Promise<void> {
    const info = await this.owned(journal);
    if (info) await this.docker(['container', 'rm', '-f', info.Id]); // Immutable checked ID, never a mutable name.
    active.delete(journal.run); if (!preserveIntent) await rm(this.journalPath(journal), { force: true });
  }
  private async trusted(journal: Journal, args: string[]): Promise<string> {
    return this.docker(['exec', '--user=0:0', journal.id!, 'python3', '-I', '/opt/agent-code/supervisor.py', ...args], 15_000);
  }
  private async seed(journal: Journal, files: Launch['files'], limits: CodeResourceLimits, signal: AbortSignal): Promise<void> {
    for (const area of ['workspace', 'shared'] as const) {
      check(signal);
      const child = spawn(this.options.dockerPath || 'docker', ['exec', '-i', `--user=${area === 'workspace' ? '10000:10000' : '0:0'}`, journal.id!, 'python3', '-I', '/opt/agent-code/seed.py', area, String(limits.files), String(limits.exportBytes)], { stdio: ['pipe', 'pipe', 'pipe'] });
      let observed = 0; const output: Buffer[] = [];
      const abort = () => { child.kill('SIGKILL'); void this.owned(journal).then(info => info?.State.Running ? this.docker(['container', 'kill', info.Id], 10_000) : undefined).catch(() => {}); };
      const timer = setTimeout(abort, 30_000); signal.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdout.on('data', (data: Buffer) => { observed += data.length; if (observed <= 8192) output.push(data); else abort(); });
      child.stderr.on('data', (data: Buffer) => { observed += data.length; if (observed > 8192) abort(); });
      const complete = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('code_seed_failed'))); });
      // Attach immediately so a transport exit while the input is being read cannot reject unhandled.
      void complete.catch(() => {});
      try {
        await sendSeed(child.stdin, files.filter(file => file.area === area), this.root, signal); await complete;
        if (observed > 8192 || JSON.parse(Buffer.concat(output).toString()).seeded !== true) throw new Error('code_seed_failed'); check(signal);
      } catch (error) { abort(); await complete.catch(() => {}); throw error; }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
  }
  launch(options: Launch): Promise<CodeHandle> {
    if (this.uncertainCreation) return Promise.reject(new Error('code_runtime_recovery_required'));
    if (this.busy || this.shutdown.signal.aborted) return Promise.reject(new Error('code_runtime_busy'));
    this.busy = true;
    const work = this.provision(options); this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {}); return work;
  }
  private async provision(options: Launch): Promise<CodeHandle> {
    const signal = AbortSignal.any([options.signal, this.shutdown.signal]); let journal: Journal | undefined, createAttempted = false;
    try {
      validIdentity(options.executionId); validIdentity(options.agentId); validIdentity(options.taskId); validateLimits(options.limits);
      validateSeedFiles(options.files, options.limits.files, options.limits.exportBytes); check(signal); await this.initialize(); check(signal);
      const image = await this.image(); check(signal);
      const run = randomUUID(); journal = { version: 4, owner: this.owner, run, pid: process.pid, name: `awp4-${this.owner.slice(0, 10)}-${run.slice(0, 8)}`, id: null };
      active.add(run); await this.save(journal); check(signal);
      createAttempted = true;
      journal.id = await this.docker(codeCreateArgs({ name: journal.name, owner: this.owner, run, image: image.id, limits: options.limits, sharedBytes: options.files.filter(f => f.area === 'shared').reduce((n, f) => n + f.bytes, 0) }), 30_000);
      if (!/^[a-f0-9]{64}$/.test(journal.id)) throw new Error('code_runtime_invalid_id'); await this.save(journal); check(signal);
      await this.docker(['container', 'start', journal.id]); check(signal);
      await this.seed(journal, options.files, options.limits, signal); check(signal);
      const j = journal; let stopped = false, used = false, success = false, exported = false, stopWork: Promise<void> | undefined;
      const stop = (): Promise<void> => {
        if (stopWork) return stopWork;
        stopped = true;
        stopWork = this.cleanup(j).then(() => { signal.removeEventListener('abort', abort); this.handles.delete(handle); this.busy = false; }).catch(error => { stopWork = undefined; throw error; });
        return stopWork;
      };
      const abort = () => { void stop().catch(() => {}); };
      const handle: CodeHandle = {
        info: { containerId: j.id!, imageDigest: image.id },
        run: async run => {
          if (used || stopped) throw new Error('code_execution_already_used');
          if (run.cwd !== '/workspace' || !Array.isArray(run.argv) || !run.argv.length || run.argv.length > 128 || run.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || Buffer.byteLength(JSON.stringify(run.argv)) > 32768) throw new Error('code_argv_invalid');
          used = true; const runningSignal = AbortSignal.any([signal, run.signal]); check(runningSignal);
          const startedAt = Date.now(), started = performance.now(); let reason: CodeOutcome['reason'] = 'exited', logsTruncated = false, count = 0;
          const child = spawn(this.options.dockerPath || 'docker', ['exec', '--user=10000:10000', '--workdir=/workspace', j.id!, '/usr/bin/env', '-i', 'PATH=/opt/code-venv/bin:/usr/local/bin:/usr/bin:/bin', 'NODE_PATH=/opt/code-node/node_modules', 'HOME=/tmp', 'PYTHONDONTWRITEBYTECODE=1', ...run.argv], { stdio: ['ignore', 'pipe', 'pipe'] });
          const terminate = (why: CodeOutcome['reason']) => { if (reason === 'exited') reason = why; void stop().catch(() => {}).finally(() => child.kill('SIGKILL')); };
          const onAbort = () => terminate('stopped'); runningSignal.addEventListener('abort', onAbort, { once: true });
          if (runningSignal.aborted) onAbort();
          const timer = setTimeout(() => terminate('timeout'), options.limits.timeoutSeconds * 1000);
          const log = (stream: 'stdout' | 'stderr', data: Buffer) => {
            const accepted = data.subarray(0, Math.max(0, options.limits.logBytes - count)); count += data.length;
            try { if (accepted.length) run.onLog(stream, accepted); } catch { terminate('runtime_lost'); }
            if (count > options.limits.logBytes) { logsTruncated = true; terminate('log_limit'); }
          };
          child.stdout.on('data', data => log('stdout', data)); child.stderr.on('data', data => log('stderr', data));
          let exitCode: number | null;
          try { exitCode = await new Promise<number | null>(resolve => { child.once('error', () => { reason = 'runtime_lost'; resolve(null); }); child.once('close', code => resolve(code)); }); }
          finally { clearTimeout(timer); }
          if (reason === 'exited') {
            try {
              const info = await this.owned(j);
              if (!info?.State.Running) { reason = info?.State.OOMKilled ? 'oom' : stopped ? 'stopped' : 'runtime_lost'; exitCode = null; }
              else { const status = JSON.parse(await this.trusted(j, ['quiesce'])); if (status.quiesced !== true || status.remaining?.length) throw new Error('code_quiesce_failed'); success = exitCode === 0; }
            } catch { reason = stopped ? 'stopped' : 'runtime_lost'; exitCode = null; }
          }
          if (runningSignal.aborted) reason = 'stopped';
          if (reason !== 'exited') { exitCode = null; success = false; await stop().catch(() => {}); }
          runningSignal.removeEventListener('abort', onAbort);
          return { exitCode, reason, startedAt, finishedAt: Date.now(), durationMs: Math.round(performance.now() - started), logsTruncated };
        },
        export: async ({ destination, signal: requestedSignal }) => {
          const exportingSignal = AbortSignal.any([signal, requestedSignal]); check(exportingSignal);
          if (stopped || !success || exported) throw new Error('code_export_forbidden'); exported = true;
          const quiesceAbort = () => { void stop().catch(() => {}); };
          exportingSignal.addEventListener('abort', quiesceAbort, { once: true });
          try {
            check(exportingSignal); const status = JSON.parse(await this.trusted(j, ['quiesce']));
            if (status.quiesced !== true || !Array.isArray(status.remaining) || status.remaining.length) throw new Error('code_quiesce_failed'); check(exportingSignal);
          } catch (error) { await stop().catch(() => {}); throw error; }
          finally { exportingSignal.removeEventListener('abort', quiesceAbort); }
          const child = spawn(this.options.dockerPath || 'docker', ['exec', '--user=10000:10000', j.id!, 'python3', '-I', '/opt/agent-code/exporter.py', String(options.limits.files), String(options.limits.exportBytes)], { stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.on('error', () => {});
          let stderr = 0, failed = false;
          const abortExport = () => { failed = true; child.stdout.destroy(new Error('code_export_interrupted')); child.kill('SIGKILL'); void stop().catch(() => {}); };
          const timer = setTimeout(abortExport, 60_000); exportingSignal.addEventListener('abort', abortExport, { once: true });
          if (exportingSignal.aborted) abortExport();
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 8192) abortExport(); });
          const complete = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('code_export_failed'))); });
          void complete.catch(() => {});
          try {
            const files = await receiveExport(child.stdout, destination, this.root, options.limits, exportingSignal); await complete;
            check(exportingSignal); if (failed || !(await this.owned(j))?.State.Running) throw new Error('code_export_interrupted'); return files;
          } catch (error) { abortExport(); await complete.catch(() => {}); throw error; }
          finally { clearTimeout(timer); exportingSignal.removeEventListener('abort', abortExport); }
        }, stop, close: stop,
      };
      this.handles.add(handle); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { await stop(); throw new Error('code_stopped'); } return handle;
    } catch (error) {
      // A failed Docker create transport can finish in the daemon after its CLI dies.
      // Retain the intent and capacity fence for startup reconciliation in that case.
      const uncertain = Boolean(journal && createAttempted && !journal.id);
      this.uncertainCreation = uncertain;
      if (journal) { try { await this.cleanup(journal, uncertain); } finally { active.delete(journal.run); } }
      this.busy = false; throw error;
    }
  }
  async reconcile(): Promise<void> {
    await this.initialize();
    for (const name of await readdir(join(this.root, 'control/code-runtime'))) {
      const temporary = /^[a-f0-9-]{36}\.json\.([0-9]+)\.[a-f0-9-]{36}\.tmp$/.exec(name);
      if (temporary) { if (!alive(Number(temporary[1]))) { const path = join(this.root, 'control/code-runtime', name); await assertManagedPath(this.root, path); await rm(path); } continue; }
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(this.root, 'control/code-runtime', name); await assertManagedPath(this.root, path);
      const before = await lstat(path); if (!before.isFile() || before.nlink !== 1 || before.size > 8192) throw new Error('code_journal_invalid');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let journal: Journal;
      try { const bytes = Buffer.alloc(8193); const read = await file.read(bytes); if (read.bytesRead > 8192) throw new Error('code_journal_invalid'); journal = JSON.parse(bytes.subarray(0, read.bytesRead).toString()); } finally { await file.close(); }
      if (journal.version !== 4 || journal.owner !== this.owner || name !== `${journal.run}.json` || !/^[a-f0-9-]{36}$/.test(journal.run) || !Number.isSafeInteger(journal.pid) || journal.pid < 1 || journal.name !== `awp4-${this.owner.slice(0, 10)}-${journal.run.slice(0, 8)}` || (journal.id !== null && !/^[a-f0-9]{64}$/.test(journal.id))) throw new Error('code_journal_invalid');
      if (active.has(journal.run) || (journal.pid !== process.pid && alive(journal.pid))) continue;
      await this.cleanup(journal);
    }
    if (!this.handles.size && !this.pending.size) { this.uncertainCreation = false; this.busy = false; }
  }
  async close(): Promise<void> {
    this.shutdown.abort(); await Promise.allSettled([...this.pending]);
    const results = await Promise.allSettled([...this.handles].map(handle => handle.stop()));
    if (this.uncertainCreation || results.some(result => result.status === 'rejected')) throw new Error('code_cleanup_incomplete');
  }
}
