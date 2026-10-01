import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator, CoordinatorError, LEASE_MS, CAPACITY } from '../../packages/coordinator/index';
import { SCHEMA_VERSION } from '../../packages/persistence/index';
import type { Scenario, TaskState } from '../../packages/contracts/index';

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'aw-phase1-coordinator-'));
  let time = 1_000_000;
  const instances: Coordinator[] = [];
  const open = () => { const c = new Coordinator({ dataRoot, now: () => time }); instances.push(c); return c; };
  return { dataRoot, open, advance: (ms: number) => { time += ms; },
    close: () => { for (const c of instances) c.close(); rmSync(dataRoot, { recursive: true, force: true }); } };
}
function agent(c: Coordinator, name = 'Agent A') {
  const before = new Set(c.snapshot().agents.map(a => a.id));
  return c.handle({ type: 'agents.create', name, instructions: 'Only use the fixed simulation.' }).agents.find(a => !before.has(a.id))!;
}
function task(c: Coordinator, agentId: string, scenario: Scenario = 'clarification') {
  const before = new Set(c.snapshot().tasks.map(t => t.id));
  return c.handle({ type: 'tasks.create', agentId, objective: 'Exercise the saved lifecycle', completionCriteria: 'Finish the simulation only.', scenario }).tasks.find(t => !before.has(t.id))!;
}
function state(c: Coordinator, id: string) { return c.snapshot().tasks.find(t => t.id === id)!; }
function until(c: Coordinator, taskId: string, expected: TaskState) {
  for (let i = 0; i < 12 && state(c, taskId).state !== expected; i++) c.tick();
  assert.equal(state(c, taskId).state, expected);
}
function code(expected: string) { return (error: unknown) => error instanceof CoordinatorError && error.code === expected; }

test('WAL migration includes all baseline tables and distinct generated private workspaces', () => {
  const f = fixture();
  try {
    const c = f.open(), a = agent(c), b = agent(c, 'Agent B');
    const ta = task(c, a.id), tb = task(c, b.id);
    assert.notEqual(a.workspaceId, b.workspaceId);
    for (const item of [ta, tb]) for (const folder of ['inputs', 'work', 'outputs']) {
      const path = join(f.dataRoot, 'private', item.agentId, 'workspace', 'tasks', item.id, folder);
      assert.ok(existsSync(path)); assert.equal(lstatSync(path).mode & 0o777, 0o700);
    }
    const db = new DatabaseSync(c.databasePath);
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
      const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      for (const name of ['agents','tasks','runs','task_messages','browser_sessions','browser_tabs','input_requests','request_slots','artifacts','artifact_versions','artifact_grants','task_dependencies','agent_messages','tool_calls','code_executions','events','event_cursors','resume_receipts']) assert.ok(names.has(name), name);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, SCHEMA_VERSION);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get()!.n, 2);
      assert.equal(db.prepare("SELECT lifecycle FROM browser_sessions LIMIT 1").get()!.lifecycle, 'not_provisioned');
    } finally { db.close(); }
  } finally { f.close(); }
});

test('independent coordinator connections do not steal live claims or run two tasks for one agent', () => {
  const f = fixture();
  try {
    const first = f.open(), a = agent(first), b = agent(first, 'B');
    task(first, a.id, 'complete'); task(first, a.id, 'complete'); task(first, b.id, 'complete');
    const one = first.claimNext()!;
    const second = f.open(), two = second.claimNext()!;
    assert.notEqual(one.agentId, two.agentId);
    assert.equal(first.claimNext(), null); assert.equal(second.claimNext(), null);
    first.authorizeTool(one); second.authorizeTool(two);
    const before = state(first, one.taskId).checkpoint;
    second.tick();
    assert.equal(state(first, one.taskId).checkpoint, before, 'one coordinator must not advance another worker');
    second.close();
    first.authorizeTool(one);
    assert.equal(state(first, two.taskId).state, 'queued');
  } finally { f.close(); }
});

test('two actual child processes race for one SQLite claim and exactly one wins', async () => {
  const f = fixture();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const c = f.open(), a = agent(c), t = task(c, a.id, 'complete');
    const source = `import {Coordinator} from './packages/coordinator/index.ts';
      const c=new Coordinator({dataRoot:process.argv[1]});
      process.stdout.write('READY\\n');
      process.stdin.once('data',()=>{process.stdout.write(JSON.stringify(c.claimNext())+'\\n');
        process.stdin.once('data',()=>{c.close();process.exit(0)});});`;
    const racers = [0, 1].map(() => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, f.dataRoot], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      let readyResolve!: () => void, claimResolve!: (value: unknown) => void;
      let rejectAll!: (error: Error) => void;
      const failed = new Promise<never>((_, reject) => { rejectAll = reject; });
      const ready = Promise.race([new Promise<void>(resolve => { readyResolve = resolve; }), failed]);
      const claimed = Promise.race([new Promise<unknown>(resolve => { claimResolve = resolve; }), failed]);
      let buffer = '', diagnostics = '';
      child.stderr!.on('data', bytes => { diagnostics += bytes.toString(); });
      child.stdout!.on('data', bytes => {
        buffer += bytes.toString();
        for (;;) {
          const newline = buffer.indexOf('\n'); if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (line === 'READY') readyResolve(); else try { claimResolve(JSON.parse(line)); } catch { rejectAll(new Error('Malformed claim output')); }
        }
      });
      child.on('error', rejectAll);
      child.on('exit', exit => { if (exit) rejectAll(new Error(diagnostics)); });
      return { child, ready, claimed };
    });
    await Promise.all(racers.map(r => r.ready));
    racers.forEach(r => r.child.stdin!.write('claim\n'));
    const claims = await Promise.all(racers.map(r => r.claimed));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(state(c, t.id).state, 'running');
    await Promise.all(racers.map(r => new Promise<void>(resolve => { r.child.once('exit', () => resolve()); r.child.stdin!.write('close\n'); })));
  } finally { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); f.close(); }
});

test('stale, forged, paused, expired and cancelled claims cannot execute a synthetic effect', () => {
  const f = fixture();
  try {
    const c = f.open(), a = agent(c), t = task(c, a.id, 'complete'), claim = c.claimNext()!;
    const original = c.snapshot().messages.length;
    assert.throws(() => c.executeSyntheticTool({ ...claim, generation: claim.generation + 1 }, 'simulation.observe'), code('stale_generation'));
    assert.throws(() => c.executeSyntheticTool({ ...claim, agentId: 'different-agent' }, 'simulation.observe'), code('stale_generation'));
    assert.throws(() => c.executeSyntheticTool(claim, 'host.exec' as never), code('permission_denied'));
    assert.equal(c.snapshot().messages.length, original);
    f.advance(LEASE_MS);
    assert.throws(() => c.renewLease(claim), code('lease_expired'));
    assert.throws(() => c.executeSyntheticTool(claim, 'simulation.observe'), code('lease_expired'));
    c.recoverExpiredRuns();
    const next = c.claimNext()!;
    assert.ok(next.generation > claim.generation);
    assert.throws(() => c.executeSyntheticTool(claim, 'simulation.observe'), code('stale_generation'));
    c.handle({ type: 'tasks.pause', taskId: t.id });
    assert.throws(() => c.executeSyntheticTool(next, 'simulation.observe'), code('stale_generation'));
    c.tick(); assert.equal(state(c,t.id).state, 'paused');
    c.handle({ type: 'tasks.resume', taskId: t.id });
    const final = c.claimNext()!;
    c.handle({ type: 'tasks.cancel', taskId: t.id });
    assert.throws(() => c.executeSyntheticTool(final, 'simulation.observe'), code('stale_generation'));
    assert.equal(c.snapshot().messages.length, original);
  } finally { f.close(); }
});

test('clarification persists across restart and duplicate replies schedule exactly one continuation', () => {
  const f = fixture();
  try {
    const before = f.open(), a = agent(before), t = task(before,a.id);
    until(before,t.id,'waiting');
    const request = before.snapshot().requests[0];
    assert.equal(state(before,t.id).checkpoint, 2);
    before.close();
    const c = f.open();
    assert.equal(state(c,t.id).state, 'waiting');
    assert.deepEqual(c.snapshot().requests[0], request);
    const command = { type: 'requests.respond', requestId: request.id, revision: request.revision, response: 'Emphasize usability.' } as const;
    c.handle(command);
    const eventCount = c.snapshot().events.length, messageCount = c.snapshot().messages.length;
    c.handle(command);
    const peer = f.open(); peer.handle(command);
    assert.equal(c.snapshot().events.length, eventCount); assert.equal(c.snapshot().messages.length, messageCount);
    assert.equal(state(c,t.id).state, 'queued');
    assert.throws(() => c.handle({ ...command, response: 'A different reply' }), code('stale_revision'));
    const db = new DatabaseSync(c.databasePath);
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resume_receipts').get()!.n, 1); } finally { db.close(); }
    until(c,t.id,'succeeded');
    assert.match(c.snapshot().messages.at(-1)!.content, /no real deliverable/i);
  } finally { f.close(); }
});

test('pausing a waiting task preserves its blocker and accepted replies do not bypass pause', () => {
  const f = fixture();
  try {
    const c = f.open(), a = agent(c), t = task(c,a.id);
    until(c,t.id,'waiting');
    c.handle({ type:'tasks.pause',taskId:t.id });
    assert.equal(state(c,t.id).state,'paused');
    c.handle({ type:'tasks.resume',taskId:t.id });
    assert.equal(state(c,t.id).state,'waiting');
    c.handle({ type:'tasks.pause',taskId:t.id });
    const request=c.snapshot().requests[0];
    c.handle({ type:'requests.respond',requestId:request.id,revision:request.revision,response:'Accuracy.' });
    assert.equal(state(c,t.id).state,'paused'); assert.equal(state(c,t.id).waitingReason,null);
    assert.ok(c.snapshot().events.some(e=>e.type==='task.blockers_changed'&&e.aggregateId===t.id));
    c.tick(); assert.equal(state(c,t.id).state,'paused');
    c.close(); const reopened=f.open();
    assert.equal(state(reopened,t.id).state,'paused');
    reopened.handle({type:'tasks.resume',taskId:t.id});
    until(reopened,t.id,'succeeded');
  } finally { f.close(); }
});

test('queued/waiting cancellation remains terminal after later replies, replays and restart', () => {
  const f=fixture();
  try {
    const c=f.open(),a=agent(c),queued=task(c,a.id,'complete');
    c.handle({type:'tasks.cancel',taskId:queued.id});
    assert.equal(c.claimNext(),null);
    const waiting=task(c,a.id); until(c,waiting.id,'waiting');
    const request=c.snapshot().requests[0];
    c.handle({type:'tasks.cancel',taskId:waiting.id});
    const command={type:'requests.respond',requestId:request.id,revision:request.revision,response:'Late answer'} as const;
    assert.throws(()=>c.handle(command),code('invalid_state'));
    c.close(); const next=f.open();
    assert.throws(()=>next.handle(command),code('invalid_state'));
    for(let n=0;n<6;n++)next.tick();
    assert.ok(next.snapshot().tasks.every(t=>t.state==='cancelled'));
    assert.equal(next.snapshot().requests[0].state,'cancelled');
  } finally { f.close(); }
});

test('recovery preserves committed synthetic effects and rejects replay from the expired generation', () => {
  const f=fixture();
  try {
    const old=f.open(),a=agent(old),t=task(old,a.id,'complete'),claim=old.claimNext()!;
    old.executeSyntheticTool(claim,'simulation.observe');
    const duplicate=old.executeSyntheticTool(claim,'simulation.observe');
    assert.equal(duplicate.replayed,true); assert.equal(state(old,t.id).checkpoint,1);
    const messages=old.snapshot().messages.length;
    f.advance(LEASE_MS+1);
    const recovered=f.open(),next=recovered.claimNext()!;
    assert.throws(()=>old.executeSyntheticTool(claim,'simulation.observe'),code('stale_generation'));
    const replay=recovered.executeSyntheticTool(next,'simulation.observe');
    assert.equal(replay.replayed,true); assert.equal(recovered.snapshot().messages.length,messages);
    recovered.executeSyntheticTool(next,'simulation.summarize');
    recovered.executeSyntheticTool(next,'simulation.complete');
    assert.equal(state(recovered,t.id).state,'succeeded');
    const db=new DatabaseSync(recovered.databasePath);
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name='simulation.observe'").get()!.n,1); } finally { db.close(); }
  } finally { f.close(); }
});

test('tool effect, checkpoint and events roll back together when commit preparation fails', () => {
  const f=fixture();
  try {
    const c=f.open(),a=agent(c),t=task(c,a.id,'complete'),claim=c.claimNext()!;
    const db=new DatabaseSync(c.databasePath),before=c.snapshot();
    try {
      db.exec("CREATE TRIGGER test_fail_tool BEFORE UPDATE ON tool_calls WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'injected_commit_failure'); END;");
      assert.throws(()=>c.executeSyntheticTool(claim,'simulation.observe'),/injected_commit_failure/);
      assert.equal(state(c,t.id).checkpoint,0); assert.deepEqual(c.snapshot().messages,before.messages); assert.deepEqual(c.snapshot().events,before.events);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get()!.n,0);
      db.exec('DROP TRIGGER test_fail_tool');
      c.executeSyntheticTool(claim,'simulation.observe');
      assert.equal(state(c,t.id).checkpoint,1);
    } finally { db.close(); }
  } finally { f.close(); }
});

test('request response transaction rolls back fulfillment, receipt, message and requeue together', () => {
  const f=fixture();
  try {
    const c=f.open(),a=agent(c),t=task(c,a.id); until(c,t.id,'waiting');
    const request=c.snapshot().requests[0],before=c.snapshot(),db=new DatabaseSync(c.databasePath);
    try {
      db.exec("CREATE TRIGGER test_fail_resume BEFORE INSERT ON resume_receipts BEGIN SELECT RAISE(ABORT,'injected_resume_failure'); END;");
      const command={type:'requests.respond',requestId:request.id,revision:request.revision,response:'Keep it concise.'} as const;
      assert.throws(()=>c.handle(command),/injected_resume_failure/);
      assert.equal(state(c,t.id).state,'waiting'); assert.deepEqual(c.snapshot().requests,before.requests); assert.deepEqual(c.snapshot().messages,before.messages);
      assert.deepEqual(c.snapshot().events,before.events);
      db.exec('DROP TRIGGER test_fail_resume');
      c.handle(command); c.handle(command);
      assert.equal(state(c,t.id).state,'queued'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resume_receipts').get()!.n,1);
    } finally { db.close(); }
  } finally { f.close(); }
});

test('one waiting agent releases its slot while another agent completes independently', () => {
  const f=fixture();
  try {
    const c=f.open(),a=agent(c),b=agent(c,'B'),waiting=task(c,a.id),independent=task(c,b.id,'complete');
    until(c,waiting.id,'waiting'); until(c,independent.id,'succeeded');
    const second=task(c,a.id,'complete'); until(c,second.id,'succeeded');
    assert.equal(state(c,waiting.id).state,'waiting');
  } finally { f.close(); }
});

test('settings persist, auto-run disabled does not execute tools, manual step remains explicit', () => {
  const f=fixture();
  try {
    const c=f.open(),a=agent(c),t=task(c,a.id,'failure');
    c.handle({type:'settings.update',settings:{theme:'dark',driverEnabled:false,maxActiveAgents:1}});
    c.tick(); assert.equal(state(c,t.id).state,'queued');
    c.handle({type:'simulation.step'}); assert.equal(state(c,t.id).state,'running');
    c.tick(); assert.equal(state(c,t.id).checkpoint,0);
    c.handle({type:'simulation.step'}); c.handle({type:'simulation.step'});
    assert.equal(state(c,t.id).state,'failed');
    c.close(); assert.deepEqual(f.open().snapshot().settings,{theme:'dark',driverEnabled:false,maxActiveAgents:1});
  } finally { f.close(); }
});

test('command validation and conversation capacity reject excess without bypassing cancellation', () => {
  const f=fixture();
  try {
    const c=f.open(),a=agent(c),t=task(c,a.id,'complete');
    const before=c.snapshot();
    for(const command of [{type:'host.exec',argv:['touch','outside']},{type:'tasks.create',agentId:a.id,objective:'x',completionCriteria:'',scenario:'complete',path:'/tmp/outside'}]) {
      assert.throws(()=>c.handle(command as never), /supported|unsupported/);
    }
    assert.deepEqual(c.snapshot(),before);
    for(let n=1;n<CAPACITY.ownerMessagesPerTask;n++)c.handle({type:'tasks.message',taskId:t.id,content:`message ${n}`});
    assert.throws(()=>c.handle({type:'tasks.message',taskId:t.id,content:'over limit'}),code('capacity_limit'));
    c.handle({type:'tasks.cancel',taskId:t.id}); assert.equal(state(c,t.id).state,'cancelled');
  } finally { f.close(); }
});

test('dependency cycle and one-active-run constraints remain database-enforced', () => {
  const f=fixture();
  try {
    const c=f.open(),a=agent(c),one=task(c,a.id),two=task(c,a.id),three=task(c,a.id),db=new DatabaseSync(c.databasePath);
    try {
      db.exec('PRAGMA foreign_keys=ON');
      db.prepare('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES (?,?)').run(two.id,one.id);
      db.prepare('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES (?,?)').run(three.id,two.id);
      assert.throws(()=>db.prepare('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES (?,?)').run(one.id,three.id),/dependency_cycle/);
      const claim=c.claimNext()!; assert.equal(claim.taskId,one.id);
      assert.throws(()=>db.prepare("INSERT INTO runs(id,task_id,agent_id,attempt,worker_id,lease_until,fencing_generation,checkpoint,state,created_at) VALUES ('duplicate',?,?,1,'other',99999999,1,'{}','running',0)").run(two.id,a.id),/UNIQUE/);
    } finally { db.close(); }
  } finally { f.close(); }
});

test('a symlink in owned private storage fails closed before agent creation', () => {
  const f=fixture();
  try {
    const c=f.open(); c.close();
    rmSync(join(f.dataRoot,'private'),{recursive:true});
    symlinkSync(tmpdir(),join(f.dataRoot,'private'));
    assert.throws(()=>f.open(),/private directory/);
  } finally { f.close(); }
});
