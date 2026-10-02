import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const profile=mkdtempSync(join(tmpdir(),'r16-renderer-'));
try {
 await build({entryPoints:[join(dir,'renderer-fixture.tsx')],bundle:true,platform:'browser',format:'iife',outfile:join(dir,'renderer-fixture.js'),jsx:'automatic'});
 const child=spawnSync(resolve('node_modules/.bin/electron'),[join(dir,'renderer-harness.cjs')],{stdio:'inherit',env:{...process.env,IMPROVEMENT_RENDERER_PROFILE:profile}});
 if(child.error)throw child.error;
 process.exitCode=child.status??1;
} finally {
 // Chromium helpers may finish cache writes after Electron's will-quit event.
 rmSync(profile,{recursive:true,force:true});
}
