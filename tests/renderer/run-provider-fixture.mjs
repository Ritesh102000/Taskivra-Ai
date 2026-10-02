import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'r18-provider-'));
try{
 await build({entryPoints:[join(dir,'provider-fixture.tsx')],bundle:true,platform:'browser',outfile:join(dir,'provider-fixture.js')});
 const child=spawnSync(resolve('node_modules/.bin/electron'),[join(dir,'provider-harness.cjs')],{stdio:'inherit',env:{...process.env,IMPROVEMENT_RENDERER_PROFILE:temp}});
 if(child.error)throw child.error;process.exitCode=child.status??1;
}finally{rmSync(temp,{recursive:true,force:true})}
