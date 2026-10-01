import type { Coordinator } from '../../../packages/coordinator/index';
import type { ArtifactPreview, FileActionResult, ImportTarget } from '../../../packages/contracts/index';
import { artifactId, parseDropPayload, parseFileCommand } from '../../../packages/contracts/file-validation';
import { CommandValidationError } from '../../../packages/contracts/validation';

export interface FileDialogs {
  pick(target: ImportTarget, singleFile: boolean): Promise<string[]>;
  save(displayName: string): Promise<string | null>;
}
const OWNER = { kind: 'owner' } as const;
const DEFERRED_DELIVERY = 'File saved privately; task delivery waits for the active code execution.';

/** Paths come only from native dialogs or Electron-authenticated dropped File objects. */
export class FileController {
  private busy = false;
  constructor(private readonly coordinator: Coordinator, private readonly dialogs: FileDialogs) {}

  private assertTarget(target: ImportTarget): void {
    const snapshot = this.coordinator.snapshot();
    if (target.scope === 'private') {
      if (!snapshot.agents.some(agent => agent.id === target.agentId)) throw new CommandValidationError('Select the agent that should receive these files.');
      if (target.taskId && !snapshot.tasks.some(task => task.id === target.taskId && task.agentId === target.agentId)) throw new CommandValidationError('The selected task belongs to a different agent.');
    }
  }
  private async exclusive(work: () => Promise<FileActionResult>): Promise<FileActionResult> {
    if (this.busy) throw new CommandValidationError('Finish the current file operation before starting another.');
    this.busy = true;
    try { await this.coordinator.artifacts.ready; return await work(); }
    finally { this.busy = false; }
  }
  async run(raw: unknown): Promise<FileActionResult> {
    const command = parseFileCommand(raw);
    return this.exclusive(async () => {
      switch (command.type) {
        case 'files.pick': {
          this.assertTarget(command.target);
          const paths = await this.dialogs.pick(command.target, Boolean(command.artifactId));
          if (!paths.length) return { snapshot: this.coordinator.snapshot(), cancelled: true };
          const result = await this.coordinator.artifacts.importFiles({ principal: OWNER, target: command.target, paths, ...(command.artifactId ? { artifactId: command.artifactId } : {}) });
          return { snapshot: this.coordinator.snapshot(), versionIds: result.versionIds, ...(result.deliveryDeferred ? { warnings: [DEFERRED_DELIVERY] } : {}) };
        }
        case 'artifacts.publish': {
          const result = await this.coordinator.artifacts.publish({ principal: OWNER, versionId: command.versionId });
          return { snapshot: this.coordinator.snapshot(), versionIds: result.versionIds };
        }
        case 'artifacts.use': {
          const result=await this.coordinator.artifacts.useInTask({ principal: OWNER, taskId: command.taskId, versionId: command.versionId });
          return { snapshot: this.coordinator.snapshot(), versionIds: [command.versionId], ...(result?.deliveryDeferred ? { warnings: ['File selection saved; task delivery waits for the active code execution.'] } : {}) };
        }
        case 'artifacts.export': {
          const version = this.coordinator.snapshot().artifacts.find(item => item.id === command.versionId);
          if (!version || version.status !== 'ready') throw new CommandValidationError('Select an available file version to export.');
          const destination = await this.dialogs.save(version.displayName);
          if (!destination) return { snapshot: this.coordinator.snapshot(), cancelled: true };
          await this.coordinator.artifacts.exportFile({ principal: OWNER, versionId: command.versionId, destination });
          return { snapshot: this.coordinator.snapshot(), exported: true };
        }
        case 'storage.updateBudget':
          await this.coordinator.artifacts.updateBudget(command.budgetBytes);
          return { snapshot: this.coordinator.snapshot() };
      }
    });
  }
  async drop(raw: unknown): Promise<FileActionResult> {
    const { target, paths } = parseDropPayload(raw);
    return this.exclusive(async () => {
      this.assertTarget(target);
      const result = await this.coordinator.artifacts.importFiles({ principal: OWNER, target, paths });
      return { snapshot: this.coordinator.snapshot(), versionIds: result.versionIds, ...(result.deliveryDeferred ? { warnings: [DEFERRED_DELIVERY] } : {}) };
    });
  }
  async preview(raw: unknown): Promise<ArtifactPreview> {
    const versionId = artifactId(raw);
    await this.coordinator.artifacts.ready;
    return this.coordinator.artifacts.preview({ principal: OWNER, versionId });
  }
}
