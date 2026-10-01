import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, link, symlink, rename, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileBoundaryError, assertManagedPath, ensureManagedDirectory, secureCopy, classifyFile,
  verifyFile, safeTextPreview, finalizeImmutable, exportVerifiedFile, measureStorage, MAX_PREVIEW_BYTES,
} from '../../packages/artifacts/safe-io';

async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const original = await mkdtemp(join(tmpdir(), 'aw-safe-io-'));
  const root = await realpath(original);
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function rejects(promise: Promise<unknown>, codes?: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FileBoundaryError, String(error));
    if (codes) assert.ok(codes.includes(error.code), `unexpected code ${error.code}`);
    return true;
  });
}
async function missing(path: string): Promise<void> { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
function hash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }

test('secure copy verifies content, hashes, identity, and exclusive staging without changing source', async () => temporary(async root => {
  const source = join(root, 'input.csv'), destination = join(root, 'stage');
  const content = 'period,value\nprevious,2\ncurrent,3\n';
  await writeFile(source, content);
  const result = await secureCopy(source, destination, { maxBytes: 1024, managedRoot: root });
  assert.equal(result.bytes, Buffer.byteLength(content));
  assert.equal(result.sha256, hash(content));
  assert.equal(result.mime, 'text/csv');
  assert.equal(result.previewKind, 'text');
  assert.equal(await readFile(destination, 'utf8'), content);
  assert.equal(await readFile(source, 'utf8'), content);
  await rejects(secureCopy(source, destination, { maxBytes: 1024, managedRoot: root }), ['destination_exists']);
  assert.equal(await readFile(destination, 'utf8'), content);
}));

test('source symlinks, hardlinks, directories, and FIFOs fail before copying', { timeout: 5000 }, async () => temporary(async root => {
  const original = join(root, 'real.txt'); await writeFile(original, 'private');
  await symlink(original, join(root, 'symlink.txt'));
  await rejects(secureCopy(join(root, 'symlink.txt'), join(root, 'out-a')), ['unsafe_file']);
  await link(original, join(root, 'hardlink.txt'));
  await rejects(secureCopy(original, join(root, 'out-b')), ['unsafe_file']);
  await rejects(verifyFile(join(root, 'hardlink.txt')), ['unsafe_file']);
  await mkdir(join(root, 'directory'));
  await rejects(secureCopy(join(root, 'directory'), join(root, 'out-c')), ['unsafe_file']);
  execFileSync('mkfifo', [join(root, 'pipe')]);
  await rejects(secureCopy(join(root, 'pipe'), join(root, 'out-d')), ['unsafe_file']);
  for (const name of ['out-a', 'out-b', 'out-c', 'out-d']) await missing(join(root, name));
}));

test('missing source files return a structured error without leaking a host path', async () => temporary(async root => {
  const absent = join(root, 'private-missing.txt');
  await rejects(secureCopy(absent, join(root, 'out')), ['file_missing']);
  await rejects(verifyFile(absent), ['file_missing']);
  await assert.rejects(verifyFile(absent), (error: unknown) => error instanceof FileBoundaryError && !error.message.includes(root));
}));

test('destination links cannot overwrite or alter an existing target', async () => temporary(async root => {
  await writeFile(join(root, 'source.txt'), 'new'); await writeFile(join(root, 'existing'), 'keep');
  await symlink(join(root, 'existing'), join(root, 'destination'));
  await rejects(secureCopy(join(root, 'source.txt'), join(root, 'destination')), ['destination_exists', 'unsafe_path']);
  await link(join(root, 'existing'), join(root, 'hard-destination'));
  await rejects(secureCopy(join(root, 'source.txt'), join(root, 'hard-destination')), ['destination_exists']);
  assert.equal(await readFile(join(root, 'existing'), 'utf8'), 'keep');
}));

test('managed paths reject traversal, prefix-confusable roots, and ancestor symlinks', async () => temporary(async root => {
  const managed = join(root, 'managed'); await mkdir(managed); await mkdir(join(root, 'managed-other'));
  await rejects(assertManagedPath(managed, '../outside', { allowMissingLeaf: true }), ['unsafe_path']);
  await rejects(assertManagedPath(managed, join(root, 'managed-other', 'file'), { allowMissingLeaf: true }), ['unsafe_path']);
  await ensureManagedDirectory(managed, 'private/task/inputs');
  assert.equal(await assertManagedPath(managed, 'private/task/inputs/file', { allowMissingLeaf: true }), join(managed, 'private/task/inputs/file'));
  await symlink(join(root, 'managed-other'), join(managed, 'escape'));
  await rejects(assertManagedPath(managed, 'escape/file', { allowMissingLeaf: true }), ['unsafe_path']);
  await rejects(ensureManagedDirectory(managed, 'escape/nested'), ['unsafe_path']);
  await missing(join(root, 'managed-other', 'nested'));
}));

test('macOS canonical source-parent aliases work without granting sibling access', async () => temporary(async root => {
  const path = join(root, 'source.txt'); await writeFile(path, 'read one file');
  const aliased = process.platform === 'darwin' && path.startsWith('/private/var/') ? path.replace('/private/var/', '/var/') : path;
  assert.equal((await verifyFile(aliased)).sha256, hash('read one file'));
}));

test('source mutation during a chunked copy rejects and removes incomplete staging', async () => temporary(async root => {
  const source = join(root, 'source.txt'), destination = join(root, 'staging');
  await writeFile(source, 'a'.repeat(192 * 1024)); let changed = false;
  await rejects(secureCopy(source, destination, {
    maxBytes: 256 * 1024, managedRoot: root,
    async afterChunk() { if (!changed) { changed = true; await writeFile(source, 'b'.repeat(192 * 1024)); } },
  }), ['file_changed']);
  await missing(destination);
}));

test('same-size mutation with restored mtime is caught by ctime and checksum checks', async () => temporary(async root => {
  const source = join(root, 'source.txt'), destination = join(root, 'staging');
  await writeFile(source, 'a'.repeat(128 * 1024)); const initial = await lstat(source); let changed = false;
  await rejects(secureCopy(source, destination, { maxBytes: 256 * 1024,
    async afterChunk() { if (!changed) { changed = true; await writeFile(source, 'b'.repeat(128 * 1024)); await utimes(source, initial.atime, initial.mtime); } },
  }), ['file_changed']);
  await missing(destination);
}));

test('managed ancestor replacement is detected and never reported as committed', async () => temporary(async root => {
  const managed = join(root, 'managed'), outside = join(root, 'outside');
  await mkdir(managed); await mkdir(outside); await mkdir(join(managed, 'staging'));
  await writeFile(join(root, 'source.txt'), 'a'.repeat(128 * 1024)); let changed = false;
  await rejects(secureCopy(join(root, 'source.txt'), join(managed, 'staging', 'copy'), { maxBytes: 256 * 1024, managedRoot: managed,
    async afterChunk() { if (!changed) { changed = true; await rename(join(managed, 'staging'), join(managed, 'moved')); await symlink(outside, join(managed, 'staging')); } },
  }), ['file_changed', 'file_missing']);
  await missing(join(outside, 'copy'));
}));

test('oversized source and wrong expected hash reject without a committed copy', async () => temporary(async root => {
  const source = join(root, 'source.txt'); await writeFile(source, '123456');
  await rejects(secureCopy(source, join(root, 'too-big'), { maxBytes: 5 }), ['file_too_large']);
  await rejects(secureCopy(source, join(root, 'wrong-hash'), { expectedSha256: '0'.repeat(64) }), ['hash_mismatch']);
  await missing(join(root, 'too-big')); await missing(join(root, 'wrong-hash'));
  await rejects(verifyFile(source, { expectedSha256: '0'.repeat(64) }), ['hash_mismatch']);
}));

test('supported formats need matching content; complex formats stay metadata-only', async () => temporary(async root => {
  const fixtures: Array<[string, Buffer | string, string]> = [
    ['notes.txt', 'hello', 'text/plain'], ['notes.md', '# Notes', 'text/markdown'], ['values.csv', 'a,b\n1,2', 'text/csv'],
    ['value.json', '{"answer":42}', 'application/json'], ['document.pdf', '%PDF-1.7\n', 'application/pdf'],
    ['image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'], ['image.jpeg', Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
  ];
  for (const [name, bytes, mime] of fixtures) { await writeFile(join(root, name), bytes); const type = await classifyFile(join(root, name)); assert.equal(type.mime, mime); if (['.pdf', '.png', '.jpeg'].some(ext => name.endsWith(ext))) assert.equal(type.previewKind, 'metadata'); }
  await writeFile(join(root, 'fake.pdf'), 'plain text'); await rejects(classifyFile(join(root, 'fake.pdf')), ['type_mismatch']);
  await writeFile(join(root, 'fake.txt'), '%PDF-1.7\n'); await rejects(classifyFile(join(root, 'fake.txt')), ['type_mismatch']);
  await writeFile(join(root, 'bad.txt'), Buffer.from([0xc3, 0x28])); await rejects(classifyFile(join(root, 'bad.txt')), ['invalid_utf8']);
  await writeFile(join(root, 'null.csv'), Buffer.from([65, 0, 66])); await rejects(classifyFile(join(root, 'null.csv')), ['type_mismatch']);
  await writeFile(join(root, 'bytes.bin'), Buffer.from([0, 255, 1]));
  assert.equal((await classifyFile(join(root, 'bytes.bin'))).mime, 'application/octet-stream');
  await writeFile(join(root, 'page.html'), '<script>never rendered</script>');
  assert.deepEqual(await classifyFile(join(root, 'page.html')), { mime: 'text/plain', format: 'text', previewKind: 'text', extension: '.html' });
  await writeFile(join(root, 'vector.svg'), '<script>never rendered</script>'); assert.equal((await classifyFile(join(root, 'vector.svg'))).previewKind, 'metadata');
}));

test('bounded JSON checks syntax, structural depth, size, and treats prototype keys as data', async () => temporary(async root => {
  const source = join(root, 'input.json');
  await writeFile(source, '{invalid'); await rejects(classifyFile(source), ['invalid_json']);
  await writeFile(source, '['.repeat(65) + '0' + ']'.repeat(65)); await rejects(classifyFile(source), ['format_limit']);
  await writeFile(source, ' '.repeat(1024 * 1024 + 1)); await rejects(classifyFile(source), ['format_limit']);
  await writeFile(source, '{"__proto__":{"polluted":true}}'); assert.equal((await classifyFile(source)).format, 'json');
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
}));

test('preview is bounded raw text with safe UTF-8 truncation and explicit status', async () => temporary(async root => {
  const source = join(root, 'notes.txt');
  await writeFile(source, 'a'.repeat(MAX_PREVIEW_BYTES - 1) + '😀tail');
  const preview = await safeTextPreview(source);
  assert.equal(preview.truncated, true); assert.equal(preview.text, 'a'.repeat(MAX_PREVIEW_BYTES - 1)); assert.ok(!preview.text.includes('\ufffd'));
  await writeFile(source, '<img src=x onerror="bad()">');
  assert.deepEqual(await safeTextPreview(source), { text: '<img src=x onerror="bad()">', truncated: false });
  await rejects(safeTextPreview(source, { maxBytes: MAX_PREVIEW_BYTES + 1 }), ['invalid_limit']);
  await writeFile(source, Buffer.from([0xc3, 0x28])); await rejects(safeTextPreview(source), ['invalid_utf8']);
}));

test('preview validates the expected full-file checksum on its own retained descriptor', async () => temporary(async root => {
  const source = join(root, 'preview.txt');
  await writeFile(source, 'verified content');
  assert.deepEqual(await safeTextPreview(source, { managedRoot: root, expectedSha256: hash('verified content') }), { text: 'verified content', truncated: false });
  await writeFile(source, 'different content');
  await rejects(safeTextPreview(source, { managedRoot: root, expectedSha256: hash('verified content') }), ['hash_mismatch']);
}));

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
interface Entry { name: string; body?: string; flags?: number; mode?: number; method?: number; expanded?: number; localExtra?: Buffer }
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let position = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.body ?? '<xml/>'), flags = entry.flags ?? 0, crc = crc32(body), expanded = entry.expanded ?? body.length, extra = entry.localExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(entry.method ?? 0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(expanded, 22); local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28); locals.push(local, name, extra, body);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(entry.method ?? 0, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(expanded, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(((entry.mode ?? 0x8180) << 16) >>> 0, 38); directory.writeUInt32LE(position, 42);
    central.push(directory, name); position += local.length + name.length + extra.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, directory, end]);
}
const coreParts: Entry[] = [{ name: '[Content_Types].xml' }, { name: '_rels/.rels' }, { name: 'xl/workbook.xml' }];

test('XLSX classification inspects bounded ZIP structure without extracting or rendering it', async () => temporary(async root => {
  const source = join(root, 'input.xlsx'); await writeFile(source, zip(coreParts));
  const result = await classifyFile(source);
  assert.equal(result.format, 'xlsx'); assert.equal(result.previewKind, 'metadata');
  await writeFile(source, zip([{ name: 'unrelated.xml' }])); await rejects(classifyFile(source), ['type_mismatch']);
  await writeFile(source, zip(coreParts).subarray(0, -5)); await rejects(classifyFile(source), ['invalid_format']);
  const badOffset = zip(coreParts); badOffset.writeUInt32LE(0xfffffff0, badOffset.length - 6);
  await writeFile(source, badOffset); await rejects(classifyFile(source), ['archive_limit']);
  const wrongLocalName = zip(coreParts); wrongLocalName[30] = 'x'.charCodeAt(0);
  await writeFile(source, wrongLocalName); await rejects(classifyFile(source), ['invalid_format']);
}));

test('XLSX rejects macros, encryption, bombs, links, unsafe paths, and inconsistent required parts', async () => temporary(async root => {
  const source = join(root, 'input.xlsx');
  const cases: Array<[Entry[], string[]]> = [
    [[...coreParts, { name: 'xl/vbaProject.bin' }], ['macro_archive']],
    [[...coreParts, { name: 'xl/embeddings/oleObject1.bin' }], ['macro_archive']],
    [[{ ...coreParts[0], flags: 1 }, ...coreParts.slice(1)], ['encrypted_archive']],
    [[...coreParts, { name: 'xl/bomb.xml', method: 8, body: 'x', expanded: 100_000_000 }], ['archive_limit']],
    [[...coreParts, { name: '../escape' }], ['unsafe_archive']],
    [[...coreParts, { name: 'xl/link.xml', mode: 0xa1ff }], ['unsafe_archive']],
    [[...coreParts, { name: 'xl/workbook.xml' }], ['unsafe_archive']],
    [[...coreParts.slice(0, 2), { name: 'xl/workbook.xml', mode: 0x41c0 }], ['invalid_format']],
    [[...coreParts.slice(0, 2), { name: 'xl/workbook.xml', body: '' }], ['type_mismatch']],
  ];
  for (const [entries, codes] of cases) { await writeFile(source, zip(entries)); await rejects(classifyFile(source), codes); }
  await writeFile(join(root, 'macro.xlsm'), zip(coreParts)); await rejects(classifyFile(join(root, 'macro.xlsm')), ['macro_archive']);
}));

test('XLSX rejects alternate local ZIP paths and excessive directory entry counts', async () => temporary(async root => {
  const source = join(root, 'input.xlsx');
  const alternatePath = Buffer.from([0x75, 0x70, 0, 0]);
  await writeFile(source, zip([{ ...coreParts[0], localExtra: alternatePath }, ...coreParts.slice(1)]));
  await rejects(classifyFile(source), ['unsupported_archive']);
  const excessive = zip(coreParts); excessive.writeUInt16LE(2049, excessive.length - 14); excessive.writeUInt16LE(2049, excessive.length - 12);
  await writeFile(source, excessive); await rejects(classifyFile(source), ['archive_limit']);
}));

test('immutable finalization is exclusive, fsynced, readonly, and leaves one regular link', async () => temporary(async root => {
  const staged = join(root, 'stage'), final = join(root, 'version'); await writeFile(staged, 'immutable');
  const info = await finalizeImmutable(staged, final, { managedRoot: root, expectedSha256: hash('immutable'), fileName: 'output.txt' });
  assert.equal(info.format, 'text'); assert.equal((await lstat(final)).nlink, 1); assert.equal((await lstat(final)).mode & 0o222, 0);
  await missing(staged); assert.equal(await readFile(final, 'utf8'), 'immutable');
  await writeFile(staged, 'different'); await rejects(finalizeImmutable(staged, final, { managedRoot: root }), ['destination_exists']);
  assert.equal(await readFile(final, 'utf8'), 'immutable'); assert.equal(await readFile(staged, 'utf8'), 'different');
}));

test('owner export exposes only a complete verified final file and never overwrites', async () => temporary(async root => {
  const source = join(root, 'source.txt'), final = join(root, 'export.txt'); await writeFile(source, 'a'.repeat(128 * 1024));
  let sawTemporary = false;
  await exportVerifiedFile(source, final, {
    expectedSha256: hash('a'.repeat(128 * 1024)),
    onStaged(path) { sawTemporary = path.includes('.agent-workspaces-export-'); },
    async afterChunk() { await missing(final); },
  });
  assert.equal(sawTemporary, true); assert.equal((await lstat(final)).nlink, 1); assert.equal((await readFile(final)).length, 128 * 1024);
  await rejects(exportVerifiedFile(source, final), ['destination_exists']);
  assert.equal((await readdir(root)).filter(name => name.startsWith('.agent-workspaces-export-')).length, 0);
}));

test('failed owner export never leaves a partial final filename', async () => temporary(async root => {
  const source = join(root, 'source.txt'), final = join(root, 'export.txt'); await writeFile(source, 'a'.repeat(128 * 1024)); let once = false;
  await rejects(exportVerifiedFile(source, final, { async afterChunk() { if (!once) { once = true; await writeFile(source, 'b'.repeat(128 * 1024)); } } }), ['file_changed']);
  await missing(final);
  assert.equal((await readdir(root)).filter(name => name.startsWith('.agent-workspaces-export-')).length, 0);
}));

test('storage measurement counts private, staged, snapshot, database and WAL bytes and enforces caps', async () => temporary(async root => {
  for (const directory of ['private', 'staging', 'snapshots', 'control']) await mkdir(join(root, directory));
  const files: Array<[string, string]> = [['private/a', '123'], ['staging/b', '12'], ['snapshots/c', '1234'], ['control/db', '12345'], ['control/db-wal', '1']];
  for (const [path, body] of files) await writeFile(join(root, path), body);
  assert.deepEqual(await measureStorage(root), { bytes: 15, entries: 9 });
  await rejects(measureStorage(root, { maxBytes: 14 }), ['storage_limit']);
  await rejects(measureStorage(root, { maxEntries: 8 }), ['storage_limit']);
  await symlink(join(root, 'private/a'), join(root, 'alias'));
  await rejects(measureStorage(root), ['unsafe_path']);
}));

test('storage counts only exact Chromium bookkeeping symlinks without following their targets', async () => temporary(async root => {
  const managed = join(root, 'managed'), outside = join(root, 'outside');
  await mkdir(managed); await mkdir(join(managed, 'desktop')); await mkdir(outside);
  await writeFile(join(outside, 'large-secret'), 's'.repeat(100_000));
  let linkBytes = 0;
  for (const name of ['SingletonSocket', 'SingletonCookie', 'SingletonLock']) {
    const path = join(managed, 'desktop', name); await symlink(outside, path); linkBytes += (await lstat(path)).size;
  }
  assert.deepEqual(await measureStorage(managed), { bytes: linkBytes, entries: 4 });
  await rejects(measureStorage(managed, { maxBytes: linkBytes - 1 }), ['storage_limit']);
  await symlink(outside, join(managed, 'desktop', 'OtherLink'));
  await rejects(measureStorage(managed), ['unsafe_path']);
}));
