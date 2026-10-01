import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_PREVIEW_BYTES = 64 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;
const MAX_ZIP_CENTRAL_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_EXPANDED_BYTES = 256 * 1024 * 1024;
/** Source is inert UTF-8 text, never executed or rendered as HTML. Classification
 * remains `text`, so a .ts/.py file cannot satisfy a csv/json request slot. */
export const SOURCE_TEXT_EXTENSIONS = new Set([
  '.py', '.pyi', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.sh', '.bash', '.zsh',
  '.go', '.rs', '.rb', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sql', '.yaml', '.yml', '.toml', '.jsonc', '.xml', '.html', '.css', '.scss', '.vue', '.svelte', '.r',
]);

export class FileBoundaryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'FileBoundaryError'; }
}
function fail(code: string, message: string): never { throw new FileBoundaryError(code, message); }
function pathSyntax(path: string): void {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) fail('unsafe_path', 'The selected path is not permitted.');
}
function positiveLimit(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('invalid_limit', 'The file limit is invalid.');
  return value;
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink && a.mode === b.mode;
}
function regular(stat: BigIntStats, maxBytes: number, permittedLinks = 1n): void {
  if (!stat.isFile() || stat.isSymbolicLink()) fail('unsafe_file', 'Only regular files can be transferred.');
  if (stat.nlink !== permittedLinks) fail('unsafe_file', 'Linked files are not accepted. Select an independent regular file.');
  if (stat.size > BigInt(maxBytes)) fail('file_too_large', `The file exceeds the ${maxBytes}-byte limit.`);
}
function changed(): never { return fail('file_changed', 'The file or its containing directory changed during the operation. Try again.'); }
function translate(error: unknown): never {
  if (error instanceof FileBoundaryError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EEXIST') fail('destination_exists', 'The selected destination already exists. Choose a new filename.');
  if (code === 'ELOOP' || code === 'ENOTDIR') fail('unsafe_path', 'Links and non-directory ancestors are not accepted.');
  if (code === 'ENOENT') fail('file_missing', 'The selected file or directory no longer exists.');
  fail('file_operation_failed', 'The file operation could not finish.');
}

type Ancestor = { path: string; handle: FileHandle; stat: BigIntStats };
interface Guard { path: string; check(): Promise<void>; close(): Promise<void> }

/** Node does not expose openat. These identity checks detect ancestor replacement;
 * they are not an atomic dirfd write guarantee against a hostile host process.
 * Managed ancestors must remain coordinator-owned (never payload-writable).
 */
async function guardPath(path: string, managedRoot?: string): Promise<Guard> {
  pathSyntax(path);
  const absolute = resolve(path);
  let root: string;
  let target: string;
  if (managedRoot) {
    pathSyntax(managedRoot);
    const suppliedRoot = resolve(managedRoot);
    const rootEntry = await lstat(suppliedRoot, { bigint: true });
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) fail('unsafe_path', 'The managed root must be a real directory.');
    root = await realpath(suppliedRoot);
    const offset = relative(suppliedRoot, absolute);
    if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) fail('unsafe_path', 'The path is outside the managed workspace.');
    target = join(root, offset);
  } else {
    // Canonicalizing the selected file's parent accepts macOS /var aliases. It
    // grants no directory listing or sibling access to an agent or renderer.
    root = await realpath(dirname(absolute));
    target = join(root, basename(absolute));
  }
  const ancestors: Ancestor[] = [];
  try {
    const parent = dirname(target);
    const offset = relative(root, parent);
    if (offset.startsWith('..') || isAbsolute(offset)) fail('unsafe_path', 'The destination is outside its granted directory.');
    let current = root;
    for (const component of ['', ...offset.split(sep).filter(Boolean)]) {
      if (component) current = join(current, component);
      const before = await lstat(current, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) fail('unsafe_path', 'Managed directory links are not accepted.');
      const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = await handle.stat({ bigint: true });
      if (!stat.isDirectory() || !sameIdentity(before, stat)) { await handle.close(); changed(); }
      ancestors.push({ path: current, handle, stat });
    }
    return {
      path: target,
      async check() {
        for (const entry of ancestors) {
          const current = await lstat(entry.path, { bigint: true });
          const retained = await entry.handle.stat({ bigint: true });
          if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, entry.stat) || !sameIdentity(retained, entry.stat)) changed();
        }
      },
      async close() { await Promise.all(ancestors.map(entry => entry.handle.close())); },
    };
  } catch (error) { await Promise.all(ancestors.map(entry => entry.handle.close())); return translate(error); }
}

export async function assertManagedPath(root: string, path: string, options: { allowMissingLeaf?: boolean } = {}): Promise<string> {
  pathSyntax(path);
  const target = isAbsolute(path) ? path : join(root, path);
  const guard = await guardPath(target, root);
  try {
    try { const stat = await lstat(guard.path); if (stat.isSymbolicLink()) fail('unsafe_path', 'Managed file links are not accepted.'); }
    catch (error) { if (!(options.allowMissingLeaf && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error; }
    await guard.check();
    return guard.path;
  } catch (error) { return translate(error); } finally { await guard.close(); }
}

export async function ensureManagedDirectory(root: string, path: string): Promise<string> {
  pathSyntax(path);
  const suppliedRoot = resolve(root), target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const offset = relative(suppliedRoot, target);
  if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) fail('unsafe_path', 'The directory is outside the managed workspace.');
  const rootStat = await lstat(suppliedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('unsafe_path', 'The managed root must be a real directory.');
  const canonicalRoot = await realpath(suppliedRoot);
  let current = canonicalRoot;
  for (const component of offset.split(sep).filter(Boolean)) {
    const next = join(current, component);
    const guard = await guardPath(next, canonicalRoot);
    try {
      try { await mkdir(guard.path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return translate(error); }
      const stat = await lstat(guard.path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_path', 'Managed directory links are not accepted.');
      await guard.check(); current = guard.path;
    } finally { await guard.close(); }
  }
  return current;
}

interface OpenSource { path: string; handle: FileHandle; initial: BigIntStats; guard: Guard }
async function source(path: string, maxBytes: number, managedRoot?: string): Promise<OpenSource> {
  positiveLimit(maxBytes);
  pathSyntax(path);
  let handle: FileHandle | undefined, guard: Guard | undefined;
  try {
    // Test before opening so a FIFO/device cannot block an open operation.
    const selected = await lstat(path, { bigint: true });
    regular(selected, maxBytes);
    guard = await guardPath(path, managedRoot);
    const before = await lstat(guard.path, { bigint: true });
    regular(before, maxBytes);
    if (!sameFile(selected, before)) changed();
    handle = await open(guard.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat({ bigint: true });
    regular(initial, maxBytes);
    if (!sameFile(before, initial)) changed();
    await guard.check();
    return { path: guard.path, handle, initial, guard };
  } catch (error) { await handle?.close(); await guard?.close(); return translate(error); }
}
async function confirmSource(input: OpenSource, maxBytes: number): Promise<void> {
  const fd = await input.handle.stat({ bigint: true });
  const name = await lstat(input.path, { bigint: true });
  regular(fd, maxBytes); regular(name, maxBytes);
  if (!sameFile(input.initial, fd) || !sameFile(input.initial, name)) changed();
  await input.guard.check();
}
async function closeSource(input: OpenSource): Promise<void> { await input.handle.close(); await input.guard.close(); }
async function hashHandle(handle: FileHandle, expectedBytes: number): Promise<string> {
  const hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK_BYTES);
  let position = 0;
  while (position < expectedBytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - position), position);
    if (!bytesRead) changed();
    hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  const extra = Buffer.alloc(1);
  if ((await handle.read(extra, 0, 1, position)).bytesRead) changed();
  return hash.digest('hex');
}
async function readExact(handle: FileHandle, offset: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size); let count = 0;
  while (count < size) { const result = await handle.read(buffer, count, size - count, offset + count); if (!result.bytesRead) fail('invalid_format', 'The file is truncated.'); count += result.bytesRead; }
  return buffer;
}

export interface FileClassification {
  mime: string; format: 'text' | 'markdown' | 'csv' | 'json' | 'pdf' | 'png' | 'jpeg' | 'xlsx' | 'binary';
  previewKind: 'text' | 'metadata'; extension: string;
}
export interface VerifiedFile extends FileClassification { bytes: number; sha256: string }
export interface FileOptions { maxBytes?: number; maxJsonBytes?: number; expectedSha256?: string; managedRoot?: string; fileName?: string }
export interface CopyOptions extends FileOptions {
  sourceRoot?: string; destinationRoot?: string;
  afterChunk?: (copiedBytes: number) => void | Promise<void>;
}
function mismatch(): never { return fail('type_mismatch', 'The filename format does not match the file contents.'); }

function zipExtra(bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) fail('invalid_format', 'The ZIP extra field is truncated.');
    const tag = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2);
    if ([1, 0x9901, 0x7075].includes(tag)) fail('unsupported_archive', 'ZIP64, encrypted, or alternate-path archives are not supported.');
    offset += 4 + length;
    if (offset > bytes.length) fail('invalid_format', 'The ZIP extra field is truncated.');
  }
}

async function inspectXlsx(handle: FileHandle, size: number): Promise<void> {
  const tailSize = Math.min(size, 22 + 65535), tail = await readExact(handle, size - tailSize, tailSize);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index--) if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { eocd = index; break; }
  if (eocd < 0) fail('invalid_format', 'The XLSX ZIP directory is missing or truncated.');
  const count = tail.readUInt16LE(eocd + 10), directorySize = tail.readUInt32LE(eocd + 12), directoryOffset = tail.readUInt32LE(eocd + 16);
  if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) || tail.readUInt16LE(eocd + 8) !== count || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('unsupported_archive', 'Split and ZIP64 spreadsheets are not supported.');
  if (!count || count > MAX_ZIP_ENTRIES || directorySize > MAX_ZIP_CENTRAL_BYTES || directoryOffset + directorySize !== size - tailSize + eocd) fail('archive_limit', 'The spreadsheet archive exceeds supported directory limits.');
  const central = await readExact(handle, directoryOffset, directorySize);
  const names = new Set<string>(), folded = new Set<string>(), regions: Array<[number, number]> = [];
  let offset = 0, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) fail('invalid_format', 'The XLSX ZIP directory is invalid.');
    const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10), crc = central.readUInt32LE(offset + 16);
    const compressed = central.readUInt32LE(offset + 20), uncompressed = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28), extraLength = central.readUInt16LE(offset + 30), commentLength = central.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength, localOffset = central.readUInt32LE(offset + 42);
    if (entryEnd > central.length || !nameLength || nameLength > 1024 || central.readUInt16LE(offset + 34)) fail('invalid_format', 'The XLSX entry metadata is invalid.');
    if (flags & (1 | 0x40 | 0x2000)) fail('encrypted_archive', 'Encrypted spreadsheet archives are not accepted.');
    if (flags & ~(0x800 | 8 | 6)) fail('unsupported_archive', 'The ZIP entry uses unsupported features.');
    if (![0, 8].includes(method) || [compressed, uncompressed, localOffset].includes(0xffffffff)) fail('unsupported_archive', 'This spreadsheet compression method is not supported.');
    if (method === 0 && compressed !== uncompressed) fail('invalid_format', 'Stored ZIP entry sizes must match.');
    expanded += uncompressed;
    if (expanded > MAX_ZIP_EXPANDED_BYTES || (uncompressed > 0 && (!compressed || uncompressed / compressed > 100))) fail('archive_limit', 'The spreadsheet exceeds expanded-size or compression-ratio limits.');
    const nameBytes = central.subarray(offset + 46, offset + 46 + nameLength);
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { fail('invalid_format', 'Spreadsheet entry names must use UTF-8.'); }
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.includes(':') || name.split('/').some(part => part === '..' || part === '.') || folded.has(name.toLowerCase())) fail('unsafe_archive', 'Unsafe or duplicate spreadsheet paths are not accepted.');
    const unixType = (central.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) fail('unsafe_archive', 'Linked or special spreadsheet entries are not accepted.');
    const directory = name.endsWith('/');
    if (((unixType === 0x4000 || (central.readUInt32LE(offset + 38) & 0x10)) && !directory) || (directory && uncompressed !== 0)) fail('invalid_format', 'The spreadsheet directory entry is inconsistent.');
    if (/(^|\/)(vbaproject\.bin|vbadata\.xml|macrosheets|dialogsheets|activex|embeddings)(\/|$)/i.test(name)) fail('macro_archive', 'Macro or embedded executable spreadsheet content is not accepted.');
    if (!directory && uncompressed > 0) names.add(name);
    folded.add(name.toLowerCase());
    zipExtra(central.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    if (localOffset + 30 > directoryOffset) fail('invalid_format', 'The ZIP local entry lies outside file data.');
    const local = await readExact(handle, localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) fail('invalid_format', 'The ZIP local entry conflicts with its directory.');
    const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
    let regionEnd = localOffset + 30 + localNameLength + localExtraLength + compressed;
    if (regionEnd > directoryOffset || localNameLength !== nameLength || !(await readExact(handle, localOffset + 30, localNameLength)).equals(nameBytes)) fail('invalid_format', 'The ZIP local path or extent is invalid.');
    zipExtra(await readExact(handle, localOffset + 30 + localNameLength, localExtraLength));
    if (!(flags & 8) && (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== uncompressed)) fail('invalid_format', 'The ZIP entry size is inconsistent.');
    if (flags & 8) {
      if (regionEnd + 12 > directoryOffset) fail('invalid_format', 'The ZIP data descriptor is truncated.');
      const first = await readExact(handle, regionEnd, 4);
      const skip = first.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
      if (regionEnd + skip + 12 > directoryOffset) fail('invalid_format', 'The ZIP data descriptor is truncated.');
      const descriptor = await readExact(handle, regionEnd + skip, 12);
      if (descriptor.readUInt32LE(0) !== crc || descriptor.readUInt32LE(4) !== compressed || descriptor.readUInt32LE(8) !== uncompressed) fail('invalid_format', 'The ZIP data descriptor conflicts with its directory.');
      regionEnd += skip + 12;
    }
    regions.push([localOffset, regionEnd]); offset = entryEnd;
  }
  if (offset !== central.length) fail('invalid_format', 'The ZIP directory contains unrecognized trailing records.');
  regions.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < regions.length; i++) if (regions[i][0] < regions[i - 1][1]) fail('unsafe_archive', 'Overlapping spreadsheet entries are not accepted.');
  if (!['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml'].every(name => names.has(name))) fail('type_mismatch', 'The ZIP does not contain the required XLSX parts.');
}

async function inspectText(handle: FileHandle, size: number, json: boolean, maxJsonBytes: number): Promise<void> {
  if (json && size > maxJsonBytes) fail('format_limit', `JSON validation is limited to ${maxJsonBytes} bytes in this phase.`);
  const decoder = new TextDecoder('utf-8', { fatal: true }), buffer = Buffer.alloc(CHUNK_BYTES);
  let position = 0, jsonText = '';
  try {
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) changed();
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      if (text.includes('\0')) fail('type_mismatch', 'The text file contains binary null bytes.');
      if (json) jsonText += text;
      position += bytesRead;
    }
    const end = decoder.decode(); if (json) jsonText += end;
  } catch (error) { if (error instanceof FileBoundaryError) throw error; fail('invalid_utf8', 'The text file is not valid UTF-8.'); }
  if (json) {
    let parsed: unknown;
    try { parsed = JSON.parse(jsonText.replace(/^\uFEFF/, '')); } catch { fail('invalid_json', 'The JSON file is not valid JSON.'); }
    const pending: Array<[unknown, number]> = [[parsed, 0]];
    let entries = 0;
    while (pending.length) {
      const [value, depth] = pending.pop()!;
      if (++entries > 100_000 || depth > 64) fail('format_limit', 'The JSON structure exceeds supported depth or entry limits.');
      if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push([child, depth + 1]);
    }
  }
}

async function classification(handle: FileHandle, size: number, fileName: string, options: FileOptions): Promise<FileClassification> {
  const extension = extname(fileName).toLowerCase();
  const first = await readExact(handle, 0, Math.min(size, 16));
  const pdf = first.subarray(0, 5).equals(Buffer.from('%PDF-'));
  const png = first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = first.length >= 3 && first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff;
  const zip = first.length >= 4 && first.readUInt32LE(0) === 0x04034b50;
  if (['.xlsm', '.xltm', '.xlam', '.xlsb'].includes(extension)) fail('macro_archive', 'Macro-capable spreadsheet formats are not accepted.');
  const textFormats: Record<string, [FileClassification['format'], string]> = { '.txt': ['text', 'text/plain'], '.md': ['markdown', 'text/markdown'], '.markdown': ['markdown', 'text/markdown'], '.csv': ['csv', 'text/csv'], '.json': ['json', 'application/json'] };
  if (SOURCE_TEXT_EXTENSIONS.has(extension)) textFormats[extension] = ['text', 'text/plain'];
  if (textFormats[extension]) {
    if (pdf || png || jpeg || zip) mismatch();
    await inspectText(handle, size, extension === '.json', positiveLimit(options.maxJsonBytes ?? MAX_JSON_BYTES, MAX_JSON_BYTES));
    return { format: textFormats[extension][0], mime: textFormats[extension][1], previewKind: 'text', extension };
  }
  if (extension === '.pdf') { if (!pdf) mismatch(); return { format: 'pdf', mime: 'application/pdf', previewKind: 'metadata', extension }; }
  if (extension === '.png') { if (!png) mismatch(); return { format: 'png', mime: 'image/png', previewKind: 'metadata', extension }; }
  if (extension === '.jpg' || extension === '.jpeg') { if (!jpeg) mismatch(); return { format: 'jpeg', mime: 'image/jpeg', previewKind: 'metadata', extension }; }
  if (extension === '.xlsx') { if (!zip) mismatch(); await inspectXlsx(handle, size); return { format: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', previewKind: 'metadata', extension }; }
  return { format: 'binary', mime: 'application/octet-stream', previewKind: 'metadata', extension };
}

export async function classifyFile(path: string, options: FileOptions = {}): Promise<FileClassification> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES, input = await source(path, maxBytes, options.managedRoot);
  try { const result = await classification(input.handle, Number(input.initial.size), options.fileName ?? basename(path), options); await confirmSource(input, maxBytes); return result; }
  catch (error) { return translate(error); } finally { await closeSource(input); }
}

export async function verifyFile(path: string, options: FileOptions = {}): Promise<VerifiedFile> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES, input = await source(path, maxBytes, options.managedRoot);
  try {
    const bytes = Number(input.initial.size), sha256 = await hashHandle(input.handle, bytes);
    const type = await classification(input.handle, bytes, options.fileName ?? basename(path), options);
    await confirmSource(input, maxBytes);
    if (options.expectedSha256 && sha256 !== options.expectedSha256) fail('hash_mismatch', 'The stored file does not match its verified checksum.');
    return { bytes, sha256, ...type };
  } catch (error) { return translate(error); } finally { await closeSource(input); }
}

/** Copies to a service staging name. Owner-facing exports use exportVerifiedFile. */
export async function secureCopy(sourcePath: string, destinationPath: string, options: CopyOptions = {}): Promise<VerifiedFile> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const input = await source(sourcePath, maxBytes, options.sourceRoot);
  let output: FileHandle | undefined, destination: Guard | undefined, outputIdentity: BigIntStats | undefined;
  try {
    destination = await guardPath(destinationPath, options.destinationRoot ?? options.managedRoot);
    await destination.check();
    output = await open(destination.path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    outputIdentity = await output.stat({ bigint: true });
    regular(outputIdentity, maxBytes);
    const hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK_BYTES);
    let bytes = 0;
    while (bytes < Number(input.initial.size)) {
      const { bytesRead } = await input.handle.read(buffer, 0, Math.min(buffer.length, Number(input.initial.size) - bytes), bytes);
      if (!bytesRead) changed();
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) { const result = await output.write(buffer, written, bytesRead - written, bytes + written); if (!result.bytesWritten) fail('file_operation_failed', 'The staged write did not advance.'); written += result.bytesWritten; }
      bytes += bytesRead;
      await options.afterChunk?.(bytes);
    }
    await confirmSource(input, maxBytes);
    const sha256 = hash.digest('hex');
    if (await hashHandle(input.handle, bytes) !== sha256) changed();
    await confirmSource(input, maxBytes);
    if (options.expectedSha256 && options.expectedSha256 !== sha256) fail('hash_mismatch', 'The source does not match its verified checksum.');
    await output.sync();
    const stable = await output.stat({ bigint: true }); regular(stable, maxBytes);
    if (Number(stable.size) !== bytes || await hashHandle(output, bytes) !== sha256) changed();
    const type = await classification(output, bytes, options.fileName ?? basename(sourcePath), options);
    if (!sameFile(stable, await output.stat({ bigint: true }))) changed();
    const named = await lstat(destination.path, { bigint: true });
    if (!sameFile(stable, named)) changed();
    await destination.check();
    return { bytes, sha256, ...type };
  } catch (error) {
    // Never unlink an entry replaced by someone else after our exclusive open.
    if (destination && outputIdentity) {
      try { const current = await lstat(destination.path, { bigint: true }); if (sameIdentity(current, outputIdentity) && !current.isSymbolicLink()) await unlink(destination.path); } catch { /* Preserve the original error. */ }
    }
    return translate(error);
  } finally { await output?.close(); await destination?.close(); await closeSource(input); }
}

export async function safeTextPreview(path: string, options: { maxBytes?: number; managedRoot?: string; expectedSha256?: string } = {}): Promise<{ text: string; truncated: boolean }> {
  const limit = positiveLimit(options.maxBytes ?? MAX_PREVIEW_BYTES, MAX_PREVIEW_BYTES);
  const input = await source(path, DEFAULT_MAX_FILE_BYTES, options.managedRoot);
  try {
    const size = Number(input.initial.size), truncated = size > limit;
    if (options.expectedSha256 && await hashHandle(input.handle, size) !== options.expectedSha256) fail('hash_mismatch', 'The preview source does not match its verified checksum.');
    const bytes = await readExact(input.handle, 0, Math.min(size, limit));
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); }
    catch { return fail('invalid_utf8', 'A text preview is unavailable because the file is not valid UTF-8.'); }
    if (text.includes('\0')) fail('invalid_utf8', 'A text preview is unavailable for binary data.');
    if (options.expectedSha256 && await hashHandle(input.handle, size) !== options.expectedSha256) fail('hash_mismatch', 'The preview source changed before it could be displayed.');
    await confirmSource(input, DEFAULT_MAX_FILE_BYTES);
    return { text, truncated };
  } catch (error) { return translate(error); } finally { await closeSource(input); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Exclusive same-filesystem publication. A crash may leave a two-link
 * staging/final pair; the service reconciles its operation journal first. */
export async function finalizeImmutable(stagedPath: string, finalPath: string, options: FileOptions = {}): Promise<VerifiedFile> {
  const info = await verifyFile(stagedPath, options);
  const input = await source(stagedPath, options.maxBytes ?? DEFAULT_MAX_FILE_BYTES, options.managedRoot);
  let destination: Guard | undefined;
  let linked = false, stageRemoved = false;
  try {
    destination = await guardPath(finalPath, options.managedRoot);
    await input.guard.check(); await destination.check();
    await confirmSource(input, options.maxBytes ?? DEFAULT_MAX_FILE_BYTES);
    await link(input.path, destination.path); linked = true;
    const finalStat = await lstat(destination.path, { bigint: true }), sourceStat = await input.handle.stat({ bigint: true });
    regular(finalStat, options.maxBytes ?? DEFAULT_MAX_FILE_BYTES, 2n);
    if (!sameIdentity(input.initial, finalStat) || !sameIdentity(input.initial, sourceStat) || finalStat.size !== input.initial.size || finalStat.mtimeNs !== input.initial.mtimeNs || sourceStat.nlink !== 2n) changed();
    if (await hashHandle(input.handle, info.bytes) !== info.sha256) changed();
    await input.handle.chmod(0o444); await input.handle.sync();
    await destination.check(); await input.guard.check();
    await syncDirectory(dirname(destination.path));
    await unlink(input.path); stageRemoved = true;
    await syncDirectory(dirname(input.path));
    const committed = await lstat(destination.path, { bigint: true });
    regular(committed, options.maxBytes ?? DEFAULT_MAX_FILE_BYTES);
    if (!sameIdentity(committed, input.initial)) changed();
    await destination.check();
    return info;
  } catch (error) {
    if (destination && linked && !stageRemoved) {
      try { const current = await lstat(destination.path, { bigint: true }); if (sameIdentity(current, input.initial)) await unlink(destination.path); } catch { /* Reconciliation owns surviving known operation paths. */ }
    }
    return translate(error);
  } finally { await destination?.close(); await closeSource(input); }
}

export async function exportVerifiedFile(sourcePath: string, selectedNewPath: string, options: CopyOptions & { onStaged?: (path: string) => void | Promise<void> } = {}): Promise<VerifiedFile> {
  const destination = await guardPath(selectedNewPath, options.destinationRoot);
  const temporary = join(dirname(destination.path), `.agent-workspaces-export-${randomUUID()}.tmp`);
  let temporaryIdentity: BigIntStats | undefined, temporaryInput: OpenSource | undefined, linked = false;
  try {
    await destination.check();
    await options.onStaged?.(temporary);
    await destination.check();
    const info = await secureCopy(sourcePath, temporary, { ...options, sourceRoot: options.sourceRoot ?? options.managedRoot, managedRoot: options.destinationRoot, destinationRoot: options.destinationRoot, fileName: options.fileName ?? basename(sourcePath) });
    temporaryInput = await source(temporary, options.maxBytes ?? DEFAULT_MAX_FILE_BYTES, options.destinationRoot);
    temporaryIdentity = temporaryInput.initial;
    if (Number(temporaryIdentity.size) !== info.bytes || await hashHandle(temporaryInput.handle, info.bytes) !== info.sha256) changed();
    await confirmSource(temporaryInput, options.maxBytes ?? DEFAULT_MAX_FILE_BYTES);
    await temporaryInput.handle.sync();
    await destination.check();
    await link(temporary, destination.path); linked = true;
    const finalStat = await lstat(destination.path, { bigint: true });
    regular(finalStat, options.maxBytes ?? DEFAULT_MAX_FILE_BYTES, 2n);
    if (!sameIdentity(finalStat, temporaryIdentity) || finalStat.size !== temporaryIdentity.size || finalStat.mtimeNs !== temporaryIdentity.mtimeNs) changed();
    if (await hashHandle(temporaryInput.handle, info.bytes) !== info.sha256 || !sameFile(finalStat, await temporaryInput.handle.stat({ bigint: true }))) changed();
    await destination.check();
    await syncDirectory(dirname(destination.path));
    await unlink(temporary);
    await syncDirectory(dirname(destination.path));
    const committed = await lstat(destination.path, { bigint: true });
    regular(committed, options.maxBytes ?? DEFAULT_MAX_FILE_BYTES);
    if (!sameIdentity(committed, temporaryIdentity) || await hashHandle(temporaryInput.handle, info.bytes) !== info.sha256 || !sameFile(committed, await temporaryInput.handle.stat({ bigint: true }))) changed();
    await destination.check();
    return info;
  } catch (error) {
    if (linked && temporaryIdentity) {
      try { const current = await lstat(destination.path, { bigint: true }); if (sameIdentity(current, temporaryIdentity)) await unlink(destination.path); } catch { /* Owner can recover a completed export if cleanup fails. */ }
    }
    return translate(error);
  } finally {
    if (temporaryIdentity) { try { const current = await lstat(temporary, { bigint: true }); if (sameIdentity(current, temporaryIdentity)) await unlink(temporary); } catch { /* A crash-orphan temp requires the service journal or owner cleanup. */ } }
    if (temporaryInput) await closeSource(temporaryInput);
    await destination.close();
  }
}

export async function measureStorage(root: string, options: { maxEntries?: number; maxBytes?: number } = {}): Promise<{ bytes: number; entries: number }> {
  const maxEntries = positiveLimit(options.maxEntries ?? 100_000), maxBytes = positiveLimit(options.maxBytes ?? Number.MAX_SAFE_INTEGER);
  const base = await realpath(root), rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('unsafe_path', 'The storage root must be a real directory.');
  let bytes = 0, entries = 0;
  const pending = [base];
  while (pending.length) {
    const directory = pending.pop()!;
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) fail('unsafe_path', 'Storage links are not accepted.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > maxEntries) fail('storage_limit', 'The storage entry limit was reached.');
      const path = join(directory, entry.name), stat = await lstat(path, { bigint: true });
      if (stat.isSymbolicLink()) {
        // Only Chromium's exact bookkeeping names at the Electron profile or
        // a dedicated agent profile root are allowed. Count the link itself;
        // never resolve or inspect its target, including broken external links.
        const relativePath = relative(base, path).split(sep).join('/');
        const ownLink = ['desktop/SingletonSocket', 'desktop/SingletonCookie', 'desktop/SingletonLock'].includes(relativePath)
          || /^native-browser\/profiles\/[A-Za-z0-9_-]{1,96}\/(?:SingletonSocket|SingletonCookie|SingletonLock|RunningChromeVersion)$/.test(relativePath);
        if (!ownLink) fail('unsafe_path', 'Storage links are not accepted.');
        bytes += Number(stat.size);
        if (!Number.isSafeInteger(bytes) || bytes > maxBytes) fail('storage_limit', 'The storage byte limit was reached.');
        continue;
      }
      if (stat.isDirectory()) pending.push(path);
      else { regular(stat, maxBytes); bytes += Number(stat.size); if (!Number.isSafeInteger(bytes) || bytes > maxBytes) fail('storage_limit', 'The storage byte limit was reached.'); }
    }
    if (!sameIdentity(before, await lstat(directory, { bigint: true }))) changed();
  }
  return { bytes, entries };
}
