// Synthetic local fixture only. Does not open the user's application data.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { Coordinator } from '../../packages/coordinator';

const dataRoot = mkdtempSync(join(tmpdir(), 'taskivra-review-snapshot-'));
const coordinator = new Coordinator({ dataRoot });
const db = new DatabaseSync(coordinator.databasePath);
const results: object[] = [];
function measure(label: string, fn: () => unknown, count = 100) {
  for (let i = 0; i < 10; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now(); fn(); times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { label, count, p50_ms: times[Math.floor(count * .5)], p95_ms: times[Math.floor(count * .95)] };
}
function checkpoint(label: string) {
  const query = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events');
  results.push({ label, serialized_bytes: Buffer.byteLength(JSON.stringify(coordinator.snapshot())),
    snapshot: measure('current full snapshot', () => coordinator.snapshot()),
    watermark: measure('implemented event watermark', () => coordinator.eventWatermark()),
  });
}
try {
  checkpoint('empty synthetic database');
  for (let i = 0; i < 100; i++) coordinator.handle({ type: 'agents.create', name: `Synthetic ${i}`, instructions: 'Simulation only.' });
  const agents = coordinator.snapshot().agents;
  for (let i = 0; i < 250; i++) coordinator.handle({ type: 'tasks.create', agentId: agents[i % agents.length].id, objective: `Synthetic task ${i}`, completionCriteria: 'Simulation only.', scenario: 'complete' });
  const tasks = coordinator.snapshot().tasks;
  db.exec('BEGIN IMMEDIATE');
  const insert = db.prepare('INSERT INTO task_messages(id,task_id,role,content,created_at) VALUES (?,?,?,?,?)');
  const existing = Number(db.prepare('SELECT COUNT(*) AS n FROM task_messages').get()!.n);
  for (let i = existing; i < 2000; i++) insert.run(`bench-message-${i}`, tasks[i % tasks.length].id, 'agent', 'Synthetic message. '.repeat(200), Date.now() + i);
  db.exec('COMMIT');
  checkpoint('100 agents, 250 tasks, 2000 messages; no artifacts');
  const report = { node: process.version, method: '100 measured iterations after 10 warmup iterations, synchronous local SQLite; no UI or IPC timing; matched former idle full-snapshot path and implemented watermark on identical fixture; no UI/IPC or allocation claim', results };
  writeFileSync(join(process.cwd(),'.test-data/improvements/snapshot-performance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close(); coordinator.close(); rmSync(dataRoot, { recursive: true, force: true });
}
