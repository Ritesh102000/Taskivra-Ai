export interface DocumentExtractionInput {
  versionId: string;
  pageStart?: number;
  pageCount?: number;
  sheet?: string;
  startRow?: number;
  rowCount?: number;
  startColumn?: number;
  columnCount?: number;
}
export interface DocumentExtractionResult {
  sourceVersionId: string;
  sourceSha256: string;
  outputVersionId: string;
  executionId: string;
  format: 'pdf' | 'xlsx';
  data: Record<string, unknown>;
  untrustedFileContent: true;
}
