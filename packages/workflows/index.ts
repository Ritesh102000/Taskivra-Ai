import { createHash, randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { Persistence } from '../persistence';
import type { LiveCommand } from '../contracts/live';
import type { WorkflowCategory, WorkflowDefinition, WorkflowDraft, WorkflowProcedure, WorkflowState } from '../contracts/workflows';
import type { ReadinessTarget, WorkflowInputCheck } from '../contracts/readiness';
import type { ReadinessRequirements } from '../readiness';
import type { ArtifactService } from '../artifacts';
import { identity, parseLimits, parsePolicy, record, string, LiveError } from '../contracts/live-validation';
import { modelChoice } from '../model-adapters/pricing';
import { prepareWorkflow, WORKFLOW_RECIPES } from './catalog';
import { readProcedure } from './procedures';
import { validateContent } from '../requests/validation';

export class WorkflowError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WorkflowError'; }
}
type Row = Record<string, string | number | null>;
type CreateTask = (command: Extract<LiveCommand, { type: 'live.createTask' }>, onCreated?: (taskId: string) => void) => string;
const fail = (code: string, message: string): never => { throw new WorkflowError(code, message); };
const category = (value: unknown): WorkflowCategory => {
  if (!['business', 'developer', 'personal'].includes(String(value))) return fail('invalid_command', 'Choose a workflow category.');
  return value as WorkflowCategory;
};
function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => [key, canonical(part)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Owner-only workflow recipes; tools and agents cannot call this service. */
export class WorkflowService {
  constructor(private options: { persistence: Persistence; createTask: CreateTask; assertReuseSource?:(taskId:string)=>void; validateModel?: (selection:string)=>void; artifacts?: Pick<ArtifactService, 'readForValidation'>; now?: () => number }) {}
  private get db() { return this.options.persistence.db; }
  private now() { return (this.options.now || Date.now)(); }
  private row(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).get(...args) as Row | undefined; }
  private event(type: string, id: string, payload = { workflowId: id } as Record<string, string>) {
    this.db.prepare('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,1,?,?)').run(type, id, JSON.stringify(payload), this.now());
  }
  private saved(row: Row): WorkflowDefinition {
    const savedDraft = JSON.parse(String(row.draft_json)) as WorkflowDraft;
    const procedure = row.definition_json ? readProcedure(String(row.definition_json)) : undefined;
    return {
      id: String(row.id), source: 'saved', title: String(row.title), description: String(row.description), category: row.category as WorkflowCategory,
      outcome: savedDraft.completionCriteria, savedDraft, createdAt: Number(row.created_at),
      tools: (procedure?.requiredCapabilities.includes('gmail') || savedDraft.policy.mailAccount) ? ['Read Gmail headers and snippets', 'Write a private report'] : savedDraft.policy.mode === 'read_only_browser' ? ['Read approved websites', 'Write a private report'] : ['Private workspace tools', 'Isolated code', 'Approved websites'],
      ...(procedure ? { procedure } : {}),
      inputs: procedure ? structuredClone(procedure.inputs) : [
        { id: 'objective', label: 'Task for this run', kind: 'multiline', required: true, defaultValue: savedDraft.objective },
        { id: 'criteria', label: 'What does done look like?', kind: 'multiline', required: true, defaultValue: savedDraft.completionCriteria },
        { id: 'websites', label: 'Websites permitted for this run', kind: 'websites', required: Boolean(savedDraft.policy.mailAccount), defaultValue: savedDraft.policy.allowedOrigins.join('\n') },
        ...(savedDraft.policy.mailAccount ? [{ id: 'account', label: 'Gmail account', kind: 'email' as const, required: true, defaultValue: savedDraft.policy.mailAccount }] : []),
      ],
    };
  }
  state(): WorkflowState {
    return { recipes: structuredClone(WORKFLOW_RECIPES), saved: (this.db.prepare('SELECT * FROM saved_workflows ORDER BY created_at DESC,id').all() as Row[]).map(row => this.saved(row)), parameterizedTaskIds: (this.db.prepare('SELECT task_id FROM workflow_task_origins WHERE definition_json IS NOT NULL').all() as Row[]).map(row => String(row.task_id)) };
  }
  /** Returns the immutable procedure stored when this task was created, never a later catalog version. */
  requirementsForTask(taskId: string): WorkflowProcedure | null {
    identity(taskId);
    const origin = this.row('SELECT definition_json FROM workflow_task_origins WHERE task_id=?', taskId);
    return origin?.definition_json ? readProcedure(String(origin.definition_json)) : null;
  }
  previewRequirements(workflowId: string, values: Record<string, string>, model: string, agentId?: string): ReadinessRequirements {
    const workflow = this.find(identity(workflowId));
    const draft = prepareWorkflow(workflow, values);
    return { outcome: workflow.outcome, model, ...(agentId ? { agentId } : {}), capabilities: [...new Set([...(workflow.procedure?.requiredCapabilities || []), ...(draft.policy.mailAccount ? ['gmail' as const] : [])])], mailAccount: draft.policy.mailAccount, requirementsUnspecified: !workflow.procedure, inputSlots: (workflow.procedure?.fileSlots || []).map(slot => ({ slotKey: slot.key, label: slot.label, required: slot.required, versionId: null, status: 'missing', detail: 'Save the task, import its input file, then assign the exact version to this slot.' })) };
  }
  async taskReadiness(taskId: string): Promise<ReadinessRequirements> {
    const task = this.row('SELECT t.agent_id,t.completion_criteria,l.model,l.policy_json FROM tasks t JOIN live_task_config l ON l.task_id=t.id WHERE t.id=?', identity(taskId));
    if (!task) return fail('not_found', 'Choose a saved live task to check.');
    const procedure = this.requirementsForTask(taskId);
    const policy = parsePolicy(JSON.parse(String(task.policy_json)));
    const documents = this.db.prepare("SELECT v.format,v.bytes,v.status FROM task_artifacts b JOIN artifact_versions v ON v.id=b.version_id WHERE b.task_id=? AND b.role='input' AND v.format IN ('pdf','xlsx')").all(taskId).map(v => ({ format: v.format as 'pdf' | 'xlsx', bytes: Number(v.bytes), available: v.status === 'ready' }));
    return { outcome: String(task.completion_criteria), agentId: String(task.agent_id), model: String(task.model), mailAccount: policy.mailAccount, capabilities: [...new Set([...(procedure?.requiredCapabilities || []), ...(policy.mailAccount ? ['gmail' as const] : []), ...(documents.length ? ['documents' as const] : [])])], requirementsUnspecified: !procedure, documentInputs: documents, inputSlots: await this.checkInputs(taskId) };
  }
  async readinessRequirements(target: ReadinessTarget): Promise<ReadinessRequirements> {
    return target.kind === 'task' ? this.taskReadiness(target.taskId) : this.previewRequirements(target.workflowId, target.values, target.model, target.agentId);
  }
  private assignmentState(taskId: string): string {
    return JSON.stringify(this.db.prepare("SELECT a.slot_key,a.version_id,b.role FROM workflow_input_assignments a LEFT JOIN task_artifacts b ON b.task_id=a.task_id AND b.version_id=a.version_id WHERE a.task_id=? ORDER BY a.slot_key").all(taskId));
  }
  async checkInputs(taskId: string): Promise<WorkflowInputCheck[]> {
    const procedure = this.requirementsForTask(taskId);
    if (!procedure?.fileSlots.length) return [];
    const task = this.row('SELECT agent_id FROM tasks WHERE id=?', taskId);
    if (!task) return fail('not_found', 'The workflow task no longer exists.');
    const before = this.assignmentState(taskId);
    const checked: WorkflowInputCheck[] = [];
    for (const slot of procedure.fileSlots) {
      const assigned = this.row('SELECT version_id FROM workflow_input_assignments WHERE task_id=? AND slot_key=?', taskId, slot.key);
      const versionId = assigned ? String(assigned.version_id) : null;
      const base = { slotKey: slot.key, label: slot.label, required: slot.required, versionId };
      if (!versionId) { checked.push({ ...base, status: 'missing', detail: 'Import a file to this task and assign it to this slot.' }); continue; }
      if (!this.row("SELECT 1 FROM task_artifacts WHERE task_id=? AND version_id=? AND role='input'", taskId, versionId)) { checked.push({ ...base, status: 'rejected', detail: 'This exact version is no longer an input pinned to the task.' }); continue; }
      if (!this.options.artifacts) { checked.push({ ...base, status: 'unavailable', detail: 'The input verification service is unavailable. No paid work can start.' }); continue; }
      try {
        const constraints = slot.constraints, needsText = Boolean(constraints.csv || constraints.json || constraints.textIncludes?.length);
        const data = await this.options.artifacts.readForValidation(String(task.agent_id), versionId, needsText);
        const format = data.version.format === 'text' ? 'txt' : data.version.format === 'markdown' ? 'md' : data.version.format;
        if (!constraints.formats.includes(format as typeof constraints.formats[number])) { checked.push({ ...base, status: 'rejected', detail: `Expected ${constraints.formats.join(', ')}. Choose a file of the required format.` }); continue; }
        if (data.version.bytes < (constraints.minBytes || 0) || data.version.bytes > (constraints.maxBytes || 100 * 1024 * 1024)) { checked.push({ ...base, status: 'rejected', detail: 'The file size is outside this slot’s permitted range.' }); continue; }
        const result = needsText ? await validateContent(data.text!, constraints) : { accepted: true, explanation: 'Format, size and checksum checks passed.' };
        checked.push({ ...base, status: result.accepted ? 'accepted' : 'rejected', detail: result.explanation });
      } catch { checked.push({ ...base, status: 'unavailable', detail: 'The file is missing, changed, unsafe or could not be checked. Choose a complete supported file.' }); }
    }
    if (this.assignmentState(taskId) !== before) return checked.map(slot => ({ ...slot, status: 'unavailable', detail: 'Inputs changed during the check. Check the current assignments again.' }));
    return checked;
  }
  async assertInputsReady(taskId: string): Promise<void> {
    const pending = (await this.checkInputs(taskId)).filter(slot => slot.required && slot.status !== 'accepted');
    if (pending.length) fail('workflow_inputs_required', 'Assign and validate every required workflow file before running. Open task readiness to see the missing or incorrect slots.');
  }
  /** Safe agent context: exact already-pinned references, without file contents or host paths. */
  inputContext(taskId: string): { slotKey: string; label: string; versionId: string | null }[] {
    return (this.requirementsForTask(taskId)?.fileSlots || []).map(slot => ({ slotKey: slot.key, label: slot.label, versionId: this.row('SELECT version_id FROM workflow_input_assignments WHERE task_id=? AND slot_key=?', taskId, slot.key)?.version_id as string | undefined || null }));
  }
  private find(id: string): WorkflowDefinition {
    const recipe = WORKFLOW_RECIPES.find(item => item.id === id);
    if (recipe) return recipe;
    const saved = this.row('SELECT * FROM saved_workflows WHERE id=?', id);
    if (!saved) return fail('not_found', 'This workflow is no longer available. Refresh the library.');
    return this.saved(saved);
  }
  private receipt(key: string, kind: string, hash: string): string | null {
    const previous = this.row('SELECT * FROM workflow_receipts WHERE idempotency_key=?', key);
    if (!previous) return null;
    if (previous.kind !== kind || previous.request_hash !== hash) return fail('conflict', 'This save was already used for different details. Start a new workflow draft.');
    return String(previous.result_id);
  }
  private addReceipt(key: string, kind: string, hash: string, result: string) {
    if (Number(this.row('SELECT COUNT(*) AS count FROM workflow_receipts')!.count) >= 1000) fail('capacity_limit', 'The workflow save history limit was reached. Existing workflows and tasks are preserved.');
    this.db.prepare('INSERT INTO workflow_receipts(idempotency_key,kind,request_hash,result_id,created_at) VALUES (?,?,?,?,?)').run(key, kind, hash, result, this.now());
  }
  handle(raw: unknown): WorkflowState {
    try { return this.execute(raw); }
    catch (error) { if (error instanceof LiveError) throw new WorkflowError(error.code, error.message); throw error; }
  }
  private execute(raw: unknown): WorkflowState {
    const input = record(raw, ['type', 'workflowId', 'values', 'agentId', 'model', 'limits', 'idempotencyKey', 'taskId', 'title', 'description', 'category', 'parameterized', 'assignments', 'mailDetail']);
    if (Buffer.byteLength(JSON.stringify(input)) > 32768) fail('invalid_command', 'The workflow request is too large.');
    if (input.type === 'workflows.state') { record(input, ['type']); return this.state(); }
    if (input.type === 'workflows.preview' || input.type === 'workflows.createTask') {
      const create = input.type === 'workflows.createTask';
      record(input, create ? ['type', 'workflowId', 'values', 'agentId', 'model', 'limits', 'idempotencyKey', 'mailDetail'] : ['type', 'workflowId', 'values']);
      const id = identity(input.workflowId);
      const key = create ? identity(input.idempotencyKey) : '';
      const hash = fingerprint(input);
      if (create) {
        const replay = this.receipt(key, 'create', hash);
        if (replay) return { ...this.state(), createdTaskId: replay };
      }
      const definition = this.find(id);
      const prepared = prepareWorkflow(definition, input.values as Record<string, string>);
      if (!create) return { ...this.state(), prepared };
      const command: Extract<LiveCommand, { type: 'live.createTask' }> = {
        type: 'live.createTask', agentId: identity(input.agentId), model: string(input.model, 100), limits: parseLimits(input.limits), ...prepared,
      };
      if (input.mailDetail !== undefined && typeof input.mailDetail !== 'boolean') fail('invalid_command', 'Choose whether this Gmail task may review full threads and selected attachments.');
      if (input.mailDetail && !command.policy.mailAccount) fail('invalid_command', 'Detailed mail access requires an exact Gmail account on this task.');
      if (input.mailDetail === true) command.policy.mailDetail = 'threads_and_attachments';
      else if (input.mailDetail === false) delete command.policy.mailDetail;
      (this.options.validateModel||modelChoice)(command.model);
      const createdTaskId = this.options.createTask(command, taskId => {
        this.addReceipt(key, 'create', hash, taskId);
        this.db.prepare('INSERT INTO workflow_task_origins(task_id,workflow_id,title,created_at,definition_json) VALUES (?,?,?,?,?)').run(taskId, id, definition.title, this.now(), definition.procedure ? JSON.stringify(definition.procedure) : null);
        this.event('workflow.task_prepared', taskId, { workflowId: id, taskId });
      });
      return { ...this.state(), createdTaskId };
    }
    if (input.type === 'workflows.saveFromTask') {
      record(input, ['type', 'taskId', 'title', 'description', 'category', 'idempotencyKey', 'parameterized']);
      if (input.parameterized !== undefined && typeof input.parameterized !== 'boolean') fail('invalid_command', 'Choose whether to preserve named workflow inputs.');
      const key = identity(input.idempotencyKey), taskId = identity(input.taskId), title = string(input.title, 100), selectedCategory = category(input.category);
      if (typeof input.description !== 'string' || Buffer.byteLength(input.description) > 500 || input.description.includes('\0')) fail('invalid_command', 'Use a description of at most 500 bytes.');
      this.options.assertReuseSource?.(taskId);
      const hash = fingerprint(input), replay = this.receipt(key, 'save', hash);
      if (replay) { this.find(replay); return this.state(); }
      this.options.persistence.transaction(() => {
        const source = this.row('SELECT t.objective,t.completion_criteria,l.policy_json FROM tasks t JOIN live_task_config l ON l.task_id=t.id WHERE t.id=?', taskId);
        if (!source) fail('not_found', 'Choose a saved live task to reuse as a workflow.');
        if (Number(this.row('SELECT COUNT(*) AS count FROM saved_workflows')!.count) >= 50) fail('capacity_limit', 'You can save up to fifty reusable workflows. Remove one to make room.');
        const procedure = input.parameterized ? this.requirementsForTask(taskId) : null;
        if (input.parameterized && !procedure) fail('invalid_command', 'This task has a manual brief. Save it as a manual workflow instead.');
        const draft: WorkflowDraft = procedure ? { objective: procedure.objectiveTemplate, completionCriteria: procedure.completionTemplate, policy: { mode: procedure.mode, allowedOrigins: [] } } : { objective: String(source!.objective), completionCriteria: String(source!.completion_criteria), policy: parsePolicy(JSON.parse(String(source!.policy_json))) };
        const id = randomUUID();
        this.db.prepare('INSERT INTO saved_workflows(id,title,description,category,draft_json,created_at,definition_json) VALUES (?,?,?,?,?,?,?)').run(id, title, (input.description as string).trim(), selectedCategory, JSON.stringify(draft), this.now(), procedure ? JSON.stringify(procedure) : null);
        this.addReceipt(key, 'save', hash, id);
        this.event('workflow.saved', id);
      });
      return this.state();
    }
    if (input.type === 'workflows.assignInputs') {
      record(input, ['type', 'taskId', 'assignments']);
      const taskId = identity(input.taskId), procedure = this.requirementsForTask(taskId);
      if (!procedure?.fileSlots.length) fail('invalid_command', 'This task has no named workflow file slots.');
      if (!Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 16) fail('invalid_command', 'Choose one exact task input for each file slot.');
      const assignments = (input.assignments as unknown[]).map(raw => { const item = record(raw, ['slotKey', 'versionId']); return { slotKey: identity(item.slotKey), versionId: identity(item.versionId) }; });
      if (new Set(assignments.map(item => item.slotKey)).size !== assignments.length) fail('invalid_command', 'Each file slot can be assigned once per change.');
      this.options.persistence.transaction(() => {
        const task = this.row('SELECT state FROM tasks WHERE id=?', taskId);
        if (!task || !['paused', 'waiting'].includes(String(task.state))) fail('task_busy', 'Pause the task before changing its workflow inputs. Ended tasks retain their original assignments.');
        if (this.row("SELECT 1 FROM runs WHERE task_id=? AND state='running'", taskId)) fail('task_busy', 'Wait for the current step to stop before changing workflow inputs.');
        for (const item of assignments) {
          if (!procedure!.fileSlots.some(slot => slot.key === item.slotKey)) fail('invalid_command', 'This workflow has no such file slot.');
          if (!this.row("SELECT 1 FROM task_artifacts WHERE task_id=? AND version_id=? AND role='input'", taskId, item.versionId)) fail('permission_denied', 'Choose an input already imported or explicitly shared into this task.');
          this.db.prepare('INSERT INTO workflow_input_assignments(task_id,slot_key,version_id,assigned_at) VALUES (?,?,?,?) ON CONFLICT(task_id,slot_key) DO UPDATE SET version_id=excluded.version_id,assigned_at=excluded.assigned_at').run(taskId, item.slotKey, item.versionId, this.now());
        }
        const all = this.db.prepare('SELECT version_id FROM workflow_input_assignments WHERE task_id=?').all(taskId) as Row[];
        if (new Set(all.map(row => row.version_id)).size !== all.length) fail('invalid_command', 'Assign different file versions to the two comparison slots.');
        this.event('workflow.inputs_assigned', taskId, { taskId });
      });
      return { ...this.state(), assignedTaskId: taskId };
    }
    if (input.type === 'workflows.delete') {
      record(input, ['type', 'workflowId']); const id = identity(input.workflowId);
      if (WORKFLOW_RECIPES.some(item => item.id === id)) fail('invalid_command', 'Built-in workflows cannot be removed.');
      this.options.persistence.transaction(() => {
        const result = this.db.prepare('DELETE FROM saved_workflows WHERE id=?').run(id);
        if (Number(result.changes)) this.event('workflow.removed', id);
      });
      return this.state();
    }
    return fail('invalid_command', 'This workflow command is not supported.');
  }
}
