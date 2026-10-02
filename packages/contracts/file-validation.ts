import type { FileCommand, ImportTarget } from './index';
import { CommandValidationError } from './validation';

function fail(message = 'This file command is not supported.'): never { throw new CommandValidationError(message); }
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail();
  return raw as Record<string, unknown>;
}
function fields(raw: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => !required.includes(key) && !optional.includes(key))) fail('The file command contains missing or unsupported fields.');
}
export function artifactId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(raw)) fail('Select a valid file or task.');
  return raw;
}
export function parseImportTarget(raw: unknown): ImportTarget {
  const value = record(raw); fields(value, ['scope', 'agentId', 'taskId']);
  if (value.scope === 'shared') {
    if (value.agentId !== null || value.taskId !== null) fail('A shared import cannot silently target a private task.');
    return { scope: 'shared', agentId: null, taskId: null };
  }
  if (value.scope !== 'private') fail('Choose private or shared storage.');
  return { scope: 'private', agentId: artifactId(value.agentId), taskId: value.taskId === null ? null : artifactId(value.taskId) };
}
export function parseFileCommand(raw: unknown): FileCommand {
  const value = record(raw);
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { return fail(); }
  if (bytes > 16384) fail('The file command is too large.');
  switch (value.type) {
    case 'repository.preview':
      fields(value,['type','projectId','agentId']);return {type:value.type,projectId:artifactId(value.projectId),agentId:artifactId(value.agentId)};
    case 'repository.capture':
      fields(value,['type','projectId','agentId','previewId','identity']);if(typeof value.identity!=='string'||!/^[a-f0-9]{64}$/.test(value.identity))fail('Review the exact snapshot identity.');return {type:value.type,projectId:artifactId(value.projectId),agentId:artifactId(value.agentId),previewId:artifactId(value.previewId),identity:value.identity};
    case 'files.pick':
      fields(value, ['type', 'target'], ['artifactId']);
      return { type: value.type, target: parseImportTarget(value.target), ...(Object.hasOwn(value, 'artifactId') ? { artifactId: artifactId(value.artifactId) } : {}) };
    case 'artifacts.publish': case 'artifacts.export': case 'artifacts.repair':
      fields(value, ['type', 'versionId']); return { type: value.type, versionId: artifactId(value.versionId) };
    case 'artifacts.use':
      fields(value, ['type', 'versionId', 'taskId']); return { type: value.type, versionId: artifactId(value.versionId), taskId: artifactId(value.taskId) };
    case 'storage.updateBudget':
      fields(value, ['type', 'budgetBytes']);
      if (!Number.isSafeInteger(value.budgetBytes) || (value.budgetBytes as number) < 256 * 1024 * 1024 || (value.budgetBytes as number) > 20 * 1024 * 1024 * 1024) fail('Choose a storage budget between 256 MiB and 20 GiB.');
      return { type: value.type, budgetBytes: value.budgetBytes as number };
    default: return fail();
  }
}
/** Internal preload payload only: renderer command APIs never accept path strings. */
export function parseDropPayload(raw: unknown): { target: ImportTarget; paths: string[] } {
  const value = record(raw); fields(value, ['target', 'paths']);
  if (!Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > 32) fail('Drop between 1 and 32 files.');
  const paths = value.paths.map(path => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || path.includes('\0')) fail('A dropped item is not a local file.');
    return path;
  });
  return { target: parseImportTarget(value.target), paths };
}
