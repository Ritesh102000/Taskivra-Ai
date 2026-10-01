import { useEffect, useState } from 'react';
import type { AppBridge, Snapshot } from '../../../packages/contracts';
import type { BrowserActionProposal, BrowserActionsBridge, BrowserActionsCommand } from '../../../packages/contracts/browser-actions';
import './browser-actions.css';

export function useBrowserActionAttention(bridge?: AppBridge & BrowserActionsBridge) {
 const [count,setCount]=useState(0);
 useEffect(()=>{if(!bridge)return;let live=true,sequence=0;const read=async()=>{const ticket=++sequence;try{const state=await bridge.browserActions({type:'browserActions.list',taskId:null});if(live&&ticket===sequence)setCount(state.attentionCount);}catch{/* Other workspace connection errors remain visible in their panels. */}};void read();const stop=bridge.onChanged(()=>void read());return()=>{live=false;stop();};},[bridge]);
 return count;
}

export function BrowserActionReview({ bridge, taskId = null, snapshot }: { bridge: AppBridge & BrowserActionsBridge; taskId?: string | null; snapshot?: Snapshot }) {
 const [actions, setActions] = useState<BrowserActionProposal[]>([]), [error, setError] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
 useEffect(() => { let live = true, generation = 0; const read = async () => { const current = ++generation; try { const state = await bridge.browserActions({ type: 'browserActions.list', taskId }); if (live && current === generation) { setActions(state.actions); setError(null); } } catch (error) { if (live && current === generation) setError(error instanceof Error ? error.message : 'Could not load browser action reviews.'); } }; void read(); const stop = bridge.onChanged(() => void read()); return () => { live = false; stop(); }; }, [bridge, taskId, refresh]);
 return <section className="browser-action-reviews" aria-label="Browser action reviews">
  <header><div><h3>Website actions to review</h3><p>Each approval covers one exact action in an agent’s private browser.</p></div><button className="secondary" onClick={() => setRefresh(n => n + 1)}>Refresh reviews</button></header>
  {error && <p role="alert">{error}</p>}
  {!actions.length && <p className="muted">No website actions need review. Read-only tasks cannot request changes.</p>}
  {actions.map(action => <ActionCard key={action.id + ':' + action.revision} action={action} agent={snapshot?.agents.find(a => a.id === action.agentId)?.name} objective={snapshot?.tasks.find(t => t.id === action.taskId)?.objective} decide={async command => { await bridge.browserActions(command); setRefresh(n => n + 1); }} />)}
 </section>;
}

function ActionCard({ action, agent, objective, decide }: { action: BrowserActionProposal; agent?: string; objective?: string; decide: (command: BrowserActionsCommand) => Promise<void> }) {
 const [account, setAccount] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
 const run = async (command: BrowserActionsCommand) => { setBusy(true); setError(null); try { await decide(command); } catch (error) { setError(error instanceof Error ? error.message : 'The review could not be saved.'); } finally { setBusy(false); } };
 const stateLabels = { pending: 'Needs your review', approved: 'Approved once', declined: 'Declined', stale: 'Needs a fresh page', dispatching: 'Being applied', completed: 'Browser action returned', outcome_unknown: 'Website outcome uncertain' };
 return <article className={'browser-action-card state-' + action.state}>
  <header><strong>{agent || 'Agent'} · {action.action.kind === 'fill' ? 'Enter a field value' : action.action.kind === 'select' ? 'Choose an option' : 'Click a page element'}</strong><span>{stateLabels[action.state]}</span></header>
  {objective && <p>{objective}</p>}
  <dl><dt>Page</dt><dd className="browser-action-url">{action.url}</dd><dt>Target</dt><dd>{action.target.label || '(No visible label)'} <small>({action.target.kind})</small></dd>
  {'value' in action.action && <><dt>Exact value</dt><dd><pre>{action.action.value === '' ? '(Empty value)' : action.action.value}</pre></dd></>}
  <dt>Agent’s expected effect</dt><dd>{action.expectedEffect}</dd><dt>Reason given by agent</dt><dd>{action.reason}</dd></dl>
  <p className="muted">The expected effect is the agent’s description. A completed browser command does not verify a purchase, submission, save, or other website result.</p>
  {action.error && <p className="browser-action-notice">{action.error}</p>}
  {action.state === 'pending' && <div className="browser-action-decision">
   <p>Clicking, selecting, or typing can change the website immediately, including automatic saves. This approval does not authorize later actions.</p>
   <label>Account or workspace you confirmed in this agent’s browser<input maxLength={254} value={account} onChange={event => setAccount(event.target.value)} disabled={busy} placeholder="For example: My business workspace" /></label>
   <small>This is your confirmation. The app has not independently verified the website account. Do not enter a password or access token.</small>
   <div><button disabled={busy || !account.trim()} onClick={() => void run({ type: 'browserActions.decide', actionId: action.id, revision: action.revision, decision: 'approve', accountConfirmation: account })}>Approve this one action</button><button className="secondary" disabled={busy} onClick={() => void run({ type: 'browserActions.decide', actionId: action.id, revision: action.revision, decision: 'decline', accountConfirmation: '' })}>Decline</button></div>
   <small>Expires {new Date(action.expiresAt).toLocaleTimeString()}. A changed page or browser handoff invalidates the approval.</small>
  </div>}
  {action.state === 'approved' && <p>Approved for {action.accountConfirmation}. The agent can apply it once while the exact page and task instructions still match.</p>}
  {action.state === 'outcome_unknown' && !action.resolution && <div className="browser-action-decision">
   <p>The agent is blocked and will not send this action again. Check the website’s actual state before continuing.</p>
   <label>What you checked<textarea maxLength={1200} value={note} onChange={event => setNote(event.target.value)} disabled={busy} placeholder="Describe the saved record, confirmation, or website state you checked." /></label>
   <div><button disabled={busy || !note.trim()} onClick={() => void run({ type: 'browserActions.resolveUnknown', actionId: action.id, revision: action.revision, outcome: 'checked_done', note })}>I checked: it happened</button><button className="secondary" disabled={busy || !note.trim()} onClick={() => void run({ type: 'browserActions.resolveUnknown', actionId: action.id, revision: action.revision, outcome: 'checked_not_done', note })}>I checked: it did not happen</button></div>
   <small>A new attempt needs a fresh page and a new approval. Recording this check never resends the old action.</small>
  </div>}
  {action.resolution && <p>Owner checked: {action.resolution.outcome === 'checked_done' ? 'the action happened' : 'the action did not happen'}. {action.resolution.note}</p>}
  {error && <p role="alert">{error}</p>}
 </article>;
}
