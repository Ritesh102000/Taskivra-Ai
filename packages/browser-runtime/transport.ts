import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Controller, RuntimeResponse, RequestOptions } from './types';

export class BrowserTransport {
  generation = 1;
  controller: Controller = 'agent';
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (v: RuntimeResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private failed = false;
  private diagnostics = 0;
  private receivedReady = false;
  private readyResolve!: (v: unknown) => void;
  private readyReject!: (e: Error) => void;
  private timer: NodeJS.Timeout;
  readonly ready: Promise<unknown>;
  constructor(private child: ChildProcessWithoutNullStreams, private onFailure: () => void) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.timer = setTimeout(() => this.fail(new Error('browser_startup_timeout')), 45_000);
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32BE(0);
          if (!length || length > 3 * 1024 * 1024) throw new Error('browser_transport_invalid');
          if (this.buffer.length < length + 4) break;
          const frame = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
          this.buffer = this.buffer.subarray(length + 4);
          if (!frame || !Number.isSafeInteger(frame.generation) || frame.generation < 1 || !['agent', 'human', 'transitioning'].includes(frame.controller)) throw new Error('browser_transport_invalid');
          if (frame.type === 'ready') {
            if (this.receivedReady || frame.protocol !== 3 || frame.phase !== 'restore') throw new Error('browser_protocol_mismatch');
            this.receivedReady = true;
            clearTimeout(this.timer); this.generation = frame.generation; this.controller = frame.controller; this.readyResolve(frame); continue;
          }
          if (frame.type === 'fatal') throw new Error('browser_worker_failed');
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id); clearTimeout(pending.timer);
          if (frame.generation >= this.generation) { this.generation = frame.generation; this.controller = frame.controller; }
          if (frame.ok === true) pending.resolve({ controller: frame.controller, generation: frame.generation, result: frame.result });
          else {
            const code = typeof frame.error === 'string' && /^[a-z_]{1,80}$/.test(frame.error) ? frame.error : 'browser_action_failed';
            pending.reject(Object.assign(new Error(code), { code }));
          }
        }
        if (this.buffer.length > 3 * 1024 * 1024 + 4) throw new Error('browser_transport_invalid');
      } catch { this.fail(new Error('browser_transport_invalid')); }
    });
    child.stderr.on('data', bytes => { this.diagnostics += bytes.length; if (this.diagnostics > 1024 * 1024) this.fail(new Error('browser_diagnostics_limit')); });
    child.stdin.on('error', () => this.fail(new Error('browser_transport_lost')));
    child.on('error', () => this.fail(new Error('browser_transport_lost')));
    child.on('exit', () => this.fail(new Error('browser_worker_exited')));
  }
  request(method: string, params: object, options: RequestOptions | { actor: 'broker'; generation: number }): Promise<RuntimeResponse> {
    if (this.failed) return Promise.reject(new Error('browser_worker_unavailable'));
    if (this.pending.size >= 32) return Promise.reject(new Error('browser_queue_full'));
    const id = randomUUID(), body = Buffer.from(JSON.stringify({ id, method, params, actor: options.actor, generation: options.generation }));
    if (!body.length || body.length > 256 * 1024) return Promise.reject(new Error('browser_request_limit'));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('browser_action_outcome_unknown')), 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(Buffer.concat([prefix, body]), error => { if (error) this.fail(new Error('browser_transport_lost')); });
    });
  }
  dispose(): void { this.fail(new Error('browser_worker_stopped')); this.child.stdin.end(); this.child.kill('SIGTERM'); }
  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true; clearTimeout(this.timer); this.readyReject(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onFailure();
  }
}
