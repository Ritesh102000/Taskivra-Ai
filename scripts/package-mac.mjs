// Local Apple Silicon packaging only: uses the installed Electron runtime, never installs or downloads.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_FILES = [
  'THIRD_PARTY_NOTICES.md', 'dist/build-provenance.json',
  'licenses/PLAYWRIGHT-LICENSE.txt', 'licenses/PLAYWRIGHT-NOTICE.txt',
  'licenses/DOCKER-SECCOMP-LICENSE.txt', 'licenses/DOCKER-SECCOMP-NOTICE.txt',
  'labs/harbor-desk/server.mjs', 'labs/harbor-desk/domain.mjs', 'labs/harbor-desk/policy.mjs',
  'labs/harbor-desk/ticket-service.mjs', 'labs/harbor-desk/export-service.mjs', 'labs/harbor-desk/share-service.mjs',
  'labs/harbor-desk/public/index.html', 'labs/harbor-desk/public/app.js',
  'dist/main/report-format-worker.cjs', 'dist/main/main.cjs', 'dist/main/preload.cjs', 'dist/main/browser-seccomp.json',
  'packages/native-browser/native-host.mjs', 'packages/native-browser/framing.mjs',
  'packages/native-browser/bin/native-host', 'packages/native-browser/bin/profile-parent',
  'packages/model-adapters/bin/keychain-helper', 'packages/gmail/bin/keychain-helper',
  'packages/google-workspace/bin/keychain-helper',
  'packages/code-runtime/setup.mjs', 'packages/code-runtime/recipe.mjs', 'packages/code-runtime/portable-base.mjs',
  'containers/code/Dockerfile', 'containers/code/documents-recipe.json',
  'workers/code/supervisor.py', 'workers/code/seed.py', 'workers/code/export_protocol.py', 'workers/code/exporter.py',
  'extensions/agent-browser/manifest.json', 'extensions/agent-browser/background.mjs',
  'extensions/agent-browser/gmail.mjs', 'extensions/agent-browser/page.mjs',
  'extensions/agent-browser/policy.mjs', 'extensions/agent-browser/session.mjs',
  'extensions/agent-browser/status.html', 'extensions/agent-browser/status.js',
];
export const NATIVE_HELPERS = RUNTIME_FILES.filter(path => path.includes('/bin/'));
const root = fileURLToPath(new URL('../', import.meta.url));
const allowedRendererTypes = new Set(['.html', '.js', '.css', '.svg', '.png', '.ico', '.webp', '.woff', '.woff2', '.ttf']);
async function regularFile(path, maxBytes = 128 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error(`Expected bounded regular build file: ${relative(root, path)}`);
  return stat;
}
async function rendererFiles(directory, prefix = 'dist/renderer') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), logical = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || /[\\\x00-\x1f]/.test(entry.name)) throw new Error('Unexpected renderer build entry.');
    if (entry.isDirectory()) result.push(...await rendererFiles(path, logical));
    else if (entry.isFile() && allowedRendererTypes.has(extname(entry.name))) result.push(logical);
    else throw new Error(`Unexpected renderer build asset: ${logical}`);
  }
  if (result.length > 512) throw new Error('Renderer build exceeds the package file limit.');
  return result;
}
function arm64(path) {
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8', timeout: 10_000 }).trim().split(/\s+/);
  if (!architectures.includes('arm64')) throw new Error(`Apple Silicon binary required: ${relative(root, path)}`);
}
export async function packageInventory(sourceRoot = root, { checkArchitecture = true } = {}) {
  const metadata = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Invalid application version.');
  const files = [...RUNTIME_FILES, ...await rendererFiles(join(sourceRoot, 'dist/renderer'))];
  if (!files.includes('dist/renderer/index.html')) throw new Error('Build the renderer before packaging.');
  const entries = [];
  for (const path of files) {
    // Reject replaced ancestors as well as file links; only app-owned build/resources are packaged.
    let cursor = sourceRoot;
    for (const part of path.split('/').slice(0, -1)) { cursor = join(cursor, part); const stat = await lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked package directories are not permitted.'); }
    const full = join(sourceRoot, path), stat = await regularFile(full);
    if (NATIVE_HELPERS.includes(path)) { await access(full, constants.X_OK); if (checkArchitecture) arm64(full); }
    entries.push({ path, bytes: stat.size, sha256: createHash('sha256').update(await readFile(full)).digest('hex'), executable: NATIVE_HELPERS.includes(path) });
  }
  return { version: metadata.version, entries, bytes: entries.reduce((total, item) => total + item.bytes, 0) };
}
export async function packageMac({ sourceRoot = root, destination, inventoryOnly = false } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Local packaging requires an Apple Silicon Mac.');
  const inventory = await packageInventory(sourceRoot), electron = join(sourceRoot, 'node_modules/electron/dist/Electron.app');
  await access(join(electron, 'Contents/MacOS/Electron'), constants.X_OK); arm64(join(electron, 'Contents/MacOS/Electron'));
  const electronVersion = (await readFile(join(sourceRoot, 'node_modules/electron/dist/version'), 'utf8')).trim();
  if (inventoryOnly) return { version: inventory.version, electronVersion, fileCount: inventory.entries.length, payloadBytes: inventory.bytes, signing: 'local ad-hoc only; no Developer ID or notarization' };
  const output = resolve(destination || join(sourceRoot, 'dist/packages', `Agent-Workspaces-${inventory.version}-arm64-local`));
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  const canonical = join(parent, output.split('/').at(-1));
  const space = await statfs(parent);
  if (space.bavail * space.bsize < 2 * 1024 ** 3) throw new Error('Local packaging requires at least 2 GiB free disk.');
  // Refuse every existing output, even empty directories. An unfinished build keeps its marker.
  await mkdir(canonical, { mode: 0o700 });
  await writeFile(join(canonical, '.package-incomplete'), 'This package is incomplete.\n', { mode: 0o600, flag: 'wx' });
  const application = join(canonical, 'Agent Workspaces.app');
  await cp(electron, application, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
  const resources = join(application, 'Contents/Resources'), app = join(resources, 'app');
  await mkdir(app, { mode: 0o755 });
  for (const entry of inventory.entries) {
    const outputPath = join(app, entry.path); await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(join(sourceRoot, entry.path), outputPath, constants.COPYFILE_EXCL);
    await chmod(outputPath, entry.executable ? 0o755 : 0o644);
    const actual = createHash('sha256').update(await readFile(outputPath)).digest('hex');
    if (actual !== entry.sha256) throw new Error('Build inputs changed during packaging. Rebuild and retry.');
  }
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'agent-workspaces', productName: 'Agent Workspaces', version: inventory.version, private: true, type: 'module', main: 'dist/main/main.cjs' }, null, 2), { flag: 'wx' });
  await rm(join(resources, 'default_app.asar'), { force: true });
  await mkdir(join(resources, 'licenses'));
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) await copyFile(join(sourceRoot, 'node_modules/electron/dist', name), join(resources, 'licenses', name), constants.COPYFILE_EXCL);
  for (const name of ['react', 'react-dom']) await copyFile(join(sourceRoot, 'node_modules', name, 'LICENSE'), join(resources, 'licenses', `${name}-LICENSE`), constants.COPYFILE_EXCL);
  const plist = join(application, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({ CFBundleDisplayName: 'Agent Workspaces', CFBundleName: 'Agent Workspaces', CFBundleIdentifier: 'dev.agentworkspaces.local', CFBundleShortVersionString: inventory.version, CFBundleVersion: inventory.version })) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'pipe', timeout: 10_000 });
  }
  // This repairs the copied bundle's signature after metadata changes. It is NOT a distribution identity.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', application], { stdio: 'pipe', timeout: 120_000 });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], { stdio: 'pipe', timeout: 60_000 });
  const manifest = { format: 'agent-workspaces-local-package', version: 1, appVersion: inventory.version, electronVersion, architecture: 'arm64', createdAt: new Date().toISOString(), signing: 'ad-hoc; no Developer ID; not notarized', includedFiles: inventory.entries, externalRequirements: ['Google Chrome and per-agent extension setup for native browsing', 'Docker Desktop and prebuilt approved runtime images for code and isolated browser execution', 'Owner-configured hosted or local model connection; OAuth for Gmail', 'Host /usr/bin/python3 for the optional reviewed repository snapshot pilot'], omitted: ['Personal data and browser profiles', 'Credentials and environment files', 'Development node_modules', 'Docker images', 'Dependency installers'] };
  await writeFile(join(canonical, 'package-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  await unlink(join(canonical, '.package-incomplete'));
  return { directory: canonical, application, version: inventory.version, electronVersion, fileCount: inventory.entries.length, signing: manifest.signing };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), inventoryOnly = args[0] === '--check';
  if (!(args.length === 0 || (inventoryOnly && args.length === 1) || (args[0] === '--out' && args.length === 2))) throw new Error('Use package-mac.mjs [--check | --out NEW_DIRECTORY]. Build the app first.');
  console.log(JSON.stringify(await packageMac({ inventoryOnly, destination: args[0] === '--out' ? args[1] : undefined }), null, 2));
}
