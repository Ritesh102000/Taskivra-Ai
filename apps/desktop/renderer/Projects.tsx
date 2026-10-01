import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppBridge, Snapshot, Task } from '../../../packages/contracts';
import type { ProjectCommand, ProjectsState } from '../../../packages/contracts/projects';
import './projects.css';

type ProjectBridge = Pick<AppBridge, 'onChanged' | 'onGmailChanged' | 'onGoogleWorkspaceChanged'> & { projects(command: ProjectCommand): Promise<ProjectsState> };
export function useProjects(bridge?: ProjectBridge) {
  const [state, setState] = useState<ProjectsState | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), locked = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!bridge || locked.current) return;
    const ticket = ++sequence.current;
    try { const next = await bridge.projects({ type: 'projects.state' }); if (mounted.current && ticket === sequence.current) setState(next); }
    catch (cause) { if (mounted.current && ticket === sequence.current) setError(cause instanceof Error ? cause.message : 'Projects could not be loaded.'); }
  }, [bridge]);
  useEffect(() => { mounted.current = true; void refresh(); const stops = bridge ? [bridge.onChanged(() => void refresh()),bridge.onGmailChanged(() => void refresh()),bridge.onGoogleWorkspaceChanged(() => void refresh())] : []; return () => { mounted.current = false; sequence.current++; for(const stop of stops)stop(); }; }, [bridge, refresh]);
  const perform = async (command: ProjectCommand) => {
    if (!bridge || locked.current) return null;
    locked.current = true; sequence.current++; setBusy(true); setError(null);
    try { const next = await bridge.projects(command); if (mounted.current) setState(next); return next; }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'This project action could not be completed.'); return null; }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  return { state, busy, error, perform, refresh };
}
export type ProjectsController = ReturnType<typeof useProjects>;

export function Projects({ snapshot, controller, onOpenAgent, onOpenTask, onCreateTask }: {
  snapshot: Snapshot; controller: ProjectsController;
  onOpenAgent?: (agentId: string) => void; onOpenTask?: (task: Task) => void; onCreateTask?: (agentId: string) => void;
}) {
  const { state, busy, error, perform } = controller;
  const [selected, setSelected] = useState('personal-workspace'), [name, setName] = useState(''), [description, setDescription] = useState('');
  const [agentName, setAgentName] = useState(''), [instructions, setInstructions] = useState(''), [brief, setBrief] = useState(''), [knowledge, setKnowledge] = useState<string[]>([]);
  const project = state?.projects.find(item => item.id === selected) ?? state?.projects[0];
  useEffect(() => { setBrief(project?.brief?.content || ''); setKnowledge(project?.brief?.knowledgeVersionIds || []); setAgentName(''); setInstructions(''); }, [project?.id, project?.brief?.revision]);
  if (!state) return <section className="projects-page"><h2>Projects</h2>{error ? <p role="alert">{error}</p> : <p>Loading your projects…</p>}</section>;
  const agents = snapshot.agents.filter(agent => project?.agentIds.includes(agent.id));
  const tasks = snapshot.tasks.filter(task => project?.taskIds.includes(task.id));
  const shared = snapshot.artifacts.filter(file => project?.artifactIds.includes(file.artifactId) && file.visibility === 'shared' && file.status === 'ready');
  return <section className="projects-page">
    <header><div><p className="eyebrow">YOUR WORK, KEPT SEPARATE</p><h2>Projects</h2><p>Give each client or area of life its own agents, brief and shared files.</p></div></header>
    {error && <p className="projects-error" role="alert">{error}</p>}
    <div className="projects-layout"><aside className="projects-list" aria-label="Projects">
      {state.projects.map(item => <button key={item.id} className={project?.id === item.id ? 'selected' : ''} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><span>{item.agentIds.length} agents · {item.taskIds.length} tasks</span></button>)}
      <form onSubmit={async event => { event.preventDefault(); const previous = new Set(state.projects.map(item => item.id)); const next = await perform({ type: 'projects.create', name, description }); if (next) { const created = next.projects.find(item => !previous.has(item.id)); if (created) setSelected(created.id); setName(''); setDescription(''); } }}>
        <h3>New project</h3><label>Name<input value={name} maxLength={80} required onChange={event => setName(event.target.value)} placeholder="Client, business or personal work" /></label>
        <label>Description<textarea value={description} maxLength={2000} onChange={event => setDescription(event.target.value)} rows={2} /></label>
        <button type="submit" disabled={busy || !name.trim()}>Create project</button>
      </form>
    </aside>{project && <main className="project-detail">
      <section className="project-card"><h3>{project.name}</h3>{project.description && <p>{project.description}</p>}<p className="project-boundary">Shared files and messages stay within this project. Each agent keeps its own browser profile. Moving existing agents between projects is disabled.</p></section>
      <section className="project-card"><h3>Agents</h3><div className="project-agents">{agents.length ? agents.map(agent => <div key={agent.id}><strong>{agent.name}</strong><span>{snapshot.tasks.filter(task => task.agentId === agent.id).length} tasks</span><div>{onOpenAgent && <button onClick={() => onOpenAgent(agent.id)}>Open agent</button>}{onCreateTask && <button onClick={() => onCreateTask(agent.id)}>New task</button>}</div></div>) : <p>Create the first agent for this project.</p>}</div>
        <form onSubmit={async event => { event.preventDefault(); if (await perform({ type: 'projects.agent.create', projectId: project.id, name: agentName, instructions })) { setAgentName(''); setInstructions(''); } }}>
          <h4>Add an agent</h4><label>Agent name<input value={agentName} onChange={event => setAgentName(event.target.value)} maxLength={80} required placeholder="Research assistant" /></label>
          <label>Agent instructions<textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={8000} rows={2} placeholder="What should this agent focus on?" /></label>
          <button type="submit" disabled={busy || !agentName.trim()}>Create agent in {project.name}</button>
        </form>
      </section>
      <form className="project-card" onSubmit={async event => { event.preventDefault(); await perform({ type: 'projects.brief.save', projectId: project.id, expectedRevision: project.brief?.revision || 0, content: brief, knowledgeVersionIds: knowledge }); }}>
        <h3>Approved project brief</h3><p>Your saved guidance is available to agents in this project. Saving creates a new version.</p>
        <label>Goals, preferences and rules<textarea value={brief} onChange={event => setBrief(event.target.value)} maxLength={8000} rows={6} placeholder="Audience, style, constraints and facts that should guide this project's work." /></label>
        <fieldset><legend>Approved shared references ({knowledge.length}/20)</legend>{shared.length ? shared.map(file => <label className="project-file-choice" key={file.id}><input type="checkbox" checked={knowledge.includes(file.id)} disabled={!knowledge.includes(file.id) && knowledge.length >= 20} onChange={event => setKnowledge(current => event.target.checked ? [...current, file.id] : current.filter(id => id !== file.id))} /><span>{file.displayName} · version {file.version}</span></label>) : <p>Publish a file from one of this project's agents to make it available here. Private files stay private.</p>}</fieldset>
        <p className="project-note">References identify approved versions; attach them to a task to grant that task access to their contents.</p><button disabled={busy} type="submit">Save brief{project.brief ? ` · current version ${project.brief.revision}` : ''}</button>
      </form>
      <section className="project-card"><h3>Approved accounts</h3><p>Connecting an account and approving it for a project are separate owner actions.</p>
        <div className="project-account"><strong>Gmail</strong><span>{project.gmailAccount || 'No account approved'}</span>{state.verifiedAccounts.gmail && <button disabled={busy || project.gmailAccount === state.verifiedAccounts.gmail} onClick={() => void perform({ type: 'projects.gmail.bind', projectId: project.id, account: state.verifiedAccounts.gmail })}>Approve {state.verifiedAccounts.gmail}</button>}{project.gmailAccount && <button disabled={busy} onClick={() => void perform({ type: 'projects.gmail.bind', projectId: project.id, account: null })}>Remove approval</button>}</div>
        <div className="project-account"><strong>Drive and Sheets</strong><span>{project.googleWorkspaceAccount || 'No account approved'}</span>{state.verifiedAccounts.googleWorkspace && <button disabled={busy || project.googleWorkspaceAccount === state.verifiedAccounts.googleWorkspace} onClick={() => void perform({ type: 'projects.google_workspace.bind', projectId: project.id, account: state.verifiedAccounts.googleWorkspace })}>Approve {state.verifiedAccounts.googleWorkspace}</button>}{project.googleWorkspaceAccount && <button disabled={busy} onClick={() => void perform({ type: 'projects.google_workspace.bind', projectId: project.id, account: null })}>Remove approval</button>}</div>
        {!state.verifiedAccounts.gmail && !state.verifiedAccounts.googleWorkspace && <p>Connect an account in its setup panel, then return here to approve it.</p>}
      </section>
      <section className="project-card"><h3>Project tasks</h3>{tasks.length ? <div className="project-tasks">{tasks.slice().reverse().map(task => <button key={task.id} disabled={!onOpenTask} onClick={() => onOpenTask?.(task)}><span>{task.objective}</span><small>{task.state}</small></button>)}</div> : <p>No tasks yet. Create one with a project agent.</p>}</section>
    </main>}</div>
  </section>;
}
