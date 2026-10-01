import type { ArtifactVersion, InputRequest, LiveState, LiveTaskState, Snapshot, Task, UserRequest } from '../../../packages/contracts/index';

export const hasLiveProgress = (run?: LiveTaskState) => Boolean(run && (run.calls > 0 || run.steps > 0 || run.activeSeconds > 0));
const terminal = new Set<Task['state']>(['succeeded', 'failed', 'cancelled']);
const active = new Set<Task['state']>(['running', 'pausing', 'recovering', 'queued', 'paused']);
const pending = new Set(['open', 'partial', 'checking', 'needs_correction']);

/** Presentation derived only from saved state. A file by itself is not task completion. */
export function summarizeWorkspace(snapshot: Pick<Snapshot, 'tasks'>, inputRequests: (InputRequest | UserRequest)[], live: LiveState | null) {
  const byUpdated = (a: Task, b: Task) => b.updatedAt - a.updatedAt;
  const taskById = new Map(snapshot.tasks.map(task => [task.id, task]));
  const requests = [...new Map(inputRequests.filter(request => pending.has(request.state) && !terminal.has(taskById.get(request.taskId)?.state as Task['state'])).map(request => [request.id, request])).values()];
  const needsInput = new Set(requests.map(request => request.taskId));
  const problems = snapshot.tasks.filter(task => !needsInput.has(task.id) && (task.state === 'failed' || task.state === 'waiting' || live?.tasks.some(run => run.taskId === task.id && run.lastError && !terminal.has(task.state)))).sort(byUpdated);
  return {
    requests,
    active: snapshot.tasks.filter(task => active.has(task.state)).sort(byUpdated),
    problems,
    results: snapshot.tasks.filter(task => task.state === 'succeeded').sort(byUpdated),
    attention: requests.length + problems.length,
    working: snapshot.tasks.filter(task => task.state === 'running').length,
    isEmpty: snapshot.tasks.length === 0,
  };
}

export function completedResult(task: Task, artifacts: ArtifactVersion[], live: LiveState | null): ArtifactVersion | undefined {
  if (task.state !== 'succeeded' || task.executionMode !== 'live') return undefined;
  const id = live?.tasks.find(run => run.taskId === task.id)?.resultVersionId;
  return artifacts.find(artifact => artifact.id === id && artifact.producerTaskId === task.id && artifact.status === 'ready');
}
