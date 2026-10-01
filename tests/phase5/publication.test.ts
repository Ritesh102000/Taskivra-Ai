import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../../packages/coordinator';

test('pause after publication staging fences its final transaction and preserves the previous shared version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-publication-fence-')); let pause = false, taskId = '', fences = 0, reopened:Coordinator|undefined;
  const c = new Coordinator({ dataRoot: join(root, 'app'), artifactFault: point => { if (pause && point === 'after_stage') { pause = false; c.handle({ type: 'tasks.pause', taskId }); } } });
  try {
    await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
    const agent = c.handle({ type: 'agents.create', name: 'Publisher', instructions: '' }).agents[0];
    const task = c.handle({ type: 'tasks.create', agentId: agent.id, objective: 'Publish exact versions.', completionCriteria: '', scenario: 'complete' }).tasks[0]; taskId = task.id;
    const source = join(root, 'result.txt'); await writeFile(source, 'old verified result');
    const privateV1 = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId }, paths: [source] })).versionIds[0];
    const claim = c.claimNext()!;
    const sharedV1 = (await c.artifacts.publish({ principal: { kind: 'owner' }, versionId: privateV1, beforeCommit: () => { fences++; c.authorizeRun(claim); } })).versionIds[0];
    await writeFile(source, 'new result must not become shared');
    const artifactId = c.snapshot().artifacts.find(v => v.id === privateV1)!.artifactId;
    const privateV2 = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId: null }, paths: [source], artifactId })).versionIds[0];
    pause = true;
    await assert.rejects(c.artifacts.publish({ principal: { kind: 'owner' }, versionId: privateV2, beforeCommit: () => { fences++; c.authorizeRun(claim); } }));
    assert.equal(fences, 2); assert.equal(c.snapshot().tasks.find(t => t.id === taskId)!.state, 'pausing');
    assert.deepEqual(c.snapshot().artifacts.filter(v => v.visibility === 'shared').map(v => v.id), [sharedV1]);
    assert.equal((await c.artifacts.preview({ principal: { kind: 'owner' }, versionId: sharedV1 })).text, 'old verified result');
    assert.equal(c.snapshot().events.filter(e => e.type === 'artifact.published').length, 1);
    // Abandoned bytes remain journaled until startup reconciliation, with no shared metadata.
    await c.shutdown(); reopened = new Coordinator({dataRoot:join(root,'app')}); await reopened.live.ready;
    assert.deepEqual(await readdir(join(root, 'app', 'staging', 'artifacts')), []);
    assert.deepEqual(reopened.snapshot().artifacts.filter(v=>v.visibility==='shared').map(v=>v.id),[sharedV1]);
  } finally { await reopened?.shutdown(); await c.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('an async publication fence fails closed instead of committing outside its transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-publication-sync-')), c = new Coordinator({ dataRoot: join(root, 'app') });
  try {
    await c.live.ready; const agent = c.handle({ type: 'agents.create', name: 'Publisher', instructions: '' }).agents[0]; const source = join(root, 'file.txt'); await writeFile(source, 'private');
    const id = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId: null }, paths: [source] })).versionIds[0];
    await assert.rejects(c.artifacts.publish({ principal: { kind: 'owner' }, versionId: id, beforeCommit: async () => {throw new Error('asynchronous callback rejected');} })); assert.equal(c.snapshot().artifacts.filter(v => v.visibility === 'shared').length, 0);
    const released = await c.artifacts.reserveExternal('live-step-trace', 256 * 1024); assert.ok(released.directory.startsWith(c.dataRoot)); await released(); await released();
  } finally { await c.shutdown(); await rm(root, { recursive: true, force: true }); }
});
