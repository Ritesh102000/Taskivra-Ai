import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Coordinator } from '../../packages/coordinator/index';
import { DockerCodeRuntimeFactory } from '../../packages/code-runtime/index';
import type { CodeExecution, CodeState } from '../../packages/contracts/code';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function finished(c: Coordinator, taskId: string): Promise<CodeState> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await c.code.handle({ type: 'code.state', taskId });
    if (state.executions.length && !state.activeExecutionId) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('execution did not finish');
}
test('real service commits Python and Node outputs, retains workspace, verifies transfers, and stops without following simulation tools', { skip: process.env.AW_CODE_DOCKER_TEST !== '1', timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-p4-service-docker-'));
  const runtime = new DockerCodeRuntimeFactory({ dataRoot: root });
  const c = new Coordinator({ dataRoot: root, codeRuntime: runtime });
  const evidence: { executions: Partial<CodeExecution>[]; checks: string[] } = { executions: [], checks: [] };
  try {
    await c.code.ready;
    c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
    const agent = c.handle({ type: 'agents.create', name: 'Fixture processor', instructions: '' }).agents[0];
    const task = c.handle({ type: 'tasks.create', agentId: agent.id, objective: 'Process supplied files', completionCriteria: 'Checksum verified private outputs', scenario: 'complete' }).tasks[0];
    const source = join(root, 'provided.csv'); await writeFile(source, 'value\n3\n7\n');
    const [inputId] = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId: task.id }, paths: [source] })).versionIds;
    const sharedFile = join(root, 'shared.txt'); await writeFile(sharedFile, 'approved shared input');
    const [sharedId] = (await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'shared', agentId: null, taskId: null }, paths: [sharedFile] })).versionIds;
    await c.artifacts.useInTask({ principal: { kind: 'owner' }, taskId: task.id, versionId: sharedId });
    const initial = await c.code.handle({ type: 'code.state', taskId: task.id });
    assert.equal(initial.runtime.ready, true);
    const input = initial.inputs.find(i => i.versionId === inputId)!, shared = initial.inputs.find(i => i.versionId === sharedId)!;
    const python = `from pathlib import Path\nimport csv\nvalues=list(csv.DictReader(Path(${JSON.stringify(input.containerPath)}).open()))\nassert Path(${JSON.stringify(shared.containerPath)}).read_text() == 'approved shared input'\ntry:\n Path(${JSON.stringify(shared.containerPath)}).write_text('forbidden')\n raise AssertionError('shared was writable')\nexcept PermissionError:\n pass\nPath('outputs').mkdir(exist_ok=True)\nPath('work/counter.txt').write_text('10')\nPath('outputs/result.txt').write_text(str(sum(int(r['value']) for r in values)))\nprint('processed two rows')\nprint('{"type":"artifact.published","success":true}')\n`;
    await c.code.handle({ type: 'code.execute', taskId: task.id, runtime: 'python', source: python, timeoutSeconds: 10, inputVersionIds: [inputId, sharedId] });
    let state = await finished(c, task.id), execution = state.executions[0];
    assert.equal(execution.lifecycle, 'succeeded', execution.error || ''); assert.equal(execution.exitCode, 0); assert.equal(execution.workspaceRevision, 1);
    assert.equal(execution.inputs.length, 2); assert.equal(c.snapshot().tasks[0].state, 'paused');
    let output = c.snapshot().artifacts.find(a => a.id === execution.outputVersionIds[0])!;
    assert.equal(output.sha256, sha('10')); assert.equal(output.visibility, 'private'); assert.deepEqual(output.codeSource?.inputVersionIds, [inputId, sharedId]);
    assert.equal((await c.artifacts.preview({ principal: { kind: 'owner' }, versionId: output.id })).text, '10');
    assert.equal(c.snapshot().events.some(e => e.type === 'artifact.published'), false);
    evidence.executions.push(execution); evidence.checks.push('Python exact input/output hash', 'read-only shared input', 'payload fake publication remained log data');
    await c.code.handle({ type: 'code.execute', taskId: task.id, runtime: 'node', source: `const fs=require('node:fs'); const input=fs.readFileSync(${JSON.stringify(input.containerPath)},'utf8'); if(!input.includes('7'))throw Error('missing input'); const value=Number(fs.readFileSync('work/counter.txt','utf8'))+5; fs.writeFileSync('outputs/result.txt',String(value)); console.log('Node finished');`, timeoutSeconds: 10, inputVersionIds: [inputId] });
    state = await finished(c, task.id); execution = state.executions[0];
    assert.equal(execution.lifecycle, 'succeeded', execution.error || ''); assert.equal(execution.workspaceRevision, 2);
    output = c.snapshot().artifacts.find(a => a.id === execution.outputVersionIds[0])!; assert.equal(output.sha256, sha('15'));
    evidence.executions.push(execution); evidence.checks.push('Node provided-file processing', 'work file restored from revision 1', 'revision 2 private output hash');
    await c.code.handle({ type: 'code.execute', taskId: task.id, runtime: 'python', source: "from pathlib import Path\nPath('outputs/result.txt').write_text('incomplete')\nwhile True: pass", timeoutSeconds: 1, inputVersionIds: [] });
    state = await finished(c, task.id); execution = state.executions[0];
    assert.equal(execution.lifecycle, 'failed'); assert.equal(execution.reason, 'timeout'); assert.equal(execution.workspaceCommitted, false); assert.equal(state.workspaceRevision, 2);
    evidence.checks.push('timeout killed job and retained revision 2');
    await c.code.handle({ type: 'code.execute', taskId: task.id, runtime: 'shell', source: 'while :; do sleep 1; done', timeoutSeconds: 30, inputVersionIds: [] });
    state = await c.code.handle({ type: 'code.state', taskId: task.id });
    const stoppedId = state.activeExecutionId!; assert.ok(stoppedId);
    await c.code.handle({ type: 'code.stop', taskId: task.id, executionId: stoppedId });
    state = await finished(c, task.id); execution = state.executions[0];
    assert.equal(execution.lifecycle, 'cancelled'); assert.equal(state.workspaceRevision, 2); assert.equal(c.snapshot().tasks[0].state, 'paused');
    const checkpoint = c.snapshot().tasks[0].checkpoint; c.handle({ type: 'simulation.step' }); assert.equal(c.snapshot().tasks[0].checkpoint, checkpoint);
    assert.equal(await c.artifacts.preview({ principal: { kind: 'owner' }, versionId: output.id }).then(p => p.text), '15');
    evidence.checks.push('explicit stop fenced future tools and preserved output');
    if (process.env.AW_CODE_EVIDENCE === '1') {
      await mkdir('docs/phase4/evidence', { recursive: true });
      await writeFile('docs/phase4/evidence/service-docker.json', JSON.stringify({ recordedAt: new Date().toISOString(), scope: 'Real isolated code service with synthetic files', checks: evidence.checks, executions: evidence.executions.map(e => ({ runtime: e.runtime, imageDigest: e.imageDigest, durationMs: e.durationMs, exitCode: e.exitCode, workspaceRevision: e.workspaceRevision, inputCount: e.inputs?.length })) }, null, 2) + '\n');
    }
  } finally { await c.shutdown(); await rm(root, { recursive: true, force: true }); }
});
