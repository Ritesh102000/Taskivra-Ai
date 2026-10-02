import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppBridge, Snapshot, Task } from '../../../packages/contracts/index';
import type { CollaborationCommand, CollaborationState } from '../../../packages/contracts/collaboration';
import { useFilePreview } from './Files';
import './collaboration.css';

/** Owner read model only. Components never derive a shared summary from private chat. */
export function useCollaboration(bridge?: AppBridge, agentId?:string|null) {
  const [state, setState] = useState<CollaborationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), reading = useRef(false), lock = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!bridge || lock.current || reading.current) return;
    const ticket = ++sequence.current;
    reading.current = true;
    try {
      const next = await bridge.collaboration({ type: 'collaboration.state',...(agentId?{agentId}:{}) });
      if (alive.current && ticket === sequence.current) setState(next);
    } catch (failure) {
      if (alive.current && ticket === sequence.current) setError(failure instanceof Error ? failure.message : 'Collaboration state could not be loaded.');
    } finally { reading.current = false; }
  }, [bridge,agentId]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = bridge?.onChanged(() => void refresh());
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 2500);
    return () => { alive.current = false; sequence.current++; off?.(); clearInterval(timer); };
  }, [bridge, refresh]);
  const perform = async (command: CollaborationCommand) => {
    if (!bridge || lock.current) return null;
    lock.current = true; sequence.current++; setBusy(true); setError(null);
    try {
      const next = await bridge.collaboration(command);
      if (alive.current) setState(next);
      return next;
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : 'The collaboration action could not finish. Refresh before trying again.');
      return null;
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return { state, error, busy, refresh, perform, clearError: () => setError(null) };
}
export type CollaborationController = ReturnType<typeof useCollaboration>;
type Common = { snapshot: Snapshot; controller: CollaborationController; onOpenTask: (task: Task) => void };
const taskLabels: Record<Task['state'], string> = { queued: 'Queued', running: 'Working', waiting: 'Waiting', pausing: 'Pausing', paused: 'Paused', recovering: 'Recovering', succeeded: 'Completed', failed: 'Failed', cancelled: 'Stopped' };
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const finished = (task: Task) => ['succeeded', 'failed', 'cancelled'].includes(task.state);
const when = (value: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value);
function Status({ controller }: { controller: CollaborationController }) {
  if (controller.error) return <div className="collaboration-notice error" role="alert"><span>{controller.error}</span><button className="inline-link" disabled={controller.busy} onClick={() => { controller.clearError(); void controller.refresh(); }}>Refresh</button></div>;
  if (!controller.state) return <p className="collaboration-note" role="status">Loading saved collaboration…</p>;
  return null;
}

function PolicyEditor({ task, snapshot, controller }: Common & { task: Task }) {
  const saved = controller.state?.policies.find(item => item.taskId === task.id);
  const [revision, setRevision] = useState(saved?.revision ?? 1);
  const [visibility, setVisibility] = useState<'private' | 'shared'>(saved?.visibility ?? 'private');
  const [summary, setSummary] = useState(saved?.summary ?? '');
  const [peers, setPeers] = useState<string[]>(saved?.peerAgentIds ?? []);
  const [dirty, setDirty] = useState(false), [notice, setNotice] = useState('');
  const load = () => { setRevision(saved?.revision ?? 1); setVisibility(saved?.visibility ?? 'private'); setSummary(saved?.summary ?? ''); setPeers(saved?.peerAgentIds ?? []); setDirty(false); setNotice(''); };
  useEffect(() => { if (!dirty) load(); }, [saved?.revision]);
  const stale = dirty && revision !== (saved?.revision ?? 1);
  const summaryTooLong = byteLength(summary.trim()) > 240;
  const change = () => { setDirty(true); setNotice(''); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = await controller.perform({ type: 'collaboration.policy', taskId: task.id, revision, visibility, summary: summary.trim(), peerAgentIds: peers });
    if (next) { const policy = next.policies.find(item => item.taskId === task.id); setRevision(policy?.revision ?? revision); setDirty(false); setNotice('Collaboration permissions saved.'); }
  };
  return <form className="collaboration-form" onSubmit={event => void submit(event)}>
    <label>Task visibility<select value={visibility} disabled={controller.busy} onChange={event => { setVisibility(event.target.value as 'private' | 'shared'); change(); }}><option value="private">Private task</option><option value="shared">Show on shared board</option></select></label>
    <label>Shareable summary<textarea rows={3} value={summary} maxLength={240} required={visibility === 'shared'} placeholder="Only the brief context other agents should see" disabled={controller.busy} onChange={event => { setSummary(event.target.value); change(); }} /></label>
    {summaryTooLong && <p className="collaboration-blocker" role="status">This summary is too long. Shorten it before saving.</p>}
    <p className="collaboration-note">The board shows this summary, status and published versions. Your task conversation, private inputs and browser pages stay private.</p>
    <fieldset disabled={controller.busy}><legend>Allowed collaborators</legend>{snapshot.agents.filter(agent => agent.id !== task.agentId).map(agent => <label className="collaboration-check" key={agent.id}><input type="checkbox" checked={peers.includes(agent.id)} disabled={!peers.includes(agent.id) && peers.length >= 32} onChange={event => { setPeers(current => event.target.checked ? [...current, agent.id] : current.filter(id => id !== agent.id)); change(); }} /><span>{agent.name}<small>Allow scoped messages and shared-file handoffs for this task.</small></span></label>)}{snapshot.agents.length < 2 && <p className="collaboration-note">Create another agent to grant collaboration access.</p>}</fieldset>
    <p className="collaboration-note">A collaborator grant does not publish private files. Publish an exact version first; each receiving task pins the version it uses.</p>
    {stale && <p className="collaboration-blocker" role="status">This policy changed while you were editing. Load the saved policy before making another change.</p>}
    <div className="collaboration-form-actions"><button className="button primary small" disabled={controller.busy || !dirty || stale || summaryTooLong || (visibility === 'shared' && !summary.trim())}>Save permissions</button>{dirty && <button className="button small" type="button" disabled={controller.busy} onClick={load}>{stale ? 'Load saved policy' : 'Discard changes'}</button>}</div>
    {notice && <p className="collaboration-policy-status" role="status">{notice}</p>}
  </form>;
}

export function TaskCollaboration({ task, snapshot, controller, onOpenTask }: Common & { task: Task }) {
  const [upstreamId, setUpstreamId] = useState(''), [requiredVersion, setRequiredVersion] = useState('');
  const [consumeVersion, setConsumeVersion] = useState(''), [notice, setNotice] = useState('');
  const preview = useFilePreview();
  const dependencyEditingBlocked = finished(task) || ['running', 'pausing', 'recovering'].includes(task.state);
  const dependencies = controller.state?.dependencies.filter(item => item.taskId === task.id) ?? [];
  const shared = snapshot.artifacts.filter(item => item.visibility === 'shared' && item.status === 'ready');
  const candidates = snapshot.tasks.filter(item => item.id !== task.id && !dependencies.some(dependency => dependency.dependsOnTaskId === item.id));
  const sourceVersions = shared.filter(item => item.producerTaskId === upstreamId);
  const linked = snapshot.taskArtifacts.filter(item => item.taskId === task.id);
  const selected = shared.find(item => item.id === consumeVersion);
  const operation = async (command: CollaborationCommand, message: string) => { setNotice(''); if (await controller.perform(command)) { setNotice(message); return true; } return false; };
  if (!controller.state) return <Status controller={controller} />;
  return <div className="collaboration-panel"><Status controller={controller} /><section className="collaboration-panel-section"><h2>Collaboration</h2><p className="collaboration-note">You choose what this task shares and which agents it works with.</p><PolicyEditor task={task} snapshot={snapshot} controller={controller} onOpenTask={onOpenTask} /></section>
    <section className="collaboration-panel-section"><h3>Task dependencies</h3><p className="collaboration-note">This task waits for each upstream task and any required published version. Removing a dependency changes its requirements.</p>{dependencyEditingBlocked && <p className="collaboration-blocker">{finished(task) ? 'This task has ended. Its saved dependencies are read-only.' : 'Pause this task before editing its dependencies.'}</p>}
      {dependencies.map(dependency => {
        const upstream = snapshot.tasks.find(item => item.id === dependency.dependsOnTaskId);
        const version = snapshot.artifacts.find(item => item.id === dependency.requiredVersionId);
        const descriptions = { pending: 'Waiting for the upstream task to finish.', ready: 'Upstream requirement satisfied.', upstream_failed: 'Upstream task failed. Resolve it or remove this requirement.', upstream_cancelled: 'Upstream task was stopped. Resolve it or remove this requirement.', artifact_unavailable: 'The required published version is missing or unavailable.' };
        return <div className="collaboration-dependency" key={dependency.dependsOnTaskId}><div className="collaboration-dependency-top"><strong>{upstream ? <button className="inline-link" onClick={() => onOpenTask(upstream)}>{upstream.objective}</button> : 'Unavailable upstream task'}</strong><button className="inline-link" disabled={controller.busy || dependencyEditingBlocked} onClick={() => void operation({ type: 'collaboration.dependency.remove', taskId: task.id, dependsOnTaskId: dependency.dependsOnTaskId }, 'Dependency removed. Other blockers still apply.')}>Remove</button></div>{dependency.requiredVersionId && <p className="collaboration-note">Required: {version ? `${version.displayName} · v${version.version}` : 'Exact published version unavailable'}</p>}<p className={'collaboration-blocker ' + (dependency.status === 'ready' ? 'ready' : dependency.status === 'pending' ? '' : 'failed')}>{descriptions[dependency.status]}</p></div>;
      })}
      {!dependencies.length && <p className="collaboration-note">No upstream tasks required.</p>}
      <form className="collaboration-form" onSubmit={async event => { event.preventDefault(); if (upstreamId && await operation({ type: 'collaboration.dependency.add', taskId: task.id, dependsOnTaskId: upstreamId, requiredVersionId: requiredVersion || null }, 'Dependency added.')) { setUpstreamId(''); setRequiredVersion(''); } }}><label>Wait for task<select value={upstreamId} required disabled={controller.busy || dependencyEditingBlocked} onChange={event => { setUpstreamId(event.target.value); setRequiredVersion(''); }}><option value="">Choose an upstream task</option>{candidates.map(item => <option key={item.id} value={item.id}>{snapshot.agents.find(agent => agent.id === item.agentId)?.name} · {item.objective}</option>)}</select></label><label>Required shared output<select value={requiredVersion} disabled={controller.busy || dependencyEditingBlocked || !upstreamId} onChange={event => setRequiredVersion(event.target.value)}><option value="">Task completion only</option>{sourceVersions.map(item => <option key={item.id} value={item.id}>{item.displayName} · v{item.version}</option>)}</select></label><button className="button small" disabled={controller.busy || dependencyEditingBlocked || !upstreamId}>Add dependency</button></form>
    </section>
    <section className="collaboration-panel-section"><h3>Use a published version</h3><p className="collaboration-note">An exact shared version becomes this task’s input. Later publications do not change an active run’s pinned files.</p><form className="collaboration-form" onSubmit={async event => { event.preventDefault(); if (consumeVersion && await operation({ type: 'collaboration.consume', taskId: task.id, versionId: consumeVersion }, 'Exact shared version pinned to this task.')) setConsumeVersion(''); }}><label>Published file<select value={consumeVersion} required disabled={controller.busy || finished(task)} onChange={event => setConsumeVersion(event.target.value)}><option value="">Choose an exact shared version</option>{shared.filter(item => !linked.some(link => link.versionId === item.id)).map(item => <option key={item.id} value={item.id}>{item.displayName} · v{item.version} · {snapshot.agents.find(agent => agent.id === item.ownerAgentId)?.name || 'Owner'}</option>)}</select></label>{selected && <p className="collaboration-note">From {snapshot.agents.find(agent => agent.id === selected.ownerAgentId)?.name || 'owner'} · <button className="inline-link" type="button" onClick={() => preview(selected.id)}>Preview v{selected.version}</button></p>}<button className="button small" disabled={controller.busy || finished(task) || !consumeVersion}>Pin selected version</button></form>
      {linked.map(link => shared.find(item => item.id === link.versionId)).filter(item => !!item).map(item => <button className="collaboration-version" key={item.id} onClick={() => preview(item.id)}><span>{item.displayName}</span><small>v{item.version} · Pinned</small></button>)}
    </section>{notice && <div className="collaboration-notice success" role="status">{notice}</div>}
  </div>;
}

export function SharedBoard({ snapshot, controller, onOpenTask }: Common) {
  const [agentId, setAgentId] = useState('');
  const preview = useFilePreview();
  const board = controller.state?.board.filter(item => !agentId || item.agentId === agentId) ?? [];
  const artifacts = controller.state?.sharedArtifacts ?? [];
  return <div className="page-scroll collaboration-page"><section className="page-heading"><div><span className="eyebrow">SHARED AWARENESS</span><h1>Shared board</h1><p>Owner-approved summaries, dependencies and published results. Private conversations and input files are excluded.</p></div><button className="button small" disabled={controller.busy} onClick={() => void controller.refresh()}>Refresh board</button></section><Status controller={controller} />
    <div className="collaboration-toolbar"><label>Agent<select value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">All agents</option>{snapshot.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><span className="collaboration-note">{board.length} shared {board.length === 1 ? 'task' : 'tasks'} · Set visibility in a task’s Collaboration panel.</span></div>
    {board.length ? <div className="collaboration-board">{board.map(item => {
      const task = snapshot.tasks.find(candidate => candidate.id === item.taskId);
      const blocked = item.dependencies.filter(dependency => dependency.status !== 'ready');
      return <article className="collaboration-card" key={item.taskId}><div className="collaboration-card-header"><span className="collaboration-card-agent">{item.agentName}</span><span className={'state-badge state-' + item.state}><span className="status-dot" />{taskLabels[item.state]}</span></div><h2>{task ? <button onClick={() => onOpenTask(task)} title="Open owner task controls">{item.summary}</button> : item.summary}</h2>{blocked.map(dependency => <p className={'collaboration-blocker' + (dependency.status === 'pending' ? '' : ' failed')} key={dependency.dependsOnTaskId}>{dependency.explanation}</p>)}
        {item.publishedVersionIds.length > 0 && <div className="collaboration-published">{item.publishedVersionIds.map(id => { const artifact = artifacts.find(version => version.versionId === id); return artifact ? <button className="collaboration-version" key={id} onClick={() => preview(id)}><span>{artifact.displayName}</span><small>v{artifact.version} · Shared</small></button> : <span className="collaboration-note" key={id}>A published version is unavailable.</span>; })}</div>}
        <div className="collaboration-card-footer"><span>{item.dependencies.length} {item.dependencies.length === 1 ? 'dependency' : 'dependencies'}</span><span>{item.publishedVersionIds.length} published {item.publishedVersionIds.length === 1 ? 'version' : 'versions'}</span>{task && <button className="inline-link" onClick={() => onOpenTask(task)}>Task controls</button>}</div></article>;
    })}</div> : controller.state && <div className="collaboration-empty"><h2>{agentId ? 'No shared tasks for this agent' : 'Choose what your agents can share'}</h2><p>Open a task’s Collaboration panel, write a brief shareable summary and enable shared visibility. Existing tasks stay private until you do.</p></div>}
  </div>;
}

function MessageComposer({ recipientAgentId, snapshot, controller }: { recipientAgentId: string; snapshot: Snapshot; controller: CollaborationController }) {
  const [taskId, setTaskId] = useState(''), [kind, setKind] = useState<'handoff' | 'update' | 'question'>('handoff');
  const [body, setBody] = useState(''), [taskIds, setTaskIds] = useState<string[]>([]), [versionIds, setVersionIds] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const request = useRef<{ payload: string; key: string } | null>(null);
  const sources = snapshot.tasks.filter(task => !finished(task) && task.agentId !== recipientAgentId && controller.state?.policies.some(policy => policy.taskId === task.id && policy.visibility === 'shared' && policy.peerAgentIds.includes(recipientAgentId)));
  const source = sources.find(task => task.id === taskId);
  const sharedTasks = controller.state?.board.filter(task => controller.state?.policies.some(policy => policy.taskId === task.taskId && policy.peerAgentIds.includes(recipientAgentId))) ?? [];
  const versions = controller.state?.sharedArtifacts ?? [];
  const recipient = snapshot.agents.find(agent => agent.id === recipientAgentId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!source || !body.trim()) return;
    const fields = { taskId, recipientAgentId, kind, taskIds, versionIds, body: body.trim() };
    const serialized = JSON.stringify(fields);
    if (request.current?.payload !== serialized) request.current = { payload: serialized, key: crypto.randomUUID() };
    setNotice('');
    if (await controller.perform({ type: 'collaboration.send', ...fields, idempotencyKey: request.current.key })) { setBody(''); setTaskIds([]); setVersionIds([]); request.current = null; setNotice('Your message was delivered to the agent inbox.'); }
  };
  return <form className="collaboration-compose collaboration-form" onSubmit={event => void submit(event)}><h2>Message {recipient?.name || 'agent'}</h2><p className="collaboration-note">Sent as you, with a source task and optional shared references. Messages do not grant access to private files.</p>
    <label>From task<select required value={taskId} disabled={controller.busy} onChange={event => { setTaskId(event.target.value); setNotice(''); }}><option value="">Select an allowed source task</option>{sources.map(task => <option key={task.id} value={task.id}>{snapshot.agents.find(agent => agent.id === task.agentId)?.name} · {controller.state?.policies.find(policy => policy.taskId === task.id)?.summary}</option>)}</select></label>{!sources.length && <p className="collaboration-blocker">No source task grants this agent collaboration access. Set a shared summary and allow this recipient in the source task’s Collaboration panel.</p>}
    <label>Message type<select value={kind} disabled={controller.busy} onChange={event => setKind(event.target.value as typeof kind)}><option value="handoff">Handoff</option><option value="update">Update</option><option value="question">Question</option></select></label><label>Your message<textarea rows={4} maxLength={1000} required value={body} disabled={controller.busy} onChange={event => { setBody(event.target.value); setNotice(''); }} placeholder="Describe the handoff or ask a focused question…" /></label>
    {byteLength(body.trim()) > 1000 && <p className="collaboration-blocker" role="status">This message is too long. Shorten it before sending.</p>}
    <details><summary className="collaboration-note">Attach shared references ({taskIds.length + versionIds.length})</summary><fieldset disabled={controller.busy}><legend>Shared tasks</legend>{sharedTasks.map(task => <label className="collaboration-check" key={task.taskId}><input type="checkbox" checked={taskIds.includes(task.taskId)} disabled={!taskIds.includes(task.taskId) && taskIds.length >= 8} onChange={event => setTaskIds(current => event.target.checked ? [...current, task.taskId] : current.filter(id => id !== task.taskId))} /><span>{task.agentName} · {task.summary}</span></label>)}{!sharedTasks.length && <p className="collaboration-note">No shared task references available.</p>}</fieldset><fieldset disabled={controller.busy}><legend>Exact shared versions</legend>{versions.map(version => <label className="collaboration-check" key={version.versionId}><input type="checkbox" checked={versionIds.includes(version.versionId)} disabled={!versionIds.includes(version.versionId) && versionIds.length >= 8} onChange={event => setVersionIds(current => event.target.checked ? [...current, version.versionId] : current.filter(id => id !== version.versionId))} /><span>{version.displayName}<small>v{version.version} · Published version</small></span></label>)}{!versions.length && <p className="collaboration-note">Publish a private file from its Files panel before sending a reference.</p>}</fieldset></details>
    <button className="button primary small" disabled={controller.busy || !source || !body.trim() || byteLength(body.trim()) > 1000}>Send as owner</button>{notice && <p className="collaboration-note" role="status">{notice}</p>}
  </form>;
}

export function AgentInbox({ agentId, onAgentChange, snapshot, controller, onOpenTask }: Common & { agentId: string | null; onAgentChange: (id: string) => void }) {
  const selectedId = snapshot.agents.some(agent => agent.id === agentId) ? agentId! : snapshot.agents[0]?.id || '';
  const [pinTaskId, setPinTaskId] = useState(''), [notice, setNotice] = useState('');
  const preview = useFilePreview();
  useEffect(() => { setPinTaskId(''); setNotice(''); }, [selectedId]);
  const tasks = snapshot.tasks.filter(task => task.agentId === selectedId && !['succeeded', 'failed', 'cancelled'].includes(task.state));
  const publications = controller.state?.publications.filter(item => item.recipientAgentId === selectedId) ?? [];
  const messages = controller.state?.inbox.filter(item => item.recipientAgentId === selectedId) ?? [];
  const unread = messages.filter(item => item.readAt === null).length + publications.filter(item => item.readAt === null).length;
  const entries = [...messages.map(item => ({ type: 'message' as const, item })), ...publications.map(item => ({ type: 'publication' as const, item }))].sort((a, b) => b.item.createdAt - a.item.createdAt);
  const pin = async (versionId: string) => { if (!tasks.some(task => task.id === pinTaskId)) return; setNotice(''); if (await controller.perform({ type: 'collaboration.consume', taskId: pinTaskId, versionId })) setNotice('Exact version pinned. Existing active runs retain their saved input versions.'); };
  return <div className="page-scroll collaboration-page"><section className="page-heading"><div><span className="eyebrow">SCOPED HANDOFFS</span><h1>Agent inboxes</h1><p>Messages and publication notices addressed to each agent. Every handoff refers to exact shared versions.</p></div><button className="button small" disabled={controller.busy} onClick={() => void controller.refresh()}>Refresh inbox</button></section><Status controller={controller} />
    <div className="collaboration-toolbar"><label>Recipient<select value={selectedId} disabled={!snapshot.agents.length} onChange={event => onAgentChange(event.target.value)}>{!snapshot.agents.length && <option value="">No agents yet</option>}{snapshot.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><span className="collaboration-note">{unread} unread · Owner messages are labelled explicitly.</span></div>
    {notice && <div className="collaboration-notice success" role="status">{notice}</div>}
    {!selectedId ? <div className="collaboration-empty"><h2>Create an agent to use inboxes</h2><p>Agents receive scoped messages and published-file notices here.</p></div> : <div className="collaboration-inbox-layout"><section aria-label="Received messages"><label className="collaboration-note">Pin shared files to <select aria-label="Receiving task for shared files" value={pinTaskId} disabled={controller.busy} onChange={event => setPinTaskId(event.target.value)}><option value="">Choose a receiving task</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.objective}</option>)}</select></label><p className="collaboration-note">Selecting a task does not start it. Use “Pin version” to attach that exact file.</p>
      <div className="collaboration-messages">{entries.map(entry => {
        if (entry.type === 'publication') { const item = entry.item; return <article className={'collaboration-message' + (item.readAt === null ? ' unread' : '')} key={'publication-' + item.id}><header><strong>Published file · {snapshot.agents.find(agent => agent.id === item.artifact.ownerAgentId)?.name || 'Owner'}</strong><time>{when(item.createdAt)}</time></header><p>{item.artifact.displayName} · v{item.artifact.version}</p><div className="collaboration-message-meta"><button className="inline-link" onClick={() => preview(item.versionId)}>Preview version</button><button className="inline-link" disabled={controller.busy || !pinTaskId} onClick={() => void pin(item.versionId)}>Pin version</button>{item.readAt === null ? <button className="inline-link" disabled={controller.busy} onClick={() => void controller.perform({ type: 'collaboration.ack', agentId: selectedId, messageIds: [], publicationIds: [item.id] })}>Mark read</button> : <span>Read</span>}</div></article>; }
        const item = entry.item;
        return <article className={'collaboration-message' + (item.readAt === null ? ' unread' : '')} key={item.id}><header><strong>{item.origin === 'owner' ? 'You · via ' : ''}{snapshot.agents.find(agent => agent.id === item.senderAgentId)?.name || 'Agent'} · {item.kind}</strong><time>{when(item.createdAt)}</time></header><p>{item.body}</p><div className="collaboration-message-meta">{item.taskIds.map(id => { const board = controller.state?.board.find(task => task.taskId === id), task = snapshot.tasks.find(task => task.id === id); return board && task ? <button className="inline-link" key={id} onClick={() => onOpenTask(task)}>{board.summary}</button> : <span key={id}>Task reference unavailable</span>; })}{item.readAt === null ? <button className="inline-link" disabled={controller.busy} onClick={() => void controller.perform({ type: 'collaboration.ack', agentId: selectedId, messageIds: [item.id] })}>Mark read</button> : <span>Read</span>}</div>{item.versionIds.map(id => { const artifact = controller.state?.sharedArtifacts.find(version => version.versionId === id); return artifact ? <div className="collaboration-published" key={id}><button className="collaboration-version" onClick={() => preview(id)}><span>{artifact.displayName}</span><small>v{artifact.version}</small></button><button className="inline-link" disabled={controller.busy || !pinTaskId} onClick={() => void pin(id)}>Pin version</button></div> : <p className="collaboration-note" key={id}>Shared version unavailable.</p>; })}</article>;
      })}{!entries.length && <div className="collaboration-empty"><h3>This inbox is clear</h3><p>Allowed collaborators can send references here. Published-version notices arrive without copying private task history.</p></div>}</div>
    </section><MessageComposer key={selectedId} recipientAgentId={selectedId} snapshot={snapshot} controller={controller} /></div>}
  </div>;
}
