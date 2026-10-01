import { constants } from 'node:fs';
import { open, rename, rm, readdir } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertManagedPath, ensureManagedDirectory } from '../artifacts/safe-io';

export const PROFILE_LIMIT = 256 * 1024 * 1024;
export const CHUNK = 128 * 1024;
const META_LIMIT = 3 * 1024 * 1024;
const MAGIC = Buffer.from('AWPROFILE3\0');
export interface ProfileFile { path: string; bytes: number; sha256: string }
export type BrokerRequest = (method: string, params: object) => Promise<unknown>;
function invalid(): never { throw new Error('browser_profile_invalid'); }
export function validateManifest(raw: unknown): ProfileFile[] {
  if (!Array.isArray(raw) || raw.length > 4096) invalid();
  let bytes = 0;
  const paths = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'bytes,path,sha256') invalid();
    const { path, bytes: size, sha256 } = item;
    if (typeof path !== 'string' || path.length > 512 || !path || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some((part: string) => !part || part === '.' || part === '..') || paths.has(path)) invalid();
    if (!Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/.test(sha256)) invalid();
    paths.add(path); bytes += size;
    if (bytes > PROFILE_LIMIT) invalid();
  }
  // A file cannot also be an ancestor of another profile file.
  for (const path of paths) { const parts = path.split('/'); parts.pop(); while (parts.length) { if (paths.has(parts.join('/'))) invalid(); parts.pop(); } }
  return raw as ProfileFile[];
}
function decodeChunk(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid();
  const result = Buffer.from(value, 'base64');
  if (result.length > maximum || result.toString('base64') !== value) invalid();
  return result;
}
function boundedTransfer(request: BrokerRequest): BrokerRequest {
  const deadline = Date.now() + 90_000;
  return async (method, params) => {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('browser_profile_timeout');
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([request(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser_profile_timeout')), remaining); })]); }
    finally { clearTimeout(timer); }
  };
}

/** Ciphertext only on the host. Authenticate the full retained fd before restore. */
export class ProfileStore {
  private loadedKey?: Buffer;
  private closed=false;
  constructor(private root: string, private keySource: Uint8Array | (() => Uint8Array), private owner: string,
    private reserve?: (bytes: number) => Promise<() => Promise<void>>) {
    if (typeof keySource !== 'function' && keySource.byteLength !== 32) throw new Error('browser_profile_key_invalid');
  }
  unlock():void {
    if(this.closed)throw new Error('browser_profile_closed');
    if(this.loadedKey)return;
    const key=typeof this.keySource==='function'?this.keySource():this.keySource;
    if(!(key instanceof Uint8Array)||key.byteLength!==32)throw new Error('browser_profile_key_invalid');
    this.loadedKey=Buffer.from(key);
  }
  private get key():Buffer {this.unlock();return this.loadedKey!;}
  close():void {this.closed=true;this.loadedKey?.fill(0);this.loadedKey=undefined;}
  private async path(agentId: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(agentId)) invalid();
    await ensureManagedDirectory(this.root, 'control/browser-profiles');
    return join(this.root, 'control/browser-profiles', `${agentId}.enc`);
  }
  private aad(agentId: string): Buffer { return Buffer.from(`agent-workspaces-profile-v3:${this.owner}:${agentId}`); }
  async save(agentId: string, rawFiles: unknown, request: BrokerRequest): Promise<number> {
    request = boundedTransfer(request);
    const files = validateManifest(rawFiles), savedAt = Date.now();
    const manifest = Buffer.from(JSON.stringify({ files, savedAt }));
    if (manifest.length > META_LIMIT) invalid();
    const destination = await this.path(agentId), temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const release = await this.reserve?.(files.reduce((sum, file) => sum + file.bytes, 0) + manifest.length + 128);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(agentId));
    let file;
    try {
      await assertManagedPath(this.root, temporary, { allowMissingLeaf: true });
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(Buffer.concat([MAGIC, iv]));
      const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
      await file.writeFile(cipher.update(Buffer.concat([length, manifest])));
      for (const entry of files) {
        const hash = createHash('sha256');
        for (let offset = 0; offset < entry.bytes;) {
          const result = await request('profile.read', { path: entry.path, offset, length: Math.min(CHUNK, entry.bytes - offset) }) as { base64?: unknown };
          const chunk = decodeChunk(result?.base64, Math.min(CHUNK, entry.bytes - offset));
          if (!chunk.length) invalid();
          hash.update(chunk); await file.writeFile(cipher.update(chunk)); offset += chunk.length;
        }
        if (hash.digest('hex') !== entry.sha256) invalid();
      }
      await file.writeFile(cipher.final()); await file.writeFile(cipher.getAuthTag());
      await file.sync(); await file.close(); file = undefined;
      await assertManagedPath(this.root, destination, { allowMissingLeaf: true });
      await rename(temporary, destination);
      const directory = await open(join(this.root, 'control/browser-profiles'), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return savedAt;
    } finally {
      await file?.close(); await rm(temporary, { force: true }); await release?.();
    }
  }
  async reconcile(): Promise<void> {
    await ensureManagedDirectory(this.root, 'control/browser-profiles');
    for (const entry of await readdir(join(this.root, 'control/browser-profiles'))) {
      const match = /^[a-zA-Z0-9_-]{1,96}\.enc\.([0-9]+)\.[a-f0-9-]{36}\.tmp$/.exec(entry);
      if (!match) continue;
      const pid = Number(match[1]); if (!Number.isSafeInteger(pid) || pid < 1) invalid();
      let live = true; try { process.kill(pid, 0); } catch { live = false; }
      if (live) continue;
      const path = join(this.root, 'control/browser-profiles', entry); await assertManagedPath(this.root, path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const metadata = await handle.stat(); if (!metadata.isFile() || metadata.nlink !== 1) invalid(); } finally { await handle.close(); }
      await rm(path);
    }
  }
  async restore(agentId: string, request: BrokerRequest): Promise<boolean> {
    request = boundedTransfer(request);
    const path = await this.path(agentId);
    let file;
    try { await assertManagedPath(this.root, path); file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (['ENOENT', 'file_missing'].includes(String((error as { code?: string }).code))) return false; throw error; }
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(PROFILE_LIMIT + META_LIMIT + 128) || before.size < BigInt(MAGIC.length + 32)) invalid();
      const header = Buffer.alloc(MAGIC.length + 12), tag = Buffer.alloc(16);
      await file.read(header, 0, header.length, 0); await file.read(tag, 0, 16, Number(before.size) - 16);
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) invalid();
      const end = Number(before.size) - 16;
      const decrypt = () => { const d = createDecipheriv('aes-256-gcm', this.key, header.subarray(MAGIC.length)); d.setAAD(this.aad(agentId)); d.setAuthTag(tag); return d; };
      const buffer = Buffer.alloc(CHUNK);
      const unchanged = async () => {
        const after = await file!.stat({ bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) invalid();
        await assertManagedPath(this.root, path);
      };
      // Pass one authenticates without sending unauthenticated plaintext to a worker.
      const authentication = decrypt();
      for (let offset = header.length; offset < end;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK, end - offset), offset);
        if (!bytesRead) invalid(); authentication.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      authentication.final(); await unchanged();
      const d = decrypt();
      let pending = Buffer.alloc(0), manifestBytes: number | undefined, files: ProfileFile[] | undefined;
      let index = 0, offset = 0, declared = false, hash = createHash('sha256');
      await request('profile.restore.begin', {});
      const consume = async (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        if (manifestBytes === undefined && pending.length >= 4) { manifestBytes = pending.readUInt32BE(0); pending = pending.subarray(4); if (manifestBytes > META_LIMIT) invalid(); }
        if (!files && manifestBytes !== undefined && pending.length >= manifestBytes) {
          const parsed = JSON.parse(pending.subarray(0, manifestBytes).toString('utf8'));
          files = validateManifest(parsed.files); pending = pending.subarray(manifestBytes);
        }
        if (!files) return;
        while (index < files.length) {
          const entry = files[index];
          if (!declared) { await request('profile.restore.file', entry); declared = true; }
          const length = Math.min(pending.length, entry.bytes - offset, CHUNK);
          if (length) {
            const bytes = pending.subarray(0, length); pending = pending.subarray(length);
            await request('profile.restore.chunk', { path: entry.path, offset, base64: bytes.toString('base64') }); hash.update(bytes); offset += length;
          }
          if (offset === entry.bytes) {
            if (hash.digest('hex') !== entry.sha256) invalid(); index++; offset = 0; declared = false; hash = createHash('sha256');
          } else break;
        }
      };
      for (let position = header.length; position < end;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK, end - position), position);
        if (!bytesRead) invalid(); await consume(d.update(buffer.subarray(0, bytesRead))); position += bytesRead;
      }
      await consume(d.final()); await unchanged();
      if (!files || index !== files.length || pending.length) invalid();
      await request('profile.restore.finish', {});
      return true;
    } finally { await file.close(); }
  }
}
