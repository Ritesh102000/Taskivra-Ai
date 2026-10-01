import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MacKeychainCredentials, CredentialError } from '../../packages/model-adapters';

function invoke(binary: string, command: string, input?: Buffer): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [command], { stdio: ['pipe', 'pipe', 'pipe'] }); const chunks: Buffer[] = [], errors: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString() }); });
    child.stdin.end(input);
  });
}

test('missing or symlinked native helper yields safe unavailable status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-model-helper-'));
  try {
    const missing = new MacKeychainCredentials({ helperPath: join(root, 'missing') }); assert.equal((await missing.status()).configured, false); await assert.rejects(missing.read(), CredentialError);
    const file = join(root, 'file'), link = join(root, 'link'); await writeFile(file, '#!/bin/sh\nexit 99\n', { mode: 0o700 }); await symlink(file, link);
    const linked = new MacKeychainCredentials({ helperPath: link }); assert.equal((await linked.status()).configured, false); await assert.rejects(linked.read(), CredentialError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit opt-in: native Security helper stores and reads only an isolated synthetic test item', { skip: process.platform !== 'darwin' || process.env.AW_MODEL_KEYCHAIN_TEST !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-model-keychain-')), binary = join(root, 'helper');
  // Compile-time isolation makes it impossible for this test binary to address the owner item.
  const service = `com.agent-workspaces.test.${randomUUID()}`;
  const synthetic = Buffer.from('sk-' + randomBytes(40).toString('hex'));
  let built = false;
  try {
    await promisify(execFile)('/usr/bin/clang', ['-std=c11', '-fobjc-arc', '-O2', '-Wall', '-Wextra', '-Werror', `-DAW_KEYCHAIN_SERVICE="${service}"`, resolve('packages/model-adapters/keychain-helper.m'), '-framework', 'Security', '-framework', 'CoreFoundation', '-framework', 'LocalAuthentication', '-framework', 'Foundation', '-o', binary]); built = true;
    const provider = new MacKeychainCredentials({ helperPath: binary }); assert.equal((await provider.status()).configured, false);
    const saved = await invoke(binary, 'set-stdin', synthetic); assert.equal(saved.code, 0); assert.equal(saved.stdout.toString().trim(), 'saved'); assert.equal(saved.stderr, '');
    assert.equal((await provider.status()).configured, true);
    const returned = Buffer.from(await provider.read()); assert.equal(returned.length, synthetic.length); assert.ok(timingSafeEqual(returned, synthetic)); returned.fill(0);
    const rejected = await invoke(binary, 'set-stdin', Buffer.from('invalid')); assert.equal(rejected.code, 1); assert.equal(rejected.stdout.length, 0); assert.equal(rejected.stderr.trim(), 'key_invalid');
    const preserved = Buffer.from(await provider.read()); assert.ok(timingSafeEqual(preserved, synthetic)); preserved.fill(0);
    const deleted = await invoke(binary, 'delete'); assert.equal(deleted.code, 0); assert.equal((await provider.status()).configured, false);
  } finally { synthetic.fill(0); if (built) { const cleaned = await invoke(binary, 'delete'); assert.equal(cleaned.code, 0); } await rm(root, { recursive: true, force: true }); }
});
