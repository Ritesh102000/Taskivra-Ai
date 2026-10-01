import { randomUUID } from 'node:crypto';
import type { RunClaim } from '../coordinator';
import type { CodeService } from '../code';
import type { ArtifactService } from '../artifacts';
import type { DocumentExtractionInput, DocumentExtractionResult } from '../contracts/documents';
import { DOCUMENT_EXTRACTOR } from './source';

export class DocumentError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'DocumentError'; } }
function fail(code: string, message: string): never { throw new DocumentError(code, message); }
export const DOCUMENT_RUNTIME_PACKAGES = [{ name: 'pypdf', version: '6.19.0' }, { name: 'openpyxl', version: '3.1.5' }, { name: 'defusedxml', version: '0.7.1' }];
export function validateExtraction(raw: unknown): Required<Omit<DocumentExtractionInput, 'sheet'>> & { sheet?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_extraction', 'Choose a supplied PDF or XLSX version.');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['versionId', 'pageStart', 'pageCount', 'sheet', 'startRow', 'rowCount', 'startColumn', 'columnCount'].includes(key)) || typeof input.versionId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(input.versionId)) fail('invalid_extraction', 'Only document references and bounded page or cell ranges are accepted.');
  const bounded = (key: string, fallback: number, max: number) => { const value = input[key] ?? fallback; if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) fail('invalid_extraction', 'The requested page or cell range exceeds the extraction limit.'); return Number(value); };
  if (input.sheet !== undefined && (typeof input.sheet !== 'string' || !input.sheet.length || input.sheet.length > 31 || /\x00/.test(input.sheet))) fail('invalid_extraction', 'Choose a valid sheet name.');
  return { versionId: input.versionId, pageStart: bounded('pageStart', 1, 2000), pageCount: bounded('pageCount', 5, 10), startRow: bounded('startRow', 1, 100_000), rowCount: bounded('rowCount', 20, 50), startColumn: bounded('startColumn', 1, 16384), columnCount: bounded('columnCount', 20, 50), ...(input.sheet ? { sheet: input.sheet as string } : {}) };
}
/** Deterministic parsing shares the existing code broker's isolated containers, leases and cancel controls. */
export class DocumentService {
  constructor(private readonly options: { code: CodeService; artifacts: ArtifactService; authorize: (claim: RunClaim) => void }) {}
  async extractForAgent(claim: RunClaim, raw: unknown, beforeDispatch?: () => void): Promise<DocumentExtractionResult> {
    const input = validateExtraction(raw); this.options.authorize(claim);
    const version = this.options.artifacts.getForAgent(claim.agentId, input.versionId);
    if (version.format !== 'pdf' && version.format !== 'xlsx') fail('unsupported_document', 'Extraction supports ordinary PDF and XLSX files. Use text preview for plain-text sources.');
    if (version.bytes > 32 * 1024 * 1024) fail('document_size_limit', 'Document extraction supports files up to 32 MiB. Choose a smaller source or split it first.');
    const state = await this.options.code.handle({ type: 'code.state', taskId: claim.taskId }); this.options.authorize(claim);
    if (!state.runtime.ready || DOCUMENT_RUNTIME_PACKAGES.some(required => !state.runtime.packages.some(item => item.runtime === 'python' && item.name === required.name && item.version === required.version))) fail('document_runtime_required', 'Prepare the reviewed document runtime before extracting PDF or XLSX content.');
    const binding = this.options.artifacts.codeInputManifest(claim.taskId, [input.versionId]).find(item => item.versionId === input.versionId);
    if (!binding) fail('document_input_required', 'Attach this exact document version to the task before extraction.');
    const filename = `extracted-${randomUUID()}.json`;
    const configuration = { ...input, format: version.format, sourceSha256: version.sha256, inputPath: binding.containerPath, outputPath: `/workspace/outputs/${filename}` };
    // JSON is quoted as data, never interpolated as Python syntax supplied by a model or document.
    const source = `${DOCUMENT_EXTRACTOR}\nextract(json.loads(${JSON.stringify(JSON.stringify(configuration))}))\n`;
    const execution = await this.options.code.executeForAgent(claim, { runtime: 'python', source, timeoutSeconds: 30, inputVersionIds: [input.versionId] }, () => { this.options.authorize(claim); beforeDispatch?.(); });
    if (execution.lifecycle !== 'succeeded' || execution.logsTruncated) fail('document_extraction_failed', 'Document extraction did not finish. The file may be encrypted, malformed, too complex, or outside the selected range. Check Activity for the saved bounded diagnostic.');
    this.options.authorize(claim); beforeDispatch?.();
    const output = this.options.artifacts.all().find(item => execution.outputVersionIds.includes(item.id) && item.displayName === filename);
    if (!output || output.bytes > 196608) fail('document_extraction_failed', 'The extraction did not produce a bounded, verified result.');
    const { text } = await this.options.artifacts.readForValidation(claim.agentId, output.id, true); this.options.authorize(claim);
    const data: unknown = JSON.parse(text!);
    if (!data || typeof data !== 'object' || Array.isArray(data) || (data as Record<string, unknown>).sourceSha256 !== version.sha256 || (data as Record<string, unknown>).format !== version.format) fail('document_extraction_failed', 'The extraction result does not match the supplied source.');
    return { sourceVersionId: version.id, sourceSha256: version.sha256, outputVersionId: output.id, executionId: execution.id, format: version.format, data: data as Record<string, unknown>, untrustedFileContent: true };
  }
}
