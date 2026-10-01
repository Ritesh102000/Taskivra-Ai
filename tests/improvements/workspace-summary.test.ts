import assert from 'node:assert/strict';
import test from 'node:test';
import { completedResult, hasLiveProgress, summarizeWorkspace } from '../../apps/desktop/renderer/workspace-summary';
import { DEFAULT_LIVE_LIMITS, type ArtifactVersion, type InputRequest, type LiveState, type LiveTaskState, type Task } from '../../packages/contracts/index';

const task = (id: string, state: Task['state'], updatedAt = 1): Task => ({ id, state, updatedAt, executionMode: 'live', agentId: 'agent', objective: 'A task', completionCriteria: 'A checked result', revision: 1, waitingReason: null, scenario: 'complete', checkpoint: 0, generation: 0, createdAt: 1 });
const request = (id: string, taskId: string, state: InputRequest['state'] = 'open'): InputRequest => ({ id, taskId, state, agentId: 'agent', type: 'clarification', title: 'A decision', reason: 'More context', revision: 1, response: null, createdAt: 1 });
const run = (taskId: string, fields: Partial<LiveTaskState> = {}): LiveTaskState => ({ taskId, model: 'test-model', policy: { mode: 'workspace', allowedOrigins: [] }, limits: { ...DEFAULT_LIVE_LIMITS }, enabled: false, calls: 0, steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 0, activeSeconds: 0, lastError: null, resultVersionId: null, ...fields });
const live = (...tasks: LiveTaskState[]): LiveState => ({ tasks, credentialConfigured: false, models: [], defaultModel: '', busy: false });
const artifact = (producerTaskId: string, fields: Partial<ArtifactVersion> = {}): ArtifactVersion => ({ id: 'result', artifactId: 'artifact', version: 1, displayName: 'report.md', ownerAgentId: 'agent', producerTaskId, visibility: 'private', bytes: 100, sha256: 'a'.repeat(64), mime: 'text/markdown', format: 'md', createdAt: 1, status: 'ready', sourceVersionId: null, ...fields });

test('overview attention deduplicates requests and ignores closed or terminal-task requests', () => {
  const tasks = [task('working', 'running'), task('input', 'waiting'), task('dependency', 'waiting'), task('failed', 'failed'), task('done', 'succeeded'), task('stopped', 'cancelled')];
  const summary = summarizeWorkspace({ tasks }, [request('one', 'input'), request('one', 'input'), request('old', 'working', 'fulfilled'), request('stale-failed', 'failed'), request('stale-done', 'done'), request('stale-stopped', 'stopped')], null);
  assert.equal(summary.working, 1);
  assert.equal(summary.attention, 3); // one actionable request and two distinct problem tasks
  assert.deepEqual(summary.requests.map(item => item.id), ['one']);
  assert.deepEqual(summary.problems.map(item => item.id), ['dependency', 'failed']);
  assert.deepEqual(summary.results.map(item => item.id), ['done']);
});

test('drafts, interrupted work and failed tasks do not become completed results because a file exists', () => {
  const tasks = [task('draft', 'paused'), task('running', 'running'), task('failed', 'failed'), task('done', 'succeeded')];
  const state = live(...tasks.map(item => run(item.id, { resultVersionId: 'result' })));
  const summary = summarizeWorkspace({ tasks }, [], state);
  assert.deepEqual(summary.results.map(item => item.id), ['done']);
  for (const item of tasks.slice(0, 3)) assert.equal(completedResult(item, [artifact(item.id)], state), undefined);
  assert.equal(completedResult(tasks[3], [artifact('done')], state)?.id, 'result');
});

test('result shortcut requires the exact ready output from its completed task', () => {
  const done = task('done', 'succeeded'), state = live(run('done', { resultVersionId: 'result' }));
  assert.equal(completedResult(done, [artifact('another-task')], state), undefined);
  assert.equal(completedResult(done, [artifact('done', { status: 'missing' })], state), undefined);
  assert.equal(completedResult(done, [artifact('done', { status: 'corrupt' })], state), undefined);
  assert.equal(completedResult(done, [artifact('done', { id: 'old-version' })], state), undefined);
  assert.equal(completedResult(done, [artifact('done')], null), undefined);
  assert.equal(completedResult({ ...done, executionMode: 'simulation' }, [artifact('done')], state), undefined);
});

test('temporary live errors surface once while request cards remain the primary action', () => {
  const tasks = [task('running', 'running'), task('input', 'waiting'), task('cancelled', 'cancelled')];
  const state = live(...tasks.map(item => run(item.id, { lastError: 'Runtime unavailable' })));
  const summary = summarizeWorkspace({ tasks }, [request('input-request', 'input', 'needs_correction')], state);
  assert.equal(summary.attention, 2);
  assert.deepEqual(summary.problems.map(item => item.id), ['running']);
  assert.deepEqual(summary.active.map(item => item.id), ['running']);
});

test('overview handles an empty workspace and preserves saved task ordering', () => {
  assert.deepEqual(summarizeWorkspace({ tasks: [] }, [], null), { requests: [], active: [], problems: [], results: [], attention: 0, working: 0, isEmpty: true });
  const tasks = [task('older', 'succeeded', 1), task('newer', 'succeeded', 2)];
  const summary = summarizeWorkspace({ tasks }, [], null);
  assert.deepEqual(summary.results.map(item => item.id), ['newer', 'older']);
  assert.deepEqual(tasks.map(item => item.id), ['older', 'newer']);
});

test('saved task limits or a reserved budget are not evidence of previous execution', () => {
  assert.equal(hasLiveProgress(undefined), false);
  assert.equal(hasLiveProgress(run('draft', { reservedUsd: 1 })), false);
  assert.equal(hasLiveProgress(run('used', { calls: 1 })), true);
  assert.equal(hasLiveProgress(run('used', { steps: 1 })), true);
  assert.equal(hasLiveProgress(run('used', { activeSeconds: 0.1 })), true);
});
