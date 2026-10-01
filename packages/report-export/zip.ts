/** Minimal stored ZIP writer for generated Office XML. No archive input, file
 * paths, compression libraries, macros, external relationships or ZIP64. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function createOfficeZip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, total = 0;
  const entries = Object.entries(files);
  if (!entries.length || entries.length > 32) throw new Error('The generated export has an unsupported archive shape.');
  for (const [path, text] of entries) {
    if (!/^[A-Za-z0-9_\[\]./-]+$/.test(path) || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('The export contains an invalid internal path.');
    const name = Buffer.from(path), bytes = Buffer.from(text); total += bytes.length;
    if (total > 16 * 1024 * 1024) throw new Error('The formatted export exceeds 16 MiB. Export the original file instead.');
    const crc = crc32(bytes), header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
