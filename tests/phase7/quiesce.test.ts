import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../../packages/coordinator';

test('quiescence fences work, preserves requests and leaves tasks paused after an interrupted backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-quiescence-'));
  const c = new Coordinator({ dataRoot: root });
  try {
    await c.live.ready;
    const agent = c.handle({ type: 'agents.create', name: 'Fixture', instructions: '' }).agents[0];
    c.handle({ type: 'tasks.create', agentId: agent.id, objective: 'Save progress', completionCriteria: '', scenario: 'clarification' });
    c.handle({ type: 'simulation.step' }); c.handle({ type: 'simulation.step' }); c.handle({ type: 'simulation.step' });
    const request = c.snapshot().requests[0]; assert.ok(request);
    c.handle({ type: 'tasks.create', agentId: agent.id, objective: 'Queued work', completionCriteria: '', scenario: 'complete' });
    await assert.rejects(c.withQuiesced(async () => {
      assert.equal(c.maintenanceActive, true);
      assert.equal(c.claimNext(), null);
      assert.throws(() => c.handle({ type: 'settings.update', settings: { driverEnabled: true } }), /checkpoint/);
      await assert.rejects(c.withQuiesced(async () => {}), /already in progress/);
      c.tick();
      throw new Error('Simulated destination failure');
    }), /destination failure/);
    assert.equal(c.maintenanceActive, false);
    assert.equal(c.snapshot().requests.find(r => r.id === request.id)?.state, 'open');
    assert.equal(c.snapshot().tasks.find(t => t.objective === 'Queued work')?.state, 'paused');
    assert.equal(c.snapshot().settings.driverEnabled, false);
    c.tick(); assert.equal(c.snapshot().tasks.find(t => t.objective === 'Queued work')?.state, 'paused');
  } finally { await c.shutdown(); await rm(root, { recursive: true, force: true }); }
});
