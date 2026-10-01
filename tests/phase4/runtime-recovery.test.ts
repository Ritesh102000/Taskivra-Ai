import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCodeRuntimeFactory } from '../../packages/code-runtime';
import { DEFAULT_CODE_RESOURCES } from '../../packages/code/runtime';
const execute = promisify(execFile);
const limits = { ...DEFAULT_CODE_RESOURCES, memoryMiB: 256, workspaceMiB: 8, tmpMiB: 4, exportBytes: 8 * 1024 * 1024, pids: 64, timeoutSeconds: 3 };
test('actual coordinator SIGKILL leaves supervisor alive and startup reconciles immutable owned container', { skip: process.env.AW_CODE_DOCKER_TEST !== '1', timeout: 30000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-p4-crash-'))), runtime = new DockerCodeRuntimeFactory({ dataRoot: root });
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/phase4/runtime-crash-helper.ts', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { if (output.length < 4096) output += data; }); child.stderr.on('data', data => { if (output.length < 4096) output += data; });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  let info: { containerId: string; imageDigest: string } | undefined;
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { info = JSON.parse(await readFile(join(root, 'running.json'), 'utf8')).info; break; } catch {}
      if (child.exitCode !== null) throw new Error('crash helper failed: ' + output);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert(info, output || 'helper did not launch');
    child.kill('SIGKILL'); await exited;
    assert.equal(JSON.parse((await execute('docker', ['inspect', info.containerId])).stdout)[0].State.Running, true);
    await runtime.reconcile();
    await assert.rejects(execute('docker', ['inspect', info.containerId]));
    assert.equal((await readdir(join(root, 'control/code-runtime'))).filter(n => n.endsWith('.json')).length, 0);
    await mkdir('packages/code-runtime/evidence', { recursive: true });
    await writeFile('packages/code-runtime/evidence/process-crash.json', JSON.stringify({ verifiedAt: new Date().toISOString(), imageDigest: info.imageDigest, parentSignal: 'SIGKILL', supervisorSurvivedParent: true, exactOwnedContainerRemovedByStartup: true }, null, 2) + '\n');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await runtime.reconcile(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
test('live second factory does not steal active resources; missing destination export fails without unhandled stream errors', { skip: process.env.AW_CODE_DOCKER_TEST !== '1', timeout: 30000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-p4-live-'))), first = new DockerCodeRuntimeFactory({ dataRoot: root }), second = new DockerCodeRuntimeFactory({ dataRoot: root });
  try {
    const handle = await first.launch({ executionId: 'live', taskId: 'task', agentId: 'agent', files: [], signal: new AbortController().signal, limits });
    await second.reconcile(); assert.equal(JSON.parse((await execute('docker', ['inspect', handle.info.containerId])).stdout)[0].State.Running, true);
    assert.equal((await handle.run({ argv: ['python3', '-I', '-c', "print('finished')"], cwd: '/workspace', signal: new AbortController().signal, onLog() {} })).exitCode, 0);
    await assert.rejects(handle.export({ destination: join(root, 'missing'), signal: new AbortController().signal })); await handle.close();
  } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
});
