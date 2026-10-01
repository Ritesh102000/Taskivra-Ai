import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CODE_LIMITS, type AppBridge, type CodeCommand, type CodeDependency, type CodeExecution, type CodeLanguage, type CodeState, type Snapshot, type Task } from '../../../packages/contracts/index';
import { formatBytes, useFilePreview } from './Files';
import './code.css';

const languageLabels: Record<CodeLanguage, string> = { python: 'Python', node: 'Node.js', shell: 'Shell' };
const stateLabels: Record<CodeExecution['lifecycle'], string> = { preparing: 'Preparing', running: 'Running', exporting: 'Saving files', stopping: 'Stopping', succeeded: 'Completed', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' };
const activeStates = new Set(['preparing', 'running', 'exporting', 'stopping']);
const encoder = new TextEncoder();
const sourcePlaceholder: Record<CodeLanguage, string> = {
  python: '# Read an exact input path shown below.\n# Write deliverables to outputs/ in /workspace.\n',
  node: '// Read an exact input path shown below.\n// Write deliverables to outputs/ in /workspace.\n',
  shell: '# This script runs inside the isolated container.\n# Write deliverables to outputs/ in /workspace.\n',
};
function elapsed(execution: CodeExecution) {
  const duration = execution.durationMs;
  return duration === null ? activeStates.has(execution.lifecycle) ? `${Math.max(0, (Date.now() - execution.startedAt) / 1000).toFixed(1)} s elapsed` : 'Duration unavailable' : duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(1)} s`;
}
function commitMessage(execution: CodeExecution) {
  if (execution.workspaceCommitted) return `Workspace saved · revision ${execution.workspaceRevision}`;
  if (activeStates.has(execution.lifecycle)) return execution.lifecycle === 'exporting' ? 'Checking files before saving. No new revision is committed yet.' : 'Changes are temporary until the workspace is saved.';
  return 'Changes were not committed. The previous saved workspace is preserved.';
}
function StateBadge({ execution }: { execution: CodeExecution }) {
  return <span className={'code-state' + (execution.lifecycle === 'succeeded' ? ' success' : ['failed', 'interrupted'].includes(execution.lifecycle) ? ' failure' : '')}>{stateLabels[execution.lifecycle]}</span>;
}
function CodeDialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="modal code-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.currentTarget === event.target) close(); }}>
    <div className="modal-header"><div><span className="eyebrow">ISOLATED CODE EXECUTION</span><h2 id={id}>{title}</h2></div><button className="icon-button" aria-label="Close code dialog" onClick={close}>×</button></div>
    <div className="code-dialog-body">{children}</div>
  </dialog>;
}

export function CodePanel({ bridge, snapshot, task, onFiles }: { bridge: AppBridge; snapshot: Snapshot; task: Task; onFiles: () => void }) {
  const [state, setState] = useState<CodeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'run' | 'dependency' | string | null>(null);
  const [runtime, setRuntime] = useState<CodeLanguage>('python');
  const [source, setSource] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [selectedInputs, setSelectedInputs] = useState<string[]>([]);
  const [dependencyRuntime, setDependencyRuntime] = useState<'python' | 'node'>('python');
  const [packageName, setPackageName] = useState('');
  const [packageVersion, setPackageVersion] = useState('');
  const [reason, setReason] = useState('');
  const alive = useRef(true);
  const sequence = useRef(0);
  const reading = useRef(false);
  const actionLock = useRef(false);
  const readAgain = useRef(false);
  const preview = useFilePreview();
  const readState = useCallback(async () => {
    if (reading.current || actionLock.current) { readAgain.current = true; return; }
    reading.current = true;
    const ticket = ++sequence.current;
    try {
      const next = await bridge.code({ type: 'code.state', taskId: task.id });
      if (alive.current && ticket === sequence.current) setState(next);
    } catch (failure) {
      if (alive.current && ticket === sequence.current) setError(failure instanceof Error ? failure.message : 'Code status could not be read. Refresh before running another command.');
    } finally { reading.current = false; }
  }, [bridge, task.id]);
  useEffect(() => {
    alive.current = true;
    void readState();
    const off = bridge.onCodeChanged(() => void readState());
    const interval = setInterval(() => { if (document.visibilityState === 'visible') { readAgain.current = false; void readState(); } }, 1000);
    return () => { alive.current = false; sequence.current += 1; off(); clearInterval(interval); };
  }, [bridge, readState]);
  const perform = async (command: CodeCommand) => {
    if (actionLock.current) return null;
    actionLock.current = true; sequence.current += 1; setBusy(true); setError(null);
    try {
      const next = await bridge.code(command);
      if (alive.current) setState(next);
      return next;
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : 'This code operation did not finish. Read its current status before trying again.');
      return null;
    } finally {
      actionLock.current = false;
      if (alive.current) { setBusy(false); if (readAgain.current) { readAgain.current = false; void readState(); } }
    }
  };
  const executions = [...(state?.executions || [])].sort((a, b) => b.startedAt - a.startedAt);
  const selected = executions.find(item => item.id === dialog);
  const active = executions.find(item => item.id === state?.activeExecutionId);
  const taskEnded = ['cancelled', 'failed', 'succeeded'].includes(task.state);
  const sourceBytes = encoder.encode(source).byteLength;
  const inputIds = new Set(state?.inputs.map(item => item.versionId));
  const inputSelectionValid = selectedInputs.every(id => inputIds.has(id));
  const dependencyCount = state?.dependencies.length || 0;
  const closeDialog = () => { if (!actionLock.current) { setDialog(null); setError(null); } };
  const showRun = () => { setSelectedInputs((state?.inputs || []).slice(0, CODE_LIMITS.inputs).map(item => item.versionId)); setError(null); setDialog('run'); };
  const stop = (execution: CodeExecution) => void perform({ type: 'code.stop', taskId: task.id, executionId: execution.id });
  const errorView = error ? <div className="code-error" role="alert">{error}<button className="inline-link" disabled={busy} onClick={() => { setError(null); void readState(); }}>Refresh code status</button></div> : null;
  const outputList = (execution: CodeExecution) => <div className="code-output-list">{execution.outputVersionIds.map(id => {
    const version = snapshot.artifacts.find(item => item.id === id);
    return <button key={id} className="code-output" onClick={() => { setDialog(null); preview(id); }}><span>{version?.displayName || 'Output file'}<small>{version ? `${formatBytes(version.bytes)} · v${version.version} · Private` : 'Saved exact version'}</small></span><span>Preview ↗</span></button>;
  })}</div>;
  const dependencyCard = (item: CodeDependency) => <section className="code-dependency" key={item.requestId}><h3>{item.packageName}{item.version ? ` · ${item.version}` : ''}</h3><p>{languageLabels[item.runtime]} dependency · {item.state === 'fulfilled' ? 'Verified in runtime' : item.state === 'cancelled' ? 'Request closed' : 'Waiting for a trusted image build'}</p><p>{item.reason}</p>{item.state === 'open' && <><p>Build an owner-reviewed package recipe through the project’s code runtime setup workflow, then check the installed image here. Code jobs keep networking disabled.</p><button className="button small" disabled={busy} onClick={() => void perform({ type: 'code.resolveDependency', taskId: task.id, requestId: item.requestId, revision: item.revision })}>Check installed dependency</button></>}</section>;

  return <section className="code-panel" aria-label="Real code executions">
    <div className="code-heading"><div><h2>Code execution</h2><p>Run a script for this task. Files and logs are real.</p></div><span className="code-live">Container</span></div>
    {!dialog && errorView}
    {!state ? <div className="code-empty" role="status">Reading the local code runtime…</div> : <>
      {!state.runtime.ready && <div className="code-runtime-note"><strong>Code runtime needs setup</strong><p>{state.runtime.message || 'Start Docker Desktop and prepare the code runtime.'}</p><code>npm run code:setup</code><p>Run this setup command from the project folder in your terminal. Images are prepared only through that deliberate setup step.</p><button className="inline-link" disabled={busy} onClick={() => void readState()}>Check again</button></div>}
      <div className="code-actions"><button className="button primary small" disabled={busy || !state.runtime.ready || !!state.activeExecutionId || taskEnded} onClick={showRun}>Run code</button><button className="button small" disabled={busy || taskEnded || dependencyCount >= CODE_LIMITS.dependencies} onClick={() => { setError(null); setDialog('dependency'); }}>Request dependency</button></div>
      {taskEnded && <p className="code-note">This task has finished. Create another task to run more code.</p>}
      {dependencyCount >= CODE_LIMITS.dependencies && <p className="code-note">This task has reached its limit of {CODE_LIMITS.dependencies} saved dependency requests. Existing requests remain available below.</p>}
      {active && <p className="code-note" role="status">{stateLabels[active.lifecycle]}. You can leave this view while execution continues.</p>}
      {executions.length ? executions.map(execution => <article className="code-execution" key={execution.id}>
        <div className="code-execution-top"><div><button className="code-execution-title" onClick={() => { setDialog(execution.id); setError(null); }}>{languageLabels[execution.runtime]} execution</button><time className="code-execution-time">{new Date(execution.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div><StateBadge execution={execution} /></div>
        <p className="code-execution-summary">{elapsed(execution)}{execution.exitCode !== null ? <> · Exit <strong>{execution.exitCode}</strong></> : null} · {execution.origin === 'owner' ? 'Started by you' : 'Started by agent'}</p>
        <p className={'code-workspace-note' + (execution.workspaceCommitted ? ' saved' : !activeStates.has(execution.lifecycle) ? ' incomplete' : '')}>{commitMessage(execution)}</p>
        {execution.error && <p className="code-execution-summary">{execution.error}</p>}
        {outputList(execution)}
        <div className="code-actions"><button className="button small" onClick={() => { setDialog(execution.id); setError(null); }}>Details & logs</button>{activeStates.has(execution.lifecycle) && <button className="button small danger-outline" disabled={busy || execution.lifecycle === 'stopping'} onClick={() => stop(execution)}>{execution.lifecycle === 'stopping' ? 'Stopping…' : 'Stop execution'}</button>}</div>
      </article>) : <div className="code-empty"><strong>A private place to process files</strong><p>Choose Python, Node.js, or shell and run a script inside an isolated container. Deliverables stay private until you publish them.</p></div>}
      {state.dependencies.map(dependencyCard)}
      <p className="code-note">Saved workspace revision {state.workspaceRevision}. {task.executionMode === 'live' ? 'Live agent code and manually started scripts share this task’s isolated workspace.' : 'This task uses the simulation; manual code execution makes no model calls.'}</p>
    </>}
    {dialog && <CodeDialog title={dialog === 'run' ? 'Run code for this task' : dialog === 'dependency' ? 'Request a runtime dependency' : selected ? `${languageLabels[selected.runtime]} execution` : 'Execution details'} close={closeDialog}>
      {errorView}
      {dialog === 'run' && state ? <form onSubmit={async event => { event.preventDefault(); if (!source.trim() || sourceBytes > CODE_LIMITS.sourceBytes || !inputSelectionValid) return; const result = await perform({ type: 'code.execute', taskId: task.id, runtime, source, timeoutSeconds, inputVersionIds: selectedInputs }); if (result && alive.current) setDialog(result.activeExecutionId || [...result.executions].sort((a,b) => b.startedAt-a.startedAt)[0]?.id || null); }}>
        <p className="code-note"><strong>{snapshot.agents.find(item => item.id === task.agentId)?.name}</strong> · {task.objective}</p>
        <div className="code-form-row"><label>Runtime<select autoFocus value={runtime} disabled={busy} onChange={event => setRuntime(event.target.value as CodeLanguage)}><option value="python">Python</option><option value="node">Node.js</option><option value="shell">Shell in container</option></select></label><label>Timeout (seconds)<input type="number" required min={1} max={CODE_LIMITS.timeoutSeconds} value={timeoutSeconds} disabled={busy} onChange={event => setTimeoutSeconds(Number(event.target.value))} /></label></div>
        <label>Script<textarea className="code-source" rows={10} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={sourcePlaceholder[runtime]} value={source} maxLength={CODE_LIMITS.sourceBytes} disabled={busy} required onChange={event => setSource(event.target.value)} /></label>
        <div className="code-source-count"><span>Saved with execution history. Do not include credentials.</span><span>{formatBytes(sourceBytes)} / {formatBytes(CODE_LIMITS.sourceBytes)}</span></div>
        {sourceBytes > CODE_LIMITS.sourceBytes && <p className="code-error" role="alert">This script exceeds the UTF-8 byte limit. Shorten it before running.</p>}
        <fieldset className="code-inputs" disabled={busy}><legend>Exact task inputs · {selectedInputs.length} selected</legend><p>Select files to materialize for this run. Shared inputs are read-only. These paths are inside the container.</p>{state.inputs.length ? state.inputs.map(input => {
          const version = snapshot.artifacts.find(item => item.id === input.versionId);
          return <label className="code-input-choice" key={input.versionId}><input type="checkbox" checked={selectedInputs.includes(input.versionId)} disabled={!selectedInputs.includes(input.versionId) && selectedInputs.length >= CODE_LIMITS.inputs} onChange={event => setSelectedInputs(previous => event.target.checked ? [...previous, input.versionId] : previous.filter(id => id !== input.versionId))} /><span><strong>{input.displayName}{version ? ` · v${version.version}` : ''}</strong><small>{formatBytes(input.bytes)} · {input.visibility === 'shared' ? 'Shared · read-only' : 'Private'} · {input.versionId}</small><code>{input.containerPath}</code></span></label>;
        }) : <p>No task files are attached. You can still run code without inputs.</p>}</fieldset>
        {!inputSelectionValid && <p className="code-error" role="alert">A selected input is no longer available. Close and reopen this form to choose current exact versions.</p>}
        <p className="code-note">Working directory: <code>/workspace</code>. Write deliverables to <code>outputs/</code>. Verified workspace files are saved after execution. The container has no network access.</p>
        <details className="code-script-details"><summary>Runtime image and installed packages</summary><p className="code-note"><code>{state.runtime.imageDigest || 'No image selected'}</code></p><p className="code-note">{state.runtime.packages.length ? state.runtime.packages.map(item => `${languageLabels[item.runtime]}: ${item.name} ${item.version}`).join(' · ') : 'Only the runtime’s documented base package set is available. Request a dependency if a module is missing.'}</p></details>
        <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={closeDialog}>Cancel</button><button className="button primary" type="submit" disabled={busy || !source.trim() || sourceBytes > CODE_LIMITS.sourceBytes || !inputSelectionValid || !state.runtime.ready || !!state.activeExecutionId || taskEnded}>{busy ? 'Starting…' : 'Run in container'}</button></div>
      </form> : dialog === 'dependency' ? <form className="code-dependency-form" onSubmit={async event => { event.preventDefault(); const result = await perform({ type: 'code.requestDependency', taskId: task.id, runtime: dependencyRuntime, packageName: packageName.trim(), version: packageVersion.trim(), reason: reason.trim() }); if (result) { setDialog(null); setPackageName(''); setPackageVersion(''); setReason(''); } }}>
        <p className="code-note">Request one exact registry package for this task. The request stays open until a trusted runtime image contains it. Submitting this form does not install packages or turn on networking for code jobs.</p>
        <div className="code-form-row"><label>Runtime<select autoFocus value={dependencyRuntime} disabled={busy} onChange={event => setDependencyRuntime(event.target.value as 'python' | 'node')}><option value="python">Python</option><option value="node">Node.js</option></select></label><label>Exact version<input required maxLength={64} value={packageVersion} placeholder="e.g. 1.2.3" disabled={busy} onChange={event => setPackageVersion(event.target.value)} /></label></div>
        <label>Registry package name<input required maxLength={128} value={packageName} placeholder={dependencyRuntime === 'python' ? 'e.g. pandas' : 'e.g. csv-parse'} disabled={busy} onChange={event => setPackageName(event.target.value)} /></label>
        <label>Why is it needed?<textarea required rows={3} maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
        <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={closeDialog}>Cancel</button><button type="submit" className="button primary" disabled={busy || !packageName.trim() || !packageVersion.trim() || !reason.trim() || taskEnded}>Create dependency request</button></div>
      </form> : selected ? <>
        <StateBadge execution={selected} /><p className={'code-workspace-note' + (selected.workspaceCommitted ? ' saved' : !activeStates.has(selected.lifecycle) ? ' incomplete' : '')}>{commitMessage(selected)}</p>
        {selected.error && <div className="code-error" role="alert">{selected.error}</div>}
        <dl className="code-detail-grid"><dt>Command</dt><dd><code>{selected.command}</code></dd><dt>Working directory</dt><dd><code>{selected.cwd}</code></dd><dt>Duration</dt><dd>{elapsed(selected)}</dd><dt>Timeout</dt><dd>{selected.timeoutSeconds} seconds</dd><dt>Exit code</dt><dd>{selected.exitCode === null ? 'Not available' : selected.exitCode}</dd><dt>Runtime outcome</dt><dd>{selected.reason?.replaceAll('_', ' ') || (selected.lifecycle === 'succeeded' ? 'Exited successfully' : activeStates.has(selected.lifecycle) ? 'Pending' : 'Unavailable')}</dd><dt>Runtime image</dt><dd><code>{selected.imageDigest || 'Not assigned yet'}</code></dd></dl>
        {activeStates.has(selected.lifecycle) && <div className="code-actions"><button className="button danger-outline" disabled={busy || selected.lifecycle === 'stopping'} onClick={() => stop(selected)}>{selected.lifecycle === 'stopping' ? 'Stopping…' : 'Stop execution'}</button></div>}
        <div className="code-log-heading"><h3>Standard output</h3><span>Untrusted process text{selected.logsTruncated ? ' · Truncated' : ''}</span></div><pre className="code-log" tabIndex={0} aria-label="Standard output">{selected.stdout || '(No standard output)'}</pre>
        <div className="code-log-heading"><h3>Standard error</h3><span>Untrusted process text{selected.logsTruncated ? ' · Truncated' : ''}</span></div><pre className="code-log stderr" tabIndex={0} aria-label="Standard error">{selected.stderr || '(No standard error)'}</pre>
        <div className="code-log-heading"><h3>Saved outputs</h3><button className="inline-link" onClick={() => { setDialog(null); onFiles(); }}>Open task files</button></div>{selected.outputVersionIds.length ? outputList(selected) : <p className="code-note">No output artifacts were committed for this execution.</p>}
        <details className="code-script-details"><summary>Executed script</summary><pre className="code-log" tabIndex={0}>{selected.source}</pre></details>
        <details className="code-script-details"><summary>Exact inputs supplied to this run · {selected.inputs.length}</summary>{selected.inputs.length ? selected.inputs.map(input => <div className="code-input-choice" key={input.versionId}><span><strong>{input.displayName}</strong><small>{input.versionId} · {formatBytes(input.bytes)} · {input.visibility === 'shared' ? 'Shared read-only' : 'Private'}</small><code>{input.containerPath}</code></span></div>) : <p className="code-note">This run received no selected input files.</p>}</details>
        <p className="code-note">Process text cannot change the authoritative status above or publish files. Outputs remain private until you explicitly publish them.</p>
      </> : <p className="code-note">This execution is no longer in the current activity list.</p>}
    </CodeDialog>}
  </section>;
}
