import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCodeRuntimeFactory } from '../../packages/code-runtime';
import { DEFAULT_CODE_RESOURCES } from '../../packages/code/runtime';
const execute = promisify(execFile);
test('explicit hashed Python and locked Node builds work offline at execution; bad hash retains prior image', { skip: process.env.AW_CODE_DEPENDENCY_TEST !== '1', timeout: 180000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-p4-dependency-'))), tag = 'agent-workspaces-code:4-dependency-test';
  const runtime = new DockerCodeRuntimeFactory({ dataRoot: root, image: tag }); let built: string | undefined;
  const baseBefore = (await execute('docker', ['image', 'inspect', 'agent-workspaces-code:4', '--format', '{{.Id}}'])).stdout.trim();
  try {
    const recipe = JSON.parse(await readFile('containers/code/dependency-example.json', 'utf8'));
    recipe.node = [{ name: 'is-number', version: '7.0.0' }];
    const packageJson = { name: 'aw-phase4-build-verification', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } };
    await writeFile(join(root, 'recipe.json'), JSON.stringify(recipe));
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson));
    // Official registry metadata, read 2026-09-11; no host package installer runs.
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: packageJson.name, version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
      '': packageJson,
      'node_modules/is-number': { version: '7.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz', integrity: 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==' },
    } }));
    const args = ['packages/code-runtime/setup.mjs', '--build', '--recipe', join(root, 'recipe.json'), '--allow-network', '--tag', tag];
    await execute(process.execPath, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const status = await runtime.status(); assert.equal(status.ready, true); assert.deepEqual(status.packages, [{ runtime: 'python', name: 'six', version: '1.17.0' }, { runtime: 'node', name: 'is-number', version: '7.0.0' }]); built = status.imageDigest!;
    for (const argv of [['python3', '-I', '-c', "import six;assert six.__version__=='1.17.0';print('six verified')"], ['node', '-e', "if(!require('is-number')('42'))throw Error('dependency failed');console.log('is-number verified')"]]) {
      const handle = await runtime.launch({ executionId: argv[0], taskId: 'dependency-task', agentId: 'dependency-agent', files: [], signal: new AbortController().signal, limits: { ...DEFAULT_CODE_RESOURCES, memoryMiB: 256, workspaceMiB: 8, tmpMiB: 4, exportBytes: 8 * 1024 * 1024, timeoutSeconds: 5, pids: 64 } });
      try {
        const info = JSON.parse((await execute('docker', ['inspect', handle.info.containerId])).stdout)[0]; assert.equal(info.HostConfig.NetworkMode, 'none');
        let log = ''; const outcome = await handle.run({ argv, cwd: '/workspace', signal: new AbortController().signal, onLog: (_stream, bytes) => { log += Buffer.from(bytes).toString(); } }); assert.equal(outcome.exitCode, 0, log);
      } finally { await handle.close(); }
    }
    recipe.python[0].sha256 = '0'.repeat(64); await writeFile(join(root, 'recipe.json'), JSON.stringify(recipe));
    await assert.rejects(execute(process.execPath, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
    assert.equal((await runtime.status()).imageDigest, built);
    assert.equal((await execute('docker', ['image', 'inspect', 'agent-workspaces-code:4', '--format', '{{.Id}}'])).stdout.trim(), baseBefore);
    await mkdir('packages/code-runtime/evidence', { recursive: true });
    await writeFile('packages/code-runtime/evidence/dependencies.json', JSON.stringify({ verifiedAt: new Date().toISOString(), testedImage: built, defaultImageUnchanged: baseBefore, packages: status.packages, packageExecutionNetwork: 'none', badHashRejected: true, previousRecipeImagePreserved: true, hostPackageInstalls: false }, null, 2) + '\n');
  } finally {
    await runtime.close();
    if (built && (await execute('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']).catch(() => ({ stdout: '' }))).stdout.trim() === built) await execute('docker', ['image', 'rm', tag]);
    await rm(root, { recursive: true, force: true });
  }
});
