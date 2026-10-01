import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBoundaryError, measureStorage } from '../../packages/artifacts/safe-io';

async function temporary(run: (managed: string, outside: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'aw-native-storage-'));
  const managed = join(root, 'managed'), outside = join(root, 'outside');
  await mkdir(managed); await mkdir(outside);
  try { await run(managed, outside); } finally { await rm(root, { recursive: true, force: true }); }
}
const boundary = (code: string) => (error: unknown) => error instanceof FileBoundaryError && error.code === code;

test('four exact native Chrome bookkeeping names count only link bytes, including broken and external targets', async () => temporary(async (managed, outside) => {
  const profile = join(managed, 'native-browser', 'profiles', 'agent_A-123');
  await mkdir(profile, { recursive: true });
  const secret = join(outside, 'large-unrelated-file');
  await writeFile(secret, 'x'.repeat(100_000));
  const names = ['SingletonSocket', 'SingletonCookie', 'SingletonLock', 'RunningChromeVersion'];
  const targets = [outside, secret, join(outside, 'missing-socket'), '153.0.0.0'];
  let linkBytes = 0;
  for (let n = 0; n < names.length; n++) {
    const path = join(profile, names[n]);
    await symlink(targets[n], path); linkBytes += (await lstat(path)).size;
  }
  assert.deepEqual(await measureStorage(managed), { bytes: linkBytes, entries: 7 });
  await assert.rejects(measureStorage(managed, { maxBytes: linkBytes - 1 }), boundary('storage_limit'));
  await assert.rejects(measureStorage(managed, { maxEntries: 6 }), boundary('storage_limit'));
}));

const rejectedPaths = [
  'SingletonSocket',
  'native-browser/SingletonSocket',
  'native-browser/profiles/SingletonSocket',
  'native-browsers/profiles/agent/SingletonSocket',
  'native-browser/profile/agent/SingletonSocket',
  'staging/native-browser/profiles/agent/SingletonSocket',
  'native-browser/profiles/agent/Default/SingletonSocket',
  'native-browser/profiles/agent/nested/RunningChromeVersion',
  'native-browser/profiles/agent/OtherLink',
  'native-browser/profiles/agent/SingletonSocket.backup',
  'native-browser/profiles/agent/singletonSocket',
  'native-browser/profiles/agent/ＳingletonSocket',
  'native-browser/profiles/agent/RunningChromeVersions',
  'native-browser/profiles/agent/RunningChromeVersion.old',
  'native-browser/profiles/agent.id/SingletonLock',
  'native-browser/profiles/agent id/SingletonLock',
  'native-browser/profiles/аgent/SingletonLock',
  `native-browser/profiles/${'a'.repeat(97)}/SingletonLock`,
  'desktop/RunningChromeVersion',
  'desktop/Default/SingletonCookie',
];
for (const path of rejectedPaths) test(`storage rejects non-allowlisted or confusable link ${path}`, async () => temporary(async (managed, outside) => {
  const link = join(managed, path);
  await mkdir(dirname(link), { recursive: true }); await symlink(outside, link);
  await assert.rejects(measureStorage(managed), boundary('unsafe_path'));
}));

test('a linked profile directory cannot obtain the bookkeeping exception for its descendants', async () => temporary(async (managed, outside) => {
  const profiles = join(managed, 'native-browser', 'profiles');
  await mkdir(profiles, { recursive: true });
  await symlink('missing', join(outside, 'SingletonSocket'));
  await symlink(outside, join(profiles, 'agent_A'));
  await assert.rejects(measureStorage(managed), boundary('unsafe_path'));
}));

test('normal native profile files still count with application database and immutable artifact bytes', async () => temporary(async (managed) => {
  const files = [['native-browser/profiles/agent_A/Default/Preferences', '12345'], ['control/agent-workspaces.sqlite-wal', '123'], ['artifacts/exact-version', '12']];
  for (const [name, content] of files) { const path = join(managed, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  assert.equal((await measureStorage(managed)).bytes, 10);
}));
