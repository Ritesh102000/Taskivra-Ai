import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Command } from '../../packages/contracts/index';
import { CommandValidationError, parseCommand } from '../../packages/contracts/validation';
import { APP_URL, isTrustedSender, type SenderIdentity } from '../../apps/desktop/main/security';

const agentId = 'agent_20c106cd-18d4-4c4a-8c1d-a33f94b1b3d9';
const taskId = 'task_f7d55028-6fc1-4f99-bf3f-34aeaf9bc2e0';
const requestId = 'request_867e158e-9349-4be0-802e-347f1b0421ba';

function rejected(raw: unknown): void {
  assert.throws(() => parseCommand(raw), (error: unknown) => {
    assert.ok(error instanceof CommandValidationError);
    assert.equal(error.code, 'invalid_command');
    return true;
  });
}

const validCommands: Command[] = [
  { type: 'snapshot' },
  { type: 'agents.create', name: 'Research', instructions: 'Ask for clarification when needed.' },
  { type: 'agents.create', name: 'Empty instructions', instructions: '' },
  { type: 'tasks.create', agentId, objective: 'Compare the inputs', completionCriteria: 'Explain the result', scenario: 'clarification' },
  { type: 'tasks.create', agentId, objective: 'Finish a simulated task', completionCriteria: '', scenario: 'complete' },
  { type: 'tasks.create', agentId, objective: 'Exercise failure', completionCriteria: '', scenario: 'failure' },
  { type: 'tasks.message', taskId, content: 'Use the previous checkpoint.' },
  { type: 'tasks.pause', taskId },
  { type: 'tasks.resume', taskId },
  { type: 'tasks.cancel', taskId },
  { type: 'requests.respond', requestId, revision: 1, response: 'Use the full period.' },
  { type: 'settings.update', settings: { theme: 'dark' } },
  { type: 'settings.update', settings: { driverEnabled: false, maxActiveAgents: 1 } },
  { type: 'settings.update', settings: { theme: 'system', driverEnabled: true, maxActiveAgents: 2 } },
  { type: 'simulation.step' },
];

test('only the finite owner-command contract parses', () => {
  for (const command of validCommands) assert.deepEqual(parseCommand(command), command);
  assert.deepEqual(parseCommand({ type: 'agents.create', name: '  Research  ', instructions: '  Carefully.  ' }), {
    type: 'agents.create', name: 'Research', instructions: 'Carefully.',
  });
});

test('arbitrary execution, I/O, worker RPC, and unsupported owner commands are rejected', () => {
  for (const type of [
    'exec', 'shell.exec', 'code.execute', 'files.read', 'files.write', 'files.import',
    'browser.evaluate', 'browser.cdp', 'worker.rpc', 'sql.query', 'dialog.showOpenDialog',
    'app.openExternal', 'tasks.setState', 'agents.delete', 'requests.fulfill',
    '__proto__', 'constructor', '', 'snapshot ',
  ]) rejected({ type });
});

test('every command rejects unknown top-level fields instead of ignoring them', () => {
  for (const command of validCommands) {
    for (const [field, value] of [
      ['path', '/Users/owner/private.txt'], ['cwd', '/'], ['command', 'touch /tmp/not-executed'],
      ['argv', ['sh', '-c', 'id']], ['sql', 'DROP TABLE tasks'], ['generation', 123],
      ['senderId', 7], ['isMainFrame', true], ['url', APP_URL], ['state', 'succeeded'],
    ] as const) rejected({ ...command, [field]: value });
  }
});

test('missing required fields, unknown discriminant types, and wrong primitive shapes reject', () => {
  for (const command of validCommands) {
    for (const field of Object.keys(command)) {
      const missing = { ...command } as Record<string, unknown>;
      delete missing[field];
      rejected(missing);
    }
  }
  for (const raw of [null, undefined, true, false, 1, 'snapshot', [], [{ type: 'snapshot' }], new Date(), new Map()]) rejected(raw);
  for (const type of [null, false, 1, {}, [], ['snapshot']]) rejected({ type });
  for (const value of [null, undefined, false, 1, {}, [], ['Research']]) {
    rejected({ type: 'agents.create', name: value, instructions: '' });
    rejected({ type: 'agents.create', name: 'Research', instructions: value });
    rejected({ type: 'tasks.message', taskId, content: value });
  }
});

test('opaque IDs reject host paths, traversal, URL authorities, whitespace, and objects', () => {
  const invalidIds = [
    '', '../private', '/Users/owner/file', '/etc/passwd', 'C:\\Users\\owner\\file',
    'file:///etc/passwd', 'app://desktop/index.html', 'http://localhost',
    'agent id', ' id', 'id ', 'id\0tail', 'a'.repeat(97), null, 0, true, {}, [],
  ];
  for (const value of invalidIds) {
    rejected({ type: 'tasks.create', agentId: value, objective: 'Task', completionCriteria: '', scenario: 'complete' });
    rejected({ type: 'tasks.message', taskId: value, content: 'Message' });
    for (const type of ['tasks.pause', 'tasks.resume', 'tasks.cancel']) rejected({ type, taskId: value });
    rejected({ type: 'requests.respond', requestId: value, revision: 1, response: 'Answer' });
  }
});

test('instruction text remains data even when it contains paths or shell syntax', () => {
  const content = 'Discuss /Users/owner/report.csv and the literal command $(touch /tmp/not-executed); do not execute it.';
  assert.deepEqual(parseCommand({ type: 'tasks.message', taskId, content }), { type: 'tasks.message', taskId, content });
});

test('text and total transport limits are enforced without silent truncation', () => {
  rejected({ type: 'agents.create', name: 'n'.repeat(81), instructions: '' });
  rejected({ type: 'agents.create', name: 'Research', instructions: 'x'.repeat(8001) });
  rejected({ type: 'tasks.create', agentId, objective: 'x'.repeat(4001), completionCriteria: '', scenario: 'complete' });
  rejected({ type: 'tasks.create', agentId, objective: 'Task', completionCriteria: 'x'.repeat(4001), scenario: 'complete' });
  rejected({ type: 'tasks.message', taskId, content: 'x'.repeat(8001) });
  rejected({ type: 'requests.respond', requestId, revision: 1, response: 'x'.repeat(8001) });
  rejected({ type: 'snapshot', extra: 'x'.repeat(32769) });
  for (const content of ['', '  \t\n', 'nul\0byte']) {
    rejected({ type: 'tasks.message', taskId, content });
    rejected({ type: 'requests.respond', requestId, revision: 1, response: content });
  }
  rejected({ type: 'agents.create', name: ' \n ', instructions: '' });
  rejected({ type: 'tasks.create', agentId, objective: ' \n ', completionCriteria: '', scenario: 'complete' });
  assert.equal((parseCommand({ type: 'tasks.message', taskId, content: 'x'.repeat(8000) }) as { content: string }).content.length, 8000);
});

test('request revisions are positive safe integers, not coercible values', () => {
  for (const revision of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', true, null, {}, []]) {
    rejected({ type: 'requests.respond', requestId, revision, response: 'Answer' });
  }
});

test('nested settings reject unknown fields, wrong types, unsupported values, and empty patches', () => {
  for (const settings of [null, [], 'dark', 1, {}, { theme: 'auto' }, { theme: ['dark'] },
    { driverEnabled: 1 }, { driverEnabled: 'false' }, { driverEnabled: null },
    { maxActiveAgents: 0 }, { maxActiveAgents: 3 }, { maxActiveAgents: 1.5 },
    { maxActiveAgents: NaN }, { maxActiveAgents: Infinity }, { maxActiveAgents: '2' },
    { dataRoot: '/Users/owner' }, { theme: 'light', dataRoot: '/tmp' },
    { theme: 'dark', containerSocket: '/var/run/docker.sock' }, { driverEnabled: true, modelApiKey: 'not-a-real-key' },
  ]) rejected({ type: 'settings.update', settings });
});

test('cyclic, inherited, and prototype-polluting command records reject', () => {
  const cyclic: Record<string, unknown> = { type: 'snapshot' };
  cyclic.self = cyclic;
  rejected(cyclic);
  const nested: Record<string, unknown> = { theme: 'dark' };
  nested.self = nested;
  rejected({ type: 'settings.update', settings: nested });
  rejected(Object.create({ type: 'snapshot' }));
  rejected(Object.assign(Object.create({ injected: true }), { type: 'snapshot' }));
  rejected({ type: 'settings.update', settings: Object.create({ theme: 'dark' }) });
  rejected(JSON.parse('{"type":"snapshot","__proto__":{"polluted":true}}'));
  rejected(JSON.parse('{"type":"settings.update","settings":{"theme":"dark","__proto__":{"polluted":true}}}'));
  rejected({ type: 'snapshot', constructor: { prototype: { polluted: true } } });
  rejected({ type: 'snapshot', extra: 1n });
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});

test('null-prototype records are treated as data and normalized into ordinary commands', () => {
  const command = Object.assign(Object.create(null), { type: 'snapshot' });
  assert.deepEqual(parseCommand(command), { type: 'snapshot' });
  const settings = Object.assign(Object.create(null), { theme: 'dark' });
  assert.deepEqual(parseCommand({ type: 'settings.update', settings }), { type: 'settings.update', settings: { theme: 'dark' } });
});

const trusted: SenderIdentity = { senderId: 7, trustedWebContentsId: 7, isMainFrame: true, url: APP_URL };

test('IPC sender requires the exact webContents, main frame, and document URL together', () => {
  assert.equal(APP_URL, 'app://desktop/index.html');
  assert.equal(isTrustedSender(trusted), true);
  assert.equal(isTrustedSender({ ...trusted, senderId: 8 }), false);
  assert.equal(isTrustedSender({ ...trusted, trustedWebContentsId: 8 }), false);
  assert.equal(isTrustedSender({ ...trusted, isMainFrame: false }), false);
  assert.equal(isTrustedSender({ ...trusted, senderId: 8, isMainFrame: false }), false);
  for (const url of [
    '', 'about:blank', 'file:///index.html', 'https://desktop/index.html', 'app://desktop/',
    'app://desktop/index.html?trusted=true', 'app://desktop/index.html#trusted',
    'app://desktop/index.html/extra', 'app://desktop/index.html.evil',
    'app://desktop.evil/index.html', 'app://desktop@evil/index.html',
    'app://evil@desktop/index.html', 'app://desktop:443/index.html',
    'APP://desktop/index.html', 'app://Desktop/index.html',
    'app://desktop/%69ndex.html', 'app://desktop/a/../index.html', `${APP_URL}\0`,
  ]) assert.equal(isTrustedSender({ ...trusted, url }), false, url);
});

test('sender metadata does not accept truthy frame flags or nonnumeric matching identities', () => {
  for (const isMainFrame of ['true', 1, {}, [], null, undefined]) {
    assert.equal(isTrustedSender({ ...trusted, isMainFrame } as unknown as SenderIdentity), false);
  }
  for (const id of ['7', null, undefined, 0, -1, 1.5, NaN, Infinity]) {
    assert.equal(isTrustedSender({ ...trusted, senderId: id, trustedWebContentsId: id } as unknown as SenderIdentity), false);
  }
});
