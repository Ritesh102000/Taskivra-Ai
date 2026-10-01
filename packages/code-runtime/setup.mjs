import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statfsSync } from 'node:fs';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validateRecipe } from './recipe.mjs';
import { ensurePortableBase } from './portable-base.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = process.env.AW_DOCKER_PATH || 'docker';
const baseTag = 'agent-workspaces-phase0-code:2026-09-11';
const baseId = 'sha256:20d943322762c150371abd5ad8bbc77ba33412dd7f3f0da6ab23bcc9c1a7d3c6';
const args = process.argv.slice(2);
let target = 'agent-workspaces-code:4';
const tagIndex = args.indexOf('--tag');
if (tagIndex >= 0) {
  const tag = args[tagIndex + 1];
  if (tagIndex !== args.length - 2 || !/^agent-workspaces-code:[a-z0-9][a-z0-9._-]{0,80}$/.test(tag || '')) throw new Error('Optional final --tag must name an agent-workspaces-code version.');
  target = tag; args.splice(tagIndex, 2);
}
if (!['--build', '--check'].includes(args[0]) || args.filter(x => x === '--recipe').length > 1 || args.filter(x => x === '--allow-network').length > 1 || args.filter(x => x === '--bootstrap-base').length > 1) throw new Error('Use --check, --build, or --build [--bootstrap-base] --recipe /owner/recipe.json --allow-network.');
const recipeIndex = args.indexOf('--recipe');
const recipePath = recipeIndex >= 0 ? args[recipeIndex + 1] : undefined;
const allowNetwork = args.includes('--allow-network');
const bootstrapBase = args.includes('--bootstrap-base');
const expected = ['--build', ...(bootstrapBase ? ['--bootstrap-base'] : []), ...(recipePath ? ['--recipe', recipePath] : []), ...(allowNetwork ? ['--allow-network'] : [])];
if (args[0] === '--check' ? args.length !== 1 : args.join('\0') !== expected.join('\0')) throw new Error('Invalid setup arguments.');
if (Boolean(recipePath || bootstrapBase) !== allowNetwork) throw new Error('Dependency recipes or fresh base provisioning require explicit --allow-network; ordinary stdlib setup has no network.');
const inspect = () => JSON.parse(execFileSync(docker, ['image', 'inspect', target], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }))[0];
function verify() {
  const image = inspect();
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Architecture !== 'arm64' || image.Config?.Labels?.['io.agent-workspaces.code.protocol'] !== '4' || image.Config?.Volumes) throw new Error('Code image verification failed.');
  process.stdout.write(JSON.stringify({ imageDigest: image.Id, packages: JSON.parse(image.Config.Labels['io.agent-workspaces.code.packages']) }) + '\n');
}
execFileSync(docker, ['version', '--format', '{{.Server.Version}}'], { stdio: 'inherit', timeout: 10000 });
if (args[0] === '--check') { verify(); process.exit(0); }
const disk = statfsSync(root); if (disk.bavail * disk.bsize < 8 * 1024 ** 3) throw new Error('Image setup requires at least 8 GiB free disk.');
const portable = bootstrapBase ? await ensurePortableBase({ docker, allowNetwork }) : null;
const selectedBaseTag = portable?.tag || baseTag, selectedBaseId = portable?.imageId || baseId;
const currentBase = () => execFileSync(docker, ['image', 'inspect', selectedBaseTag, '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 10000 }).trim();
if (currentBase() !== selectedBaseId) throw new Error('Pinned local base is missing or changed. Use explicit --bootstrap-base --allow-network for fresh provisioning.');
const context = await mkdtemp(join(tmpdir(), 'aw-code-build-'));
try {
  await mkdir(join(context, 'workers'), { recursive: true }); await cp(join(root, 'workers/code'), join(context, 'workers/code'), { recursive: true });
  let dockerfile = await readFile(join(root, 'containers/code/Dockerfile'), 'utf8');
  if (portable) dockerfile = dockerfile.replace(/^FROM agent-workspaces-phase0-code:2026-09-11$/m, `FROM ${selectedBaseTag}`) + `\nLABEL io.agent-workspaces.code.base-recipe=${JSON.stringify(portable.recipe)}\nLABEL io.agent-workspaces.code.official-base=${JSON.stringify(portable.official)}\nLABEL io.agent-workspaces.code.resolved-base=${JSON.stringify(selectedBaseId)}\n`;
  if (recipePath) {
    const recipeFile = resolve(recipePath), info = await lstat(recipeFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('Recipe must be a bounded independent regular JSON file.');
    const recipe = validateRecipe(JSON.parse(await readFile(recipeFile, 'utf8')));
    await mkdir(join(context, 'approved'));
    if (recipe.python.length) {
      await writeFile(join(context, 'approved/requirements.txt'), recipe.python.map(p => `${p.name}==${p.version} --hash=sha256:${p.sha256}`).join('\n') + '\n');
      await writeFile(join(context, 'approved/python.json'), JSON.stringify(recipe.python));
      await writeFile(join(context, 'approved/verify.py'), "import json,importlib.metadata\nfor item in json.load(open('/opt/approved/python.json')):\n assert importlib.metadata.version(item['name']) == item['version'], 'installed Python version differs'\n");
      dockerfile += `\nCOPY approved/requirements.txt approved/python.json approved/verify.py /opt/approved/\nRUN apk add --no-cache py3-pip=${recipe.pipApkVersion} && python3 -m venv /opt/code-venv && /opt/code-venv/bin/python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: --require-hashes -r /opt/approved/requirements.txt && /opt/code-venv/bin/python -I /opt/approved/verify.py\n`;
    }
    if (recipe.node) {
      const source = dirname(recipeFile);
      for (const name of ['package.json', 'package-lock.json']) {
        const path = join(source, name), stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('Node recipe files must be bounded independent regular JSON files beside the recipe.');
        await cp(path, join(context, 'approved', name));
      }
      const packageJson = JSON.parse(await readFile(join(context, 'approved/package.json'), 'utf8'));
      const lock = JSON.parse(await readFile(join(context, 'approved/package-lock.json'), 'utf8'));
      const wanted = Object.fromEntries(recipe.node.map(p => [p.name, p.version]));
      if (JSON.stringify(Object.entries(packageJson.dependencies || {}).sort()) !== JSON.stringify(Object.entries(wanted).sort()) || packageJson.devDependencies || packageJson.optionalDependencies || lock.lockfileVersion !== 3 || !lock.packages || Object.keys(lock.packages).length > 513) throw new Error('Node dependency manifest must exactly match the recipe and use a bounded v3 lockfile.');
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (!path) continue;
        if (!/^node_modules\/(?:[a-zA-Z0-9_@.-]+\/)*[a-zA-Z0-9_.-]+$/.test(path) || path.split('/').some(p => p === '.' || p === '..') || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved || '') || !/^sha(?:256|512)-[a-zA-Z0-9+/]+=*$/.test(entry.integrity || '') || entry.link || typeof entry.version !== 'string' || !/^\d[^\s]*$/.test(entry.version)) throw new Error('Node lock entries require registry URLs, exact versions and integrity hashes; links and alternate sources are denied.');
      }
      await writeFile(join(context, 'approved/node.json'), JSON.stringify(recipe.node));
      await writeFile(join(context, 'approved/verify.cjs'), "const fs=require('node:fs');for(const p of JSON.parse(fs.readFileSync('/opt/approved/node.json','utf8'))){if(JSON.parse(fs.readFileSync('/opt/code-node/node_modules/'+p.name+'/package.json','utf8')).version!==p.version)throw new Error('installed Node version differs')}\n");
      dockerfile += '\nCOPY approved/package*.json /opt/code-node/\nCOPY approved/node.json approved/verify.cjs /opt/approved/\nRUN npm ci --prefix /opt/code-node --ignore-scripts --omit=dev --no-audit --no-fund && node /opt/approved/verify.cjs\n';
    }
    const packages = [...recipe.python.map(({ name, version }) => ({ runtime: 'python', name, version })), ...(recipe.node || []).map(({ name, version }) => ({ runtime: 'node', name, version }))];
    dockerfile += `\nLABEL io.agent-workspaces.code.packages=${JSON.stringify(JSON.stringify(packages))}\n`;
  }
  await writeFile(join(context, 'Dockerfile'), dockerfile);
  const child = spawn(docker, ['build', '--pull=false', `--network=${allowNetwork ? 'default' : 'none'}`, '-f', join(context, 'Dockerfile'), '-t', target, context], { stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Code image build failed; the previous image tag remains available.'))); });
  if (currentBase() !== selectedBaseId) throw new Error('Pinned base tag changed during setup.'); verify();
} finally { await rm(context, { recursive: true, force: true }); }
