import type { ModelConnectionState } from '../../../packages/contracts/model-connection';
export class ModelConnectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
/** Owner-only credential entry. Key bytes never enter a task, event, log or database. */
export class ModelConnectionController {
  private busy = false;
  constructor(private store: { save(key: string): Promise<void>; remove(): Promise<void> }, private active: () => Promise<boolean>) {}
  async handle(raw: unknown): Promise<ModelConnectionState> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ModelConnectionError('invalid_command', 'Choose a supported connection action.');
    const input = raw as Record<string, unknown>;
    if (this.busy) throw new ModelConnectionError('busy', 'A connection update is already in progress.');
    if (input.type !== 'model.saveKey' && input.type !== 'model.removeKey') throw new ModelConnectionError('invalid_command', 'Choose a supported connection action.');
    if (Object.keys(input).some(key => !['type', ...(input.type === 'model.saveKey' ? ['key'] : [])].includes(key))) throw new ModelConnectionError('invalid_command', 'This connection action has unsupported fields.');
    if (input.type === 'model.saveKey' && (typeof input.key !== 'string' || !/^sk-[A-Za-z0-9_-]{16,512}$/.test(input.key))) throw new ModelConnectionError('invalid_key', 'Enter a valid OpenAI API key. It will be saved only in macOS Keychain.');
    this.busy = true;
    try {
      if (await this.active()) throw new ModelConnectionError('busy', 'Pause active tasks before changing the model key.');
      try {
        if (input.type === 'model.saveKey') await this.store.save(input.key as string);
        else await this.store.remove();
      } catch { throw new ModelConnectionError('keychain_unavailable', 'macOS Keychain could not save this change. Check Keychain access and try again.'); }
      return { configured: input.type === 'model.saveKey', tested: false };
    } finally { this.busy = false; }
  }
}
