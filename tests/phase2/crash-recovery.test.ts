import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../../packages/coordinator/index';

interface InterruptedOperation {
  id: string;
  stage: string;
  finals: string[];
  candidates: { artifactId: string; versionId: string; final: string; sha256: string }[];
  snapshot: { id: string; final: string; files: { versionId: string; path: string }[] };
}

async function regularFiles(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await regularFiles(root, path));
    else {
      assert.ok(entry.isFile(), 'The managed artifact tree must contain only directories and regular files.');
      found.push(relative(root, path));
    }
  }
  return found.sort();
}

test('SIGKILL after file finalization recovers the journal without exposing an attachment or deleting committed bytes', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-phase2-process-crash-'));
  const dataRoot = join(root, 'app');
  const databasePath = join(dataRoot, 'control', 'agent-workspaces.sqlite');
  const committedText = 'Already committed: retain these exact bytes.\n';
  const interruptedText = 'Finalized before process death, but never committed.\n';
  const committedSource = join(root, 'committed.txt');
  const interruptedSource = join(root, 'interrupted.txt');
  let coordinator: Coordinator | undefined;
  try {
    await writeFile(committedSource, committedText);
    await writeFile(interruptedSource, interruptedText);
    coordinator = new Coordinator({ dataRoot });
    await coordinator.artifacts.ready;
    const agent = coordinator.handle({ type: 'agents.create', name: 'Crash recovery', instructions: '' }).agents[0];
    const task = coordinator.handle({ type: 'tasks.create', agentId: agent.id, objective: 'Use the attachment after import', completionCriteria: '', scenario: 'complete' }).tasks[0];
    const committedId = (await coordinator.artifacts.importFiles({
      principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId: null }, paths: [committedSource],
    })).versionIds[0];
    const committedVersion = coordinator.snapshot().artifacts[0];
    let committedRef: string;
    const initialDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      committedRef = String(initialDb.prepare('SELECT storage_ref FROM artifact_versions WHERE id=?').get(committedId)!.storage_ref);
    } finally { initialDb.close(); }
    const committedStat = await stat(join(dataRoot, committedRef));
    coordinator.close();
    await coordinator.artifacts.drain();
    coordinator = undefined;

    // Use this test's runtime, including Electron's bundled Node when invoked by
    // scripts/test-electron.mjs. SIGKILL cannot enter the import catch or finally.
    const childSource = `
      import { Coordinator } from ${JSON.stringify(new URL('../../packages/coordinator/index.ts', import.meta.url).href)};
      const { dataRoot, agentId, taskId, sourcePath } = JSON.parse(process.argv[1]);
      const coordinator = new Coordinator({ dataRoot, artifactFault(point) {
        if (point === 'after_finalize') process.kill(process.pid, 'SIGKILL');
      }});
      await coordinator.artifacts.ready;
      await coordinator.artifacts.importFiles({ principal: { kind: 'owner' },
        target: { scope: 'private', agentId, taskId }, paths: [sourcePath] });
      throw new Error('The import unexpectedly survived its SIGKILL fault point.');
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childSource,
      JSON.stringify({ dataRoot, agentId: agent.id, taskId: task.id, sourcePath: interruptedSource })], {
      env: process.env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    assert.equal(child.error, undefined, `The child must reach its own kill hook, not the parent timeout. ${child.stderr}`);
    assert.equal(child.status, null, child.stderr);
    assert.equal(child.signal, 'SIGKILL', child.stderr);

    // Inspect raw persisted state before constructing the recovering service:
    // finalized bytes and its live reservation still exist, so cleanup did not run.
    let interrupted: InterruptedOperation;
    const crashedDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const pending = crashedDb.prepare("SELECT * FROM artifact_operations WHERE state='finalized'").all();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].owner_pid, child.pid);
      assert.ok(Number(pending[0].reserved_bytes) > 0);
      interrupted = JSON.parse(String(pending[0].manifest)) as InterruptedOperation;
      assert.equal(interrupted.candidates.length, 1);
      assert.ok(interrupted.snapshot);
      assert.equal(crashedDb.prepare('SELECT COUNT(*) AS n FROM artifact_versions').get()!.n, 1);
      for (const table of ['task_artifacts', 'workspace_snapshots', 'workspace_heads']) {
        assert.equal(crashedDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, `${table} was not committed before death`);
      }
    } finally { crashedDb.close(); }
    assert.deepEqual(await readdir(join(dataRoot, 'staging/artifacts')), [interrupted.id]);
    assert.equal(await readFile(join(dataRoot, interrupted.candidates[0].final), 'utf8'), interruptedText);
    const stagedSnapshot = JSON.parse(await readFile(join(dataRoot, interrupted.snapshot.final, 'manifest.json'), 'utf8'));
    assert.equal(stagedSnapshot.files.length, 1);
    assert.equal(stagedSnapshot.files[0].versionId, interrupted.candidates[0].versionId);
    assert.equal(await readFile(join(dataRoot, interrupted.snapshot.final, stagedSnapshot.files[0].path), 'utf8'), interruptedText);

    coordinator = new Coordinator({ dataRoot });
    await coordinator.artifacts.ready;
    const recovered = coordinator.snapshot();
    assert.deepEqual(recovered.artifacts, [committedVersion]);
    assert.deepEqual(recovered.taskArtifacts, []);
    assert.deepEqual(recovered.workspaceSnapshots, []);
    assert.equal(recovered.tasks[0].id, task.id);
    assert.equal((await coordinator.artifacts.preview({ principal: { kind: 'owner' }, versionId: committedId })).text, committedText);

    const recoveredDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(recoveredDb.prepare('SELECT id FROM artifacts WHERE id=?').get(interrupted.candidates[0].artifactId), undefined);
      assert.equal(recoveredDb.prepare('SELECT id FROM artifact_versions WHERE id=?').get(interrupted.candidates[0].versionId), undefined);
      for (const table of ['task_artifacts', 'workspace_snapshots', 'workspace_heads']) {
        assert.equal(recoveredDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, `${table} must stay empty after recovery`);
      }
      const operation = recoveredDb.prepare('SELECT state,reserved_bytes,lease_until FROM artifact_operations WHERE id=?').get(interrupted.id)!;
      assert.equal(operation.state, 'abandoned');
      assert.equal(operation.reserved_bytes, 0);
      assert.equal(operation.lease_until, 0);
      assert.equal(recoveredDb.prepare("SELECT COUNT(*) AS n FROM events WHERE type='artifact.imported'").get()!.n, 1);
      assert.equal(recoveredDb.prepare("SELECT COUNT(*) AS n FROM events WHERE type='workspace.snapshot_committed'").get()!.n, 0);
      assert.deepEqual(recoveredDb.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(recoveredDb.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { recoveredDb.close(); }

    assert.deepEqual(await readdir(join(dataRoot, 'staging/artifacts')), []);
    for (const final of new Set([...interrupted.finals, interrupted.snapshot.final])) {
      await assert.rejects(stat(join(dataRoot, final)), { code: 'ENOENT' });
    }
    assert.deepEqual(await readdir(join(dataRoot, dirname(interrupted.snapshot.final))), []);
    assert.deepEqual(await regularFiles(join(dataRoot, 'artifacts')), [relative('artifacts', committedRef)]);
    const preserved = await readFile(join(dataRoot, committedRef));
    const preservedStat = await stat(join(dataRoot, committedRef));
    assert.equal(preserved.toString(), committedText);
    assert.equal(createHash('sha256').update(preserved).digest('hex'), committedVersion.sha256);
    assert.equal(preservedStat.ino, committedStat.ino);
    assert.equal(preservedStat.dev, committedStat.dev);
    assert.equal(preservedStat.mode & 0o222, 0);
    assert.equal(await readFile(interruptedSource, 'utf8'), interruptedText);
  } finally {
    if (coordinator) { coordinator.close(); await coordinator.artifacts.drain(); }
    await rm(root, { recursive: true, force: true });
  }
});
