import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodeCommand } from '../../packages/contracts/code-validation';
import { CODE_LIMITS } from '../../packages/contracts/code';

const execution = { type: 'code.execute', taskId: 'task-a', runtime: 'python', source: "print('fixture')", timeoutSeconds: 30, inputVersionIds: ['version-a'] };
test('code IPC accepts script data without exposing host commands, images, mounts, environment or actor selection', () => {
  assert.deepEqual(parseCodeCommand(execution), execution);
  for (const [key, value] of Object.entries({ argv: ['/bin/sh'], cwd: '/Users/owner', actor: 'agent', runId: 'forged', agentId: 'other', sourcePath: '/etc/passwd', image: 'unreviewed', mounts: ['/'], env: { OPENAI_API_KEY: 'fictional' }, network: 'host', privileged: true })) assert.throws(() => parseCodeCommand({ ...execution, [key]: value }));
  const source = "print('$(touch /tmp/never-executed-on-host) `whoami`')";
  assert.equal((parseCodeCommand({ ...execution, source }) as typeof execution).source, source);
});
test('execution limits reject oversized UTF-8 scripts, invalid timeouts and duplicate or fabricated inputs', () => {
  for (const timeoutSeconds of [0, 121, 1.1, '30', NaN, Infinity]) assert.throws(() => parseCodeCommand({ ...execution, timeoutSeconds }));
  for (const source of ['', ' ', '\0', '😀'.repeat(CODE_LIMITS.sourceBytes / 4 + 1)]) assert.throws(() => parseCodeCommand({ ...execution, source }));
  for (const inputVersionIds of [['version-a', 'version-a'], ['/etc/passwd'], ['../private'], Array.from({ length: 129 }, (_, i) => `id-${i}`), 'all']) assert.throws(() => parseCodeCommand({ ...execution, inputVersionIds }));
});
test('malformed, cyclic and inherited execution envelopes cannot bypass typed commands', () => {
  const cyclic: Record<string, unknown> = { ...execution }; cyclic.loop = cyclic;
  for (const raw of [null, [], cyclic, Object.create(execution), { ...execution, type: 'code.evalHost' }, { type: 'code.stop', taskId: 'task-a', executionId: '/containers/all' }]) assert.throws(() => parseCodeCommand(raw));
  assert.deepEqual(parseCodeCommand(Object.assign(Object.create(null), execution)), execution);
});
test('dependency requests only carry registry names and exact versions, never installation commands or URLs', () => {
  const dependency = { type: 'code.requestDependency', taskId: 'task-a', runtime: 'node', packageName: '@example/package', version: '1.2.3', reason: 'Fixture requires a parser' };
  assert.deepEqual(parseCodeCommand(dependency), dependency);
  for (const packageName of ['https://example.test/code.tgz', '/tmp/pkg', '../pkg', 'x; echo broken', 'git+ssh://host/repo']) assert.throws(() => parseCodeCommand({ ...dependency, packageName }));
  for (const version of ['latest', '*', '^1.2.3', '>=1', '1.0;command', '../1.0']) assert.throws(() => parseCodeCommand({ ...dependency, version }));
  assert.throws(() => parseCodeCommand({ ...dependency, install: true }));
  assert.throws(() => parseCodeCommand({ type: 'code.resolveDependency', taskId: 'task-a', requestId: 'req-a', revision: 0 }));
});
