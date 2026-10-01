import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactVersion } from '../../packages/contracts';
import { checkResultQuality, type QualityInput } from '../../packages/results/quality';
import { Coordinator } from '../../packages/coordinator';
import { DEFAULT_LIVE_LIMITS } from '../../packages/contracts/live';
import { DEFAULT_MODEL } from '../../packages/model-adapters/pricing';

function input(text = '# Findings\nObserved data.\n# Sources\nA source.\n# Limitations\nNo semantic verification.', options: Partial<QualityInput> = {}): QualityInput {
  const version: ArtifactVersion = { id: randomUUID(), artifactId: randomUUID(), version: 1, displayName: 'report.md', ownerAgentId: 'agent-fixture', producerTaskId: 'task-fixture', visibility: 'private', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), mime: 'text/markdown', format: 'markdown', createdAt: 1, status: 'ready', sourceVersionId: null };
  return { version, text, complete: true, completionCriteria: 'Required sections: Findings, Sources, Limitations', inputVersionIds: [], evidenceIds: ['receipt-known-1'], reportEvidenceIds: ['receipt-known-1'], now: 123, ...options };
}

test('quality is bound to exact source and labels structural success separately from factual accuracy', () => {
  const source = input(), quality = checkResultQuality(source);
  assert.equal(quality.status, 'pass'); assert.equal(quality.canFinish, true); assert.equal(quality.sourceVersionId, source.version.id); assert.equal(quality.sourceSha256, source.version.sha256); assert.equal(quality.checkedAt, 123);
  assert.equal(quality.coverage.checkedBytes, source.version.bytes); assert.match(quality.limitation, /do not certify factual accuracy/);
});
test('missing required headings, empty output, invalid JSON and forged references fail', () => {
  for (const source of [input('# Findings\nOnly one section'), input(' '), input('evidence:receipt-other-task'), input('x', { version: { ...input().version, format: 'json' }, requiredSections: [], completionCriteria: '' })]) assert.equal(checkResultQuality(source).canFinish, false);
  const forged = checkResultQuality(input(undefined, { reportEvidenceIds: ['receipt-other-task'] }));
  assert.equal(forged.checks.find(check => check.id === 'references')!.status, 'fail');
});
test('prose criteria and unsupported or partial content remain explicit warnings', () => {
  const prose = checkResultQuality(input('Perfect relevant and accurate report', { completionCriteria: 'Produce an accurate report.', requiredSections: [], reportEvidenceIds: [] }));
  assert.equal(prose.status, 'warn'); assert.equal(prose.canFinish, true); assert.match(prose.checks.find(check => check.id === 'criteria')!.message, /no automatic pass/);
  const partial = checkResultQuality(input('# Findings', { complete: false, requiredSections: ['Findings', 'Sources'] }));
  assert.equal(partial.status, 'warn'); assert.equal(partial.coverage.complete, false);
});
test('CSV validates all rows and flags malformed shape without evaluating formula cells', () => {
  const source = input('name,value\n=SUM(A1),00123\n', { completionCriteria: '', reportEvidenceIds: [] }); source.version.format = 'csv';
  const quality = checkResultQuality(source); assert.equal(quality.checks.find(check => check.id === 'csv')!.status, 'pass');
  for (const text of ['name,value\none\n', 'name,name\none,two\n', 'name,value\n"never closes,1']) { const bad = input(text); bad.version.format = 'csv'; assert.equal(checkResultQuality(bad).canFinish, false); }
});
test('valid CSV beyond row, column, cell or byte checker bounds remains an explicit coverage warning', () => {
  for (const text of ['heading\n' + 'value\n'.repeat(10001), Array.from({ length: 101 }, (_, i) => 'h' + i).join(',') + '\n', 'heading\n' + 'x'.repeat(32768), 'heading\n' + 'x\n'.repeat(524289)]) {
    const source = input(text, { completionCriteria: '', reportEvidenceIds: [] }); source.version.format = 'csv';
    const quality = checkResultQuality(source); assert.equal(quality.status, 'warn'); assert.equal(quality.canFinish, true); assert.equal(quality.coverage.complete, false);
    assert.match(quality.checks.find(check => check.id === 'csv')!.message, /checker limit, not proof/);
  }
});
test('source references are checked only against this task inputs and source receipts', () => {
  const accepted = input('# Findings\n[Source](artifact:input-version-1) evidence:receipt-known-1\n# Sources\nKnown.\n# Limitations\nReview.', { inputVersionIds: ['input-version-1'] });
  assert.equal(checkResultQuality(accepted).status, 'pass');
  accepted.inputVersionIds = []; assert.equal(checkResultQuality(accepted).status, 'fail');
});
test('prefinish service validates task ownership and exact managed output bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-quality-')), c = new Coordinator({ dataRoot: join(root, 'data') });
  try {
    await c.live.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
    const agent = c.handle({ type: 'agents.create', name: 'Quality fixture', instructions: '' }).agents[0];
    const taskId = c.createLiveTask({ type: 'live.createTask', agentId: agent.id, objective: 'Create a fixture report', completionCriteria: 'Required sections: Findings, Limitations', policy: { mode: 'workspace', allowedOrigins: [] }, model: DEFAULT_MODEL, limits: DEFAULT_LIVE_LIMITS });
    const path = join(root, 'report.md'); await writeFile(path, '# Findings\nThere are two rows.');
    const versionId = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId }, paths: [path] })).versionIds[0];
    await assert.rejects(c.results.checkQuality(taskId, versionId), /output produced/);
    const db = new DatabaseSync(c.databasePath); try { db.prepare("UPDATE task_artifacts SET role='output' WHERE task_id=? AND version_id=?").run(taskId, versionId); } finally { db.close(); }
    const quality = await c.results.checkQuality(taskId, versionId); assert.equal(quality.canFinish, false); assert.match(quality.checks.find(check => check.id === 'sections')!.message, /Limitations/);
    assert.equal(c.snapshot().tasks.find(task => task.id === taskId)!.state, 'paused');
    await assert.rejects(c.results.checkQuality(randomUUID(), versionId), /output produced/);
  } finally { await c.shutdown(); await rm(root, { recursive: true, force: true }); }
});
