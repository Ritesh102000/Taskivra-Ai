import { Coordinator } from '../../../packages/coordinator/index';

const coordinator = new Coordinator({ dataRoot: process.argv[2], now: () => 1000 });
let snapshot = coordinator.handle({ type: 'agents.create', name: 'Crash fixture', instructions: '' });
snapshot = coordinator.handle({ type: 'tasks.create', agentId: snapshot.agents[0].id, objective: 'Recover a simulated task after abrupt process death', completionCriteria: 'Simulation finishes from its checkpoint', scenario: 'complete' });
snapshot = coordinator.handle({ type: 'simulation.step' });
if (snapshot.tasks[0].state !== 'running') throw new Error('Fixture must leave an active run before the crash.');
process.stdout.write(`${JSON.stringify({ task: snapshot.tasks[0], dataRoot: snapshot.runtime.dataRoot })}\n`);
setInterval(() => {}, 1000);
