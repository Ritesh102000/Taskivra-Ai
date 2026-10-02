import type { DatabaseSync } from 'node:sqlite';
import { procedureVersion, readProcedure } from './procedures';

/** Snapshot effective owner-approved requirements; never copy grants or request history. */
export function effectiveProcedure(db: DatabaseSync, taskId: string) {
  const origin = db.prepare('SELECT definition_json FROM workflow_task_origins WHERE task_id=?').get(taskId);
  if (!origin?.definition_json) return null;
  const procedure = readProcedure(String(origin.definition_json));
  const amendments = db.prepare("SELECT d.payload_json FROM input_requests r JOIN request_details d ON d.request_id=r.id WHERE r.task_id=? AND r.state='fulfilled' AND d.kind='reduced_scope' ORDER BY r.created_at,r.id").all(taskId);
  if (!amendments.length) return procedure;
  const waived = new Set(amendments.flatMap(row => JSON.parse(String(row.payload_json)).waiveSlotKeys || []));
  const task = db.prepare('SELECT completion_criteria FROM tasks WHERE id=?').get(taskId)!;
  const { versionId: _, ...definition } = procedure;
  const effective = { ...definition, completionTemplate: String(task.completion_criteria), fileSlots: definition.fileSlots.filter(slot => !waived.has(slot.key)), output: { format: undefined, filename: definition.output.filename, sections: [] } };
  return { ...effective, versionId: procedureVersion(effective) };
}
export function copyEffectiveWorkflow(db: DatabaseSync, sourceTaskId: string, targetTaskId: string, now: number) {
  const origin = db.prepare('SELECT workflow_id,title FROM workflow_task_origins WHERE task_id=?').get(sourceTaskId);
  const procedure = effectiveProcedure(db, sourceTaskId);
  if (!origin || !procedure) return;
  db.prepare('INSERT INTO workflow_task_origins(task_id,workflow_id,title,created_at,definition_json) VALUES (?,?,?,?,?)').run(targetTaskId,String(origin.workflow_id),String(origin.title),now,JSON.stringify(procedure));
  for (const role of db.prepare('SELECT slot_key,version_id FROM workflow_input_assignments WHERE task_id=?').all(sourceTaskId)) {
    if (procedure.fileSlots.some(slot => slot.key === role.slot_key)) db.prepare('INSERT INTO workflow_input_assignments(task_id,slot_key,version_id,assigned_at) VALUES (?,?,?,?)').run(targetTaskId,String(role.slot_key),String(role.version_id),now);
  }
}
