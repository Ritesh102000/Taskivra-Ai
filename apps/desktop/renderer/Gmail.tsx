import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppBridge, GmailOwnerCommand, GmailState, LiveTaskState } from '../../../packages/contracts/index';
import './gmail.css';

function useGmail(bridge: AppBridge) {
  const [state, setState] = useState<GmailState | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const alive = useRef(true), lock = useRef(false), reading = useRef(false), readAgain = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    if (!alive.current) return;
    if (lock.current || reading.current) { readAgain.current = true; return; }
    const ticket = ++sequence.current; reading.current = true; readAgain.current = false;
    try { const next = await bridge.gmail({ type: 'gmail.state' }); if (alive.current && ticket === sequence.current) setState(next); }
    catch (failure) { if (alive.current && ticket === sequence.current) setError(failure instanceof Error ? failure.message : 'Gmail connection status is unavailable.'); }
    finally { reading.current = false; if (alive.current && readAgain.current && !lock.current) void refresh(); }
  }, [bridge]);
  useEffect(() => { alive.current = true; void refresh(); const off = bridge.onGmailChanged(() => void refresh()); return () => { alive.current = false; sequence.current++; off(); }; }, [bridge, refresh]);
  const operation = async (work: () => Promise<GmailState>) => {
    if (lock.current) return;
    lock.current = true; sequence.current++; setBusy(true); setError(null);
    try { const next = await work(); if (alive.current) setState(next); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'The Gmail connection action did not finish. Read its status before trying again.'); }
    finally { lock.current = false; if (alive.current) { setBusy(false); void refresh(); } }
  };
  return { state, error, busy, refresh, clearError: () => setError(null),
    perform: (command: GmailOwnerCommand) => operation(() => bridge.gmail(command)),
    importClient: () => operation(async () => (await bridge.gmailImportClient()).state),
  };
}
type GmailController = ReturnType<typeof useGmail>;
const GmailContext = createContext<{ controller: GmailController; tasks: LiveTaskState[] } | null>(null);
export function GmailProvider({ bridge, tasks, children }: { bridge: AppBridge; tasks: LiveTaskState[]; children: ReactNode }) {
  const controller = useGmail(bridge);
  return <GmailContext.Provider value={{ controller, tasks }}>{children}</GmailContext.Provider>;
}

export function GmailConnection({ taskId, settings = false, requireConnection = false }: { taskId?: string; settings?: boolean; requireConnection?: boolean }) {
  const context = useContext(GmailContext), [selectedTask, setSelectedTask] = useState('');
  if (!context) return null;
  const { controller, tasks } = context, state = controller.state;
  const mailTasks = tasks.filter(task => task.policy.mode === 'read_only_browser' && task.policy.mailAccount);
  const chosen = mailTasks.find(task => task.taskId === (taskId || selectedTask)) || (!taskId && !selectedTask ? mailTasks[0] : undefined);
  const account = chosen?.policy.mailAccount;
  const connected = Boolean(account && state?.connectedAccount?.toLowerCase() === account.toLowerCase());
  const connectionSaved = connected || Boolean(settings && state?.connectedAccount);
  const blocked = controller.busy || Boolean(state?.connecting);
  return <section className={'gmail-connection' + (settings ? ' gmail-settings' : '')} aria-label="Gmail read-only connection">
    <div className="gmail-heading"><div><h2>Gmail connection</h2><p>{account || 'Read-only access through Google consent'}</p></div><span className={'model-status-chip' + (connectionSaved ? ' ready' : '')}>{state?.connecting ? 'Waiting for consent' : connectionSaved ? 'Connected' : state?.connectedAccount ? 'Another account connected' : state?.configured ? 'Ready to connect' : state ? 'Setup needed' : 'Checking…'}</span></div>
    {settings && mailTasks.length > 1 && <label className="gmail-task-selector">Saved Gmail task<select value={chosen?.taskId || ''} disabled={blocked} onChange={event => setSelectedTask(event.target.value)}>{mailTasks.map(task => <option key={task.taskId} value={task.taskId}>{task.policy.mailAccount} · {task.taskId.slice(0, 8)}</option>)}</select></label>}
    {(controller.error || state?.error) && <div className="agent-run-error" role="alert">{controller.error || state?.error}<button className="inline-link" disabled={controller.busy} onClick={() => { controller.clearError(); void controller.refresh(); }}>Refresh connection</button></div>}
    {state && !state.configured && <div className="gmail-next-step"><strong>Google Desktop OAuth client required</strong><p>Use a Google Desktop OAuth client with Gmail API enabled.</p><p>The file is read through a native picker and kept in secure local storage. Its contents are never shown here.</p></div>}
    <details className="gmail-setup-help"><summary>Setup instructions</summary><ol><li>In Google Cloud, select your project and enable <strong>Gmail API</strong>.</li><li>In <strong>Google Auth platform → Audience</strong>, choose <strong>External</strong> and keep the app in <strong>Testing</strong>. Add <strong>{account || 'the exact Gmail account saved on this task'}</strong> as a test user. Complete Branding and add the Gmail read-only scope in Data Access.</li><li>In <strong>Clients</strong>, create a <strong>Desktop app</strong> OAuth client and download its JSON. Import it here, then choose <strong>Connect Gmail</strong> and consent with that same account.</li></ol></details>
    {state?.configured && !connected && <p className="gmail-copy">Connect opens Google consent in your system browser for {account || 'the account saved on a Gmail task'}. The backend verifies the returned account before reading mail.</p>}
    {state?.connecting && <p className="gmail-copy" role="status">Finish Google consent in the browser that opened. Return here afterward; connection status updates automatically.</p>}
    {state?.connectedAccount && <p className="gmail-copy">Connected account: <strong>{state.connectedAccount}</strong>{account && !connected ? '. This does not authorize the different account required by this task.' : '.'}</p>}
    {connected && <p className="gmail-copy">A read-only connection is saved. The backend rechecks the account before reading mail; an owner-paused task stays paused.</p>}
    {settings && state?.configured && <p className="gmail-copy">Replacing the OAuth client clears the saved Gmail connection. Disconnect removes local tokens; Google account permissions can also be revoked in your Google account settings.</p>}
    <div className="gmail-actions">{state?.connectedAccount&&<button className="button small" disabled={blocked} onClick={()=>void controller.perform({type:'gmail.verify'})}>Verify account for project use</button>}{!state?.configured || settings ? <button className="button small" disabled={blocked || !state} onClick={() => void controller.importClient()}>{state?.configured ? 'Replace OAuth client JSON' : 'Import OAuth client JSON'}</button> : null}{(!connected || requireConnection || settings || Boolean(state?.error)) && <button className="button small primary" disabled={blocked || !state?.configured || !chosen} onClick={() => chosen && void controller.perform({ type: 'gmail.connect', taskId: chosen.taskId })}>{state?.connecting ? 'Consent in progress…' : connected ? 'Reconnect Gmail' : 'Connect Gmail'}</button>}{settings && state?.connectedAccount && <button className="button small danger-outline" disabled={blocked} onClick={() => void controller.perform({ type: 'gmail.disconnect' })}>Disconnect Gmail</button>}<button className="text-button" disabled={controller.busy} onClick={() => { controller.clearError(); void controller.refresh(); }}>Refresh</button></div>
    {!chosen && <p className="gmail-copy">A saved live task with an approved Gmail account is required to connect. The account cannot be changed through this connection panel.</p>}
    <p className="gmail-privacy">Google grants read-only Gmail access. Tasks read their unread listing, or selected threads and safe attachments when you enable detailed review; it cannot send mail or change read/unread state through this connection. Verify the connected account, then approve it for the intended project in Projects. Tokens stay in the trusted backend.</p>
  </section>;
}
