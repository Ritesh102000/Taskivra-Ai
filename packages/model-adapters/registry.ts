import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelProviderInput, ModelProviderProfile, ModelProviderState, ProviderModelOption } from '../contracts/model-providers';
import { ConfiguredModelAdapter } from './configured';
import { isRecord, ProviderConfigurationError, providerSelectionId, validateProviderInput } from './profiles';
import { DEFAULT_MODEL, MODEL_CHOICES } from './pricing';
import type { CredentialProvider } from './credentials';
import type { ModelAdapter } from './types';
export interface ProviderCredentialStore extends CredentialProvider { save(key: string): Promise<void>; remove(): Promise<void> }
export interface SavedProviderRegistry { version: 1; profiles: ModelProviderProfile[]; heads: { id: string; revision: number; archived: boolean }[] }
export interface ProviderRegistryOptions { filePath: string; credentials(profile: ModelProviderProfile): ProviderCredentialStore; legacyAdapter: ModelAdapter; fetch?: typeof globalThis.fetch }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function error(code: string, message: string): never { throw new ProviderConfigurationError(code, message); }
function privateParent(path: string) {
  const parent = dirname(path); if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  let directory = parent;
  while (true) { const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) error('provider_storage', 'The connection folder must be a real private directory.'); const next = dirname(directory); if (next === directory) break; directory = next; }
  const info = lstatSync(parent); if (typeof process.getuid === 'function' && info.uid !== process.getuid()) error('provider_storage', 'The connection folder belongs to another user.');
}
export function validateProviderRegistry(raw: unknown): SavedProviderRegistry {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'heads,profiles,version' || raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > 500 || !Array.isArray(raw.heads) || raw.heads.length > 50) return error('provider_storage', 'Saved model connections are invalid. Restore a verified backup.');
  const ids = new Set<string>();
  for (const value of raw.profiles) {
    if (!isRecord(value)) error('provider_storage', 'Saved model connections are invalid.');
    const { id, revision, selectionId, createdAt, ...input } = value; const normalized = validateProviderInput(input);
    if (input.baseUrl !== normalized.baseUrl) error('provider_storage', 'Saved provider URLs must use their normalized form.');
    if (typeof id !== 'string' || !uuid.test(id) || !Number.isSafeInteger(revision) || (revision as number) < 1 || (revision as number) > 500 || selectionId !== providerSelectionId(id, revision as number) || ids.has(selectionId as string) || !Number.isSafeInteger(createdAt) || (createdAt as number) < 0) error('provider_storage', 'Saved model revisions are invalid.');
    ids.add(selectionId as string);
  }
  const heads = new Set<string>();
  for (const h of raw.heads) {
    if (!isRecord(h) || Object.keys(h).sort().join(',') !== 'archived,id,revision' || typeof h.id !== 'string' || heads.has(h.id) || typeof h.archived !== 'boolean' || !ids.has(providerSelectionId(h.id, h.revision as number))) error('provider_storage', 'Saved model connections are invalid.');
    heads.add(h.id); const latest = Math.max(...raw.profiles.filter((p: ModelProviderProfile) => p.id === h.id).map((p: ModelProviderProfile) => p.revision));
    if (latest !== h.revision) error('provider_storage', 'Saved model revisions are out of order.');
  }
  if (raw.profiles.some((p: ModelProviderProfile) => !heads.has(p.id))) error('provider_storage', 'Saved model connections are incomplete.');
  return raw as unknown as SavedProviderRegistry;
}
export class ProviderRegistry {
  private data: SavedProviderRegistry = { version: 1, profiles: [], heads: [] }; private adapters = new Map<string, ModelAdapter>(); private writing = false;
  readonly filePath: string;
  constructor(private config: ProviderRegistryOptions) {
    this.filePath = config.filePath; privateParent(this.filePath);
    if (existsSync(this.filePath)) {
      let fd: number | undefined; try { fd = openSync(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW); const info = fstatSync(fd); if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024 || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) error('provider_storage', 'Saved model connections must be a private file.'); this.data = validateProviderRegistry(JSON.parse(readFileSync(fd, 'utf8'))); }
      catch (e) { if (e instanceof ProviderConfigurationError) throw e; error('provider_storage', 'Saved model connections could not be read. Restore a verified backup.'); } finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  options(): ProviderModelOption[] {
    return [...MODEL_CHOICES.map(m => ({ id: m.id, label: m.label, provider: m.provider, local: false, inputUsdPerMillion: m.inputUsdPerMillion, outputUsdPerMillion: m.outputUsdPerMillion, maxInputTokens: 200_000, maxOutputTokens: 4096 })), ...this.data.heads.filter(h => !h.archived).map(h => this.profile(providerSelectionId(h.id, h.revision))).map(p => ({ id: p.selectionId, label: `${p.label} · ${p.model}`, provider: p.kind, local: p.billing === 'local', inputUsdPerMillion: p.inputUsdPerMillion, outputUsdPerMillion: p.outputUsdPerMillion, maxInputTokens: p.maxInputTokens, maxOutputTokens: p.maxOutputTokens, profileRevision: p.revision }))];
  }
  profile(selectionId: string): ModelProviderProfile { const p = this.data.profiles.find(p => p.selectionId === selectionId); if (!p) return error('provider_missing', 'This saved model revision is unavailable. Choose a configured model.'); return structuredClone(p); }
  resolve(selectionId: string): ModelAdapter {
    if (selectionId === DEFAULT_MODEL) return this.config.legacyAdapter;
    const p = this.profile(selectionId); let adapter = this.adapters.get(selectionId); if (!adapter) { adapter = new ConfiguredModelAdapter({ profile: p, credentials: this.config.credentials(p), fetch: this.config.fetch }); this.adapters.set(selectionId, adapter); } return adapter;
  }
  selectable(selectionId: string): boolean { return selectionId === DEFAULT_MODEL || this.options().some(option => option.id === selectionId); }
  async state(): Promise<ModelProviderState> {
    const profiles = await Promise.all(this.data.heads.map(async h => { const p = this.profile(providerSelectionId(h.id, h.revision)), status = await this.resolve(p.selectionId).status(); return { ...p, archived: h.archived, configured: status.configured, message: status.message, tested: false as const }; }));
    return { profiles, history: this.data.profiles.filter(p=>!this.data.heads.some(h=>h.id===p.id&&h.revision===p.revision)).map(p=>structuredClone(p)), busy: this.writing };
  }
  private persist(data: SavedProviderRegistry) {
    validateProviderRegistry(data); privateParent(this.filePath);
    if (existsSync(this.filePath)) { const info = lstatSync(this.filePath); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) error('provider_storage', 'The connection file changed unexpectedly.'); }
    const temporary = join(dirname(this.filePath), `.model-providers-${randomUUID()}`); let fd: number | undefined;
    try { fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, this.filePath); this.data = data; }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
  }
  async save(input: ModelProviderInput, update: { id?: string; expectedRevision?: number; key?: string } = {}): Promise<void> {
    if (this.writing) error('provider_busy', 'A model connection change is already in progress.'); const validated = validateProviderInput(input);
    if (update.key !== undefined && (validated.authentication !== 'api-key' || !/^[\x21-\x7e]{8,1024}$/.test(update.key))) error('provider_key', 'Enter a valid API key without spaces or line breaks.');
    if (this.data.profiles.length >= 500 || (!update.id && this.data.heads.length >= 50)) error('provider_capacity', 'The saved connection limit has been reached.');
    let old: ModelProviderProfile | undefined;
    if (update.id !== undefined) { const head = this.data.heads.find(h => h.id === update.id); if (!head || head.revision !== update.expectedRevision) error('provider_conflict', 'This connection changed. Reload it before saving.'); old = this.profile(providerSelectionId(head.id, head.revision)); }
    else if (update.expectedRevision !== undefined) error('provider_conflict', 'A new connection cannot specify a previous revision.');
    const id = old?.id ?? randomUUID(), revision = (old?.revision ?? 0) + 1, profile: ModelProviderProfile = { ...validated, id, revision, selectionId: providerSelectionId(id, revision), createdAt: Date.now() };
    this.writing = true; let savedKey = false;
    try {
      if (validated.authentication === 'api-key') {
        let key = update.key;
        if (!key && old && old.baseUrl === profile.baseUrl && old.kind === profile.kind && old.authentication === profile.authentication) {
          const credentials = this.config.credentials(old); if ((await credentials.status()).configured) key = await credentials.read();
        }
        if (key) { await this.config.credentials(profile).save(key); savedKey = true; key = ''; }
      }
      const data = structuredClone(this.data); data.profiles.push(profile); const head = data.heads.find(h => h.id === id); if (head) { head.revision = revision; head.archived = false; } else data.heads.push({ id, revision, archived: false }); this.persist(data);
    } catch (e) { if (savedKey) await this.config.credentials(profile).remove().catch(() => {}); if (e instanceof ProviderConfigurationError) throw e; error('provider_keychain', 'The connection could not be saved. Check macOS Keychain and the app data folder.'); }
    finally { this.writing = false; }
  }
  archive(id: string, expectedRevision: number): void {
    if (this.writing) error('provider_busy', 'A model connection change is already in progress.'); const data = structuredClone(this.data), head = data.heads.find(h => h.id === id); if (!head || head.revision !== expectedRevision) error('provider_conflict', 'This connection changed. Reload it before archiving.'); head.archived = true; this.persist(data);
  }
  async saveKey(selectionId: string, key: string): Promise<void> {
    if (this.writing) error('provider_busy', 'A model connection change is already in progress.'); const profile = this.profile(selectionId);
    if (profile.authentication !== 'api-key' || !/^[\x21-\x7e]{8,1024}$/.test(key)) error('provider_key', 'Enter a valid API key for this saved endpoint revision.');
    this.writing = true;
    try { await this.config.credentials(profile).save(key); } catch { error('provider_keychain', 'The key could not be saved in macOS Keychain.'); } finally { this.writing = false; }
  }
  async removeKey(selectionId: string): Promise<void> {
    if (this.writing) error('provider_busy', 'A model connection change is already in progress.'); const profile = this.profile(selectionId); this.writing = true;
    try { await this.config.credentials(profile).remove(); } catch { error('provider_keychain', 'The key could not be removed from macOS Keychain.'); } finally { this.writing = false; }
  }
}
