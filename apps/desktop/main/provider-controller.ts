import type { ModelProviderState } from '../../../packages/contracts/model-providers';
import { ProviderRegistry } from '../../../packages/model-adapters/registry';
import { isRecord, ProviderConfigurationError, validateProviderInput } from '../../../packages/model-adapters/profiles';
/** Invoke only from the owner main frame. Mutation callers must hold the coordinator maintenance gate. */
export class ProviderController {
  private busy = false;
  constructor(readonly registry: ProviderRegistry, private active: () => boolean | Promise<boolean>) {}
  async handle(raw: unknown): Promise<ModelProviderState> {
    const fail = (): never => { throw new ProviderConfigurationError('provider_command', 'Choose a supported model connection action.'); };
    if (!isRecord(raw) || typeof raw.type !== 'string') fail();
    const input = raw as Record<string, unknown>;
    const allowed = { 'providers.state': ['type'], 'providers.save': ['type', 'profile', 'id', 'expectedRevision', 'key'], 'providers.archive': ['type', 'id', 'expectedRevision'], 'providers.removeKey': ['type', 'selectionId'], 'providers.saveKey': ['type', 'selectionId', 'key'] };
    const keys = allowed[input.type as keyof typeof allowed]; if (!keys || Object.keys(input).some(k => !keys.includes(k))) fail();
    if (input.type === 'providers.state') return this.registry.state();
    if (this.busy) throw new ProviderConfigurationError('provider_busy', 'A model connection change is already in progress.'); this.busy = true;
    try {
      if (await this.active()) throw new ProviderConfigurationError('provider_busy', 'Pause active tasks before changing model connections.');
      if (input.type === 'providers.save') {
        const profile = validateProviderInput(input.profile);
        if (input.id !== undefined && typeof input.id !== 'string' || input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) || input.key !== undefined && typeof input.key !== 'string') fail();
        await this.registry.save(profile, { id: input.id as string | undefined, expectedRevision: input.expectedRevision as number | undefined, key: input.key as string | undefined });
      } else if (input.type === 'providers.archive') {
        if (typeof input.id !== 'string' || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) fail(); this.registry.archive(input.id as string, input.expectedRevision as number);
      } else if (input.type === 'providers.saveKey') { if (typeof input.selectionId !== 'string' || typeof input.key !== 'string') fail(); await this.registry.saveKey(input.selectionId as string, input.key as string); }
      else { if (typeof input.selectionId !== 'string') fail(); await this.registry.removeKey(input.selectionId as string); }
      return await this.registry.state();
    } finally { this.busy = false; }
  }
}
