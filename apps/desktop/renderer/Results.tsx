import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppBridge, ArtifactPreview, Snapshot } from '../../../packages/contracts/index';
import type { ReportExportBridge, ReportExportFormat, ResultItem, ResultDetail, ResultsBridge, ResultsCommand, ResultsState } from '../../../packages/contracts/results';
import { compareResultText } from '../../../packages/results/preview';
import {useFilePreview} from './Files';
import { SafeResultPreview } from './SafeResultPreview';
import './results.css';

const label = { unreviewed: 'Needs your review', accepted: 'Accepted by you', changes_requested: 'Changes requested' };
const money = (value: number) => '$' + value.toLocaleString(undefined, { maximumFractionDigits: 4, minimumFractionDigits: 2 });
export function ResultsPanel({ bridge, snapshot, onSnapshot, onOpenTask, selectedTaskId }: {
  bridge: AppBridge & ResultsBridge & ReportExportBridge; snapshot: Snapshot; onSnapshot?: (snapshot: Snapshot) => void;
  onOpenTask?: (taskId: string) => void; selectedTaskId?: string;
}) {
  const previewSupporting=useFilePreview();
  const [state, setState] = useState<ResultsState | null>(null), [selected, setSelected] = useState(selectedTaskId || '');
  const [detail, setDetail] = useState<ResultDetail | null>(null), [comparison, setComparison] = useState<ArtifactPreview | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState(''), [revisionForm, setRevisionForm] = useState(false), [maxCost, setMaxCost] = useState(1);
  const [exactSelection,setExactSelection] = useState<ResultItem|null>(null);
  const [inspectionRevision, setInspectionRevision] = useState(0);
  const [exportMessage, setExportMessage] = useState('');
  const alive = useRef(true), lock = useRef(false), generation = useRef(0), readGeneration = useRef(0), exactGeneration = useRef(0);
  const refresh = useCallback(async () => {
    if (lock.current) return;
    const ticket = ++generation.current;
    try { const next = await bridge.results({ type: 'results.state' }); if (alive.current && ticket === generation.current) setState(next); }
    catch (cause) { if (alive.current && ticket === generation.current) setError(cause instanceof Error ? cause.message : 'Results could not be read.'); }
  }, [bridge]);
  useEffect(() => { alive.current = true; void refresh(); const off = bridge.onChanged(() => void refresh()); return () => { alive.current = false; generation.current++; readGeneration.current++; exactGeneration.current++; off(); }; }, [bridge, refresh]);
  useEffect(() => { if (selectedTaskId) setSelected(selectedTaskId); }, [selectedTaskId]);
  const item = selected ? state?.results.find(r => r.taskId === selected) || (exactSelection?.taskId === selected ? exactSelection : undefined) : state?.results[0];
  useEffect(() => { if (!selected || state?.results.some(r=>r.taskId===selected)) return; const ticket=++exactGeneration.current; void bridge.results({type:'results.inspect',taskId:selected}).then(next=>{if(alive.current&&ticket===exactGeneration.current)setExactSelection(next.detail?.result||null);},()=>{if(alive.current&&ticket===exactGeneration.current)setError('This exact result could not be read.');}); },[selected,state,snapshot,bridge]);
  async function older(){const cursor=state?.results.at(-1)?.taskId;if(!cursor||busy)return;setBusy(true);try{const next=await bridge.results({type:'results.state',beforeTaskId:cursor});setState(prev=>prev?{...next,results:[...prev.results,...next.results.filter(r=>!prev.results.some(p=>p.taskId===r.taskId))]}:next);}catch(e){setError(e instanceof Error?e.message:'Older results could not be read.');}finally{setBusy(false);}}
  useEffect(() => {
    const ticket = ++readGeneration.current; setDetail(null); setComparison(null); setFeedback(''); setRevisionForm(false); setExportMessage('');
    if (!item) { setLoading(false); return; }
    setLoading(true); setMaxCost(item.limits.maxCostUsd); setError(null);
    void bridge.results({ type: 'results.inspect', taskId: item.taskId, versionId: item.version.id }).then(next => {
      if (alive.current && readGeneration.current === ticket) setDetail(next.detail || null);
    }).catch(cause => { if (alive.current && readGeneration.current === ticket) setError(cause instanceof Error ? cause.message : 'The exact result could not be checked.'); })
      .finally(() => { if (alive.current && readGeneration.current === ticket) setLoading(false); });
  }, [bridge, item?.taskId, item?.version.id, item?.review.revision, inspectionRevision]);

  const perform = async (command: ResultsCommand) => {
    if (lock.current) return;
    lock.current = true; generation.current++; setBusy(true); setError(null);
    try {
      const next = await bridge.results(command);
      if (alive.current) { setState(next); setRevisionForm(false); }
      const nextSnapshot = await bridge.command({ type: 'snapshot' }); if (alive.current) onSnapshot?.(nextSnapshot);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The result action could not finish. Refresh before retrying.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const exportExact = async () => {
    if (!item || lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { const result = await bridge.files({ type: 'artifacts.export', versionId: item.version.id }); if (alive.current) onSnapshot?.(result.snapshot); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The file could not be exported.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const exportReport = async (format: ReportExportFormat) => {
    if (!item || lock.current) return;
    lock.current = true; setBusy(true); setError(null); setExportMessage('');
    try { const result = await bridge.reportExport({ type: 'results.exportReport', taskId: item.taskId, versionId: item.version.id, format }); if (alive.current) setExportMessage(result.message); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The formatted report could not be exported.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const comparePrevious = async () => {
    if (!item?.revisionOf || busy) return;
    const ticket = readGeneration.current; setError(null);
    try {
      const previous = await bridge.results({ type: 'results.inspect', taskId: item.revisionOf.taskId, versionId: item.revisionOf.versionId });
      if (alive.current && ticket === readGeneration.current) setComparison(previous.detail?.preview || null);
    } catch (cause) { if (alive.current && ticket === readGeneration.current) setError(cause instanceof Error ? cause.message : 'The earlier version could not be checked.'); }
  };
  const pending = state?.revisionJobs.filter(job => job.sourceTaskId === item?.taskId && job.sourceVersionId === item?.version.id) || [];
  const difference = comparison?.text !== null && comparison?.text !== undefined && detail?.preview.text !== null && detail?.preview.text !== undefined ? compareResultText(comparison.text, detail.preview.text) : null;
  return <div className="page-scroll results-page">
    <header className="results-page-heading"><div><span className="eyebrow">FINISHED WORK</span><h1>Review the result.</h1><p>Inspect the evidence, accept a version or ask for a precise change.</p></div><button className="button" disabled={busy || loading} onClick={() => { setInspectionRevision(value => value + 1); void refresh(); }}>Refresh</button></header>
    {error && <p role="alert" className="agent-run-error">{error}</p>}
    {!state ? <p role="status">Loading saved results…</p> : !state.results.length ? <section className="results-empty"><h2>Your first result will appear here.</h2><p>Complete a live task to review its output. Simulations and unfinished work are not presented as finished results.</p></section> : <div className="results-layout">
      <aside className="results-list" aria-label="Completed task results">{state.results.map(result => <button key={result.taskId} className={'result-list-item' + (result.taskId === item?.taskId ? ' selected' : '')} aria-pressed={result.taskId === item?.taskId} disabled={busy} onClick={() => setSelected(result.taskId)}>
        <span className={'result-review-status ' + result.review.state}>{label[result.review.state]}</span><strong>{result.version.displayName}</strong><span>{snapshot.agents.find(a => a.id === result.agentId)?.name || 'Agent'} · {new Date(result.version.createdAt).toLocaleDateString()}</span><small>{result.objective}</small>
      </button>)}<button className="button" disabled={busy || !state.results.length} onClick={()=>void older()}>Load older results</button></aside>
      <main className="result-detail" aria-label="Selected result">
        {item && <><header className="result-detail-heading"><div><span className={'result-review-status ' + item.review.state}>{label[item.review.state]}</span><h2>{item.version.displayName}</h2><p>Version {item.version.version} · {money(item.costUsd)} estimated model cost</p></div><div className="result-actions"><button className="button small" disabled={busy || !detail} onClick={() => void exportExact()}>Export exact file</button>{onOpenTask && <button className="button small" disabled={busy} onClick={() => onOpenTask(item.taskId)}>Open task</button>}</div></header>
          {loading && <p role="status">Checking the saved file and reading its bounded preview…</p>}
          {detail && <><div className="result-trust-strip"><span>File integrity checked</span><span>{item.review.state === 'accepted' ? 'Outcome accepted by you' : 'Outcome needs your judgment'}</span><span>{detail.totalEvidence} successful tool receipts</span></div>
            <p className="result-note">A readable file and successful tool calls do not prove that every fact or calculation is correct.</p>
            {detail.quality && <section className="result-criteria" aria-label="Automatic quality checks"><h3>{detail.quality.status === 'fail' ? 'Quality checks found required changes' : detail.quality.status === 'warn' ? 'Structure checked · review notes remain' : 'Structural checks passed'}</h3><ul>{detail.quality.checks.map(check => <li key={check.id}><strong>{check.status === 'fail' ? 'Fix' : check.status === 'warn' ? 'Review' : 'Checked'} · {check.label}</strong><p>{check.message}</p></li>)}</ul><p className="result-note">{detail.quality.limitation}</p></section>}
            {['markdown', 'md', 'text', 'txt', 'csv'].includes(item.version.format) && <section className="result-criteria" aria-label="Formatted exports"><h3>Ready to share</h3><p>Export the complete saved result with clean formatting and its source record. Existing files are protected; choose a new filename.</p><div className="result-actions">{item.version.format === 'csv' ? <button className="button small" disabled={busy} onClick={() => void exportReport('xlsx')}>Excel workbook</button> : <><button className="button small" disabled={busy} onClick={() => void exportReport('pdf')}>PDF report</button><button className="button small" disabled={busy} onClick={() => void exportReport('docx')}>Word document</button></>}</div>{item.version.format === 'csv' && <p className="result-note">Spreadsheet cells stay editable literal text, preserving identifiers and preventing formula execution.</p>}{exportMessage && <p className="result-note" role="status">{exportMessage}</p>}</section>}
            <section className="result-criteria"><h3>What this task promised</h3><p>{item.completionCriteria}</p><p className="result-note">{item.review.state === 'accepted' ? 'You accepted this exact version. This is an owner decision, not an independent factual certification.' : 'Compare these criteria with the output and sources before accepting.'}</p></section>
            {item.revisionOf && <button className="inline-link result-compare-button" disabled={busy} onClick={() => comparison ? setComparison(null) : void comparePrevious()}>{comparison ? 'Close comparison' : 'Compare with the earlier result'}</button>}
            {comparison ? <><p className="result-note">{difference?.identical ? 'The preview text is identical.' : difference?.firstDifferentLine ? `The preview first differs at line ${difference.firstDifferentLine}.` : 'Inspect both versions below.'} {(comparison.truncated || detail.preview.truncated || difference?.bounded) && 'This comparison covers previews only.'}</p><div className="result-comparison"><section><h3>Earlier result</h3><SafeResultPreview preview={comparison} /></section><section><h3>Current result</h3><SafeResultPreview preview={detail.preview} /></section></div></> : <SafeResultPreview preview={detail.preview} />}
            <section className="result-review-actions" aria-label="Owner result decision"><h3>Your decision</h3><p>Acceptance is saved for this exact output. {detail.canRequestChanges === false ? 'For another pass, start a new fleet with selected evidence.' : 'A revision creates a separate paused task with its own limits.'}</p><div className="result-actions"><button className="button primary" disabled={busy || item.review.state === 'accepted'} onClick={() => void perform({ type: 'results.accept', taskId: item.taskId, versionId: item.version.id, revision: item.review.revision, idempotencyKey: crypto.randomUUID() })}>{item.review.state === 'accepted' ? 'Accepted' : 'Accept this version'}</button>{detail.canRequestChanges !== false && <button className="button" disabled={busy} onClick={() => setRevisionForm(!revisionForm)}>Request changes</button>}</div>
              {item.review.feedback && <p className="result-owner-feedback"><strong>Your latest request</strong><br />{item.review.feedback}</p>}
              {revisionForm && detail.canRequestChanges !== false && <form className="result-revision-form" onSubmit={event => { event.preventDefault(); void perform({ type: 'results.requestChanges', taskId: item.taskId, versionId: item.version.id, revision: item.review.revision, feedback, limits: { ...item.limits, maxCostUsd: maxCost }, idempotencyKey: crypto.randomUUID() }); }}><label>What should change?<textarea value={feedback} maxLength={4000} rows={4} required disabled={busy} onChange={event => setFeedback(event.target.value)} placeholder="Name the missing detail, incorrect conclusion or change you need." /></label><label>Maximum spend for the new task (USD)<input type="number" required min={0.01} max={10} step={0.01} value={maxCost} disabled={busy} onChange={event => setMaxCost(Number(event.target.value))} /></label><p className="result-note">Model: {item.model}. Other limits: {item.limits.maxModelCalls} calls, {item.limits.maxToolSteps} steps, {item.limits.maxTokens.toLocaleString()} tokens, {item.limits.maxActiveSeconds} active seconds. The same agent and base website/account policy are retained. Exact original output and input versions are attached; prior capability grants are not copied. No model runs until you start the new task.</p><button className="button primary" disabled={busy || !feedback.trim()}>Prepare revision task</button></form>}
            </section>
            <details className="result-evidence"><summary>Sources and technical receipts</summary>{detail.provenance && <section aria-label="Exact result provenance"><h3>Exact provenance</h3><pre>{JSON.stringify(detail.provenance,null,2)}</pre><p className="result-note">Source roles, execution receipts, structural assessment and owner acceptance are separate records. A technical receipt is not a factual quality score.</p></section>}<h3>Selected input files</h3>{detail.inputs.length ? <ul>{detail.inputs.map(input => <li key={input.id}>{input.displayName} · version {input.version} · <code>{input.id}</code></li>)}</ul> : <p>No input files were attached. Sources may be browser or mail observations listed by the agent in the report.</p>}{!!detail.supportingOutputs?.length&&<section><h3>Same-task supporting outputs</h3><p>Derived outputs help inspect this task’s work. They are not independent source evidence.</p>{detail.supportingOutputs.map(v=><button className="button small" key={v.id} onClick={()=>previewSupporting(v.id)}>{v.displayName} · output:{v.id}</button>)}</section>}<h3>Successful tool calls</h3><p className="result-note">Receipts establish that calls completed. They do not independently validate the report’s conclusions.</p><ul>{detail.evidence.map(receipt => <li key={receipt.id}>{receipt.label} · {new Date(receipt.createdAt).toLocaleString()}<br /><code>{receipt.id}</code></li>)}</ul>{detail.evidenceTruncated && <p>Showing the latest {detail.evidence.length} of {detail.totalEvidence} receipts.</p>}<p>Output version: <code>{item.version.id}</code></p><p>SHA-256: <code>{item.version.sha256}</code></p></details>
          </>}
          {pending.length > 0 && <section className="result-revision-jobs"><h3>Revision tasks</h3>{pending.map(job => <div className="result-revision-job" key={job.id}><p><strong>{job.state === 'ready' ? 'Prepared · not started automatically' : job.state === 'preparing' ? 'Preparing exact inputs' : 'Input preparation needs attention'}</strong></p>{job.error && <p>{job.error}</p>}<div className="result-actions">{job.state !== 'ready' && <button className="button small" disabled={busy} onClick={() => void perform({ type: 'results.retryPreparation', revisionId: job.id })}>Retry preparation</button>}{onOpenTask && <button className="button small" disabled={busy} onClick={() => onOpenTask(job.taskId)}>Open revision task</button>}</div></div>)}</section>}
        </>}
      </main>
    </div>}
  </div>;
}
