import type { InputRequest, LiveState, Snapshot, Task, UserRequest } from '../../../packages/contracts/index';
import { useFilePreview } from './Files';
import { completedResult, hasLiveProgress, summarizeWorkspace } from './workspace-summary';
import './overview.css';

interface OverviewProps {
  snapshot: Snapshot;
  requests: (InputRequest | UserRequest)[];
  live: LiveState | null;
  onTask: (task: Task, panel?: 'browser' | 'activity' | 'files') => void;
  onWorkflows: () => void;
  onTasks: () => void;
  onRequests: () => void;
  onSettings: () => void;
}

const labels: Record<Task['state'], string> = { queued: 'Ready to run', running: 'Working', waiting: 'Needs you', pausing: 'Pausing', paused: 'Paused', recovering: 'Recovering', succeeded: 'Completed', failed: 'Needs attention', cancelled: 'Stopped' };

export function Overview({ snapshot, requests: inputRequests, live, onTask, onWorkflows, onTasks, onRequests, onSettings }: OverviewProps) {
  const preview = useFilePreview();
  const { requests, active, problems, results, attention, working, isEmpty } = summarizeWorkspace(snapshot, inputRequests, live);
  const agentName = (task: Task) => snapshot.agents.find(agent => agent.id === task.agentId)?.name || 'Agent';
  return <div className="page-scroll overview-page">
    <section className="overview-heading">
      <div><span className="eyebrow">YOUR WORK, IN MOTION</span><h1>{isEmpty ? 'What would you like to get done?' : 'Your workspace, at a glance.'}</h1><p>Give your agents an outcome. Keep the decisions that matter.</p></div>
      <button className="button primary" onClick={onWorkflows}>Start a workflow <span aria-hidden="true">↗</span></button>
    </section>

    <div className="overview-status-bar" aria-label="Workspace status">
      <button onClick={onTasks}><span className="overview-indicator working" /><strong>{working}</strong> working</button>
      <button onClick={() => requests.length ? onRequests() : problems[0] ? onTask(problems[0], 'activity') : onRequests()}><span className={'overview-indicator' + (attention ? ' attention' : '')} /><strong>{attention}</strong> need attention</button>
      <button onClick={onTasks}><span className="overview-indicator complete" /><strong>{results.length}</strong> completed</button>
      <span className="overview-private">Private agents · Saved on this Mac</span>
    </div>

    {live && !live.credentialConfigured && <section className="overview-setup" aria-label="Model connection needed"><span className="overview-setup-symbol" aria-hidden="true">◈</span><div><strong>Prepare now. Connect when you’re ready.</strong><p>You can save a workflow before connecting your OpenAI account. Starting a live task requires a model key.</p></div><button className="button small" onClick={onSettings}>Connection settings</button></section>}

    {isEmpty ? <section className="overview-first-run">
      <div className="overview-first-copy"><span className="eyebrow">START WITH AN OUTCOME</span><h2>One place for the work<br />you’d rather delegate.</h2><p>Research a decision, analyze a file, review your inbox, or turn a brief into a useful draft. A guided workflow sets up the task for you.</p><button className="button primary" onClick={onWorkflows}>Explore workflows <span aria-hidden="true">→</span></button></div>
      <ol className="overview-first-steps"><li><span>01</span><div><strong>Choose the result</strong><p>Pick a workflow for business, development, or everyday work.</p></div></li><li><span>02</span><div><strong>Make it yours</strong><p>Add your brief, choose an agent, and set a spend limit.</p></div></li><li><span>03</span><div><strong>Review, then run</strong><p>Follow progress, answer requests, and inspect the result.</p></div></li></ol>
    </section> : <div className="overview-columns">
      <section className="overview-section overview-attention"><header><div><span className="eyebrow">NEXT ACTIONS</span><h2>Needs you {attention > 0 && <span className="overview-count">{attention}</span>}</h2></div><button className="text-button" onClick={onRequests}>All requests <span aria-hidden="true">→</span></button></header>
        {attention === 0 ? <div className="overview-clear"><span aria-hidden="true">✓</span><strong>No decisions waiting.</strong><p>Your agents will ask here when they need a file, a sign-in, or your direction.</p></div> : <div className="overview-action-list">
          {requests.slice(0, 5).map(request => { const task = snapshot.tasks.find(item => item.id === request.taskId); const browser = request.type === 'browser_handoff'; return <button className="overview-action" key={request.id} onClick={() => task ? onTask(task, browser ? 'browser' : 'activity') : onRequests()}><span className="overview-action-kind">{browser ? 'SIGN IN' : request.type === 'files' ? 'ADD FILES' : 'YOUR DECISION'}</span><strong>{request.title}</strong><p>{request.reason}</p><footer><span>{task ? agentName(task) : 'Agent'}</span><span>{browser ? 'Open browser' : 'Respond'} →</span></footer></button>; })}
          {problems.slice(0, Math.max(0, 5 - requests.length)).map(task => <button className="overview-action problem" key={task.id} onClick={() => onTask(task, 'activity')}><span className="overview-action-kind">{task.state === 'failed' ? 'TASK STOPPED' : task.state === 'waiting' ? 'WAITING' : 'REVIEW NEEDED'}</span><strong>{task.objective}</strong><p>{task.state === 'waiting' ? 'Review what this task is waiting for and its next step.' : 'Review the saved progress and what the agent tried.'}</p><footer><span>{agentName(task)}</span><span>Review task →</span></footer></button>)}
          {attention > 5 && <button className="overview-more" onClick={requests.length ? onRequests : onTasks}>{requests.length ? 'See all requests →' : 'See all task details →'}</button>}
        </div>}
      </section>
      <section className="overview-section"><header><div><span className="eyebrow">IN YOUR WORKSPACE</span><h2>Work in progress</h2></div><button className="text-button" onClick={onTasks}>All tasks <span aria-hidden="true">→</span></button></header>
        {active.length ? <div className="overview-progress-list">{active.slice(0, 5).map(task => { const run = live?.tasks.find(item => item.taskId === task.id); return <button className="overview-progress-row" key={task.id} onClick={() => onTask(task, 'activity')}><span className={'overview-task-orb state-' + task.state} aria-hidden="true">{task.state === 'running' ? '↗' : '◷'}</span><div><strong>{task.objective}</strong><p>{agentName(task)} <span>·</span> {task.executionMode === 'live' ? task.state === 'paused' && !run?.enabled ? hasLiveProgress(run) ? 'Paused · progress saved' : 'Saved · run when ready' : labels[task.state] : 'Simulation · ' + labels[task.state]}</p></div><span aria-hidden="true">→</span></button>; })}</div> : <div className="overview-quiet"><p>No tasks in progress.</p><button className="text-button" onClick={onWorkflows}>Choose your next workflow →</button></div>}
      </section>
    </div>}

    {!isEmpty && <section className="overview-section overview-results"><header><div><span className="eyebrow">THE PAYOFF</span><h2>Recent results</h2></div><button className="text-button" onClick={onTasks}>View tasks <span aria-hidden="true">→</span></button></header>{results.length ? <div className="overview-result-grid">{results.slice(0, 3).map(task => { const artifact = completedResult(task, snapshot.artifacts, live); return <article className="overview-result" key={task.id}><span className="overview-result-type">{task.executionMode === 'live' ? 'COMPLETED TASK' : 'SIMULATION RESULT'}</span><h3>{task.objective}</h3><p>{artifact?.displayName || task.completionCriteria || 'The task reached its saved completion criteria.'}</p><footer><span>{agentName(task)}</span><button className="text-button" onClick={() => artifact?.status === 'ready' ? void preview(artifact.id) : onTask(task, 'files')}>{artifact?.status === 'ready' ? 'Open result' : 'Review task'} →</button></footer></article>; })}</div> : <div className="overview-results-empty">Completed work will appear here, with its saved result ready to open.</div>}</section>}
  </div>;
}
