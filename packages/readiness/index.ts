import type { BrowserState } from '../contracts/browser';
import type { CodeRuntimeStatus } from '../contracts/code';
import type { GoogleWorkspaceState } from '../contracts/google-workspace';
import { DOCUMENT_RUNTIME_PACKAGES } from '../documents';
import type { GmailState } from '../contracts/gmail';
import type { ReadinessCapability, ReadinessCommand, ReadinessItem, ReadinessState, ReadinessTarget, WorkflowInputCheck } from '../contracts/readiness';
import { identity, record, string } from '../contracts/live-validation';

export interface ReadinessRequirements {
  outcome: string;
  agentId?: string;
  model: string;
  capabilities: Exclude<ReadinessCapability, 'model' | 'inputs'>[];
  mailAccount?: string;
  googleWorkspaceAccount?: string;
  inputSlots?: WorkflowInputCheck[];
  documentInputs?: { format: 'pdf' | 'xlsx'; bytes: number; available: boolean }[];
  /** True for an old/manual task whose optional tools have not been declared as requirements. */
  requirementsUnspecified?: boolean;
}
export interface ModelReadiness {
  credentialConfigured: boolean;
  models: { id: string }[];
}
export interface ReadinessPorts {
  resolve(target: ReadinessTarget): ReadinessRequirements | Promise<ReadinessRequirements>;
  model(selection:string): ModelReadiness | Promise<ModelReadiness>;
  browser?(agentId: string): BrowserState['runtime'] | Promise<BrowserState['runtime']>;
  code?(): CodeRuntimeStatus | Promise<CodeRuntimeStatus>;
  gmail?(): GmailState | Promise<GmailState>;
  googleWorkspace?(): GoogleWorkspaceState | Promise<GoogleWorkspaceState>;
  /** Resolve the immutable agent project and its explicit owner-approved connector accounts. */
  projectAccounts?(agentId: string): { gmail: string | null; googleWorkspace: string | null } | Promise<{ gmail: string | null; googleWorkspace: string | null }>;
}
export class ReadinessError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ReadinessError'; }
}

export function parseReadinessCommand(raw: unknown): ReadinessCommand {
  const command = record(raw, ['type', 'target']);
  if (command.type !== 'readiness.check') throw new ReadinessError('invalid_command', 'This readiness action is not supported.');
  const target = record(command.target, ['kind', 'taskId', 'workflowId', 'values', 'agentId', 'model']);
  if (target.kind === 'task') {
    record(target, ['kind', 'taskId']);
    return { type: 'readiness.check', target: { kind: 'task', taskId: identity(target.taskId) } };
  }
  if (target.kind !== 'workflow') throw new ReadinessError('invalid_command', 'Choose a task or workflow to check.');
  record(target, ['kind', 'workflowId', 'values', 'agentId', 'model']);
  // The workflow resolver validates named parameters. No paths, policy or credentials can be sent.
  if (!target.values || typeof target.values !== 'object' || Array.isArray(target.values) || ![Object.prototype, null].includes(Object.getPrototypeOf(target.values)) || Buffer.byteLength(JSON.stringify(target.values)) > 24000 || Object.values(target.values).some(value => typeof value !== 'string' || value.includes('\0'))) throw new ReadinessError('invalid_command', 'Complete the workflow inputs before checking setup.');
  return { type: 'readiness.check', target: { kind: 'workflow', workflowId: identity(target.workflowId), values: target.values as Record<string, string>, model: string(target.model, 100), ...(target.agentId === undefined ? {} : { agentId: identity(target.agentId) }) } };
}

/** Combines only the selected job's read-only status ports. No repairs or paid probes. */
export class ReadinessService {
  constructor(private options: { ports: ReadinessPorts; now?: () => number; timeoutMs?: number }) {}
  async handle(raw: unknown): Promise<ReadinessState> {
    const { target } = parseReadinessCommand(raw);
    const timeout = Math.max(10, Math.min(15000, this.options.timeoutMs ?? 5000));
    const deadline=Date.now()+timeout;
    let resolveTimer:ReturnType<typeof setTimeout>|undefined;
    let required:ReadinessRequirements;
    try{required=await Promise.race([Promise.resolve().then(()=>this.options.ports.resolve(target)),new Promise<never>((_,reject)=>{resolveTimer=setTimeout(()=>reject(new ReadinessError('readiness_timeout','The readiness requirements could not be resolved in time. Retry the check; saved work is unchanged.')),timeout);})]);}
    finally{if(resolveTimer)clearTimeout(resolveTimer);}
    const now = (this.options.now || Date.now)();
    const capabilities = [...new Set<ReadinessCapability>(['model', ...required.capabilities])];
    let codePromise: Promise<CodeRuntimeStatus> | undefined;
    const codeStatus = () => codePromise ||= this.options.ports.code ? Promise.resolve().then(() => this.options.ports.code!()) : Promise.reject(Error('not_available'));
    const approvedAccount = async (connector: 'gmail' | 'googleWorkspace', expected: string | undefined) => {
      if (!required.agentId) return false;
      if (!this.options.ports.projectAccounts) throw Error('not_available');
      const accounts = await this.options.ports.projectAccounts(required.agentId);
      return !!expected && accounts[connector]?.toLowerCase() === expected.toLowerCase();
    };
    const run = async (capability: ReadinessCapability): Promise<ReadinessItem> => {
      const base = { id: capability, checkedAt: now };
      if (capability === 'model') {
        const state = await this.options.ports.model(required.model);
        if (!state.models.some(model => model.id === required.model)) return { ...base, label: 'Model', status: 'needs_setup', blocking: true, detail: 'Choose a supported model for this job.', action: 'settings', actionLabel: 'Model settings' };
        if (!state.credentialConfigured) return { ...base, label: 'Model', status: 'needs_setup', blocking: true, detail: 'This model connection is not configured. Choose its connection in Settings.', action: 'settings', actionLabel: 'Model settings' };
        return { ...base, label: 'Model', status: 'configured', blocking: false, detail: 'Connection configured. Model compatibility, availability and metered account balance have not been tested by this check.' };
      }
      if (capability === 'gmail') {
        if (!this.options.ports.gmail) throw Error('not_available');
        const state = await this.options.ports.gmail();
        if (state.connecting) return { ...base, label: 'Gmail connection', status: 'checking', blocking: true, detail: 'Finish the current sign-in, then check again.', action: 'settings', actionLabel: 'Gmail settings' };
        if (!state.configured || !state.connectedAccount) return { ...base, label: 'Gmail connection', status: 'needs_setup', blocking: true, detail: 'Connect the exact Gmail account selected for this job.', action: 'settings', actionLabel: 'Connect Gmail' };
        if (state.connectedAccount.toLowerCase() !== required.mailAccount?.toLowerCase()) return { ...base, label: 'Gmail connection', status: 'needs_setup', blocking: true, detail: 'The connected Gmail account does not match this job. Choose the intended account before running.', action: 'settings', actionLabel: 'Gmail settings' };
        if (state.error) return { ...base, label: 'Gmail connection', status: 'needs_setup', blocking: true, detail: 'The connection has a recorded error. Review its status and reconnect if needed.', action: 'settings', actionLabel: 'Gmail settings' };
        if (!await approvedAccount('gmail', required.mailAccount)) return { ...base, label: 'Gmail project approval', status: 'needs_setup', blocking: true, detail: required.agentId ? 'The exact Gmail account must be verified and explicitly approved for this agent’s project. A saved connection alone does not give the project access.' : 'Save this task or choose an existing agent, then verify and approve the Gmail account for that agent’s project.', action: 'projects', actionLabel: 'Project accounts' };
        return { ...base, label: 'Gmail connection', status: 'configured', blocking: false, detail: 'The selected account is connected locally. No email was read here. The project has approved this exact account; token validity is checked again when mail is read.' };
      }
      if (capability === 'google_workspace') {
        if (!this.options.ports.googleWorkspace) throw Error('not_available');
        const state = await this.options.ports.googleWorkspace();
        if (state.connecting) return { ...base, label: 'Google Drive connection', status: 'checking', blocking: true, detail: 'Finish Google consent, then verify the account.', action: 'settings', actionLabel: 'Google connections' };
        if (!state.configured || !state.connectedAccount || state.error || state.connectedAccount.toLowerCase() !== required.googleWorkspaceAccount?.toLowerCase()) return { ...base, label: 'Google Drive connection', status: 'needs_setup', blocking: true, detail: 'Connect the exact Google account selected for this live import.', action: 'settings', actionLabel: 'Google connections' };
        if (!await approvedAccount('googleWorkspace', required.googleWorkspaceAccount)) return { ...base, label: 'Google project approval', status: 'needs_setup', blocking: true, detail: 'Verify and explicitly approve this Google account for the selected agent’s project before importing. A Gmail approval does not grant Drive access.', action: 'projects', actionLabel: 'Project accounts' };
        return { ...base, label: 'Google Drive connection', status: 'configured', blocking: false, detail: 'The exact account is configured and approved for this project. No document was read here; identity is verified again before the selected import.' };
      }
      if (capability === 'documents') {
        if (required.documentInputs?.some(input => !input.available || input.bytes > 32 * 1024 * 1024)) return { ...base, label: 'PDF and spreadsheet reader', status: 'needs_input', blocking: true, detail: 'A pinned document is missing, damaged, or above the 32 MiB extraction limit. Replace it with a complete supported input.', action: 'files', actionLabel: 'Choose task files' };
        const state = await codeStatus();
        if (!state.ready || !state.imageDigest || DOCUMENT_RUNTIME_PACKAGES.some(required => !state.packages.some(item => item.runtime === 'python' && item.name === required.name && item.version === required.version))) return { ...base, label: 'PDF and spreadsheet reader', status: 'needs_setup', blocking: true, detail: 'This task has a pinned PDF or XLSX input. Start Docker and prepare the reviewed document image with its exact parser packages before extraction.', action: 'runtime', actionLabel: 'Document runtime setup' };
        return { ...base, label: 'PDF and spreadsheet reader', status: 'verified', blocking: false, detail: 'The isolated document image and reviewed parser versions are available. No document was opened by this check; unsupported, encrypted or scanned content may still need a different input.' };
      }
      if (capability === 'browser') {
        if (!required.agentId) return { ...base, label: 'Private browser', status: 'needs_setup', blocking: true, detail: 'Save the task to create its agent, then prepare that agent’s private browser.', action: 'browser', actionLabel: 'Browser setup' };
        if (!this.options.ports.browser) throw Error('not_available');
        const state = await this.options.ports.browser(required.agentId);
        const native = state.backend === 'desktop_chrome';
        if (!state.ready || (native && (state.setupRequired || !state.extensionConnected))) return { ...base, label: native ? 'Dedicated Chrome' : 'Container browser', status: 'needs_setup', blocking: true, detail: native ? 'Prepare or reconnect this agent’s dedicated Chrome profile and extension. Website sign-in may still need your help. Code containers are not required for this browser.' : 'The container browser runtime is unavailable. Its Docker service and browser image must be ready.', action: 'browser', actionLabel: 'Browser setup' };
        return { ...base, label: native ? 'Dedicated Chrome' : 'Container browser', status: 'verified', blocking: false, detail: native ? 'This agent’s extension is connected. No page or sign-in was tested. Managed file transfers are unavailable in native Chrome.' : 'The browser runtime is available. No website, sign-in or page action was tested.' };
      }
      if (capability === 'code') {
        const state = await codeStatus();
        return state.ready
          ? { ...base, label: 'Isolated code runtime', status: 'verified', blocking: false, detail: 'The code runtime is available. Jobs run offline in an isolated container; no code was executed by this check.' }
          : { ...base, label: 'Isolated code runtime', status: 'needs_setup', blocking: true, detail: 'Start the container runtime and prepare the code image through the existing code setup.', action: 'runtime', actionLabel: 'Code setup' };
      }
      throw Error('unsupported_capability');
    };
    const checks = await Promise.all(capabilities.map(async capability => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([run(capability), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), Math.max(1,deadline-Date.now())); })]);
      } catch {
        return { id: capability, label: { model: 'Model', browser: 'Private browser', code: 'Isolated code runtime', gmail: 'Gmail connection', google_workspace: 'Google Drive connection', documents: 'PDF and spreadsheet reader', inputs: 'Required files' }[capability], status: 'unavailable' as const, blocking: true, detail: 'This status could not be checked. Saved work is unchanged; retry the check.', checkedAt: now };
      } finally { if (timer) clearTimeout(timer); }
    }));
    const inputSlots = required.inputSlots || [];
    if (inputSlots.length) {
      const pending = inputSlots.filter(slot => slot.required && slot.status !== 'accepted');
      checks.push({ id: 'inputs', label: 'Required files', status: pending.length ? 'needs_input' : 'verified', blocking: pending.length > 0, detail: pending.length ? `${pending.length} required file slot${pending.length === 1 ? '' : 's'} need a valid, assigned input before paid work can start.` : 'The assigned file versions passed the declared format and content checks. Their relevance to the question is reviewed during the task.', action: 'files', actionLabel: 'Choose task files', checkedAt: now });
    }
    return { outcome: required.outcome, status: checks.some(check => check.blocking) ? 'needs_attention' : checks.some(check => check.status !== 'verified') ? 'ready_with_limits' : 'ready', checks, inputSlots, checkedAt: now, paidProbePerformed: false, notes: ['No model calls, website actions or email reads were made. This check does not prove the task will succeed.', ...(required.requirementsUnspecified ? ['This older or custom brief has no declared tool requirements. Optional browser or code needs are checked when used.'] : [])] };
  }
}
