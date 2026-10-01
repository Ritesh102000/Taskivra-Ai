import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Writable } from 'node:stream';
import { assertManagedPath, ensureManagedDirectory } from '../artifacts/safe-io';
import type { CodeExportFile, CodeSeedFile } from '../code/runtime';

export const MAX_HEADER = 8192, MAX_FILES = 4096, MAX_BYTES = 512 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
export function safePath(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 2048 || /[\u0000-\u001f\\:]/.test(value)) throw new Error('code_path_invalid');
  const parts = value.split('/');
  if (parts.length > 24 || parts.some(p => !p || p === '.' || p === '..' || Buffer.byteLength(p) > 255)) throw new Error('code_path_invalid');
  return value;
}
// Conservative collision protection across Linux and macOS filesystem spelling.
export const pathKey = (path: string): string => path.normalize('NFD').toUpperCase().toLowerCase();
export class PathIndex {
  private paths = new Map<string, 'file' | 'directory'>();
  add(path: string): void {
    const parts = safePath(path).split('/');
    const key = pathKey(path);
    if (this.paths.has(key)) throw new Error('code_path_collision');
    for (let index = 1; index < parts.length; index++) {
      const parent = pathKey(parts.slice(0, index).join('/'));
      if (this.paths.get(parent) === 'file') throw new Error('code_path_collision');
      this.paths.set(parent, 'directory');
    }
    this.paths.set(key, 'file');
  }
}
export function validateSeedFiles(files: CodeSeedFile[], maxFiles: number, maxBytes: number): void {
  if (!Array.isArray(files) || files.length > maxFiles) throw new Error('code_input_limit');
  const areas = { workspace: new PathIndex(), shared: new PathIndex() };
  let total = 0;
  for (const file of files) {
    if (!['workspace', 'shared'].includes(file.area) || typeof file.sourcePath !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HASH.test(file.sha256)) throw new Error('code_input_invalid');
    areas[file.area].add(file.path); total += file.bytes;
    if (total > maxBytes) throw new Error('code_input_limit');
  }
}
export function header(value: object): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > MAX_HEADER) throw new Error('code_header_limit');
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length); return Buffer.concat([size, data]);
}
function cancelled(signal: AbortSignal): void { if (signal.aborted) throw new Error('code_stopped'); }
function identical(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink;
}
async function write(stream: Writable, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => stream.write(bytes, error => error ? reject(error) : resolve()));
}
/** Host inputs are retained, independently hashed descriptors; chunks never contain paths outside the manifest. */
export async function sendSeed(stream: Writable, files: CodeSeedFile[], root: string, signal: AbortSignal): Promise<void> {
  let total = 0;
  for (const file of files) {
    cancelled(signal); await assertManagedPath(root, file.sourcePath);
    const before = await lstat(file.sourcePath, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(file.bytes)) throw new Error('code_input_changed');
    const handle = await open(file.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!identical(before, await handle.stat({ bigint: true }))) throw new Error('code_input_changed');
      await write(stream, header({ type: 'file', path: file.path, size: file.bytes, sha256: file.sha256 }));
      const digest = createHash('sha256'); let count = 0; const buffer = Buffer.alloc(65536);
      while (true) {
        cancelled(signal); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.bytes - count + 1), null);
        if (!bytesRead) break;
        count += bytesRead; if (count > file.bytes) throw new Error('code_input_changed');
        const chunk = buffer.subarray(0, bytesRead); digest.update(chunk); await write(stream, chunk);
      }
      await assertManagedPath(root, file.sourcePath);
      if (count !== file.bytes || digest.digest('hex') !== file.sha256 || !identical(before, await handle.stat({ bigint: true })) || !identical(before, await lstat(file.sourcePath, { bigint: true }))) throw new Error('code_input_changed');
      total += count;
    } finally { await handle.close(); }
  }
  cancelled(signal); await write(stream, header({ type: 'end', count: files.length, bytes: total })); stream.end();
}

class Reader {
  private iterator: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  constructor(source: AsyncIterable<Uint8Array>, private signal: AbortSignal) { this.iterator = source[Symbol.asyncIterator](); }
  async exact(count: number): Promise<Buffer> {
    const result = Buffer.alloc(count); let offset = 0;
    while (offset < count) {
      cancelled(this.signal);
      if (!this.buffer.length) {
        const next = await this.iterator.next();
        if (next.done) throw new Error('code_export_truncated');
        this.buffer = Buffer.from(next.value);
      }
      const size = Math.min(count - offset, this.buffer.length);
      this.buffer.copy(result, offset, 0, size); offset += size; this.buffer = this.buffer.subarray(size);
    }
    return result;
  }
  async ended(): Promise<boolean> {
    cancelled(this.signal); if (this.buffer.length) return false;
    return (await this.iterator.next()).done === true;
  }
}
/** Independent host parser: exact framing, regular exclusive outputs, collisions, limits, hashes and fsync. */
export async function receiveExport(source: AsyncIterable<Uint8Array>, destination: string, root: string, limits: { files: number; exportBytes: number }, signal: AbortSignal): Promise<CodeExportFile[]> {
  await assertManagedPath(root, destination);
  if (!(await lstat(destination)).isDirectory() || (await readdir(destination)).length) throw new Error('code_export_destination_invalid');
  const reader = new Reader(source, signal), index = new PathIndex(), manifest: CodeExportFile[] = [];
  const directories = new Set([destination]); let total = 0;
  while (true) {
    const size = (await reader.exact(4)).readUInt32BE();
    if (!size || size > MAX_HEADER) throw new Error('code_export_header_invalid');
    let item: Record<string, unknown>;
    try { item = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await reader.exact(size))); } catch { throw new Error('code_export_header_invalid'); }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('code_export_header_invalid');
    if (item.type === 'end') {
      if (Object.keys(item).sort().join(',') !== 'bytes,count,type' || item.count !== manifest.length || item.bytes !== total || !(await reader.ended())) throw new Error('code_export_end_invalid');
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) { const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } }
      return manifest;
    }
    if (Object.keys(item).sort().join(',') !== 'path,sha256,size,type' || item.type !== 'file' || !Number.isSafeInteger(item.size) || (item.size as number) < 0 || typeof item.sha256 !== 'string' || !HASH.test(item.sha256)) throw new Error('code_export_record_invalid');
    const bytes = item.size as number, path = safePath(item.path); index.add(path);
    if (manifest.length >= limits.files || total + bytes > limits.exportBytes) throw new Error('code_export_limit');
    const target = join(destination, path), parent = dirname(target);
    await ensureManagedDirectory(root, relative(root, parent)); await assertManagedPath(root, target, { allowMissingLeaf: true });
    for (let directory = parent; directory.startsWith(destination); directory = dirname(directory)) { directories.add(directory); if (directory === destination) break; }
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const digest = createHash('sha256'); let remaining = bytes;
      while (remaining) {
        const chunk = await reader.exact(Math.min(65536, remaining)); digest.update(chunk); remaining -= chunk.length;
        let written = 0; while (written < chunk.length) written += (await output.write(chunk, written, chunk.length - written)).bytesWritten;
      }
      if (digest.digest('hex') !== item.sha256) throw new Error('code_export_hash_mismatch');
      await output.sync(); await output.chmod(0o444);
    } finally { await output.close(); }
    await assertManagedPath(root, target); total += bytes;
    manifest.push({ path, sourcePath: target, bytes, sha256: item.sha256 });
  }
}
