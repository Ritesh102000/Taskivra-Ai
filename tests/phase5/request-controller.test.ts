import test from 'node:test';
import assert from 'node:assert/strict';
import type { Coordinator } from '../../packages/coordinator/index';
import type { RequestCommand, UserRequest } from '../../packages/contracts/index';
import { CommandValidationError } from '../../packages/contracts/validation';
import { RequestController, parseRequestPick } from '../../apps/desktop/main/request-controller';

const selection = { requestId: 'request-one', revision: 1, slotId: 'slot-one', slotRevision: 1 };
function fixture(pick: () => Promise<string | null> = async () => '/native/chosen.csv') {
  const request: UserRequest = { id: 'request-one', taskId: 'task-one', agentId: 'agent-one', type: 'files', kind: 'files', title: 'Supply revenue data', reason: 'A checked CSV is required', state: 'open', revision: 1, continuationKey: 'continue-one', slots: [{ id: 'slot-one', key: 'revenue', label: 'Revenue CSV', required: true, constraints: { formats: ['csv'], csv: { requiredColumns: ['revenue'] } }, state: 'missing', candidateVersionId: null, revision: 1, explanation: null }], response: null, createdAt: 1 };
  const calls: { imports: unknown[]; assignments: RequestCommand[]; picks: number } = { imports: [], assignments: [], picks: 0 };
  let taskState = 'waiting';
  const fake = {
    snapshot: () => ({ tasks: [{ id: 'task-one', agentId: 'agent-one', state: taskState }] }),
    requests: { async handle(command: RequestCommand) {
      if (command.type === 'requests.list') return [structuredClone(request)];
      calls.assignments.push(command);
      if (command.type !== 'requests.assign' || request.state === 'cancelled' || command.revision !== request.revision || command.assignments[0].slotRevision !== request.slots[0].revision) throw new CommandValidationError('The request changed; refresh its current revision.');
      request.slots[0].candidateVersionId = command.assignments[0].versionId; request.slots[0].state = 'checking'; request.slots[0].revision++; request.revision++;
      return [structuredClone(request)];
    } },
    artifacts: { async importFiles(input: unknown) { calls.imports.push(input); return { versionIds: ['immutable-candidate'] }; } },
  };
  const controller = new RequestController(fake as unknown as Coordinator, async (actual, label) => { calls.picks++; assert.equal(actual.agentId, 'agent-one'); assert.equal(label, 'Revenue CSV'); return pick(); });
  return { controller, request, calls, setTaskState: (state: string) => { taskState = state; } };
}

test('native request import scope is derived from request identity and candidates are not task inputs', async () => {
  const f = fixture(); const result = await f.controller.pick(selection);
  assert.equal(result.cancelled, false); assert.deepEqual(f.calls.imports, [{ principal: { kind: 'owner' }, target: { scope: 'private', agentId: 'agent-one', taskId: null }, paths: ['/native/chosen.csv'] }]);
  assert.deepEqual(f.calls.assignments, [{ type: 'requests.assign', requestId: 'request-one', revision: 1, assignments: [{ slotId: 'slot-one', slotRevision: 1, versionId: 'immutable-candidate' }] }]);
  assert.equal(result.requests[0].slots[0].state, 'checking'); assert.equal(JSON.stringify(result).includes('/native/'), false);
});

test('request picker rejects injected paths, scope, unknown fields and invalid revisions before opening native UI', async () => {
  const f = fixture();
  for (const raw of [{ ...selection, path: '/private/key' }, { ...selection, agentId: 'agent-two' }, { ...selection, taskId: 'task-two' }, { ...selection, revision: 0 }, { ...selection, slotRevision: 1.5 }, { ...selection, requestId: '../request' }, [], null]) await assert.rejects(f.controller.pick(raw), CommandValidationError);
  assert.equal(f.calls.picks, 0); assert.deepEqual(f.calls.imports, []); assert.deepEqual(parseRequestPick(selection), selection);
});

test('cancelled picker creates no candidate and stale requests are rejected before import', async () => {
  const f = fixture(async () => null); const cancelled = await f.controller.pick(selection); assert.equal(cancelled.cancelled, true); assert.equal(f.calls.imports.length, 0); assert.equal(f.calls.assignments.length, 0);
  f.request.revision++; await assert.rejects(f.controller.pick(selection), CommandValidationError); assert.equal(f.calls.picks, 1);
  f.request.revision = 1; f.setTaskState('cancelled'); await assert.rejects(f.controller.pick(selection), CommandValidationError); assert.equal(f.calls.imports.length, 0);
});

test('a request changed during native selection leaves a private copy but cannot bind the stale slot', async () => {
  const f = fixture(async () => { f.request.state = 'cancelled'; f.request.revision++; return '/native/late.csv'; });
  await assert.rejects(f.controller.pick(selection), CommandValidationError); assert.equal(f.calls.imports.length, 1); assert.equal(f.calls.assignments.length, 1); assert.equal(f.request.slots[0].candidateVersionId, null);
  assert.deepEqual((f.calls.imports[0] as { target: unknown }).target, { scope: 'private', agentId: 'agent-one', taskId: null });
});

test('one native request picker is active at a time and checking candidates can be replaced by current revision', async () => {
  let release!: () => void; const wait = new Promise<void>(done => { release = done; }); const f = fixture(async () => { await wait; return '/native/replacement.csv'; });
  f.request.state = 'checking'; f.request.slots[0].state = 'checking'; f.request.slots[0].candidateVersionId = 'older-candidate';
  const picking = f.controller.pick(selection); await Promise.resolve(); await assert.rejects(f.controller.pick(selection), CommandValidationError); release(); await picking;
  assert.equal(f.calls.picks, 1); assert.equal(f.request.slots[0].candidateVersionId, 'immutable-candidate'); assert.equal(f.request.slots[0].revision, 2);
});
