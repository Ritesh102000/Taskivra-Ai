import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCodeRuntimeFactory } from '../../packages/code-runtime';
import { DEFAULT_CODE_RESOURCES } from '../../packages/code/runtime';
test('quiesced trusted export reads payload-owned 0600 files and 0700 directories without DAC capability', { skip: process.env.AW_CODE_DOCKER_TEST !== '1', timeout: 15000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-p4-permissions-'))), runtime = new DockerCodeRuntimeFactory({ dataRoot: root });
  try {
    const handle = await runtime.launch({ executionId: 'private-mode', taskId: 'task', agentId: 'agent', files: [], signal: new AbortController().signal, limits: { ...DEFAULT_CODE_RESOURCES, memoryMiB: 256, workspaceMiB: 8, tmpMiB: 4, exportBytes: 8 * 1024 * 1024, timeoutSeconds: 3, pids: 64 } });
    try {
      assert.equal((await handle.run({ argv: ['python3', '-I', '-c', "import os;from pathlib import Path;os.umask(0o077);Path('outputs/private').mkdir();Path('outputs/private/result.txt').write_text('private-mode-content')"], cwd: '/workspace', signal: new AbortController().signal, onLog() {} })).exitCode, 0);
      const destination = join(root, 'stage'); await mkdir(destination); const manifest = await handle.export({ destination, signal: new AbortController().signal });
      assert.equal(manifest.length, 1); assert.equal(await readFile(manifest[0].sourcePath, 'utf8'), 'private-mode-content');
    } finally { await handle.close(); }
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
