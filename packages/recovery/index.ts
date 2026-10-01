import { validateProviderRegistry } from '../model-adapters/registry';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../persistence/index';
import type { RecoveryEntry, RecoveryManifest, RecoveryBackupResult, RecoveryRestoreResult } from '../contracts/recovery';

type DbRow = Record<string, unknown>;
type PersistenceHandle = { dataRoot: string; databasePath: string };
export type RecoveryOptions = {
  persistence: PersistenceHandle;
  appVersion: string;
  /** Must block every mutating IPC/background job, drain in-flight work, and keep work paused. */
  withQuiesced: <T>(work: () => Promise<T>) => Promise<T>;
  limits?: Partial<RecoveryLimits>;
};
export type RecoveryLimits = { files: number; fileBytes: number; databaseBytes: number; totalBytes: number; manifestBytes: number };
export const RECOVERY_LIMITS: RecoveryLimits = {
  files: 30_000, fileBytes: 100 * 1024 * 1024, databaseBytes: 512 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024 * 1024, manifestBytes: 8 * 1024 * 1024,
};
const DB = 'control/agent-workspaces.sqlite';
const PROVIDERS = 'control/model-providers.json';
const MANIFEST = 'backup-manifest.json';
const INCOMPLETE = '.recovery-incomplete';
const SHA = /^[a-f0-9]{64}$/;
const ID = '[A-Za-z0-9_-]{1,96}';
const ARTIFACT = new RegExp(`^artifacts/(private/${ID}|shared)/${ID}/${ID}/content(?:\\.[A-Za-z0-9_-]{1,24})?$`);
const WORKSPACE = new RegExp(`^private/${ID}/workspace/tasks/${ID}/(snapshots|revisions)/${ID}$`);
const EXCLUSIONS = ['Browser profiles and cookies', 'Keychain credentials and account tokens', 'Unimported browser downloads', 'Runtime sockets, leases, staging and logs'];

export class RecoveryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RecoveryError'; }
}
function fail(code: string, message: string): never { throw new RecoveryError(code, message); }
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('invalid_manifest', 'Invalid file size in backup metadata.');
  return Number(value);
}
function portablePath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 1024 || isAbsolute(path) || /[\\\x00-\x1f:]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) fail('unsafe_path', 'A backup path is unsafe.');
  return path;
}
function includedPath(path: string, kind: RecoveryEntry['kind']): boolean {
  if (kind === 'database') return path === DB;
  if (kind === 'configuration') return path === PROVIDERS;
  if (kind === 'artifact') return ARTIFACT.test(path);
  const parts = path.split('/');
  return kind === 'workspace' && parts.length > 7 && WORKSPACE.test(parts.slice(0, 7).join('/'));
}
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child); return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
async function safeRoot(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_path', 'Select a real directory, not a link.');
  return realpath(path);
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
async function managed(root: string, path: string, createParents = false): Promise<string> {
  const rel = portablePath(path), parts = rel.split('/');
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    if (createParents) { try { await mkdir(cursor, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
    const st = await lstat(cursor);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('unsafe_path', 'Backup paths cannot contain links.');
  }
  return join(root, rel);
}
async function transfer(root: string, entry: Pick<RecoveryEntry, 'path' | 'kind'> & Partial<RecoveryEntry>, limits: RecoveryLimits, destination?: string): Promise<RecoveryEntry> {
  const source = await managed(root, entry.path), handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await handle.stat(), max = entry.kind === 'database' ? limits.databaseBytes : entry.kind === 'configuration' ? Math.min(limits.fileBytes,2*1024*1024) : limits.fileBytes;
    if (!before.isFile() || before.nlink !== 1 || before.size > max) fail('unsafe_file', 'Backup files must be bounded regular files without hard links.');
    if (entry.bytes !== undefined && before.size !== entry.bytes) fail('integrity_error', 'A backup file has the wrong size.');
    if (destination) output = await open(await managed(destination, entry.path, true), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > max) fail('unsafe_file', 'A backup file grew beyond its size limit.');
      digest.update(buffer.subarray(0, result.bytesRead));
      if (output) await output.writeFile(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat(), sha256 = digest.digest('hex');
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || (entry.sha256 && sha256 !== entry.sha256)) fail('integrity_error', 'A backup file changed or failed its integrity check.');
    if (output) { await output.sync(); if (!['database','configuration'].includes(entry.kind)) await output.chmod(0o400); }
    return { path: entry.path, kind: entry.kind, bytes, sha256 };
  } finally { await output?.close(); await handle.close(); }
}
async function writePrivate(path: string, value: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); }
}
async function syncParents(root: string, paths: string[]): Promise<void> {
  const parents = new Set<string>([root]);
  for (const path of paths) {
    let cursor = dirname(join(root, path));
    while (isWithin(root, cursor)) { parents.add(cursor); if (cursor === root) break; cursor = dirname(cursor); }
  }
  for (const path of [...parents].sort((a, b) => b.length - a.length)) await syncDirectory(path);
  await syncDirectory(dirname(root));
}
function database(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;'); return db; } catch (e) { db.close(); throw e; }
}
function checkDatabase(db: DatabaseSync): void {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== SCHEMA_VERSION) fail('schema_mismatch', 'This backup requires the matching application schema.');
  if (db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) fail('integrity_error', 'The backup database failed integrity checks.');
}
function assertIdle(db: DatabaseSync): void {
  const checks = [
    "SELECT 1 FROM tasks WHERE state IN ('running','pausing','recovering')",
    "SELECT 1 FROM runs WHERE state='running'",
    "SELECT 1 FROM code_executions WHERE lifecycle IN ('preparing','running','exporting','stopping')",
    'SELECT 1 FROM code_workspace_leases',
    'SELECT 1 FROM routine_preparation_claims',
    "SELECT 1 FROM artifact_operations WHERE state IN ('staging','finalized')",
    "SELECT 1 FROM request_validation_jobs WHERE state IN ('queued','running')",
    "SELECT 1 FROM request_replan_jobs WHERE state IN ('queued','running')",
    "SELECT 1 FROM browser_tool_calls WHERE state='dispatched'",
    "SELECT 1 FROM browser_downloads WHERE state='saving'",
    "SELECT 1 FROM browser_sessions WHERE controller!='none' OR owner_pid IS NOT NULL",
    "SELECT 1 FROM live_model_calls WHERE state='reserved'",
    "SELECT 1 FROM live_tool_receipts WHERE state='dispatched'",
    "SELECT 1 FROM tool_calls WHERE state IN ('planned','dispatched')",
  ];
  for (const sql of checks) if (db.prepare(`${sql} LIMIT 1`).get()) fail('not_quiesced', 'Pause and finish active operations before backing up.');
}
type Expected = RecoveryEntry & { content?: string };
function expectedFiles(db: DatabaseSync, limits: RecoveryLimits): Expected[] {
  const files: Expected[] = [], paths = new Set<string>();
  let total = 0;
  const add = (entry: Expected) => {
    portablePath(entry.path); count(entry.bytes);
    if (!includedPath(entry.path, entry.kind) || !SHA.test(entry.sha256) || paths.has(entry.path)) fail('invalid_manifest', 'Invalid or duplicate stored file reference.');
    if (entry.bytes > limits.fileBytes || files.length >= limits.files || (total += entry.bytes) > limits.totalBytes) fail('size_limit', 'The backup exceeds its configured storage limits.');
    paths.add(entry.path); files.push(entry);
  };
  for (const row of db.prepare('SELECT storage_ref,sha256,bytes,status FROM artifact_versions').iterate()) {
    if (row.status !== 'ready') fail('incomplete_source', 'Resolve missing or corrupt artifacts before creating a complete backup.');
    add({ path: String(row.storage_ref), kind: 'artifact', bytes: Number(row.bytes), sha256: String(row.sha256) });
  }
  for (const table of ['workspace_snapshots', 'code_workspace_revisions']) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
      if (row.status !== 'ready') fail('incomplete_source', 'Resolve missing or corrupt workspaces before creating a complete backup.');
      const base = portablePath(row.storage_ref);
      if (!WORKSPACE.test(base) || String(row.manifest).length > limits.manifestBytes) fail('invalid_manifest', 'Invalid workspace metadata.');
      const members: unknown = JSON.parse(String(row.manifest));
      if (!Array.isArray(members) || members.length > limits.files || members.length !== Number(row.file_count)) fail('invalid_manifest', 'Invalid workspace file count.');
      let memberBytes = 0;
      for (const member of members as DbRow[]) {
        const path = portablePath(member.path);
        if (path === 'manifest.json') fail('invalid_manifest', 'Workspace metadata cannot replace its manifest.');
        add({ path: `${base}/${path}`, kind: 'workspace', bytes: count(member.bytes), sha256: String(member.sha256) });
        memberBytes += Number(member.bytes);
      }
      if (memberBytes !== Number(row.bytes)) fail('invalid_manifest', 'Invalid workspace byte count.');
      const data = table === 'workspace_snapshots'
        ? { taskId: row.task_id, revision: row.revision, files: members }
        : { taskId: row.task_id, executionId: row.execution_id, parentId: row.parent_id, revision: row.revision, files: members };
      const content = JSON.stringify(data, null, 2);
      add({ path: `${base}/manifest.json`, kind: 'workspace', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), content });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Backup only the validated connection schema, never credentials or arbitrary control files. */
async function checkProviderConfiguration(root:string,db:DatabaseSync,listed:boolean):Promise<string|null>{
  const selections=db.prepare("SELECT model FROM live_task_config WHERE model LIKE 'profile:%' UNION SELECT model FROM security_review_members WHERE model LIKE 'profile:%' UNION SELECT model FROM fleet_members WHERE model LIKE 'profile:%' UNION SELECT planner_model AS model FROM fleet_runs WHERE planner_model LIKE 'profile:%' UNION SELECT worker_model AS model FROM fleet_runs WHERE worker_model LIKE 'profile:%'").all().map(row=>String(row.model));
  if(!listed){if(selections.length)fail('incomplete_backup','Saved tasks reference model connections missing from this backup.');return null;}
  const handle=await open(await managed(root,PROVIDERS),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size>2*1024*1024)fail('invalid_manifest','The saved model configuration is unsafe.');
    const content=await handle.readFile('utf8');let value;try{value=validateProviderRegistry(JSON.parse(content));}catch{fail('invalid_manifest','The model connection file must contain only valid nonsecret configuration.');}
    const ids=new Set(value!.profiles.map(profile=>profile.selectionId));
    if(selections.some(id=>!ids.has(id)))fail('incomplete_backup','A model revision required by a saved task is missing.');
    return content;
  }finally{await handle.close();}
}

/** No write operation can be performed without the caller's exclusive coordinator gate. */
export class RecoveryService {
  private readonly limits: RecoveryLimits;
  private busy = false;
  constructor(private readonly options: RecoveryOptions) {
    this.limits = { ...RECOVERY_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1 || value > RECOVERY_LIMITS[key as keyof RecoveryLimits]) fail('size_limit', 'Recovery limits can only lower the built-in safety bounds.');
    if (typeof options.withQuiesced !== 'function') fail('not_quiesced', 'Recovery requires an exclusive coordinator gate.');
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) fail('busy', 'Another recovery operation is already in progress.');
    this.busy = true; try { return await work(); } finally { this.busy = false; }
  }
  private async destination(path: string, source: string): Promise<string> {
    const target = resolve(path), parent = await safeRoot(dirname(target)), resolved = join(parent, target.split(sep).at(-1)!);
    if (isWithin(source, resolved) || isWithin(resolved, source) || isWithin(await safeRoot(this.options.persistence.dataRoot), resolved)) fail('unsafe_destination', 'Choose a new location outside existing app data and the source backup.');
    // Atomic reservation: existing empty directories also refuse replacement. Caller selects a parent and a new name.
    try { await mkdir(resolved, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('destination_exists', 'Use a new directory; recovery never overwrites an existing location.'); throw e; }
    await writePrivate(join(resolved, INCOMPLETE), 'This operation is incomplete. Do not open this directory as app data.\n');
    return resolved;
  }
  async createBackup(destinationDirectory: string): Promise<RecoveryBackupResult> {
    return this.exclusive(() => this.options.withQuiesced(async () => {
      const source = await safeRoot(this.options.persistence.dataRoot);
      if (resolve(this.options.persistence.databasePath) !== join(source, DB)) fail('unsafe_path', 'Unexpected application database location.');
      const dbPath = await managed(source, DB), dbStat = await lstat(dbPath);
      if (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.nlink !== 1 || dbStat.size > this.limits.databaseBytes) fail('unsafe_file', 'Unexpected application database file.');
      const lock = new DatabaseSync(dbPath);
      let reader: DatabaseSync | undefined;
      let locked = false;
      try {
        lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); locked = true;
        reader = database(this.options.persistence.databasePath); checkDatabase(reader); assertIdle(reader);
        const expected = expectedFiles(reader, this.limits), destination = await this.destination(destinationDirectory, source);
        await managed(destination, DB, true);
        // SQLite's online backup API includes committed WAL pages; the writer reservation keeps DB/file references stable.
        await backup(reader, join(destination, DB)); await chmod(join(destination, DB), 0o600);
        const snapshot = new DatabaseSync(join(destination, DB));
        try { snapshot.exec('PRAGMA journal_mode=DELETE'); checkDatabase(snapshot); } finally { snapshot.close(); }
        const files: RecoveryEntry[] = [await transfer(destination, { path: DB, kind: 'database' }, this.limits)];
        if (files[0].bytes + expected.reduce((total, entry) => total + entry.bytes, 0) > this.limits.totalBytes || expected.length + 1 > this.limits.files) fail('size_limit', 'The backup exceeds its configured storage limits.');
        for (const entry of expected) files.push(await transfer(source, entry, this.limits, destination));
        const hasProviders=await exists(join(source,PROVIDERS));
        const configuration=await checkProviderConfiguration(source,reader,hasProviders);
        if(configuration!==null){await writePrivate(await managed(destination,PROVIDERS,true),configuration);files.push(await transfer(destination,{path:PROVIDERS,kind:'configuration'},this.limits));}
        const totalBytes = files.reduce((total, entry) => total + entry.bytes, 0);
        if (totalBytes > this.limits.totalBytes || files.length > this.limits.files) fail('size_limit', 'The backup exceeds its configured storage limits.');
        const manifest: RecoveryManifest = { format: 'agent-workspaces-backup', version: 1, id: randomUUID(), appVersion: this.options.appVersion, schemaVersion: SCHEMA_VERSION, createdAt: Date.now(), files, totalBytes, exclusions: EXCLUSIONS };
        const serialized = JSON.stringify(manifest, null, 2);
        if (Buffer.byteLength(serialized) > this.limits.manifestBytes) fail('size_limit', 'The backup manifest exceeds its safety limit.');
        await writePrivate(join(destination, `${MANIFEST}.tmp`), serialized);
        await rename(join(destination, `${MANIFEST}.tmp`), join(destination, MANIFEST));
        await syncParents(destination, files.map(entry => entry.path));
        await unlink(join(destination, INCOMPLETE)); await syncDirectory(destination);
        return { directory: destination, manifest };
      } finally { reader?.close(); try { if (locked) lock.exec('ROLLBACK'); } finally { lock.close(); } }
    }));
  }
  async verifyBackup(sourceDirectory: string): Promise<RecoveryBackupResult> {
    const directory = await safeRoot(sourceDirectory);
    if (await exists(join(directory, INCOMPLETE))) fail('incomplete_backup', 'This backup did not finish.');
    const manifestHandle = await open(join(directory, MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW);
    let manifest: RecoveryManifest;
    try {
      const st = await manifestHandle.stat();
      if (!st.isFile() || st.nlink !== 1 || st.size > this.limits.manifestBytes) fail('invalid_manifest', 'Invalid backup manifest.');
      manifest = JSON.parse(await manifestHandle.readFile('utf8')) as RecoveryManifest;
    } finally { await manifestHandle.close(); }
    if (!manifest || manifest.format !== 'agent-workspaces-backup' || manifest.version !== 1 || manifest.schemaVersion !== SCHEMA_VERSION || typeof manifest.id !== 'string' || !/^[a-f0-9-]{36}$/.test(manifest.id) || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > this.limits.files) fail('invalid_manifest', 'Unsupported or invalid backup manifest.');
    const seen = new Set<string>(); let total = 0;
    for (const entry of manifest.files) {
      if (!entry || !includedPath(portablePath(entry.path), entry.kind) || !SHA.test(entry.sha256) || seen.has(entry.path)) fail('invalid_manifest', 'Invalid or duplicate backup file.');
      total += count(entry.bytes); seen.add(entry.path);
      if (total > this.limits.totalBytes) fail('size_limit', 'The backup exceeds its configured storage limits.');
      await transfer(directory, entry, this.limits);
    }
    if (total !== manifest.totalBytes || !seen.has(DB)) fail('invalid_manifest', 'Backup totals do not match.');
    // Never open a supplied WAL: the portable database must be self-contained.
    for (const suffix of ['-wal', '-shm', '-journal']) if (await exists(join(directory, `${DB}${suffix}`))) fail('invalid_manifest', 'A portable backup cannot contain database journals.');
    const db = database(join(directory, DB));
    try {
      checkDatabase(db); assertIdle(db);
      const expected = expectedFiles(db, this.limits), listed = new Map(manifest.files.map(entry => [entry.path, entry]));
      const hasProviders=listed.has(PROVIDERS);await checkProviderConfiguration(directory,db,hasProviders);
      if (expected.length + 1 + Number(hasProviders) !== listed.size) fail('incomplete_backup', 'The backup does not contain exactly its referenced files.');
      for (const entry of expected) {
        const actual = listed.get(entry.path);
        if (!actual || actual.kind !== entry.kind || actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) fail('incomplete_backup', 'A required stored file is absent or inconsistent.');
      }
    } finally { db.close(); }
    return { directory, manifest };
  }
  async restoreBackup(sourceDirectory: string, destinationRoot: string): Promise<RecoveryRestoreResult> {
    return this.exclusive(async () => {
      const verified = await this.verifyBackup(sourceDirectory), destination = await this.destination(destinationRoot, verified.directory);
      for (const entry of verified.manifest.files) await transfer(verified.directory, entry, this.limits, destination);
      const db = new DatabaseSync(join(destination, DB));
      let pausedTasks = 0;
      try {
        db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
        const now = Date.now();
        pausedTasks = Number(db.prepare("UPDATE tasks SET state='paused',revision=revision+1,generation=generation+1,updated_at=? WHERE state NOT IN ('succeeded','failed','cancelled')").run(now).changes);
        db.exec(`UPDATE settings SET driver_enabled=0; UPDATE live_task_config SET enabled=0;
          UPDATE runs SET state='interrupted',lease_until=0 WHERE state IN ('running','waiting','paused');
          UPDATE browser_sessions SET profile_ref=NULL,controller='none',controller_generation=controller_generation+1,lifecycle='not_provisioned',task_id=NULL,selected_tab_id=NULL,profile_saved_at=NULL,last_error=NULL,owner_instance=NULL,owner_pid=NULL;
          DELETE FROM browser_tabs; DELETE FROM gmail_connection_requests;
          DELETE FROM code_workspace_leases; DELETE FROM artifact_operations;
          UPDATE browser_downloads SET state='failed' WHERE state!='saved';`);
        db.prepare('UPDATE request_capability_grants SET revoked_at=? WHERE revoked_at IS NULL').run(now);
        if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='routines'").get()) db.exec('UPDATE routines SET enabled=0; UPDATE notice_settings SET enabled=0');
        if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='fleet_runs'").get()) db.exec("UPDATE fleet_runs SET status='paused',problem='Restored from backup. Review saved progress and resume the fleet explicitly.' WHERE status='running'");
        if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='routine_preparation_claims'").get()) db.exec("DELETE FROM routine_preparation_claims; UPDATE routine_occurrences SET state='blocked',reason='Restored occurrence requires review; preparation and dispatch will not replay.' WHERE state IN ('preparing','dispatching')");
        for (const table of ['project_gmail_accounts', 'project_google_workspace_accounts']) if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) db.exec(`DELETE FROM ${table}`);
        if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='browser_action_proposals'").get()) db.prepare("UPDATE browser_action_proposals SET state=CASE WHEN state='dispatching' THEN 'outcome_unknown' ELSE 'stale' END,revision=revision+1,account_confirmation=NULL,error='Restored from backup; review and propose this action again.',updated_at=? WHERE state IN ('pending','approved','dispatching')").run(now);
        for (const table of ['request_validation_jobs', 'request_replan_jobs']) db.prepare(`UPDATE ${table} SET state='cancelled',owner_id=NULL,owner_pid=NULL,lease_until=0,finished_at=? WHERE state IN ('queued','running')`).run(now);
        db.exec("UPDATE request_slots SET state='needs_replacement' WHERE state IN ('uploading','checking'); UPDATE input_requests SET state='needs_correction',revision=revision+1 WHERE state='checking';");
        db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);'); checkDatabase(db);
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } finally { db.close(); }
      for (const folder of ['artifacts', 'private', 'staging', 'backups']) if (!await exists(join(destination, folder))) await mkdir(join(destination, folder), { mode: 0o700 });
      await writePrivate(join(destination, 'control/restore-receipt.json'), JSON.stringify({ backupId: verified.manifest.id, restoredAt: Date.now(), pausedTasks, requiresReview: true, note: 'Tasks are paused; the driver and live execution are disabled. Review permissions and reconnect accounts before explicitly resuming.' }, null, 2));
      await syncParents(destination, [...verified.manifest.files.map(entry => entry.path), 'control/restore-receipt.json']);
      await unlink(join(destination, INCOMPLETE)); await syncDirectory(destination);
      return { dataRoot: destination, backupId: verified.manifest.id, restoredFiles: verified.manifest.files.length, pausedTasks, requiresReview: true };
    });
  }
}
