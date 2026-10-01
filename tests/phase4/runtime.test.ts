import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { DEFAULT_CODE_RESOURCES } from '../../packages/code/runtime';
import { codeCreateArgs, DockerCodeRuntimeFactory, validateLimits } from '../../packages/code-runtime';
import { header, PathIndex, receiveExport, safePath, sendSeed, validateSeedFiles } from '../../packages/code-runtime/protocol';
// @ts-expect-error Pure setup parser is JavaScript and never runs a build on import.
import { validateRecipe } from '../../packages/code-runtime/recipe.mjs';

const signal = new AbortController().signal;
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
function protocol(records: { path: string; data: Buffer; sha256?: string }[], end = true): Buffer {
  return Buffer.concat([...records.flatMap(r => [header({ type: 'file', path: r.path, size: r.data.length, sha256: r.sha256 || digest(r.data) }), r.data]), ...(end ? [header({ type: 'end', count: records.length, bytes: records.reduce((n, r) => n + r.data.length, 0) })] : [])]);
}
async function fixture(fn: (root: string, stage: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'aw-p4-unit-')), stage = join(root, 'stage'); await mkdir(stage);
  try { await fn(root, stage); } finally { await rm(root, { recursive: true, force: true }); }
}
test('runtime resource flags deny network, mounts, privilege and retain explicit distinct supervisor identity', () => {
  const args = codeCreateArgs({ name: 'owned', owner: 'x', run: 'y', image: 'sha256:test', limits: DEFAULT_CODE_RESOURCES, sharedBytes: 1234 });
  for (const value of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--cap-add=KILL', '--user=0:0', '--security-opt=no-new-privileges', '--memory=1024m', '--memory-swap=1024m', '--pids-limit=256', '--log-driver=none']) assert(args.includes(value));
  assert(!args.some(x => /(?:privileged|seccomp=unconfined|--volume|--mount|--pid=host|--network=host)/.test(x)));
  assert.throws(() => validateLimits({ ...DEFAULT_CODE_RESOURCES, memoryMiB: 2048 }));
  assert.throws(() => validateLimits({ ...DEFAULT_CODE_RESOURCES, timeoutSeconds: 121 }));
  assert.throws(() => validateLimits({ ...DEFAULT_CODE_RESOURCES, files: 0 }));
});
test('path and seed validation reject escapes, collisions and unbounded input manifests', () => {
  for (const path of ['/x', '../x', 'x//a', 'a\\b', 'a:b', 'x/./y', 'x\0y', 'a/'.repeat(30)]) assert.throws(() => safePath(path));
  for (const pair of [['a', 'a/b'], ['a/b', 'a'], ['Report', 'report'], ['é', 'e\u0301'], ['ß', 'SS']]) { const index = new PathIndex(); index.add(pair[0]); assert.throws(() => index.add(pair[1])); }
  assert.throws(() => validateSeedFiles([{ area: 'workspace', path: 'a', sourcePath: '/x', bytes: 2, sha256: '0'.repeat(64) }], 4, 1));
});
test('independent export parser verifies streaming checksums and exact bytes with immutable outputs', async () => fixture(async (root, stage) => {
  const data = Buffer.from('checked\n'), wire = protocol([{ path: 'results/a.txt', data }]);
  const chunks = Array.from({ length: Math.ceil(wire.length / 7) }, (_, index) => wire.subarray(index * 7, index * 7 + 7));
  const result = await receiveExport(Readable.from(chunks), stage, root, DEFAULT_CODE_RESOURCES, signal);
  assert.equal(result[0].sha256, digest(data)); assert.deepEqual(await readFile(result[0].sourcePath), data);
}));
for (const [name, bytes] of [
  ['traversal', protocol([{ path: '../external', data: Buffer.from('x') }])],
  ['hash mismatch', protocol([{ path: 'a', data: Buffer.from('x'), sha256: '0'.repeat(64) }])],
  ['truncation', protocol([{ path: 'a', data: Buffer.from('x') }], false)],
  ['trailing forged event', Buffer.concat([protocol([]), Buffer.from('{"published":true}')])],
  ['duplicate', protocol([{ path: 'a', data: Buffer.from('x') }, { path: 'A', data: Buffer.from('y') }])],
  ['special type', Buffer.concat([header({ type: 'symlink', path: 'a', target: '/x' })])],
  ['huge header', Buffer.from([0xff, 0xff, 0xff, 0xff])],
] as const) test(`export rejects ${name}`, async () => fixture(async (root, stage) => { await assert.rejects(receiveExport(Readable.from([bytes]), stage, root, DEFAULT_CODE_RESOURCES, signal)); }));
test('input sender detects changed source and rejects host symlink input', async () => fixture(async (root) => {
  const source = join(root, 'input'); await writeFile(source, 'old');
  const file = { area: 'workspace' as const, path: 'input', sourcePath: source, bytes: 3, sha256: digest(Buffer.from('old')) };
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  await writeFile(source, 'new'); await assert.rejects(sendSeed(sink, [file], root, signal));
  await symlink(source, join(root, 'link')); await assert.rejects(sendSeed(sink, [{ ...file, sourcePath: join(root, 'link') }], root, signal));
}));
test('dependency recipes require exact versions and hashes and reject shell or source injection', () => {
  assert.deepEqual(validateRecipe({ version: 1, python: [{ name: 'example', version: '1.0', sha256: '0'.repeat(64) }], pipApkVersion: '1.0-r0' }).python[0].name, 'example');
  for (const value of [
    { version: 1, node: [{ name: 'thing; sh', version: '1.0.0' }] },
    { version: 1, node: [{ name: 'thing', version: '^1.0.0' }] },
    { version: 1, python: [{ name: 'thing', version: '1.0', sha256: 'bad' }], pipApkVersion: '1-r0' },
    { version: 1, python: [{ name: 'thing', version: '1.0', sha256: '0'.repeat(64) }] },
    { version: 1, node: [{ name: 'thing', version: '1.0.0' }], command: 'host command' },
  ]) assert.throws(() => validateRecipe(value));
});
test('lost create reply fences admission and successful reconciliation restores the same factory', async () => fixture(async sourceRoot => {
  const root = await realpath(sourceRoot), fake = join(root, 'fake-docker');
  await writeFile(fake, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),root=__dirname,state=path.join(root,'fake-state'),attempt=path.join(root,'fake-attempt');
const image='sha256:'+'b'.repeat(64),id='a'.repeat(64);let data=fs.existsSync(state)?JSON.parse(fs.readFileSync(state,'utf8')):null;
if(a[0]==='version')console.log('test');
else if(a[0]==='image')console.log(JSON.stringify([{Id:image,Architecture:'arm64',Config:{Labels:{'io.agent-workspaces.code.protocol':'4','io.agent-workspaces.code.packages':'[]'}}}]));
else if(a[0]==='container'&&a[1]==='create'){
 const labels={};a.forEach((v,i)=>{if(v==='--label'){const t=a[i+1].split('=');labels[t[0]]=t[1]}});
 fs.writeFileSync(state,JSON.stringify({Id:id,Name:a[a.indexOf('--name')+1],Config:{Labels:labels},State:{Running:true}}));
 if(!fs.existsSync(attempt)){fs.writeFileSync(attempt,'1');process.exitCode=1}else console.log(id);
}else if(a[0]==='container'&&a[1]==='ls'){if(data)console.log(id)}
else if(a[0]==='container'&&a[1]==='inspect'){if(data)console.log(JSON.stringify([data]));else process.exitCode=1}
else if(a[0]==='container'&&a[1]==='rm'){const fail=path.join(root,'fake-cleanup-once');if(fs.existsSync(fail)){fs.unlinkSync(fail);process.exitCode=1}else if(data)fs.unlinkSync(state)}
else if(a[0]==='container'&&a[1]==='start')console.log(id);
else if(a[0]==='exec'){process.stdin.resume();process.stdin.on('end',()=>console.log('{"seeded":true}'))}
else process.exitCode=1;
`); await chmod(fake, 0o700);
  const runtime = new DockerCodeRuntimeFactory({ dataRoot: root, dockerPath: fake });
  const options = { executionId: 'recovery', agentId: 'agent', taskId: 'task', files: [], limits: DEFAULT_CODE_RESOURCES, signal };
  try {
    await writeFile(join(root, 'fake-cleanup-once'), '1');
    await assert.rejects(runtime.launch(options)); assert.equal((await runtime.status()).ready, false);
    await assert.rejects(runtime.launch(options), /recovery_required/);
    await runtime.reconcile(); assert.equal((await runtime.status()).ready, true);
    const handle = await runtime.launch(options); await handle.close();
    await rm(join(root, 'fake-attempt'));
    const interrupted = new DockerCodeRuntimeFactory({ dataRoot: root, dockerPath: fake });
    await assert.rejects(interrupted.launch(options)); await assert.rejects(interrupted.close(), /cleanup_incomplete/);
    await interrupted.reconcile(); await interrupted.close();
  } finally { await runtime.close(); }
}));
