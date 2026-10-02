import {build} from 'esbuild';
import electron from 'electron';
import {spawnSync} from 'node:child_process';
await build({stdin:{contents:"export {createXlsxReport} from './packages/report-export';export {formatOfficeInWorker} from './apps/desktop/main/report-format';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:'.test-data/improvements/format-benchmark.cjs'});
await build({entryPoints:['apps/desktop/main/report-format-worker.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist/main/report-format-worker.cjs'});
const result=spawnSync(electron,['tests/renderer/report-performance.cjs'],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:''}});if(result.error)throw result.error;process.exitCode=result.status??1;
