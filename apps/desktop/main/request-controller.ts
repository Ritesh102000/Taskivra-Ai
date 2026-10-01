import type { Coordinator } from '../../../packages/coordinator/index';
import type { RequestPick, UserRequest } from '../../../packages/contracts/index';
import { parseRequestCommand } from '../../../packages/contracts/request-validation';
import { CommandValidationError } from '../../../packages/contracts/validation';

export function parseRequestPick(raw: unknown): RequestPick {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.keys(raw).some(key => !['requestId', 'revision', 'slotId', 'slotRevision'].includes(key))) throw new CommandValidationError('Select a current file-request slot.');
  const value = raw as Record<string, unknown>;
  const parsed = parseRequestCommand({ type: 'requests.assign', requestId: value.requestId, revision: value.revision, assignments: [{ slotId: value.slotId, slotRevision: value.slotRevision, versionId: 'native-file-pending' }] });
  if (parsed.type !== 'requests.assign') throw new CommandValidationError('Select a current file-request slot.');
  return { requestId: parsed.requestId, revision: parsed.revision, slotId: parsed.assignments[0].slotId, slotRevision: parsed.assignments[0].slotRevision };
}

/** Native paths stay in main. A candidate is attached to the task only after validation. */
export class RequestController {
  private busy = false;
  constructor(private coordinator: Coordinator, private pickFile: (request: UserRequest, label: string) => Promise<string | null>) {}
  async pick(raw: unknown): Promise<{ requests: UserRequest[]; cancelled: boolean }> {
    const command = parseRequestPick(raw);
    if (this.busy) throw new CommandValidationError('Finish the current file selection before opening another.');
    this.busy = true;
    try {
      const requests = await this.coordinator.requests.handle({ type: 'requests.list', taskId: null });
      const request = requests.find(item => item.id === command.requestId), slot = request?.slots.find(item => item.id === command.slotId);
      if (!request || request.kind !== 'files' || !slot || ['fulfilled', 'cancelled', 'superseded'].includes(request.state) || request.revision !== command.revision || slot.revision !== command.slotRevision) throw new CommandValidationError('This file request changed. Refresh it before selecting a replacement.');
      const task = this.coordinator.snapshot().tasks.find(item => item.id === request.taskId);
      if (!task || ['cancelled', 'failed', 'succeeded'].includes(task.state)) throw new CommandValidationError('This task is no longer accepting files.');
      const path = await this.pickFile(request, slot.label);
      if (!path) return { requests: await this.coordinator.requests.handle({ type: 'requests.list', taskId: null }), cancelled: true };
      const imported = await this.coordinator.artifacts.importFiles({ principal: { kind: 'owner' }, target: { scope: 'private', agentId: request.agentId, taskId: null }, paths: [path] });
      const versionId = imported.versionIds[0];
      if (!versionId) throw new CommandValidationError('The chosen file did not produce an imported version.');
      const updated = await this.coordinator.requests.handle({ type: 'requests.assign', requestId: command.requestId, revision: command.revision, assignments: [{ slotId: command.slotId, slotRevision: command.slotRevision, versionId }] });
      return { requests: updated, cancelled: false };
    } finally { this.busy = false; }
  }
}
