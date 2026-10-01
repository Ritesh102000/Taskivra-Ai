import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDropPayload, parseFileCommand, parseImportTarget } from '../../packages/contracts/file-validation';
import { parseCommand } from '../../packages/contracts/validation';
import { nativeDropPaths } from '../../apps/desktop/main/drop';
import { FileController } from '../../apps/desktop/main/file-controller';
import type { Coordinator } from '../../packages/coordinator/index';
import type { ImportTarget, Snapshot } from '../../packages/contracts/index';

const target: ImportTarget = { scope: 'private', agentId: 'agent-a', taskId: 'task-a' };
const shared: ImportTarget = { scope: 'shared', agentId: null, taskId: null };

test('file commands accept IDs and explicit scope but no host paths, principals, code, or SQL', () => {
  const commands = [
    { type: 'files.pick', target }, { type: 'files.pick', target, artifactId: 'artifact-a' },
    { type: 'artifacts.publish', versionId: 'version-a' },
    { type: 'artifacts.use', versionId: 'version-a', taskId: 'task-a' },
    { type: 'artifacts.export', versionId: 'version-a' },
    { type: 'storage.updateBudget', budgetBytes: 2 * 1024 ** 3 },
  ];
  for (const command of commands) {
    assert.deepEqual(parseFileCommand(command), command);
    for (const extra of [{ path: '/etc/passwd' }, { destination: '/tmp/overwrite' }, { paths: ['/tmp/file'] }, { principal: { kind: 'owner' } }, { command: 'cat /etc/passwd' }, { sql: 'select 1' }]) assert.throws(() => parseFileCommand({ ...command, ...extra }));
  }
  for (const type of ['files.read', 'files.write', 'files.importPaths', 'artifacts.setScope', 'shell.openPath', 'artifacts.delete']) assert.throws(() => parseFileCommand({ type }));
  // Adding file channels does not broaden the original task-command bridge.
  assert.throws(() => parseCommand({ type: 'files.pick', target }));
});

test('import target cannot mix shared visibility with private task ownership', () => {
  assert.deepEqual(parseImportTarget(shared), shared);
  assert.deepEqual(parseImportTarget(target), target);
  for (const value of [{ ...shared, agentId: 'agent-a' }, { ...shared, taskId: 'task-a' }, { ...target, agentId: null }, { ...target, taskId: '../task' }, { ...target, scope: 'public' }, { ...target, path: '/tmp' }, {}, null, [], Object.create({ scope: 'shared' })]) assert.throws(() => parseImportTarget(value));
});

test('file IDs, storage limits, missing fields and cyclic commands reject before dialogs', () => {
  for (const versionId of ['', '../private', '/tmp/file', 'file:///tmp/file', {}, null, 'x'.repeat(97)]) assert.throws(() => parseFileCommand({ type: 'artifacts.export', versionId }));
  for (const budgetBytes of [0, -1, 256 * 1024 ** 2 - 1, 21 * 1024 ** 3, 1.5, NaN, Infinity, '2147483648']) assert.throws(() => parseFileCommand({ type: 'storage.updateBudget', budgetBytes }));
  for (const command of [{ type: 'files.pick' }, { type: 'artifacts.use', versionId: 'version-a' }, { type: 'artifacts.publish' }, null, [], true]) assert.throws(() => parseFileCommand(command));
  const cyclic: Record<string, unknown> = { type: 'files.pick' }; cyclic.target = cyclic;
  assert.throws(() => parseFileCommand(cyclic));
});

test('drop conversion uses native File identity, ignoring a fabricated path property', () => {
  const fabricated = { name: 'passwords.txt', path: '/etc/passwd' };
  assert.throws(() => nativeDropPaths([fabricated], () => ''), /dragged from your Mac/);
  assert.throws(() => nativeDropPaths([fabricated], () => { throw new Error('Not a native File'); }), /native File/);
  const native = {} as File;
  assert.deepEqual(nativeDropPaths([native], file => { assert.equal(file, native); return '/tmp/selected.txt'; }), ['/tmp/selected.txt']);
  for (const files of [[], new Array(33).fill(native), '/tmp/selected.txt', null]) assert.throws(() => nativeDropPaths(files, () => '/tmp/selected.txt'));
});

test('internal drop envelope is bounded and rejects nonlocal paths and extra fields', () => {
  assert.deepEqual(parseDropPayload({ target, paths: ['/tmp/selected.txt'] }), { target, paths: ['/tmp/selected.txt'] });
  for (const paths of [[], new Array(33).fill('/tmp/file'), ['../file'], ['https://example.com/file'], ['/tmp/nul\0file'], [4], '/tmp/file']) assert.throws(() => parseDropPayload({ target, paths }));
  assert.throws(() => parseDropPayload({ target, paths: ['/tmp/file'], artifactId: 'arbitrary-version-target' }));
});

function fixture() {
  const calls: { name: string; input: unknown }[] = [];
  const snapshot = { agents: [{ id: 'agent-a', name: 'A' }], tasks: [{ id: 'task-a', agentId: 'agent-a' }], artifacts: [{ id: 'version-a', artifactId: 'artifact-a', displayName: 'result.csv', status: 'ready' }] } as unknown as Snapshot;
  const service = {
    ready: Promise.resolve(),
    async importFiles(input: unknown) { calls.push({ name: 'import', input }); return { versionIds: ['version-new'] }; },
    async publish(input: unknown) { calls.push({ name: 'publish', input }); return { versionIds: ['version-shared'] }; },
    async useInTask(input: unknown) { calls.push({ name: 'use', input }); },
    async exportFile(input: unknown) { calls.push({ name: 'export', input }); },
    async updateBudget(input: unknown) { calls.push({ name: 'budget', input }); },
    async preview(input: unknown) { calls.push({ name: 'preview', input }); return { version: snapshot.artifacts[0], text: 'safe plain text', truncated: false, note: '' }; },
  };
  const coordinator = { snapshot: () => snapshot, artifacts: service } as unknown as Coordinator;
  return { calls, coordinator, snapshot };
}

test('picker import uses only native dialog selections and binds the exact recipient', async () => {
  const { calls, coordinator } = fixture();
  const controller = new FileController(coordinator, { async pick(selected, single) { assert.deepEqual(selected, target); assert.equal(single, false); return ['/tmp/native-selection.csv']; }, async save() { return null; } });
  const result = await controller.run({ type: 'files.pick', target });
  assert.deepEqual(calls, [{ name: 'import', input: { principal: { kind: 'owner' }, target, paths: ['/tmp/native-selection.csv'] } }]);
  assert.deepEqual(result.versionIds, ['version-new']);
});

test('native picker cancellation has no import side effect', async () => {
  const { calls, coordinator } = fixture();
  const controller = new FileController(coordinator, { async pick() { return []; }, async save() { return null; } });
  assert.equal((await controller.run({ type: 'files.pick', target })).cancelled, true);
  assert.equal((await controller.run({ type: 'artifacts.export', versionId: 'version-a' })).cancelled, true);
  assert.deepEqual(calls, []);
});

test('invalid target and raw path commands fail before a native dialog opens', async () => {
  const { coordinator } = fixture(); let dialogs = 0;
  const controller = new FileController(coordinator, { async pick() { dialogs++; return []; }, async save() { dialogs++; return null; } });
  await assert.rejects(controller.run({ type: 'files.pick', target: { ...target, agentId: 'agent-b' } }));
  await assert.rejects(controller.run({ type: 'files.pick', target: { ...target, taskId: 'task-b' } }));
  await assert.rejects(controller.run({ type: 'artifacts.export', versionId: 'version-a', destination: '/tmp/forged' }));
  assert.equal(dialogs, 0);
});

test('version updates use a single-file picker and retain the logical artifact ID', async () => {
  const { calls, coordinator } = fixture();
  const controller = new FileController(coordinator, { async pick(_target, single) { assert.equal(single, true); return ['/tmp/version2.csv']; }, async save() { return null; } });
  await controller.run({ type: 'files.pick', target, artifactId: 'artifact-a' });
  assert.equal((calls[0].input as { artifactId: string }).artifactId, 'artifact-a');
});

test('export destination comes only from the native save dialog', async () => {
  const { calls, coordinator } = fixture();
  const controller = new FileController(coordinator, { async pick() { return []; }, async save(name) { assert.equal(name, 'result.csv'); return '/tmp/owner-selected-new-file.csv'; } });
  assert.equal((await controller.run({ type: 'artifacts.export', versionId: 'version-a' })).exported, true);
  assert.deepEqual(calls[0], { name: 'export', input: { principal: { kind: 'owner' }, versionId: 'version-a', destination: '/tmp/owner-selected-new-file.csv' } });
});

test('one file operation owns the dialog/transfer slot until completion', async () => {
  const { coordinator } = fixture(); let release!: (paths: string[]) => void;
  const controller = new FileController(coordinator, { pick: () => new Promise(resolve => { release = resolve; }), async save() { return null; } });
  const first = controller.run({ type: 'files.pick', target });
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(controller.run({ type: 'artifacts.publish', versionId: 'version-a' }), /current file operation/);
  release([]); await first;
  await controller.run({ type: 'artifacts.publish', versionId: 'version-a' });
});

test('owner file methods use a fixed trusted principal and never accept one from the renderer', async () => {
  const { calls, coordinator } = fixture();
  const controller = new FileController(coordinator, { async pick() { return []; }, async save() { return null; } });
  await controller.run({ type: 'artifacts.publish', versionId: 'version-a' });
  await controller.run({ type: 'artifacts.use', versionId: 'version-a', taskId: 'task-a' });
  await controller.preview('version-a');
  for (const call of calls) assert.deepEqual((call.input as { principal: unknown }).principal, { kind: 'owner' });
  await assert.rejects(controller.preview({ versionId: 'version-a', principal: { kind: 'agent', agentId: 'agent-b' } }));
});
