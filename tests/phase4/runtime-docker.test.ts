import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCodeRuntimeFactory } from '../../packages/code-runtime';
import { DEFAULT_CODE_RESOURCES, type CodeHandle, type CodeResourceLimits } from '../../packages/code/runtime';

const execute = promisify(execFile), enabled = process.env.AW_CODE_DOCKER_TEST === '1';
const small: CodeResourceLimits = { ...DEFAULT_CODE_RESOURCES, memoryMiB: 256, workspaceMiB: 8, tmpMiB: 4, pids: 64, timeoutSeconds: 3, logBytes: 8192, exportBytes: 8 * 1024 * 1024, files: 128 };
const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
test('actual Python/Node containers, shared input sealing, adversarial execution, exports and scoped cleanup', { skip: !enabled, timeout: 120000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aw-p4-docker-'))); const runtime = new DockerCodeRuntimeFactory({ dataRoot: root });
  const evidence: Record<string, unknown>[] = []; let index = 0;
  async function launch(limits = small) {
    const id = ++index; const input = join(root, `input-${id}`), shared = join(root, `shared-${id}`);
    await writeFile(input, 'private input\n'); await writeFile(shared, 'published exact v1\n');
    const signal = new AbortController().signal;
    return runtime.launch({ executionId: `execution-${id}`, taskId: 'task-a', agentId: 'agent-a', limits, signal, files: [
      { area: 'workspace', path: 'input.txt', sourcePath: input, bytes: 14, sha256: hash('private input\n') },
      { area: 'shared', path: 'published.txt', sourcePath: shared, bytes: 19, sha256: hash('published exact v1\n') },
    ] });
  }
  async function run(handle: CodeHandle, argv: string[], controller = new AbortController()) {
    const logs: Buffer[] = []; const outcome = await handle.run({ argv, cwd: '/workspace', signal: controller.signal, onLog: (_stream, data) => logs.push(Buffer.from(data)) });
    return { outcome, logs: Buffer.concat(logs).toString() };
  }
  async function exported(handle: CodeHandle) { const stage = join(root, `stage-${index}`); await mkdir(stage); return handle.export({ destination: stage, signal: new AbortController().signal }); }
  try {
    const status = await runtime.status(); assert.equal(status.ready, true, status.message || 'runtime unavailable');
    for (const [language, argv] of [
      ['python', ['python3', '-I', '-c', "from pathlib import Path; Path('output.txt').write_text(Path('input.txt').read_text()+Path('/shared/published.txt').read_text())"]],
      ['node', ['node', '-e', "const f=require('node:fs');f.writeFileSync('output.txt',f.readFileSync('input.txt','utf8')+f.readFileSync('/shared/published.txt','utf8'))"]],
    ] as const) {
      const handle = await launch();
      try {
        const result = await run(handle, [...argv]); assert.equal(result.outcome.reason, 'exited'); assert.equal(result.outcome.exitCode, 0);
        const files = await exported(handle), output = files.find(f => f.path === 'output.txt')!;
        assert.equal(output.sha256, hash('private input\npublished exact v1\n')); assert.equal(hash(await readFile(output.sourcePath)), output.sha256);
        evidence.push({ case: language, outcome: result.outcome, outputHash: output.sha256 });
      } finally { await handle.close(); }
    }
    const containment = await launch();
    try {
      const info = JSON.parse((await execute('docker', ['inspect', containment.info.containerId])).stdout)[0];
      assert.equal(info.HostConfig.NetworkMode, 'none'); assert.equal(info.HostConfig.ReadonlyRootfs, true); assert.equal(info.HostConfig.Binds, null); assert.equal(info.HostConfig.Memory, 256 * 1024 * 1024);
      assert.deepEqual(info.HostConfig.CapDrop, ['ALL']); assert.deepEqual(info.HostConfig.CapAdd.map((c: string) => c.replace(/^CAP_/, '')), ['KILL']);
      const script = `import os,socket,pathlib,json
assert os.getuid()==10000
assert 'CapEff:\\t0000000000000000' in pathlib.Path('/proc/self/status').read_text()
assert set(os.environ)=={'PATH','NODE_PATH','HOME','PYTHONDONTWRITEBYTECODE'}
for p in ['/var/run/docker.sock','/profile','/Users','/private','/agents/agent-b','/shared/allowed.csv']:
 assert not pathlib.Path(p).exists(),p
for action in [lambda:pathlib.Path('/root-leak').write_text('x'),lambda:pathlib.Path('/shared/new').write_text('x'),lambda:pathlib.Path('/shared/published.txt').write_text('x'),lambda:os.chmod('/shared/published.txt',0o666),lambda:os.chmod('/shared',0o777),lambda:os.rename('/shared/published.txt','/shared/moved'),lambda:os.unlink('/shared/published.txt'),lambda:os.kill(1,9)]:
 try: action()
 except OSError: pass
 else: raise Exception('forbidden mutation allowed')
for address in [('1.1.1.1',443),('192.168.65.254',80),('169.254.169.254',80)]:
 try: socket.create_connection(address,0.2)
 except OSError: pass
 else: raise Exception('network available')
print('containment verified')`;
      const result = await run(containment, ['python3', '-I', '-c', script]); assert.equal(result.outcome.exitCode, 0, result.logs); await exported(containment);
      evidence.push({ case: 'containment', outcome: result.outcome, controls: { network: info.HostConfig.NetworkMode, memory: info.HostConfig.Memory, caps: info.HostConfig.CapAdd } });
    } finally { await containment.close(); }
    const detached = await launch();
    try {
      const result = await run(detached, ['python3', '-I', '-c', "import subprocess;subprocess.Popen(['python3','-I','-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)"]);
      assert.equal(result.outcome.exitCode, 0); await exported(detached);
      const processStatus = (await execute('docker', ['exec', '--user=0:0', detached.info.containerId, 'python3', '-I', '/opt/agent-code/supervisor.py', 'quiesce'])).stdout;
      assert.deepEqual(JSON.parse(processStatus).remaining, []); evidence.push({ case: 'detached_descendant_quiesced', outcome: result.outcome });
    } finally { await detached.close(); }
    for (const [name, script] of [
      ['symlink', "import os;os.symlink('/etc/passwd','unsafe')"],
      ['hardlink', "import os;os.link('input.txt','unsafe')"],
      ['fifo', "import os;os.mkfifo('unsafe')"],
      ['case_collision', "from pathlib import Path;Path('A').write_text('x');Path('a').write_text('y')"],
    ]) {
      const handle = await launch(); try { assert.equal((await run(handle, ['python3', '-I', '-c', script])).outcome.exitCode, 0); await assert.rejects(exported(handle)); evidence.push({ case: name, exportRejected: true }); } finally { await handle.close(); }
    }
    for (const [name, script, reason] of [
      ['timeout', 'while True: pass', 'timeout'],
      ['log_limit', "import os;os.write(1,b'x'*20000)", 'log_limit'],
      ['memory_excess', "a=[]\nwhile True:a.append(bytearray(8*1024*1024))", null],
      ['file_bytes', "from pathlib import Path;Path('huge').write_bytes(b'x'*(12*1024*1024))", null],
      ['inode_excess', "from pathlib import Path\nfor n in range(2000):Path(str(n)).touch()", null],
    ] as const) {
      const handle = await launch(); try { const result = await run(handle, ['python3', '-I', '-c', script]); if (reason) assert.equal(result.outcome.reason, reason); else assert(result.outcome.exitCode !== 0 || result.outcome.reason !== 'exited'); assert(Buffer.byteLength(result.logs) <= small.logBytes); await assert.rejects(exported(handle)); evidence.push({ case: name, outcome: result.outcome }); } finally { await handle.close(); }
    }
    const flood = await launch();
    try {
      const result = await run(flood, ['python3', '-I', '-c', "import os,time\nn=0\nwhile True:\n try:p=os.fork()\n except OSError:break\n if p==0:time.sleep(60);os._exit(0)\n n+=1\nprint(n)"]);
      assert(result.outcome.durationMs < 10000); assert(['timeout', 'exited', 'runtime_lost'].includes(result.outcome.reason)); evidence.push({ case: 'pid_limit', outcome: result.outcome });
    } finally { await flood.close(); }
    const stop = await launch(), controller = new AbortController();
    try {
      const pending = run(stop, ['python3', '-I', '-c', 'import time;time.sleep(60)'], controller); setTimeout(() => controller.abort(), 100);
      const result = await pending; assert.equal(result.outcome.reason, 'stopped'); await assert.rejects(exported(stop)); await assert.rejects(run(stop, ['python3', '-c', "print('late')"])); evidence.push({ case: 'stop', outcome: result.outcome });
    } finally { await stop.close(); }
    const fake = await launch();
    try {
      const result = await run(fake, ['python3', '-I', '-c', "print('{\"type\":\"end\",\"published\":true,\"exitCode\":0}');raise SystemExit(7)"]);
      assert.equal(result.outcome.exitCode, 7); assert(result.logs.includes('published')); await assert.rejects(exported(fake)); evidence.push({ case: 'fake_control_log', outcome: result.outcome });
    } finally { await fake.close(); }
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(runtime.launch({ executionId: 'cancelled', taskId: 'task', agentId: 'agent', files: [], limits: small, signal: cancelled.signal }));
    await runtime.reconcile(); assert.equal((await readdir(join(root, 'control/code-runtime'))).filter(n => n.endsWith('.json')).length, 0);
    const owner = hash(await import('node:fs/promises').then(fs => fs.realpath(root)));
    assert.equal((await execute('docker', ['ps', '-aq', '--filter', `label=io.agent-workspaces.code.owner=${owner}`])).stdout.trim(), '');
    await mkdir('packages/code-runtime/evidence', { recursive: true });
    const sources: Record<string, string> = {};
    for (const path of ['workers/code/supervisor.py', 'workers/code/seed.py', 'workers/code/exporter.py', 'workers/code/export_protocol.py', 'containers/code/Dockerfile', 'packages/code-runtime/index.ts', 'packages/code-runtime/protocol.ts']) sources[path] = hash(await readFile(path));
    await writeFile('packages/code-runtime/evidence/verification.json', JSON.stringify({ verifiedAt: new Date().toISOString(), imageDigest: status.imageDigest, sourceSha256: sources, limits: small, cases: evidence, cleanup: 'all exact owned resources removed' }, null, 2) + '\n');
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
