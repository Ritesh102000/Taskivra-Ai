import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
if (process.platform !== 'darwin' || process.argv.length !== 2) throw new Error('Run this explicit native Keychain helper build on macOS with no arguments.');
const directory = fileURLToPath(new URL('./', import.meta.url)), destination = join(directory, 'bin');
await mkdir(destination, { recursive: true, mode: 0o700 });
const temporary = join(destination, `.keychain-${randomUUID()}`);
try {
  await promisify(execFile)('/usr/bin/clang', ['-std=c11', '-fobjc-arc', '-O2', '-Wall', '-Wextra', '-Werror', join(directory, 'keychain-helper.m'), '-framework', 'Security', '-framework', 'CoreFoundation', '-framework', 'LocalAuthentication', '-framework', 'Foundation', '-o', temporary], { timeout: 30000, maxBuffer: 65536 });
  await rename(temporary, join(destination, 'keychain-helper'));
  process.stdout.write('Built the native macOS Keychain helper. No credentials were read or changed.\n');
} finally { await rm(temporary, { force: true }); }
