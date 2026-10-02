import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppBridge, BrowserSetupCommand, BrowserSetupState } from '../../../packages/contracts/index';
import './browser-setup.css';

export function useBrowserSetup(bridge: AppBridge, agentId: string) {
  const [state, setState] = useState<BrowserSetupState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const alive = useRef(true), lock = useRef(false), reading = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!alive.current || lock.current || reading.current) return;
    reading.current = true;
    const ticket = ++sequence.current;
    try { const next = await bridge.browserSetup({ type: 'browserSetup.state', agentId }); if (alive.current && ticket === sequence.current) { setState(next); setError(null); } }
    catch (failure) { if (alive.current && ticket === sequence.current) setError(failure instanceof Error ? failure.message : 'Browser setup state is unavailable.'); }
    finally { reading.current = false; }
  }, [agentId, bridge]);
  useEffect(() => {
    alive.current = true; void refresh();
    const off = bridge.onBrowserChanged(() => void refresh());
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 3000);
    return () => { alive.current = false; sequence.current++; clearInterval(timer); off(); };
  }, [bridge, refresh]);
  const perform = async (command: BrowserSetupCommand) => {
    if (lock.current || !alive.current) return null;
    lock.current = true; sequence.current++; setBusy(true); setError(null);
    try { const next = await bridge.browserSetup(command); if (alive.current) setState(next); return next; }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'Browser setup could not finish. Check its status before retrying.'); return null; }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return { state, busy, error, refresh, perform, clearError: () => setError(null) };
}
export type BrowserSetupController = ReturnType<typeof useBrowserSetup>;

export function BrowserSetupCard({ controller, agentId, sessionOpen, human, agentWorking }: { controller: BrowserSetupController; agentId: string; sessionOpen: boolean; human: boolean; agentWorking: boolean }) {
  const state = controller.state;
  const [copied, setCopied] = useState(false);
  const locked = controller.busy || sessionOpen || agentWorking;
  const ownerLocked = controller.busy || (sessionOpen && !human) || (!sessionOpen && agentWorking);
  const health = state?.health;
  const heading = health === 'connected' ? 'Browser connected' : health === 'profile_closed' ? 'Ready to reconnect' : health === 'extension_disconnected' ? 'Connection needs attention' : health === 'profile_repair' ? 'Profile needs repair' : health === 'runtime_unavailable' ? 'Browser support unavailable' : 'Connect this agent’s browser';
  const needsInstall = state?.setupRequired && health !== 'runtime_unavailable' && health !== 'profile_repair';
  return <details className="browser-setup-card" open={state?.backend === 'desktop_chrome' && !state.ready ? true : undefined}><summary>Browser setup · {state ? state.backend === 'desktop_chrome' ? 'Desktop Chrome' : 'Isolated Docker browser' : 'Checking…'}</summary>
    {controller.error && <p className="browser-error" role="alert">{controller.error}</p>}
    {state ? <><label>Browser for this agent<select aria-label="Agent browser backend" value={state.backend} disabled={locked} onChange={event => void controller.perform({ type: 'browserSetup.selectBackend', agentId, backend: event.target.value as BrowserSetupState['backend'] })}><option value="desktop_chrome">Desktop Chrome · dedicated profile</option><option value="docker">Docker · isolated Chromium</option></select></label>{sessionOpen || agentWorking ? <p className="browser-session-note">Close this browser session and pause the agent’s running task before changing its browser.</p> : null}
      {state.backend === 'desktop_chrome' ? <><p className="browser-session-note">A separate Chrome profile for this agent. Desktop Chrome uses this Mac’s network and has no container egress boundary; task website allowlists govern agent tools. Choose Docker when a container network boundary is required.</p><div className="browser-health" data-health={health || 'checking'} role="status"><strong>{heading}</strong><p>{state.message || 'This agent’s private browser connection is available.'}</p></div>
        {needsInstall && <div className="browser-extension-instructions"><h3>One-time setup</h3><ol><li>Choose <strong>Open Chrome setup</strong> below.</li><li>On Chrome’s Extensions page, turn on <strong>Developer mode</strong> and choose <strong>Load unpacked</strong>.</li><li>Select the extension folder shown below. Keep this dedicated profile open, then check the connection.</li></ol>{state.extensionPath && <div className="browser-extension-path"><code>{state.extensionPath}</code><button type="button" className="inline-link" onClick={async () => { try { await navigator.clipboard.writeText(state.extensionPath!); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy folder path'}</button></div>}</div>}
        <div className="browser-session-actions"><button className="button small" disabled={ownerLocked || health === 'runtime_unavailable'} onClick={() => void controller.perform({ type: 'browserSetup.openProfile', agentId })}>{health === 'profile_closed' ? 'Reconnect Chrome' : 'Open Chrome window'}</button><button className="button small" disabled={locked || health === 'runtime_unavailable'} onClick={() => void controller.perform({ type: 'browserSetup.prepare', agentId })}>{needsInstall ? 'Open Chrome setup' : health === 'profile_repair' ? 'Repair profile setup' : 'Check extension'}</button></div><p className="browser-session-note">Take control to sign in or interact in this agent’s Chrome window. Return control when you’re ready for it to continue. Passwords and verification codes belong on the website.</p>{!state.supportsTransfers && <p className="browser-session-note">Managed file uploads and downloads require the Docker browser. Code runs in offline containers in either browser mode.</p>}</> : <><p className="browser-session-note">Chromium runs in a container with an embedded owner viewer and managed file transfers. Prepare its images with <code>npm run browser:setup</code> if needed.</p>{state.message && <p className="browser-session-note" role="status">{state.message}</p>}</>}
    </> : <p className="browser-session-note" role="status">Checking installed browser support without opening a window.</p>}
    <button className="inline-link" disabled={controller.busy} onClick={() => { controller.clearError(); void controller.refresh(); }}>Check connection</button>
  </details>;
}
