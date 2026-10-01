export type BrowserBackend = 'desktop_chrome' | 'docker';
export type BrowserHealth = 'connected' | 'profile_closed' | 'extension_missing' | 'extension_disconnected' | 'setup_required' | 'profile_repair' | 'runtime_unavailable' | 'checking';
export interface BrowserSetupState {
  agentId: string; backend: BrowserBackend; ready: boolean; message: string | null;
  registered: boolean; extensionConnected: boolean; setupRequired: boolean;
  supportsTransfers: boolean; extensionPath?: string;
  health?: BrowserHealth; extensionInstalled?: boolean | null; profileRunning?: boolean | null;
}
export type BrowserSetupCommand =
 | {type:'browserSetup.state'|'browserSetup.prepare'|'browserSetup.openProfile';agentId:string}
 | {type:'browserSetup.selectBackend';agentId:string;backend:BrowserBackend};
export const BROWSER_SETUP_CHANNEL='agent-workspaces:browser-setup';
