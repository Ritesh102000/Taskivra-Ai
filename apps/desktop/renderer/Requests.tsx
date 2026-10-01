import { GmailConnection } from './Gmail';
import { useCallback, useEffect, useRef, useState } from 'react';
import { REQUEST_LIMITS, type Agent, type AppBridge, type RequestCommand, type RequestPick, type RequestSlot, type Snapshot, type Task, type UserRequest } from '../../../packages/contracts/index';
import { formatBytes, useFilePreview } from './Files';
import './agent-run.css';

export const requestIsPending = (state: string) => !['fulfilled', 'cancelled', 'superseded'].includes(state);
export function useRequests(bridge?: AppBridge) {
  const [requests, setRequests] = useState<UserRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), lock = useRef(false), reading = useRef(false), readAgain = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge || !alive.current) return;
    if (lock.current || reading.current) { readAgain.current = true; return; }
    const ticket = ++sequence.current; reading.current = true; readAgain.current = false;
    try { const next = await bridge.requests({ type: 'requests.list', taskId: null }); if (alive.current && ticket === sequence.current) setRequests(next); }
    catch (failure) { if (alive.current && ticket === sequence.current) setError(failure instanceof Error ? failure.message : 'Requests could not be loaded.'); }
    finally { reading.current = false; if (alive.current && readAgain.current && !lock.current) void refresh(); }
  }, [bridge]);
  useEffect(() => { alive.current = true; void refresh(); const off = bridge?.onRequestsChanged(() => void refresh()); const offWorkspace = bridge?.onChanged(() => void refresh()); return () => { alive.current = false; sequence.current++; off?.(); offWorkspace?.(); }; }, [bridge, refresh]);
  const operation = async (work: () => Promise<UserRequest[]>) => {
    if (lock.current) return false;
    lock.current = true; sequence.current++; setBusy(true); setError(null);
    try { const next = await work(); if (alive.current) setRequests(next); return true; }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'The request could not be updated. Refresh it before trying again.'); return false; }
    finally { lock.current = false; if (alive.current) { setBusy(false); void refresh(); } }
  };
  return { requests, error, busy, refresh, clearError: () => setError(null),
    perform: (command: RequestCommand) => bridge ? operation(() => bridge.requests(command)) : Promise.resolve(false),
    pick: (command: RequestPick) => bridge ? operation(async () => (await bridge.requestPick(command)).requests) : Promise.resolve(false),
  };
}
export type RequestController = ReturnType<typeof useRequests>;
const slotLabels: Record<RequestSlot['state'], string> = { missing: 'File needed', uploading: 'Importing', checking: 'Checking file', accepted: 'Accepted', needs_replacement: 'Replace file' };

export function StructuredRequestCard({ request, agent, task, snapshot, controller, onOpen, onOpenBrowser, onOpenCode }: {
  request: UserRequest; agent?: Agent; task?: Task; snapshot: Snapshot; controller: RequestController;
  onOpen?: () => void; onOpenBrowser?: () => void; onOpenCode?: () => void;
}) {
  const [reply, setReply] = useState('');
  const [chooseSlot, setChooseSlot] = useState<string | null>(null);
  const [versionId, setVersionId] = useState('');
  const preview = useFilePreview();
  const pending = requestIsPending(request.state) && task?.state !== 'cancelled';
  const canUse = snapshot.artifacts.filter(item => item.status === 'ready' && (item.visibility === 'shared' || item.ownerAgentId === request.agentId));
  const accepted = request.slots.filter(slot => slot.state === 'accepted' && slot.required).length, required = request.slots.filter(slot => slot.required).length;
  const busy = controller.busy;
  const replyBytes = new TextEncoder().encode(reply).length;
  const action = (decision: 'accept' | 'decline') => void controller.perform({ type: 'requests.decide', requestId: request.id, revision: request.revision, decision });
  const slotView = (slot: RequestSlot) => {
    const candidate = snapshot.artifacts.find(item => item.id === slot.candidateVersionId);
    const constraints = slot.constraints;
    const importing = slot.state === 'uploading';
    return <section className="request-slot" key={slot.id} aria-label={slot.label}>
      <div className="request-slot-top"><strong>{slot.label}{!slot.required ? ' · Optional' : ''}</strong><span className={'request-slot-state ' + (slot.state === 'accepted' ? 'accepted' : slot.state === 'needs_replacement' ? 'rejected' : '')}>{slotLabels[slot.state]}</span></div>
      <p>{constraints.formats.length ? constraints.formats.map(format => format.toUpperCase()).join(', ') : 'Supported file'}{constraints.maxBytes ? ` · Up to ${formatBytes(constraints.maxBytes)}` : ''}{constraints.minBytes ? ` · At least ${formatBytes(constraints.minBytes)}` : ''}</p>
      {constraints.csv?.requiredColumns.length ? <p>Required columns: {constraints.csv.requiredColumns.join(', ')}</p> : null}
      {constraints.json?.requiredKeys.length ? <p>Required fields: {constraints.json.requiredKeys.join(', ')}</p> : null}
      {slot.explanation && <p role={slot.state === 'needs_replacement' ? 'alert' : 'status'}>{slot.explanation}</p>}
      {candidate && <button className="inline-link" onClick={() => preview(candidate.id)}>{candidate.displayName} · v{candidate.version}</button>}
      {pending && <div className="request-slot-actions"><button className="button small" disabled={busy || importing} onClick={() => void controller.pick({ requestId: request.id, revision: request.revision, slotId: slot.id, slotRevision: slot.revision })}>{slot.candidateVersionId ? 'Replace from Mac' : 'Choose file from Mac'}</button><button className="button small" disabled={busy || importing} onClick={() => { setChooseSlot(slot.id); setVersionId(''); controller.clearError(); }}>Use saved version</button></div>}
      {pending && chooseSlot === slot.id && <form className="request-version-picker" onSubmit={async event => { event.preventDefault(); if (versionId && await controller.perform({ type: 'requests.assign', requestId: request.id, revision: request.revision, assignments: [{ slotId: slot.id, slotRevision: slot.revision, versionId }] })) { setChooseSlot(null); setVersionId(''); } }}>
        <label>Exact file version<select autoFocus required value={versionId} disabled={busy} onChange={event => setVersionId(event.target.value)}><option value="">Select a permitted version</option>{canUse.map(item => <option key={item.id} value={item.id}>{item.displayName} · v{item.version} · {item.visibility === 'shared' ? 'Shared' : 'Private'}</option>)}</select></label>
        <div className="request-slot-actions"><button type="button" className="button small" disabled={busy} onClick={() => setChooseSlot(null)}>Cancel</button><button type="submit" className="button primary small" disabled={busy || !versionId}>Check this version</button></div>
      </form>}
    </section>;
  };
  const heading = request.kind === 'gmail_connection' ? 'GMAIL CONNECTION NEEDED' : request.kind === 'files' ? 'FILES NEEDED' : request.kind === 'reduced_scope' ? 'REVISED OUTCOME PROPOSED' : request.kind === 'browser_handoff' ? 'BROWSER HANDOFF NEEDED' : request.kind === 'capability' ? 'YOUR APPROVAL NEEDED' : 'YOUR INPUT NEEDED';
  return <section className={'request-card' + (!pending ? ' request-resolved' : '')} aria-label={request.title}>
    <div className="request-card-top"><span className="request-symbol" aria-hidden="true">{pending ? '?' : '✓'}</span><div><span className="eyebrow">{pending ? heading : request.state === 'fulfilled' ? 'REQUEST FULFILLED' : request.state === 'superseded' ? 'REQUEST REVISED' : 'REQUEST CLOSED'}</span><h3>{request.title}</h3></div></div>
    <p className="request-context">{agent?.name || 'Agent'}{onOpen && task ? <> <span>·</span> <button className="inline-link" onClick={onOpen}>{task.objective}</button></> : null}</p><p className="request-reason">{request.reason}</p>
    {controller.error && pending && <div className="agent-run-error" role="alert">{controller.error}<button className="inline-link" disabled={busy} onClick={() => { controller.clearError(); void controller.refresh(); }}>Refresh requests</button></div>}
    {request.slots.length > 0 && <><p className="request-partial-note">{accepted} of {required} required files accepted. {pending ? 'Only accepted versions count; replacing one file preserves the other accepted files.' : ''}</p>{request.slots.map(slotView)}</>}
    {request.reducedScope && <div className="request-reduced-scope"><h4>Review the proposed outcome</h4><p>{request.reducedScope.description}</p><p><strong>Done means:</strong> {request.reducedScope.completionCriteria}</p>{request.reducedScope.waiveSlotKeys.length > 0 && <p>Proceed without: {request.reducedScope.waiveSlotKeys.join(', ')}. Missing files will not be marked accepted.</p>}{pending && <div className="request-slot-actions"><button className="button small" disabled={busy} onClick={() => action('decline')}>Keep original outcome</button><button className="button primary small" disabled={busy} onClick={() => action('accept')}>Accept revised outcome</button></div>}</div>}
    {request.capability && <div className="request-reduced-scope"><h4>{request.capability.name === 'browser_upload' ? 'Share selected files with this website' : 'Publish selected files for all agents'}</h4>{request.capability.origin && <p>Destination: <strong>{request.capability.origin}</strong></p>}<p>{request.capability.versionIds.map(id => { const version = snapshot.artifacts.find(item => item.id === id); return version ? `${version.displayName} · v${version.version}` : id; }).join('\n')}</p><p>{request.capability.name === 'browser_upload' ? 'The website will receive these exact file bytes. This approval applies only to the named destination and versions.' : 'Every agent will be able to discover and use these exact published versions.'}</p>{pending && <div className="request-slot-actions"><button className="button small" disabled={busy} onClick={() => action('decline')}>Decline</button><button className="button primary small" disabled={busy} onClick={() => action('accept')}>{request.capability.name === 'browser_upload' ? 'Approve file upload' : 'Approve publication'}</button></div>}</div>}
    {request.kind === 'gmail_connection' && <GmailConnection taskId={request.taskId} requireConnection={pending} />}
    {pending && request.kind === 'browser_handoff' && <div className="browser-request-action"><p className="subtle">Take control to finish sign-in, including any verification code. Return control when ready. Enter credentials only in the browser viewer.</p><div className="request-bottom"><span>Private browser input</span><button className="button primary small" disabled={busy || !onOpenBrowser} onClick={onOpenBrowser}>Open browser →</button></div></div>}
    {pending && request.kind === 'capability' && !request.capability && <div className="browser-request-action"><p className="subtle">Review this runtime dependency in Activity. A matching installed image is required before fulfillment.</p><button className="button primary small" disabled={busy || !onOpenCode} onClick={onOpenCode}>Open Activity →</button></div>}
    {request.response && <blockquote>{request.response}</blockquote>}
    {pending && ['files', 'clarification'].includes(request.kind) && <form className="request-owner-reply" onSubmit={async event => { event.preventDefault(); if (reply.trim() && replyBytes <= REQUEST_LIMITS.responseBytes && await controller.perform({ type: 'requests.reply', requestId: request.id, revision: request.revision, response: reply.trim() })) setReply(''); }}>
      <label htmlFor={'owner-reply-' + request.id}>{request.kind === 'files' ? 'Missing a file or need to explain?' : 'Your reply'}</label><textarea id={'owner-reply-' + request.id} rows={3} value={reply} maxLength={REQUEST_LIMITS.responseBytes} disabled={busy} onChange={event => setReply(event.target.value)} placeholder={request.kind === 'files' ? 'Explain what is available. The agent can propose a revised outcome.' : 'Add the detail the agent needs…'} required />
      {request.kind === 'files' && <p>A reply does not accept a missing file. The agent can replan; you must approve a materially reduced outcome.</p>}
      {replyBytes > REQUEST_LIMITS.responseBytes && <p className="agent-run-error" role="alert">Shorten this reply to fit the {formatBytes(REQUEST_LIMITS.responseBytes)} limit.</p>}
      <div className="request-bottom"><span>Saved with this request</span><button className="button primary small" disabled={busy || !reply.trim() || replyBytes > REQUEST_LIMITS.responseBytes}>Send reply →</button></div>
    </form>}
  </section>;
}
