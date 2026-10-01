import { useState } from 'react';
import type { AppBridge } from '../../../packages/contracts';

export function KeySettings({ bridge, configured, active, onChanged }: { bridge: AppBridge; configured: boolean; active: boolean; onChanged(): void }) {
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function update(remove = false) {
    const value = key.trim(); setKey(''); setBusy(true); setMessage('');
    try {
      await bridge.modelConnection(remove ? { type: 'model.removeKey' } : { type: 'model.saveKey', key: value });
      setMessage(remove ? 'Saved key removed.' : 'Key saved in macOS Keychain. No paid connection test was made.'); onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The key could not be saved.'); }
    finally { setBusy(false); }
  }
  return <section className="settings-section"><h2>Connect OpenAI</h2><p>Add or replace your API key. It is cleared from this form after submission and stored in macOS Keychain. Task content is sent to OpenAI when a live task runs.</p>
    <form className="modal-form" onSubmit={event => { event.preventDefault(); void update(); }}>
      <label>API key<input type="password" autoComplete="off" spellCheck={false} value={key} maxLength={515} disabled={busy || active} onChange={event => setKey(event.target.value)} placeholder="Paste your API key" /></label>
      <div><button className="button primary" disabled={busy || active || !key.trim()}>Save key</button> {configured && <button className="button" type="button" disabled={busy || active} onClick={() => void update(true)}>Remove saved key</button>}</div>
      {active && <p>Pause active tasks before changing this connection.</p>}{message && <p role="status">{message}</p>}
    </form></section>;
}
