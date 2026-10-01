import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);

test('Phase 3 egress image passes the 44-check external network regression and leaves no test resources', { skip: process.env.AW_DOCKER_TESTS !== '1', timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-phase3-egress-')), state = join(root, 'state.json');
  const harness = resolve('spikes/phase0/egress/harness.py');
  const run = async (args: string[], timeout = 30_000) => JSON.parse((await exec('python3', [harness, ...args], { timeout, maxBuffer: 1024 * 1024 })).stdout);
  let provisioned: { run_id: string } | undefined;
  try {
    // Production policy is unchanged; only the explicitly opted-in fixture changed.
    assert.deepEqual(await readFile('containers/egress/proxy.py'), await readFile('spikes/phase0/egress/proxy.py'));
    provisioned = await run(['up', '--image', 'agent-workspaces-egress:3', '--state', state, '--test-fixture']);
    const evidence = await run(['check', '--state', state, '--public'], 90_000);
    assert.equal(evidence.passed, true, JSON.stringify(evidence.checks.filter((check: { passed: boolean }) => !check.passed)));
    assert.equal(evidence.checks.length, 44);
    const cleanup = await run(['down', '--state', state]);
    assert.equal(cleanup.passed, true);
    const selector = `label=agent-workspaces.phase0-egress=${provisioned!.run_id}`;
    assert.equal((await exec('docker', ['container', 'ls', '-aq', '--filter', selector])).stdout.trim(), '');
    assert.equal((await exec('docker', ['network', 'ls', '-q', '--filter', selector])).stdout.trim(), '');
    provisioned = undefined;
    if (process.env.AW_RUNTIME_EVIDENCE === '1') {
      await mkdir('packages/browser-runtime/evidence', { recursive: true });
      await writeFile('packages/browser-runtime/evidence/egress.json', JSON.stringify({ ...evidence, phase: 3, cleanup: { containers: 0, networks: 0 } }, null, 2));
    }
  } finally {
    if (provisioned) await run(['down', '--state', state]);
    await rm(root, { recursive: true, force: true });
  }
});
