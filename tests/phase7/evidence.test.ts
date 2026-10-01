import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EvidenceArchive, isSourceReceipt, REPORT_CONTENT_BYTES, CODE_SOURCE_BYTES } from '../../packages/agent-loop/evidence';
import { toolsForPolicy } from '../../packages/agent-loop/tools';
import { MODEL_LIMITS } from '../../packages/model-adapters/openai';
import type { Persistence } from '../../packages/persistence';

test('older evidence pages are durable, scoped to the task and exclude failed or login-only receipts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE live_tool_receipts(id TEXT,task_id TEXT,state TEXT,tool_name TEXT,result_json TEXT,created_at INTEGER)');
    const insert = db.prepare('INSERT INTO live_tool_receipts VALUES (?,?,?,?,?,?)');
    for (let n = 0; n < 30; n++) insert.run(`source-${n}`, 'mine', 'succeeded', 'browser_observe', JSON.stringify({ text: `Source ${n}` }), n);
    insert.run('other-private', 'other', 'succeeded', 'read_file', JSON.stringify({ text: 'PRIVATE CANARY' }), 31);
    insert.run('failed', 'mine', 'failed', 'read_file', '{}', 32);
    insert.run('login', 'mine', 'succeeded', 'browser_open', '{"loginOrRedirect":true}', 33);
    insert.run('coordination', 'mine', 'succeeded', 'send_agent_message', '{}', 34);
    const archive = new EvidenceArchive({ db } as Persistence);
    const first = archive.list('mine', null), second = archive.list('mine', first.nextCursor);
    assert.equal(first.items.length, 23);
    assert.equal(second.items.length, 7);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(x => x.evidenceId)).size, 30);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE CANARY|other-private|failed|coordination|"login"/);
    assert.deepEqual(archive.read('mine', 'source-0').result, { text: 'Source 0' });
    assert.equal(archive.read('mine', 'source-0').savedObservation, true);
    for (const id of ['other-private', 'failed', 'login', 'coordination']) assert.throws(() => archive.read('mine', id));
    for (const cursor of [-1, 0, 1.2, '1', Infinity]) assert.throws(() => archive.list('mine', cursor));
  } finally { db.close(); }
});

test('saved blockers are never factual sources and read-only modes have no executable/write tool escalation', () => {
  for (const value of [{ waiting: true }, { accountVerified: false }, { loginOrRedirect: true }, { humanLoginRequired: true }, { nativeHumanControl: true }, null]) assert.equal(isSourceReceipt('browser_observe', value), false);
  for (const policy of [{ mode: 'read_only_browser' as const, allowedOrigins: [] }, { mode: 'read_only_browser' as const, allowedOrigins: ['https://mail.google.com'], mailAccount: 'test@gmail.com' }]) {
    const tools = toolsForPolicy(policy).map(t => t.name);
    assert.ok(tools.includes('read_file')); assert.ok(tools.includes('evidence_list')); assert.ok(tools.includes('evidence_read'));
    for (const forbidden of ['code_execute', 'consume_shared', 'publish_output', 'browser_upload']) assert.ok(!tools.includes(forbidden));
    assert.equal(new Set(tools).size, tools.length);
  }
  assert.ok(REPORT_CONTENT_BYTES < MODEL_LIMITS.argumentsBytes);
  assert.ok(CODE_SOURCE_BYTES < MODEL_LIMITS.argumentsBytes);
});
