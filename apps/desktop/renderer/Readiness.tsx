import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadinessAction, ReadinessState, ReadinessStatus } from '../../../packages/contracts/readiness';
import './readiness.css';

const labels: Record<ReadinessStatus, string> = { verified: 'Checked', configured: 'Configured · not tested live', not_tested: 'Not tested', needs_setup: 'Setup needed', needs_input: 'Input needed', checking: 'In progress', unavailable: 'Could not check' };

export interface ReadinessPanelProps {
  targetKey: string;
  check: () => Promise<ReadinessState>;
  onAction?: (action: ReadinessAction) => void;
  inputVersions?: { id: string; displayName: string }[];
  onAssign?: (slotKey: string, versionId: string) => Promise<void>;
}
/** All controls use typed owner APIs. Renderer never receives runtime commands or credential paths. */
export function ReadinessPanel({ targetKey, check, onAction, inputVersions = [], onAssign }: ReadinessPanelProps) {
  const [state, setState] = useState<ReadinessState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const currentCheck = useRef(check), ticket = useRef(0), mounted = useRef(true), locked = useRef(false);
  currentCheck.current = check;
  const refresh = useCallback(async () => {
    if (locked.current) return;
    locked.current = true; const revision = ++ticket.current;
    setBusy(true); setError(null);
    try { const next = await currentCheck.current(); if (mounted.current && revision === ticket.current) setState(next); }
    catch (failure) { if (mounted.current && revision === ticket.current) setError(failure instanceof Error ? failure.message : 'Setup could not be checked. Your draft is preserved.'); }
    finally { if (revision === ticket.current) { locked.current = false; if (mounted.current) setBusy(false); } }
  }, []);
  useEffect(() => {
    mounted.current = true; ticket.current++; locked.current = false; setState(null); void refresh();
    return () => { mounted.current = false; ticket.current++; locked.current = false; };
  }, [targetKey, refresh]);
  const assign = async (slotKey: string, versionId: string) => {
    if (!onAssign || !versionId || locked.current) return;
    locked.current = true; const revision = ++ticket.current; setBusy(true); setError(null);
    try {
      await onAssign(slotKey, versionId);
      const next = await currentCheck.current();
      if (mounted.current && revision === ticket.current) setState(next);
    } catch (failure) { if (mounted.current && revision === ticket.current) setError(failure instanceof Error ? failure.message : 'This file could not be assigned.'); }
    finally { if (revision === ticket.current) { locked.current = false; if (mounted.current) setBusy(false); } }
  };
  return <section className="readiness-panel" aria-label="Task readiness">
    <div className="readiness-heading"><div><h3>Ready for this job?</h3><p>{state?.status === 'needs_attention' ? 'Complete the items below before running.' : state ? 'Setup checked. Live access and the final result still need verification.' : 'Checking only what this job needs…'}</p></div><button type="button" className="button small" disabled={busy} onClick={() => void refresh()}>{busy ? 'Checking…' : 'Check again'}</button></div>
    {error && <p className="agent-run-error" role="alert">{error}</p>}
    {state && <><ul className="readiness-checks">{state.checks.map(item => <li key={item.id}><div><strong>{item.label}</strong><span className={'readiness-status' + (item.blocking ? ' needs-attention' : '')}>{labels[item.status]}</span></div><p>{item.detail}</p>{item.action && onAction && <button type="button" className="text-button" disabled={busy} onClick={() => onAction(item.action!)}>{item.actionLabel}</button>}</li>)}</ul>
    {state.inputSlots.length > 0 && <div className="readiness-slots"><h4>Assign the files for this run</h4>{state.inputSlots.map(slot => <div className="readiness-slot" key={slot.slotKey}><label>{slot.label}{onAssign && <select aria-label={slot.label} value={slot.versionId || ''} disabled={busy} onChange={event => void assign(slot.slotKey, event.target.value)}><option value="">Choose an imported task input…</option>{inputVersions.map(version => <option key={version.id} value={version.id}>{version.displayName} · {version.id.slice(0, 8)}</option>)}</select>}</label><p className={slot.status === 'accepted' ? 'readiness-slot-accepted' : ''}>{slot.status === 'accepted' ? 'Checked. ' : ''}{slot.detail}</p></div>)}{onAssign && !inputVersions.length && <p>Import files into this task’s Files view first. Files are not copied from another run.</p>}</div>}
    <div className="readiness-notes">{state.notes.map(note => <p key={note}>{note}</p>)}</div></>}
  </section>;
}
