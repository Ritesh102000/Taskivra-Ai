import { GmailConnection } from './Gmail';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_LIVE_LIMITS, type AppBridge, type LiveCommand, type LiveLimits, type LivePolicy, type LiveState, type LiveTaskState, type Task } from '../../../packages/contracts/index';
import { useFilePreview } from './Files';
import './agent-run.css';
import { hasLiveProgress } from './workspace-summary';
export { hasLiveProgress } from './workspace-summary';

export function useLiveController(bridge?: AppBridge) {
  const [state, setState] = useState<LiveState | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const alive = useRef(true), lock = useRef(false), reading = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!bridge || lock.current || reading.current) return;
    const ticket = ++sequence.current; reading.current = true;
    try { const next = await bridge.live({ type: 'live.state' }); if (alive.current && ticket === sequence.current) setState(next); }
    catch (failure) { if (alive.current && ticket === sequence.current) setError(failure instanceof Error ? failure.message : 'Live agent status is unavailable.'); }
    finally { reading.current = false; }
  }, [bridge]);
  useEffect(() => { alive.current = true; void refresh(); const off = bridge?.onLiveChanged(() => void refresh()); const offState = bridge?.onChanged(() => void refresh()); const interval = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 1500); return () => { alive.current = false; sequence.current++; clearInterval(interval); off?.(); offState?.(); }; }, [bridge, refresh]);
  const perform = async (command: LiveCommand) => {
    if (!bridge || lock.current) return null;
    lock.current = true; sequence.current++; setBusy(true); setError(null);
    try { const next = await bridge.live(command); if (alive.current) { if(command.type==='live.resources')setState(current=>current?{...current,tasks:current.tasks.map(task=>task.taskId===command.taskId?{...task,resourcePreview:next.tasks.find(t=>t.taskId===command.taskId)?.resourcePreview}:task)}:current);else setState(next); } return next; }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'The live agent action did not finish. Refresh its state before trying again.'); return null; }
    finally { lock.current = false; if (alive.current) { setBusy(false); if (command.type !== 'live.resources') void refresh(); } }
  };
  return { state, error, busy, perform, refresh, clearError: () => setError(null) };
}
export type LiveController = ReturnType<typeof useLiveController>;
export function ModeBadge({ live }: { live: boolean }) { return <span className={'task-mode-badge' + (live ? ' live' : '')}>{live ? 'Live agent' : 'Simulation'}</span>; }
const dollars = (value: number) => '$' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const count = (value: number) => value.toLocaleString();

export function AgentRunPanel({ task, run, controller, waitingMessage }: { task: Task; run?: LiveTaskState; controller: LiveController; waitingMessage?: string | null }) {
  const preview = useFilePreview();
  const [localPreview,setLocalPreview] = useState<LiveTaskState['resourcePreview']>();
  useEffect(()=>{setLocalPreview(undefined);},[task.id]);
  if (!run) return <section className="agent-run-panel"><div className="agent-run-heading"><h2>Live agent</h2><ModeBadge live /></div><p className="agent-run-status">Reading the saved live-task configuration…</p>{controller.error && <p className="agent-run-error" role="alert">{controller.error}</p>}</section>;
  const finished = ['succeeded', 'failed', 'cancelled'].includes(task.state), pending = task.state === 'waiting', running = run.enabled && !finished;
  return <section className="agent-run-panel" aria-label="Live agent execution">
    <div className="agent-run-heading"><div><h2>Live agent</h2><p>{run.modelLabel || run.model}</p></div><ModeBadge live /></div>
    <p className="agent-run-status">{task.state === 'succeeded' ? 'Completed with a saved result for review.' : pending ? waitingMessage || 'Waiting for your response.' : task.state === 'pausing' ? 'Pausing the current step…' : running ? 'Working within this task’s limits.' : finished ? 'This run has ended.' : 'Ready when you are. Starting can make paid model calls.'}</p>
    {(controller.error || run.lastError) && <div className="agent-run-error" role="alert">{controller.error || run.lastError}<button className="inline-link" disabled={controller.busy} onClick={() => { controller.clearError(); void controller.refresh(); }}>Refresh live status</button></div>}
    <div className="agent-run-metrics"><div className="agent-run-metric"><strong>{dollars(run.costUsd)}</strong><span>Estimated model cost / {dollars(run.limits.maxCostUsd)} cap</span></div><div className="agent-run-metric"><strong>{count(run.inputTokens + run.outputTokens)}</strong><span>Tokens / {count(run.limits.maxTokens)}</span></div><div className="agent-run-metric"><strong>{run.steps} / {run.limits.maxToolSteps}</strong><span>Tool steps</span></div><div className="agent-run-metric"><strong>{Math.floor(run.activeSeconds)} s</strong><span>Active time / {run.limits.maxActiveSeconds} s · waiting excluded</span></div></div>
    <div className="agent-run-actions">{!finished && <>{running ? <button className="button small" disabled={controller.busy || task.state === 'pausing'} onClick={() => void controller.perform({ type: 'live.pause', taskId: task.id })}>Pause agent</button> : <button className="button primary small" disabled={controller.busy || pending || !(run.modelConfigured ?? controller.state?.credentialConfigured)} onClick={() => void controller.perform({ type: 'live.start', taskId: task.id })}>{task.state === 'paused' && hasLiveProgress(run) ? 'Resume agent' : 'Run agent'}</button>}<button className="button small danger-outline" disabled={controller.busy} onClick={() => void controller.perform({ type: 'live.stop', taskId: task.id })}>Stop task</button></>}{run.resultVersionId && <button className="button primary small" onClick={() => preview(run.resultVersionId!)}>Open saved result</button>}</div>
    {run.attention && <p role="status">Needs attention: {run.attention.cause.replaceAll('_',' ')}. Suggested actions: {run.attention.actions.map(a=>a.replaceAll('_',' ')).join(', ')}.</p>}
    <section aria-label="Next-call resources"><button className="button small" disabled={controller.busy} onClick={async()=>{const next=await controller.perform({type:'live.resources',taskId:task.id});if(next)setLocalPreview(next.tasks.find(t=>t.taskId===task.id)?.resourcePreview);}}>Preview next-call resources</button>{localPreview&&<><p>Last local preview · Input: {localPreview.inputBytes ?? 'unavailable'} bytes / {localPreview.inputByteCeiling ?? 'unknown'} ceiling · {localPreview.byteFit === true ? 'Fits' : localPreview.byteFit === false ? 'Does not fit' : 'Fit unknown'}.</p><p>{localPreview.remainingTokens} tokens available; {localPreview.heldInputTokens} input and {localPreview.heldOutputTokens} output tokens held. {dollars(localPreview.remainingCostUsd)} cost headroom; {dollars(localPreview.heldCostUsd)} held.</p><p>Output allowance: {localPreview.requestedOutputTokens} tokens. Quote: {localPreview.nextReservationUsd === null ? 'unknown until the adapter supplies a local quote' : dollars(localPreview.nextReservationUsd)}. Preview sends no model request and reads no credential.</p>{localPreview.errorCode&&<p role="alert">{localPreview.errorCode}</p>}</>}</section>
    {run.replanFailures?.map(f=><section key={f.requestId+':'+f.revision}><p role="alert">Saved request revision {f.revision}: {f.message}</p>{f.canRepair&&<button className="button small" disabled={controller.busy} onClick={()=>void controller.perform({type:'live.repairRequest',taskId:task.id,requestId:f.requestId,revision:f.revision})}>Retry this saved explanation</button>}</section>)}
    <details className="agent-run-details"><summary>Usage and policy details</summary><dl><dt>Model calls</dt><dd>{run.calls} / {run.limits.maxModelCalls}</dd><dt>Input tokens</dt><dd>{count(run.inputTokens)}</dd><dt>Output tokens</dt><dd>{count(run.outputTokens)}</dd><dt>Cost reserved</dt><dd>{dollars(run.reservedUsd)}</dd><dt>Policy</dt><dd>{run.policy.mode === 'read_only_browser' ? 'Read-only browser' : 'Private workspace tools'}</dd><dt>Allowed websites</dt><dd>{run.policy.allowedOrigins.length ? run.policy.allowedOrigins.join(', ') : 'No website origins granted'}</dd>{run.policy.mailAccount && <><dt>Mailbox</dt><dd>{run.policy.mailAccount}</dd></>}</dl></details>
    {Boolean(run.troubleshooting?.length) && <section className="agent-troubleshooting" aria-label="Agent troubleshooting"><h3>What the agent tried</h3><ol>{run.troubleshooting?.slice(-8).map((item, index) => <li key={item.at + ':' + index}><strong>{item.recovered ? 'Recovered' : 'Needs attention'} · Attempt {item.attempts}</strong><p>{item.message}</p><p><strong>Next step:</strong> {item.action}</p><small>{new Date(item.at).toLocaleString()}</small></li>)}</ol></section>}
    {run.policy.mailAccount && <GmailConnection taskId={task.id} />}
    <p className="agent-run-note">Model cost is calculated from usage and the configured rates. Page content, files and tool output are untrusted data; they cannot grant new access.</p>
  </section>;
}

export function ModelSettings({ controller }: { controller: LiveController }) {
  const state = controller.state;
  return <section className="settings-section"><div className="model-status-card"><div><strong>Model connections</strong><p>API keys remain in macOS Keychain. Local servers can work without a key.</p></div><span className={'model-status-chip' + (state?.credentialConfigured ? ' ready' : '')}>{state ? state.credentialConfigured ? 'Connection configured' : 'Connection needed' : 'Checking connection status…'}</span></div><div className="model-settings-form">
    {controller.error && <div className="agent-run-error" role="alert">{controller.error}</div>}
    <p>Choose a model and limits for each live task. Reading this status does not call the model. Add or edit providers above. Configuration status does not verify server availability or model compatibility.</p>
    {state?.models.length ? <div className="model-settings-grid">{state.models.map(model => <div className="agent-run-panel" key={model.id}><strong>{model.label}</strong><p className="agent-run-note">{model.local ? 'Local server' : model.provider || 'Cloud provider'} · {model.configured ? 'Configuration saved' : 'Connection needed'}</p><p className="agent-run-note">Per million tokens: {dollars(model.inputUsdPerMillion)} input · {dollars(model.outputUsdPerMillion)} output</p></div>)}</div> : null}
    <button className="button small" disabled={controller.busy} onClick={() => { controller.clearError(); void controller.refresh(); }}>Refresh model status</button>
  </div></section>;
}
export interface LiveTaskDraft { model: string; policyMode: LivePolicy['mode']; origins: string; reviewedActions?: boolean; limits: LiveLimits }
export function newLiveTaskDraft(model = ''): LiveTaskDraft { return { model, policyMode: 'workspace', origins: '', limits: { ...DEFAULT_LIVE_LIMITS } }; }
export function LiveTaskOptions({ draft, onChange, state, disabled }: { draft: LiveTaskDraft; onChange: (draft: LiveTaskDraft) => void; state: LiveState | null; disabled: boolean }) {
  const selectedModel = state?.models.find(model=>model.id===draft.model);
  const limit = (name: keyof LiveLimits, value: number) => onChange({ ...draft, limits: { ...draft.limits, [name]: value } });
  return <div className="live-task-options"><p>Save now. Run when ready. Starting a live task uses its selected model connection within these limits.</p><div className="live-task-limits">
    <label className="live-task-full">Model<select required value={draft.model} disabled={disabled} onChange={event => onChange({ ...draft, model: event.target.value })}><option value="" disabled>Select an available model</option>{state?.models.map(model => <option key={model.id} value={model.id}>{model.label}{model.local ? ' · local' : ''}</option>)}</select></label>
    <label className="live-task-full">Maximum model spend (USD)<input type="number" min={0.01} max={10} step={0.01} required value={draft.limits.maxCostUsd} disabled={disabled} onChange={event => limit('maxCostUsd', Number(event.target.value))} /></label>
    <label className="live-task-full">Task access<select value={draft.policyMode} disabled={disabled} onChange={event => onChange({ ...draft, policyMode: event.target.value as LivePolicy['mode'] })}><option value="workspace">Private workspace and approved browser tools</option><option value="read_only_browser">Read-only browser</option></select></label>
    {draft.policyMode==='workspace'&&<label className="live-task-full"><span><input type="checkbox" checked={Boolean(draft.reviewedActions)} disabled={disabled} onChange={e=>onChange({...draft,reviewedActions:e.target.checked})}/> Allow individually reviewed website actions</span><small>Clicking, typing and selecting may change website data. Each exact action waits for your approval.</small></label>}
    <label className="live-task-full">Allowed websites<textarea rows={2} placeholder={'https://example.com\nOne HTTPS origin per line; no path'} value={draft.origins} maxLength={3072} disabled={disabled} onChange={event => onChange({ ...draft, origins: event.target.value })} /><small className="agent-run-note">Leave blank to grant no website access.</small></label>
  </div>{selectedModel?.local && <p className="agent-run-note">This local model records no provider fee. Token, time and tool limits still apply; the app does not measure local compute costs.</p>}{selectedModel && selectedModel.configured === false && <p className="agent-run-note">This selected connection needs a key or setup before it can run. You can save the task now.</p>}<details className="live-advanced-options"><summary>Advanced run limits</summary><div className="live-task-limits">
    <label>Model calls<input type="number" min={1} max={100} required value={draft.limits.maxModelCalls} disabled={disabled} onChange={event => limit('maxModelCalls', Number(event.target.value))} /></label>
    <label>Tool steps<input type="number" min={1} max={200} required value={draft.limits.maxToolSteps} disabled={disabled} onChange={event => limit('maxToolSteps', Number(event.target.value))} /></label>
    <label>Active time (seconds)<input type="number" min={10} max={3600} required value={draft.limits.maxActiveSeconds} disabled={disabled} onChange={event => limit('maxActiveSeconds', Number(event.target.value))} /></label>
    <label>Total model tokens<input type="number" min={1000} max={1000000} step={1000} required value={draft.limits.maxTokens} disabled={disabled} onChange={event => limit('maxTokens', Number(event.target.value))} /></label>
  </div></details>{state && !state.credentialConfigured && <p className="agent-run-note">No model connection is configured. You can save this task now and connect a cloud provider or local server later.</p>}</div>;
}
