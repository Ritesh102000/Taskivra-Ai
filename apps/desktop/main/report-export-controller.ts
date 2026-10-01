import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactService } from '../../../packages/artifacts';
import { exportVerifiedFile } from '../../../packages/artifacts/safe-io';
import type { ResultService } from '../../../packages/results';
import type { ReportExportFormat, ReportExportResult } from '../../../packages/contracts/results';
import { identity, record } from '../../../packages/contracts/live-validation';
import { createDocxReport, createXlsxReport, MAX_FORMATTED_EXPORT_BYTES, renderReportHtml, type ExportSource } from '../../../packages/report-export';

export interface ReportExportOptions {
  results: ResultService; artifacts: ArtifactService;
  saveDialog: (suggestedName: string, format: ReportExportFormat) => Promise<string | null>;
  renderPdf: (html: string) => Promise<Buffer>;
}
/** Owner-only boundary: source identities arrive through IPC; destination paths
 * originate only in a native save dialog. No model export or path argument. */
export class ReportExportController {
  private active: Promise<ReportExportResult> | null = null;
  constructor(private options: ReportExportOptions) {}
  handle(raw: unknown): Promise<ReportExportResult> {
    if (this.active) return Promise.reject(new Error('Finish the current report export before starting another.'));
    const work = this.execute(raw); this.active = work;
    void work.finally(() => { if (this.active === work) this.active = null; }).catch(() => undefined);
    return work;
  }
  private async execute(raw: unknown): Promise<ReportExportResult> {
    const input = record(raw, ['type', 'taskId', 'versionId', 'format']);
    if (input.type !== 'results.exportReport' || !['pdf', 'docx', 'xlsx'].includes(String(input.format))) throw new Error('Choose a supported report export.');
    const taskId = identity(input.taskId), versionId = identity(input.versionId), format = input.format as ReportExportFormat;
    const detail = await this.options.results.inspect(taskId, versionId);
    const sourceType = detail.result.version.format;
    if (!(format === 'xlsx' ? sourceType === 'csv' : ['md', 'markdown', 'txt', 'text'].includes(sourceType))) throw new Error('Choose PDF or Word for a text report, or Excel for a CSV result.');
    const name = detail.result.version.displayName.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 100).trim() || 'Report';
    const destination = await this.options.saveDialog(`${name}.${format}`, format);
    if (!destination) return { cancelled: true, format, sourceVersionId: versionId, sourceSha256: detail.result.version.sha256, message: 'Export cancelled. No file was written.' };
    // The task/output membership and exact bytes are rechecked after the dialog.
    const fresh = await this.options.results.inspect(taskId, versionId);
    const content = await this.options.artifacts.readForValidation(fresh.result.agentId, versionId, true);
    if (content.text === null) throw new Error('The complete report text is unavailable.');
    const source: ExportSource = { version: content.version, text: content.text, taskId, review: fresh.result.review.state };
    const release = await this.options.artifacts.reserveExternal('agent-report', MAX_FORMATTED_EXPORT_BYTES * 2);
    try {
      const bytes = format === 'pdf' ? await this.options.renderPdf(renderReportHtml(source)) : format === 'docx' ? createDocxReport(source) : createXlsxReport(source);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FORMATTED_EXPORT_BYTES || (format === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))) throw new Error('The report renderer did not return a valid bounded export.');
      const sha256 = createHash('sha256').update(bytes).digest('hex'), path = join(release.directory, `report.${format}`);
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      await exportVerifiedFile(path, destination, { sourceRoot: release.directory, expectedSha256: sha256, maxBytes: MAX_FORMATTED_EXPORT_BYTES, fileName: `report.${format}` });
      return { cancelled: false, format, sourceVersionId: versionId, sourceSha256: content.version.sha256, bytes: bytes.length, sha256, message: `Exported ${format.toUpperCase()} from the complete saved version. The original result is unchanged.` };
    } finally { await release(); }
  }
  async drain(): Promise<void> { await this.active?.catch(() => undefined); }
}

/** Main-process PDF rendering. The fixed template's data URL is the only
 * permitted request; JavaScript, networking, downloads, popups and permissions
 * are disabled, and the ephemeral browser is always destroyed. */
export async function renderIsolatedReportPdf(html: string): Promise<Buffer> {
  if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw new Error('This report is too large to format as PDF.');
  const { BrowserWindow, session } = await import('electron');
  const isolated = session.fromPartition(`report-export-${randomUUID()}`, { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  isolated.webRequest.onBeforeRequest((request, callback) => callback({ cancel: request.url !== url }));
  isolated.on('will-download', event => event.preventDefault());
  const window = new BrowserWindow({ show: false, width: 1000, height: 1200, webPreferences: { session: isolated, javascript: false, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => { await window.loadURL(url); return window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true }); })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PDF formatting timed out. The source file is preserved.')), 30000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); if (!window.isDestroyed()) window.destroy(); isolated.webRequest.onBeforeRequest(null); await isolated.clearStorageData().catch(() => undefined); }
}
