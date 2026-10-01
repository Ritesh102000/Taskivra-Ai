/** Each reviewed action is one potential website change, never a reusable permission. */
export type BrowserActionSpec = { kind: 'click'; ref: string; revision: number }
 | { kind: 'fill' | 'select'; ref: string; revision: number; value: string };
export type BrowserActionStatus = 'pending' | 'approved' | 'declined' | 'stale' | 'dispatching' | 'completed' | 'outcome_unknown';
export interface BrowserActionProposal {
 id: string; taskId: string; agentId: string; revision: number; state: BrowserActionStatus;
 sessionId: string; generation: number; tabId: string; pageRevision: number; url: string;
 target: { ref: string; kind: string; label: string }; action: BrowserActionSpec;
 reason: string; expectedEffect: string; accountConfirmation: string | null;
 createdAt: number; expiresAt: number; error: string | null;
 resolution: { outcome: 'checked_done' | 'checked_not_done'; note: string; at: number } | null;
}
export interface BrowserActionsState { actions: BrowserActionProposal[]; attentionCount: number }
export type BrowserActionsCommand = { type: 'browserActions.list'; taskId: string | null }
 | { type: 'browserActions.decide'; actionId: string; revision: number; decision: 'approve' | 'decline'; accountConfirmation: string }
 | { type: 'browserActions.resolveUnknown'; actionId: string; revision: number; outcome: 'checked_done' | 'checked_not_done'; note: string };
export const BROWSER_ACTIONS_CHANNEL = 'agent-workspaces:browser-actions';
export interface BrowserActionsBridge { browserActions(command: BrowserActionsCommand): Promise<BrowserActionsState> }
