import type {BrowserState} from '../contracts/browser';
export interface BrowserReply { controller: 'agent' | 'human' | 'transitioning'; generation: number; result: unknown }
export interface BrowserHandle {
  request(method: string, params: Record<string, unknown>, options: { actor: 'agent' | 'human' | 'owner'; generation: number }): Promise<BrowserReply>;
  close(options: { saveProfile: boolean }): Promise<{ saved: boolean; savedAt?: number; cleanupPending?:boolean }>;
  stop(): Promise<void>;
}
export interface BrowserRuntime {
  status(agentId?:string): Promise<BrowserState['runtime']>;
  launch(options: { sessionId: string; agentId: string; initialGeneration: number; onExit: () => void }): Promise<BrowserHandle>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}
export const unavailableRuntime: BrowserRuntime = {
  async status() { return { ready: false, message: 'The browser runtime is not connected. Open the desktop app after browser setup.' }; },
  async launch() { throw new Error('runtime_unavailable'); },
  async reconcile() {}, async close() {},
};
