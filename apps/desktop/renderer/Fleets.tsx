import {useCallback, useEffect, useRef, useState} from 'react';
import type {AppBridge, LiveLimits, LiveState} from '../../../packages/contracts';
import {DEFAULT_FLEET_LIMITS, DEFAULT_FLEET_TASK_LIMITS, FLEET_LAB_URL, type Fleet, type FleetCommand, type FleetMessage, type FleetBridge, type FleetLabStatus, type FleetLimits, type FleetMode, type FleetState} from '../../../packages/contracts/fleet';
import type {ProjectsController} from './Projects';
import './fleets.css';
import {RepositorySnapshotPilot} from './RepositorySnapshot';

type Props = {
  bridge: AppBridge & FleetBridge; live: LiveState | null; projects: ProjectsController;
  onChanged: () => void; onTask: (id: string) => void; onResult: (id: string) => void;
  onLibrary: () => void; onSettings: () => void;
};
const statusLabels: Record<Fleet['status'], string> = {
  prepared: 'Draft', running: 'Working', paused: 'Paused', needs_attention: 'Needs attention', succeeded: 'Complete', stopped: 'Stopped',
};
const taskLabels: Record<string, string> = {paused: 'Paused', queued: 'Queued', running: 'Working', waiting: 'Needs input', succeeded: 'Complete', failed: 'Failed', cancelled: 'Stopped', pausing: 'Pausing', recovering: 'Recovering'};
const teamFields = [
  {key: 'maxAgents', label: 'Agents, including the lead', min: 2, max: 6},
  {key: 'maxConcurrent', label: 'Tasks working at once', min: 1, max: 2},
  {key: 'maxWorkItems', label: 'Work items', min: 1, max: 12},
  {key: 'maxPlanRevisions', label: 'Plan revisions', min: 1, max: 4},
  {key: 'maxModelCalls', label: 'Model calls', min: 1, max: 300},
  {key: 'maxTokens', label: 'Total tokens', min: 1000, max: 2000000},
  {key: 'maxActiveSeconds', label: 'Combined active seconds', min: 10, max: 7200},
] as const;
const taskFields = [
  {key: 'maxCostUsd', label: 'Model spend (USD)', min: 0.01, max: 10, step: 0.01},
  {key: 'maxModelCalls', label: 'Model calls', min: 1, max: 100, step: 1},
  {key: 'maxToolSteps', label: 'Tool steps', min: 1, max: 200, step: 1},
  {key: 'maxTokens', label: 'Total tokens', min: 1000, max: 1000000, step: 1},
  {key: 'maxActiveSeconds', label: 'Active seconds', min: 10, max: 3600, step: 1},
] as const;
const money = (value: number) => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
const formatTime = (value: number) => new Date(value).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

export function Fleets({bridge, live, projects, onChanged, onTask, onResult, onLibrary, onSettings}: Props) {
  const [state, setState] = useState<FleetState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState('personal-workspace'), [objective, setObjective] = useState(''), [sources, setSources] = useState<string[]>([]);
  const [mode, setMode] = useState<FleetMode>('imported_evidence');
  const [plannerModel, setPlannerModel] = useState(''), [workerModel, setWorkerModel] = useState('');
  const [limits, setLimits] = useState<FleetLimits>(() => ({...DEFAULT_FLEET_LIMITS}));
  const [taskLimits, setTaskLimits] = useState<LiveLimits>(() => ({...DEFAULT_FLEET_TASK_LIMITS}));
  const [selected, setSelected] = useState(''), [newOpen, setNewOpen] = useState(true), [notice, setNotice] = useState(''), [archived,setArchived]=useState(false),[pageCursor,setPageCursor]=useState<string|null>(null);
  const locked = useRef(false), mounted = useRef(true), sequence = useRef(0), initialLoad = useRef(true);
  const createAttempt = useRef<{signature: string; key: string} | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const project = projects.state?.projects.find(item => item.id === projectId) || projects.state?.projects[0];
  const refresh = useCallback(async () => {
    if (locked.current) return;
    const ticket = ++sequence.current;
    try {
      let next = await bridge.fleet({type: 'fleet.state',projectId,sourceVersionIds:sources,archived,...(pageCursor?{beforeFleetId:pageCursor}:{})});if(selected&&!next.fleets.some(f=>f.id===selected)){const exact=await bridge.fleet({type:'fleet.state',projectId,archived,fleetId:selected});next={...next,fleets:[...next.fleets,...exact.fleets]};}
      if (mounted.current && ticket === sequence.current) {
        setState(next);
        if (initialLoad.current) {initialLoad.current = false; setNewOpen(!next.fleets.length);}
      }
    } catch (cause) {if (mounted.current && ticket === sequence.current) setError(cause instanceof Error ? cause.message : 'Fleets could not be loaded.');}
  }, [bridge,projectId,sources,archived,selected,pageCursor]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const stops = [bridge.onChanged(() => void refresh()), bridge.onLiveChanged(() => void refresh())];
    return () => {mounted.current = false; sequence.current++; stops.forEach(stop => stop());};
  }, [bridge, refresh]);
  useEffect(() => {
    if (live?.defaultModel) {setPlannerModel(current => current || live.defaultModel); setWorkerModel(current => current || live.defaultModel);}
  }, [live?.defaultModel]);
  const modelLabel = (id: string) => live?.models.find(model => model.id === id)?.label || live?.tasks.find(task => task.model === id)?.modelLabel || 'Saved model selection';
  const configured = (id: string) => Boolean(live?.models.find(model => model.id === id)?.configured);
  const modelOptions = live?.models.map(model => <option key={model.id} value={model.id}>{model.label}{model.configured ? '' : ' · needs connection'}</option>);
  const eligible = state?.eligibleSources.filter(source => source.projectId === project?.id) || [];
  const selectedSources = eligible.filter(source => sources.includes(source.versionId));
  const selectedBytes = selectedSources.reduce((total, source) => total + source.bytes, 0);
  const sourcesValid = sources.length > 0 && sources.length <= 8 && selectedSources.length === sources.length && selectedBytes <= 256 * 1024 && selectedSources.every(source => source.bytes <= 64 * 1024);
  const canCreate = Boolean(state && project && objective.trim() && (mode === 'local_website' || sourcesValid) && plannerModel && workerModel);
  const connectionsReady = configured(plannerModel) && configured(workerModel);
  const siteReady = mode !== 'local_website' || Boolean(state?.lab?.ready);
  const fleet = state?.fleets.find(item => item.id === selected) || state?.fleets[0];

  function resetDraft() {
    setObjective(''); setSources([]); setMode('imported_evidence'); setPlannerModel(live?.defaultModel || ''); setWorkerModel(live?.defaultModel || '');
    setLimits({...DEFAULT_FLEET_LIMITS}); setTaskLimits({...DEFAULT_FLEET_TASK_LIMITS}); setError(''); setNotice(''); createAttempt.current = null;
  }
  async function create(start: boolean) {
    if (locked.current || !canCreate || (start && (!connectionsReady || !siteReady)) || !form.current?.reportValidity() || !project) return;
    locked.current = true; sequence.current++; setBusy(true); setError(''); setNotice('');
    const input = {type: 'fleet.create' as const, projectId: project.id, objective: objective.trim(), sourceVersionIds: mode === 'local_website' ? [] : sources, mode, plannerModel, workerModel, limits, taskLimits};
    const signature = JSON.stringify(input);
    if (createAttempt.current?.signature !== signature) createAttempt.current = {signature, key: crypto.randomUUID()};
    let createdId: string | undefined;
    try {
      const next = await bridge.fleet({...input, idempotencyKey: createAttempt.current.key});
      createdId = next.createdFleetId;
      if (!createdId) throw new Error('The saved fleet could not be identified. Refresh the fleet list before trying again.');
      if (mounted.current) {setState(next); setSelected(createdId); setObjective(''); setSources([]); setNewOpen(false);}
      createAttempt.current = null;
      if (start) {
        const started = await bridge.fleet({type: 'fleet.start', fleetId: createdId});
        if (mounted.current) {setState(started); setNotice('Fleet started. Its lead will plan the work and coordinate the team.');}
      } else if (mounted.current) setNotice('Draft saved. No model calls start until you choose Start fleet.');
      onChanged(); void projects.refresh();
    } catch (cause) {
      if (mounted.current) setError(`${createdId ? 'Your fleet is saved, but could not start. ' : ''}${cause instanceof Error ? cause.message : 'This fleet action could not be completed.'}`);
      if (createdId) {onChanged(); void projects.refresh();}
    } finally {locked.current = false; if (mounted.current) {setBusy(false); void refresh();}}
  }
  async function perform(command: FleetCommand) {
    if (locked.current) return;
    locked.current = true; sequence.current++; setBusy(true); setError(''); setNotice('');
    try {
      let next = await bridge.fleet(command);if(archived&&command.type!=='fleet.followup')next=await bridge.fleet({type:'fleet.state',projectId,archived,sourceVersionIds:sources});
      if (mounted.current) {setState(next); if(command.type==='fleet.followup'&&next.createdFleetId){setSelected(next.createdFleetId);setArchived(false);setPageCursor(null);} setNotice(command.type === 'fleet.labStart' ? next.lab?.message || 'Training website is ready.' : command.type === 'fleet.pause' ? 'Pause requested. Saved progress is retained.' : command.type === 'fleet.stop' ? 'Fleet stopped. Saved work remains available.' : command.type==='fleet.followup' ? 'Fresh follow-up draft saved. Review and start it separately.' : command.type==='fleet.archive'? 'History updated. Saved identities remain; nothing was started.' : 'Fleet started from saved progress.');}
      onChanged();
    } catch (cause) {if (mounted.current) setError(cause instanceof Error ? cause.message : 'The fleet could not be updated.');}
    finally {locked.current = false; if (mounted.current) {setBusy(false); void refresh();}}
  }

  async function olderFleets(){if(locked.current||!state?.nextCursor)return;locked.current=true;sequence.current++;setBusy(true);setError('');try{const next=await bridge.fleet({type:'fleet.state',projectId,archived,beforeFleetId:state.nextCursor,sourceVersionIds:sources});if(mounted.current){setState(next);setSelected('');setPageCursor(state.nextCursor||null);}}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Older fleet history unavailable.');}finally{locked.current=false;if(mounted.current)setBusy(false);}}
  return <div className="page-scroll fleet-page">
    <section className="page-heading"><div><span className="eyebrow">ONE OBJECTIVE · A COORDINATED TEAM</span><h1>Fleets</h1><p>Give the team a goal. Agents divide the work, share findings and deliver one result.</p></div></section>
    <div className="fleet-scope-note"><strong>Assess selected evidence or the local training website.</strong><p>Choose a file review or let the fleet explore the synthetic website through its browser, run bounded local terminal checks and use offline container code. The website mode starts logged out with its URL only. Your selected model providers receive the observations and reports; local model connections process them locally.</p></div>
    {error && <div className="agent-run-error" role="alert">{error}</div>}
    {notice && <p className="fleet-notice" role="status">{notice}</p>}
    <section className="fleet-new">
      <button className="fleet-disclosure" type="button" aria-expanded={newOpen} aria-controls="fleet-create-form" disabled={busy} onClick={() => setNewOpen(current => !current)}><span>Start a fleet</span><span aria-hidden="true">{newOpen ? '−' : '+'}</span></button>
      {newOpen && <form id="fleet-create-form" ref={form} onSubmit={event => {event.preventDefault(); void create(true);}}>
        <label>How should the fleet work?<select value={mode} disabled={busy} onChange={event => {setMode(event.target.value as FleetMode); setSources([]);}}><option value="imported_evidence">Review published files</option><option value="local_website">Test the local website</option></select></label>
        <label>What should the team accomplish?<textarea value={objective} onChange={event => setObjective(event.target.value)} maxLength={3000} rows={4} required disabled={busy} placeholder={mode === 'local_website' ? 'Explore the website as a new visitor. Organize a team, check the user journeys, exchange findings, reproduce unexpected behavior, and deliver a prioritized report with evidence and remediation.' : 'Review this project for authorization weaknesses. Check each finding against the source, identify what remains untested, and deliver a prioritized remediation report.'} /></label>
        <div className="fleet-form-grid"><label>Project<select value={project?.id || ''} onChange={event => {setProjectId(event.target.value); setSources([]);}} required disabled={busy}><option value="" disabled>Choose a project</option>{projects.state?.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Total model spend limit (USD)<input type="number" value={limits.maxCostUsd} min={0.01} max={50} step={0.01} required disabled={busy} onChange={event => setLimits(current => ({...current, maxCostUsd: Number(event.target.value)}))} /></label></div>
        {mode === 'local_website' ? <fieldset className="fleet-lab-setup" disabled={busy}><legend>Local training website</legend><div className="fleet-lab-heading"><div><strong>{state?.lab?.ready ? 'Website ready' : 'Website stopped'}</strong><p className="fleet-lab-url">{FLEET_LAB_URL}</p></div><button className="button" type="button" disabled={busy || Boolean(state?.lab?.ready)} onClick={() => void perform({type: 'fleet.labStart'})}>{state?.lab?.ready ? 'Website running' : 'Start training website'}</button></div><p>{state?.lab?.message || 'Start the app’s synthetic website before starting the fleet.'}</p><p>The agents begin as logged-out visitors and can discover pages and register synthetic accounts. Browser actions, local terminal responses and reports become evidence. Source files and hidden answers are not attached.</p><small>Browser + local terminal checks + offline container code</small></fieldset> : <fieldset disabled={busy}><legend>Evidence for this fleet</legend>{project&&<RepositorySnapshotPilot bridge={bridge} project={project} onCaptured={()=>{onChanged();void projects.refresh();void refresh();}}/>}<p>Select published versions in this project. The fleet shares these files and its own reports internally; later changes to the original files do not change its inputs.</p>
          {!state ? <p>Loading available files…</p> : eligible.length ? <div className="fleet-source-list">{eligible.map(source => {
            const checked = sources.includes(source.versionId), tooLarge = source.bytes > 64 * 1024;
            return <label key={source.versionId}><input type="checkbox" checked={checked} disabled={tooLarge || (!checked && (sources.length >= 8 || selectedBytes + source.bytes > 256 * 1024))} onChange={event => setSources(current => event.target.checked ? [...current, source.versionId] : current.filter(id => id !== source.versionId))} /><span>{source.displayName}<small>{source.format} · {Math.ceil(source.bytes / 1024)} KiB · version {source.versionId.slice(0, 8)}{tooLarge ? ' · exceeds the per-file limit' : ''}</small></span></label>;
          })}</div> : <p>No supported published files in this project yet. Publish your source files in the shared library first.</p>}
          <div className="fleet-source-footer"><small>{sources.length}/8 files · {Math.ceil(selectedBytes / 1024)}/256 KiB · up to 64 KiB per file</small><button className="button small" type="button" onClick={onLibrary}>Open shared library</button></div>
        </fieldset>}
        <div className="fleet-form-grid"><label>Lead model<select value={plannerModel} required disabled={busy} onChange={event => setPlannerModel(event.target.value)}><option value="">Choose a model</option>{modelOptions}</select><small>Plans, revises the work and combines results.</small></label><label>Worker model<select value={workerModel} required disabled={busy} onChange={event => setWorkerModel(event.target.value)}><option value="">Choose a model</option>{modelOptions}</select><small>Used by the specialist agents the lead creates.</small></label></div>
        <details className="fleet-limits"><summary>Team size and limits <span>Up to {limits.maxAgents} agents · {limits.maxConcurrent} active tasks</span></summary><p>Limits cover the whole fleet, including planning, follow-up work and the final report. The workspace concurrency setting can reduce the number of tasks working at once.</p><div className="fleet-limit-grid">{teamFields.map(field => <label key={field.key}>{field.label}<input type="number" required min={field.min} max={field.max} step={1} value={limits[field.key]} disabled={busy} onChange={event => setLimits(current => ({...current, [field.key]: Number(event.target.value)}))} /></label>)}</div>
          <h3>Limits for each task</h3><p>Every task also has its own ceiling. The fleet-wide allowance still applies.</p><div className="fleet-limit-grid">{taskFields.map(field => <label key={field.key}>{field.label}<input type="number" required min={field.min} max={field.max} step={field.step} value={taskLimits[field.key]} disabled={busy} onChange={event => setTaskLimits(current => ({...current, [field.key]: Number(event.target.value)}))} /></label>)}</div>
        </details>
        <div className="fleet-start-note"><strong>One start includes planning and automatic handoffs.</strong><p>The lead creates roles and work items within your limits. Agents claim work, exchange findings and revise the plan without asking you to approve each handoff. They can pause for clarification. You can pause or stop the whole fleet at any time.</p><small>Spend tracking uses the model prices saved in Settings. Local models may record no provider cost.</small></div>
        {!connectionsReady && <p className="fleet-connection-note">Connect both selected models to start. You can save a draft first.</p>}
        {!siteReady && <p className="fleet-connection-note">Start the training website to run this fleet. You can save a draft first.</p>}
        <div className="fleet-actions"><button className="button primary" type="submit" disabled={busy || !canCreate || !connectionsReady || !siteReady}>{busy ? 'Saving…' : 'Start fleet'}</button><button className="button" type="button" disabled={busy || !canCreate} onClick={() => void create(false)}>Save draft</button><button className="button" type="button" disabled={busy} onClick={onSettings}>Model connections</button><button className="text-button" type="button" disabled={busy} onClick={resetDraft}>Clear draft</button></div>
      </form>}
    </section>
    <section className="fleet-saved"><div className="fleet-section-heading"><h2>Your fleets</h2><label><input type="checkbox" checked={archived} disabled={busy} onChange={e=>{setState(null);setSelected('');setPageCursor(null);setArchived(e.target.checked);}}/> Browse archived fleets</label><button className="button small" disabled={busy} onClick={() => {if(pageCursor)setPageCursor(null);else void refresh();}}>Refresh</button></div>
      {!state ? <p className="subtle">Loading saved fleets…</p> : !state.fleets.length ? <div className="fleet-empty"><h3>{archived?'No archived fleets in this scope.':'Your first objective starts here.'}</h3><p>Describe the outcome, select evidence and choose Start fleet. The plan and agent team will appear as the lead creates them.</p><p>Earlier review tasks and their results remain available in All tasks and Results.</p></div> : <>
        <div className="fleet-picker" role="group" aria-label="Saved fleets">{state.fleets.map(item => <button type="button" key={item.id} aria-pressed={fleet?.id === item.id} className={fleet?.id === item.id ? 'selected' : ''} onClick={() => setSelected(item.id)}><strong>{item.title}</strong><span>{statusLabels[item.status]} · {item.items.filter(work => work.state === 'completed').length}/{item.items.length} work items</span></button>)}</div>
        {fleet && <FleetDetail bridge={bridge} fleet={fleet} lab={state.lab} busy={busy} modelLabel={modelLabel} onLabStart={() => void perform({type: 'fleet.labStart'})} onCommand={perform} onTask={onTask} onResult={onResult} />}
      </>}{state?.nextCursor&&<button className="button" disabled={busy} onClick={()=>void olderFleets()}>Load older fleets</button>}
    </section>
  </div>;
}

function FleetDetail({bridge,fleet, lab, busy, modelLabel, onLabStart, onCommand, onTask, onResult}: {bridge:FleetBridge;fleet: Fleet; lab?: FleetLabStatus; busy: boolean; modelLabel: (id: string) => string; onLabStart: () => void; onCommand: (command: FleetCommand) => Promise<void>; onTask: (id: string) => void; onResult: (id: string) => void}) {
  const [followup,setFollowup]=useState(''),[followupOpen,setFollowupOpen]=useState(false),[mailbox,setMailbox]=useState<FleetMessage[]>([]),[cursor,setCursor]=useState<string|null>(null),[mailError,setMailError]=useState(''),[mailTask,setMailTask]=useState('');const mailboxSequence=useRef(0),followupKey=useRef(crypto.randomUUID());
  useEffect(()=>{setFollowup('');setFollowupOpen(false);setMailbox([]);setCursor(null);setMailTask('');mailboxSequence.current++;followupKey.current=crypto.randomUUID();},[fleet.id]);
  async function readMailbox(taskId:string,beforeMessageId?:string,messageId?:string){const ticket=++mailboxSequence.current;setMailError('');try{const next=await bridge.fleet({type:'fleet.mailbox',fleetId:fleet.id,taskId,...(beforeMessageId?{beforeMessageId}:{}),...(messageId?{messageId}:{})});if(ticket===mailboxSequence.current){setMailbox(previous=>beforeMessageId?[...previous,...(next.mailbox?.messages||[])]:next.mailbox?.messages||[]);setCursor(next.mailbox?.nextCursor||null);}}catch(e){if(ticket===mailboxSequence.current)setMailError(e instanceof Error?e.message:'Mailbox unavailable.');}}
  const completed = fleet.items.filter(item => item.state === 'completed').length;
  const active = fleet.tasks.filter(task => ['running', 'pausing'].includes(task.state));
  const final = Boolean(fleet.finalTaskId && fleet.finalVersionId);
  const resumeBlocked = fleet.tasks.some(task => task.kind === 'worker' && ['failed', 'cancelled'].includes(task.state) && fleet.items.some(item => item.id === task.itemId && item.state !== 'cancelled'));
  const isTerminal = fleet.status === 'succeeded' || fleet.status === 'stopped';
  const itemName = (id: string) => fleet.items.find(item => item.id === id)?.title || id.slice(0, 8);
  return <article className="fleet-detail">
    <header className="fleet-detail-heading"><div><span className={'fleet-status fleet-status-' + fleet.status}>{statusLabels[fleet.status]}</span><h2>{fleet.title}</h2><p className="fleet-objective">{fleet.objective}</p><small>Created {formatTime(fleet.createdAt)} · {fleet.mode === 'local_website' ? 'Local website · black-box assessment' : `${fleet.sourceVersionIds.length} selected file versions`}</small>{fleet.siteUrl && <p className="fleet-lab-url">{fleet.siteUrl}</p>}</div><div className="fleet-actions">
      {fleet.mode === 'local_website' && !lab?.ready && !isTerminal && <button className="button" disabled={busy} onClick={onLabStart}>Start training website</button>}
      {fleet.status === 'running' ? <button className="button" disabled={busy} onClick={() => void onCommand({type: 'fleet.pause', fleetId: fleet.id})}>Pause fleet</button> : !isTerminal && <button className="button primary" disabled={busy || resumeBlocked || (fleet.mode === 'local_website' && !lab?.ready)} onClick={() => void onCommand({type: 'fleet.start', fleetId: fleet.id})}>{fleet.status === 'prepared' ? 'Start fleet' : 'Resume fleet'}</button>}
      {!isTerminal && <button className="button fleet-stop" disabled={busy} onClick={() => void onCommand({type: 'fleet.stop', fleetId: fleet.id})}>Stop fleet</button>}
      {isTerminal&&<button className="button" disabled={busy} onClick={()=>void onCommand({type:'fleet.archive',fleetId:fleet.id,archived:!fleet.archivedAt})}>{fleet.archivedAt?'Restore fleet to browse':'Archive finished fleet'}</button>}
      {final && <button className="button primary" onClick={() => onResult(fleet.finalTaskId!)}>Open combined result</button>}
    </div></header>
    <button className="button small" disabled={busy} onClick={()=>setFollowupOpen(!followupOpen)}>Prepare fresh follow-up</button>{followupOpen&&<form onSubmit={e=>{e.preventDefault();void onCommand({type:'fleet.followup',fleetId:fleet.id,objective:followup,limits:{...fleet.limits},taskLimits:{...fleet.taskLimits},idempotencyKey:followupKey.current});}}><label>New reviewed objective<textarea required maxLength={4000} value={followup} onChange={e=>{setFollowup(e.target.value);followupKey.current=crypto.randomUUID();}}/></label><p>A fresh paused fleet keeps selected exact sources and saved model choices with fresh {money(fleet.limits.maxCostUsd)} fleet and {money(fleet.taskLimits.maxCostUsd)} per-task limits. Prior grants are not copied. Nothing runs until you start it.</p><button className="button" disabled={busy||!followup.trim()}>Save follow-up draft</button></form>}
    {fleet.lineage&&<p>Follow-up of fleet {fleet.lineage.sourceFleetId}, plan revision {fleet.lineage.sourceRevision} · exact final version {fleet.lineage.sourceFinalVersionId||'none'}.</p>}
    {fleet.sourceManifest&&<details><summary>Immutable supplied-source manifest</summary><code>{fleet.sourceManifest.sha256}</code><pre>{JSON.stringify(fleet.sourceManifest.entries,null,2)}</pre><p>Selected identities describe supplied coverage. Retrieved, declared inspected and validated findings are separate; selection does not prove file inspection or test execution.</p></details>}
    <section aria-label="Fleet mailbox"><label>Read a member’s mailbox<select value={mailTask} onChange={e=>{setMailTask(e.target.value);mailboxSequence.current++;setMailbox([]);setCursor(null);setMailError('');if(e.target.value)void readMailbox(e.target.value);}}><option value="">Choose a fleet task</option>{fleet.tasks.map(t=><option key={t.taskId} value={t.taskId}>{t.kind} · {t.taskId}</option>)}</select></label>{mailError&&<p role="alert">{mailError}</p>}{mailbox.map(m=><article key={m.id}><strong>{m.id}</strong><p>{m.content}</p>{m.replyToMessageId&&<button className="inline-link" onClick={()=>void readMailbox(mailTask,undefined,m.replyToMessageId!)}>Read linked question {m.replyToMessageId}</button>}</article>)}{cursor&&<button className="button" onClick={()=>void readMailbox(mailTask,cursor)}>Read older mailbox records</button>}</section>
    {resumeBlocked && <p role="status">A required worker ended. Review its task, then create fresh follow-up work with reviewed scope.</p>}
    {fleet.problem && <p className="agent-run-error" role="alert">{fleet.problem}</p>}
    <div className="fleet-metrics"><div><strong>{completed}<span> / {fleet.items.length}</span></strong><small>Work items completed</small></div><div><strong>{active.length}<span> / {fleet.limits.maxConcurrent}</span></strong><small>Tasks active</small></div><div><strong>{fleet.members.length}<span> / {fleet.limits.maxAgents}</span></strong><small>Agents created</small></div><div><strong>{money(fleet.costUsd)}<span> / {money(fleet.limits.maxCostUsd)}</span></strong><small>{money(fleet.reservedUsd)} reserved for in-flight calls</small></div></div>
    <div className="fleet-budget-note">{fleet.modelCalls}/{fleet.limits.maxModelCalls} model calls · {fleet.totalTokens.toLocaleString()}/{fleet.limits.maxTokens.toLocaleString()} tokens · {Math.ceil(fleet.activeSeconds)}/{fleet.limits.maxActiveSeconds} combined active seconds</div>
    <section className="fleet-block"><div className="fleet-section-heading"><h3>Team</h3><small>Roles are created by the lead</small></div>{fleet.members.length ? <div className="fleet-members">{fleet.members.map(member => {
      const tasks = fleet.tasks.filter(task => task.memberId === member.id);
      return <section key={member.id} className="fleet-member"><span className="eyebrow">{member.isLead ? 'TEAM LEAD' : member.roleKey.replaceAll('_', ' ')}</span><h4>{member.name}</h4><p>{member.goal}</p><small>{modelLabel(member.model)}</small><div className="fleet-member-tasks">{tasks.map(task => <button className="inline-link" key={task.taskId} onClick={() => onTask(task.taskId)}>{task.itemId ? itemName(task.itemId) : 'Coordination task'} · {task.preparation === 'failed' ? 'Preparation needs attention' : task.preparation === 'preparing' ? 'Preparing files' : taskLabels[task.state] || task.state}</button>)}</div>{tasks.filter(task => task.error).map(task => <p className={task.error === 'fleet_pending_work_cancelled' ? undefined : 'fleet-task-error'} key={task.taskId}>{task.error === 'fleet_pending_work_cancelled' ? 'This unclaimed task closed when its work was removed from the plan.' : task.error}</p>)}</section>;
    })}</div> : <p className="subtle">The lead is created when this fleet is prepared. Its team will appear here after planning.</p>}</section>
    <section className="fleet-block"><div className="fleet-section-heading"><h3>Shared work board</h3><small>Plan revision {fleet.revision} · up to {fleet.limits.maxWorkItems} items</small></div>{fleet.items.length ? <div className="fleet-board">{fleet.items.map(item => {
      const dependencies = item.dependsOnIds.map(id => fleet.items.find(candidate => candidate.id === id));
      const waiting = item.state === 'pending' && dependencies.some(dependency => dependency?.state !== 'completed');
      const owner = fleet.members.find(member => member.roleKey === item.roleKey);
      const task = fleet.tasks.find(task => task.taskId === item.claimedTaskId);
      return <section className="fleet-work-item" key={item.id}><div className="fleet-work-top"><span className={'fleet-item-state fleet-item-' + item.state}>{item.state === 'pending' ? waiting ? 'Waiting for dependencies' : 'Ready to claim' : item.state === 'claimed' ? 'Claimed' : item.state === 'completed' ? 'Completed' : 'Cancelled'}</span><small>{item.key}</small></div><h4>{item.title}</h4><p>{item.description}</p><small>Assigned role: {owner?.name || item.roleKey}</small>{dependencies.length > 0 && <p className="fleet-dependencies">Depends on: {item.dependsOnIds.map(itemName).join(' · ')}</p>}{task && <p className="fleet-dependencies">Task: {taskLabels[task.state] || task.state}</p>}<div className="fleet-actions">{item.claimedTaskId && <button className="button small" onClick={() => onTask(item.claimedTaskId!)}>Open task</button>}{item.outputVersionId && item.claimedTaskId && <button className="button small" onClick={() => onResult(item.claimedTaskId!)}>Read result</button>}</div>{item.publishedVersionId && <small className="fleet-shared-version">Shared report version {item.publishedVersionId.slice(0, 8)}</small>}</section>;
    })}</div> : <p className="fleet-planning-empty">{fleet.status === 'prepared' ? 'Start the fleet to let its lead propose roles and a plan.' : 'No work items have been proposed yet. Open the lead’s task to inspect its progress.'}</p>}</section>
    <div className="fleet-updates-grid"><section className="fleet-block"><h3>Plan revisions</h3>{fleet.revisions.length ? <ol className="fleet-revisions">{fleet.revisions.map(revision => <li key={revision.revision}><strong>Revision {revision.revision}</strong><small>{formatTime(revision.createdAt)}</small><p>{revision.summary}</p></li>)}</ol> : <p className="subtle">Planning decisions will appear here.</p>}</section><section className="fleet-block"><h3>Findings and messages</h3>{fleet.messages.length ? <ol className="fleet-messages">{fleet.messages.map(message => {
      const task = fleet.tasks.find(item => item.taskId === message.fromTaskId), author = fleet.members.find(member => member.id === task?.memberId);
      return <li key={message.id}><div><strong>{author?.name || 'Fleet agent'}</strong><small>{formatTime(message.createdAt)}</small></div><small>To: {message.recipientRoleKey ? fleet.members.find(member => member.roleKey === message.recipientRoleKey)?.name || message.recipientRoleKey : 'Whole fleet'}</small><p>{message.content}</p>{message.replyToMessageId&&<small>Reply to exact message {message.replyToMessageId}</small>}{message.itemIds.length > 0 && <small>Work: {message.itemIds.map(itemName).join(' · ')}</small>}{message.versionIds.length > 0 && <small>Shared file versions: {message.versionIds.map(id => id.slice(0, 8)).join(' · ')}</small>}<button className="inline-link" onClick={() => onTask(message.fromTaskId)}>Open sender’s task</button></li>;
    })}</ol> : <p className="subtle">The team’s scoped discussion and findings will appear here.</p>}</section></div>
    <details className="fleet-saved-limits"><summary>Saved models and limits</summary><p>Lead: {modelLabel(fleet.plannerModel)}<br />Workers: {modelLabel(fleet.workerModel)}</p><p>Up to {fleet.limits.maxAgents} agents, {fleet.limits.maxConcurrent} active tasks, {fleet.limits.maxWorkItems} work items and {fleet.limits.maxPlanRevisions} plan revisions.</p><p>Each task: {money(fleet.taskLimits.maxCostUsd)} model spend, {fleet.taskLimits.maxModelCalls} calls, {fleet.taskLimits.maxToolSteps} tool steps, {fleet.taskLimits.maxTokens.toLocaleString()} tokens and {fleet.taskLimits.maxActiveSeconds} active seconds.</p><p>Resume keeps these saved choices. Earlier review tasks and results remain available in All tasks and Results.</p></details>
  </article>;
}
