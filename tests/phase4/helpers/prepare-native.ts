import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Coordinator } from '../../../packages/coordinator/index';

const root = resolve('.test-data/phase4-ui');
await mkdir(root, { recursive: true, mode: 0o700 });
const c = new Coordinator({ dataRoot: root });
try {
  await c.code.ready;
  c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
  if (c.snapshot().agents.length === 0) {
    const agent = c.handle({ type: 'agents.create', name: 'Code QA', instructions: 'Synthetic desktop verification only.' }).agents[0];
    const task = c.handle({ type: 'tasks.create', agentId: agent.id, objective: 'Process the provided numbers', completionCriteria: 'Verified sum and saved workspace', scenario: 'complete' }).tasks[0];
    const source = join(root, 'native-input.csv'); await writeFile(source, 'value\n4\n6\n');
    await c.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: agent.id, taskId: task.id }, paths: [source] });
  }
  console.log(JSON.stringify({ dataRoot: root, agents: c.snapshot().agents.length, tasks: c.snapshot().tasks.length }));
} finally { await c.shutdown(); }
