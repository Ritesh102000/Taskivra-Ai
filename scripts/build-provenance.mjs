import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
export async function buildProvenance(root = process.cwd()) {
 const digest = async path => createHash('sha256').update(await readFile(`${root}/${path}`)).digest('hex');
 const sourceEntries=[];
 async function scan(dir){for(const entry of await readdir(`${root}/${dir}`,{withFileTypes:true})){const path=`${dir}/${entry.name}`;if(entry.isSymbolicLink())throw new Error('Build provenance refuses linked source inputs.');if(entry.isDirectory()&&!['node_modules','bin','evidence'].includes(entry.name))await scan(path);else if(entry.isFile()&&/\.(?:ts|tsx|mjs|cjs|js|css|html|json)$/.test(entry.name)){const stat=await lstat(`${root}/${path}`);if(stat.size>16*1024*1024)throw new Error('Build source input exceeds provenance bound.');sourceEntries.push({path,sha256:await digest(path)});}}}
 for(const directory of ['apps','packages','scripts','extensions','workers','containers','labs'])await scan(directory);sourceEntries.sort((a,b)=>a.path.localeCompare(b.path));
 const sourceTreeSha256=createHash('sha256').update(JSON.stringify(sourceEntries)).digest('hex');
 const pkg = JSON.parse(await readFile(`${root}/package.json`,'utf8'));
 let revision = null, dirty = null;
 try {revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();dirty=!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim();} catch {}
 const versions={};for(const name of ['electron','typescript','esbuild','vite','react','react-dom']){try{versions[name]=JSON.parse(await readFile(`${root}/node_modules/${name}/package.json`,'utf8')).version;}catch{versions[name]=null;}}
 return {format:'taskivra-build-provenance',schemaVersion:1,appVersion:pkg.version,revision,trackedInputsDirty:dirty,node:process.version,platform:process.platform,architecture:process.arch,toolchain:versions,sourceTreeSha256,sourceEntries,inputs:{packageJson:await digest('package.json'),lockfile:await digest('package-lock.json'),buildScript:await digest('scripts/build.mjs')},builtAt:new Date().toISOString(),limitation:'Nonsecret build inputs only. Null receipts are unknown. No credentials, environment dump, absolute host paths, signing or runtime validation are included.'};
}
export async function writeBuildProvenance(path){await writeFile(path,JSON.stringify(await buildProvenance(),null,2)+'\n');}
