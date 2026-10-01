import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCodeRuntimeFactory } from '../../packages/code-runtime';
import { DEFAULT_CODE_RESOURCES } from '../../packages/code/runtime';
const execute = promisify(execFile);
const enabled = process.env.AW_CODE_DOCKER_TEST === '1';
const limits = { ...DEFAULT_CODE_RESOURCES, memoryMiB: 512, workspaceMiB: 96, tmpMiB: 8, exportBytes: 96 * 1024 * 1024, pids: 64, timeoutSeconds: 10 };
test('actual streamed export exceeds old 64 MiB spike bound and cancellation during export never returns a manifest', { skip: !enabled, timeout: 45000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-p4-stream-'))), runtime = new DockerCodeRuntimeFactory({ dataRoot: root });
  try {
    for (const cancel of [false, true]) {
      const handle = await runtime.launch({ executionId: `export-${cancel}`, taskId: 'task', agentId: 'agent', files: [], signal: new AbortController().signal, limits });
      try {
        const result = await handle.run({ argv: ['python3', '-I', '-c', "from pathlib import Path\nwith Path('outputs/bounded.bin').open('wb') as f:\n for i in range(72):f.write(b'x'*(1024*1024))"], cwd: '/workspace', signal: new AbortController().signal, onLog() {} });
        assert.equal(result.exitCode, 0);
        const destination = join(root, `stage-${cancel}`); await mkdir(destination);
        const abort = new AbortController(); const pending = handle.export({ destination, signal: abort.signal });
        if (cancel) {
          const reject = assert.rejects(pending);
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            try { if ((await readdir(join(destination, 'outputs'))).includes('bounded.bin')) break; } catch {}
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          abort.abort(); await reject; await assert.rejects(handle.export({ destination, signal: new AbortController().signal }));
        } else {
          const files = await pending; assert.equal(files.length, 1); assert.equal(files[0].bytes, 72 * 1024 * 1024); assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
        }
      } finally { await handle.close(); }
    }
    await mkdir('packages/code-runtime/evidence', { recursive: true });
    await writeFile('packages/code-runtime/evidence/stream-boundaries.json', JSON.stringify({ verifiedAt: new Date().toISOString(), imageDigest: (await runtime.status()).imageDigest, verifiedExportBytes: 72 * 1024 * 1024, cancelledAfterFirstOutputCreated: true, cancelledExportReturnedManifest: false, limits }, null, 2) + '\n');
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
test('AbortSignal during actual launch removes only its journaled container', { skip: !enabled, timeout: 30000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-p4-launch-stop-'))), runtime = new DockerCodeRuntimeFactory({ dataRoot: root });
  const abort = new AbortController();
  try {
    await runtime.status();
    const pending = runtime.launch({ executionId: 'launch-stop', taskId: 'task', agentId: 'agent', files: [], signal: abort.signal, limits });
    const result = pending.then(handle => ({ handle }), error => ({ error }));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !(await readdir(join(root, 'control/code-runtime'))).some(name => name.endsWith('.json'))) await new Promise(resolve => setTimeout(resolve, 1));
    abort.abort(); const completed = await result;
    if ('handle' in completed) await completed.handle.close(); else assert(completed.error instanceof Error);
    await runtime.reconcile(); assert.equal((await readdir(join(root, 'control/code-runtime'))).filter(name => name.endsWith('.json')).length, 0);
    const owner = await import('node:crypto').then(crypto => crypto.createHash('sha256').update(root).digest('hex'));
    assert.equal((await execute('docker', ['ps', '-aq', '--filter', `label=io.agent-workspaces.code.owner=${owner}`])).stdout.trim(), '');
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
