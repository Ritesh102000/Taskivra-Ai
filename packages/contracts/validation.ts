import type { Command, Settings } from './index';

export class CommandValidationError extends Error {
  readonly code = 'invalid_command';
}
function fail(message = 'This command is not supported.'): never { throw new CommandValidationError(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], required = allowed): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('The command contains missing or unsupported fields.');
}
function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`${field} is invalid or too long.`);
  const result = value.trim();
  if (!allowEmpty && !result) fail(`${field} is required.`);
  return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(value)) fail('The selected item is invalid.');
  return value;
}
export function parseCommand(raw: unknown): Command {
  const v = object(raw);
  // Limit transport data before any database work; no code, paths, or SQL fields exist.
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(v)); } catch { return fail(); }
  if (bytes > 32768) fail('The command is too large.');
  switch (v.type) {
    case 'snapshot': case 'simulation.step':
      keys(v, ['type']); return { type: v.type };
    case 'agents.create':
      keys(v, ['type', 'name', 'instructions']);
      return { type: v.type, name: text(v.name, 'Agent name', 80), instructions: text(v.instructions, 'Instructions', 8000, true) };
    case 'tasks.create':
      keys(v, ['type', 'agentId', 'objective', 'completionCriteria', 'scenario']);
      if (!['clarification', 'complete', 'failure'].includes(v.scenario as string)) fail('Select a supported simulation scenario.');
      return { type: v.type, agentId: id(v.agentId), objective: text(v.objective, 'Task', 4000), completionCriteria: text(v.completionCriteria, 'Completion criteria', 4000, true), scenario: v.scenario as 'clarification' | 'complete' | 'failure' };
    case 'tasks.message':
      keys(v, ['type', 'taskId', 'content']);
      return { type: v.type, taskId: id(v.taskId), content: text(v.content, 'Message', 8000) };
    case 'tasks.pause': case 'tasks.resume': case 'tasks.cancel':
      keys(v, ['type', 'taskId']); return { type: v.type, taskId: id(v.taskId) };
    case 'requests.respond':
      keys(v, ['type', 'requestId', 'revision', 'response']);
      if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 1) fail('The request revision is invalid.');
      return { type: v.type, requestId: id(v.requestId), revision: v.revision as number, response: text(v.response, 'Answer', 8000) };
    case 'settings.update': {
      keys(v, ['type', 'settings']); const s = object(v.settings);
      keys(s, ['theme', 'driverEnabled', 'maxActiveAgents'], []);
      if (!Object.keys(s).length) fail('Select a setting to update.');
      if (Object.hasOwn(s, 'theme') && !['system', 'light', 'dark'].includes(s.theme as string)) fail('Select a supported appearance.');
      if (Object.hasOwn(s, 'driverEnabled') && typeof s.driverEnabled !== 'boolean') fail('Simulation auto-run must be on or off.');
      if (Object.hasOwn(s, 'maxActiveAgents') && (!Number.isInteger(s.maxActiveAgents) || ![1, 2].includes(s.maxActiveAgents as number))) fail('Choose one or two active simulated agents.');
      return { type: v.type, settings: { ...s } as Partial<Settings> };
    }
    default: return fail();
  }
}
