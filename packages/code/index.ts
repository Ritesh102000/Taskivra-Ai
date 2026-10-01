import { randomUUID, createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type { Persistence } from '../persistence/index';
import type { ArtifactService } from '../artifacts/index';
import { ensureManagedDirectory } from '../artifacts/safe-io';
import type { CodeWorkspaceLease } from '../artifacts/code';
import type { RunClaim } from '../coordinator/index';
import { CODE_LIMITS, type CodeCommand, type CodeDependency, type CodeExecution, type CodeRuntimeStatus, type CodeState } from '../contracts/code';
import { parseCodeCommand, dependencyName } from '../contracts/code-validation';
import { DEFAULT_CODE_RESOURCES, unavailableCodeRuntime, type CodeHandle, type CodeRuntime } from './runtime';

type Row = Record<string, string | number | null>;
type ExecuteCommand = Extract<CodeCommand, { type: 'code.execute' }>;
type Active = { id: string; taskId: string; claim: RunClaim; origin: 'owner' | 'agent'; controller: AbortController; done: Promise<void>; handle?: CodeHandle; stopped: boolean; logBytes: number; stdout: string; stderr: string; lastFlush: number; timer?: ReturnType<typeof setInterval>; beforeDispatch?: () => void; preflightError?: unknown };
const live = "('preparing','running','exporting','stopping')";
const terminalTasks = new Set(['succeeded', 'failed', 'cancelled']);
const messages: Record<string, string> = {
  runtime_unavailable: 'Start Docker Desktop, run npm run code:setup, and refresh Activity.',
  code_runtime_setup_required: 'The code image is missing or incompatible. Run npm run code:setup and refresh Activity.',
  code_busy: 'One code execution can run at a time. Stop it or wait for it to finish.',
  code_fenced: 'This execution no longer owns the task. Uncommitted workspace changes were discarded.',
  execution_failed: 'The command failed. Its workspace changes were not saved; the previous revision is intact.',
  timeout: 'The execution reached its time limit. Its process tree was stopped and unsaved changes were discarded.',
  log_limit: 'The execution exceeded its log limit. Its process tree was stopped and unsaved changes were discarded.',
  oom: 'The execution exceeded its memory limit. Unsaved workspace changes were discarded.',
  stopped: 'Execution stopped. Uncommitted workspace changes were discarded.',
  runtime_lost: 'The execution container or connection was lost. The previous committed workspace is preserved.',
  export_failed: 'Workspace export could not be verified. No partial revision was committed.',
  owner_update_pending: 'A new task update arrived before code started. The earlier script was not run.',
  cleanup_failed: 'Container cleanup needs attention. Saved outputs remain available; start Docker Desktop and refresh before another execution.',
  storage_full: 'The application storage budget cannot fit this execution and its staging files. Increase the budget in Settings or choose smaller inputs.',
  workspace_busy: 'The task workspace is locked by another operation. Wait for it to finish before running code.',
};
export class CodeError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function fail(code: string, message = messages[code] || messages.execution_failed): never { throw new CodeError(code, message); }
function processAlive(pid: number): boolean { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function safeReason(cause: unknown, fallback: string): string {
  const value = cause && typeof cause === 'object' && 'code' in cause ? cause.code : cause instanceof Error ? cause.message : '';
  return typeof value === 'string' && Object.hasOwn(messages, value) ? value : fallback;
}
function boundedText(bytes: Uint8Array, limit: number): string {
  let value = Buffer.from(bytes).toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (Buffer.byteLength(value) > limit) value = new TextDecoder('utf-8').decode(Buffer.from(value).subarray(0, Math.max(0, limit - 3)));
  return value;
}

/** Sole trusted code broker: payload output is display data, never a command or status channel. */
export class CodeService {
  readonly ready: Promise<void>;
  private active = new Map<string, Active>();
  private stopped = false;
  private closing = false;
  private cleanupProblem = false;
  private runtimeStatus: CodeRuntimeStatus = { ready: false, message: 'Checking the code runtime.', imageDigest: null, packages: [] };
  constructor(private options: { persistence: Persistence; artifacts: ArtifactService; instanceId: string; assertTaskAllowed?:(taskId:string,args?:Omit<ExecuteCommand,'type'|'taskId'>)=>void; authorize: (claim: RunClaim) => void; runtime?: CodeRuntime; now?: () => number; onChanged?: () => void }) {
    this.ready = this.reconcile();
  }
  private get runtime() { return this.options.runtime || unavailableCodeRuntime; }
  private now() { return (this.options.now || Date.now)(); }
  private row(sql: string, ...values: SQLInputValue[]) { return this.options.persistence.db.prepare(sql).get(...values) as Row | undefined; }
  private rows(sql: string, ...values: SQLInputValue[]) { return this.options.persistence.db.prepare(sql).all(...values) as Row[]; }
  private write(sql: string, ...values: SQLInputValue[]) { this.options.persistence.db.prepare(sql).run(...values); }
  private transaction<T>(work: () => T): T { if (this.stopped) fail('closed', 'The execution service is closing.'); return this.options.persistence.transaction(work); }
  private changed() { if (!this.stopped) this.options.onChanged?.(); }
  private task(taskId: string): Row { const task = this.row('SELECT * FROM tasks WHERE id=?', taskId); if (!task) fail('not_found', 'Select an existing task.'); return task; }
  private event(type: string, taskId: string, payload: object) {
    this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)', type, taskId, Number(this.task(taskId).revision), JSON.stringify({ taskId, realCode: true, ...payload }), this.now());
  }
  private blocker(taskId: string): string | null {
    const request = this.row("SELECT type FROM input_requests WHERE task_id=? AND blocking=1 AND state NOT IN ('fulfilled','cancelled','superseded') LIMIT 1", taskId);
    if (request) return String(request.type);
    return this.row("SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? AND t.state<>'succeeded'", taskId) ? 'dependency' : null;
  }
  private transition(taskId: string, state: string, reason: string | null, fence = false) {
    const before = this.task(taskId);
    this.write('UPDATE tasks SET state=?,waiting_reason=?,revision=revision+1,generation=generation+?,updated_at=? WHERE id=?', state, reason, fence ? 1 : 0, this.now(), taskId);
    this.event('task.state_changed', taskId, { from: before.state, to: state, waitingReason: reason, generation: this.task(taskId).generation });
  }
  private async reconcile() {
    await this.options.artifacts.ready;
    try { await this.runtime.reconcile(); } catch { this.cleanupProblem = true; }
    if (this.stopped) return;
    this.transaction(() => {
      for (const execution of this.rows(`SELECT * FROM code_executions WHERE lifecycle IN ${live}`)) {
        if (processAlive(Number(execution.owner_pid))) continue;
        const committed = Boolean(execution.workspace_committed), state = committed ? 'succeeded' : 'interrupted';
        this.write('UPDATE code_executions SET lifecycle=?,reason=?,error=?,finished_at=?,owner_instance=NULL,owner_pid=NULL WHERE id=?', state, committed ? null : 'runtime_lost', committed ? null : messages.runtime_lost, this.now(), execution.id);
        this.write('UPDATE tool_calls SET state=?,finished_at=? WHERE id=?', committed ? 'succeeded' : 'outcome_unknown', this.now(), execution.tool_call_id);
        const tool = this.row('SELECT run_id FROM tool_calls WHERE id=?', execution.tool_call_id);
        if (tool) this.write("UPDATE runs SET state='interrupted',finished_at=?,lease_until=? WHERE id=? AND state='running'", this.now(), this.now(), tool.run_id);
        const task = this.task(String(execution.task_id));
        if (!terminalTasks.has(String(task.state))) this.transition(String(task.id), 'paused', this.blocker(String(task.id)), true);
        this.event('execution.recovered', String(task.id), { executionId: execution.id, workspaceCommitted: committed });
      }
    });
  }
  private async refreshRuntime() {
    if (this.cleanupProblem) {
      try { await this.runtime.reconcile(); this.cleanupProblem = false; } catch { this.runtimeStatus = { ready: false, message: messages.cleanup_failed, imageDigest: null, packages: [] }; return; }
    }
    try { this.runtimeStatus = await this.runtime.status(); } catch { this.runtimeStatus = { ready: false, message: messages.runtime_unavailable, imageDigest: null, packages: [] }; }
  }
  private execution(row: Row): CodeExecution {
    const nullable = (name: string) => row[name] === null ? null : Number(row[name]);
    const limits = JSON.parse(String(row.limits_json));
    return { id: String(row.id), taskId: String(row.task_id), agentId: String(row.agent_id), origin: row.origin as CodeExecution['origin'], runtime: row.runtime as CodeExecution['runtime'], source: String(row.source), command: (JSON.parse(String(row.argv)) as string[]).join(' '), cwd: '/workspace', lifecycle: row.lifecycle as CodeExecution['lifecycle'], imageDigest: row.image_digest ? String(row.image_digest) : null, timeoutSeconds: limits.timeoutSeconds, startedAt: Number(row.started_at), finishedAt: nullable('finished_at'), durationMs: nullable('duration_ms'), exitCode: nullable('exit_code'), error: row.error ? String(row.error) : null, reason: row.reason ? String(row.reason) : null, stdout: String(row.stdout), stderr: String(row.stderr), logsTruncated: Boolean(row.logs_truncated), inputs: JSON.parse(String(row.input_bindings)), workspaceCommitted: Boolean(row.workspace_committed), workspaceRevision: nullable('workspace_revision'), outputVersionIds: JSON.parse(String(row.output_version_ids)) };
  }
  private state(taskId: string): CodeState {
    const task = this.task(taskId);
    const executions = this.rows('SELECT * FROM code_executions WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 25', taskId).map(row => this.execution(row));
    const dependencies: CodeDependency[] = this.rows('SELECT d.*,i.revision,i.state FROM code_dependencies d JOIN input_requests i ON i.id=d.request_id WHERE i.task_id=? ORDER BY i.created_at', taskId).map(row => ({ requestId: String(row.request_id), revision: Number(row.revision), runtime: row.runtime as 'python' | 'node', packageName: String(row.package_name), version: row.version ? String(row.version) : null, reason: String(row.reason), state: row.state as CodeDependency['state'] }));
    return { taskId, agentId: String(task.agent_id), executions, inputs: this.options.artifacts.codeInputManifest(taskId), workspaceRevision: this.options.artifacts.latestCodeRevision(taskId), activeExecutionId: executions.find(ex => ['preparing', 'running', 'exporting', 'stopping'].includes(ex.lifecycle))?.id || null, runtime: this.runtimeStatus, dependencies };
  }
  async handle(raw: unknown): Promise<CodeState> {
    const command = parseCodeCommand(raw); await this.ready;
    if (this.stopped || this.closing) fail('closed', 'The execution service is closing.');
    this.task(command.taskId);
    if (command.type === 'code.state') await this.refreshRuntime();
    else if (command.type === 'code.execute') await this.start(command);
    else if (command.type === 'code.stop') await this.stop(command.taskId, command.executionId);
    else if (command.type === 'code.requestDependency') {this.options.assertTaskAllowed?.(command.taskId);this.requestDependency(command);}
    else if (command.type === 'code.resolveDependency') await this.resolveDependency(command);
    return this.state(command.taskId);
  }
  /** Internal tool entry. Identity and run are supplied by the authenticated coordinator. */
  async executeForAgent(claim: RunClaim, input: Omit<ExecuteCommand, 'type' | 'taskId'>, beforeDispatch?: () => void): Promise<CodeExecution> {
    await this.ready;
    if (this.stopped || this.closing) fail('closed', 'The execution service is closing.');
    this.options.authorize(claim);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['runtime', 'source', 'timeoutSeconds', 'inputVersionIds'].includes(key))) fail('permission_denied', 'Agent execution arguments cannot supply identity or ownership.');
    const command = parseCodeCommand({ ...input, type: 'code.execute', taskId: claim.taskId }) as ExecuteCommand;
    const executionId = await this.start(command, claim, beforeDispatch); const entry = this.active.get(executionId);
    if (entry) await entry.done;
    if (entry?.preflightError) throw entry.preflightError;
    if (this.stopped) fail('closed', 'The execution service is closing.');
    return this.execution(this.row('SELECT * FROM code_executions WHERE id=?', executionId)!);
  }
  private ownerClaim(task: Row): RunClaim {
    if (terminalTasks.has(String(task.state))) fail('invalid_state', 'Finished tasks cannot start new code. Create another task.');
    if (this.blocker(String(task.id))) fail('missing_input', 'Resolve this task’s open requests before running code.');
    const previous = this.row("SELECT * FROM runs WHERE agent_id=? AND state='running'", task.agent_id);
    if (previous) {
      if (previous.task_id !== task.id || previous.worker_id !== this.options.instanceId) fail('code_busy', 'Another run owns this agent. Pause that task before starting a manual execution.');
      this.write("UPDATE runs SET state='interrupted',finished_at=?,lease_until=? WHERE id=?", this.now(), this.now(), previous.id);
      this.write("UPDATE tool_calls SET state='outcome_unknown',finished_at=? WHERE run_id=? AND state IN ('planned','dispatched')", this.now(), previous.id);
    }
    this.transition(String(task.id), 'running', null, true);
    const runId = randomUUID(), workerId = randomUUID(), generation = Number(this.task(String(task.id)).generation), leaseUntil = this.now() + 15_000;
    const attempt = Number(this.row('SELECT COALESCE(MAX(attempt),0)+1 AS n FROM runs WHERE task_id=?', task.id)!.n);
    this.write("INSERT INTO runs(id,task_id,agent_id,attempt,worker_id,lease_until,fencing_generation,checkpoint,state,created_at) VALUES (?,?,?,?,?,?,?,?,'running',?)", runId, task.id, task.agent_id, attempt, workerId, leaseUntil, generation, JSON.stringify({ step: task.checkpoint, mode: 'owner-code' }), this.now());
    return { runId, taskId: String(task.id), agentId: String(task.agent_id), workerId, generation, leaseUntil };
  }
  private assertCurrent(entry: Active) {
    if (this.stopped || entry.stopped || entry.controller.signal.aborted) fail('code_fenced');
    this.options.authorize(entry.claim);
    const row = this.row('SELECT * FROM code_executions WHERE id=?', entry.id);
    if (!row || row.owner_instance !== this.options.instanceId || !['preparing', 'running', 'exporting'].includes(String(row.lifecycle))) fail('code_fenced');
  }
  private async start(command: ExecuteCommand, authenticated?: RunClaim, beforeDispatch?: () => void): Promise<string> {
    if (this.stopped || this.closing) fail('closed', 'The execution service is closing.');
    const scopeArgs={runtime:command.runtime,source:command.source,timeoutSeconds:command.timeoutSeconds,inputVersionIds:command.inputVersionIds};
    // Check actual mounted inputs for owner and agent entry points before touching a runtime.
    this.options.assertTaskAllowed?.(command.taskId,scopeArgs);
    await this.refreshRuntime();
    if (!this.runtimeStatus.ready) fail('runtime_unavailable', this.runtimeStatus.message || messages.runtime_unavailable);
    // The reservation is owned by the file service's crash-recoverable staging journal.
    const reserved = await this.options.artifacts.reserveExternal('code-execution', 4 * CODE_LIMITS.logBytes + 2 * CODE_LIMITS.sourceBytes);
    let entry: Active;
    try {
      entry = this.transaction(() => {
        if (this.closing) fail('closed', 'The execution service is closing.');
        if (this.row(`SELECT 1 FROM code_executions WHERE lifecycle IN ${live}`)) fail('code_busy');
        if (Number(this.row('SELECT COUNT(*) AS n FROM code_executions')!.n) >= CODE_LIMITS.executions) fail('capacity_limit', 'The saved execution limit was reached. Existing files and controls remain available.');
        const task = this.task(command.taskId);
        if (authenticated) this.options.authorize(authenticated);
        this.options.assertTaskAllowed?.(command.taskId,scopeArgs);
        beforeDispatch?.();
        const inputs = this.options.artifacts.codeInputManifest(command.taskId, command.inputVersionIds);
        if (authenticated && command.inputVersionIds.some(versionId => !this.row('SELECT 1 FROM run_artifact_bindings WHERE run_id=? AND version_id=?', authenticated.runId, versionId))) fail('permission_denied', 'This file version was not pinned when the agent run started. Start a fresh run to accept new inputs.');
        const claim = authenticated || this.ownerClaim(task), executionId = randomUUID(), toolId = randomUUID();
        const extension = command.runtime === 'python' ? 'py' : command.runtime === 'node' ? 'js' : 'sh';
        const path = `/workspace/work/.aw-execution-${executionId}.${extension}`;
        const argv = command.runtime === 'python' ? ['python3', '-I', path] : command.runtime === 'node' ? ['node', path] : ['/bin/sh', path];
        const limits = { ...DEFAULT_CODE_RESOURCES, timeoutSeconds: command.timeoutSeconds };
        this.write("INSERT INTO tool_calls(id,run_id,generation,tool_name,args_ref,state,idempotency_key,created_at) VALUES (?,?,?,'code.execute',?,'planned',?,?)", toolId, claim.runId, claim.generation, JSON.stringify({ runtime: command.runtime, sourceSha256: createHash('sha256').update(command.source).digest('hex'), inputVersionIds: command.inputVersionIds }), `code:${executionId}`, this.now());
        this.write(`INSERT INTO code_executions(id,tool_call_id,image_digest,argv,cwd,limits_json,lifecycle,task_id,agent_id,owner_instance,owner_pid,origin,runtime,source,started_at,input_bindings) VALUES (?,?,?,?,?,?,'preparing',?,?,?,?,?,?,?,?,?)`, executionId, toolId, '', JSON.stringify(argv), '/workspace', JSON.stringify(limits), task.id, task.agent_id, this.options.instanceId, process.pid, authenticated ? 'agent' : 'owner', command.runtime, command.source, this.now(), JSON.stringify(inputs));
        if (!authenticated) for (const versionId of command.inputVersionIds) this.write('INSERT INTO run_artifact_bindings(run_id,version_id) VALUES (?,?)', claim.runId, versionId);
        this.event('execution.preparing', command.taskId, { executionId, runtime: command.runtime, inputVersionIds: command.inputVersionIds });
        return { id: executionId, taskId: command.taskId, claim, origin: authenticated ? 'agent' as const : 'owner' as const, controller: new AbortController(), done: Promise.resolve(), stopped: false, logBytes: 0, stdout: '', stderr: '', lastFlush: 0, beforeDispatch };
      });
    } catch (cause) { await reserved(); throw cause; }
    this.active.set(entry.id, entry);
    entry.timer = setInterval(() => {
      try { this.transaction(() => { this.assertCurrent(entry); this.write('UPDATE runs SET lease_until=? WHERE id=?', this.now() + 15_000, entry.claim.runId); }); }
      catch { entry.stopped = true; entry.controller.abort(); void entry.handle?.stop().catch(() => {}); }
    }, 1000);
    entry.done = this.run(entry, command, reserved).catch(() => { /* run records bounded failure and closes resources. */ });
    this.changed(); return entry.id;
  }
  private log(entry: Active, stream: 'stdout' | 'stderr', bytes: Uint8Array) {
    if (this.stopped || entry.stopped) return;
    const value = boundedText(bytes, CODE_LIMITS.logBytes - entry.logBytes);
    entry[stream] += value; entry.logBytes += Buffer.byteLength(value);
    if (Date.now() - entry.lastFlush > 250) this.flush(entry);
  }
  private flush(entry: Active) {
    if (this.stopped) return;
    this.write('UPDATE code_executions SET stdout=?,stderr=? WHERE id=? AND owner_instance=?', entry.stdout, entry.stderr, entry.id, this.options.instanceId);
    entry.lastFlush = Date.now(); this.changed();
  }
  /** Internal decision fence only before execution. Completed code is never automatically replayed. */
  private preflight(entry: Active) {
    try { entry.beforeDispatch?.(); } catch (error) { entry.preflightError = error; throw error; }
  }
  private async run(entry: Active, command: ExecuteCommand, reserved: (() => Promise<void>) & { directory: string }) {
    let lease: CodeWorkspaceLease | undefined, reason: string | null = null, outcomeExit: number | null = null;
    let exportReservation: ((() => Promise<void>) & { directory: string }) | undefined;
    try {
      this.assertCurrent(entry);
      lease = await this.options.artifacts.beginCodeWorkspace({ taskId: entry.taskId, agentId: entry.claim.agentId, executionId: entry.id, versionIds: command.inputVersionIds, assertCurrent: () => this.assertCurrent(entry) });
      this.assertCurrent(entry);
      const row = this.row('SELECT * FROM code_executions WHERE id=?', entry.id)!;
      const argv = JSON.parse(String(row.argv)) as string[], sourcePath = join(reserved.directory, 'source');
      const script = await open(sourcePath, 'wx', 0o600);
      try { await script.writeFile(command.source); await script.sync(); } finally { await script.close(); }
      const source = Buffer.from(command.source);
      this.assertCurrent(entry);this.preflight(entry);
      entry.handle = await this.runtime.launch({ executionId: entry.id, taskId: entry.taskId, agentId: entry.claim.agentId, signal: entry.controller.signal, limits: { ...DEFAULT_CODE_RESOURCES, timeoutSeconds: command.timeoutSeconds }, files: [...lease.files, { area: 'workspace', path: argv[argv.length - 1].slice('/workspace/'.length), sourcePath, bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') }] });
      this.assertCurrent(entry);this.preflight(entry);
      this.transaction(() => { this.assertCurrent(entry); this.write("UPDATE code_executions SET lifecycle='running',image_digest=? WHERE id=?", entry.handle!.info.imageDigest, entry.id); this.write("UPDATE tool_calls SET state='dispatched' WHERE id=?", row.tool_call_id); this.event('execution.started', entry.taskId, { executionId: entry.id, imageDigest: entry.handle!.info.imageDigest }); });
      this.changed();
      const outcome = await entry.handle.run({ argv, cwd: '/workspace', signal: entry.controller.signal, onLog: (stream, bytes) => this.log(entry, stream, bytes) });
      outcomeExit = outcome.exitCode;
      if (!this.stopped) this.write('UPDATE code_executions SET exit_code=?,duration_ms=?,logs_truncated=? WHERE id=?', outcome.exitCode, outcome.durationMs, outcome.logsTruncated ? 1 : 0, entry.id);
      this.assertCurrent(entry);
      if (outcome.reason !== 'exited' || outcome.exitCode !== 0) { reason = outcome.reason === 'exited' ? 'execution_failed' : outcome.reason; return; }
      this.transaction(() => { this.assertCurrent(entry); this.write("UPDATE code_executions SET lifecycle='exporting' WHERE id=?", entry.id); this.event('execution.exporting', entry.taskId, { executionId: entry.id }); });
      this.changed();
      exportReservation = await this.options.artifacts.reserveExternal('code-execution', CODE_LIMITS.workspaceBytes);
      this.assertCurrent(entry);
      const destination = join(exportReservation.directory, 'export');
      await ensureManagedDirectory(this.options.persistence.dataRoot, relative(this.options.persistence.dataRoot, destination));
      const exported = await entry.handle.export({ destination, signal: entry.controller.signal });
      this.assertCurrent(entry);
      await lease.commit(exported, { assertCurrent: () => this.assertCurrent(entry), onCommit: receipt => {
        this.write('UPDATE code_executions SET workspace_committed=1,workspace_revision=?,output_version_ids=? WHERE id=?', receipt.revision, JSON.stringify(receipt.outputVersionIds), entry.id);
      } });
    } catch (cause) { reason = entry.stopped || entry.controller.signal.aborted ? 'stopped' : safeReason(cause, 'export_failed'); }
    finally {
      if (entry.timer) clearInterval(entry.timer);
      try { await entry.handle?.close(); } catch { this.cleanupProblem = true; reason ||= 'cleanup_failed'; }
      try { await lease?.release(); } catch { reason ||= 'export_failed'; }
      if (!this.stopped) {
        this.flush(entry);
        this.transaction(() => {
          const row = this.row('SELECT * FROM code_executions WHERE id=?', entry.id)!;
          const committed = Boolean(row.workspace_committed);
          if (entry.stopped) reason = 'stopped';
          // A commit receipt is authoritative even if subsequent staging cleanup was interrupted.
          if (committed && reason === 'export_failed') reason = null;
          const lifecycle = entry.stopped ? 'cancelled' : committed && !reason ? 'succeeded' : 'failed';
          this.write('UPDATE code_executions SET lifecycle=?,reason=?,error=?,finished_at=?,duration_ms=COALESCE(duration_ms,?),owner_instance=NULL,owner_pid=NULL WHERE id=?', lifecycle, reason, reason ? messages[reason] || messages.execution_failed : null, this.now(), this.now() - Number(row.started_at), entry.id);
          this.write('UPDATE tool_calls SET state=?,result_ref=?,finished_at=? WHERE id=?', lifecycle === 'succeeded' ? 'succeeded' : 'failed', JSON.stringify({ executionId: entry.id, workspaceCommitted: committed, outputVersionIds: JSON.parse(String(row.output_version_ids)) }), this.now(), row.tool_call_id);
          const task = this.task(entry.taskId);
          if (entry.origin === 'owner' || (lifecycle !== 'succeeded' && !entry.preflightError)) {
            this.write("UPDATE runs SET state=?,finished_at=?,lease_until=? WHERE id=? AND state='running'", entry.stopped ? 'cancelled' : lifecycle === 'succeeded' ? 'paused' : 'failed', this.now(), this.now(), entry.claim.runId);
            if (!terminalTasks.has(String(task.state)) && ['running', 'pausing', 'recovering'].includes(String(task.state))) this.transition(entry.taskId, 'paused', this.blocker(entry.taskId), true);
          }
          this.event('execution.finished', entry.taskId, { executionId: entry.id, lifecycle, exitCode: row.exit_code, workspaceCommitted: committed, workspaceRevision: row.workspace_revision, outputVersionIds: JSON.parse(String(row.output_version_ids)) });
          if (reason === 'execution_failed' && outcomeExit !== 0 && !terminalTasks.has(String(this.task(entry.taskId).state))) this.inferMissingDependency(entry, command);
        });
      }
      await exportReservation?.().catch(() => {});
      await reserved().catch(() => {});
      this.active.delete(entry.id);
      this.changed();
    }
  }
  private async stop(taskId: string, executionId: string) {
    const row = this.row('SELECT * FROM code_executions WHERE id=? AND task_id=?', executionId, taskId);
    if (!row) fail('not_found', 'That execution does not belong to this task.');
    if (!['preparing', 'running', 'exporting', 'stopping'].includes(String(row.lifecycle))) return;
    const entry = this.active.get(executionId);
    if (!entry) fail('code_busy', 'Another coordinator owns this execution. Close it before retrying.');
    entry.stopped = true; entry.controller.abort();
    this.transaction(() => {
      this.write("UPDATE code_executions SET lifecycle='stopping' WHERE id=?", executionId);
      const task = this.task(taskId);
      if (!terminalTasks.has(String(task.state))) this.transition(taskId, 'paused', this.blocker(taskId), true);
      this.write("UPDATE runs SET state='cancelled',finished_at=?,lease_until=? WHERE id=? AND state='running'", this.now(), this.now(), entry.claim.runId);
      this.event('execution.stopping', taskId, { executionId });
    });
    this.changed(); await entry.handle?.stop().catch(() => {});
  }
  async stopForTask(taskId: string): Promise<void> {
    for (const entry of this.active.values()) if (entry.taskId === taskId) await this.stop(taskId, entry.id);
  }
  /** A checkpoint must wait for runtime cleanup, workspace leases and reservations, not only the stop signal. */
  async stopAndDrain(taskId?: string): Promise<void> {
    const entries = [...this.active.values()].filter(entry => taskId === undefined || entry.taskId === taskId);
    const stopped = await Promise.allSettled(entries.map(entry => this.stop(entry.taskId, entry.id)));
    await Promise.allSettled(entries.map(entry => entry.done));
    const failure = stopped.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  private requestDependency(command: Extract<CodeCommand, { type: 'code.requestDependency' }>) {
    this.transaction(() => {
      if (this.row(`SELECT 1 FROM code_executions WHERE task_id=? AND lifecycle IN ${live}`, command.taskId)) fail('code_busy', 'Stop the active execution before requesting an image change.');
      this.createDependency(command.taskId, command.runtime, command.packageName, command.version, command.reason, true);
    }); this.changed();
  }
  private createDependency(taskId: string, runtime: 'python' | 'node', packageName: string, version: string | null, reason: string, required = false) {
    const task = this.task(taskId);
    if (terminalTasks.has(String(task.state))) fail('invalid_state', 'This task is finished.');
    const previous = this.row("SELECT d.request_id,d.version,i.revision FROM code_dependencies d JOIN input_requests i ON i.id=d.request_id WHERE i.task_id=? AND d.runtime=? AND d.package_name=? AND i.state='open'", taskId, runtime, packageName);
    if (previous) {
      // Only an explicit owner request can pin or replace a version. Repeated
      // observations must never loosen an existing exact package requirement.
      if (required && version !== null && previous.version !== version) {
        const revision = Number(previous.revision) + 1;
        this.write('UPDATE code_dependencies SET version=?,reason=? WHERE request_id=?', version, reason, previous.request_id);
        this.write('UPDATE input_requests SET revision=?,reason=? WHERE id=?', revision, reason, previous.request_id);
        this.event('input.requested', taskId, { requestId: previous.request_id, runtime, packageName, version, revision, updated: true, capabilityGranted: false });
      }
      return;
    }
    if (Number(this.row('SELECT COUNT(*) AS n FROM code_dependencies d JOIN input_requests i ON i.id=d.request_id WHERE i.task_id=?', taskId)!.n) >= CODE_LIMITS.dependencies) {
      if (required) fail('capacity_limit', 'This task has reached its eight saved dependency requests. Existing requests can still be checked.');
      return;
    }
    const requestId = randomUUID();
    this.write("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?,'permission_change',?,?,'open',?,?)", requestId, taskId, `Code dependency: ${packageName}`, reason, `code-dependency:${requestId}`, this.now());
    this.write('INSERT INTO code_dependencies(request_id,runtime,package_name,version,reason) VALUES (?,?,?,?,?)', requestId, runtime, packageName, version, reason);
    this.write("UPDATE runs SET state='waiting',finished_at=?,lease_until=? WHERE task_id=? AND state='running'", this.now(), this.now(), taskId);
    this.transition(taskId, task.state === 'paused' ? 'paused' : 'waiting', 'permission_change', true);
    this.event('input.requested', taskId, { requestId, runtime, packageName, version, capabilityGranted: false });
  }
  private inferMissingDependency(entry: Active, command: ExecuteCommand) {
    if (command.runtime === 'shell') return;
    const match = command.runtime === 'python' ? /ModuleNotFoundError: No module named ['"]([A-Za-z0-9_.-]+)['"]/.exec(entry.stderr) : /(?:Cannot find (?:module|package)) ['"]((?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)['"]/.exec(entry.stderr);
    if (!match) return;
    try {
      const name = dependencyName(match[1], command.runtime);
      // Logs may suggest a request, but cannot install a package, pick a version, or grant access.
      this.createDependency(entry.taskId, command.runtime, name, null, 'The command reported a missing import. Confirm its registry package and exact version in a reviewed runtime recipe, build the image, then check the request. Code-job networking stays disabled.');
    } catch { /* Invalid payload strings never become dependency controls. */ }
  }
  private async resolveDependency(command: Extract<CodeCommand, { type: 'code.resolveDependency' }>) {
    await this.refreshRuntime();
    this.transaction(() => {
      const row = this.row('SELECT d.*,i.task_id,i.state,i.revision FROM code_dependencies d JOIN input_requests i ON i.id=d.request_id WHERE d.request_id=?', command.requestId);
      if (!row || row.task_id !== command.taskId) fail('not_found', 'That dependency request does not belong to this task.');
      if (row.state === 'fulfilled') return;
      if (row.state !== 'open' || Number(row.revision) !== command.revision) fail('stale_revision', 'Refresh the dependency request before checking it.');
      const task = this.task(command.taskId);
      if (terminalTasks.has(String(task.state))) fail('invalid_state', 'This task is finished.');
      const normalize = (name: string) => row.runtime === 'python' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;
      const installed = this.runtimeStatus.ready && this.runtimeStatus.packages.find(p => p.runtime === row.runtime && normalize(p.name) === normalize(String(row.package_name)) && (!row.version || p.version === row.version));
      if (!installed) fail('dependency_missing', 'The selected code image does not contain this requested package and version. Build the reviewed runtime recipe first, then check again.');
      const revision = Number(row.revision) + 1;
      this.write("UPDATE input_requests SET state='fulfilled',revision=?,response=?,response_revision=? WHERE id=?", revision, `Verified ${installed.name} ${installed.version} in ${this.runtimeStatus.imageDigest}`, command.revision, command.requestId);
      this.write('INSERT INTO resume_receipts(request_id,fulfillment_revision,continuation_key,created_at) SELECT id,?,continuation_key,? FROM input_requests WHERE id=?', revision, this.now(), command.requestId);
      this.transition(command.taskId, task.state === 'paused' ? 'paused' : this.blocker(command.taskId) ? 'waiting' : 'queued', this.blocker(command.taskId));
      this.event('input.fulfilled', command.taskId, { requestId: command.requestId, packageName: installed.name, version: installed.version, imageDigest: this.runtimeStatus.imageDigest });
    }); this.changed();
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.closing = true;
    await this.stopAndDrain();
    await this.runtime.close(); this.stopped = true;
  }
  abandon(): void {
    if (this.stopped) return;
    this.closing = true;
    for (const entry of this.active.values()) {
      entry.stopped = true; entry.controller.abort(); if (entry.timer) clearInterval(entry.timer);
      this.transaction(() => {
        const execution = this.row('SELECT * FROM code_executions WHERE id=?', entry.id)!;
        const committed = Boolean(execution.workspace_committed);
        this.write('UPDATE code_executions SET lifecycle=?,reason=?,error=?,finished_at=?,owner_instance=NULL,owner_pid=NULL WHERE id=?', committed ? 'succeeded' : 'interrupted', committed ? null : 'runtime_lost', committed ? null : messages.runtime_lost, this.now(), entry.id);
        this.write('UPDATE tool_calls SET state=?,finished_at=? WHERE id=?', committed ? 'succeeded' : 'outcome_unknown', this.now(), execution.tool_call_id);
        this.write("UPDATE runs SET state='interrupted',finished_at=?,lease_until=? WHERE id=? AND state='running'", this.now(), this.now(), entry.claim.runId);
        const task = this.task(entry.taskId);
        if (!terminalTasks.has(String(task.state))) this.transition(entry.taskId, 'paused', this.blocker(entry.taskId), true);
        this.event('execution.interrupted', entry.taskId, { executionId: entry.id, workspaceCommitted: committed });
      });
      void entry.handle?.stop().catch(() => {});
    }
    this.stopped = true;
  }
}
