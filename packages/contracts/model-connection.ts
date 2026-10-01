export const MODEL_CONNECTION_CHANNEL = 'agent-workspaces:model-connection';
export type ModelConnectionCommand = { type: 'model.saveKey'; key: string } | { type: 'model.removeKey' };
export interface ModelConnectionState { configured: boolean; tested: false }
