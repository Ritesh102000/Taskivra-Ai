import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Official ARM64 manifest and exact Alpine Python package; no machine-generated image ID is required.
export const PORTABLE_CODE_BASE = {
  image: 'node:24.14.0-alpine3.23@sha256:0e0d39e04fdf3dc5f450a07922573bac666d28920df2df3f3b1540b0aba7ab98',
  pythonApk: '3.12.14-r0',
  tag: 'agent-workspaces-base-code:20260930',
};
export const PORTABLE_BASE_DOCKERFILE = `FROM ${PORTABLE_CODE_BASE.image}\nRUN apk add --no-cache python3=${PORTABLE_CODE_BASE.pythonApk} && mkdir -p /workspace /shared /opt/agent-code\n`;
const RECIPE = createHash('sha256').update(PORTABLE_BASE_DOCKERFILE).digest('hex');
export function verifyPortableBase(image) {
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Architecture !== 'arm64' || image.Config?.Volumes || image.Config?.Labels?.['io.agent-workspaces.base.recipe'] !== RECIPE || image.Config?.Labels?.['io.agent-workspaces.base.official'] !== PORTABLE_CODE_BASE.image) throw new Error('Portable base provenance verification failed; existing tags were preserved.');
  return image.Id;
}
export async function ensurePortableBase({ docker, allowNetwork }) {
  const inspect = () => JSON.parse(execFileSync(docker, ['image', 'inspect', PORTABLE_CODE_BASE.tag], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 1024 * 1024 }))[0];
  let existing;
  try { existing = inspect(); } catch (error) { if (error.status !== 1) throw error; }
  if (existing) return { imageId: verifyPortableBase(existing), tag: PORTABLE_CODE_BASE.tag, official: PORTABLE_CODE_BASE.image, recipe: RECIPE, built: false };
  if (!allowNetwork) throw new Error('Fresh base setup requires explicit --bootstrap-base --allow-network. No download was attempted.');
  const context = await mkdtemp(join(tmpdir(), 'aw-portable-code-base-'));
  try {
    await writeFile(join(context, 'Dockerfile'), PORTABLE_BASE_DOCKERFILE, { mode: 0o600, flag: 'wx' });
    const child = spawn(docker, ['build', '--platform=linux/arm64', '--pull=false', '--network=default', '--label', `io.agent-workspaces.base.recipe=${RECIPE}`, '--label', `io.agent-workspaces.base.official=${PORTABLE_CODE_BASE.image}`, '-t', PORTABLE_CODE_BASE.tag, context], { stdio: 'inherit' });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Portable base build failed. Existing runtime image tags were preserved.'))); });
    return { imageId: verifyPortableBase(inspect()), tag: PORTABLE_CODE_BASE.tag, official: PORTABLE_CODE_BASE.image, recipe: RECIPE, built: true };
  } finally { await rm(context, { recursive: true, force: true }); }
}
