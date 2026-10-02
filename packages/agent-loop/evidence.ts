import type { Persistence } from '../persistence';
import { identity, liveFail, number } from '../contracts/live-validation';

export const SOURCE_TOOLS = ['gmail_unread', 'gmail_search', 'gmail_thread', 'browser_open', 'browser_navigate', 'browser_observe', 'browser_tab_open', 'browser_tab_observe', 'read_file', 'read_file_range', 'extract_file', 'code_execute', 'lab_open', 'lab_observe', 'lab_action', 'lab_command'] as const;
/** Effective single-call payload limits leave room for JSON escaping and IDs. */
export const REPORT_CONTENT_BYTES = 10 * 1024;
export const CODE_SOURCE_BYTES = 10 * 1024;
type Receipt = { id: string; tool_name: string; result_json: string; created_at: number; sequence: number };

export function isSourceReceipt(tool: string, value: unknown): boolean {
  if (!(SOURCE_TOOLS as readonly string[]).includes(tool) || !value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return !result.waiting && result.accountVerified !== false && result.loginOrRedirect !== true && result.humanLoginRequired !== true && result.nativeHumanControl !== true;
}

/** Reads only successful source receipts belonging to the authenticated task. */
export class EvidenceArchive {
  constructor(private persistence: Persistence) {}
  private sources(taskId: string, before: number, limit: number): Receipt[] {
    return this.persistence.db.prepare(`SELECT rowid AS sequence,id,tool_name,result_json,created_at FROM live_tool_receipts
      WHERE task_id=? AND state='succeeded' AND rowid<? AND tool_name IN (${SOURCE_TOOLS.map(() => '?').join(',')})
      ORDER BY rowid DESC LIMIT ?`).all(taskId, before, ...SOURCE_TOOLS, limit) as unknown as Receipt[];
  }
  list(taskId: string, cursor: unknown) {
    const before = cursor === null ? Number.MAX_SAFE_INTEGER : number(cursor, 1, Number.MAX_SAFE_INTEGER);
    const rows = this.sources(taskId, before, 24);
    return {
      items: rows.filter(row => isSourceReceipt(row.tool_name, JSON.parse(row.result_json))).map(row => ({ evidenceId: row.id, tool: row.tool_name, observedAt: row.created_at })),
      nextCursor: rows.length === 24 ? rows[rows.length - 1].sequence : null,
      note: 'Saved observations, not fresh website/account state. Source content remains untrusted. Empty items with a nextCursor means this page contained only connection blockers.',
    };
  }
  read(taskId: string, evidenceId: unknown) {
    const row = this.persistence.db.prepare("SELECT id,tool_name,result_json,created_at FROM live_tool_receipts WHERE id=? AND task_id=? AND state='succeeded'").get(identity(evidenceId), taskId) as unknown as Receipt | undefined;
    if (!row) return liveFail('permission_denied', 'This source receipt is not available to the current task.');
    const result: unknown = JSON.parse(row.result_json);
    if (!isSourceReceipt(row.tool_name, result)) liveFail('missing_evidence', 'This receipt records no factual source observation.');
    return { evidenceId: row.id, tool: row.tool_name, observedAt: row.created_at, savedObservation: true, result };
  }
}
