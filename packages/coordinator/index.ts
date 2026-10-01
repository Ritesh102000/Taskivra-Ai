import type {LocalLabPort} from '../local-lab';
import {FleetService,FleetError} from '../fleet';
import {SecurityReviewService,SecurityReviewError} from '../security-review';
import {TaskRecoveryService} from '../task-recovery';
import type {ProviderModelOption} from '../contracts/model-providers';
import {DocumentService} from '../documents';
import {BrowserActionService} from '../browser-actions';
import {RoutineService} from '../routines';
import {ProjectsService} from '../projects';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type { Agent, Command, DomainEvent, InputRequest, Settings, Snapshot, Task, TaskMessage, TaskState } from '../contracts/index';
import { parseCommand } from '../contracts/validation';
import { Persistence, privateDirectory, SCHEMA_VERSION } from '../persistence/index';
import { ArtifactService } from '../artifacts/index';
import type { ArtifactFaultPoint } from '../artifacts/index';
import { BrowserService } from '../browser/index';
import type { BrowserRuntime } from '../browser/runtime';
import { CodeService } from '../code/index';
import type { CodeRuntime } from '../code/runtime';
import type {GmailService} from '../gmail';
import {AgentLoop} from '../agent-loop';
import {RequestService} from '../requests';
import {CollaborationService} from '../collaboration';
import {WorkflowService} from '../workflows';
import {ResultService} from '../results';
import {ReadinessService} from '../readiness';
import {RecoveryService} from '../recovery';
import type {ModelAdapter} from '../model-adapters/types';
import type {LiveCommand} from '../contracts/live';

export const LEASE_MS = 15_000;
export const CAPACITY = { agents: 100, tasks: 250, messages: 2_000, ownerMessagesPerTask: 100, ownerMessageBytes: 4 * 1024 * 1024, snapshotEvents: 500 } as const;
export class CoordinatorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'CoordinatorError'; this.code = code; }
}
export interface RunClaim { runId: string; taskId: string; agentId: string; workerId: string; generation: number; leaseUntil: number }
export type SyntheticTool = 'simulation.observe' | 'simulation.request' | 'simulation.summarize' | 'simulation.complete' | 'simulation.fail';
export interface SyntheticResult { toolCallId: string; taskId: string; tool: SyntheticTool; checkpoint: number; state: TaskState; replayed: boolean }
type Row = Record<string, string | number | null>;
const terminal = new Set<TaskState>(['succeeded', 'failed', 'cancelled']);
const tools = new Set<SyntheticTool>(['simulation.observe', 'simulation.request', 'simulation.summarize', 'simulation.complete', 'simulation.fail']);

/** Sole domain writer. Simulation stays separate from the explicit isolated browser service. */
export class Coordinator {
  readonly instanceId = randomUUID();
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly artifacts: ArtifactService;
  readonly browser: BrowserService;
  readonly code: CodeService;
  readonly requests: RequestService;
  readonly collaboration: CollaborationService;
  readonly live: AgentLoop;
  readonly workflows: WorkflowService;
  readonly results: ResultService;
  readonly readiness: ReadinessService;
  readonly recovery: RecoveryService;
  readonly routines: RoutineService;
  readonly projects: ProjectsService;
  readonly browserActions: BrowserActionService;
  readonly documents: DocumentService;
  readonly taskRecovery: TaskRecoveryService;
  readonly securityReviews: SecurityReviewService;
  readonly fleets: FleetService;
  readonly localLab?: LocalLabPort;
  readonly gmail?: GmailService;
  private readonly persistence: Persistence;
  private readonly now: () => number;
  private closed = false;
  private maintenance = false;
  private verifiedProjectGmail:string|null=null;
  private verifiedProjectGoogle:string|null=null;
  get maintenanceActive(): boolean { return this.maintenance; }

  constructor({ dataRoot, now = Date.now, artifactFault, browserRuntime, onBrowserChanged, codeRuntime, onCodeChanged, modelAdapter, modelResolver, modelCatalog, onLiveChanged, onRequestsChanged, onCollaborationChanged, gmail, localLab }: { dataRoot: string; now?: () => number; artifactFault?: (point: ArtifactFaultPoint) => void; browserRuntime?: BrowserRuntime; onBrowserChanged?: () => void; codeRuntime?: CodeRuntime; onCodeChanged?: () => void; modelAdapter?:ModelAdapter; modelResolver?:(selection:string)=>ModelAdapter; modelCatalog?:()=>ProviderModelOption[]; onLiveChanged?:()=>void; onRequestsChanged?:()=>void; onCollaborationChanged?:()=>void; gmail?:GmailService; localLab?:LocalLabPort }) {
    this.localLab=localLab;
    this.now = now;
    this.gmail=gmail;
    this.persistence = new Persistence(dataRoot, now());
    this.dataRoot = this.persistence.dataRoot;
    this.databasePath = this.persistence.databasePath;
    this.recoverExpiredRuns();
    // Reconcile deterministic private directories after a previous interrupted setup.
    for (const agent of this.rows('SELECT id FROM agents')) this.agentDirectory(String(agent.id));
    for (const task of this.rows('SELECT id,agent_id FROM tasks')) this.taskDirectory(String(task.agent_id), String(task.id));
    this.artifacts = new ArtifactService({ persistence: this.persistence, now, fault: artifactFault });
    this.securityReviews=new SecurityReviewService({persistence:this.persistence,artifacts:this.artifacts,createTask:(command,callback)=>this.createLiveTask(command,callback),validateModel:selection=>this.live.validateModel(selection),now});
    this.fleets=new FleetService({persistence:this.persistence,artifacts:this.artifacts,
      createTask:(command,callback)=>this.createLiveTask(command,callback),
      createAgent:(projectId,name,instructions)=>{
        if(Number(this.row('SELECT COUNT(*) AS count FROM agents')!.count)>=CAPACITY.agents)throw new CoordinatorError('capacity_limit','The saved agent limit is reached.');
        const id=randomUUID();this.agentDirectory(id);
        this.write('INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES (?,?,?,?,?)',id,name,instructions,randomUUID(),this.now());
        this.write('INSERT INTO browser_sessions(id,agent_id) VALUES (?,?)',randomUUID(),id);
        this.projects.assignNewAgent(id,projectId);this.event('agent.created',id,1,{name});return id;
      },validateModel:selection=>this.live.validateModel(selection),modelReadiness:async selection=>(await this.live.modelReadiness(selection)).credentialConfigured,
      startTask:async taskId=>{await this.live.handle({type:'live.start',taskId});},
      pauseTask:taskId=>this.controlFleetTask(taskId,'pause'),stopTask:taskId=>this.controlFleetTask(taskId,'cancel'),
      authorize:claim=>this.authorizeRun(claim),startLab:localLab?()=>localLab.start():undefined,labStatus:localLab?()=>localLab.status():undefined,closeLabBrowser:taskId=>this.browser?.stopForTask(taskId)||Promise.resolve(),now,onChanged:()=>{onLiveChanged?.();this.live?.tick();}});
    this.browser = new BrowserService({persistence:this.persistence,artifacts:this.artifacts,instanceId:this.instanceId,assertTaskAllowed:taskId=>{this.securityReviews.assertToolAllowed(taskId,'browser_open',{});this.fleets.assertToolAllowed(taskId,'browser_open',{});},authorize:claim=>{this.securityReviews.assertToolAllowed(claim.taskId,'browser_open',{});this.fleets.assertToolAllowed(claim.taskId,'browser_open',{});this.authorizeTool(claim);},runtime:browserRuntime,now,onChanged:()=>{this.live?.browserChanged();onBrowserChanged?.();}});
    this.code = new CodeService({persistence:this.persistence,artifacts:this.artifacts,instanceId:this.instanceId,assertTaskAllowed:(taskId,args)=>{this.securityReviews.assertToolAllowed(taskId,'code_execute',args||{});this.fleets.assertToolAllowed(taskId,'code_execute',args||{});},authorize:claim=>{this.securityReviews.assertToolAllowed(claim.taskId,'code_execute',{});this.fleets.assertToolAllowed(claim.taskId,'code_execute',{});this.authorizeRun(claim);},runtime:codeRuntime,now,onChanged:onCodeChanged});
    this.documents=new DocumentService({code:this.code,artifacts:this.artifacts,authorize:claim=>this.authorizeRun(claim)});
    this.requests=new RequestService({persistence:this.persistence,artifacts:this.artifacts,authorize:claim=>this.authorizeRun(claim),now,onChanged:onRequestsChanged,applyCapability:(taskId,capability)=>this.live.grantCapability(taskId,capability)});
    this.collaboration=new CollaborationService({persistence:this.persistence,artifacts:this.artifacts,authorize:claim=>this.authorizeRun(claim),now,onChanged:onCollaborationChanged});
    this.taskRecovery=new TaskRecoveryService({persistence:this.persistence,now,onChanged:onLiveChanged});
    this.live=new AgentLoop({persistence:this.persistence,coordinator:this,requests:this.requests,adapter:modelAdapter,modelResolver,modelCatalog,now,onChanged:()=>{onLiveChanged?.();this.fleets.tick();}});
    this.workflows=new WorkflowService({persistence:this.persistence,artifacts:this.artifacts,assertReuseSource:taskId=>this.assertReviewSource(taskId),createTask:(command,callback)=>this.createLiveTask(command,callback),validateModel:selection=>this.live.validateModel(selection),now});
    this.results=new ResultService({persistence:this.persistence,artifacts:this.artifacts,assertRevisionSource:taskId=>this.assertReviewSource(taskId),canReviseSource:taskId=>!this.securityReviews.isReviewTask(taskId)&&!this.fleets.isFleetTask(taskId),createTask:(command,callback)=>this.createLiveTask(command,callback),validateModel:selection=>this.live.validateModel(selection),now});
    this.readiness=new ReadinessService({now,ports:{
      resolve:target=>this.workflows.readinessRequirements(target),
      projectAccounts:agentId=>{const id=this.projects.agent(agentId);return{gmail:this.projects.gmailAccount(id),googleWorkspace:this.projects.googleWorkspaceAccount(id)};},
      model:async selection=>this.live.modelReadiness(selection),
      ...(browserRuntime?{browser:(agentId:string)=>browserRuntime.status(agentId)}:{}),
      ...(codeRuntime?{code:()=>codeRuntime.status()}:{}),
      ...(gmail?{gmail:()=>gmail.status()}:{}),
    }});
    this.browserActions=new BrowserActionService({persistence:this.persistence,browser:this.browser,authorize:claim=>this.authorizeRun(claim),now,onDecision:taskId=>{this.transact(()=>{const task=this.requiredTask(taskId),reason=this.blockingReason(taskId);if(task.state==='waiting'&&!reason)this.transition(taskId,'queued');});this.live.tick();},onChanged:onBrowserChanged});
    this.routines=new RoutineService({persistence:this.persistence,artifacts:this.artifacts,assertReuseSource:taskId=>this.assertReviewSource(taskId),now,createTask:(command,callback)=>this.createLiveTask(command,callback),preflight:async id=>{await this.workflows.assertInputsReady(id);const check=await this.readiness.handle({type:'readiness.check',target:{kind:'task',taskId:id}});if(check.status==='needs_attention')throw new CoordinatorError('missing_input','Review setup before running.');},start:id=>this.live.handle({type:'live.start',taskId:id})});
    this.projects=new ProjectsService({persistence:this.persistence,now,verifiedGmailAccount:()=>this.verifiedProjectGmail,verifiedGoogleWorkspaceAccount:()=>this.verifiedProjectGoogle,createAgent:input=>{
      if(Number(this.row('SELECT COUNT(*) AS count FROM agents')!.count)>=CAPACITY.agents)throw new CoordinatorError('capacity_limit','The saved agent limit is reached.');
      const id=randomUUID();this.agentDirectory(id);this.write('INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES (?,?,?,?,?)',id,input.name,input.instructions,randomUUID(),this.now());this.write('INSERT INTO browser_sessions(id,agent_id) VALUES (?,?)',randomUUID(),id);this.event('agent.created',id,1,{name:input.name});return id;
    }});
    this.recovery=new RecoveryService({persistence:this.persistence,appVersion:'0.9.9',withQuiesced:work=>this.withQuiesced(work)});

  }

  private controlFleetTask(taskId:string,action:'pause'|'cancel'){
    this.transact(()=>{const task=this.requiredTask(taskId);if(terminal.has(task.state as TaskState))return;if(action==='pause')this.pause(taskId);else this.cancel(taskId);});
    this.live.onOwnerCommand(action==='pause'?'tasks.pause':'tasks.cancel',taskId);
  }

  private assertReviewSource(taskId:string){if(this.fleets.isFleetTask(taskId))throw new FleetError('fleet_scope','Start a new fleet to change its selected evidence. A fleet task cannot become an unrestricted task or routine.');if(this.securityReviews.isReviewTask(taskId))throw new SecurityReviewError('security_review_scope','Prepare a new Security Review to change its evidence or repeat the review. Its fixed scope cannot become a general task or routine.');}

  async handleProjects(raw:unknown,googleAccount?:()=>Promise<string|null>){
    this.verifiedProjectGmail=null;this.verifiedProjectGoogle=null;
    if(this.gmail){const state=await this.gmail.status();if(!state.error&&!state.connecting)this.verifiedProjectGmail=this.gmail.verifiedConnectedAccount();}
    if(googleAccount)this.verifiedProjectGoogle=await googleAccount();
    if(this.maintenance)throw new CoordinatorError('maintenance_busy','Wait for recovery to finish.');
    const result=this.projects.handle(raw);void this.live.gmailChanged();return result;
  }

  private ensureOpen(): void { if (this.closed) throw new CoordinatorError('closed', 'The coordinator is closed.'); }
  private row(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.persistence.db.prepare(sql).get(...values) as Row | undefined; }
  private rows(sql: string, ...values: SQLInputValue[]): Row[] { return this.persistence.db.prepare(sql).all(...values) as Row[]; }
  private write(sql: string, ...values: SQLInputValue[]): void { this.persistence.db.prepare(sql).run(...values); }
  private transact<T>(callback: () => T): T { this.ensureOpen(); return this.persistence.transaction(callback); }
  private requiredTask(id: string): Row {
    const task = this.row('SELECT * FROM tasks WHERE id=?', id);
    if (!task) throw new CoordinatorError('not_found', 'The selected task no longer exists.');
    return task;
  }
  private event(type: string, aggregateId: string, revision: number, payload: Record<string, unknown> = {}): void {
    this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)', type, aggregateId, revision, JSON.stringify({ simulation: this.row('SELECT execution_mode FROM tasks WHERE id=?',aggregateId)?.execution_mode!=='live', ...payload }), this.now());
  }
  private message(taskId: string, role: TaskMessage['role'], content: string, deliveryState?: TaskMessage['deliveryState']): void {
    if (role === 'owner') {
      const counts = this.row("SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes FROM task_messages WHERE role='owner'")!;
      const taskCount = this.row("SELECT COUNT(*) AS count FROM task_messages WHERE role='owner' AND task_id=?", taskId)!;
      if (Number(counts.count) >= CAPACITY.messages || Number(taskCount.count) >= CAPACITY.ownerMessagesPerTask || Number(counts.bytes) + Buffer.byteLength(content) > CAPACITY.ownerMessageBytes) {
        throw new CoordinatorError('capacity_limit', 'The Phase 1 conversation limit was reached. Existing tasks can still be paused or cancelled.');
      }
    }
    // Generated messages occur only at the finite simulation steps, never per timer.
    const id = randomUUID();
    this.write('INSERT INTO task_messages(id,task_id,role,content,created_at,delivery_state) VALUES (?,?,?,?,?,?)', id, taskId, role, content, this.now(), deliveryState ?? null);
    this.event('message.created', taskId, Number(this.requiredTask(taskId).revision), { messageId: id, role });
  }
  private agentDirectory(agentId: string): string {
    const path = join(this.dataRoot, 'private', agentId);
    privateDirectory(path); privateDirectory(join(path, 'workspace')); privateDirectory(join(path, 'workspace', 'tasks'));
    return path;
  }
  private taskDirectory(agentId: string, taskId: string): void {
    const root = join(this.agentDirectory(agentId), 'workspace', 'tasks', taskId);
    privateDirectory(root);
    for (const name of ['inputs', 'work', 'outputs']) privateDirectory(join(root, name));
  }
  private hasBlockers(taskId: string): boolean {
    return Boolean(this.row("SELECT 1 FROM input_requests WHERE task_id=? AND blocking=1 AND state NOT IN ('fulfilled','cancelled','superseded') LIMIT 1", taskId))
      || Boolean(this.row("SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? AND (t.state<>'succeeded' OR (d.required_artifact_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.id=d.required_artifact_version AND v.status='ready' AND a.visibility='shared' AND a.producer_task_id=t.id))) LIMIT 1", taskId));
  }
  private blockingReason(taskId: string): string | null {
    const revisionBlocker=this.fleets?.blockingReason(taskId)||this.securityReviews?.blockingReason(taskId)||this.results?.blockingReason(taskId)||this.routines?.blockingReason(taskId)||this.browserActions?.blockingReason(taskId);if(revisionBlocker)return revisionBlocker;
    const request = this.row("SELECT type FROM input_requests WHERE task_id=? AND blocking=1 AND state NOT IN ('fulfilled','cancelled','superseded') ORDER BY created_at,id LIMIT 1", taskId);
    return request ? String(request.type) : this.collaboration?.dependencyBlocker(taskId) ?? (this.hasBlockers(taskId) ? 'dependency' : null);
  }
  private transition(taskId: string, state: TaskState, waitingReason: string | null = null, fence = false): void {
    const previous = this.requiredTask(taskId);
    this.write('UPDATE tasks SET state=?,waiting_reason=?,revision=revision+1,generation=generation+?,updated_at=? WHERE id=?', state, waitingReason, fence ? 1 : 0, this.now(), taskId);
    const task = this.requiredTask(taskId);
    this.event('task.state_changed', taskId, Number(task.revision), { from: previous.state, to: state, waitingReason, generation: task.generation });
  }
  private finishRun(runId: string, state: string): void {
    this.write('UPDATE runs SET state=?,finished_at=?,lease_until=? WHERE id=? AND state=\'running\'', state, this.now(), this.now(), runId);
  }
  private settings(): Settings {
    const row = this.row('SELECT * FROM settings WHERE id=1')!;
    return { theme: row.theme as Settings['theme'], driverEnabled: Boolean(row.driver_enabled), maxActiveAgents: Number(row.max_active_agents) };
  }

  handle(raw: Command): Snapshot {
    this.ensureOpen();
    const command = parseCommand(raw);
    if (command.type === 'snapshot') return this.snapshot();
    if(this.maintenance)throw new CoordinatorError('maintenance_busy','The workspace is saving a recovery checkpoint. Wait for it to finish.');
    if (command.type === 'simulation.step') { this.advance(true); return this.snapshot(); }
    this.transact(() => {
      switch (command.type) {
        case 'agents.create': {
          if (Number(this.row('SELECT COUNT(*) AS count FROM agents')!.count) >= CAPACITY.agents) throw new CoordinatorError('capacity_limit', 'Phase 1 supports up to 100 saved agents.');
          const id = randomUUID(), workspaceId = randomUUID();
          this.agentDirectory(id);
          this.write('INSERT INTO agents(id,name,instructions,workspace_id,created_at) VALUES (?,?,?,?,?)', id, command.name, command.instructions, workspaceId, this.now());
          this.write('INSERT INTO browser_sessions(id,agent_id) VALUES (?,?)', randomUUID(), id);
          this.event('agent.created', id, 1, { name: command.name });
          break;
        }
        case 'tasks.create': {
          if (!this.row('SELECT id FROM agents WHERE id=? AND enabled=1', command.agentId)) throw new CoordinatorError('not_found', 'Select an enabled agent.');
          if (Number(this.row('SELECT COUNT(*) AS count FROM tasks')!.count) >= CAPACITY.tasks) throw new CoordinatorError('capacity_limit', 'Phase 1 supports up to 250 saved tasks.');
          const id = randomUUID();
          this.taskDirectory(command.agentId, id);
          this.write("INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?,?)", id, command.agentId, command.objective, command.completionCriteria, command.scenario, this.now(), this.now());
          this.event('task.created', id, 1, { agentId: command.agentId, scenario: command.scenario });
          this.message(id, 'owner', command.objective);
          this.message(id, 'system', 'Simulation task queued. Automatic task progress does not call a model. The Browser panel opens a live browser; Activity lets you explicitly run code in an isolated container.');
          break;
        }
        case 'tasks.message': {
          const task = this.requiredTask(command.taskId);
          const live = task.execution_mode === 'live';
          if (live) {
            if (terminal.has(task.state as TaskState)) throw new CoordinatorError('invalid_state', 'This task has finished. Create a follow-up task for more work.');
            // Keep the complete update history in model context; never silently drop an older correction.
            const updates = this.rows("SELECT content FROM task_messages WHERE task_id=? AND delivery_state IS NOT NULL ORDER BY rowid", command.taskId).map(row => String(row.content));
            if (Buffer.byteLength(JSON.stringify([...updates, command.content])) > 24 * 1024) throw new CoordinatorError('capacity_limit', 'This task has reached its saved update limit. Existing updates are kept; create a follow-up task for additional instructions.');
          }
          this.message(command.taskId, 'owner', command.content, live ? 'pending' : undefined);
          break;
        }
        case 'tasks.pause': this.pause(command.taskId); break;
        case 'tasks.resume': this.resume(command.taskId); break;
        case 'tasks.cancel': this.cancel(command.taskId); break;
        case 'requests.respond': this.respond(command.requestId, command.revision, command.response); break;
        case 'settings.update': {
          const previous = this.settings(), next = { ...previous, ...command.settings };
          if (JSON.stringify(previous) === JSON.stringify(next)) break;
          // A lower slot cap applies to future claims; active work remains bounded.
          this.write('UPDATE settings SET theme=?,driver_enabled=?,max_active_agents=? WHERE id=1', next.theme, next.driverEnabled ? 1 : 0, next.maxActiveAgents);
          this.event('settings.updated', 'settings', 1, next);
          break;
        }
      }
    });
    if(command.type==='tasks.pause'||command.type==='tasks.cancel'||command.type==='tasks.resume')this.live.onOwnerCommand(command.type,command.taskId);
    if(command.type==='tasks.pause'||command.type==='tasks.cancel') {
      void this.browser.stopForTask(command.taskId).catch(()=>{});
      void this.code.stopForTask(command.taskId).catch(()=>{});
    }
    return this.snapshot();
  }

  /** Internal creation path used only after strict live-command validation. */
  createLiveTask(command:Extract<LiveCommand,{type:'live.createTask'}>,onCreated?:(taskId:string)=>void):string {
    return this.transact(()=>{
      if(!this.row('SELECT id FROM agents WHERE id=? AND enabled=1',command.agentId))throw new CoordinatorError('not_found','Select an enabled agent.');
      if(Number(this.row('SELECT COUNT(*) AS count FROM tasks')!.count)>=CAPACITY.tasks)throw new CoordinatorError('capacity_limit','The saved task limit was reached.');
      const taskId=randomUUID();this.taskDirectory(command.agentId,taskId);
      this.write("INSERT INTO tasks(id,agent_id,objective,state,completion_criteria,scenario,execution_mode,created_at,updated_at) VALUES (?,?,?,'paused',?,'complete','live',?,?)",taskId,command.agentId,command.objective,command.completionCriteria,this.now(),this.now());
      this.event('task.created',taskId,1,{agentId:command.agentId,simulation:false});this.message(taskId,'owner',command.objective);this.message(taskId,'system','Live task prepared. Start explicitly to use the selected model connection, tools and task budget.');
      this.write('INSERT INTO live_task_config(task_id,model,policy_json,limits_json,created_at,updated_at) VALUES (?,?,?,?,?,?)',taskId,command.model,JSON.stringify(command.policy),JSON.stringify(command.limits),this.now(),this.now());
      this.event('live.task_configured',taskId,1,{model:command.model,limits:command.limits,policy:command.policy,simulation:false});
      onCreated?.(taskId);return taskId;
    });
  }

  private pause(taskId: string): void {
    const task = this.requiredTask(taskId);
    if (task.state === 'paused' || task.state === 'pausing') return;
    if (terminal.has(task.state as TaskState)) throw new CoordinatorError('invalid_state', 'A finished task cannot be paused.');
    this.transition(taskId, task.state === 'running' ? 'pausing' : 'paused', this.blockingReason(taskId), true);
  }
  private resume(taskId: string): void {
    const task = this.requiredTask(taskId);
    if (task.state === 'queued' || task.state === 'waiting' || task.state === 'running') return;
    if (task.state !== 'paused') throw new CoordinatorError('invalid_state', 'Wait for the pause checkpoint before resuming.');
    const preparation = this.fleets?.blockingReason(taskId)||this.securityReviews?.blockingReason(taskId)||this.results?.blockingReason(taskId)||this.routines?.blockingReason(taskId);
    if(preparation)throw new CoordinatorError('invalid_state',preparation);
    const reason = this.blockingReason(taskId);
    this.transition(taskId, reason ? 'waiting' : 'queued', reason);
  }
  private cancel(taskId: string): void {
    const task = this.requiredTask(taskId);
    if (task.state === 'cancelled') return;
    if (terminal.has(task.state as TaskState)) throw new CoordinatorError('invalid_state', 'The task has already finished.');
    this.transition(taskId, 'cancelled', null, true);
    const active = this.row("SELECT id FROM runs WHERE task_id=? AND state='running'", taskId);
    if (active) this.finishRun(String(active.id), 'cancelled');
    this.write("UPDATE tool_calls SET state='outcome_unknown',finished_at=? WHERE run_id IN (SELECT id FROM runs WHERE task_id=?) AND state IN ('planned','dispatched')", this.now(), taskId);
    for (const request of this.rows("SELECT * FROM input_requests WHERE task_id=? AND state NOT IN ('fulfilled','cancelled','superseded')", taskId)) {
      this.write("UPDATE input_requests SET state='cancelled',revision=revision+1 WHERE id=?", request.id);
      this.event('input.cancelled', String(request.id), Number(request.revision) + 1, { taskId });
    }
  }
  private respond(requestId: string, revision: number, response: string): void {
    const request = this.row('SELECT * FROM input_requests WHERE id=?', requestId);
    if (!request) throw new CoordinatorError('not_found', 'The selected request no longer exists.');
    if(request.type!=='clarification')throw new CoordinatorError('invalid_state','Complete this request using its browser, file, or dependency controls.');
    const taskId = String(request.task_id), task = this.requiredTask(taskId);
    if (terminal.has(task.state as TaskState) || request.state === 'cancelled') throw new CoordinatorError('invalid_state', 'This task is closed; its request cannot restart it.');
    if (request.state === 'fulfilled' && request.response_revision === revision && request.response === response) return;
    if (request.revision !== revision || request.state !== 'open') throw new CoordinatorError('stale_revision', 'This request changed. Refresh it before answering.');
    this.message(taskId, 'owner', response);
    const fulfilledRevision = revision + 1;
    this.write("UPDATE input_requests SET state='fulfilled',revision=?,response=?,response_revision=? WHERE id=?", fulfilledRevision, response, revision, requestId);
    this.event('input.owner_replied', requestId, fulfilledRevision, { taskId });
    this.write('INSERT INTO resume_receipts(request_id,fulfillment_revision,continuation_key,created_at) VALUES (?,?,?,?)', requestId, fulfilledRevision, request.continuation_key, this.now());
    this.event('input.fulfilled', requestId, fulfilledRevision, { taskId });
    const preparation = this.fleets?.blockingReason(taskId)||this.securityReviews?.blockingReason(taskId)||this.results?.blockingReason(taskId)||this.routines?.blockingReason(taskId);
    if(preparation)throw new CoordinatorError('invalid_state',preparation);
    const reason = this.blockingReason(taskId);
    if (task.state === 'waiting' && !reason) this.transition(taskId, 'queued');
    else if (task.state === 'paused') {
      this.write('UPDATE tasks SET waiting_reason=?,revision=revision+1,updated_at=? WHERE id=?', reason, this.now(), taskId);
      this.event('task.blockers_changed', taskId, Number(this.requiredTask(taskId).revision), { waitingReason: reason });
    }
  }

  /** Atomic SQLite claim. A second connection cannot claim the same task/agent. */
  claimNext(workerId = this.instanceId, mode:'simulation'|'live'='simulation', excludedAgentIds:string[]=[]): RunClaim | null {
    if(this.maintenance)return null;
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(workerId)) throw new CoordinatorError('invalid_worker', 'Worker identity is invalid.');
    if(!Array.isArray(excludedAgentIds)||excludedAgentIds.length>CAPACITY.agents||excludedAgentIds.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(value)))throw new CoordinatorError('invalid_worker','Busy agent identities are invalid.');
    this.collaboration.reconcile();
    this.browserActions?.reconcile();
    return this.transact(() => {
      this.recoverLocked();
      const active = Number(this.row("SELECT (SELECT COUNT(*) FROM runs WHERE state='running')+(SELECT COUNT(*) FROM request_replan_jobs WHERE state='running' AND lease_until>?) AS count",this.now())!.count);
      if (active >= this.settings().maxActiveAgents) return null;
      const task = this.rows(`SELECT t.* FROM tasks t JOIN agents a ON a.id=t.agent_id
        WHERE t.state='queued' AND a.enabled=1 AND t.execution_mode=?
        AND NOT EXISTS(SELECT 1 FROM security_review_members sm WHERE sm.task_id=t.id AND sm.preparation<>'ready')
        AND NOT EXISTS(SELECT 1 FROM routine_occurrences ro WHERE ro.task_id=t.id AND ro.state IN ('preparing','blocked'))
        AND NOT EXISTS(SELECT 1 FROM browser_action_proposals ba WHERE ba.task_id=t.id AND (ba.state IN ('pending','dispatching') OR (ba.state='outcome_unknown' AND ba.resolution_json IS NULL)))
        AND t.agent_id NOT IN (SELECT value FROM json_each(?))
        AND (t.execution_mode='simulation' OR EXISTS(SELECT 1 FROM live_task_config l WHERE l.task_id=t.id AND l.enabled=1))
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.agent_id=t.agent_id AND r.state='running')
        AND NOT EXISTS (SELECT 1 FROM request_replan_jobs j JOIN input_requests i ON i.id=j.request_id JOIN tasks rt ON rt.id=i.task_id WHERE rt.agent_id=t.agent_id AND j.state='running' AND j.lease_until>?)
        AND NOT EXISTS (SELECT 1 FROM code_executions c WHERE c.agent_id=t.agent_id AND c.lifecycle IN ('preparing','running','exporting','stopping'))
        AND NOT EXISTS (SELECT 1 FROM browser_sessions b WHERE b.agent_id=t.agent_id AND b.lifecycle IN ('starting','ready','closing') AND (b.task_id<>t.id OR b.controller IN ('human','transitioning')))
        AND NOT EXISTS (SELECT 1 FROM result_revision_jobs j WHERE j.task_id=t.id AND j.state<>'ready')
        AND NOT EXISTS (SELECT 1 FROM input_requests i WHERE i.task_id=t.id AND i.blocking=1 AND i.state NOT IN ('fulfilled','cancelled','superseded'))
        AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks parent ON parent.id=d.depends_on_task_id WHERE d.task_id=t.id AND (parent.state<>'succeeded' OR (d.required_artifact_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.id=d.required_artifact_version AND v.status='ready' AND a.visibility='shared' AND a.producer_task_id=parent.id))))
        ORDER BY t.created_at,t.id`,mode,JSON.stringify(excludedAgentIds),this.now()).find(candidate=>!this.fleets||this.fleets.canClaim(String(candidate.id)));
      if (!task) return null;
      this.transition(String(task.id), 'running', null, true);
      const generation = Number(task.generation) + 1, runId = randomUUID(), leaseUntil = this.now() + LEASE_MS;
      const attempt = Number(this.row('SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM runs WHERE task_id=?', task.id)!.attempt);
      this.write("INSERT INTO runs(id,task_id,agent_id,attempt,worker_id,lease_until,fencing_generation,checkpoint,state,created_at) VALUES (?,?,?,?,?,?,?,?,'running',?)", runId, task.id, task.agent_id, attempt, workerId, leaseUntil, generation, JSON.stringify({ step: task.checkpoint }), this.now());
      this.write('INSERT INTO run_artifact_bindings(run_id,version_id) SELECT ?,version_id FROM task_artifacts WHERE task_id=?',runId,task.id);
      this.event('run.claimed', runId, generation, { taskId: task.id, agentId: task.agent_id, workerId, checkpoint: task.checkpoint });
      return { runId, taskId: String(task.id), agentId: String(task.agent_id), workerId, generation, leaseUntil };
    });
  }

  /** Broker guard only. executeSyntheticTool repeats it inside the write transaction. */
  authorizeTool(claim: RunClaim, tool: SyntheticTool = 'simulation.observe'): void {
    this.ensureOpen();
    if (!tools.has(tool)) throw new CoordinatorError('permission_denied', 'Only authenticated fixed simulation tools are available.');
    this.authorizeRun(claim);
    if(this.row("SELECT 1 FROM code_executions WHERE agent_id=? AND lifecycle IN ('preparing','running','exporting','stopping')",claim.agentId))throw new CoordinatorError('conflict','Wait for the active code execution before another tool.');
  }

  /** Internal run identity guard; each real service validates its own tool surface. */
  authorizeRun(claim: RunClaim): void {
    this.ensureOpen();
    if (!claim || ![claim.runId,claim.taskId,claim.agentId,claim.workerId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)) || !Number.isSafeInteger(claim.generation)) throw new CoordinatorError('permission_denied', 'An authenticated current run is required.');
    const run = this.row('SELECT r.*,t.agent_id AS task_agent_id,t.state AS task_state,t.generation AS task_generation FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?', claim.runId);
    if (!run || run.task_id !== claim.taskId || run.agent_id !== claim.agentId || run.task_agent_id !== claim.agentId || run.worker_id !== claim.workerId || run.fencing_generation !== claim.generation || run.task_generation !== claim.generation || run.state !== 'running' || run.task_state !== 'running') {
      throw new CoordinatorError('stale_generation', 'This worker no longer owns the running task.');
    }
    if (Number(run.lease_until) <= this.now()) throw new CoordinatorError('lease_expired', 'This worker lease expired before the action.');
    const fleetBlocker=this.fleets?.blockingReason(claim.taskId);if(fleetBlocker)throw new CoordinatorError('permission_denied',fleetBlocker);
  }

  renewLease(claim: RunClaim): RunClaim {
    return this.transact(() => {
      this.authorizeRun(claim);
      const leaseUntil = this.now() + LEASE_MS;
      this.write('UPDATE runs SET lease_until=? WHERE id=?', leaseUntil, claim.runId);
      return { ...claim, leaseUntil };
    });
  }

  private expectedTool(task: Row): SyntheticTool {
    switch (Number(task.checkpoint)) {
      case 0: return 'simulation.observe';
      case 1: return task.scenario === 'clarification' ? 'simulation.request' : task.scenario === 'failure' ? 'simulation.fail' : 'simulation.summarize';
      case 2: return task.scenario === 'clarification' ? 'simulation.summarize' : 'simulation.complete';
      case 3: if (task.scenario === 'clarification') return 'simulation.complete';
    }
    throw new CoordinatorError('invalid_state', 'The simulation has no remaining step.');
  }

  /** Fixed synthetic effects are committed with their receipt/checkpoint/events. */
  executeSyntheticTool(claim: RunClaim, tool: SyntheticTool, idempotencyKey = `simulation:${claim.taskId}:${tool}`): SyntheticResult {
    return this.transact(() => {
      this.authorizeTool(claim, tool);
      if (idempotencyKey !== `simulation:${claim.taskId}:${tool}`) throw new CoordinatorError('permission_denied', 'The simulation receipt must match its task and fixed step.');
      const receipt = this.row('SELECT c.* FROM tool_calls c JOIN runs r ON r.id=c.run_id WHERE c.idempotency_key=? AND r.task_id=? AND c.tool_name=?', idempotencyKey, claim.taskId, tool);
      if (receipt) {
        if (receipt.state !== 'succeeded' || !receipt.result_ref) throw new CoordinatorError('outcome_unknown', 'This action needs reconciliation before replay.');
        return { ...JSON.parse(String(receipt.result_ref)) as SyntheticResult, replayed: true };
      }
      const task = this.requiredTask(claim.taskId);
      if (this.expectedTool(task) !== tool) throw new CoordinatorError('invalid_state', 'The requested simulation step is out of order.');
      const toolCallId = randomUUID(), checkpoint = Number(task.checkpoint) + 1;
      this.write("INSERT INTO tool_calls(id,run_id,generation,tool_name,args_ref,state,idempotency_key,created_at) VALUES (?,?,?,?,?,'planned',?,?)", toolCallId, claim.runId, claim.generation, tool, '{}', idempotencyKey, this.now());
      this.event('tool.planned', toolCallId, claim.generation, { taskId: claim.taskId, tool });
      this.write("UPDATE tool_calls SET state='dispatched' WHERE id=?", toolCallId);
      this.write('UPDATE tasks SET checkpoint=?,revision=revision+1,updated_at=? WHERE id=?', checkpoint, this.now(), claim.taskId);
      this.write('UPDATE runs SET checkpoint=?,lease_until=? WHERE id=?', JSON.stringify({ step: checkpoint, lastTool: tool }), this.now() + LEASE_MS, claim.runId);
      switch (tool) {
        case 'simulation.observe': this.message(claim.taskId, 'agent', 'Simulation: reviewed the task and saved the first checkpoint. No website or local input file was accessed.'); break;
        case 'simulation.request': {
          const requestId = randomUUID();
          this.write("INSERT INTO input_requests(id,task_id,type,title,reason,state,continuation_key,created_at) VALUES (?,?,'clarification',?,?,'open',?,?)", requestId, claim.taskId, 'Choose the focus of this simulated result', 'What should the result emphasize? Your reply tests durable waiting and resuming; it does not call a model.', `simulation:${claim.taskId}:clarification`, this.now());
          this.message(claim.taskId, 'agent', 'Simulation: I need your preferred focus before continuing. Your progress is saved while this clarification is open.');
          this.event('input.requested', requestId, 1, { taskId: claim.taskId, agentId: claim.agentId });
          this.finishRun(claim.runId, 'waiting');
          this.transition(claim.taskId, 'waiting', 'clarification', true);
          break;
        }
        case 'simulation.summarize': this.message(claim.taskId, 'agent', task.scenario === 'clarification' ? 'Simulation: accepted your saved clarification and prepared the final step.' : 'Simulation: prepared the final step and saved another checkpoint.'); break;
        case 'simulation.complete':
          this.message(claim.taskId, 'agent', 'Simulation completed. Task state, conversation, checkpoints, and any clarification were saved. This is a lifecycle demonstration; no real deliverable or external action was produced.');
          this.finishRun(claim.runId, 'succeeded'); this.transition(claim.taskId, 'succeeded', null, true); break;
        case 'simulation.fail':
          this.message(claim.taskId, 'agent', 'Simulation stopped at the intentional failure checkpoint. No external work was attempted. Create another simulation task to try a different scenario.');
          this.finishRun(claim.runId, 'failed'); this.transition(claim.taskId, 'failed', 'simulation_failure', true); break;
      }
      const current = this.requiredTask(claim.taskId);
      const result: SyntheticResult = { toolCallId, taskId: claim.taskId, tool, checkpoint, state: current.state as TaskState, replayed: false };
      this.write("UPDATE tool_calls SET state='succeeded',result_ref=?,finished_at=? WHERE id=?", JSON.stringify(result), this.now(), toolCallId);
      this.event('tool.succeeded', toolCallId, claim.generation, { taskId: claim.taskId, tool, checkpoint });
      return result;
    });
  }

  private recoverLocked(ownWorker?: string): number {
    const runs = ownWorker
      ? this.rows("SELECT r.*,t.state AS task_state FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.state='running' AND r.worker_id=?", ownWorker)
      : this.rows("SELECT r.*,t.state AS task_state FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.state='running' AND r.lease_until<=?", this.now());
    for (const run of runs) {
      const taskId = String(run.task_id), paused = run.task_state === 'pausing'||this.requiredTask(String(run.task_id)).execution_mode==='live';
      this.finishRun(String(run.id), 'interrupted');
      this.write("UPDATE tool_calls SET state='outcome_unknown',finished_at=? WHERE run_id=? AND state IN ('planned','dispatched')", this.now(), run.id);
      if (terminal.has(run.task_state as TaskState)) continue;
      this.transition(taskId, 'recovering', null, true);
      const preparation = this.fleets?.blockingReason(taskId)||this.securityReviews?.blockingReason(taskId)||this.results?.blockingReason(taskId)||this.routines?.blockingReason(taskId);
    if(preparation)throw new CoordinatorError('invalid_state',preparation);
    const reason = this.blockingReason(taskId);
      this.transition(taskId, paused ? 'paused' : reason ? 'waiting' : 'queued', reason);
      this.event('run.recovered', String(run.id), Number(this.requiredTask(taskId).generation), { taskId, cause: ownWorker ? 'coordinator_closed' : 'lease_expired', checkpoint: this.requiredTask(taskId).checkpoint });
    }
    return runs.length;
  }
  recoverExpiredRuns(): number { return this.transact(() => this.recoverLocked()); }

  private claimFromRow(run: Row): RunClaim {
    return { runId: String(run.id), taskId: String(run.task_id), agentId: String(run.agent_id), workerId: String(run.worker_id), generation: Number(run.fencing_generation), leaseUntil: Number(run.lease_until) };
  }
  private advance(force: boolean): void {
    this.transact(() => {
      this.recoverLocked();
      for (const run of this.rows("SELECT r.*,t.state AS task_state FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.state='running' AND r.worker_id=?", this.instanceId)) {
        if (run.task_state === 'pausing') {
          this.finishRun(String(run.id), 'paused');
          this.transition(String(run.task_id), 'paused', this.blockingReason(String(run.task_id)));
        } else this.write('UPDATE runs SET lease_until=? WHERE id=?', this.now() + LEASE_MS, run.id);
      }
    });
    if (!force && !this.settings().driverEnabled) return;
    for (const run of this.rows("SELECT * FROM runs WHERE state='running' AND worker_id=? ORDER BY created_at,id", this.instanceId)) {
      if(this.row("SELECT 1 FROM code_executions WHERE agent_id=? AND lifecycle IN ('preparing','running','exporting','stopping')",run.agent_id))continue;
      if(this.row("SELECT 1 FROM browser_sessions WHERE agent_id=? AND lifecycle IN ('starting','ready','closing') AND controller IN ('human','transitioning')",run.agent_id))continue;
      this.executeSyntheticTool(this.claimFromRow(run), this.expectedTool(this.requiredTask(String(run.task_id))));
    }
    while (this.claimNext()) { /* Atomic claims enforce global and per-agent capacity. */ }
  }
  tick(): void { if(this.maintenance)return;this.advance(false);this.fleets.tick();this.live.tick(); }

  snapshot(): Snapshot {
    this.ensureOpen();
    return this.persistence.readTransaction(() => this.readSnapshot());
  }
  private readSnapshot(): Snapshot {
    const agents: Agent[] = this.rows('SELECT * FROM agents ORDER BY created_at,id').map(row => ({ id: String(row.id), name: String(row.name), instructions: String(row.instructions), workspaceId: String(row.workspace_id), enabled: Boolean(row.enabled), createdAt: Number(row.created_at) }));
    const tasks: Task[] = this.rows('SELECT * FROM tasks ORDER BY created_at,id').map(row => ({ id: String(row.id), executionMode:row.execution_mode as 'simulation'|'live', agentId: String(row.agent_id), objective: String(row.objective), completionCriteria: String(row.completion_criteria), state: row.state as TaskState, revision: Number(row.revision), waitingReason: row.waiting_reason === null ? null : String(row.waiting_reason), scenario: row.scenario as Task['scenario'], checkpoint: Number(row.checkpoint), generation: Number(row.generation), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
    const messages: TaskMessage[] = this.rows('SELECT * FROM task_messages ORDER BY created_at,rowid').map(row => ({ id: String(row.id), taskId: String(row.task_id), role: row.role as TaskMessage['role'], content: String(row.content), createdAt: Number(row.created_at), ...(row.delivery_state ? {deliveryState: row.delivery_state as TaskMessage['deliveryState'], ...(row.incorporated_at !== null ? {incorporatedAt: Number(row.incorporated_at)} : {})} : {}) }));
    const requests: InputRequest[] = this.rows("SELECT i.*,t.agent_id FROM input_requests i JOIN tasks t ON t.id=i.task_id WHERE i.type IN ('files','clarification','browser_handoff','permission_change') ORDER BY i.created_at,i.id").map(row => ({ id: String(row.id), taskId: String(row.task_id), agentId: String(row.agent_id), type: row.type as InputRequest['type'], title: String(row.title), reason: String(row.reason), state: row.state as InputRequest['state'], revision: Number(row.revision), response: row.response === null ? null : String(row.response), createdAt: Number(row.created_at) }));
    const events: DomainEvent[] = this.rows(`SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ${CAPACITY.snapshotEvents}) ORDER BY id`).map(row => ({ id: Number(row.id), type: String(row.type), aggregateId: String(row.aggregate_id), aggregateRevision: Number(row.aggregate_revision), payload: JSON.parse(String(row.payload)), createdAt: Number(row.created_at) }));
    return { agents, tasks, messages, requests, events, settings: this.settings(), runtime: { mode: tasks.some(t=>t.executionMode==='live')?(tasks.some(t=>t.executionMode==='simulation')?'mixed':'live'):'simulation', dataRoot: this.dataRoot, schemaVersion: SCHEMA_VERSION }, artifacts:this.artifacts.all(),taskArtifacts:this.artifacts.bindings(),workspaceSnapshots:this.artifacts.snapshots(),storage:this.artifacts.storage() };
  }

  /** Freeze work before a consistent backup or system sleep. Resumption is explicit. */
  async withQuiesced<T>(work:()=>Promise<T>):Promise<T> {
    this.ensureOpen();
    if(this.maintenance)throw new CoordinatorError('maintenance_busy','A recovery operation is already in progress.');
    this.maintenance=true;
    try {
      const taskIds=this.rows('SELECT id FROM tasks').map(row=>String(row.id));
      // Start runtime stops before awaiting workers that may be waiting on those runtimes.
      const stops=await Promise.allSettled([this.fleets.suspend(),this.live.suspend(),this.taskRecovery.suspend(),this.securityReviews.suspend(),this.routines.suspend(),this.code.stopAndDrain(),...taskIds.map(id=>this.browser.stopForTask(id))]);
      await this.browserActions.drain();
      await this.results.drain();
      await this.requests.drainValidations();
      await this.artifacts.drain();
      this.transact(()=>{
        this.routines.pauseAll();
        this.write('UPDATE settings SET driver_enabled=0 WHERE id=1');
        this.write('UPDATE live_task_config SET enabled=0,updated_at=?',this.now());
        for(const row of this.rows("SELECT id,state FROM tasks WHERE state IN ('queued','running','pausing','recovering')")){
          this.write("UPDATE runs SET state='interrupted',finished_at=?,lease_until=? WHERE task_id=? AND state='running'",this.now(),this.now(),row.id);
          this.transition(String(row.id),'paused',this.blockingReason(String(row.id)),true);
        }
        this.event('workspace.quiesced','workspace',1,{resumeRequired:true});
      });
      if(stops.some(result=>result.status==='rejected'))throw new CoordinatorError('maintenance_busy','Some running work could not stop cleanly. Tasks are paused and no backup was started.');
      return await work();
    } finally { this.maintenance=false;this.taskRecovery.resume();this.securityReviews.resume();this.fleets.resume();this.live.resumeScheduling();this.routines.resume(); }
  }

  async shutdown():Promise<void> {
    if(this.closed)return;
    this.maintenance=true;
    const taskIds=this.rows('SELECT id FROM tasks').map(row=>String(row.id));
    const stops=await Promise.allSettled([this.fleets.suspend(),this.live.shutdown(),this.taskRecovery.suspend(),this.securityReviews.suspend(),this.routines.suspend(),this.code.stopAndDrain(),...taskIds.map(id=>this.browser.stopForTask(id))]);
    await this.browserActions.drain();await this.results.drain();await this.gmail?.close();await this.requests.shutdown();await this.collaboration.shutdown();await this.code.shutdown();await this.browser.shutdown();await this.artifacts.drain();this.close();
    if(stops.some(result=>result.status==='rejected'))throw new CoordinatorError('shutdown_interrupted','Some work could not stop cleanly; the saved checkpoints were retained.');
  }

  close(): void {
    if (this.closed) return;
    this.fleets.abandon();
    this.live.abandon();
    this.requests.close();
    this.collaboration.close();
    this.code.abandon();
    this.browser.abandon();
    this.artifacts.close();
    this.transact(() => this.recoverLocked(this.instanceId));
    this.persistence.close(); this.closed = true;
  }
}
