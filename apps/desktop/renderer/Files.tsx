import { createContext, useContext, useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { AppBridge, ArtifactPreview, ArtifactVersion, FileActionResult, FileCommand, ImportTarget, Snapshot, Task } from '../../../packages/contracts/index';
import './files.css';

const GiB = 1024 ** 3;
export function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  const unit = bytes >= GiB ? GiB : bytes >= 1024 ** 2 ? 1024 ** 2 : 1024;
  return (bytes / unit).toLocaleString(undefined, { maximumFractionDigits: bytes >= GiB ? 2 : 1 }) + (unit === GiB ? ' GiB' : unit === 1024 ** 2 ? ' MiB' : ' KiB');
}
function FileGlyph({ type = 'file', size = 17 }: { type?: 'file' | 'plus' | 'arrow' | 'export' | 'shared' | 'shield' | 'close' | 'check'; size?: number }) {
  const paths = {
    file: <><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="m13 5 7 7-7 7M4 12h16" />,
    export: <><path d="M5 13v7h14v-7M12 15V3m-4 4 4-4 4 4" /></>,
    shared: <><circle cx="6" cy="12" r="3" /><circle cx="18" cy="5" r="3" /><circle cx="18" cy="19" r="3" /><path d="m9 10 6-4M9 14l6 4" /></>,
    shield: <><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type]}</svg>;
}
function VersionIcon({ version }: { version: ArtifactVersion }) {
  return <span className="file-icon">{version.format.length <= 5 ? version.format : <FileGlyph />}</span>;
}
function Scope({ version, snapshot }: { version: ArtifactVersion; snapshot: Snapshot }) {
  const owner = snapshot.agents.find(agent => agent.id === version.ownerAgentId);
  return <span className={'scope-label' + (version.visibility === 'shared' ? ' shared' : '')}><FileGlyph type={version.visibility === 'shared' ? 'shared' : 'shield'} size={11} />{version.visibility === 'shared' ? 'All agents' : 'Private · ' + (owner?.name || 'Owner')}</span>;
}
type FileContextValue = {
  snapshot: Snapshot; busy: boolean;
  notice: { kind: 'success' | 'error'; text: string } | null;
  dismissNotice: () => void;
  open: (id: string) => void;
  pick: (target: ImportTarget, artifactId?: string) => Promise<FileActionResult | null>;
  drop: (target: ImportTarget, files: File[]) => Promise<FileActionResult | null>;
  run: (command: FileCommand) => Promise<FileActionResult | null>;
  chooseShared: (taskId: string) => void;
};
const FileContext = createContext<FileContextValue | null>(null);
function useFiles() {
  const value = useContext(FileContext);
  if (!value) throw new Error('File tools need the desktop workspace.');
  return value;
}
/** Only opens the existing owner-only, bounded plain-text/metadata preview. */
export function useFilePreview() { return useFiles().open; }
function FileDialog({ title, children, close, busy }: { title: string; children: ReactNode; close: () => void; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => { const current = dialog.current; current?.showModal(); return () => current?.close(); }, []);
  useEffect(() => {
    const preferred = dialog.current?.querySelector<HTMLElement>('[data-file-initial-focus]');
    (preferred || heading.current)?.focus();
  }, [title]);
  return <dialog ref={dialog} className="modal file-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) close(); }} onClick={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div className="modal-header"><div><span className="eyebrow">MANAGED FILES</span><h2 ref={heading} tabIndex={-1} id={id}>{title}</h2></div><button className="icon-button" disabled={busy} onClick={close} aria-label="Close file details"><FileGlyph type="close" /></button></div>
    <div className="file-dialog-body">{children}</div>
  </dialog>;
}
function Notice({ modal = false }: { modal?: boolean }) {
  const { notice, dismissNotice, busy } = useFiles();
  if (busy && !notice) return <div className="file-operation-state" role="status">Working with your files…</div>;
  if (!notice) return null;
  return <div className={'file-operation-state ' + notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" aria-label={modal ? 'Dismiss file dialog message' : 'Dismiss file message'} onClick={dismissNotice}><FileGlyph type="close" size={13} /></button></div>;
}

export function FilesProvider({ bridge, snapshot, onSnapshot, children }: { bridge: AppBridge; snapshot: Snapshot; onSnapshot: (snapshot: Snapshot) => void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<FileContextValue['notice']>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [mode, setMode] = useState<'detail' | 'publish' | 'use' | 'choose'>('detail');
  const [useTaskId, setUseTaskId] = useState('');
  const [chooseTaskId, setChooseTaskId] = useState('');
  const previewGeneration = useRef(0);
  const operationLock = useRef(false);
  const version = snapshot.artifacts.find(item => item.id === selectedId) || (preview?.version.id === selectedId ? preview.version : null);
  useEffect(() => {
    const preventNavigation = (event: globalThis.DragEvent) => event.preventDefault();
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    return () => { window.removeEventListener('dragover', preventNavigation); window.removeEventListener('drop', preventNavigation); previewGeneration.current += 1; };
  }, []);

  const operation = async (work: () => Promise<FileActionResult>, success: (result: FileActionResult) => string) => {
    if (operationLock.current) return null;
    operationLock.current = true; setBusy(true); setNotice(null);
    try {
      const result = await work(); onSnapshot(result.snapshot);
      if (!result.cancelled) setNotice({ kind: 'success', text: result.warnings?.length ? success(result) + ' ' + result.warnings.join(' ') : success(result) });
      return result;
    } catch (failure) {
      setNotice({ kind: 'error', text: failure instanceof Error ? failure.message : 'The file operation failed. No successful import has been reported.' });
      return null;
    } finally { operationLock.current = false; setBusy(false); }
  };
  const run = (command: FileCommand) => operation(() => bridge.files(command), result => command.type === 'artifacts.publish' ? 'Published to the shared library. All agents can use this version.' : command.type === 'artifacts.use' ? 'The selected version is now pinned to the task.' : command.type === 'artifacts.export' ? result.exported ? 'File exported.' : 'Export finished.' : command.type === 'storage.updateBudget' ? 'Storage budget updated.' : ((result.versionIds?.length || 0) + ' file(s) imported.'));
  const pick = (target: ImportTarget, artifactId?: string) => operation(() => bridge.files({ type: 'files.pick', target, ...(artifactId ? { artifactId } : {}) }), result => (result.versionIds?.length || 0) + (artifactId ? ' new version imported.' : ' file(s) imported · ' + (target.scope === 'shared' ? 'Shared inside its project.' : 'Private to ' + (snapshot.agents.find(item => item.id === target.agentId)?.name || 'this agent') + '.')));
  const drop = (target: ImportTarget, files: File[]) => operation(() => bridge.importDroppedFiles(target, files), result => (result.versionIds?.length || 0) + ' file(s) imported · Private to ' + (snapshot.agents.find(item => item.id === target.agentId)?.name || 'this agent') + '.');
  const close = () => { if (operationLock.current) return; previewGeneration.current += 1; setSelectedId(null); setPreview(null); setPreviewLoading(false); setPreviewFailed(false); setChooseTaskId(''); setMode('detail'); };
  const open = (id: string) => {
    const generation = ++previewGeneration.current;
    setSelectedId(id); setPreview(null); setPreviewLoading(true); setPreviewFailed(false); setMode('detail'); setNotice(null);
    bridge.preview(id).then(result => { if (generation === previewGeneration.current) { setPreview(result); setPreviewLoading(false); } }, failure => { if (generation === previewGeneration.current) { setPreviewLoading(false); setPreviewFailed(true); setNotice({ kind: 'error', text: failure instanceof Error ? failure.message : 'This file could not be previewed.' }); } });
  };
  const chooseShared = (taskId: string) => { setChooseTaskId(taskId); setSelectedId(null); setMode('choose'); setNotice(null); };
  const context = { snapshot, busy, notice, dismissNotice: () => setNotice(null), open, pick, drop, run, chooseShared };
  const shared = snapshot.artifacts.filter(item => item.visibility === 'shared' && item.status === 'ready').sort((a, b) => b.createdAt - a.createdAt);
  const owner = snapshot.agents.find(item => item.id === version?.ownerAgentId);
  const task = snapshot.tasks.find(item => item.id === version?.producerTaskId);
  const latestVersion = version ? Math.max(...snapshot.artifacts.filter(item => item.artifactId === version.artifactId).map(item => item.version)) : 0;
  const versions = version ? snapshot.artifacts.filter(item => item.artifactId === version.artifactId).sort((a, b) => b.version - a.version) : [];
  const eligibleTasks = snapshot.tasks.filter(item => !version || version.visibility === 'shared' || item.agentId === version.ownerAgentId);
  const source = snapshot.artifacts.find(item => item.id === version?.sourceVersionId);
  const dialogOpen = selectedId !== null || mode === 'choose';

  return <FileContext.Provider value={context}>{children}
    {dialogOpen && <FileDialog title={mode === 'publish' ? 'Publish to the shared library' : mode === 'use' ? 'Use this version in a task' : mode === 'choose' ? 'Choose a shared version' : version?.displayName || 'File details'} close={close} busy={busy}>
      <Notice modal />
      {mode === 'choose' ? <>
        <p className="modal-description">Choose the exact version to add to <strong>{snapshot.tasks.find(item => item.id === chooseTaskId)?.objective || 'this task'}</strong>. New publications will not replace it.</p>
        {shared.length ? <div className="file-use-list">{shared.map(item => <button className="file-use-choice" key={item.id} disabled={busy} onClick={async () => { const result = await run({ type: 'artifacts.use', versionId: item.id, taskId: chooseTaskId }); if (result) close(); }}><VersionIcon version={item} /><div><strong>{item.displayName} <span className="version-label">v{item.version}</span></strong><span>{formatBytes(item.bytes)} · {snapshot.agents.find(agent => agent.id === item.ownerAgentId)?.name || 'Shared by you'}</span></div></button>)}</div> : <p className="file-panel-empty">There are no ready shared versions yet. Publish a file or add one to the shared library first.</p>}
      </> : version ? <>
        <div className="file-detail-heading"><VersionIcon version={version} /><div><strong>{version.displayName}</strong><p>{version.format.toUpperCase()} · {formatBytes(version.bytes)} · Version {version.version}</p><div className="file-detail-badges"><Scope version={version} snapshot={snapshot} />{version.status !== 'ready' && <span className="scope-label">{version.status === 'missing' ? 'File missing' : 'Integrity issue'}</span>}{version.version < latestVersion && <span className="scope-label">A newer version is available</span>}</div></div></div>
        {mode === 'publish' ? <form className="file-action-form" onSubmit={async event => { event.preventDefault(); const result = await run({ type: 'artifacts.publish', versionId: version.id }); if (result && !result.cancelled) { const published = result.versionIds?.[0]; if (published) open(published); else setMode('detail'); } }}>
          <div className="file-decision-box"><h3>Available to agents in this project</h3><p>Publish <strong>{version.displayName} · v{version.version}</strong>, currently private to <strong>{owner?.name || 'its owner'}</strong>, as an immutable shared version.</p></div><p className="modal-description">This is an explicit sharing action. Agents in this file’s project can discover and use the published version. Other projects stay separate.</p><div className="modal-actions"><button className="button" type="button" disabled={busy} onClick={() => setMode('detail')}>Back</button><button className="button primary" type="submit" disabled={busy || version.status !== 'ready'}><FileGlyph type="shared" size={15} />Publish within project</button></div>
        </form> : mode === 'use' ? <form className="file-action-form" onSubmit={async event => { event.preventDefault(); if (!useTaskId) return; const result = await run({ type: 'artifacts.use', versionId: version.id, taskId: useTaskId }); if (result) setMode('detail'); }}>
          <label>Destination task<select data-file-initial-focus autoFocus value={useTaskId} onChange={event => setUseTaskId(event.target.value)} required disabled={busy}><option value="" disabled>Select a task</option>{eligibleTasks.map(item => <option value={item.id} key={item.id}>{snapshot.agents.find(agent => agent.id === item.agentId)?.name} · {item.objective}</option>)}</select></label><p className="pinned-version-note">The task will use <strong>{version.displayName} · v{version.version}</strong>. It will keep this version if a newer one is published.</p>{!eligibleTasks.length && <p className="file-panel-empty">Create a task{version.visibility === 'private' ? ' for ' + (owner?.name || 'this agent') : ''} before using this file.</p>}<div className="modal-actions"><button className="button" type="button" disabled={busy} onClick={() => setMode('detail')}>Back</button><button className="button primary" type="submit" disabled={busy || !useTaskId}>Use version {version.version}<FileGlyph type="arrow" size={15} /></button></div>
        </form> : <>
          <div className="file-version-picker"><label htmlFor="file-version-select">View version</label><select id="file-version-select" value={version.id} disabled={busy} onChange={event => open(event.target.value)}>{versions.map(item => <option key={item.id} value={item.id}>v{item.version}{item.version === latestVersion ? ' · Latest' : ''} · {new Date(item.createdAt).toLocaleDateString()}{item.status !== 'ready' ? ' · ' + item.status : ''}</option>)}</select><p>Viewing another version leaves task inputs unchanged. Use “Use in task” to attach it.</p></div>
          <div className="file-detail-actions"><button className="button small" disabled={busy || version.status !== 'ready'} onClick={() => void run({ type: 'artifacts.export', versionId: version.id })}><FileGlyph type="export" size={14} />Export</button><button className="button small" disabled={busy || version.status !== 'ready'} onClick={() => { setUseTaskId(''); setMode('use'); setNotice(null); }}>Use in task</button>{version.visibility === 'private' && <button className="button small" disabled={busy || version.status !== 'ready'} onClick={() => { setMode('publish'); setNotice(null); }}><FileGlyph type="shared" size={13} />Publish</button>}<button className="button small" disabled={busy} onClick={async () => { const result = await pick({ scope: version.visibility, agentId: version.visibility === 'private' ? version.ownerAgentId : null, taskId: null }, version.artifactId); if (result?.versionIds?.[0]) open(result.versionIds[0]); }}><FileGlyph type="plus" size={14} />Add version</button></div>
          <div className="file-preview-heading"><h3>Preview</h3><span>{previewLoading ? 'Reading safely…' : previewFailed ? 'Could not load' : preview?.truncated ? 'Excerpt · truncated' : preview?.text !== null && preview ? 'Plain text' : 'Metadata only'}</span></div>
          {previewLoading ? <div className="file-metadata-only" role="status">Loading a bounded preview…</div> : previewFailed ? <div className="file-metadata-only"><strong>Preview could not be loaded</strong><p>Check the error above before trying again.</p><button className="button small" disabled={busy} onClick={() => open(version.id)}>Retry preview</button></div> : preview?.text !== null && preview ? <pre className="file-preview">{preview.text.length ? preview.text : '(Empty file)'}</pre> : <div className="file-metadata-only"><strong>{version.status === 'ready' ? 'Content preview is not available for this format' : 'This version is not ready to use'}</strong>{preview?.note || (version.status === 'ready' ? 'Complex documents and images show metadata here. Content processing is deferred to the isolated execution service.' : 'Check the file status before exporting or using this version.')}</div>}
          {preview?.text !== null && preview?.note && <p className="phase-note" style={{ marginTop: 9 }}>{preview.note}</p>}
          <dl className="file-details-grid"><dt>File type</dt><dd>{version.mime}</dd><dt>Visibility</dt><dd>{version.visibility === 'shared' ? 'All agents' : 'Private to ' + (owner?.name || 'its owner')}</dd><dt>Owner</dt><dd>{owner?.name || 'You'}</dd><dt>Source task</dt><dd>{task?.objective || 'Owner import'}</dd><dt>Created</dt><dd>{new Date(version.createdAt).toLocaleString()}</dd><dt>Integrity</dt><dd>{version.status === 'ready' ? 'Ready · checksum recorded' : version.status}</dd><dt>SHA-256</dt><dd><code>{version.sha256}</code></dd><dt>Version ID</dt><dd><code>{version.id}</code></dd></dl>
          <section className="file-provenance"><h3>Provenance</h3><p>{version.codeSource ? `Created by code execution ${version.codeSource.executionId}. The following exact inputs were supplied to that run.` : version.browserSource ? `Downloaded from ${version.browserSource.origin} and saved privately for this task.` : version.sourceVersionId ? 'Derived from the following exact version:' : 'Imported as an immutable original. No earlier source version is recorded.'}</p>{version.codeSource && <ul>{version.codeSource.inputVersionIds.map(id => { const input = snapshot.artifacts.find(item => item.id === id); return <li key={id}>{input ? `${input.displayName} · v${input.version}` : 'Input version'}<br /><code>{id}</code></li>; })}</ul>}{version.sourceVersionId && <ul><li>{source ? source.displayName + ' · v' + source.version : 'Source version'}<br /><code>{version.sourceVersionId}</code></li></ul>}</section>
        </>}
      </> : <div className="file-metadata-only">This version is no longer available in the current workspace.</div>}
    </FileDialog>}
  </FileContext.Provider>;
}

function FileRow({ version }: { version: ArtifactVersion }) {
  const { open, snapshot } = useFiles();
  const latest = Math.max(...snapshot.artifacts.filter(item => item.artifactId === version.artifactId).map(item => item.version));
  return <button className="file-card" onClick={() => open(version.id)} title={version.displayName}><VersionIcon version={version} /><span className="file-card-copy"><strong>{version.displayName}</strong><span className="file-card-meta"><span>{formatBytes(version.bytes)}</span><span>·</span><span>v{version.version}</span>{version.status !== 'ready' && <span>· {version.status}</span>}</span><span className="file-card-scope"><FileGlyph type={version.visibility === 'shared' ? 'shared' : 'shield'} size={10} />{version.visibility === 'shared' ? 'Shared version · pinned' : 'Private'}{version.version < latest ? ' · Newer version available' : ''}</span></span><span className="file-card-arrow"><FileGlyph type="arrow" size={13} /></span></button>;
}

export function TaskFiles({ task }: { task: Task }) {
  const { snapshot, busy, pick, drop, chooseShared } = useFiles();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const owner = snapshot.agents.find(item => item.id === task.agentId);
  const target: ImportTarget = { scope: 'private', agentId: task.agentId, taskId: task.id };
  const links = snapshot.taskArtifacts.filter(item => item.taskId === task.id);
  const inputs = links.filter(item => item.role === 'input').map(link => snapshot.artifacts.find(item => item.id === link.versionId)).filter((item): item is ArtifactVersion => Boolean(item));
  const outputs = links.filter(item => item.role === 'output').map(link => snapshot.artifacts.find(item => item.id === link.versionId)).filter((item): item is ArtifactVersion => Boolean(item));
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const handleDrop = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragging(false); const files = Array.from(event.dataTransfer.files); if (files.length && !busy) void drop(target, files); };
  return <div className="task-files-panel">
    <div className="file-panel-heading"><div><h2>Task files</h2><p>{owner?.name} · Imports are private</p></div><span className="scope-label"><FileGlyph type="shield" size={11} />Real files</span></div>
    <div className="file-toolbar"><button className="button primary small" disabled={busy} onClick={() => void pick(target)}><FileGlyph type="plus" size={14} />Import files</button><button className="button small" disabled={busy} onClick={() => chooseShared(task.id)}>From shared library</button></div>
    <Notice />
    <div className={'file-dropzone' + (dragging ? ' dragging' : '')} onDragEnter={event => { if (hasFiles(event)) { event.preventDefault(); depth.current += 1; setDragging(true); } }} onDragLeave={event => { if (hasFiles(event)) { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); } }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }} onDrop={handleDrop}><span className="file-icon"><FileGlyph type="file" size={20} /></span><strong>{dragging ? 'Drop to import privately' : 'Drop files here'}</strong><span>Copies go to {owner?.name || 'this agent'} for this task.<br />100 MiB per file · 250 MiB per import</span></div>
    <div className="file-group"><div className="file-group-header"><h3>Inputs</h3><span>{inputs.length}</span></div>{inputs.length ? inputs.map(version => <FileRow key={version.id} version={version} />) : <p className="file-empty-group">No inputs yet. Import a file or select an exact shared version.</p>}</div>
    <div className="file-group"><div className="file-group-header"><h3>Outputs</h3><span>{outputs.length}</span></div>{outputs.length ? outputs.map(version => <FileRow key={version.id} version={version} />) : <p className="file-empty-group">No output files have been saved. Run code from Activity or save a browser download.</p>}</div>
    <p className="phase-note">Imports, shared versions, browser downloads, and code outputs are real files. {task.executionMode === 'live' ? 'The live agent receives only permitted exact input versions.' : 'Run code explicitly in Activity; this task’s progress uses a simulation.'}</p>
  </div>;
}

export function SharedLibrary() {
  const { snapshot, busy, pick, open } = useFiles();
  const [query, setQuery] = useState('');
  const shared = snapshot.artifacts.filter(item => item.visibility === 'shared');
  const shown = shared.filter(item => item.displayName.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.createdAt - a.createdAt || b.version - a.version);
  return <div className="page-scroll"><section className="page-heading"><div><span className="eyebrow">PUBLISHED WORK, READY TO REUSE</span><h1>Shared library</h1><p>Owner view of published files across projects. Agents see only their own project’s files; tasks pin exact versions.</p></div><button className="button primary" disabled={busy} onClick={() => void pick({ scope: 'shared', agentId: null, taskId: null })}><FileGlyph type="plus" size={16} />Add shared files</button></section><Notice />
    <div className="file-library-tools"><span>{shared.length} published {shared.length === 1 ? 'version' : 'versions'} · Scoped by project</span><label className="file-library-search"><input aria-label="Search shared files" placeholder="Find a shared file…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    {shown.length ? <div className="library-version-list"><div className="library-version-labels"><span>FILE</span><span>VERSION</span><span>PRODUCER</span><span>CREATED</span></div>{shown.map(version => {
      const latest = Math.max(...shared.filter(item => item.artifactId === version.artifactId).map(item => item.version));
      return <button className="library-version-row" key={version.id} onClick={() => open(version.id)} title={version.displayName}><span className="library-version-name"><VersionIcon version={version} /><span><strong>{version.displayName}</strong><small>{formatBytes(version.bytes)} · {version.format.toUpperCase()}{version.status !== 'ready' ? ' · ' + version.status : ''}</small></span></span><span><span className="version-label">v{version.version}</span>{latest === version.version && <span className="latest-label">Latest version</span>}</span><span className="library-version-producer">{snapshot.agents.find(item => item.id === version.ownerAgentId)?.name || 'Shared by you'}</span><span className="library-version-date">{new Date(version.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}<FileGlyph type="arrow" size={13} /></span></button>;
    })}</div> : <div className="quiet-empty"><div className="empty-state"><span className="empty-icon"><FileGlyph type="shared" size={28} /></span><h3>{query ? 'No shared files match' : 'A shared home for finished work'}</h3><p>{query ? 'Try another filename.' : 'Add a file to the Personal workspace, or publish a private file within its project from its details. Every version is preserved.'}</p>{query && <button className="button" onClick={() => setQuery('')}>Clear search</button>}</div></div>}
  </div>;
}

export function StorageUsage() {
  const { snapshot, busy, run } = useFiles();
  const budget = snapshot.storage.budgetBytes;
  const [value, setValue] = useState(String(budget / GiB));
  useEffect(() => setValue(String(budget / GiB)), [budget]);
  const proposed = Number(value);
  const valid = Number.isFinite(proposed) && proposed >= .25 && proposed <= 20;
  return <>
    <div className="storage-usage"><div className="storage-usage-top"><strong>{formatBytes(snapshot.storage.usedBytes)} used</strong><span>of {formatBytes(budget)}</span></div><div className="storage-meter" role="meter" aria-label="Application storage used" aria-valuenow={snapshot.storage.usedBytes} aria-valuemin={0} aria-valuemax={budget}><span style={{ width: Math.min(100, (snapshot.storage.usedBytes / Math.max(1, budget)) * 100) + '%' }} /></div><p>Application bytes are counted against this budget. The initial 2 GiB budget is an implementation default.</p></div>
    <form className="setting-row storage-budget-form" onSubmit={event => { event.preventDefault(); if (valid) void run({ type: 'storage.updateBudget', budgetBytes: Math.round(proposed * GiB) }); }}><div><strong>Storage budget</strong><p>Choose 0.25–20 GiB. Files must fit within the budget.</p></div><div className="storage-budget-controls"><label className="sr-only" htmlFor="storage-budget">Storage budget in GiB</label><input id="storage-budget" type="number" min=".25" max="20" step=".25" value={value} onChange={event => setValue(event.target.value)} disabled={busy} /><span>GiB</span><button className="button small" disabled={busy || !valid || Math.round(proposed * GiB) === budget} type="submit">Save</button></div></form><div className="storage-notice"><Notice /></div>
  </>;
}
