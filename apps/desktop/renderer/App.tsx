import {TaskHistory} from './TaskHistory';
import {ExactGrants} from './Grants';
import {Fleets} from './Fleets';
import {ProviderSettings} from './ProviderSettings';
import {RecoveryCenter} from './RecoveryCenter';
import {Connections} from './Connections';
import {TaskMailReview} from './TaskMailReview';
import {Projects,useProjects} from './Projects';
import {BrowserActionReview,useBrowserActionAttention} from './BrowserActionReview';
import {Routines} from './Routines';
import {ResultsPanel} from './Results';
import {TaskReadiness} from './TaskReadiness';
import {KeySettings} from './KeySettings';
import {RecoverySettings} from './RecoverySettings';
import { GmailProvider, GmailConnection } from './Gmail';
import { Overview } from './Overview';
import { SaveWorkflowDialog, Workflows, useWorkflows } from './Workflows';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { Agent, AppBridge, Command, DomainEvent, InputRequest, Scenario, Snapshot, Task, TaskState, UserRequest } from '../../../packages/contracts/index';
import { FilesProvider, SharedLibrary, StorageUsage, TaskFiles } from './Files';
import { BrowserPanel } from './Browser';
import { CodePanel } from './Code';
import { AgentRunPanel, LiveTaskOptions, ModelSettings, ModeBadge, newLiveTaskDraft, useLiveController, hasLiveProgress } from './AgentRun';
import { StructuredRequestCard, requestIsPending, useRequests } from './Requests';
import { AgentInbox, SharedBoard, TaskCollaboration, useCollaboration } from './Collaboration';

function isStructuredRequest(request: InputRequest | UserRequest): request is UserRequest { return 'slots' in request && 'kind' in request && 'continuationKey' in request; }
const bridge = (window as Window & { agentWorkspaces?: AppBridge }).agentWorkspaces;
const providerApi=bridge?{command:bridge.modelProviders}:undefined;
function waitingLabel(task: Task, requests: (InputRequest | UserRequest)[]): string | null {
  const pending = requests.filter(request => request.taskId === task.id && requestIsPending(request.state));
  if (pending.some(request => 'kind' in request && request.kind === 'gmail_connection')) return 'Waiting for your Gmail connection.';
  if (pending.some(request => 'kind' in request && request.kind === 'reduced_scope')) return 'Waiting for your decision on a revised outcome.';
  if (pending.some(request => 'kind' in request && request.kind === 'capability' && request.capability)) return 'Waiting for your approval of exact file access.';
  if (pending.some(request => request.type === 'browser_handoff')) return 'Waiting for you to finish browser sign-in.';
  if (pending.some(request => request.type === 'files')) return 'Waiting for required files to be accepted.';
  if (pending.some(request => request.type === 'clarification')) return 'Waiting for your response.';
  if (pending.some(request => request.type === 'permission_change' && (!('kind' in request) || request.legacy))) return 'Waiting for a runtime dependency.';
  const labels: Record<string, string> = { permission_change: 'Waiting for your approval.', browser_handoff: 'Waiting for browser sign-in.', files: 'Waiting for required files.', clarification: 'Waiting for your response.', dependency: 'Waiting for another task.', browser_action: 'Waiting for your review of a website action.' };
  return task.waitingReason ? labels[task.waitingReason] || task.waitingReason : null;
}
const terminalStates: TaskState[] = ['succeeded', 'failed', 'cancelled'];
const stateLabels: Record<TaskState, string> = {
  queued: 'Queued', running: 'Working', waiting: 'Needs input', pausing: 'Pausing',
  paused: 'Paused', recovering: 'Recovering', succeeded: 'Completed', failed: 'Failed', cancelled: 'Stopped',
};
type IconName = 'grid' | 'inbox' | 'folder' | 'agent' | 'plus' | 'arrow' | 'back' | 'play' | 'pause' | 'stop' | 'check' | 'clock' | 'settings' | 'activity' | 'browser' | 'panel' | 'close' | 'message' | 'sun' | 'shield' | 'search';
const iconPaths: Record<IconName, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.4" /><rect x="14" y="3" width="7" height="7" rx="1.4" /><rect x="3" y="14" width="7" height="7" rx="1.4" /><rect x="14" y="14" width="7" height="7" rx="1.4" /></>,
  inbox: <><path d="M4 4h16l2 11v5H2v-5L4 4Z" /><path d="M2 15h6l2 3h4l2-3h6" /></>,
  folder: <path d="M3 6h7l2 3h9v11H3V6Zm0 0V4h7l2 2h7v3" />,
  agent: <><rect x="4" y="7" width="16" height="13" rx="4" /><path d="M12 3v4M8 13h.01M16 13h.01M9 17h6M1 12v4M23 12v4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="m13 5 7 7-7 7M4 12h16" />,
  back: <path d="m11 5-7 7 7 7M4 12h16" />,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="16" cy="17" r="3" /></>,
  activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  browser: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16m3-10 2 2-2 2" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  message: <path d="M4 4h16v13H9l-5 4V4Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2m-3-9-1.5 1.5M6.5 17.5 5 19M5 5l1.5 1.5m11 11L19 19" /></>,
  shield: <><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
};
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}
function Badge({ state, ready = false }: { state: TaskState; ready?: boolean }) {
  return <span className={'state-badge state-' + state}><span className="status-dot" />{ready ? 'Ready to run' : stateLabels[state]}</span>;
}
function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return <span className={'avatar' + (large ? ' avatar-large' : '')}>{name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() || 'A'}</span>;
}
function time(value: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
function date(value: number) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}
function Empty({ icon, title, children, action }: { icon: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={27} /></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
function Dialog({ title, children, onClose, busy, error }: { title: string; children: ReactNode; onClose: () => void; busy: boolean; error?: string | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal-header"><div><span className="eyebrow">YOUR WORKSPACE</span><h2 id="modal-title">{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}><Icon name="close" /></button></div>
    {error && <div className="modal-error" role="alert">{error}</div>}
    {children}
  </dialog>;
}

function RequestCard({ request, agent, task, busy, onRespond, onOpen, onOpenBrowser, onOpenCode }: { request: InputRequest; agent?: Agent; task?: Task; busy: boolean; onRespond: (request: InputRequest, response: string) => Promise<boolean>; onOpen?: () => void; onOpenBrowser?: () => void; onOpenCode?: () => void }) {
  const [answer, setAnswer] = useState('');
  const open = request.state === 'open' && task?.state !== 'cancelled';
  const browserHandoff = request.type === 'browser_handoff';
  const dependencyRequest = request.type === 'permission_change';
  const replaced = String(request.state) === 'superseded';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (answer.trim() && await onRespond(request, answer.trim())) setAnswer('');
  };
  return <section className={'request-card' + (!open ? ' request-resolved' : '')} aria-label={request.title}>
    <div className="request-card-top"><span className="request-symbol"><Icon name={open ? browserHandoff ? 'browser' : 'message' : 'check'} /></span><div><span className="eyebrow">{open ? browserHandoff ? 'BROWSER HANDOFF NEEDED' : dependencyRequest ? 'RUNTIME DEPENDENCY NEEDED' : 'YOUR INPUT NEEDED' : replaced ? 'REPLACED REQUEST' : request.state === 'cancelled' ? 'REQUEST CANCELLED' : request.state === 'fulfilled' ? browserHandoff ? 'CONTROL RETURNED' : dependencyRequest ? 'DEPENDENCY VERIFIED' : 'ANSWER SAVED' : 'REQUEST CLOSED'}</span><h3>{request.title}</h3></div></div>
    <p className="request-context">{agent?.name || 'Agent'}{onOpen && task ? <> <span>·</span> <button className="inline-link" onClick={onOpen}>{task.objective}</button></> : null}</p>
    <p className="request-reason">{request.reason}</p>
    {open && dependencyRequest ? <div className="browser-request-action"><p className="subtle">Review the exact package in Activity. A trusted image build must provide it before this request can be fulfilled. Code jobs keep networking disabled.</p><div className="request-bottom"><span><Icon name="shield" size={13} /> Runtime verification required</span><button className="button primary small" disabled={busy || !onOpenCode} onClick={onOpenCode}>Open Activity <Icon name="arrow" size={15} /></button></div></div> : open && browserHandoff ? <div className="browser-request-action"><p className="subtle">Take control in the browser to sign in. Return control when you are ready; a fresh page view resolves this request. Do not enter credentials in task messages.</p><div className="request-bottom"><span><Icon name="shield" size={13} /> Private browser input</span><button className="button primary small" disabled={busy || !onOpenBrowser} onClick={onOpenBrowser}>Open browser <Icon name="arrow" size={15} /></button></div></div> : open ? <form onSubmit={submit}>
      <label className="sr-only" htmlFor={'answer-' + request.id}>Your response to {request.title}</label>
      <textarea id={'answer-' + request.id} placeholder="Add the detail your agent needs…" rows={3} value={answer} onChange={event => setAnswer(event.target.value)} maxLength={4000} disabled={busy} required />
      <div className="request-bottom"><span><Icon name="shield" size={13} /> Private to {agent?.name || 'this agent'}</span><button className="button primary small" disabled={busy || !answer.trim()} type="submit">Send response <Icon name="arrow" size={15} /></button></div>
    </form> : replaced ? <p className="subtle">This request was replaced. Follow the current request to continue.</p> : dependencyRequest && request.state === 'fulfilled' ? <p className="subtle">The requested package was verified in the installed runtime image.</p> : browserHandoff && request.state === 'fulfilled' ? <p className="subtle">Browser control was returned with a fresh page view.</p> : request.response ? <blockquote>{request.response}</blockquote> : <p className="subtle">This request is closed. No response is needed.</p>}
  </section>;
}

function eventLabel(event: DomainEvent) {
  if (event.type === 'task.created' && event.payload.simulation === false) return 'Live task saved';
  const labels: Record<string, string> = {
    'agent.created': 'Agent created', 'task.created': 'Task added to the queue',
    'task.state_changed': 'Task state changed', 'task.message_added': 'Message saved',
    'input.requested': 'Owner input requested', 'input.owner_replied': 'Owner response saved',
    'input.fulfilled': 'Request fulfilled', 'run.claimed': 'Run started',
    'run.checkpointed': 'Progress checkpoint saved', 'settings.updated': 'Settings updated',
    'task.recovered': 'Task recovered', 'simulation.step': 'Simulation advanced',
    'message.created': 'Message saved', 'run.recovered': 'Saved run recovered',
    'tool.planned': 'Next tool step prepared', 'tool.succeeded': 'Tool step completed',
    'task.blockers_changed': 'Task requirements updated',
    'artifact.imported': 'File imported', 'artifact.published': 'File published to shared library',
    'artifact.used': 'Exact file version linked to task', 'artifact.version_added': 'New file version added',
    'storage.budget_updated': 'Storage budget updated', 'storage.budget_changed': 'Storage budget updated',
    'artifact.exported': 'Verified file copy exported', 'artifact.integrity_failed': 'File integrity check needs attention',
    'workspace.snapshot_committed': 'Task file snapshot saved',
    'execution.started': 'Container execution started', 'execution.finished': 'Container execution finished',
    'execution.preparing': 'Preparing isolated execution', 'execution.stopping': 'Stopping container execution',
    'execution.recovered': 'Interrupted execution recovered', 'execution.interrupted': 'Execution interrupted; saved progress retained', 'execution.exporting': 'Checking and saving execution files',
    'workspace.code_committed': 'Code workspace revision saved',
    'live.task_configured': 'Live task and limits saved', 'live.model_started': 'Model request started',
    'live.model_usage': 'Model usage recorded', 'live.tool_started': 'Agent tool started',
    'live.tool_finished': 'Agent tool finished', 'live.completed': 'Live result verified', 'live.paused': 'Live agent paused',
    'input.candidates_assigned': 'Selected files queued for checking', 'input.slot_checked': 'File requirement checked',
    'input.replan_queued': 'Agent asked to review available information', 'input.replan_completed': 'Agent reviewed the request',
    'input.replan_limit': 'Request review limit reached', 'input.capability_granted': 'Exact file access approved',
    'input.reduced_scope_proposed': 'Revised outcome proposed for your review', 'input.reduced_scope_accepted': 'Revised outcome accepted',
    'input.superseded': 'Request replaced by a newer decision',
    'workflow.task_prepared': 'Workflow task saved', 'workflow.saved': 'Reusable workflow saved', 'workflow.removed': 'Saved workflow removed',
    'collaboration.policy_changed': 'Collaboration permissions updated',
    'collaboration.message_sent': 'Scoped agent message delivered',
    'collaboration.dependency_added': 'Upstream task requirement added',
    'collaboration.dependency_removed': 'Upstream task requirement removed',
  };
  return labels[event.type] || event.type.replaceAll('_', ' ').replaceAll('.', ' · ');
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'history' | 'overview' | 'projects' | 'fleets' | 'taskRecovery' | 'routines' | 'results' | 'workflows' | 'tasks' | 'requests' | 'shared' | 'board' | 'inboxes' | 'settings'>('overview');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'agent' | 'task' | 'saveWorkflow' | null>(null);
  const [panel, setPanel] = useState<'activity' | 'browser' | 'files' | 'collaboration'>('activity');
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(340);
  const [message, setMessage] = useState('');
  const [agentName, setAgentName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [newTaskAgent, setNewTaskAgent] = useState('');
  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState('');
  const [scenario, setScenario] = useState<Scenario>('clarification');
  const [newTaskMode, setNewTaskMode] = useState<'live' | 'simulation'>('live');
  const live = useLiveController(bridge);
  const workflows = useWorkflows(bridge);
  const projects = useProjects(bridge);
  const createTaskAfterAgent = useRef(false);
  const requests = useRequests(bridge);
  const browserAttention = useBrowserActionAttention(bridge);
  const collaboration = useCollaboration(bridge,view==='inboxes'||view==='board'?agentId:undefined);
  const [liveDraft, setLiveDraft] = useState(() => newLiveTaskDraft());
  const conversationEnd = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  const applySnapshot = useCallback((next: Snapshot) => {
    if (!mounted.current) return;
    setSnapshot(current => {
      const lastEvent = (value: Snapshot) => value.events.reduce((last, event) => Math.max(last, event.id), 0);
      return current && lastEvent(current) > lastEvent(next) ? current : next;
    });
  }, []);
  const refresh = useCallback(async () => {
    if (!bridge) return;
    try { applySnapshot(await bridge.command({ type: 'snapshot' })); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'The workspace could not be loaded.'); }
  }, [applySnapshot]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = bridge?.onChanged(() => { void refresh(); });
    return () => { mounted.current = false; unsubscribe?.(); };
  }, [refresh]);
  useEffect(() => {
    const theme = snapshot?.settings.theme || 'system';
    document.documentElement.dataset.theme = theme;
  }, [snapshot?.settings.theme]);
  useEffect(() => { setMessage(''); }, [taskId]);
  useEffect(() => { if (modal) setError(null); }, [modal]);
  useEffect(() => { const model = live.state?.defaultModel; if (modal === 'task' && model) setLiveDraft(current => current.model ? current : { ...current, model }); }, [modal, live.state?.defaultModel]);
  useEffect(() => { conversationEnd.current?.scrollIntoView({ block: 'end' }); }, [taskId, snapshot?.messages.length, snapshot?.requests.length]);

  const command = async (value: Command) => {
    if (!bridge) return null;
    setBusy(true); setError(null);
    try { const next = await bridge.command(value); applySnapshot(next); return next; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The action could not be completed.'); return null; }
    finally { setBusy(false); }
  };
  const openTask = (task: Task) => { setTaskId(task.id); setAgentId(task.agentId); setView('tasks'); };
  const navigate = (next: typeof view) => { setView(next); setTaskId(null); setAgentId(null); setFilter('all'); };
  const createTask = () => {
    if (!snapshot?.agents.some(a=>!a.archived)) { createTaskAfterAgent.current = true; setAgentName(''); setInstructions(''); setModal('agent'); return; }
    setNewTaskAgent(snapshot.agents.find(a=>a.id===agentId&&!a.archived)?.id || snapshot.agents.find(a=>!a.archived)!.id); setObjective(''); setCriteria(''); setScenario('clarification'); setLiveDraft(newLiveTaskDraft(live.state?.defaultModel)); setNewTaskMode('live'); setModal('task');
  };
  const respond = async (request: InputRequest, response: string) => Boolean(await command({ type: 'requests.respond', requestId: request.id, revision: request.revision, response }));

  if (!bridge) return <main className="connection-screen"><div className="brand-symbol"><Icon name="grid" size={27} /></div><h1>Open your desktop workspace</h1><p>This interface needs the Agent Workspaces desktop app to access your saved tasks.</p><span className="subtle">The desktop connection is unavailable in this browser.</span></main>;
  if (!snapshot) return <main className="connection-screen"><div className="brand-symbol"><Icon name="grid" size={27} /></div><h1>{error ? 'Unable to open your workspace' : 'Opening your workspace…'}</h1><p>{error || 'Loading your saved agents and tasks.'}</p>{error && <button className="button primary" onClick={() => void refresh()}>Try again</button>}</main>;

  const agent = snapshot.agents.find(item => item.id === agentId);
  const task = snapshot.tasks.find(item => item.id === taskId);
  const taskAgent = snapshot.agents.find(item => item.id === task?.agentId);
  const structuredRequests = requests.requests.filter(item => !item.legacy);
  const structuredIds = new Set(structuredRequests.map(item => item.id));
  const legacyRequests = snapshot.requests.filter(item => !structuredIds.has(item.id) && (item.legacy === true || item.legacy === undefined && item.type !== 'files' && requests.loadStatus === 'loaded'));
  const unavailableRequests = snapshot.requests.filter(item => !structuredIds.has(item.id) && !legacyRequests.some(r => r.id === item.id) && requestIsPending(item.state));
  const allRequests = [...structuredRequests, ...legacyRequests];
  const openRequests = allRequests.filter(item => requestIsPending(item.state));
  const requestAttention = openRequests.length + browserAttention;
  const taskRequests = legacyRequests.filter(item => item.taskId === task?.id);
  const structuredTaskRequests = structuredRequests.filter(item => item.taskId === task?.id);
  const isLiveTask = task?.executionMode === 'live';
  const currentLiveRun = live.state?.tasks.find(item => item.taskId === task?.id);
  const taskMessages = snapshot.messages.filter(item => item.taskId === task?.id).sort((a, b) => a.createdAt - b.createdAt);
  const running = snapshot.tasks.filter(item => item.state === 'running').length;
  const completed = snapshot.tasks.filter(item => item.state === 'succeeded').length;
  const filteredTasks = snapshot.tasks.filter(item => {
    const scope = !agentId || item.agentId === agentId;
    const state = filter === 'all' || (filter === 'active' ? ['running', 'queued', 'recovering', 'pausing'].includes(item.state) : filter === 'waiting' ? item.state === 'waiting' : filter === 'finished' ? terminalStates.includes(item.state) : item.state === filter);
    return !item.archived && scope && state && item.objective.toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  const events = snapshot.events.filter(event => !task || event.aggregateId === task.id || event.payload.taskId === task.id || event.payload.producerTaskId === task.id || snapshot.taskArtifacts.some(link => link.taskId === task.id && (link.versionId === event.aggregateId || link.versionId === event.payload.versionId)) || [...taskRequests, ...structuredTaskRequests].some(request => request.id === event.aggregateId)).slice().sort((a, b) => b.id - a.id);
  const changeWidth = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = event.clientX, width = panelWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setPanelWidth(Math.max(280, Math.min(520, width + start - moveEvent.clientX)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  return <FilesProvider bridge={bridge} snapshot={snapshot} onSnapshot={applySnapshot}><GmailProvider bridge={bridge} tasks={live.state?.tasks || []}><div className="workspace-app">
    <aside className="sidebar" aria-label="Workspace navigation">
      <div className="sidebar-brand"><span className="brand-symbol"><Icon name="grid" size={20} /></span><div><strong>Agent Workspaces</strong><span>PERSONAL WORKSPACE</span></div></div>
      <button className="button new-task-button" onClick={() => navigate('workflows')}><Icon name="plus" size={18} /> New task <span className="shortcut">＋</span></button>
      <nav className="primary-nav">
        <button className={'nav-item' + (view === 'overview' ? ' selected' : '')} onClick={() => navigate('overview')} aria-current={view === 'overview' ? 'page' : undefined}><Icon name="sun" /><span>Overview</span></button>
        <button className={'nav-item' + (view === 'projects' ? ' selected' : '')} onClick={() => navigate('projects')} aria-current={view === 'projects' ? 'page' : undefined}><Icon name="folder" /><span>Projects</span></button>
        <button className={'nav-item' + (view === 'routines' ? ' selected' : '')} onClick={() => navigate('routines')} aria-current={view === 'routines' ? 'page' : undefined}><Icon name="clock" /><span>Routines</span></button>
        <button className={'nav-item' + (view === 'results' ? ' selected' : '')} onClick={() => navigate('results')} aria-current={view === 'results' ? 'page' : undefined}><Icon name="check" /><span>Results</span></button>
        <button className={'nav-item' + (view === 'fleets' ? ' selected' : '')} onClick={() => navigate('fleets')} aria-current={view === 'fleets' ? 'page' : undefined}><Icon name="agent" /><span>Fleets</span></button>
        <button className={'nav-item' + (view === 'workflows' ? ' selected' : '')} onClick={() => navigate('workflows')} aria-current={view === 'workflows' ? 'page' : undefined}><Icon name="play" /><span>Workflows</span></button>
        <button className={'nav-item' + (view === 'tasks' && !agentId ? ' selected' : '')} onClick={() => navigate('tasks')} aria-current={view === 'tasks' && !agentId ? 'page' : undefined}><Icon name="grid" /><span>All tasks</span><span className="nav-count">{snapshot.tasks.length}</span></button>
        <button className={'nav-item' + (view === 'requests' ? ' selected' : '')} onClick={() => navigate('requests')} aria-current={view === 'requests' ? 'page' : undefined}><Icon name="inbox" /><span>Requests</span>{requestAttention > 0 && <span className="nav-count attention">{requestAttention}</span>}</button>
        <button className={'nav-item' + (view === 'shared' ? ' selected' : '')} onClick={() => navigate('shared')} aria-current={view === 'shared' ? 'page' : undefined}><Icon name="folder" /><span>Shared library</span></button>
        <button className={'nav-item' + (view === 'taskRecovery' ? ' selected' : '')} onClick={() => navigate('taskRecovery')} aria-current={view === 'taskRecovery' ? 'page' : undefined}><Icon name="shield" /><span>Recovery</span></button>
        <button className={'nav-item' + (view === 'board' ? ' selected' : '')} onClick={() => navigate('board')} aria-current={view === 'board' ? 'page' : undefined}><Icon name="activity" /><span>Shared board</span></button>
        <button className={'nav-item' + (view === 'inboxes' ? ' selected' : '')} onClick={() => navigate('inboxes')} aria-current={view === 'inboxes' ? 'page' : undefined}><Icon name="message" /><span>Agent inboxes</span></button>
      </nav>
      <div className="nav-section-heading"><span>YOUR AGENTS</span><button className="icon-button" aria-label="Create agent" title="Create agent" onClick={() => { createTaskAfterAgent.current = false; setAgentName(''); setInstructions(''); setModal('agent'); }}><Icon name="plus" size={15} /></button></div>
      <div className="agents-nav">
        {snapshot.agents.filter(item=>!item.archived).map(item => {
          const priority = ['running', 'pausing', 'recovering', 'waiting', 'paused', 'queued'];
          const active = snapshot.tasks.filter(candidate => candidate.agentId === item.id && priority.includes(candidate.state)).sort((a, b) => priority.indexOf(a.state) - priority.indexOf(b.state))[0];
          return <button key={item.id} className={'agent-nav-item' + (agentId === item.id ? ' selected' : '')} onClick={() => { setAgentId(item.id); setTaskId(null); setView('tasks'); setFilter('all'); }} aria-current={agentId === item.id ? 'page' : undefined}><Avatar name={item.name} /><span className="agent-nav-copy"><strong>{item.name}</strong><span>{active ? active.executionMode === 'live' && active.state === 'paused' && live.state?.tasks.some(run => run.taskId === active.id && !hasLiveProgress(run)) ? 'Ready to run' : stateLabels[active.state] : 'Ready for a task'}</span></span>{active?.state === 'running' && <span className="live-dot" />}</button>;
        })}
        {!snapshot.agents.some(a=>!a.archived) && <button className="add-first-agent" onClick={() => { createTaskAfterAgent.current = false; setModal('agent'); }}><Icon name="plus" size={16} /> Create your first agent</button>}
      </div>
      <div className="sidebar-bottom"><div className="local-state"><span className="live-dot" /><span>Saved on this Mac</span><Icon name="shield" size={13} /></div><button className={'nav-item' + (view === 'settings' ? ' selected' : '')} onClick={() => navigate('settings')}><Icon name="settings" /><span>Settings</span></button><div className="owner-profile"><span className="owner-avatar">Y</span><div><strong>Your workspace</strong><span>Local · Single owner</span></div></div></div>
    </aside>

    <main className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{view === 'history' ? 'History and archive' : view === 'overview' ? 'Overview' : view === 'fleets' ? 'Fleets' : view === 'taskRecovery' ? 'Automatic recovery' : view === 'results' ? 'Results' : view === 'routines' ? 'Routines' : view === 'projects' ? 'Projects' : view === 'workflows' ? 'Workflows' : view === 'requests' ? 'Requests' : view === 'shared' ? 'Shared library' : view === 'board' ? 'Shared board' : view === 'inboxes' ? 'Agent inboxes' : view === 'settings' ? 'Settings' : agent?.name || 'All tasks'}</strong></div><div className="topbar-actions"><span className={'task-mode-badge' + ((isLiveTask || (!task && snapshot.tasks.some(item => item.executionMode === 'live'))) ? ' live' : '')}>{task ? isLiveTask ? 'Live agent' : 'Simulation' : 'Private workspace'}</span>{view === 'tasks' && (task ? !isLiveTask : snapshot.tasks.some(item => item.executionMode === 'simulation')) && <button className="text-button step-button" disabled={busy} onClick={() => void command({ type: 'simulation.step' })} title="Advance the local simulation by one step"><Icon name="play" size={13} /><span>Advance simulation</span></button>}</div></header>
      {(error || live.error) && <div className="error-banner" role="alert"><span>{error || live.error}</span><button className="icon-button" onClick={() => { setError(null); live.clearError(); }} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}

      {view === 'projects' && <Projects snapshot={snapshot} controller={projects} onOpenTask={openTask} onOpenAgent={id=>{setAgentId(id);setTaskId(null);setView('tasks');}} onCreateTask={id=>{setNewTaskAgent(id);setObjective('');setCriteria('');setLiveDraft(newLiveTaskDraft(live.state?.defaultModel));setNewTaskMode('live');setModal('task');}} />}
      {view === 'fleets' && <Fleets bridge={bridge} live={live.state} projects={projects} onChanged={()=>{void refresh();void live.refresh();}} onTask={id=>{const found=snapshot.tasks.find(t=>t.id===id);if(found)openTask(found);else void bridge.command({type:'snapshot'}).then(next=>{applySnapshot(next);const latest=next.tasks.find(t=>t.id===id);if(latest)openTask(latest);}).catch(cause=>setError(cause instanceof Error?cause.message:'This task could not be opened.'));}} onResult={id=>{setTaskId(id);setAgentId(null);setView('results');}} onLibrary={()=>navigate('shared')} onSettings={()=>navigate('settings')}/> }
      {view === 'taskRecovery' && <RecoveryCenter recovery={bridge.taskRecovery} onChanged={bridge.onLiveChanged} onTask={id=>{const found=snapshot.tasks.find(t=>t.id===id);if(found)openTask(found);}} />}
      {view === 'routines' && <Routines bridge={bridge} onTask={id=>{const found=snapshot.tasks.find(t=>t.id===id);if(found)openTask(found);}} />}
      {view === 'results' && <ResultsPanel bridge={bridge} snapshot={snapshot} onSnapshot={applySnapshot} selectedTaskId={taskId || undefined} onOpenTask={id => { const found=snapshot.tasks.find(t=>t.id===id); if(found)openTask(found); }} />}
      {view === 'overview' && <Overview snapshot={snapshot} requests={openRequests} live={live.state} onTask={(item, nextPanel) => { openTask(item); if (nextPanel) { setPanel(nextPanel); setPanelOpen(true); } }} onWorkflows={() => navigate('workflows')} onTasks={() => navigate('tasks')} onRequests={() => navigate('requests')} onSettings={() => navigate('settings')} />}
      {view === 'workflows' && <Workflows bridge={bridge} snapshot={snapshot} live={live.state} controller={workflows} onSetup={action => navigate(action==='projects'?'projects':'settings')} onCustom={createTask} onCreated={async createdId => { const next = await command({ type: 'snapshot' }); const created = next?.tasks.find(item => item.id === createdId); if (created) { openTask(created); setPanel('activity'); setPanelOpen(true); } void live.refresh(); }} />}

      {view === 'history' && <TaskHistory bridge={bridge} snapshot={snapshot} onTask={openTask} />}
      {view === 'tasks' && !task && <div className="page-scroll">
        <section className="page-heading"><div><span className="eyebrow">{agent ? 'AGENT WORKSPACE' : 'YOUR COMMAND CENTER'}</span><h1>{agent ? agent.name : 'All tasks'}</h1><p>{agent ? agent.instructions || 'A private workspace for this agent’s tasks.' : 'A clear view of what’s working and what needs you.'}</p></div><div className="collaboration-agent-actions"><button className="button" onClick={()=>navigate('history')}>History and archive</button>{agent && <button className="button" onClick={() => { setView('inboxes'); setTaskId(null); }}>Open agent inbox</button>}<button className="button primary" onClick={createTask}><Icon name="plus" size={16} /> New task</button></div></section>
        {!agent && <div className="overview-strip"><button onClick={() => setFilter('active')} className={filter === 'active' ? 'active' : ''}><span className="metric-symbol teal"><Icon name="activity" /></span><div><strong>{running}</strong><span>Working now</span></div></button><button onClick={() => { navigate('requests'); }}><span className="metric-symbol amber"><Icon name="inbox" /></span><div><strong>{requestAttention}</strong><span>Need your input</span></div></button><button onClick={() => setFilter('finished')} className={filter === 'finished' ? 'active' : ''}><span className="metric-symbol neutral"><Icon name="check" /></span><div><strong>{completed}</strong><span>Completed</span></div></button></div>}
        <div className="task-list-toolbar"><div className="filter-tabs" aria-label="Filter tasks">{[['all', 'All tasks'], ['active', 'Active'], ['waiting', 'Needs input'], ['paused', 'Paused'], ['finished', 'Finished']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div><label className="search-field"><Icon name="search" size={15} /><input aria-label="Search tasks" placeholder="Find a task…" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
        {filteredTasks.length ? <div className="task-list" aria-label="Tasks"><div className="task-list-labels"><span>TASK</span><span>AGENT</span><span>STATUS</span><span>UPDATED</span></div>{filteredTasks.map(item => {
          const owner = snapshot.agents.find(candidate => candidate.id === item.agentId);
          return <button key={item.id} className="task-row" onClick={() => openTask(item)}><span className="task-row-title"><span className={'task-symbol state-' + item.state}><Icon name={item.state === 'succeeded' ? 'check' : item.state === 'waiting' ? 'message' : item.state === 'running' ? 'activity' : 'clock'} size={17} /></span><span><strong>{item.objective}</strong><span><span className={'task-mode-inline' + (item.executionMode === 'live' ? ' live' : '')}>{item.executionMode === 'live' ? 'Live' : 'Simulation'}</span>{waitingLabel(item, allRequests) || (item.state === 'succeeded' ? item.executionMode === 'live' ? 'Live result verified' : 'Simulation outcome verified' : item.completionCriteria || (item.executionMode === 'live' ? 'Live agent task' : 'Local simulation task'))}</span></span></span><span className="task-row-agent"><Avatar name={owner?.name || 'Agent'} /><span>{owner?.name || 'Agent'}</span></span><Badge state={item.state} ready={Boolean(item.executionMode === 'live' && item.state === 'paused' && live.state?.tasks.some(run => run.taskId === item.id && !hasLiveProgress(run)))} /><span className="task-row-time">{date(item.updatedAt)} <Icon name="arrow" size={15} /></span></button>;
        })}</div> : <div className="landing-empty">{snapshot.tasks.filter(item => !agentId || item.agentId === agentId).length === 0 && !search && filter === 'all' ? <><Empty icon="agent" title={snapshot.agents.some(a=>!a.archived) ? 'Give your agent a first task' : 'Your workspace starts with an agent'} action={<button className="button primary" onClick={snapshot.agents.some(a=>!a.archived) ? createTask : () => setModal('agent')}><Icon name="plus" size={16} />{snapshot.agents.some(a=>!a.archived) ? 'Create a task' : 'Create an agent'}</button>}>Create an agent, give it an outcome, and follow each step here.</Empty><div className="intro-capabilities"><div><Icon name="browser" /><strong>A browser for each agent</strong><span>Separate sessions and multiple tabs.</span></div><div><Icon name="folder" /><strong>Private work, shared results</strong><span>Keep inputs private. Publish with intent.</span></div><div><Icon name="message" /><strong>You stay in the loop</strong><span>Answer a request and pick up where you left off.</span></div></div><p className="phase-note">Choose a live agent task with a model and clear limits, or a simulation to explore the workflow. Files, browsers and container code are real; live tasks start only when you run them.</p></> : <Empty icon="search" title="No tasks match this view" action={<button className="button" onClick={() => { setFilter('all'); setSearch(''); }}>Clear filters</button>}>Try another status or search term.</Empty>}</div>}
      </div>}

      {view === 'tasks' && task && <div className="task-detail">
        <header className="task-header"><div className="task-header-main"><button className="text-button back-link" onClick={() => setTaskId(null)}><Icon name="back" size={14} /> Back to tasks</button><h1 title={task.objective}>{task.objective.split(/\r?\n/)[0]}</h1><div className="task-meta"><span className="owner-inline"><Avatar name={taskAgent?.name || 'Agent'} />{taskAgent?.name}</span><Badge state={task.state} ready={Boolean(isLiveTask && currentLiveRun && task.state === 'paused' && !hasLiveProgress(currentLiveRun))} /><ModeBadge live={Boolean(isLiveTask)} /><span className="privacy-label"><Icon name="shield" size={13} /> Private</span></div></div><div className="task-control-buttons">{isLiveTask && <button className="button small" disabled={workflows.busy} onClick={() => { workflows.clearError(); setModal('saveWorkflow'); }}>Save workflow</button>}{isLiveTask ? !terminalStates.includes(task.state) && <><button className="button small" disabled={busy || live.busy || task.state === 'pausing' || (!currentLiveRun?.enabled && (task.state === 'waiting' || !(currentLiveRun?.modelConfigured ?? live.state?.credentialConfigured)))} onClick={() => void live.perform({ type: currentLiveRun?.enabled ? 'live.pause' : 'live.start', taskId: task.id })}><Icon name={currentLiveRun?.enabled ? 'pause' : 'play'} size={14} />{task.state === 'pausing' ? 'Pausing' : currentLiveRun?.enabled ? 'Pause' : task.state === 'paused' && hasLiveProgress(currentLiveRun) ? 'Resume' : 'Run agent'}</button><button className="button small danger-outline" disabled={busy || live.busy} onClick={() => void live.perform({ type: 'live.stop', taskId: task.id })}><Icon name="stop" size={13} /> Stop</button></> : <>{task.state === 'paused' ? <button className="button small" disabled={busy} onClick={() => void command({ type: 'tasks.resume', taskId: task.id })}><Icon name="play" size={14} /> Resume</button> : !terminalStates.includes(task.state) && <button className="button small" disabled={busy || task.state === 'pausing'} onClick={() => void command({ type: 'tasks.pause', taskId: task.id })}><Icon name="pause" size={14} />{task.state === 'pausing' ? 'Pausing' : 'Pause'}</button>}{!terminalStates.includes(task.state) && <button className="button small danger-outline" disabled={busy} onClick={() => void command({ type: 'tasks.cancel', taskId: task.id })}><Icon name="stop" size={13} /> Stop</button>}</>}<button className={'icon-button panel-toggle' + (panelOpen ? ' selected' : '')} aria-label={panelOpen ? 'Hide work panel' : 'Show work panel'} aria-pressed={panelOpen} onClick={() => setPanelOpen(!panelOpen)}><Icon name="panel" /></button></div></header>
        <div className={'task-columns' + (!panelOpen ? ' panel-collapsed' : '')} style={{ '--work-width': panelWidth + 'px' } as CSSProperties}>
          <section className="conversation-column" aria-label="Task conversation"><div className="conversation-scroll"><div className="conversation-date"><span />{date(task.createdAt)}<span /></div>{task.completionCriteria && <details className="outcome-details"><summary>Desired outcome</summary><p>{task.completionCriteria}</p></details>}
            {taskMessages.map(item => <article key={item.id} className={'conversation-message message-' + item.role}>{item.role === 'system' ? <div className="system-message"><Icon name="activity" size={13} /><p>{item.content}</p></div> : <><div className="message-avatar">{item.role === 'owner' ? <span className="owner-avatar">Y</span> : <Avatar name={taskAgent?.name || 'Agent'} />}</div><div className="message-copy"><header><strong>{item.role === 'owner' ? 'You' : taskAgent?.name || 'Agent'}</strong><time>{time(item.createdAt)}</time>{item.role === 'agent' && <span className="small-simulation">{isLiveTask ? 'Live agent' : 'Simulation'}</span>}{isLiveTask && item.role === 'owner' && item.deliveryState && <span className={'instruction-state ' + item.deliveryState}>{item.deliveryState === 'pending' ? 'Queued for next step' : 'Included in next decision'}</span>}</header><p>{item.content}</p></div></>}</article>)}
            {!taskMessages.length && <p className="subtle conversation-placeholder">This task is saved. Its progress will appear here.</p>}
            {unavailableRequests.filter(r => r.taskId === task.id).map(r => <div key={r.id} className="request-card" role="status"><h3>{r.title}</h3><p>{requests.loadError || 'Loading this structured request…'}</p><button className="button" onClick={() => void requests.refresh()}>Retry loading request</button></div>)}
            {taskRequests.map(request => <RequestCard key={request.id} request={request} agent={taskAgent} task={task} busy={busy} onRespond={respond} onOpenBrowser={() => { setPanel('browser'); setPanelOpen(true); }} onOpenCode={() => { setPanel('activity'); setPanelOpen(true); }} />)}
            {structuredTaskRequests.map(request => <StructuredRequestCard key={request.id} request={request} agent={taskAgent} task={task} snapshot={snapshot} controller={requests} onOpenBrowser={() => { setPanel('browser'); setPanelOpen(true); }} onOpenCode={() => { setPanel('activity'); setPanelOpen(true); }} />)}
            <div ref={conversationEnd} />
          </div><form className="message-composer" onSubmit={async event => { event.preventDefault(); if (message.trim() && await command({ type: 'tasks.message', taskId: task.id, content: message.trim() })) setMessage(''); }}><label className="sr-only" htmlFor="task-message">Message {taskAgent?.name || 'agent'}</label><textarea id="task-message" rows={2} placeholder={terminalStates.includes(task.state) ? 'This task has ended.' : 'Add direction for ' + (taskAgent?.name || 'this agent') + '…'} value={message} maxLength={4000} disabled={busy || terminalStates.includes(task.state)} onChange={event => setMessage(event.target.value)} /><div className="composer-bottom"><span>{terminalStates.includes(task.state) ? 'This task has ended. Save a workflow to prepare another run.' : isLiveTask ? 'Saved now, included at the next agent decision. Answer requests in their cards.' : 'Saved to this simulation task. Answer requests in their cards.'}</span><button className="send-button" type="submit" disabled={busy || !message.trim() || terminalStates.includes(task.state)} aria-label="Send message"><Icon name="arrow" size={17} /></button></div></form></section>
          {panelOpen && <><div className="panel-resizer" role="separator" aria-label="Resize work panel" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={520} aria-valuenow={panelWidth} tabIndex={0} onPointerDown={changeWidth} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPanelWidth(width => Math.max(280, Math.min(520, width + (event.key === 'ArrowLeft' ? 20 : -20)))); } }} /><aside className="work-panel" aria-label="Agent work panel"><div className="work-tabs" role="tablist" aria-label="Work views">{(['browser', 'files', 'activity', 'collaboration'] as const).filter(value=>!currentLiveRun?.reviewOnly||['files','activity'].includes(value)).map(value => <button key={value} role="tab" aria-selected={panel === value} className={panel === value ? 'selected' : ''} onClick={() => setPanel(value)}><Icon name={value === 'files' ? 'folder' : value === 'collaboration' ? 'message' : value} size={15} />{value[0].toUpperCase() + value.slice(1)}</button>)}</div><div className="work-panel-content" role="tabpanel">
            {panel === 'collaboration' && !currentLiveRun?.reviewOnly ? <TaskCollaboration key={task.id} task={task} snapshot={snapshot} controller={collaboration} onOpenTask={openTask} /> : panel === 'activity' ? <>{isLiveTask && !currentLiveRun?.reviewOnly && !terminalStates.includes(task.state) && <TaskReadiness bridge={bridge} snapshot={snapshot} task={task} onAction={action => { if(action==='settings') navigate('settings'); else if(action==='projects') navigate('projects'); else {setPanel(action==='browser'?'browser':action==='files'?'files':'activity');setPanelOpen(true);} }} />}{isLiveTask && task.state==='succeeded' && <button className="button primary" onClick={()=>setView('results')}>Review result</button>}{isLiveTask&&currentLiveRun?.policy.mailAccount&&<TaskMailReview bridge={bridge} run={currentLiveRun} />}{isLiveTask && <BrowserActionReview bridge={bridge} taskId={task.id} snapshot={snapshot} />}{isLiveTask && <ExactGrants bridge={bridge} taskId={task.id} />}{isLiveTask && <AgentRunPanel task={task} run={currentLiveRun} controller={live} waitingMessage={waitingLabel(task, allRequests)} />}{!currentLiveRun?.reviewOnly && <CodePanel key={task.id} bridge={bridge} snapshot={snapshot} task={task} onFiles={() => setPanel('files')} />}{currentLiveRun?.reviewOnly&&<p className="subtle">Fleet work uses its selected files and exact approved report handoffs. Open Fleets to review its team and next work item.</p>}<div className="panel-heading code-activity-divider"><h2>Task progress</h2><span className="small-simulation">{isLiveTask ? 'Live task' : 'Local simulation'}</span></div><div className="current-progress"><span className={'task-symbol state-' + task.state}><Icon name={task.state === 'waiting' ? 'message' : task.state === 'succeeded' ? 'check' : 'activity'} size={17} /></span><div><strong>{isLiveTask && currentLiveRun && task.state === 'paused' && !hasLiveProgress(currentLiveRun) ? 'Ready to run' : stateLabels[task.state]}</strong><p>{waitingLabel(task, allRequests) || (task.state === 'paused' ? isLiveTask && !hasLiveProgress(currentLiveRun) ? 'Ready to run. Your task brief and limits are saved.' : 'Progress saved at a checkpoint.' : task.state === 'cancelled' ? 'No more steps will run for this task.' : task.state === 'succeeded' ? isLiveTask ? 'The result is ready for your review.' : 'The simulated task completed its example steps.' : 'Following the saved task lifecycle.')}</p></div></div><div className="activity-timeline">{events.map(event => <div className="activity-item" key={event.id}><span className="timeline-dot" /><div><p>{eventLabel(event)}</p><time>{time(event.createdAt)}</time></div></div>)}{!events.length && <p className="subtle">Activity will appear as this task advances.</p>}</div><details className="technical-details"><summary>Saved progress details</summary><dl><dt>Checkpoint</dt><dd>{task.checkpoint}</dd><dt>Run generation</dt><dd>{task.generation}</dd><dt>Task revision</dt><dd>{task.revision}</dd></dl></details></> : panel === 'browser' && !currentLiveRun?.reviewOnly ? <BrowserPanel key={task.id} bridge={bridge} snapshot={snapshot} task={task} onFiles={() => setPanel('files')} /> : <TaskFiles task={task} />}
          </div></aside></>}
        </div>
      </div>}

      {view === 'requests' && <div className="page-scroll"><section className="page-heading"><div><span className="eyebrow">KEEP WORK MOVING</span><h1>Requests <span className="heading-count">{requestAttention}</span></h1><p>A little context from you helps your agents continue.</p></div><span className="privacy-label"><Icon name="shield" size={14} /> Responses stay with their task</span></section><BrowserActionReview bridge={bridge} snapshot={snapshot} />{unavailableRequests.map(r => <div key={r.id} className="request-card" role="status"><h3>{r.title}</h3><p>{requests.loadError || 'Loading this structured request…'}</p><button className="button" onClick={() => void requests.refresh()}>Retry loading request</button></div>)}{requests.error && <div className="agent-run-error" role="alert">{requests.error}<button className="inline-link" onClick={() => { requests.clearError(); void requests.refresh(); }}>Refresh requests</button></div>}{openRequests.length ? <div className="requests-grid">{openRequests.map(request => { const relatedTask = snapshot.tasks.find(item => item.id === request.taskId); return isStructuredRequest(request) ? <StructuredRequestCard key={request.id} request={request} agent={snapshot.agents.find(item => item.id === request.agentId)} task={relatedTask} snapshot={snapshot} controller={requests} onOpen={relatedTask ? () => openTask(relatedTask) : undefined} onOpenBrowser={relatedTask ? () => { openTask(relatedTask); setPanel('browser'); setPanelOpen(true); } : undefined} onOpenCode={relatedTask ? () => { openTask(relatedTask); setPanel('activity'); setPanelOpen(true); } : undefined} /> : <RequestCard key={request.id} request={request} agent={snapshot.agents.find(item => item.id === request.agentId)} task={relatedTask} busy={busy} onRespond={respond} onOpen={relatedTask ? () => openTask(relatedTask) : undefined} onOpenBrowser={relatedTask ? () => { openTask(relatedTask); setPanel('browser'); setPanelOpen(true); } : undefined} onOpenCode={relatedTask ? () => { openTask(relatedTask); setPanel('activity'); setPanelOpen(true); } : undefined} />; })}</div> : browserAttention === 0 && unavailableRequests.length === 0 && requests.loadStatus === 'loaded' ? <div className="quiet-empty"><Empty icon="check" title="You’re all caught up">Files, clarification, browser handoff and approval requests appear here and in the task conversation.</Empty></div> : null}{allRequests.some(request => !requestIsPending(request.state)) && <section className="past-requests"><h2>Previously answered or closed</h2>{allRequests.filter(request => !requestIsPending(request.state)).map(request => { const relatedTask = snapshot.tasks.find(item => item.id === request.taskId); return <button className="past-request-row" key={request.id} onClick={() => relatedTask && openTask(relatedTask)}><Icon name={request.state === 'fulfilled' ? 'check' : 'stop'} size={15} /><span>{request.title}<small>{snapshot.agents.find(item => item.id === request.agentId)?.name}</small></span><span className="subtle">{request.state === 'fulfilled' ? request.type === 'browser_handoff' ? 'Control returned' : request.type === 'permission_change' ? 'Verified' : request.type === 'files' ? 'Files accepted' : 'Answered' : 'Closed'}</span><Icon name="arrow" size={15} /></button>; })}</section>}</div>}
      {view === 'shared' && <SharedLibrary />}
      {view === 'board' && <SharedBoard snapshot={snapshot} controller={collaboration} onOpenTask={item => { openTask(item); setPanel('collaboration'); setPanelOpen(true); }} />}
      {view === 'inboxes' && <AgentInbox agentId={agentId} onAgentChange={setAgentId} snapshot={snapshot} controller={collaboration} onOpenTask={item => { openTask(item); setPanel('collaboration'); setPanelOpen(true); }} />}
      {view === 'settings' && <div className="page-scroll settings-page"><section className="page-heading"><div><span className="eyebrow">MAKE THIS SPACE YOURS</span><h1>Settings</h1><p>Your model connection, appearance, and optional simulation.</p></div></section><KeySettings bridge={bridge} configured={Boolean(live.state?.legacyCredentialConfigured)} active={snapshot.tasks.some(t=>t.executionMode==='live'&&['running','queued','pausing'].includes(t.state))} onChanged={()=>void live.refresh()} />{providerApi && <ProviderSettings api={providerApi} active={Boolean(live.state?.busy)||snapshot.tasks.some(t=>t.executionMode==='live'&&['running','queued','pausing'].includes(t.state))} onChanged={()=>void live.refresh()} />}<ModelSettings controller={live} /><GmailConnection settings /><Connections bridge={bridge} snapshot={snapshot} projects={projects} /><section className="settings-section"><div className="settings-section-title"><Icon name="sun" /><h2>Appearance</h2></div><div className="setting-row"><div><strong>Theme</strong><p>Follow your Mac or choose an appearance.</p></div><select aria-label="Theme" value={snapshot.settings.theme} disabled={busy} onChange={event => void command({ type: 'settings.update', settings: { theme: event.target.value as Snapshot['settings']['theme'] } })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div></section><section className="settings-section"><div className="settings-section-title"><Icon name="activity" /><h2>Simulation</h2><span className="simulation-badge"><span /> Local driver</span></div><p className="setting-intro">A deterministic local driver exercises waiting, responses, pause, stop, and recovery. It does not contact a model or operate a browser.</p><div className="setting-row"><div><strong>Advance automatically</strong><p>Turn off to move one step at a time.</p></div><button className={'toggle-switch' + (snapshot.settings.driverEnabled ? ' on' : '')} role="switch" aria-checked={snapshot.settings.driverEnabled} aria-label="Advance simulation automatically" disabled={busy} onClick={() => void command({ type: 'settings.update', settings: { driverEnabled: !snapshot.settings.driverEnabled } })}><span /></button></div><div className="setting-row"><div><strong>Active agents</strong><p>Maximum agents advancing at the same time.</p></div><select aria-label="Maximum active agents" value={snapshot.settings.maxActiveAgents} disabled={busy} onChange={event => void command({ type: 'settings.update', settings: { maxActiveAgents: Number(event.target.value) } })}>{[1, 2].map(value => <option key={value} value={value}>{value} {value === 1 ? 'agent' : 'agents'}</option>)}</select></div></section><section className="settings-section"><div className="settings-section-title"><Icon name="shield" /><h2>Local storage</h2></div><StorageUsage /><RecoverySettings bridge={bridge} /><div className="setting-row storage-row"><div><strong>Application data</strong><p>Your saved workspace stays on this Mac.</p><code>{snapshot.runtime.dataRoot}</code></div><span className="local-chip"><span className="live-dot" /> Local</span></div></section></div>}
      <footer className="workspace-footer"><span><Icon name="shield" size={12} /> Local task state</span><span>{snapshot.tasks.some(item => item.executionMode === 'live') ? 'Selected model connection · Per-task limits' : 'Simulation tasks · Live browser, files & code'}</span></footer>
    </main>

    {modal === 'saveWorkflow' && task && <SaveWorkflowDialog task={task} controller={workflows} onClose={() => setModal(null)} onSaved={() => { setModal(null); navigate('workflows'); }} />}
    {modal === 'agent' && <Dialog title="Create an agent" onClose={() => setModal(null)} busy={busy} error={error}><form className="modal-form" onSubmit={async event => { event.preventDefault(); const known = new Set(snapshot.agents.map(item => item.id)); const next = await command({ type: 'agents.create', name: agentName.trim(), instructions: instructions.trim() }); if (next) { const created = next.agents.find(item => !known.has(item.id)); setAgentId(created?.id || null); setTaskId(null); setView('tasks'); if (created && createTaskAfterAgent.current) { createTaskAfterAgent.current = false; setNewTaskAgent(created.id); setObjective(''); setCriteria(''); setLiveDraft(newLiveTaskDraft(live.state?.defaultModel)); setNewTaskMode('live'); setModal('task'); } else setModal(null); setAgentName(''); setInstructions(''); } }}><p className="modal-description">Give your agent a name and a little direction. Its tasks and workspace stay separate from other agents.</p><label>Agent name<input autoFocus required maxLength={80} placeholder="e.g. Research assistant" value={agentName} onChange={event => setAgentName(event.target.value)} disabled={busy} /></label><label>Instructions <span className="optional">Optional</span><textarea rows={4} maxLength={4000} placeholder="What should this agent focus on? How should it work?" value={instructions} onChange={event => setInstructions(event.target.value)} disabled={busy} /></label><div className="form-note"><Icon name="activity" size={16} /><span>Choose live or simulation when you create a task. Each agent keeps its own browser and private files.</span></div><div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button primary" disabled={busy || !agentName.trim()}>{busy ? 'Creating…' : 'Create agent'}<Icon name="arrow" size={15} /></button></div></form></Dialog>}
    {modal === 'task' && <Dialog title="Give your agent a task" onClose={() => setModal(null)} busy={busy || live.busy} error={error || live.error}><form className="modal-form" onSubmit={async event => {
      event.preventDefault();
      const known = new Set(snapshot.tasks.map(item => item.id));
      if (newTaskMode === 'live') {
        const created = await live.perform({ type: 'live.createTask', agentId: newTaskAgent, objective: objective.trim(), completionCriteria: criteria.trim(), model: liveDraft.model, policy: { ...(liveDraft.reviewedActions&&liveDraft.policyMode==='workspace'?{browserInteraction:'reviewed_actions' as const}:{}), mode: liveDraft.policyMode, allowedOrigins: liveDraft.origins.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }, limits: liveDraft.limits });
        if (created) { const next = await command({ type: 'snapshot' }); const task = next?.tasks.find(item => !known.has(item.id)); if (task) { openTask(task); setPanel('activity'); setPanelOpen(true); } setModal(null); }
      } else { const next = await command({ type: 'tasks.create', agentId: newTaskAgent, objective: objective.trim(), completionCriteria: criteria.trim(), scenario }); if (next) { const created = next.tasks.find(item => !known.has(item.id)); if (created) openTask(created); setModal(null); } }
    }}><label>Assign to<select value={newTaskAgent} onChange={event => setNewTaskAgent(event.target.value)} disabled={busy || live.busy} required>{snapshot.agents.filter(item=>!item.archived).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="live-task-mode" role="group" aria-label="Task execution mode"><button type="button" className={newTaskMode === 'live' ? 'selected' : ''} aria-pressed={newTaskMode === 'live'} disabled={busy || live.busy} onClick={() => { setNewTaskMode('live'); if (!liveDraft.model) setLiveDraft({ ...liveDraft, model: live.state?.defaultModel || '' }); }}><strong>Live agent</strong><span>Real model and permitted tools</span></button><button type="button" className={newTaskMode === 'simulation' ? 'selected' : ''} aria-pressed={newTaskMode === 'simulation'} disabled={busy || live.busy} onClick={() => setNewTaskMode('simulation')}><strong>Simulation</strong><span>Explore the saved task workflow</span></button></div>
      <label>What should the agent accomplish?<textarea autoFocus rows={3} required maxLength={2000} placeholder="Describe the outcome you want…" value={objective} onChange={event => setObjective(event.target.value)} disabled={busy || live.busy} /></label><label>What does done look like? {newTaskMode === 'simulation' && <span className="optional">Optional</span>}<input required={newTaskMode === 'live'} maxLength={2000} placeholder="A result you can review and use" value={criteria} onChange={event => setCriteria(event.target.value)} disabled={busy || live.busy} /></label>
      {newTaskMode === 'live' ? <LiveTaskOptions draft={liveDraft} onChange={setLiveDraft} state={live.state} disabled={busy || live.busy} /> : <><label>Simulation scenario<select value={scenario} onChange={event => setScenario(event.target.value as Scenario)} disabled={busy}><option value="clarification">Ask for clarification, then continue</option><option value="complete">Complete without asking for input</option><option value="failure">Exercise a failure</option></select></label><div className="form-note"><Icon name="activity" size={16} /><span>This task follows a local simulation. It makes no model calls.</span></div></>}
      <div className="modal-actions"><button type="button" className="button" disabled={busy || live.busy} onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button primary" disabled={busy || live.busy || !objective.trim() || !newTaskAgent || (newTaskMode === 'live' && (!criteria.trim() || !liveDraft.model))}>{busy || live.busy ? 'Creating…' : newTaskMode === 'live' ? 'Save live task' : 'Create simulation'}<Icon name="arrow" size={15} /></button></div></form></Dialog>}
  </div></GmailProvider></FilesProvider>;
}
