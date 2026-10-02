import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { AppBridge, BrowserCommand, BrowserState, Snapshot, Task } from '../../../packages/contracts/index';
import { formatBytes } from './Files';
import { BrowserSetupCard, useBrowserSetup } from './BrowserSetup';
import './browser.css';

type Glyph = 'browser' | 'expand' | 'close' | 'plus' | 'refresh' | 'arrow' | 'shield' | 'upload' | 'download';
function BrowserGlyph({ name, size = 16 }: { name: Glyph; size?: number }) {
  const paths: Record<Glyph, ReactNode> = {
    browser: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
    expand: <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 7V3m0 4h-4M4 17v4m0-4h4" /><path d="M20 7a9 9 0 0 0-16 1m0 9a9 9 0 0 0 16-1" /></>,
    arrow: <path d="m13 5 7 7-7 7M4 12h16" />,
    shield: <><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    upload: <><path d="M5 14v6h14v-6M12 15V3m-4 4 4-4 4 4" /></>,
    download: <><path d="M5 14v6h14v-6M12 3v12m-4-4 4 4 4-4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

type PendingInput = { sessionId: string; generation: number; tabId: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'pointer'; x: number; y: number; button: 'left' }
  | { kind: 'scroll'; deltaX: number; deltaY: number }
);
function originOf(url: string | undefined) {
  try { const urlValue = new URL(url || ''); return ['http:', 'https:'].includes(urlValue.protocol) ? urlValue.origin : null; }
  catch { return null; }
}
function ExpandedBrowser({ name, children, close }: { name: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => { ref.current?.showModal(); heading.current?.focus(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className="modal browser-expanded-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="modal-header"><div><span className="eyebrow">PRIVATE AGENT BROWSER</span><h2 id={id} tabIndex={-1} ref={heading}>{name}’s browser</h2></div><button className="icon-button" aria-label="Close expanded browser" onClick={close}><BrowserGlyph name="close" /></button></div>
    <div className="browser-expanded-body">{children}</div>
  </dialog>;
}

/** Frames and queued owner input live only in this mounted component. */
export function BrowserPanel({ bridge, snapshot, task, onFiles }: { bridge: AppBridge; snapshot: Snapshot; task: Task; onFiles: () => void }) {
  const setup = useBrowserSetup(bridge, task.agentId);
  const [state, setState] = useState<BrowserState | null>(null);
  const backend = state?.lifecycle === 'ready' ? state.runtime.backend ?? setup.state?.backend : setup.state?.backend ?? state?.runtime.backend;
  const native = backend === 'desktop_chrome';
  const localLab = backend === 'local_lab';
  const actualWindow = native || localLab;
  const actualWindowRef = useRef(actualWindow);
  actualWindowRef.current = actualWindow;
  const stateRef = useRef<BrowserState | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [freshRequired, setFreshRequired] = useState(false);
  const freshRequiredRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [transition, setTransition] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [address, setAddress] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadVersion, setUploadVersion] = useState('');
  const [uploadTarget, setUploadTarget] = useState('');
  const [uploadConfirmed, setUploadConfirmed] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const inputExitTarget = useRef<HTMLDivElement>(null);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const alive = useRef(true);
  const lock = useRef(false);
  const readingState = useRef(false);
  const queue = useRef<PendingInput[]>([]);
  const draining = useRef(false);
  const drainRef = useRef<() => void>(() => {});
  const uploadOpenRef = useRef(false);
  uploadOpenRef.current = uploadOpen;
  const composing = useRef(false);
  const lastComposition = useRef<string | null>(null);
  const agent = snapshot.agents.find(item => item.id === task.agentId);
  const inputHelpId = useId();

  const clearQueue = useCallback(() => { queue.current = []; if (alive.current) setQueued(0); }, []);
  const apply = useCallback((next: BrowserState) => {
    if (!alive.current || next.agentId !== task.agentId) return;
    const previous = stateRef.current;
    if (previous && next.revision < previous.revision) return;
    if (previous && (previous.sessionId !== next.sessionId || previous.generation !== next.generation || previous.activeTabId !== next.activeTabId || next.controller !== 'human')) clearQueue();
    stateRef.current = next; setState(next);
  }, [clearQueue, task.agentId]);
  const readState = useCallback(async () => {
    if (readingState.current || !alive.current) return;
    readingState.current = true;
    try { apply(await bridge.browser({ type: 'browser.state', agentId: task.agentId })); }
    catch (failure) { if (alive.current) { setError(failure instanceof Error ? failure.message : 'The browser service could not be reached.'); freshRequiredRef.current = true; setFreshRequired(true); } }
    finally { readingState.current = false; }
  }, [apply, bridge, task.agentId]);

  const run = useCallback(async (command: BrowserCommand, options: { fresh?: boolean; quiet?: boolean } = {}) => {
    if (lock.current || !alive.current) return null;
    lock.current = true;
    setBusy(true);
    if (!options.quiet) { setError(null); setMessage(null); }
    try {
      const result = await bridge.browser(command);
      if (!alive.current) return null;
      apply(result);
      if (options.fresh && result.frame) { freshRequiredRef.current = false; setFreshRequired(false); }
      return result;
    } catch (failure) {
      clearQueue();
      if (alive.current) {
        setError(failure instanceof Error ? failure.message : 'The browser action failed.');
        setMessage('The action was not retried. Refresh the view and check the page before continuing.');
        freshRequiredRef.current = true; setFreshRequired(true);
      }
      void readState();
      return null;
    } finally { lock.current = false; if (alive.current) { setBusy(false); queueMicrotask(() => drainRef.current()); } }
  }, [apply, bridge, clearQueue, readState]);

  useEffect(() => {
    alive.current = true;
    void readState();
    const unsubscribe = bridge.onBrowserChanged(() => { void readState(); });
    const timer = window.setInterval(() => {
      const current = stateRef.current;
      if ((actualWindowRef.current && current?.controller === 'human') || document.visibilityState !== 'visible' || uploadOpenRef.current || lock.current || queue.current.length || freshRequiredRef.current || !current?.sessionId || !current.activeTabId || current.lifecycle !== 'ready' || current.controller === 'transitioning') return;
      void run({ type: 'browser.observe', agentId: task.agentId, sessionId: current.sessionId, generation: current.generation }, { quiet: true });
    }, 2000);
    return () => { alive.current = false; clearInterval(timer); unsubscribe(); queue.current = []; stateRef.current = null; };
  }, [bridge, clearQueue, readState, run, task.agentId, task.executionMode]);
  useEffect(() => {
    const tab = state?.tabs.find(item => item.id === state.activeTabId);
    setAddress(tab?.url === 'about:blank' ? '' : tab?.url || '');
  }, [state?.activeTabId, state?.tabs.find(item => item.id === state.activeTabId)?.url]);
  useEffect(() => { setUploadConfirmed(false); }, [uploadTarget, uploadVersion, state?.generation, state?.activeTabId, state?.frame?.revision]);

  const drain = async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      while (alive.current && queue.current.length) {
        if (lock.current) break;
        const input = queue.current.shift()!;
        setQueued(queue.current.length);
        const current = stateRef.current;
        if (actualWindowRef.current || !current?.sessionId || current.lifecycle !== 'ready' || current.controller !== 'human' || freshRequiredRef.current || input.sessionId !== current.sessionId || input.generation !== current.generation || input.tabId !== current.activeTabId || current.frame?.tabId !== input.tabId || current.frame.generation !== current.generation) { clearQueue(); break; }
        const common = { agentId: task.agentId, sessionId: current.sessionId, generation: current.generation, tabId: input.tabId, revision: current.frame.revision };
        const command: BrowserCommand = input.kind === 'text' ? { type: 'browser.text', ...common, text: input.text } : input.kind === 'key' ? { type: 'browser.key', ...common, key: input.key } : input.kind === 'pointer' ? { type: 'browser.pointer', ...common, x: Math.round(input.x), y: Math.round(input.y) } : { type: 'browser.scroll', ...common, x: Math.round(input.deltaX), y: Math.round(input.deltaY) };
        if (!await run(command)) { clearQueue(); break; }
      }
    } finally { draining.current = false; if (alive.current) setQueued(queue.current.length); }
  };
  drainRef.current = () => { if (alive.current && queue.current.length) void drain(); };
  // A quiet observation may finish while typing begins. Drain afterwards, without
  // retaining browser input in a timer, storage, logs, or the task conversation.
  useEffect(() => { if (!busy && queued > 0 && !lock.current) void drain(); }, [busy, queued]);

  const enqueue = (input: Omit<Extract<PendingInput, { kind: 'text' }>, 'sessionId' | 'generation' | 'tabId'> | Omit<Extract<PendingInput, { kind: 'key' }>, 'sessionId' | 'generation' | 'tabId'> | Omit<Extract<PendingInput, { kind: 'pointer' }>, 'sessionId' | 'generation' | 'tabId'> | Omit<Extract<PendingInput, { kind: 'scroll' }>, 'sessionId' | 'generation' | 'tabId'>) => {
    const current = stateRef.current;
    if (actualWindowRef.current || freshRequiredRef.current || !current?.sessionId || current.controller !== 'human' || current.lifecycle !== 'ready' || !current.frame || current.frame.tabId !== current.activeTabId || current.frame.generation !== current.generation) return;
    if (queue.current.length >= 256 || (input.kind === 'text' && input.text.length > 8192)) { clearQueue(); freshRequiredRef.current = true; setFreshRequired(true); setError('Input limit reached. Pending input was discarded; the last action may have completed. Refresh the view before continuing, and paste fewer than 8,192 characters at a time.'); return; }
    const last = queue.current.at(-1);
    if (input.kind === 'text' && last?.kind === 'text' && last.tabId === current.activeTabId && last.generation === current.generation && last.text.length + input.text.length <= 8192) last.text += input.text;
    else if (input.kind === 'scroll' && last?.kind === 'scroll' && last.tabId === current.activeTabId && last.generation === current.generation) { last.deltaX = Math.max(-2000, Math.min(2000, last.deltaX + input.deltaX)); last.deltaY = Math.max(-2000, Math.min(2000, last.deltaY + input.deltaY)); }
    else queue.current.push({ ...input, sessionId: current.sessionId, generation: current.generation, tabId: current.activeTabId! });
    setQueued(queue.current.length); void drain();
  };
  const leaveInput = () => { keyboard.current?.blur(); inputExitTarget.current?.focus(); };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); leaveInput(); return; }
    if (event.nativeEvent.isComposing || composing.current || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
    if (event.key.length === 1 && ((!event.metaKey && !event.ctrlKey) || event.getModifierState('AltGraph'))) return;
    event.preventDefault();
    const key = event.key === ' ' ? 'Space' : event.key;
    enqueue({ kind: 'key', key: [event.ctrlKey || event.metaKey ? 'Control' : null, event.altKey ? 'Alt' : null, event.shiftKey ? 'Shift' : null, key].filter(Boolean).join('+') });
  };

  const bound = () => {
    const current = stateRef.current;
    return current?.sessionId ? { agentId: task.agentId, sessionId: current.sessionId, generation: current.generation } : null;
  };
  const refresh = async () => {
    const current = stateRef.current, binding = bound();
    if (actualWindowRef.current && current?.controller === 'human') { await readState(); return; }
    if (binding && current?.activeTabId) await run({ type: 'browser.observe', ...binding }, { fresh: true });
    else await readState();
  };
  const control = async () => {
    const current = stateRef.current, binding = bound();
    if (!binding || !current || lock.current || queue.current.length) return;
    clearQueue(); setTransition(true); setUploadOpen(false);
    try {
      const next = await run({ type: current.controller === 'human' ? 'browser.returnControl' : 'browser.takeControl', ...binding }, { fresh: true });
      if (next) {
        if (next.controller === 'human' && native) {
          await setup.perform({ type: 'browserSetup.openProfile', agentId: task.agentId });
          setMessage('You control this agent’s Chrome window. Agent inspection is suspended until you return control.');
        } else if (next.controller === 'human' && localLab) {
          setMessage('You control this agent’s local browser window. Page capture and agent actions are suspended until you return control.');
        } else setMessage(next.controller === 'human' ? 'You control this browser. Page input stays out of model observations and saved traces.' : 'Returned to the agent with a fresh view of the page.');
      }
    } finally { if (alive.current) setTransition(false); }
  };
  const navigate = async (event: FormEvent) => {
    event.preventDefault();
    const current = stateRef.current, binding = bound();
    if (!binding || !current || !address.trim() || current.controller !== 'human' || (current.activeTabId && freshRequiredRef.current)) return;
    const url = /^[a-z][a-z\d+.-]*:/i.test(address.trim()) ? address.trim() : 'https://' + address.trim();
    if (current.activeTabId) await run({ type: 'browser.navigate', ...binding, tabId: current.activeTabId, revision: current.frame?.revision || 0, url }, { fresh: true });
    else await run({ type: 'browser.newTab', ...binding, url }, { fresh: true });
  };
  const controller = transition || state?.controller === 'transitioning' ? 'transitioning' : state?.controller;
  const ready = state?.lifecycle === 'ready';
  const busyControls = busy || queued > 0 || transition || setup.busy;
  const human = ready && controller === 'human';
  const frame = ready && !(actualWindow && controller === 'human') && !transition && !freshRequired && state?.frame?.dataUrl.startsWith('data:image/jpeg;base64,') && state.frame.generation === state.generation && state.frame.tabId === state.activeTabId ? state.frame : null;
  const canInput = !actualWindow && human && !!frame;
  wheelHandler.current = event => {
    event.preventDefault();
    if (!canInput || !frame) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1;
    enqueue({ kind: 'scroll', deltaX: Math.max(-2000, Math.min(2000, event.deltaX * multiplier)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY * multiplier)) });
  };
  useEffect(() => {
    const element = keyboard.current;
    const handleWheel = (event: WheelEvent) => wheelHandler.current(event);
    element?.addEventListener('wheel', handleWheel, { passive: false });
    return () => element?.removeEventListener('wheel', handleWheel);
  }, [expanded, !!frame]);
  const activeTab = state?.tabs.find(item => item.id === state.activeTabId);
  const destinationOrigin = originOf(activeTab?.url);
  const associated = state?.taskId === task.id;
  const inputs = snapshot.taskArtifacts.filter(link => link.taskId === task.id).map(link => snapshot.artifacts.find(item => item.id === link.versionId)).filter(item => item?.status === 'ready' && (item.visibility === 'shared' || item.ownerAgentId === task.agentId));
  const chosen = inputs.find(item => item?.id === uploadVersion);
  const uploadTargets = state?.targets.filter(target => target.kind === 'file') || [];
  const profileNote = native ? <p className="browser-session-note"><BrowserGlyph name="shield" size={11} /> <strong>Dedicated Chrome profile.</strong> Chrome retains this agent’s local login state. Other Chrome profiles stay separate. Site login and MFA support depend on the website.</p> : localLab ? <p className="browser-session-note"><BrowserGlyph name="shield" size={11} /> <strong>Temporary per-agent session.</strong> Cookies and website storage stay separate from other agents and are cleared when this browser closes.</p> : <p className="browser-session-note"><BrowserGlyph name="shield" size={11} /> <strong>Logins remembered locally.</strong> This agent’s private profile is saved at checkpoints{state?.profile.saved ? ' and restored when it reopens' : ''}. A crash can lose recent changes or require login again.</p>;
  const openBrowser = async () => { clearQueue(); await run({ type: 'browser.open', agentId: task.agentId, taskId: task.id }, { fresh: true }); };
  const moveToTask = async () => { const binding = bound(); if (!binding || lock.current) return; clearQueue(); if (await run({ type: 'browser.close', ...binding })) await openBrowser(); };
  const showFiles = () => { setExpanded(false); onFiles(); };

  const content = <div className="browser-panel" ref={inputExitTarget} tabIndex={-1}>
    <div className="browser-panel-heading"><div><h2>{agent?.name || 'Agent'}’s browser</h2><p>{!backend ? 'Checking browser backend' : native ? 'Desktop Chrome · Dedicated profile' : localLab ? 'Local lab Electron · Temporary session' : 'Docker Chromium · Isolated session'} · Up to 6 tabs</p></div>{ready ? <span className="browser-live"><span /> LIVE</span> : <BrowserGlyph name="browser" />}</div>
    {!localLab && <BrowserSetupCard controller={setup} agentId={task.agentId} sessionOpen={Boolean(state && ['ready', 'starting', 'closing'].includes(state.lifecycle))} human={human} agentWorking={snapshot.tasks.some(item => item.agentId === task.agentId && ['running', 'pausing', 'recovering'].includes(item.state))} />}
    {(error || state?.error) && <div className="browser-error" role="alert"><p>{error || state?.error}</p>{message && <p>{message}</p>}{freshRequired && ready && !(actualWindow && human) && <button className="button small" disabled={busyControls} onClick={() => void refresh()}>Get a fresh view</button>}</div>}
    {!error && message && <div className="browser-status-message" role="status">{message}</div>}
    {!state ? <div className="browser-start" role="status"><span className="browser-start-symbol"><BrowserGlyph name="browser" size={26} /></span><h3>Checking browser service</h3><p>{localLab ? 'Reading this agent’s local session state.' : 'Reading this agent’s saved session state.'}</p>{error && <button className="button small" onClick={() => void readState()}>Try again</button>}</div> : !ready ? <>
      <div className="browser-start"><span className="browser-start-symbol"><BrowserGlyph name="browser" size={26} /></span><h3>{state.lifecycle === 'starting' ? 'Opening private browser' : state.lifecycle === 'disconnected' ? 'Session disconnected' : state.lifecycle === 'closing' ? localLab ? 'Closing temporary browser' : 'Saving and closing browser' : state.lifecycle === 'error' ? 'Browser needs attention' : 'Your agent’s own browser'}</h3><p>{state.error || state.runtime.message || (native ? 'Open this agent’s dedicated Chrome profile. Connect its extension using Browser setup above. Agent work stays in background tabs; manual control opens Chrome only when you ask.' : localLab ? 'Open this agent’s local browser window. Tabs and cookies stay separate from other agents. This temporary session is cleared when the browser closes.' : 'Open a live browser in an isolated container. Its tabs and logins stay separate from other agents. Up to two browsers can run at once.')}</p><button className="button primary small" disabled={busyControls || state.lifecycle === 'starting' || state.lifecycle === 'closing'} onClick={() => void openBrowser()}>{busy || state.lifecycle === 'starting' ? 'Opening…' : state.lifecycle === 'disconnected' || state.lifecycle === 'error' ? 'Reconnect browser' : state.runtime.ready ? 'Open browser' : 'Check and open browser'}<BrowserGlyph name="arrow" size={14} /></button></div>
      {profileNote}<p className="browser-session-note">{task.executionMode === 'live' ? 'This browser is available to the live agent within its task policy. Take control for sign-in or direct interaction.' : 'This task uses a simulation. Browser interactions here are live; no model controls this task.'}</p>
    </> : actualWindow ? <>
      {state.requestId && <div className="browser-status-message" role="status"><strong>Browser handoff requested</strong><p>{localLab ? 'Take control and finish sign-in in this agent’s local browser window.' : 'Take control and finish sign-in in this agent’s Chrome window.'} Return control here when ready.</p></div>}
      <div className="browser-control"><span className={'browser-controller ' + controller}><span />Controller: <strong>{human ? localLab ? 'You in the local window' : 'You in Chrome' : controller === 'transitioning' ? 'Transitioning' : 'Agent'}</strong></span><button className="button small primary" disabled={busyControls || controller === 'transitioning'} onClick={() => void control()}>{controller === 'transitioning' ? 'Changing control…' : human ? 'Return to agent' : localLab ? 'Take control in local window' : 'Take control in Chrome'}</button><p className="browser-control-note">{localLab ? human ? 'No page capture or agent actions while you control this window.' : 'Take control to bring this agent’s local browser window to the front.' : human ? 'No page capture or agent actions while you control Chrome.' : 'The agent works in background tabs. Your current Mac app keeps focus.'}</p></div>
      {!associated && <div className="browser-status-message"><p>This session belongs to another task for this agent.</p><button className="button small" disabled={busyControls} onClick={() => void moveToTask()}>Close and reopen for this task</button></div>}
      {human ? <div className="browser-native-owner"><BrowserGlyph name="browser" size={26} /><h3>{localLab ? 'Continue in the local browser window' : 'Continue in the Chrome window'}</h3><p>{localLab ? 'Use this agent’s temporary browser window to sign in, navigate and manage tabs.' : 'Use the dedicated profile to sign in, navigate and manage tabs.'} Page capture is hidden during your handoff. Return control above when finished.</p>{native && <button className="button small" disabled={busyControls} onClick={() => void setup.perform({ type: 'browserSetup.openProfile', agentId: task.agentId })}>Show this agent’s Chrome</button>}</div> : <>
        <div className="browser-tabs" aria-label={localLab ? 'Agent local browser tabs' : 'Agent Chrome tabs'}>{state.tabs.map(tab => <div className={'browser-tab' + (tab.id === state.activeTabId ? ' selected' : '')} key={tab.id}><span className="browser-tab-select" title={tab.url}>{tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url) || 'Untitled tab'}</span></div>)}</div>
        <div className="browser-toolbar"><button className="button small" disabled={busyControls || !state.activeTabId} onClick={() => void refresh()}><BrowserGlyph name="refresh" size={13} />Refresh observation</button>{!expanded && <button className="icon-button" aria-label="Expand browser observation" onClick={() => setExpanded(true)}><BrowserGlyph name="expand" size={13} /></button>}</div>
        {activeTab && <p className="browser-session-note">{activeTab.url}</p>}
        <div className="browser-viewport">{frame ? <img src={frame.dataUrl} width={frame.width} height={frame.height} alt={'Agent browser observation: ' + (activeTab?.title || 'Current page')} draggable={false} /> : <div className="browser-viewport-empty"><BrowserGlyph name="browser" size={24} /><strong>{freshRequired ? 'A fresh observation is required' : 'Waiting for an agent observation'}</strong><p>{localLab ? 'Screenshots appear only while the agent controls this browser. Take control to interact in the local browser window.' : 'Background screenshots appear only while the agent controls this browser. Take control to interact in Chrome.'}</p></div>}</div>
        <p className="browser-view-caption">{localLab ? 'Browser observation' : 'Background observation'} · Read-only in this panel</p>
      </>}
      <div className="browser-session-actions"><button className="button small" disabled={busyControls} onClick={async () => { const binding = bound(); if (binding) { clearQueue(); await run({ type: 'browser.close', ...binding }); } }}>Close browser session</button></div>
      <p className="browser-session-note">{localLab ? 'Managed file transfers are not available in the local lab browser.' : 'Managed file transfers are not available in Desktop Chrome. Use the Docker browser for verified uploads and downloads.'}</p>
      {profileNote}
    </> : <>
      {state.requestId && <div className="browser-status-message" role="status"><strong>Login requested</strong><p>Take control, sign in on the page, then return control. Credentials stay out of task messages and saved traces.</p></div>}
      <div className="browser-control"><span className={'browser-controller ' + controller}><span />Controller: <strong>{controller === 'human' ? 'You' : controller === 'transitioning' ? 'Transitioning' : controller === 'agent' ? 'Agent' : 'None'}</strong></span><button className="button small primary" disabled={busyControls || controller === 'transitioning'} onClick={() => void control()}>{controller === 'transitioning' ? 'Finishing current action…' : controller === 'human' ? 'Return to agent' : 'Take control'}</button><p className="browser-control-note">{controller === 'transitioning' ? 'Waiting for the current action before changing controller.' : controller === 'human' ? 'Only you can enter text, navigate, and interact.' : task.executionMode === 'live' ? 'Agent controls this browser. Take control to pause its actions and sign in.' : 'Take control to browse or sign in. This task uses a simulation.'}</p></div>
      {!associated && <div className="browser-status-message"><p>This session belongs to another task for {agent?.name || 'this agent'}. Close and reopen it for this task before transferring files. Its saved login profile stays with the agent.</p><button className="button small" disabled={busyControls} onClick={() => void moveToTask()}>Close and reopen for this task</button></div>}
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">{state.tabs.map(tab => <div className={'browser-tab' + (tab.id === state.activeTabId ? ' selected' : '')} key={tab.id}><button className="browser-tab-select" role="tab" aria-selected={tab.id === state.activeTabId} disabled={busyControls || !human} title={tab.url} onClick={() => { const binding = bound(); if (binding) { clearQueue(); setUploadOpen(false); void run({ type: 'browser.selectTab', ...binding, tabId: tab.id }, { fresh: true }); } }}>{tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url) || 'Untitled tab'}</button><button className="icon-button" aria-label={'Close ' + (tab.title || 'tab')} disabled={busyControls || !human} onClick={() => { const binding = bound(); if (binding) { clearQueue(); setUploadOpen(false); void run({ type: 'browser.closeTab', ...binding, tabId: tab.id }, { fresh: true }); } }}><BrowserGlyph name="close" size={11} /></button></div>)}</div>
      <div className="browser-toolbar"><button ref={refreshButton} className="icon-button" aria-label="Refresh browser view" title="Refresh view without reloading the page" disabled={busyControls || !state.activeTabId} onClick={() => void refresh()}><BrowserGlyph name="refresh" size={13} /></button><form className="browser-address" onSubmit={event => void navigate(event)}><input aria-label="Website address" placeholder="https://example.com" value={address} maxLength={4096} disabled={busyControls || !human || (!!state.activeTabId && !frame)} onChange={event => setAddress(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" /><button className="button small" aria-label="Navigate to website" disabled={busyControls || !human || !address.trim() || (!!state.activeTabId && !frame)} type="submit"><BrowserGlyph name="arrow" size={13} /></button></form><button className="icon-button" aria-label="New browser tab" title={state.tabs.length >= 6 ? 'Six tab limit reached' : 'New tab'} disabled={busyControls || !human || state.tabs.length >= 6} onClick={() => { const binding = bound(); if (binding) void run({ type: 'browser.newTab', ...binding, url: 'about:blank' }, { fresh: true }); }}><BrowserGlyph name="plus" size={13} /></button>{!expanded && <button className="icon-button" aria-label="Expand browser" title="Expand browser" onClick={() => setExpanded(true)}><BrowserGlyph name="expand" size={13} /></button>}</div>
      <div className="browser-viewport">
        {frame ? <><img src={frame.dataUrl} width={frame.width} height={frame.height} alt={'Current page: ' + (activeTab?.title || activeTab?.url || 'New tab')} draggable={false} /><textarea ref={keyboard} className="browser-keyboard-surface" aria-label="Live browser page input" aria-describedby={inputHelpId} disabled={!canInput || transition} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" onFocus={() => setKeyboardFocused(true)} onBlur={() => { setKeyboardFocused(false); composing.current = false; if (keyboard.current) keyboard.current.value = ''; }} onKeyDown={keyDown}
          onChange={event => { if (composing.current) return; const text = event.currentTarget.value; event.currentTarget.value = ''; if (lastComposition.current === text && /composition/i.test((event.nativeEvent as InputEvent).inputType || '')) { lastComposition.current = null; return; } lastComposition.current = null; if (text) enqueue({ kind: 'text', text }); }}
          onCompositionStart={() => { composing.current = true; lastComposition.current = null; }} onCompositionEnd={event => { composing.current = false; lastComposition.current = event.data; event.currentTarget.value = ''; if (event.data) enqueue({ kind: 'text', text: event.data }); }}
          onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (text) enqueue({ kind: 'text', text }); }}
          onPointerDown={event => { if (!canInput || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); const rect = event.currentTarget.getBoundingClientRect(); enqueue({ kind: 'pointer', x: Math.max(0, Math.min(frame.width - 1, (event.clientX - rect.left) * frame.width / rect.width)), y: Math.max(0, Math.min(frame.height - 1, (event.clientY - rect.top) * frame.height / rect.height)), button: 'left' }); }}
          onContextMenu={event => event.preventDefault()} /></> : <div className="browser-viewport-empty"><BrowserGlyph name="browser" size={24} /><strong>{freshRequired ? 'A fresh view is required' : !state.tabs.length ? 'No open tabs' : controller === 'transitioning' ? 'Changing browser control' : 'Waiting for the current page'}</strong><p>{freshRequired ? 'The previous frame is hidden. Refresh the view to check the page before another action.' : !state.tabs.length ? 'Take control and open a tab to visit a website.' : 'Only a current frame from this session will appear here.'}</p></div>}
      </div>
      <div className="browser-view-caption"><span id={inputHelpId}>{human ? 'Click page to type · Tab moves within page · Esc leaves page input' : 'Owner view · Take control to interact'}</span><span>{queued ? queued + ' input actions queued' : busy ? 'Updating…' : frame ? frame.width + ' × ' + frame.height : 'No live frame'}</span>{keyboardFocused && <button className="inline-link" onClick={leaveInput}>Leave page input</button>}</div>
      <div className="browser-session-actions"><button className="button small" disabled={busyControls || !canInput} onClick={() => enqueue({ kind: 'key', key: 'Escape' })}>Send Esc to page</button><button className="button small" disabled={busyControls || !canInput || !associated || !destinationOrigin} onClick={() => { setUploadOpen(!uploadOpen); setUploadVersion(''); setUploadTarget(''); setUploadConfirmed(false); }}><BrowserGlyph name="upload" size={12} />Upload task file</button><button className="button small" disabled={busyControls} onClick={async () => { const binding = bound(); if (binding) { clearQueue(); await run({ type: 'browser.close', ...binding }); } }}>Close browser</button></div>
      {uploadOpen && <form className="browser-upload-box" onSubmit={async event => { event.preventDefault(); const binding = bound(), current = stateRef.current; if (!binding || !current?.activeTabId || !current.frame || !chosen || !uploadConfirmed || !destinationOrigin) return; const result = await run({ type: 'browser.upload', ...binding, tabId: current.activeTabId, revision: current.frame.revision, versionId: chosen.id, ref: uploadTarget, destinationOrigin }); if (result) { setUploadOpen(false); setMessage('The selected file version was supplied to the website’s upload field.'); } }}><h3>Confirm website upload</h3><p>Only an exact version already linked to this task can be supplied. Choose the website’s upload field, then confirm its destination.</p><label>Task file version<select value={uploadVersion} required onChange={event => setUploadVersion(event.target.value)} disabled={busyControls}><option value="" disabled>Select a linked version</option>{inputs.map(item => item && <option value={item.id} key={item.id}>{item.displayName} · v{item.version} · {formatBytes(item.bytes)}</option>)}</select></label>{!inputs.length && <p>Link or import a file in the Files panel first.</p>}<label>Website upload field<select value={uploadTarget} required onChange={event => setUploadTarget(event.target.value)} disabled={busyControls}><option value="" disabled>Select an upload field</option>{uploadTargets.map(item => <option value={item.ref} key={item.ref}>{item.label || 'File upload field'}</option>)}</select></label>{!uploadTargets.length && <p>No supported file input is available in this page view. Open the website’s upload form and refresh the view.</p>}<div className="browser-upload-confirm">Destination: <strong>{destinationOrigin}</strong><br />File: <strong>{chosen ? chosen.displayName + ' · v' + chosen.version : 'Choose a version above'}</strong><br />From {agent?.name || 'this agent'}’s task.</div><label className="browser-upload-check"><input type="checkbox" checked={uploadConfirmed} disabled={busyControls || !chosen || !uploadTarget} onChange={event => setUploadConfirmed(event.target.checked)} /><span>I authorize supplying this exact file version to the website above.</span></label><div className="browser-upload-actions"><button className="button small" type="button" disabled={busyControls} onClick={() => setUploadOpen(false)}>Cancel</button><button className="button primary small" type="submit" disabled={busyControls || !chosen || !uploadTarget || !uploadConfirmed || !canInput}>Upload version</button></div></form>}
      <section className="browser-downloads"><div className="browser-downloads-heading"><h3>Private downloads</h3><button className="inline-link" onClick={showFiles}>Open Files</button></div>{state.downloads.length ? state.downloads.map(item => <div className="browser-download" key={item.id}><BrowserGlyph name="download" size={14} /><div><strong title={item.name}>{item.name}</strong><p>{formatBytes(item.bytes)} · {item.versionId ? 'Saved as a private file' : item.state}</p>{!item.versionId && item.state === 'ready' && <button className="inline-link" disabled={busyControls || !associated} onClick={() => { const binding = bound(); if (binding) void run({ type: 'browser.saveDownload', ...binding, downloadId: item.id }); }}>Save to private files</button>}</div></div>) : <p className="browser-downloads-empty">Website downloads appear here and are saved to this agent’s private files.</p>}</section>
      {profileNote}
    </>}
  </div>;
  return <>{expanded ? <><div className="browser-start"><span className="browser-start-symbol"><BrowserGlyph name="expand" size={22} /></span><h3>Browser expanded</h3><p>The same private session is open in the larger view.</p><button className="button small" onClick={() => setExpanded(false)}>Return to panel</button></div><ExpandedBrowser name={agent?.name || 'Agent'} close={() => setExpanded(false)}>{content}</ExpandedBrowser></> : content}</>;
}
