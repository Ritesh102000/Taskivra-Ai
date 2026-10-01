export type Controller = 'agent' | 'human' | 'transitioning';
export interface RuntimeResponse { controller: Controller; generation: number; result: unknown }
export interface RequestOptions { actor: 'agent' | 'human' | 'owner' | 'broker'; generation: number }
export interface BrowserHandle {
  readonly info: { containerId: string; imageId: string; networkId: string; restored: boolean; sandbox: unknown };
  request(method: string, params: object, options: RequestOptions): Promise<RuntimeResponse>;
  close(options: { saveProfile: boolean }): Promise<{ saved: boolean; savedAt?: number }>;
  stop(): Promise<void>;
}
export interface LaunchOptions { sessionId: string; agentId: string; initialGeneration: number; onExit?: () => void }
export interface RuntimeFactory {
  status(): Promise<{ ready: boolean; message: string | null }>;
  launch(options: LaunchOptions): Promise<BrowserHandle>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}
export interface FactoryOptions {
  dataRoot: string;
  /** Loaded only for an actual browser launch, never for status or cleanup. */
  profileKey: Uint8Array | (() => Uint8Array);
  seccompPath: string;
  dockerPath?: string;
  browserImage?: string;
  egressImage?: string;
  reserveStorage?: (bytes: number) => Promise<() => Promise<void>>;
  /** Test-only fixture created by this runtime. Never accepted from renderer IPC. */
  testFixture?: boolean;
}
