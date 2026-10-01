import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statfsSync } from 'node:fs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = process.env.AW_DOCKER_PATH || 'docker';
const images = [
  { tag:'agent-workspaces-browser:3', label:'io.agent-workspaces.browser.protocol', local:'agent-workspaces-phase0-browser:1.63.0', base:'sha256:a32d31643c1ee3c0041d2f41c49e32fea386ea8d84cf579a72c0754ceb6a8817', dockerfile:'containers/browser/Dockerfile', files:['containers/browser/Dockerfile','workers/browser'] },
  { tag:'agent-workspaces-egress:3', label:'io.agent-workspaces.egress.policy', local:'agent-workspaces-phase0-code:2026-09-11', base:'sha256:20d943322762c150371abd5ad8bbc77ba33412dd7f3f0da6ab23bcc9c1a7d3c6', dockerfile:'containers/egress/Dockerfile', files:['containers/egress'] },
];
function verifyBuilt(image) {
  const data=JSON.parse(execFileSync(docker,['image','inspect',image.tag],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024}))[0];
  if(!/^sha256:[a-f0-9]{64}$/.test(data.Id)||data.Config?.Labels?.[image.label]!=='3')throw new Error('Runtime image protocol/policy label verification failed.');
  process.stdout.write(data.Id+'\n');
}
if (process.argv.length !== 3 || !['--build','--check'].includes(process.argv[2])) throw new Error('Use setup.mjs --check or explicitly setup.mjs --build. This workflow never downloads images.');
execFileSync(docker,['version','--format','{{.Server.Version}}'],{stdio:'inherit',timeout:10000});
for (const image of images) {
  if (process.argv[2] === '--check') { verifyBuilt(image); continue; }
  const disk=statfsSync(root); if(disk.bavail*disk.bsize < 8*1024**3) throw new Error('Browser image setup requires at least 8 GiB free disk.');
  const verified=execFileSync(docker,['image','inspect',image.local,'--format','{{.Id}}'],{encoding:'utf8',timeout:10000}).trim();
  if(verified!==image.base)throw new Error('The pinned Phase 0 base image is unavailable; automatic downloads are disabled.');
  const archive=spawn('tar',['-cf','-',...image.files],{cwd:root,stdio:['ignore','pipe','inherit']});
  const build=spawn(docker,['build','--pull=false','--network=none','-f',image.dockerfile,'-t',image.tag,'-'],{cwd:root,stdio:['pipe','inherit','inherit']});
  archive.stdout.pipe(build.stdin);
  build.stdin.on('error',()=>archive.kill('SIGTERM'));
  const completion=child=>new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>code===0?resolve():reject(new Error(`Setup process failed: ${code??signal}`)));});
  await Promise.all([completion(archive),completion(build)]);
  if(execFileSync(docker,['image','inspect',image.local,'--format','{{.Id}}'],{encoding:'utf8',timeout:10000}).trim()!==image.base)throw new Error('Pinned local base tag changed during setup.');
  verifyBuilt(image);
}
