import { createHash } from 'node:crypto';
import type { ArtifactVersion } from '../contracts';
import { inlineTokens, parseMarkdownPreview, type MarkdownBlock } from '../results/preview';
import { parseCompleteCsv } from '../results/csv';
import { createOfficeZip } from './zip';

export interface ExportSource { version: ArtifactVersion; text: string; taskId: string; review: 'unreviewed' | 'accepted' | 'changes_requested' }
export const MAX_FORMATTED_EXPORT_BYTES = 16 * 1024 * 1024;
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export function escapeText(text: string): string { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function sourceCheck(source: ExportSource) {
  // The trusted UTF-8 validation reader removes a leading BOM. Reconstruct only
  // that exact, checksum-proven prefix; no other normalization is accepted.
  const decoded = Buffer.from(source.text), original = decoded.length + 3 === source.version.bytes ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), decoded]) : decoded;
  if (source.version.status !== 'ready' || original.length !== source.version.bytes || createHash('sha256').update(original).digest('hex') !== source.version.sha256) throw new Error('The export source does not match the exact saved version.');
  if (source.version.bytes > 1024 * 1024) throw new Error('Formatted exports support source files up to 1 MiB. Export the exact original for larger files.');
  for (const value of [source.text, source.version.displayName, source.version.id, source.taskId]) if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) throw new Error('The source contains characters that cannot be preserved safely in an Office or PDF report. Export the original file.');
  if (source.version.producerTaskId !== source.taskId) throw new Error('The export source belongs to a different task.');
}
function documentBlocks(source: ExportSource): MarkdownBlock[] {
  sourceCheck(source);
  if (!['md', 'markdown', 'text', 'txt'].includes(source.version.format)) throw new Error('PDF and Word reports support Markdown and plain-text results.');
  if (['text', 'txt'].includes(source.version.format)) {
    if (source.text.length > 65536 || source.text.split(/\r?\n/).length > 1000) throw new Error('The formatted report exceeds the complete-content limit. Export the original file instead.');
    return source.text.split(/\r?\n/).map(text => ({ kind: 'text', text }));
  }
  const parsed = parseMarkdownPreview(source.text);
  if (parsed.truncated) throw new Error('The report is too large or its tables exceed the formatting limits. Export the original file to preserve every row and column.');
  return parsed.blocks;
}
function inlineHtml(text: string): string {
  return inlineTokens(text).map(token => token.kind === 'strong' ? `<strong>${escapeText(token.text)}</strong>` : token.kind === 'code' ? `<code>${escapeText(token.text)}</code>` : token.kind === 'reference' ? `${escapeText(token.text)} <span class="reference">(${escapeText(token.url || '')})</span>` : escapeText(token.text)).join('');
}
const reviewLabel = (source: ExportSource) => source.review === 'accepted' ? 'Accepted by owner' : source.review === 'changes_requested' ? 'Changes requested' : 'Not yet reviewed';
const title = (source: ExportSource) => source.version.displayName.replace(/\.[^.]+$/, '');

/** All user content is escaped text. No anchors, images, scripts, fonts, embeds,
 * relative assets or external resources are created by this renderer. */
export function renderReportHtml(source: ExportSource): string {
  const blocks = documentBlocks(source);
  const renderInline = ['text', 'txt'].includes(source.version.format) ? escapeText : inlineHtml;
  const content = blocks.map(block => {
    if (block.kind === 'heading') return `<h${Math.min(6, block.level + 1)}>${inlineHtml(block.text)}</h${Math.min(6, block.level + 1)}>`;
    if (block.kind === 'code') return `<pre>${escapeText(block.text)}</pre>`;
    if (block.kind === 'quote') return `<blockquote>${inlineHtml(block.text)}</blockquote>`;
    if (block.kind === 'table') return `<table><thead><tr>${block.rows[0].map(cell => `<th>${inlineHtml(cell)}</th>`).join('')}</tr></thead><tbody>${block.rows.slice(1).map(row => `<tr>${row.map(cell => `<td>${inlineHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    return `<p${block.kind === 'item' ? ' class="item"' : ''}>${block.kind === 'item' ? `<span class="bullet">${escapeText(block.marker || '•')}</span> ` : ''}${renderInline(block.text) || '&#160;'}</p>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeText(title(source))}</title><style>
@page { size:A4; margin:18mm 18mm 20mm; } * { box-sizing:border-box; } body { margin:0; color:#20373d; font:11pt/1.55 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif; overflow-wrap:anywhere; } header { border-top:5px solid #207d73; padding:18px 0 20px; margin-bottom:20px; border-bottom:1px solid #d8e3e1; } .brand { color:#207d73; font-size:8pt; letter-spacing:2px; font-weight:700; text-transform:uppercase; } h1 { font-size:27pt; line-height:1.13; letter-spacing:-.9px; margin:13px 0; } .meta { font-size:9pt; color:#63757a; } h2,h3,h4,h5,h6 { color:#194b48; break-after:avoid; line-height:1.25; margin:21px 0 9px; } h2 { font-size:19pt; } h3 { font-size:15pt; } h4,h5,h6 { font-size:12pt; } p { margin:8px 0; white-space:pre-wrap; orphans:3; widows:3; } .item { margin:5px 0 5px 12px; } .bullet { color:#207d73; } table { border-collapse:collapse; width:100%; margin:15px 0; font-size:9pt; table-layout:fixed; } th,td { text-align:left; padding:8px; border:1px solid #d7e2df; vertical-align:top; white-space:pre-wrap; } th { background:#e9f2ef; color:#194b48; font-weight:650; } tr { break-inside:avoid; } thead { display:table-header-group; } code,pre { font-family:Menlo,Consolas,monospace; font-size:8.5pt; } pre { border-left:3px solid #80afa5; padding:12px; background:#f1f6f4; white-space:pre-wrap; overflow-wrap:anywhere; } code { background:#f1f6f4; } blockquote { color:#53686b; border-left:3px solid #80afa5; padding-left:14px; margin:14px 0; } .reference { color:#617575; font-size:.9em; } footer { border-top:1px solid #d8e3e1; margin-top:26px; padding-top:12px; color:#667b7c; font-size:7.5pt; } footer p { margin:3px 0; }
</style></head><body><header><div class="brand">Agent Workspaces · Report</div><h1>${escapeText(title(source))}</h1><div class="meta">Saved version ${source.version.version} · ${escapeText(new Date(source.version.createdAt).toISOString().slice(0, 10))} · ${reviewLabel(source)}</div></header><main>${content}</main><footer><p>Formatted from the complete saved source. Formatting does not verify its claims. References remain text; no external content was loaded.</p><p>Source version: ${escapeText(source.version.id)}</p><p>SHA-256: ${escapeText(source.version.sha256)}</p></footer></body></html>`;
}

const wordRun = (text: string, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeText(text)}</w:t></w:r>`;
function wordInline(text: string) { return inlineTokens(text).map(token => wordRun(token.kind === 'reference' ? `${token.text} (${token.url || ''})` : token.text, token.kind === 'strong' ? '<w:b/>' : token.kind === 'code' ? '<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/>' : '')).join(''); }
const paragraph = (text: string, style = 'Normal', raw = false) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${raw ? wordRun(text) : wordInline(text)}</w:p>`;
const officeRootRelationships = (target: string) => XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
export function createDocxReport(source: ExportSource): Buffer {
  const blocks = documentBlocks(source);
  const body = blocks.map(block => {
    if (block.kind === 'heading') return paragraph(block.text, `Heading${Math.min(3, block.level)}`);
    if (block.kind === 'table') return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="D7E2DF"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${block.rows[0].map(() => `<w:gridCol w:w="${Math.floor(9360 / block.rows[0].length)}"/>`).join('')}</w:tblGrid>${block.rows.map((row, i) => `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${row.map(cell => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9360 / block.rows[0].length)}" w:type="dxa"/>${i === 0 ? '<w:shd w:fill="E9F2EF"/>' : ''}</w:tcPr>${paragraph(cell, i === 0 ? 'TableHeader' : 'TableText')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
    if (block.kind === 'code') return block.text.split('\n').map(line => paragraph(line, 'Code', true)).join('');
    return paragraph((block.kind === 'item' ? (block.marker || '•') + ' ' : '') + block.text, block.kind === 'quote' ? 'Quote' : 'Normal', ['text', 'txt'].includes(source.version.format));
  }).join('');
  const styles = XML + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:color w:val="20373D"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="280" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[['Title', 'Title', 48], ['Heading1', 'Heading 1', 36], ['Heading2', 'Heading 2', 28], ['Heading3', 'Heading 3', 24], ['TableHeader', 'Table Header', 20], ['TableText', 'Table Text', 20], ['Metadata', 'Metadata', 17], ['Quote', 'Quote', 22], ['Code', 'Code', 18]].map(([id, name, size]) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr>${String(id).startsWith('Heading') ? `<w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="${Number(String(id).slice(-1)) - 1}"/>` : ''}</w:pPr><w:rPr><w:sz w:val="${size}"/>${['Title', 'Heading1', 'Heading2', 'Heading3', 'TableHeader'].includes(String(id)) ? '<w:b/><w:color w:val="207D73"/>' : ''}${id === 'Code' ? '<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/>' : ''}</w:rPr></w:style>`).join('')}</w:styles>`;
  return createOfficeZip({
    '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': officeRootRelationships('word/document.xml'),
    'word/_rels/document.xml.rels': XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': styles,
    'word/document.xml': XML + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph('AGENT WORKSPACES · REPORT', 'Metadata')}${paragraph(title(source), 'Title')}${paragraph(`Saved version ${source.version.version} · ${reviewLabel(source)}`, 'Metadata')}${body}${paragraph('Source record', 'Heading2')}${paragraph('Formatted from the complete saved source. Formatting does not verify its claims. References remain text.', 'Metadata')}${paragraph(`Source version: ${source.version.id}`, 'Metadata')}${paragraph(`SHA-256: ${source.version.sha256}`, 'Metadata')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1020" w:right="1020" w:bottom="1134" w:left="1020" w:header="500" w:footer="500"/></w:sectPr></w:body></w:document>`,
  });
}

function columnName(index: number): string { let name = ''; for (let i = index + 1; i > 0; i = Math.floor((i - 1) / 26)) name = String.fromCharCode(65 + (i - 1) % 26) + name; return name; }
function sheetXml(rows: string[][], data: boolean): string {
  const width = Math.max(...rows.map(row => row.length), 1), last = `${columnName(width - 1)}${rows.length}`;
  const columns = Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(14, ...rows.slice(0, 1000).map(row => Math.min((row[i] || '').length + 3, 60))))}" customWidth="1"/>`).join('');
  return XML + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0">${data ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ''}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols><sheetData>${rows.map((row, i) => `<row r="${i + 1}"${i === 0 ? ' ht="26" customHeight="1"' : ''}>${row.map((value, j) => `<c r="${columnName(j)}${i + 1}" s="${i === 0 ? 1 : 2}" t="inlineStr"><is><t xml:space="preserve">${escapeText(value).replaceAll('\r', '&#13;')}</t></is></c>`).join('')}</row>`).join('')}</sheetData>${data && rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : ''}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>`;
}
export function createXlsxReport(source: ExportSource): Buffer {
  sourceCheck(source); if (source.version.format !== 'csv') throw new Error('Editable spreadsheet exports require a CSV result.');
  const rows = parseCompleteCsv(source.text);
  if (!rows.length || !rows[0].length) throw new Error('The CSV is empty.');
  if (rows.length * rows[0].length > 100000) throw new Error('Formatted spreadsheets support at most 100,000 cells. Export the exact CSV to keep the full dataset.');
  const metadata = [['Source record', 'Value'], ['Filename', source.version.displayName], ['Source version', source.version.id], ['Source SHA-256', source.version.sha256], ['Saved version', String(source.version.version)], ['Review', reviewLabel(source)], ['Coverage', `${rows.length - 1} data rows; ${rows[0].length} columns; complete source`], ['Cell policy', 'All source cells are editable literal text. Formulas, links, macros and external data connections were not created.'], ['Verification', 'Formatting does not verify source claims or calculations.']];
  return createOfficeZip({
    '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': officeRootRelationships('xl/workbook.xml'),
    'xl/workbook.xml': XML + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="Results" sheetId="1" r:id="rId1"/><sheet name="Source record" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><color rgb="FF20373D"/></font><font><sz val="11"/><name val="Calibri"/><b/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF207D73"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    'xl/worksheets/sheet1.xml': sheetXml(rows, true), 'xl/worksheets/sheet2.xml': sheetXml(metadata, false),
  });
}
