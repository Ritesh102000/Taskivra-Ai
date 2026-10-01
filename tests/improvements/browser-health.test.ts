import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describeProfileHealth, profileExtensionInstalled, profileIsRunning } from '../../packages/native-browser/health';

const evidence = { registered: true, connected: false, damaged: false, installed: true, running: false };
test('an installed extension in a closed profile asks to reconnect, not reinstall', () => {
  const result = describeProfileHealth(evidence);
  assert.equal(result.health, 'profile_closed'); assert.equal(result.setupRequired, false);
  assert.doesNotMatch(result.message!, /load|install/i);
});
test('an installed disconnected extension asks for reload without treating it as missing', () => {
  const result = describeProfileHealth({ ...evidence, running: true });
  assert.equal(result.health, 'extension_disconnected'); assert.equal(result.setupRequired, false);
  assert.match(result.message!, /enable or reload/);
});
test('only absent registration, absent extension or damaged setup calls for preparation', () => {
  assert.equal(describeProfileHealth({ ...evidence, registered: false }).health, 'setup_required');
  assert.equal(describeProfileHealth({ ...evidence, installed: false }).health, 'extension_missing');
  assert.equal(describeProfileHealth({ ...evidence, damaged: true, connected: true }).health, 'profile_repair');
  assert.equal(describeProfileHealth({ ...evidence, connected: true }).health, 'connected');
  assert.equal(describeProfileHealth({ ...evidence, installed: null, running: null }).setupRequired, false);
});
test('preference inspection recognizes disabled extensions and reads only the requested profile', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-health-')));
  try {
    const profile = join(root, 'agent'), other = join(root, 'other');
    await mkdir(join(profile, 'Default'), { recursive: true }); await mkdir(join(other, 'Default'), { recursive: true });
    await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { fixture: { state: 0 } } } }));
    await writeFile(join(other, 'Default', 'Preferences'), '{}');
    assert.equal(await profileExtensionInstalled(profile, 'fixture'), true);
    assert.equal(await profileExtensionInstalled(other, 'fixture'), false);
    assert.equal(await profileExtensionInstalled(profile, 'different'), false);
    assert.equal(await profileIsRunning(profile), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('damaged and redirected profile preferences remain unknown instead of recommending reinstall', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-health-')));
  try {
    const profile = join(root, 'agent'); await mkdir(join(profile, 'Default'), { recursive: true });
    await writeFile(join(profile, 'Default', 'Preferences'), '{}');
    await writeFile(join(profile, 'Default', 'Secure Preferences'), '{broken');
    assert.equal(await profileExtensionInstalled(profile, 'fixture'), null);
    await rm(join(profile, 'Default', 'Secure Preferences'));
    await writeFile(join(root, 'private'), JSON.stringify({ extensions: { settings: { fixture: {} } } }));
    await symlink(join(root, 'private'), join(profile, 'Default', 'Secure Preferences'));
    assert.equal(await profileExtensionInstalled(profile, 'fixture'), null);
    await symlink(profile, join(root, 'alias'));
    assert.equal(await profileExtensionInstalled(join(root, 'alias'), 'fixture'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
