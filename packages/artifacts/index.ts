import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, rename, rm, chmod, open } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type { ArtifactPreview, ArtifactVersion, ImportTarget, TaskArtifact, WorkspaceSnapshot } from '../contracts/index';
import type { CodeInput } from '../contracts/code';
import type { CodeExportFile, CodeSeedFile } from '../code/runtime';
import { codeWorkspacePath, type CodeWorkspaceFile, type CodeWorkspaceLease, type CodeWorkspaceOptions, type CodeWorkspaceReceipt } from './code';
import { Persistence } from '../persistence/index';
import { ProjectAccess } from '../projects';
import { assertManagedPath, ensureManagedDirectory, secureCopy, finalizeImmutable, verifyFile, safeTextPreview, measureStorage, exportVerifiedFile } from './safe-io';

export type Principal = { kind: 'owner' } | { kind: 'agent'; agentId: string };
export const FILE_LIMITS = { file: 100 * 1024 * 1024, batch: 250 * 1024 * 1024, workspace: 512 * 1024 * 1024, batchFiles: 32, versions: 2000, snapshots: 2000 } as const;
const METADATA_RESERVE = 8 * 1024 * 1024;
const OPERATION_LEASE_MS = 120_000;
export class ArtifactError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ArtifactError'; this.code = code; }
}
export type ArtifactFaultPoint = 'after_preflight' | 'after_stage' | 'after_finalize' | 'before_metadata_commit' | 'after_metadata_commit';
type Row = Record<string, string | number | null>;
interface Candidate { artifactId: string; versionId: string; displayName: string; ownerAgentId: string | null; producerTaskId: string | null; visibility: 'private' | 'shared'; version: number; sourceVersionId: string | null; publishedFrom: string | null; stage: string; final: string; bytes: number; sha256: string; mime: string; format: string; expectedBytes?: number; originalName?: string; codeSource?: {executionId:string;inputVersionIds:string[]} }
export interface BrowserDownloadSource { sessionId: string; tabId: string; downloadId: string; origin: string }
type BrowserCandidate = Candidate & { browserSource?: BrowserDownloadSource; browserDownloadKey?: string };
interface SnapshotCandidate { id: string; taskId: string; revision: number; stage: string; final: string; bytes: number; files: { path: string; versionId: string; bytes: number; sha256: string }[] }
interface CodeRevisionCandidate { id:string;taskId:string;executionId:string;parentId:string|null;revision:number;stage:string;final:string;bytes:number;files:CodeWorkspaceFile[] }
interface Operation { id: string; stage: string; kind: string; finals: string[]; snapshot?: SnapshotCandidate; codeRevision?:CodeRevisionCandidate; queueTaskId?:string; candidates: Candidate[]; committed?: boolean }
const locks = new Map<string, Promise<unknown>>();
const staticErrors: Record<string, string> = {
  permission_denied: 'This file is private to a different agent. Publish an explicit shared copy before handing it off.',
  not_found: 'The selected file, agent, or task no longer exists.',
  integrity_error: 'The managed file is missing, changed, or unsafe. Its original version was not replaced.',
  file_invalid: 'The selected file failed its format or regular-file checks. Choose a complete supported file.',
  limit_exceeded: 'The limits are 100 MiB per file, 250 MiB and 32 files per batch, 512 MiB per workspace snapshot, and 2,000 saved versions or snapshots.',
  format_limit: 'JSON validation supports files up to 1 MiB, nesting depth 64, and 100,000 structure entries.',
  archive_limit: 'XLSX validation supports up to 2,048 archive entries, a 4 MiB directory, 256 MiB expanded data, and a 100:1 compression ratio.',
  storage_full: 'The application storage budget cannot fit this operation and its staging copy. Increase the budget or choose a smaller file.',
  operation_failed: 'The file operation could not finish. Existing committed versions remain unchanged.',
  destination_exists: 'That export filename already exists. Choose a new filename; the existing file was preserved.',
  closed: 'The application is closing; the file operation was not committed.',
  workspace_busy: 'Code currently owns this task workspace. Files will be delivered when the execution finishes.',
  stale_workspace: 'The execution no longer owns the current workspace. Existing committed files were preserved.',
};
function error(code: string): ArtifactError { return new ArtifactError(code, staticErrors[code] || staticErrors.operation_failed); }
function id(value: string): string { if (!/^[a-zA-Z0-9_-]{1,96}$/.test(value)) throw error('not_found'); return value; }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Coordinator-owned file service. Paths originate only in the trusted native bridge. */
export class ArtifactService {
  readonly ready: Promise<void>;
  readonly instanceId = randomUUID();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private readonly persistence: Persistence;
  private readonly now: () => number;
  private readonly fault?: (point: ArtifactFaultPoint) => void;
  private readonly root: string;

  constructor({ persistence, now = Date.now, fault }: { persistence: Persistence; now?: () => number; fault?: (point: ArtifactFaultPoint) => void }) {
    this.persistence = persistence; this.now = now; this.fault = fault; this.root = persistence.dataRoot;
    this.ready = this.lock(async () => {
      for (const path of ['artifacts/private','artifacts/shared','staging/artifacts']) { if (this.closed) return; await ensureManagedDirectory(this.root,path); }
      if (!this.closed) await this.reconcileInternal();
    }).catch(cause => { if (!this.closed) throw this.translate(cause); });
  }
  private row(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.persistence.db.prepare(sql).get(...values) as Row | undefined; }
  private rows(sql: string, ...values: SQLInputValue[]): Row[] { return this.persistence.db.prepare(sql).all(...values) as Row[]; }
  private write(sql: string, ...values: SQLInputValue[]): void { this.persistence.db.prepare(sql).run(...values); }
  private transaction<T>(callback: () => T): T { this.open(); return this.persistence.transaction(callback); }
  private open(): void { if (this.closed) throw error('closed'); }
  private owner(principal: Principal): void { if (!principal || principal.kind !== 'owner') throw error('permission_denied'); }
  private event(type: string, aggregateId: string, revision: number, payload: object): void {
    this.write('INSERT INTO events(type,aggregate_id,aggregate_revision,payload,created_at) VALUES (?,?,?,?,?)',type,aggregateId,revision,JSON.stringify({ ...payload, realFiles: true }),this.now());
  }
  private translate(cause: unknown): ArtifactError {
    if (cause instanceof ArtifactError) return cause;
    const code = (cause as { code?: string })?.code || '';
    if(code==='project_boundary')return new ArtifactError('project_boundary','This file belongs to another project. Export and explicitly reimport a copy to share it with a different project.');
    if(code==='destination_exists')return error('destination_exists');
    if(code==='format_limit'||code==='archive_limit')return error(code);
    if (/limit|size|too_large/.test(code)) return error('limit_exceeded');
    if (/changed|hash|checksum|unsafe|symlink|regular|hardlink|traversal/.test(code)) return error('integrity_error');
    if (/format|invalid|unsupported|encrypted|type_mismatch|macro_archive/.test(code)) return error('file_invalid');
    return error('operation_failed');
  }
  private lock<T>(action: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.root) || Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    locks.set(this.root,next.catch(() => undefined));
    this.pending.add(next); next.then(() => this.pending.delete(next),() => this.pending.delete(next));
    return next;
  }
  private async run<T>(action: () => Promise<T>): Promise<T> {
    await this.ready;
    return this.lock(async () => { this.open(); try { return await action(); } catch (cause) { throw this.translate(cause); } });
  }
  private task(taskId: string): Row {
    const task = this.row('SELECT * FROM tasks WHERE id=?',id(taskId)); if (!task) throw error('not_found'); return task;
  }
  private taskAccess(principal: Principal, taskId: string): Row {
    const task = this.task(taskId);
    if (!principal || (principal.kind !== 'owner' && (principal.kind !== 'agent' || principal.agentId !== task.agent_id))) throw error('permission_denied');
    return task;
  }
  private version(versionId: string): Row {
    const found = this.row(`SELECT v.*,a.display_name,a.owner_agent_id,a.producer_task_id,a.visibility,a.published_from_artifact_id
      FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.id=?`,id(versionId));
    if (!found) throw error('not_found'); return found;
  }
  private access(principal: Principal, versionId: string): Row {
    const version = this.version(versionId);
    if (!principal || (principal.kind !== 'owner' && (principal.kind !== 'agent' || (version.visibility !== 'shared' && version.owner_agent_id !== principal.agentId)))) throw error('permission_denied');
    if(principal.kind==='agent'&&!this.row('SELECT id FROM agents WHERE id=?',id(principal.agentId)))throw error('permission_denied');
    if(principal.kind==='agent')new ProjectAccess(this.persistence.db).assertAgentVersion(principal.agentId,versionId);
    if (version.status !== 'ready') throw error('integrity_error');
    return version;
  }
  private display(row: Row): ArtifactVersion {
    let browserSource: ArtifactVersion['browserSource'];
    let codeSource: ArtifactVersion['codeSource'];
    try {
      const provenance=JSON.parse(String(row.provenance));
      const origin = provenance.browserSource?.origin;
      if (typeof origin === 'string') {
        const parsed = new URL(origin);
        if (['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin) browserSource = { origin };
      }
      const code=provenance.codeSource;
      if(code&&typeof code.executionId==='string'&&Array.isArray(code.inputVersionIds)&&code.inputVersionIds.every((value:unknown)=>typeof value==='string'))codeSource={executionId:code.executionId,inputVersionIds:code.inputVersionIds};
    } catch { /* Older or incomplete metadata has no browser source to display. */ }
    return { id: String(row.id),artifactId:String(row.artifact_id),version:Number(row.version_number),displayName:String(row.display_name),ownerAgentId:row.owner_agent_id===null?null:String(row.owner_agent_id),producerTaskId:row.producer_task_id===null?null:String(row.producer_task_id),visibility:row.visibility as ArtifactVersion['visibility'],bytes:Number(row.bytes),sha256:String(row.sha256),mime:String(row.mime),format:String(row.format),createdAt:Number(row.created_at),status:row.status as ArtifactVersion['status'],sourceVersionId:row.source_version_id===null?null:String(row.source_version_id),...(browserSource ? { browserSource } : {}),...(codeSource?{codeSource}:{}) };
  }
  all(): ArtifactVersion[] { return this.rows("SELECT v.*,a.display_name,a.owner_agent_id,a.producer_task_id,a.visibility FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id ORDER BY v.created_at,v.rowid").map(row=>this.display(row)); }
  bindings(): TaskArtifact[] { return this.rows('SELECT * FROM task_artifacts ORDER BY created_at,rowid').map(row=>({ taskId:String(row.task_id),versionId:String(row.version_id),role:row.role as TaskArtifact['role'] })); }
  snapshots(): WorkspaceSnapshot[] { return this.rows("SELECT * FROM workspace_snapshots WHERE status='ready' ORDER BY created_at,rowid").map(row=>({id:String(row.id),taskId:String(row.task_id),revision:Number(row.revision),bytes:Number(row.bytes),fileCount:Number(row.file_count),createdAt:Number(row.created_at)})); }
  storage(): { usedBytes: number; budgetBytes: number } { const row=this.row('SELECT * FROM artifact_settings WHERE id=1')!; return {usedBytes:Number(row.used_bytes),budgetBytes:Number(row.budget_bytes)}; }
  getForAgent(agentId: string,versionId: string): ArtifactVersion { return this.display(this.access({kind:'agent',agentId},versionId)); }

  private async measure(): Promise<number> {
    const measured=await measureStorage(this.root,{maxEntries:100_000}); this.open();
    const bytes=measured.bytes;
    this.transaction(()=>this.write('UPDATE artifact_settings SET used_bytes=?,measured_at=? WHERE id=1',bytes,this.now()));
    return bytes;
  }
  private async reserve(op:Operation, bytes:number): Promise<void> {
    const used=await this.measure();
    this.transaction(()=>{
      const held=Number(this.row("SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM artifact_operations WHERE state IN ('staging','finalized')")!.n);
      if(used+held+bytes+METADATA_RESERVE>this.storage().budgetBytes)throw error('storage_full');
      this.write("INSERT INTO artifact_operations(id,owner_id,owner_pid,kind,state,manifest,reserved_bytes,lease_until,created_at,updated_at) VALUES (?,?,?,?,'staging',?,?,?,?,?)",op.id,this.instanceId,process.pid,op.kind,JSON.stringify(op),bytes,this.now()+OPERATION_LEASE_MS,this.now(),this.now());
    });
    try { await ensureManagedDirectory(this.root,op.stage); } catch(cause) { await this.abandoned(op); throw cause; }
  }
  private async heartbeat(op:Operation):Promise<void> {
    this.open(); this.transaction(()=>this.write('UPDATE artifact_operations SET manifest=?,lease_until=?,updated_at=? WHERE id=?',JSON.stringify(op),this.now()+OPERATION_LEASE_MS,this.now(),op.id));
  }
  private operation(kind:string):Operation { const opId=randomUUID();return{id:opId,kind,stage:`staging/artifacts/${opId}`,finals:[],candidates:[]}; }
  private async finalFile(candidate:Candidate):Promise<void> {
    await ensureManagedDirectory(this.root,dirname(candidate.final)); this.open();
    await finalizeImmutable(join(this.root,candidate.stage),join(this.root,candidate.final),{managedRoot:this.root,expectedSha256:candidate.sha256,maxBytes:FILE_LIMITS.file});
    await this.syncParents(dirname(candidate.final));
  }
  private async syncParents(path:string):Promise<void>{
    let current=join(this.root,path);
    while(current===this.root||current.startsWith(this.root+'/')){
      if(current!==this.root)await assertManagedPath(this.root,current);const directory=await open(current,'r');try{await directory.sync();}finally{await directory.close();}
      if(current===this.root)break;current=dirname(current);
    }
  }
  private async verify(version:Row):Promise<void> {
    try {
      const path=await assertManagedPath(this.root,join(this.root,String(version.storage_ref)));
      const metadata=await verifyFile(path,{managedRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:String(version.sha256),fileName:String(version.display_name)});
      if(metadata.bytes!==version.bytes)throw error('integrity_error');
    } catch(cause) {
      this.open();
      const missing=['ENOENT','file_missing'].includes((cause as {code?:string})?.code||'');
      this.transaction(()=>{this.write('UPDATE artifact_versions SET status=? WHERE id=?',missing?'missing':'corrupt',version.id);this.event('artifact.integrity_failed',String(version.id),Number(version.version_number),{status:missing?'missing':'corrupt'});});
      throw error('integrity_error');
    }
  }
  private async abandoned(op:Operation):Promise<void> {
    if(op.committed)return;
    if(!this.closed)this.transaction(()=>this.write("UPDATE artifact_operations SET state='abandoned',reserved_bytes=0,lease_until=0,manifest=?,updated_at=? WHERE id=?",JSON.stringify(op),this.now(),op.id));
    {for(const final of op.finals)await this.removeManaged(final);if(op.snapshot)await this.removeManaged(op.snapshot.final);await this.removeManaged(op.stage);}
    // The persisted journal lets startup safely clean either filesystem crash point.
    if(!this.closed)await this.measure().catch(()=>undefined);
  }
  private async postcommitCleanup(op:Operation):Promise<void> {
    try{await this.removeManaged(op.stage);await this.measure();}
    catch{try{if(!this.closed)this.event('artifact.cleanup_pending',op.id,1,{committed:true,operation:op.kind,versionIds:op.candidates.map(c=>c.versionId),message:'Saved files are committed. Staging cleanup needs retry; do not repeat the import or export.'});}catch{/* Diagnostics cannot revoke committed success. */}}
  }
  private candidate(versionId:string,artifactId:string,displayName:string,target:ImportTarget,version:number,sourceVersionId:string|null,publishedFrom:string|null,stage:string):Candidate {
    const extension=/^\.[A-Za-z0-9]{1,12}$/.test(extname(displayName))?extname(displayName).toLowerCase():'.bin';
    const folder=target.scope==='private'?`artifacts/private/${id(target.agentId!)}`:'artifacts/shared';
    return{artifactId,versionId,displayName,ownerAgentId:target.agentId,producerTaskId:target.taskId,visibility:target.scope,version,sourceVersionId,publishedFrom,stage,final:`${folder}/${artifactId}/${versionId}/content${extension}`,bytes:0,sha256:'',mime:'',format:''};
  }
  private target(target:ImportTarget):void {
    if(!target||!['private','shared'].includes(target.scope))throw error('permission_denied');
    if(target.scope==='private'&&!target.agentId)throw error('permission_denied');
    if(target.agentId&&!this.row('SELECT id FROM agents WHERE id=?',id(target.agentId)))throw error('not_found');
    if(target.taskId&&this.task(target.taskId).agent_id!==target.agentId)throw error('permission_denied');
    if(target.scope==='shared'&&target.agentId===null&&target.taskId!==null)throw error('permission_denied');
  }

  async importFiles({principal,target,paths,artifactId,browserSource,beforeCommit}:{principal:Principal;target:ImportTarget;paths:string[];artifactId?:string;browserSource?:BrowserDownloadSource;beforeCommit?:()=>void}):Promise<{versionIds:string[];deliveryDeferred?:boolean}> {
    return this.run(async()=>{
      this.owner(principal);this.target(target);
      let browserDownloadKey: string | undefined;
      if(browserSource){
        if(target.scope!=='private'||!target.taskId||artifactId||paths.length!==1)throw error('permission_denied');
        browserDownloadKey=`${id(browserSource.sessionId)}:${id(browserSource.downloadId)}`;
        id(browserSource.tabId);
        try{const origin=new URL(browserSource.origin);if(!['http:','https:'].includes(origin.protocol)||origin.origin!==browserSource.origin)throw error('permission_denied');}catch{throw error('permission_denied');}
        const session=this.row('SELECT agent_id FROM browser_sessions WHERE id=?',browserSource.sessionId);
        if(!session||session.agent_id!==target.agentId)throw error('permission_denied');
        const prior=this.row("SELECT id FROM artifact_versions WHERE json_extract(provenance,'$.browserDownloadKey')=?",browserDownloadKey);
        if(prior){await this.verify(this.access(principal,String(prior.id)));return{versionIds:[String(prior.id)]};}
      }
      if(!Array.isArray(paths)||!paths.length||paths.length>FILE_LIMITS.batchFiles||(artifactId&&paths.length!==1))throw error('limit_exceeded');
      if(Number(this.row('SELECT COUNT(*) AS n FROM artifact_versions')!.n)+paths.length>FILE_LIMITS.versions)throw error('limit_exceeded');
      let existing:Row|undefined;
      if(artifactId){existing=this.row('SELECT * FROM artifacts WHERE id=?',id(artifactId));if(!existing)throw error('not_found');if(existing.visibility!==target.scope||(target.scope==='private'&&existing.owner_agent_id!==target.agentId))throw error('permission_denied');}
      const op=this.operation('import');let total=0;
      for(let i=0;i<paths.length;i++) {
        if(typeof paths[i]!=='string')throw error('file_invalid');const stat=await lstat(paths[i]);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw error('file_invalid');
        if(stat.size>FILE_LIMITS.file)throw error('limit_exceeded');total+=stat.size;
        const logical=artifactId||randomUUID(),versionId=randomUUID(),displayName=existing?String(existing.display_name):basename(paths[i]);
        const version=Number(this.row('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM artifact_versions WHERE artifact_id=?',logical)!.n);
        const metadataTarget=existing?{...target,agentId:existing.owner_agent_id===null?null:String(existing.owner_agent_id),taskId:existing.producer_task_id===null?null:String(existing.producer_task_id)}:target;
        op.candidates.push({...this.candidate(versionId,logical,displayName,metadataTarget,version,null,null,`${op.stage}/file-${i}${extname(displayName).replace(/[^.a-zA-Z0-9]/g,'').slice(0,12)}`),expectedBytes:stat.size,originalName:basename(paths[i]),...(browserSource?{browserSource,browserDownloadKey}:{})});
      }
      if(total>FILE_LIMITS.batch)throw error('limit_exceeded');
      const existingSnapshotBytes=target.taskId?this.taskInputBytes(target.taskId)+Number(this.row("SELECT COALESCE(SUM(v.bytes),0) AS n FROM task_artifact_deliveries d JOIN artifact_versions v ON v.id=d.version_id WHERE d.task_id=? AND d.state='pending'",target.taskId)!.n):0;
      if(target.taskId&&existingSnapshotBytes+total>FILE_LIMITS.workspace)throw error('limit_exceeded');
      await this.reserve(op,total+(target.taskId?total+existingSnapshotBytes:0)+METADATA_RESERVE);
      try {
        this.fault?.('after_preflight');
        for(let i=0;i<paths.length;i++){const candidate=op.candidates[i];let heartbeatAt=Date.now();const copied=await secureCopy(paths[i],join(this.root,candidate.stage),{maxBytes:Math.max(1,candidate.expectedBytes!),managedRoot:this.root,fileName:candidate.displayName,afterChunk:async()=>{this.open();if(Date.now()-heartbeatAt>1000){await this.heartbeat(op);heartbeatAt=Date.now();}}});if(copied.bytes!==candidate.expectedBytes)throw error('integrity_error');Object.assign(candidate,{bytes:copied.bytes,sha256:copied.sha256,mime:copied.mime,format:copied.format});}
        await this.heartbeat(op);this.fault?.('after_stage');
        op.finals=op.candidates.map(c=>dirname(c.final));await this.heartbeat(op);
        for(const candidate of op.candidates){this.open();await this.finalFile(candidate);}
        if(target.taskId){
          if(this.row('SELECT 1 FROM code_workspace_leases WHERE task_id=?',target.taskId)){op.queueTaskId=target.taskId;await this.heartbeat(op);}
          else op.snapshot=await this.prepareSnapshot(op,target.taskId,op.candidates);
        }
        await this.finalizeOperation(op,beforeCommit);
        return{versionIds:op.candidates.map(c=>c.versionId),...(op.queueTaskId&&this.row("SELECT 1 FROM task_artifact_deliveries WHERE task_id=? AND state='pending'",op.queueTaskId)?{deliveryDeferred:true}:{})};
      }catch(cause){await this.abandoned(op);throw cause;}
    });
  }

  /** beforeCommit is a trusted synchronous broker fence, never a renderer argument. */
  async publish({principal,versionId,beforeCommit}:{principal:Principal;versionId:string;beforeCommit?:()=>void}):Promise<{versionIds:string[]}> {
    return this.run(async()=>{
      this.owner(principal);const source=this.access(principal,versionId);await this.verify(source);
      if(source.visibility==='shared')return{versionIds:[versionId]};
      const group=this.row('SELECT * FROM artifacts WHERE published_from_artifact_id=?',source.artifact_id);
      if(group){const published=this.row('SELECT id FROM artifact_versions WHERE artifact_id=? AND source_version_id=?',group.id,versionId);if(published){await this.verify(this.access(principal,String(published.id)));return{versionIds:[String(published.id)]};}}
      if(Number(this.row('SELECT COUNT(*) AS n FROM artifact_versions')!.n)>=FILE_LIMITS.versions)throw error('limit_exceeded');
      const logical=group?String(group.id):randomUUID(),number=Number(this.row('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM artifact_versions WHERE artifact_id=?',logical)!.n),op=this.operation('publish');
      const candidate=this.candidate(randomUUID(),logical,String(source.display_name),{scope:'shared',agentId:source.owner_agent_id===null?null:String(source.owner_agent_id),taskId:source.producer_task_id===null?null:String(source.producer_task_id)},number,versionId,String(source.artifact_id),`${op.stage}/content${extname(String(source.storage_ref))}`);
      candidate.codeSource=this.display(source).codeSource;
      op.candidates=[candidate];await this.reserve(op,Number(source.bytes)+METADATA_RESERVE);
      try {
        const copied=await secureCopy(join(this.root,String(source.storage_ref)),join(this.root,candidate.stage),{managedRoot:this.root,sourceRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:String(source.sha256),fileName:String(source.display_name)});
        Object.assign(candidate,{bytes:copied.bytes,sha256:copied.sha256,mime:copied.mime,format:copied.format});await this.heartbeat(op);this.fault?.('after_stage');
        op.finals=[dirname(candidate.final)];await this.heartbeat(op);await this.finalFile(candidate);await this.finalizeOperation(op,beforeCommit);return{versionIds:[candidate.versionId]};
      }catch(cause){await this.abandoned(op);throw cause;}
    });
  }

  private taskInputBytes(taskId:string):number {return Number(this.row("SELECT COALESCE(SUM(v.bytes),0) AS n FROM task_artifacts b JOIN artifact_versions v ON v.id=b.version_id WHERE b.task_id=? AND b.role='input'",taskId)!.n);}
  private async prepareSnapshot(op:Operation,taskId:string,added:Candidate[]|Row[]):Promise<SnapshotCandidate> {
    const task=this.task(taskId);const versions=new Map<string,Row|Candidate>();
    for(const binding of this.rows("SELECT version_id FROM task_artifacts WHERE task_id=? AND role='input'",taskId)){const row=this.access({kind:'agent',agentId:String(task.agent_id)},String(binding.version_id));versions.set(String(row.id),row);}
    for(const item of added)versions.set('versionId'in item?String(item.versionId):String(item.id),item);
    const bytes=[...versions.values()].reduce((sum,v)=>sum+Number(v.bytes),0);
    if(bytes>FILE_LIMITS.workspace||versions.size>4096||Number(this.row('SELECT COUNT(*) AS n FROM workspace_snapshots')!.n)>=FILE_LIMITS.snapshots)throw error('limit_exceeded');
    const snapshotId=randomUUID(),snapshot:SnapshotCandidate={id:snapshotId,taskId,revision:Number(this.row('SELECT COALESCE(MAX(revision),0)+1 AS n FROM workspace_snapshots WHERE task_id=?',taskId)!.n),stage:`${op.stage}/snapshot`,final:`private/${task.agent_id}/workspace/tasks/${taskId}/snapshots/${snapshotId}`,bytes,files:[]};
    op.snapshot=snapshot;await this.heartbeat(op);await ensureManagedDirectory(this.root,snapshot.stage);
    for(const [versionId,item]of versions){
      const managed='final'in item?String(item.final):String(item.storage_ref),displayName='displayName'in item?String(item.displayName):String(item.display_name);
      if(!('final'in item))await this.verify(item as Row);
      const path=`inputs/${versionId}/content${extname(managed)}`;await ensureManagedDirectory(this.root,`${snapshot.stage}/${dirname(path)}`);
      const copied=await secureCopy(join(this.root,managed),join(this.root,snapshot.stage,path),{managedRoot:this.root,sourceRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:String(item.sha256),fileName:displayName});
      await chmod(join(this.root,snapshot.stage,path),0o444);snapshot.files.push({path,versionId,bytes:copied.bytes,sha256:copied.sha256});
      await this.syncParents(`${snapshot.stage}/${dirname(path)}`);
    }
    const manifest=await open(join(this.root,snapshot.stage,'manifest.json'),'wx',0o600);
    try{await manifest.writeFile(JSON.stringify({taskId,revision:snapshot.revision,files:snapshot.files},null,2));await manifest.sync();}finally{await manifest.close();}
    await chmod(join(this.root,snapshot.stage,'manifest.json'),0o444);await this.syncParents(snapshot.stage);return snapshot;
  }
  private async finalizeOperation(op:Operation,beforeCommit?:()=>void):Promise<void> {
    if(op.snapshot){await ensureManagedDirectory(this.root,dirname(op.snapshot.final));await assertManagedPath(this.root,join(this.root,op.snapshot.final),{allowMissingLeaf:true});await rename(join(this.root,op.snapshot.stage),join(this.root,op.snapshot.final));op.finals.push(op.snapshot.final);await this.syncParents(dirname(op.snapshot.final));await this.syncParents(op.stage);}
    this.open();await this.heartbeat(op);
    this.transaction(()=>this.write("UPDATE artifact_operations SET state='finalized' WHERE id=?",op.id));this.fault?.('after_finalize');
    this.transaction(()=>{
      const owned=this.row("SELECT id FROM artifact_operations WHERE id=? AND owner_id=? AND state='finalized'",op.id,this.instanceId);if(!owned)throw error('operation_failed');
      this.fault?.('before_metadata_commit');
      const fenceResult:unknown=beforeCommit?.();
      if(fenceResult&&typeof fenceResult==='object'&&'then' in fenceResult){void Promise.resolve(fenceResult).catch(()=>{});throw error('stale_workspace');}
      for(const c of op.candidates){
        if(!this.row('SELECT id FROM artifacts WHERE id=?',c.artifactId))this.write('INSERT INTO artifacts(id,owner_agent_id,producer_task_id,visibility,display_name,created_at,published_from_artifact_id) VALUES (?,?,?,?,?,?,?)',c.artifactId,c.ownerAgentId,c.producerTaskId,c.visibility,c.displayName,this.now(),c.publishedFrom);
        const browser = c as BrowserCandidate;
        this.write("INSERT INTO artifact_versions(id,artifact_id,storage_ref,sha256,bytes,mime,provenance,status,created_at,version_number,format,source_version_id) VALUES (?,?,?,?,?,?,?,'ready',?,?,?,?)",c.versionId,c.artifactId,c.final,c.sha256,c.bytes,c.mime,JSON.stringify({sourceVersionId:c.sourceVersionId,importedBy:browser.browserSource?'browser':'owner',originalName:c.originalName||c.displayName,...(browser.browserSource?{browserSource:browser.browserSource,browserDownloadKey:browser.browserDownloadKey}:{}),...(c.codeSource?{codeSource:c.codeSource}:{})}),this.now(),c.version,c.format,c.sourceVersionId);
        this.event(op.kind==='publish'?'artifact.published':'artifact.imported',c.artifactId,c.version,{versionId:c.versionId,visibility:c.visibility,producerTaskId:c.producerTaskId});
      }
      if(op.snapshot){const s=op.snapshot;
        if(this.row('SELECT 1 FROM code_workspace_leases WHERE task_id=?',s.taskId))throw error('workspace_busy');
        for(const f of s.files)this.write("INSERT OR IGNORE INTO task_artifacts(task_id,version_id,role,created_at) VALUES (?,?,'input',?)",s.taskId,f.versionId,this.now());
        for(const f of s.files)this.write("UPDATE task_artifact_deliveries SET state='delivered',delivered_at=? WHERE task_id=? AND version_id=? AND state='pending'",this.now(),s.taskId,f.versionId);
        this.write("INSERT INTO workspace_snapshots(id,task_id,revision,storage_ref,manifest,bytes,file_count,status,created_at) VALUES (?,?,?,?,?,?,?,'ready',?)",s.id,s.taskId,s.revision,s.final,JSON.stringify(s.files),s.bytes,s.files.length,this.now());
        this.write('INSERT INTO workspace_heads(task_id,snapshot_id) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET snapshot_id=excluded.snapshot_id',s.taskId,s.id);
        this.event('workspace.snapshot_committed',s.taskId,s.revision,{snapshotId:s.id,files:s.files.length});
      }
      if(op.queueTaskId)for(const c of op.candidates){
        this.write("INSERT OR IGNORE INTO task_artifact_deliveries(task_id,version_id,state,created_at) VALUES (?,?,'pending',?)",op.queueTaskId,c.versionId,this.now());
        this.event('workspace.input_queued',op.queueTaskId,1,{versionId:c.versionId});
      }
      this.write("UPDATE artifact_operations SET state='committed',reserved_bytes=0,updated_at=? WHERE id=?",this.now(),op.id);
    });
    op.committed=true;
    this.fault?.('after_metadata_commit');
    await this.postcommitCleanup(op);
    if(op.queueTaskId)await this.deliverQueuedInputs(op.queueTaskId).catch(()=>undefined);
  }

  async useInTask({principal,taskId,versionId}:{principal:Principal;taskId:string;versionId:string}):Promise<{deliveryDeferred?:boolean}> {
    return this.run(async()=>{
      const task=this.taskAccess(principal,taskId);const source=this.access({kind:'agent',agentId:String(task.agent_id)},versionId);await this.verify(source);
      if(this.row('SELECT 1 FROM task_artifacts WHERE task_id=? AND version_id=?',taskId,versionId))return{};
      if(this.row('SELECT 1 FROM code_workspace_leases WHERE task_id=?',taskId)){
        if(this.row("SELECT 1 FROM task_artifact_deliveries WHERE task_id=? AND version_id=? AND state='pending'",taskId,versionId))return{deliveryDeferred:true};
        const pendingBytes=Number(this.row("SELECT COALESCE(SUM(v.bytes),0) AS n FROM task_artifact_deliveries d JOIN artifact_versions v ON v.id=d.version_id WHERE d.task_id=? AND d.state='pending'",taskId)!.n);
        if(this.taskInputBytes(taskId)+pendingBytes+Number(source.bytes)>FILE_LIMITS.workspace)throw error('limit_exceeded');
        this.transaction(()=>{this.write("INSERT OR IGNORE INTO task_artifact_deliveries(task_id,version_id,state,created_at) VALUES (?,?,'pending',?)",taskId,versionId,this.now());this.event('workspace.input_queued',taskId,1,{versionId});});return{deliveryDeferred:true};
      }
      const op=this.operation('use');await this.reserve(op,this.taskInputBytes(taskId)+Number(source.bytes)+METADATA_RESERVE);
      try{op.snapshot=await this.prepareSnapshot(op,taskId,[source]);this.fault?.('after_stage');await this.finalizeOperation(op);}catch(cause){await this.abandoned(op);throw cause;}
      return{};
    });
  }
  async createSnapshot({principal,taskId}:{principal:Principal;taskId:string}):Promise<WorkspaceSnapshot> {
    return this.run(async()=>{this.taskAccess(principal,taskId);const op=this.operation('snapshot');await this.reserve(op,this.taskInputBytes(taskId)+METADATA_RESERVE);try{op.snapshot=await this.prepareSnapshot(op,taskId,[]);this.fault?.('after_stage');await this.finalizeOperation(op);return this.snapshots().find(s=>s.id===op.snapshot!.id)!;}catch(cause){await this.abandoned(op);throw cause;}});
  }
  /** Owner-selected replacement restores only the immutable bytes recorded for this exact version. */
  async repairVersion({principal,versionId,sourcePath}:{principal:Principal;versionId:string;sourcePath:string}):Promise<ArtifactVersion> {
    return this.run(async()=>{
      this.owner(principal);const version=this.version(versionId);
      if(!['missing','corrupt'].includes(String(version.status)))throw error('integrity_error');
      const op=this.operation('repair');await this.reserve(op,Number(version.bytes)+METADATA_RESERVE);
      try{
        const staged=join(this.root,op.stage,'replacement');
        const copied=await secureCopy(sourcePath,staged,{managedRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:String(version.sha256),fileName:String(version.display_name)});
        if(copied.bytes!==Number(version.bytes))throw error('integrity_error');
        const destination=join(this.root,String(version.storage_ref));await ensureManagedDirectory(this.root,dirname(String(version.storage_ref)));
        await assertManagedPath(this.root,destination,{allowMissingLeaf:true});
        await chmod(staged,0o444);await rename(staged,destination);await this.syncParents(dirname(String(version.storage_ref)));
        await this.verify(version);
        this.transaction(()=>{this.write("UPDATE artifact_versions SET status='ready' WHERE id=?",versionId);this.write("UPDATE artifact_operations SET state='committed',reserved_bytes=0 WHERE id=?",op.id);this.event('artifact.repaired',String(version.artifact_id),Number(version.version_number),{versionId});});
        op.committed=true;await this.postcommitCleanup(op);return this.display(this.version(versionId));
      }catch(cause){await this.abandoned(op);throw cause;}
    });
  }
  /** Exact immutable source byte interval, UTF8 boundaries expand at most three bytes per edge. */
  async readRange({principal,versionId,offset,length}:{principal:Principal;versionId:string;offset:number;length:number}):Promise<{version:ArtifactVersion;requestedOffset:number;requestedLength:number;start:number;end:number;text:string;complete:boolean}> {
    return this.run(async()=>{
      const version=this.access(principal,versionId);
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>65536||offset>Number(version.bytes))throw error('limit_exceeded');
      if(!['txt','text','md','markdown','csv','json'].includes(String(version.format)))throw error('file_invalid');
      const path=await assertManagedPath(this.root,join(this.root,String(version.storage_ref))),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const before=await file.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(Number(version.bytes)))throw error('integrity_error');
        const lower=Math.max(0,offset-3),upper=Math.min(Number(version.bytes),offset+length+3),selected=Buffer.alloc(upper-lower),chunk=Buffer.alloc(65536),hash=createHash('sha256');let position=0;
        while(true){const read=await file.read(chunk,0,chunk.length,position);if(!read.bytesRead)break;hash.update(chunk.subarray(0,read.bytesRead));const a=Math.max(position,lower),b=Math.min(position+read.bytesRead,upper);if(a<b)chunk.copy(selected,a-lower,a-position,b-position);position+=read.bytesRead;if(position>FILE_LIMITS.file)throw error('limit_exceeded');}
        const after=await file.stat({bigint:true}),named=await lstat(path,{bigint:true});
        if(position!==Number(version.bytes)||hash.digest('hex')!==version.sha256||before.ino!==after.ino||before.dev!==after.dev||before.ctimeNs!==after.ctimeNs||before.mtimeNs!==after.mtimeNs||named.ino!==after.ino||named.dev!==after.dev||named.ctimeNs!==after.ctimeNs||after.nlink!==1n)throw error('integrity_error');
        let start=offset-lower,end=Math.min(offset+length,position)-lower;
        while(start>0&&(selected[start]&0xc0)===0x80)start--;
        while(end<selected.length&&(selected[end]&0xc0)===0x80)end++;
        const text=new TextDecoder('utf-8',{fatal:true}).decode(selected.subarray(start,end));
        return{version:this.display(version),requestedOffset:offset,requestedLength:length,start:lower+start,end:lower+end,text,complete:lower+start===0&&lower+end===position};
      }finally{await file.close();}
    });
  }
  async preview({principal,versionId}:{principal:Principal;versionId:string}):Promise<ArtifactPreview> {
    return this.run(async()=>{
      const version=this.access(principal,versionId);await this.verify(version);
      const textTypes=['txt','text','md','markdown','csv','json'];
      if(!textTypes.includes(String(version.format)))return{version:this.display(version),text:null,truncated:false,note:'Metadata preview only. Complex document/image parsing is deferred to the isolated execution service.'};
      const preview=await safeTextPreview(join(this.root,String(version.storage_ref)),{maxBytes:65536,managedRoot:this.root,expectedSha256:String(version.sha256)});
      return{version:this.display(version),text:preview.text,truncated:preview.truncated,note:'Plain text only; scripts, markup and document macros are not executed.'};
    });
  }
  /** Fixed validation workers receive bounded data, never a managed host path. */
  async readForValidation(agentId:string,versionId:string,includeText:boolean):Promise<{version:ArtifactVersion;text:string|null}> {
    return this.run(async()=>{
      const version=this.access({kind:'agent',agentId},versionId);await this.verify(version);
      if(!includeText)return{version:this.display(version),text:null};
      if(Number(version.bytes)>1024*1024)throw new ArtifactError('validation_limit','Content validation supports complete UTF-8 files up to 1 MiB.');
      const path=await assertManagedPath(this.root,join(this.root,String(version.storage_ref))),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const before=await file.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(Number(version.bytes)))throw error('integrity_error');
        const buffer=Buffer.alloc(Number(version.bytes)+1);let count=0;
        while(count<buffer.length){const read=await file.read(buffer,count,buffer.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
        const after=await file.stat({bigint:true}),named=await lstat(path,{bigint:true});
        if(count!==Number(version.bytes)||createHash('sha256').update(buffer.subarray(0,count)).digest('hex')!==version.sha256||before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.ctimeNs!==after.ctimeNs||before.mtimeNs!==after.mtimeNs||after.nlink!==1n||named.ino!==after.ino||named.dev!==after.dev||named.ctimeNs!==after.ctimeNs)throw error('integrity_error');
        await assertManagedPath(this.root,path);let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count));}catch{throw error('file_invalid');}if(text.includes('\0'))throw error('file_invalid');
        return{version:this.display(version),text};
      }finally{await file.close();}
    });
  }
  async exportFile({principal,versionId,destination}:{principal:Principal;versionId:string;destination:string}):Promise<void> {
    return this.run(async()=>{
      this.owner(principal);const version=this.access(principal,versionId);await this.verify(version);
      const op=this.operation('export');await this.reserve(op,Number(version.bytes)+METADATA_RESERVE);
      try{
        // Reserve the external temporary copy without recording a path or granting recovery external deletion rights.
        await exportVerifiedFile(join(this.root,String(version.storage_ref)),destination,{sourceRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:String(version.sha256),fileName:String(version.display_name),afterChunk:()=>this.open()});
        this.transaction(()=>{
          if(!this.row("SELECT id FROM artifact_operations WHERE id=? AND owner_id=? AND state='staging'",op.id,this.instanceId))throw error('operation_failed');
          this.event('artifact.exported',versionId,Number(version.version_number),{});
          this.write("UPDATE artifact_operations SET state='committed',reserved_bytes=0,updated_at=? WHERE id=?",this.now(),op.id);
        });
        op.committed=true;await this.postcommitCleanup(op);
      }catch(cause){await this.abandoned(op);throw cause;}
    });
  }
  async updateBudget(budgetBytes:number):Promise<void> {
    return this.run(async()=>{if(!Number.isSafeInteger(budgetBytes)||budgetBytes<64*1024*1024||budgetBytes>64*1024**3)throw error('limit_exceeded');const used=await this.measure();if(budgetBytes<used+METADATA_RESERVE)throw error('storage_full');this.transaction(()=>{this.write('UPDATE artifact_settings SET budget_bytes=? WHERE id=1',budgetBytes);this.event('storage.budget_changed','storage',1,{budgetBytes});});});
  }

  /** Trusted service reservation, never exposed as a renderer/model tool. */
  async reserveExternal(kind: string, bytes: number): Promise<(() => Promise<void>) & {directory:string}> {
    if(!['browser-profile','browser-download','code-execution','agent-report','live-step-trace','selected-connector-input'].includes(kind)||!Number.isSafeInteger(bytes)||bytes<0||bytes>1024**3)throw error('limit_exceeded');
    const op=this.operation(kind);
    await this.run(()=>this.reserve(op,bytes+METADATA_RESERVE));
    let released=false;
    const release=async()=>{if(released)return;
      if(this.closed){await this.removeManaged(op.stage);released=true;return;}
      await this.run(async()=>{this.transaction(()=>this.write("UPDATE artifact_operations SET state='committed',reserved_bytes=0,updated_at=? WHERE id=?",this.now(),op.id));op.committed=true;await this.removeManaged(op.stage);await this.measure();});released=true;
    };
    return Object.assign(release,{directory:join(this.root,op.stage)});
  }

  /** Verified scope-bound transfer copy; callers receive no access to siblings. */
  async stageForBrowser(principal: Principal, versionId: string): Promise<{path:string;version:ArtifactVersion;release:()=>Promise<void>}> {
    return this.run(async()=>{
      const version=this.access(principal,versionId);await this.verify(version);const op=this.operation('browser-upload');
      await this.reserve(op,Number(version.bytes)+METADATA_RESERVE);
      const path=join(this.root,op.stage,'content');
      try{await secureCopy(join(this.root,String(version.storage_ref)),path,{sourceRoot:this.root,managedRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:String(version.sha256),fileName:String(version.display_name)});}
      catch(cause){await this.abandoned(op);throw cause;}
      let released=false;
      return{path,version:this.display(version),release:async()=>{if(released)return;
        if(this.closed){await this.removeManaged(op.stage);released=true;return;}
        await this.run(async()=>{this.transaction(()=>this.write("UPDATE artifact_operations SET state='committed',reserved_bytes=0 WHERE id=?",op.id));op.committed=true;await this.removeManaged(op.stage);await this.measure();});released=true;
      }};
    });
  }

  async codeWorkspaceChanges(principal:Principal,taskId:string):Promise<{revision:number;parentRevision:number|null;added:string[];removed:string[];modified:string[]}> {
    return this.run(async()=>{
      this.taskAccess(principal,taskId);
      const head=this.row('SELECT r.* FROM code_workspace_heads h JOIN code_workspace_revisions r ON r.id=h.revision_id WHERE h.task_id=?',taskId);
      if(!head)return{revision:0,parentRevision:null,added:[],removed:[],modified:[]};
      await this.verifyCodeRevision(head);
      const parent=head.parent_id?this.row('SELECT * FROM code_workspace_revisions WHERE id=? AND task_id=?',head.parent_id,taskId):undefined;
      if(head.parent_id&&!parent)throw error('integrity_error');if(parent)await this.verifyCodeRevision(parent);
      const after=new Map((JSON.parse(String(head.manifest)) as CodeWorkspaceFile[]).map(f=>[f.path,f]));
      const priorFiles=(parent?JSON.parse(String(parent.manifest)):[]) as CodeWorkspaceFile[];
      const before=new Map<string,CodeWorkspaceFile>(priorFiles.map(f=>[f.path,f]));
      return{revision:Number(head.revision),parentRevision:parent?Number(parent.revision):null,added:[...after.keys()].filter(p=>!before.has(p)).sort(),removed:[...before.keys()].filter(p=>!after.has(p)).sort(),modified:[...after.keys()].filter(p=>before.has(p)&&(after.get(p)!.sha256!==before.get(p)!.sha256||after.get(p)!.bytes!==before.get(p)!.bytes)).sort()};
    });
  }
  latestCodeRevision(taskId:string):number {
    return Number(this.row('SELECT r.revision FROM code_workspace_heads h JOIN code_workspace_revisions r ON r.id=h.revision_id WHERE h.task_id=?',id(taskId))?.revision||0);
  }
  pendingCodeInputs(taskId:string):ArtifactVersion[] {
    const task=this.task(taskId);
    return this.rows("SELECT version_id FROM task_artifact_deliveries WHERE task_id=? AND state='pending' ORDER BY created_at,rowid",taskId).map(row=>this.display(this.access({kind:'agent',agentId:String(task.agent_id)},String(row.version_id))));
  }
  codeInputManifest(taskId:string,versionIds?:string[]):CodeInput[] {
    const task=this.task(taskId);
    const selected=versionIds??this.rows("SELECT version_id FROM task_artifacts WHERE task_id=? AND role='input' ORDER BY created_at,rowid",taskId).map(row=>String(row.version_id));
    if(!Array.isArray(selected)||selected.length>(versionIds?128:FILE_LIMITS.versions)||new Set(selected).size!==selected.length)throw error('limit_exceeded');
    return selected.map(versionId=>{
      if(!this.row('SELECT 1 FROM task_artifacts WHERE task_id=? AND version_id=?',taskId,id(versionId)))throw error('permission_denied');
      const v=this.access({kind:'agent',agentId:String(task.agent_id)},versionId),shared=v.visibility==='shared';
      return{versionId,displayName:String(v.display_name),containerPath:`${shared?'/shared':'/workspace/inputs'}/${versionId}/content${extname(String(v.storage_ref))}`,bytes:Number(v.bytes),visibility:shared?'shared':'private'};
    });
  }
  private assertCodeLease(options:CodeWorkspaceOptions,baseRevision:string|null):void {
    options.assertCurrent();
    const lease=this.row('SELECT * FROM code_workspace_leases WHERE task_id=?',options.taskId);
    const execution=this.row('SELECT task_id,agent_id,lifecycle FROM code_executions WHERE id=?',options.executionId);
    const head=this.row('SELECT revision_id FROM code_workspace_heads WHERE task_id=?',options.taskId);
    if(!lease||lease.execution_id!==options.executionId||lease.agent_id!==options.agentId||lease.owner_id!==this.instanceId||lease.base_revision_id!==baseRevision||
      !execution||execution.task_id!==options.taskId||execution.agent_id!==options.agentId||!['preparing','running','exporting'].includes(String(execution.lifecycle))||
      (head?.revision_id??null)!==baseRevision)throw error('stale_workspace');
  }
  /** Holds a durable task lock, not the global file queue, while the container runs. */
  async beginCodeWorkspace(options:CodeWorkspaceOptions):Promise<CodeWorkspaceLease> {
    return this.run(async()=>{
      const {taskId,agentId,executionId}=options;id(executionId);const task=this.task(taskId);
      if(task.agent_id!==agentId)throw error('permission_denied');
      await this.deliverQueuedInputs(taskId);
      const inputs=this.codeInputManifest(taskId,options.versionIds);
      const head=this.row('SELECT r.* FROM code_workspace_heads h JOIN code_workspace_revisions r ON r.id=h.revision_id WHERE h.task_id=?',taskId);
      if(head&&head.status!=='ready')throw error('integrity_error');
      const baseRevision=head?String(head.id):null,baseRevisionNumber=head?Number(head.revision):0;
      this.transaction(()=>{
        options.assertCurrent();
        const execution=this.row('SELECT task_id,agent_id,lifecycle FROM code_executions WHERE id=?',executionId);
        if(!execution||execution.task_id!==taskId||execution.agent_id!==agentId||!['preparing','running','exporting'].includes(String(execution.lifecycle)))throw error('stale_workspace');
        if(this.row('SELECT 1 FROM code_workspace_leases WHERE task_id=?',taskId))throw error('workspace_busy');
        if((this.row('SELECT revision_id FROM code_workspace_heads WHERE task_id=?',taskId)?.revision_id??null)!==baseRevision)throw error('stale_workspace');
        this.write('INSERT INTO code_workspace_leases(task_id,agent_id,execution_id,owner_id,owner_pid,base_revision_id,input_version_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',taskId,agentId,executionId,this.instanceId,process.pid,baseRevision,JSON.stringify(options.versionIds),this.now());
      });
      let released=false;
      const releaseInternal=async()=>{
        if(released)return;
        this.transaction(()=>this.write('DELETE FROM code_workspace_leases WHERE task_id=? AND execution_id=? AND owner_id=?',taskId,executionId,this.instanceId));
        await this.deliverQueuedInputs(taskId);released=true;
      };
      try{
        const files:CodeSeedFile[]=[];
        if(head){
          await this.verifyCodeRevision(head);
          for(const file of JSON.parse(String(head.manifest)) as CodeWorkspaceFile[]){
            if(file.path.startsWith('inputs/')||/^work\/\.aw-execution-/.test(file.path))continue;
            files.push({area:'workspace',...file,sourcePath:join(this.root,String(head.storage_ref),file.path)});
          }
        }
        for(const input of inputs){const version=this.access({kind:'agent',agentId},input.versionId);await this.verify(version);
          files.push({area:input.visibility==='shared'?'shared':'workspace',path:input.containerPath.replace(input.visibility==='shared'?'/shared/':'/workspace/',''),sourcePath:join(this.root,String(version.storage_ref)),bytes:Number(version.bytes),sha256:String(version.sha256)});
        }
        if(files.length>4096||files.reduce((n,f)=>n+f.bytes,0)>FILE_LIMITS.workspace)throw error('limit_exceeded');
        this.transaction(()=>this.assertCodeLease(options,baseRevision));
        return{files,inputs,baseRevision,baseRevisionNumber,
          commit:async(exported,callbacks)=>this.run(async()=>{
            if(released)throw error('stale_workspace');
            const committed=await this.commitCodeWorkspace(options,baseRevision,baseRevisionNumber,exported,callbacks);
            released=true;
            // A failed delivery is retryable; it cannot undo the already committed code receipt.
            await this.deliverQueuedInputs(taskId).catch(()=>undefined);return committed;
          }),
          release:()=>this.run(releaseInternal),
        };
      }catch(cause){await releaseInternal();throw cause;}
    });
  }
  private async commitCodeWorkspace(options:CodeWorkspaceOptions,baseRevision:string|null,baseNumber:number,exported:CodeExportFile[],callbacks:Parameters<CodeWorkspaceLease['commit']>[1]):Promise<CodeWorkspaceReceipt> {
    const checkedOptions={...options,assertCurrent:()=>{options.assertCurrent();callbacks.assertCurrent();}};
    this.transaction(()=>this.assertCodeLease(checkedOptions,baseRevision));
    if(!Array.isArray(exported)||exported.length>4096)throw error('limit_exceeded');
    const paths=new Set<string>();let bytes=0,outputBytes=0;
    for(const file of exported){
      codeWorkspacePath(file.path);const normalized=file.path.normalize('NFC').toLowerCase();
      if(paths.has(normalized)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>FILE_LIMITS.file||!/^[a-f0-9]{64}$/.test(file.sha256))throw error('integrity_error');
      paths.add(normalized);bytes+=file.bytes;if(file.path.startsWith('outputs/'))outputBytes+=file.bytes;
    }
    for(const path of paths){const parts=path.split('/');for(let n=1;n<parts.length;n++)if(paths.has(parts.slice(0,n).join('/')))throw error('integrity_error');}
    const outputs=exported.filter(f=>f.path.startsWith('outputs/'));
    if(bytes>FILE_LIMITS.workspace||Number(this.row('SELECT COUNT(*) AS n FROM artifact_versions')!.n)+outputs.length>FILE_LIMITS.versions||Number(this.row('SELECT COUNT(*) AS n FROM code_workspace_revisions')!.n)>=FILE_LIMITS.snapshots)throw error('limit_exceeded');
    const op=this.operation('code-workspace'),revisionId=randomUUID();
    const revision:CodeRevisionCandidate={id:revisionId,taskId:options.taskId,executionId:options.executionId,parentId:baseRevision,revision:baseNumber+1,stage:`${op.stage}/revision`,final:`private/${options.agentId}/workspace/tasks/${options.taskId}/revisions/${revisionId}`,bytes,files:[]};op.codeRevision=revision;
    await this.reserve(op,bytes+outputBytes+METADATA_RESERVE);
    try{
      this.fault?.('after_preflight');await ensureManagedDirectory(this.root,revision.stage);
      for(const file of [...exported].sort((a,b)=>a.path.localeCompare(b.path))){
        await ensureManagedDirectory(this.root,`${revision.stage}/${dirname(file.path)}`);
        const source=await assertManagedPath(this.root,file.sourcePath);
        const copied=await secureCopy(source,join(this.root,revision.stage,file.path),{managedRoot:this.root,sourceRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:file.sha256,fileName:file.path.startsWith('outputs/')?basename(file.path):'workspace.bin'});
        if(copied.bytes!==file.bytes)throw error('integrity_error');
        await chmod(join(this.root,revision.stage,file.path),0o444);revision.files.push({path:file.path,bytes:copied.bytes,sha256:copied.sha256});await this.syncParents(`${revision.stage}/${dirname(file.path)}`);
        if(file.path.startsWith('outputs/')){
          const c=this.candidate(randomUUID(),randomUUID(),basename(file.path),{scope:'private',agentId:options.agentId,taskId:options.taskId},1,null,null,`${op.stage}/output-${op.candidates.length}`);
          Object.assign(c,{bytes:copied.bytes,sha256:copied.sha256,mime:copied.mime,format:copied.format,codeSource:{executionId:options.executionId,inputVersionIds:options.versionIds}});
          await secureCopy(join(this.root,revision.stage,file.path),join(this.root,c.stage),{managedRoot:this.root,sourceRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:copied.sha256,fileName:c.displayName});op.candidates.push(c);
        }
        await this.heartbeat(op);
      }
      const manifest=await open(join(this.root,revision.stage,'manifest.json'),'wx',0o600);
      try{await manifest.writeFile(this.codeRevisionManifest(revision));await manifest.sync();}finally{await manifest.close();}
      await chmod(join(this.root,revision.stage,'manifest.json'),0o444);await this.syncParents(revision.stage);await this.heartbeat(op);this.fault?.('after_stage');
      op.finals=[revision.final,...op.candidates.map(c=>dirname(c.final))];await this.heartbeat(op);
      for(const c of op.candidates)await this.finalFile(c);
      await ensureManagedDirectory(this.root,dirname(revision.final));await assertManagedPath(this.root,join(this.root,revision.final),{allowMissingLeaf:true});
      await rename(join(this.root,revision.stage),join(this.root,revision.final));await this.syncParents(dirname(revision.final));await this.syncParents(op.stage);
      this.transaction(()=>this.write("UPDATE artifact_operations SET state='finalized',manifest=? WHERE id=? AND owner_id=?",JSON.stringify(op),op.id,this.instanceId));this.fault?.('after_finalize');
      // Reverify finalized bytes immediately before the durable receipt; no payload can address this host storage.
      await this.verifyCodeRevision({id:revision.id,task_id:revision.taskId,execution_id:revision.executionId,parent_id:revision.parentId,revision:revision.revision,storage_ref:revision.final,manifest:JSON.stringify(revision.files)});
      for(const c of op.candidates)await verifyFile(join(this.root,c.final),{managedRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:c.sha256,fileName:c.displayName});
      const receipt:CodeWorkspaceReceipt={revisionId,revision:revision.revision,outputVersionIds:op.candidates.map(c=>c.versionId)};
      this.transaction(()=>{
        this.assertCodeLease(checkedOptions,baseRevision);
        if(!this.row("SELECT 1 FROM artifact_operations WHERE id=? AND owner_id=? AND state='finalized'",op.id,this.instanceId))throw error('stale_workspace');
        this.fault?.('before_metadata_commit');
        for(const c of op.candidates){
          this.write("INSERT INTO artifacts(id,owner_agent_id,producer_task_id,visibility,display_name,created_at) VALUES (?,?,?,'private',?,?)",c.artifactId,options.agentId,options.taskId,c.displayName,this.now());
          this.write("INSERT INTO artifact_versions(id,artifact_id,storage_ref,sha256,bytes,mime,provenance,status,created_at,version_number,format) VALUES (?,?,?,?,?,?,?,'ready',?,1,?)",c.versionId,c.artifactId,c.final,c.sha256,c.bytes,c.mime,JSON.stringify({importedBy:'code',codeSource:c.codeSource}),this.now(),c.format);
          this.write("INSERT INTO task_artifacts(task_id,version_id,role,created_at) VALUES (?,?,'output',?)",options.taskId,c.versionId,this.now());
          this.event('artifact.code_output',c.artifactId,1,{versionId:c.versionId,executionId:options.executionId,visibility:'private'});
        }
        this.write("INSERT INTO code_workspace_revisions(id,task_id,execution_id,parent_id,revision,storage_ref,manifest,bytes,file_count,status,output_version_ids,created_at) VALUES (?,?,?,?,?,?,?,?,?,'ready',?,?)",revisionId,options.taskId,options.executionId,baseRevision,revision.revision,revision.final,JSON.stringify(revision.files),bytes,revision.files.length,JSON.stringify(receipt.outputVersionIds),this.now());
        this.write('INSERT INTO code_workspace_heads(task_id,revision_id) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET revision_id=excluded.revision_id',options.taskId,revisionId);
        callbacks.onCommit?.(receipt);
        this.write('DELETE FROM code_workspace_leases WHERE task_id=? AND execution_id=? AND owner_id=?',options.taskId,options.executionId,this.instanceId);
        this.write("UPDATE artifact_operations SET state='committed',reserved_bytes=0,updated_at=? WHERE id=?",this.now(),op.id);
        this.event('workspace.code_committed',options.taskId,revision.revision,{executionId:options.executionId,revisionId,outputVersionIds:receipt.outputVersionIds});
      });
      op.committed=true;this.fault?.('after_metadata_commit');await this.postcommitCleanup(op);return receipt;
    }catch(cause){await this.abandoned(op);throw cause;}
  }
  private codeRevisionManifest(revision:Pick<CodeRevisionCandidate,'taskId'|'executionId'|'parentId'|'revision'|'files'>):string {
    return JSON.stringify({taskId:revision.taskId,executionId:revision.executionId,parentId:revision.parentId,revision:revision.revision,files:revision.files},null,2);
  }
  private async verifyCodeRevision(row:Row):Promise<void> {
    const files=JSON.parse(String(row.manifest)) as CodeWorkspaceFile[],root=await assertManagedPath(this.root,join(this.root,String(row.storage_ref)));
    if(!Array.isArray(files)||files.length>4096)throw error('integrity_error');
    const manifest=this.codeRevisionManifest({taskId:String(row.task_id),executionId:String(row.execution_id),parentId:row.parent_id===null?null:String(row.parent_id),revision:Number(row.revision),files});
    await verifyFile(join(root,'manifest.json'),{managedRoot:this.root,maxBytes:4*1024*1024,fileName:'manifest.bin',expectedSha256:createHash('sha256').update(manifest).digest('hex')});
    for(const file of files){codeWorkspacePath(file.path);const checked=await verifyFile(join(root,file.path),{managedRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:file.sha256,fileName:'workspace.bin'});if(checked.bytes!==file.bytes)throw error('integrity_error');}
  }
  private async deliverQueuedInputs(taskId:string):Promise<void> {
    if(this.row('SELECT 1 FROM code_workspace_leases WHERE task_id=?',taskId))return;
    const pending=this.rows("SELECT version_id FROM task_artifact_deliveries WHERE task_id=? AND state='pending' ORDER BY created_at,rowid",taskId);
    if(!pending.length)return;
    const task=this.task(taskId),versions=pending.map(row=>this.access({kind:'agent',agentId:String(task.agent_id)},String(row.version_id)));
    const op=this.operation('queued-inputs');await this.reserve(op,this.taskInputBytes(taskId)+versions.reduce((sum,v)=>sum+Number(v.bytes),0)+METADATA_RESERVE);
    try{op.snapshot=await this.prepareSnapshot(op,taskId,versions);await this.finalizeOperation(op);}catch(cause){await this.abandoned(op);throw cause;}
  }

  private async removeManaged(path:string):Promise<void> {
    if(!path)return;
    const permitted=/^staging\/artifacts\/[a-zA-Z0-9_-]{1,96}$/.test(path)||/^artifacts\/(private\/[a-zA-Z0-9_-]{1,96}|shared)\/[a-zA-Z0-9_-]{1,96}\/[a-zA-Z0-9_-]{1,96}$/.test(path)||/^private\/[a-zA-Z0-9_-]{1,96}\/workspace\/tasks\/[a-zA-Z0-9_-]{1,96}\/(snapshots|revisions)\/[a-zA-Z0-9_-]{1,96}$/.test(path);
    if(!permitted)throw error('integrity_error');
    try{await assertManagedPath(this.root,join(this.root,path));await rm(join(this.root,path),{recursive:true,force:true});}catch(cause){if(!['ENOENT','file_missing'].includes((cause as {code?:string})?.code||''))throw cause;}
  }
  private async reconcileInternal():Promise<void> {
    for(const row of this.rows('SELECT * FROM artifact_operations')){
      this.open();const op=JSON.parse(String(row.manifest)) as Operation;
      if(row.state==='committed'){await this.removeManaged(op.stage);continue;}
      if(row.state!=='abandoned'&&processAlive(Number(row.owner_pid)))continue;
      for(const final of op.finals)await this.removeManaged(final);
      if(op.snapshot)await this.removeManaged(op.snapshot.final);
      await this.removeManaged(op.stage);
      this.transaction(()=>this.write("UPDATE artifact_operations SET state='abandoned',reserved_bytes=0,lease_until=0 WHERE id=?",row.id));
    }
    // Operations are journaled before staging directories are created; unreferenced staging is abandoned.
    const known=new Set(this.rows('SELECT id FROM artifact_operations').map(row=>String(row.id)));
    const staging=join(this.root,'staging/artifacts');
    for(const entry of await readdir(staging,{withFileTypes:true}))if(!known.has(entry.name)){await this.removeManaged(`staging/artifacts/${entry.name}`);}
    for(const version of this.rows("SELECT v.*,a.display_name FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.status='ready'")){if(this.closed)return;try{await this.verify(version);}catch(cause){if(this.closed)return;if(!(cause instanceof ArtifactError))throw cause;}}
    for(const row of this.rows("SELECT * FROM workspace_snapshots WHERE status='ready'")){
      if(this.closed)return;
      try{
        const files=JSON.parse(String(row.manifest)) as SnapshotCandidate['files'],root=await assertManagedPath(this.root,join(this.root,String(row.storage_ref)));
        // SQLite holds the trusted manifest; the filesystem copy is only verified, never parsed or followed.
        const manifest=JSON.stringify({taskId:String(row.task_id),revision:Number(row.revision),files},null,2);
        const verifiedManifest=await verifyFile(join(root,'manifest.json'),{managedRoot:this.root,maxBytes:2*1024*1024,fileName:'manifest.bin',expectedSha256:createHash('sha256').update(manifest).digest('hex')});
        if(verifiedManifest.bytes!==Buffer.byteLength(manifest))throw error('integrity_error');
        for(const file of files){const verified=await verifyFile(join(root,file.path),{managedRoot:this.root,maxBytes:FILE_LIMITS.file,expectedSha256:file.sha256});if(verified.bytes!==file.bytes)throw error('integrity_error');}
      }
      catch{this.open();this.transaction(()=>{this.write("UPDATE workspace_snapshots SET status='corrupt' WHERE id=?",row.id);this.event('workspace.integrity_failed',String(row.task_id),Number(row.revision),{snapshotId:row.id});});}
    }
    for(const revision of this.rows("SELECT * FROM code_workspace_revisions WHERE status='ready'")){
      try{await this.verifyCodeRevision(revision);}catch{this.transaction(()=>{this.write("UPDATE code_workspace_revisions SET status='corrupt' WHERE id=?",revision.id);this.event('workspace.integrity_failed',String(revision.task_id),Number(revision.revision),{revisionId:revision.id});});}
    }
    for(const lease of this.rows('SELECT l.*,e.lifecycle FROM code_workspace_leases l JOIN code_executions e ON e.id=l.execution_id')){
      if(processAlive(Number(lease.owner_pid))&&['preparing','running','exporting','stopping'].includes(String(lease.lifecycle)))continue;
      this.transaction(()=>this.write('DELETE FROM code_workspace_leases WHERE task_id=? AND execution_id=?',lease.task_id,lease.execution_id));
    }
    for(const task of this.rows("SELECT DISTINCT task_id FROM task_artifact_deliveries WHERE state='pending'")){
      try{await this.deliverQueuedInputs(String(task.task_id));}catch{this.event('workspace.input_delivery_deferred',String(task.task_id),1,{reason:'file_or_storage_check_failed'});}
    }
    if(!this.closed)try{await this.measure();}catch(cause){if(this.closed)return;this.transaction(()=>this.event('storage.scan_failed','storage',1,{reason:'unsafe_managed_entry'}));}
  }
  async reconcile():Promise<void>{return this.run(()=>this.reconcileInternal());}
  close():void{if(this.closed)return;this.closed=true;this.persistence.transaction(()=>this.write("UPDATE artifact_operations SET state='abandoned',reserved_bytes=0,lease_until=0 WHERE owner_id=? AND state IN ('staging','finalized')",this.instanceId));}
  async drain():Promise<void>{await Promise.allSettled([...this.pending]);}
}
