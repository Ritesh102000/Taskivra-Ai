export type BrowserLifecycle = 'idle' | 'starting' | 'ready' | 'closing' | 'disconnected' | 'error';
export type BrowserController = 'none' | 'agent' | 'human' | 'transitioning';
export interface BrowserTab { id: string; title: string; url: string; revision: number }
export interface BrowserFrame { dataUrl: string; width: number; height: number; revision: number; tabId: string; generation: number }
export interface BrowserTarget { ref: string; kind: string; label: string }
export interface BrowserDownload { id: string; name: string; bytes: number; state: 'pending' | 'ready' | 'saving' | 'saved' | 'failed'; versionId?: string }
export interface BrowserState {
  agentId: string; sessionId: string; taskId: string | null;
  lifecycle: BrowserLifecycle; controller: BrowserController;
  generation: number; revision: number; activeTabId: string | null;
  tabs: BrowserTab[]; frame: BrowserFrame | null; targets: BrowserTarget[];
  downloads: BrowserDownload[]; error: string | null; requestId: string | null;
  profile: { mode: 'remember'; saved: boolean; savedAt: number | null };
  runtime: { ready: boolean; message: string | null; backend?: 'desktop_chrome'|'docker'|'local_lab'; setupRequired?: boolean; extensionConnected?: boolean; supportsTransfers?: boolean };
}
type Bound = { agentId: string; sessionId: string; generation: number };
type Page = Bound & { tabId: string; revision: number };
export type BrowserCommand =
  | { type: 'browser.state'; agentId: string }
  | { type: 'browser.open'; agentId: string; taskId: string }
  | ({ type: 'browser.close' | 'browser.observe' | 'browser.takeControl' | 'browser.returnControl' } & Bound)
  | ({ type: 'browser.requestLogin'; taskId: string } & Bound)
  | ({ type: 'browser.newTab'; url: string } & Bound)
  | ({ type: 'browser.selectTab' | 'browser.closeTab'; tabId: string } & Bound)
  | ({ type: 'browser.navigate'; url: string } & Page)
  | ({ type: 'browser.pointer'; x: number; y: number } & Page)
  | ({ type: 'browser.key'; key: string } & Page)
  | ({ type: 'browser.text'; text: string } & Page)
  | ({ type: 'browser.scroll'; x: number; y: number } & Page)
  | ({ type: 'browser.upload'; versionId: string; ref: string; destinationOrigin: string } & Page)
  | ({ type: 'browser.saveDownload'; downloadId: string } & Bound);
export const BROWSER_CHANNEL = 'agent-workspaces:browser';
export const BROWSER_CHANGED_CHANNEL = 'agent-workspaces:browser-changed';
