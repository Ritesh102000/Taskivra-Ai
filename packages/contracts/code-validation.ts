import { CODE_LIMITS, type CodeCommand, type CodeLanguage } from './code';
import { CommandValidationError } from './validation';

function fail(message = 'This execution command has unsupported or missing fields.'): never { throw new CommandValidationError(message); }
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) fail('Select an existing task or execution.'); return value; }
function text(value: unknown, max: number): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > max) fail('The execution input is empty or exceeds its limit.'); return value; }
export function dependencyName(value: unknown, runtime: 'python' | 'node'): string {
  const name = text(value, 128);
  if (!(runtime === 'python' ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/ : /^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/).test(name)) fail('Enter a registry package name, without a URL, path, or command.');
  return name;
}
export function dependencyVersion(value: unknown): string {
  const version = text(value, 64);
  if (!/^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(version)) fail('Choose an exact package version; ranges and URLs are not accepted.');
  return version;
}
export function parseCodeCommand(raw: unknown): CodeCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail();
  const v = raw as Record<string, unknown>;
  let bytes = 0; try { bytes = Buffer.byteLength(JSON.stringify(v)); } catch { fail(); }
  if (bytes > 300_000) fail('The code command is too large.');
  const keys = (fields: string[]) => { const expected = ['type', 'taskId', ...fields]; if (expected.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !expected.includes(k))) fail(); };
  const taskId = id(v.taskId);
  switch (v.type) {
    case 'code.state': keys([]); return { type: v.type, taskId };
    case 'code.execute': {
      keys(['runtime', 'source', 'timeoutSeconds', 'inputVersionIds']);
      if (!['python', 'node', 'shell'].includes(v.runtime as string)) fail('Select Python, Node, or shell inside the isolated container.');
      if (!Number.isSafeInteger(v.timeoutSeconds) || Number(v.timeoutSeconds) < 1 || Number(v.timeoutSeconds) > CODE_LIMITS.timeoutSeconds) fail('Execution timeout must be between 1 and 120 seconds.');
      if (!Array.isArray(v.inputVersionIds) || v.inputVersionIds.length > CODE_LIMITS.inputs) fail('Select at most 128 task input versions.');
      const inputVersionIds = v.inputVersionIds.map(id);
      if (new Set(inputVersionIds).size !== inputVersionIds.length) fail('A file version can only be selected once.');
      return { type: v.type, taskId, runtime: v.runtime as CodeLanguage, source: text(v.source, CODE_LIMITS.sourceBytes), timeoutSeconds: Number(v.timeoutSeconds), inputVersionIds };
    }
    case 'code.stop': keys(['executionId']); return { type: v.type, taskId, executionId: id(v.executionId) };
    case 'code.requestDependency': {
      keys(['runtime', 'packageName', 'version', 'reason']);
      if (v.runtime !== 'python' && v.runtime !== 'node') fail('Dependency requests support Python and Node packages.');
      return { type: v.type, taskId, runtime: v.runtime, packageName: dependencyName(v.packageName, v.runtime), version: dependencyVersion(v.version), reason: text(v.reason, 1000) };
    }
    case 'code.resolveDependency': {
      keys(['requestId', 'revision']);
      if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1) fail('Refresh the dependency request before checking it.');
      return { type: v.type, taskId, requestId: id(v.requestId), revision: Number(v.revision) };
    }
    default: return fail();
  }
}
