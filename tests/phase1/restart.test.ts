import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator/index';
import type { Task } from '../../packages/contracts/index';

test('SQLite recovers a real SIGKILL interrupted simulation and completes from its saved checkpoint', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspaces-crash-'));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/phase1/helpers/crash-writer.ts'), root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let coordinator: Coordinator | undefined;
  let errors = '';
  child.stderr.on('data', data => { errors += data.toString(); });
  try {
    const saved = await new Promise<{ task: Task }>((resolveReady, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`Crash fixture timed out. ${errors}`)), 8000);
      child.stdout.on('data', data => {
        output += data.toString();
        if (output.includes('\n')) {
          clearTimeout(timeout);
          try { resolveReady(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
        }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited before crash: ${code}. ${errors}`)); });
    });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    coordinator = new Coordinator({ dataRoot: root, now: () => 100000 });
    let snapshot = coordinator.handle({ type: 'snapshot' });
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].id, saved.task.id);
    assert.ok(snapshot.tasks[0].generation > saved.task.generation);
    assert.equal(snapshot.tasks[0].checkpoint, saved.task.checkpoint);
    for (let step = 0; step < 12 && snapshot.tasks[0].state !== 'succeeded'; step++) snapshot = coordinator.handle({ type: 'simulation.step' });
    assert.equal(snapshot.tasks[0].state, 'succeeded');
    coordinator.close(); coordinator = undefined;
    const database = new DatabaseSync(join(root, 'control', 'agent-workspaces.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.equal(database.prepare("SELECT count(*) AS n FROM runs WHERE state='running'").get()?.n, 0);
      assert.ok(Number(database.prepare("SELECT count(*) AS n FROM events WHERE type='task.state_changed'").get()?.n) >= 3);
    } finally { database.close(); }
  } finally {
    coordinator?.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
});
