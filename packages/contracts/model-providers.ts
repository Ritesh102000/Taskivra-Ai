/** A saved profile is an immutable model + endpoint + pricing revision. No secret leaves the main process. */
export const MODEL_PROVIDERS_CHANNEL = 'agent-workspaces:model-providers';
export type ModelProviderKind = 'openai' | 'anthropic' | 'ollama' | 'openai-compatible';
export interface ModelProviderInput {
  label: string; kind: ModelProviderKind; baseUrl: string; model: string;
  authentication: 'api-key' | 'none'; billing: 'metered' | 'local';
  inputUsdPerMillion: number; outputUsdPerMillion: number;
  maxInputTokens: number; maxOutputTokens: number;
  toolCalling: true;
}
export interface ModelProviderProfile extends ModelProviderInput {
  id: string; revision: number; selectionId: string; createdAt: number;
}
export interface ModelProviderView extends ModelProviderProfile {
  archived: boolean; configured: boolean; message: string | null; tested: false;
}
export interface ModelProviderState { profiles: ModelProviderView[]; history?: ModelProviderProfile[]; busy: boolean }
export interface ProviderModelOption {
  id: string; label: string; inputUsdPerMillion: number; outputUsdPerMillion: number;
  provider: string; local: boolean; maxInputTokens: number; maxOutputTokens: number;
  /** Configuration is checked asynchronously by status(); listing never contacts a provider. */
  profileRevision?: number;
}
export type ModelProviderCommand = { type: 'providers.state' }
 | { type: 'providers.save'; profile: ModelProviderInput; id?: string; expectedRevision?: number; key?: string }
 | { type: 'providers.archive'; id: string; expectedRevision: number }
 | { type: 'providers.removeKey'; selectionId: string }
 | { type: 'providers.saveKey'; selectionId: string; key: string };
export interface ModelProviderApi { command(command: ModelProviderCommand): Promise<ModelProviderState> }
