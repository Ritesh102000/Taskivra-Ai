import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GmailState } from '../../packages/contracts/index';
import { GmailController, GmailControllerError, parseGmailOwnerCommand } from '../../apps/desktop/main/gmail-controller';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aw-gmail-controller-'));
  const state: GmailState = { configured: false, connectedAccount: null, connecting: false, error: null };
  const calls: { imports: string[]; accounts: string[]; picks: number; disconnects: number } = { imports: [], accounts: [], picks: 0, disconnects: 0 };
  let path: string | null = join(root, 'desktop.json'); let beforePick: (() => Promise<void>) | null = null;
  const service = { async status() { return { ...state }; }, async importClient(json: string) { calls.imports.push(json); state.configured = true; return { ...state }; }, async connect(account: string) { calls.accounts.push(account); state.connecting = true; return { ...state }; }, async disconnect() { calls.disconnects++; state.connectedAccount = null; return { ...state }; } };
  const controller = new GmailController(service, async id => id === 'approved-task' ? 'owner@gmail.com' : null, async () => { calls.picks++; await beforePick?.(); return path; });
  return { root, controller, calls, state, setPath: (value: string | null) => { path = value; }, beforePick: (work: () => Promise<void>) => { beforePick = work; }, close: () => rm(root, { recursive: true, force: true }) };
}
test('connect derives the exact saved task account and rejects renderer supplied accounts, endpoints and secrets', async () => {
  const f = await fixture(); try {
    for (const raw of [{ type: 'gmail.connect', account: 'other@gmail.com' }, { type: 'gmail.connect', taskId: 'approved-task', account: 'other@gmail.com' }, { type: 'gmail.connect', taskId: 'approved-task', url: 'https://attacker.test' }, { type: 'gmail.state', token: 'fake-secret' }, { type: 'gmail.connect', taskId: '../task' }, null, []]) await assert.rejects(f.controller.handle(raw), GmailControllerError);
    await assert.rejects(f.controller.handle({ type: 'gmail.connect', taskId: 'other-task' }), GmailControllerError);
    assert.deepEqual(f.calls.accounts, []);
    assert.equal((await f.controller.handle({ type: 'gmail.connect', taskId: 'approved-task' })).connecting, true);
    assert.deepEqual(f.calls.accounts, ['owner@gmail.com']);
    assert.deepEqual(parseGmailOwnerCommand({ type: 'gmail.disconnect' }), { type: 'gmail.disconnect' });
  } finally { await f.close(); }
});
test('native import sends bounded configuration only to trusted service and returns status without content or paths', async () => {
  const f = await fixture(); try {
    const json = '{"installed":{"client_secret":"SYNTHETIC_SECRET_CANARY"}}';
    await writeFile(join(f.root, 'desktop.json'), json);
    const result = await f.controller.importClient(undefined);
    assert.deepEqual(f.calls.imports, [json]); assert.equal(result.state.configured, true); assert.equal(result.cancelled, false);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET_CANARY'), false); assert.equal(JSON.stringify(result).includes(f.root), false);
    await assert.rejects(f.controller.importClient({ path: '/private/key' }), GmailControllerError); assert.equal(f.calls.picks, 1);
  } finally { await f.close(); }
});
test('cancelled import preserves connection and unsafe or oversized selections never reach service', async () => {
  const f = await fixture(); try {
    f.state.connectedAccount = 'owner@gmail.com'; f.setPath(null);
    const result = await f.controller.importClient(undefined); assert.equal(result.cancelled, true); assert.equal(result.state.connectedAccount, 'owner@gmail.com');
    const original = join(f.root, 'original.json'), alias = join(f.root, 'alias.json'), directory = join(f.root, 'folder');
    await writeFile(original, '{}'); await symlink(original, alias); await mkdir(directory);
    for (const path of [alias, directory, join(f.root, 'missing.json')]) { f.setPath(path); await assert.rejects(f.controller.importClient(undefined), GmailControllerError); }
    f.setPath(original); await writeFile(original, Buffer.alloc(16385, 32)); await assert.rejects(f.controller.importClient(undefined), GmailControllerError);
    await writeFile(original, Buffer.from([0xc0, 0x80])); await assert.rejects(f.controller.importClient(undefined), GmailControllerError);
    assert.deepEqual(f.calls.imports, []); assert.equal(f.state.connectedAccount, 'owner@gmail.com');
  } finally { await f.close(); }
});
test('only one native configuration picker runs at once', async () => {
  const f = await fixture(); let release!: () => void; try {
    const wait = new Promise<void>(done => { release = done; }); f.beforePick(() => wait); f.setPath(null);
    const active = f.controller.importClient(undefined); await assert.rejects(f.controller.importClient(undefined), GmailControllerError); release(); await active;
    assert.equal(f.calls.picks, 1);
  } finally { release?.(); await f.close(); }
});
