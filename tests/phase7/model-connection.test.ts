import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelConnectionController } from '../../apps/desktop/main/model-connection-controller';

const fixtureKey = 'sk-fixture_only_not_a_real_credential';
test('owner connection actions store securely and never claim a paid test or return key material', async () => {
  const received: string[] = []; let removed = 0;
  const c = new ModelConnectionController({ save: async key => { received.push(key); }, remove: async () => { removed++; } }, async () => false);
  const result = await c.handle({ type: 'model.saveKey', key: fixtureKey });
  assert.deepEqual(received, [fixtureKey]); assert.deepEqual(result, { configured: true, tested: false });
  assert.doesNotMatch(JSON.stringify(result), /fixture_only/);
  assert.deepEqual(await c.handle({ type: 'model.removeKey' }), { configured: false, tested: false }); assert.equal(removed, 1);
  for (const raw of [{ type: 'model.saveKey', key: fixtureKey, taskId: 'x' }, { type: 'model.saveKey', key: fixtureKey + '\n' }, { type: 'model.readKey' }, { type: 'model.removeKey', key: fixtureKey }]) await assert.rejects(c.handle(raw));
});

test('active work and native errors cannot disclose or rotate credentials', async () => {
  let writes = 0;
  const blocked = new ModelConnectionController({ save: async () => { writes++; }, remove: async () => { writes++; } }, async () => true);
  await assert.rejects(blocked.handle({ type: 'model.saveKey', key: fixtureKey }), /Pause active/); assert.equal(writes, 0);
  const failing = new ModelConnectionController({ save: async () => { throw new Error(fixtureKey); }, remove: async () => {} }, async () => false);
  await assert.rejects(failing.handle({ type: 'model.saveKey', key: fixtureKey }), error => error instanceof Error && /Keychain/.test(error.message) && !error.message.includes(fixtureKey));
});
