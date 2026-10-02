import type { ArtifactVersion } from '../contracts';
import type { ResultQuality, ResultQualityCheck } from '../contracts/results';
import { CsvCoverageError, parseCompleteCsv } from './csv';
import { parseMarkdownPreview, PREVIEW_CHAR_LIMIT } from './preview';

export const QUALITY_CHECKER_VERSION = 'structural-2026-10-02.1';
export interface QualityInput {
  version: ArtifactVersion; text: string | null; complete: boolean; completionCriteria: string;
  requiredSections?: string[]; requiredFormat?: string;
  inputVersionIds: string[]; supportingOutputVersionIds?: string[]; evidenceIds: string[]; reportEvidenceIds?: string[];
  now?: number;
}
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[*_`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Checks mechanically observable defects only; no model is called and no source is fetched. */
export function checkResultQuality(input: QualityInput): ResultQuality {
  const checks: ResultQualityCheck[] = [], text = input.text || '';
  const add = (id: string, label: string, status: ResultQualityCheck['status'], message: string) => checks.push({ id, label, status, message });
  const supported = ['md', 'markdown', 'txt', 'text', 'csv', 'json'].includes(input.version.format);
  const complete = input.complete && input.text !== null;
  let coverageComplete = complete;
  if (!input.version.bytes || (complete && !text.trim())) add('content', 'Usable content', 'fail', 'The selected output is empty. Produce a non-empty result before finishing.');
  else if (!supported || !complete) add('content', 'Content coverage', 'warn', 'Only file integrity was checked. Complete content checks are unavailable for this format or file size.');
  else add('content', 'Complete content', 'pass', `Checked all ${input.version.bytes.toLocaleString()} source bytes.`);
  const format = input.version.format === 'md' ? 'markdown' : input.version.format;
  if (input.requiredFormat) add('format', 'Required output format', format === input.requiredFormat ? 'pass' : 'fail', format === input.requiredFormat ? `The output has the required ${input.requiredFormat} format.` : `This workflow requires ${input.requiredFormat}; the selected output is ${format}.`);
  if (complete && format === 'csv') {
    try {
      const rows = parseCompleteCsv(text);
      if (!rows.length || rows[0].some(cell => !cell.trim()) || new Set(rows[0]).size !== rows[0].length) add('csv', 'CSV structure', 'fail', 'The CSV needs non-empty, unique column headings.');
      else add('csv', 'CSV structure', 'pass', `${rows.length - 1} data rows and ${rows[0].length} columns parsed completely; cell values and formulas were not evaluated.`);
      if (rows.length === 1) add('csv-data', 'Data coverage', 'warn', 'The CSV contains column headings but no data rows.');
    } catch (cause) {
      if (cause instanceof CsvCoverageError) { coverageComplete = false; add('csv', 'CSV check coverage', 'warn', `${cause.message} Structure beyond that limit was not checked; review the exact original. This is a checker limit, not proof of invalid data.`); }
      else add('csv', 'CSV structure', 'fail', cause instanceof Error ? cause.message : 'The complete CSV could not be parsed.');
    }
  }
  if (complete && format === 'json') {
    try { JSON.parse(text); add('json', 'JSON structure', 'pass', 'The complete output is valid JSON. Field meanings and values require review.'); }
    catch { add('json', 'JSON structure', 'fail', 'The selected output is not complete valid JSON.'); }
  }
  const explicitSections = [...input.completionCriteria.matchAll(/^Required sections:\s*(.+)$/gmi)].flatMap(match => match[1].split(/[,;|]/).map(value => value.trim()).filter(Boolean));
  const requiredSections = [...new Set([...(input.requiredSections || []), ...explicitSections])];
  if (requiredSections.length) {
    const markdown = format === 'markdown' && complete ? parseMarkdownPreview(text) : null;
    if (!complete || (markdown?.truncated) || text.length > PREVIEW_CHAR_LIMIT) add('sections', 'Required sections', 'warn', 'Section checks could not cover the complete output; review all required sections manually.');
    else {
      const headings = markdown?.blocks.filter(block => block.kind === 'heading').map(block => normalized((block as { text: string }).text)) || [];
      const missing = requiredSections.filter(section => !headings.includes(normalized(section)));
      add('sections', 'Required sections', missing.length ? 'fail' : 'pass', missing.length ? `Missing required headings: ${missing.join(', ')}.` : `All ${requiredSections.length} required headings are present. Heading presence does not prove their content is complete.`);
    }
  }
  if (complete) {
    const evidence = new Set(input.evidenceIds), versions = new Set(input.inputVersionIds), outputs = new Set(input.supportingOutputVersionIds || []);
    const invalid = (input.reportEvidenceIds || []).filter(id => !evidence.has(id));
    for (const match of text.matchAll(/\b(evidence|receipt|artifact|version|output):(?:\/\/)?([A-Za-z0-9_-]{8,96})\b/g)) {
      if (!(match[1] === 'evidence' || match[1] === 'receipt' ? evidence : match[1] === 'output' ? outputs : versions).has(match[2])) invalid.push(`${match[1]}:${match[2]}`);
    }
    if (invalid.length) add('references', 'Exact source references', 'fail', `These references do not belong to this task's successful evidence, selected inputs or exact same-task supporting outputs: ${[...new Set(invalid)].slice(0, 8).join(', ')}.`);
    else if (input.reportEvidenceIds?.length) add('references', 'Saved report references', 'pass', `${input.reportEvidenceIds.length} saved evidence references belong to successful source observations for this task. This does not establish that they support every claim.`);
    else add('references', 'Source references', 'warn', 'This output has no saved report evidence references. Review the source coverage and claims manually.');
    if (/\b(?:TODO|TBD|FIXME)\b|\[(?:insert|add|fill in)\b[^\]]*\]/i.test(text)) add('placeholders', 'Unfinished text', 'warn', 'Potential placeholder text remains (for example TODO or “insert…”). Review whether it is intentional source content.');
    if (input.completionCriteria && !requiredSections.length) add('criteria', 'Completion criteria', 'warn', 'The task has prose criteria. Their semantic fulfillment requires owner review; no automatic pass was inferred from keyword matches.');
  }
  const status = checks.some(check => check.status === 'fail') ? 'fail' : checks.some(check => check.status === 'warn') ? 'warn' : 'pass';
  return { checkerVersion: QUALITY_CHECKER_VERSION, sourceVersionId: input.version.id, sourceSha256: input.version.sha256, checkedAt: input.now ?? Date.now(), status, canFinish: status !== 'fail', coverage: { complete: coverageComplete, checkedBytes: input.text === null ? 0 : Buffer.byteLength(text), sourceBytes: input.version.bytes }, checks, limitation: 'These checks verify structure, complete-file coverage and exact reference membership. They do not certify factual accuracy, calculations, relevance or satisfaction of prose instructions.' };
}
