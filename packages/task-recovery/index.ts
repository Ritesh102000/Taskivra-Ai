import {randomUUID} from 'node:crypto';
import type {SQLInputValue} from 'node:sqlite';
import type {Persistence} from '../persistence';
import type {TaskRecoveryIncident, TaskRecoveryState} from '../contracts/task-recovery';
import {identity, record} from '../contracts/live-validation';

type Row = Record<string, string | number | null>;
const TRANSIENT_READ_ERRORS = new Set(['observation_unavailable','stale_observation','fresh_observation_required','browser_transport_lost','browser_worker_exited','browser_worker_unavailable']);
export const RECOVERY_LIMITS = Object.freeze({maxRetriesPerIncident: 2, maxRetriesPerTask: 4, delaysMs: [300, 1200] as readonly number[]});
export function recoverableReadCode(error: unknown): string | null {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && TRANSIENT_READ_ERRORS.has(code) ? code : null;
}
const messages: Record<TaskRecoveryIncident['state'], string> = {
  waiting: 'Waiting briefly before requesting a fresh browser observation.',
  retrying: 'Requesting a fresh browser observation within the saved retry limit.',
  recovered: 'A fresh browser observation succeeded; the task continued from saved progress.',
  exhausted: 'Automatic observation recovery stopped. Review the browser or connection before resuming the task.',
  cancelled: 'Recovery stopped when the task or workspace was paused. No further retry was sent.',
  interrupted: 'Recovery was interrupted by an app or process exit. Saved attempts were retained; nothing was replayed.',
};
export interface RecoveryRead<T> {
  taskId: string; runId: string; operation: 'browser_read';
  check: () => void; signal?: AbortSignal; read: () => Promise<T>;
}
/** This service accepts only an internal fresh-read callback. It cannot retry a model call, navigation, click or external write. */
export class TaskRecoveryService {
  private suspended = false;
  private cancellation = new AbortController();
  private active = new Set<Promise<unknown>>();
  constructor(private options: {persistence: Persistence; now?: () => number; onChanged?: () => void; wait?: (ms: number, signal: AbortSignal) => Promise<void>}) {
    for (const row of this.rows("SELECT id,owner_pid FROM task_recovery_incidents WHERE state IN ('waiting','retrying')")) {
      let alive = false;
      try { if (Number(row.owner_pid) > 0) {process.kill(Number(row.owner_pid), 0); alive = true;} } catch {}
      if (!alive) this.write("UPDATE task_recovery_incidents SET state='interrupted',next_attempt_at=NULL,updated_at=? WHERE id=?", this.now(), row.id);
    }
  }
  private get db() {return this.options.persistence.db;}
  private now() {return (this.options.now || Date.now)();}
  private rows(sql: string, ...args: SQLInputValue[]) {return this.db.prepare(sql).all(...args) as Row[];}
  private row(sql: string, ...args: SQLInputValue[]) {return this.db.prepare(sql).get(...args) as Row | undefined;}
  private write(sql: string, ...args: SQLInputValue[]) {return this.db.prepare(sql).run(...args);}
  private changed(type: string, taskId: string, id: string) {
    this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,1,?,?)', type, taskId, JSON.stringify({taskId, incidentId: id}), this.now());
    this.options.onChanged?.();
  }
  state(): TaskRecoveryState {
    return {incidents: this.rows('SELECT * FROM task_recovery_incidents ORDER BY created_at DESC,id LIMIT 100').map(r => ({
      id: String(r.id), taskId: String(r.task_id), runId: String(r.run_id), operation: 'browser_read', code: String(r.code),
      state: r.state as TaskRecoveryIncident['state'], attempts: Number(r.attempts), nextAttemptAt: r.next_attempt_at === null ? null : Number(r.next_attempt_at),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), acknowledged: Boolean(r.acknowledged), message: messages[r.state as TaskRecoveryIncident['state']],
    })), needsAttention: Number(this.row("SELECT count(*) AS n FROM task_recovery_incidents WHERE state IN ('exhausted','interrupted') AND acknowledged=0")!.n),
    maxRetriesPerIncident: RECOVERY_LIMITS.maxRetriesPerIncident, maxRetriesPerTask: RECOVERY_LIMITS.maxRetriesPerTask};
  }
  handle(raw: unknown): TaskRecoveryState {
    const input = record(raw, ['type','id']);
    if (input.type === 'taskRecovery.state') {record(input, ['type']); return this.state();}
    if (input.type !== 'taskRecovery.acknowledge') throw new Error('Choose a supported recovery action.');
    record(input, ['type','id']);
    const id = identity(input.id), row = this.row('SELECT task_id FROM task_recovery_incidents WHERE id=?', id);
    if (!row) throw new Error('This recovery item no longer exists.');
    this.write('UPDATE task_recovery_incidents SET acknowledged=1 WHERE id=?', id);
    this.changed('recovery.acknowledged', String(row.task_id), id);
    return this.state();
  }
  runRead<T>(options: RecoveryRead<T>): Promise<T> {
    const work = this.execute(options);
    this.active.add(work);
    void work.then(() => this.active.delete(work), () => this.active.delete(work));
    return work;
  }
  private async wait(ms: number, signal: AbortSignal) {
    if (this.options.wait) return this.options.wait(ms, signal);
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason || new Error('Recovery stopped.'));
      const abort = () => {clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason || new Error('Recovery stopped.'));};
      const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve();}, ms);
      signal.addEventListener('abort', abort, {once: true});
    });
  }
  private async execute<T>(options: RecoveryRead<T>): Promise<T> {
    const taskId = identity(options.taskId), runId = identity(options.runId);
    if (options.operation !== 'browser_read') throw new Error('Only a fresh browser observation supports automatic recovery.');
    const signal = options.signal ? AbortSignal.any([options.signal, this.cancellation.signal]) : this.cancellation.signal;
    const check = () => {if (this.suspended || signal.aborted) throw signal.reason || new Error('Recovery stopped.'); options.check();};
    check();
    let lastError: unknown;
    try {const value = await options.read(); check(); return value;} catch (error) {check(); if (!recoverableReadCode(error)) throw error; lastError = error;}
    const code = recoverableReadCode(lastError)!, id = randomUUID();
    this.write("INSERT INTO task_recovery_incidents VALUES (?,?,?,'browser_read',?,'waiting',0,NULL,?,?,?,0)", id, taskId, runId, code, this.now(), this.now(), process.pid);
    this.changed('recovery.started', taskId, id);
    try {
      for (let attempt = 0; attempt < RECOVERY_LIMITS.maxRetriesPerIncident; attempt++) {
        check();
        // Reserve before waiting or invoking a callback. A crash never restores spent retry authority.
        const reserved = this.options.persistence.transaction(() => {
          const used = Number(this.row('SELECT COALESCE(sum(attempts),0) AS n FROM task_recovery_incidents WHERE task_id=?', taskId)!.n);
          if (used >= RECOVERY_LIMITS.maxRetriesPerTask) return false;
          this.write("UPDATE task_recovery_incidents SET attempts=attempts+1,state='waiting',next_attempt_at=?,updated_at=? WHERE id=?", this.now()+RECOVERY_LIMITS.delaysMs[attempt], this.now(), id);
          return true;
        });
        if (!reserved) break;
        await this.wait(RECOVERY_LIMITS.delaysMs[attempt], signal); check();
        this.write("UPDATE task_recovery_incidents SET state='retrying',next_attempt_at=NULL,updated_at=? WHERE id=?", this.now(), id);
        try {
          const value = await options.read(); check();
          this.write("UPDATE task_recovery_incidents SET state='recovered',updated_at=? WHERE id=?", this.now(), id);
          this.changed('recovery.succeeded', taskId, id); return value;
        } catch (error) {check(); lastError = error; if (!recoverableReadCode(error)) break;}
      }
      this.write("UPDATE task_recovery_incidents SET state='exhausted',next_attempt_at=NULL,updated_at=? WHERE id=?", this.now(), id);
      this.changed('recovery.exhausted', taskId, id);
    } catch (error) {
      this.write("UPDATE task_recovery_incidents SET state='cancelled',next_attempt_at=NULL,updated_at=? WHERE id=?", this.now(), id);
      this.changed('recovery.cancelled', taskId, id); throw error;
    }
    throw lastError;
  }
  async drain() {await Promise.allSettled([...this.active]);}
  async suspend() {this.suspended = true; this.cancellation.abort(new Error('Recovery stopped.')); await this.drain();}
  resume() {if (this.suspended) {this.cancellation = new AbortController(); this.suspended = false;}}
}
