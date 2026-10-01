import electron from 'electron';
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

// Exercise the same persistence code under Electron's bundled Node/SQLite.
const phase = process.argv[2];
if (phase && !['phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'phase7', 'phase8', 'fleet', 'improvements'].includes(phase)) throw new Error('Expected phase1 through phase8, fleet, or improvements.');
const files = (phase ? [phase] : ['phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'phase7', 'phase8', 'fleet', 'improvements']).flatMap(name => globSync(`tests/${name}/*.test.ts`)).sort();
if (!files.length) throw new Error('No desktop tests found.');
const result = spawnSync(electron, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
