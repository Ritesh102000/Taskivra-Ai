import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
export interface CredentialStatus { configured: boolean; message: string | null }
export interface CredentialProvider { status(): Promise<CredentialStatus>; read(): Promise<string> }
export class CredentialError extends Error {
  constructor(readonly code: string) { super(code === 'credential_missing' ? 'Save an OpenAI key in macOS Keychain before starting a model task.' : 'The native Keychain helper is unavailable or access was denied.'); this.name = 'CredentialError'; }
}
type PresenceEntry = { expiresAt: number; result?: CredentialStatus; pending?: Promise<CredentialStatus> };
const presence = new Map<string, PresenceEntry>();
export class MacKeychainCredentials implements CredentialProvider {
  constructor(private readonly options: { helperPath: string; account?: string }) {
    if (options.account !== undefined && !/^provider-[a-f0-9]{64}$/.test(options.account)) throw new CredentialError('credential_unavailable');
  }
  private presenceKey(): string { return this.options.helperPath + '\0' + (this.options.account || 'owner'); }
  private valid(key: string): boolean { return this.options.account ? /^[\x21-\x7e]{8,1024}$/.test(key) : /^sk-[A-Za-z0-9_-]{16,512}$/.test(key); }
  private async invoke(command: 'status' | 'read' | 'set-stdin' | 'delete', input?: Buffer): Promise<Buffer> {
    if (process.platform !== 'darwin') throw new CredentialError('credential_unavailable');
    try { const file = await lstat(this.options.helperPath); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error(); await access(this.options.helperPath, constants.X_OK); } catch { throw new CredentialError('credential_unavailable'); }
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.options.helperPath, [command, ...(this.options.account ? [this.options.account] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.end(input, () => input?.fill(0));
      const chunks: Buffer[] = []; let count = 0, errorBytes = 0, failed = false;
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, 15000);
      child.stdout.on('data', (bytes: Buffer) => { count += bytes.length; if (count > 2048) stop(); else chunks.push(bytes); });
      child.stderr.on('data', (bytes: Buffer) => { errorBytes += bytes.length; if (errorBytes > 2048) stop(); });
      child.once('error', () => { failed = true; });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0 || failed) { for (const chunk of chunks) chunk.fill(0); reject(new CredentialError('credential_unavailable')); }
        else { const output = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0); resolve(output); }
      });
    });
  }
  async save(key: string): Promise<void> {
    if (!this.valid(key)) throw new CredentialError('credential_missing');
    presence.delete(this.presenceKey());
    const bytes = Buffer.from(key);
    try { const result = await this.invoke('set-stdin', bytes); result.fill(0); } finally { bytes.fill(0); }
  }
  async remove(): Promise<void> { presence.delete(this.presenceKey()); const result = await this.invoke('delete'); result.fill(0); }
  async status(): Promise<CredentialStatus> {
    const key = this.presenceKey(), cached = presence.get(key);
    if (cached?.result && cached.expiresAt > Date.now()) return { ...cached.result };
    if (cached?.pending) return { ...await cached.pending };
    if (presence.size >= 1024) for (const [id, entry] of presence) if (!entry.pending && entry.expiresAt <= Date.now()) presence.delete(id);
    const entry: PresenceEntry = { expiresAt: 0 }; const pending = this.readPresence(); entry.pending = pending; presence.set(key, entry);
    try { const result = await pending; if (presence.get(key) === entry) { entry.result = result; entry.expiresAt = Date.now() + 2000; entry.pending = undefined; } return { ...result }; }
    finally { if (presence.get(key) === entry && entry.pending) presence.delete(key); }
  }
  private async readPresence(): Promise<CredentialStatus> {
    try { const bytes = await this.invoke('status'), value = bytes.toString().trim(); bytes.fill(0); if (!['configured', 'missing'].includes(value)) throw new CredentialError('credential_unavailable'); return { configured: value === 'configured', message: value === 'configured' ? null : 'Save an API key in macOS Keychain.' }; }
    catch { return { configured: false, message: 'Build the native Keychain helper and check macOS Keychain access.' }; }
  }
  async read(): Promise<string> {
    const bytes = await this.invoke('read');
    try { const key = bytes.toString(); if (!this.valid(key)) throw new CredentialError('credential_missing'); return key; }
    finally { bytes.fill(0); }
  }
}
