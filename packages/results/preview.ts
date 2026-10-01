/** Renderer-safe parsing only. No HTML, URL fetches, evaluation, or markdown plugins. */
export const PREVIEW_CHAR_LIMIT = 65536;
export interface CsvPreview { rows: string[][]; truncated: boolean; omittedColumns: boolean; error: string | null }
export function parseCsvPreview(input: string, sourceTruncated = false): CsvPreview {
  const text = input.slice(0, PREVIEW_CHAR_LIMIT).replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, afterQuote = false, fieldStarted = false;
  let truncated = sourceTruncated || input.length > PREVIEW_CHAR_LIMIT, omittedColumns = false, clippedCell = false;
  const add = (c: string) => { if (cell.length < 4096) cell += c; else clippedCell = true; };
  const field = () => { if (row.length < 20) row.push(cell); else omittedColumns = true; cell = ''; afterQuote = false; fieldStarted = false; };
  const record = () => { field(); if (rows.length < 201) rows.push(row); else truncated = true; row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { add('"'); i++; } else { quoted = false; afterQuote = true; } }
      else add(c);
      continue;
    }
    if (afterQuote && c !== ',' && c !== '\n' && c !== '\r') return { rows: [], truncated, omittedColumns, error: 'This CSV has characters after a closing quote. View the original text instead.' };
    if (c === '"') {
      if (fieldStarted || cell) return { rows: [], truncated, omittedColumns, error: 'This CSV has a quote inside an unquoted field. View the original text instead.' };
      quoted = true; fieldStarted = true;
    } else if (c === ',') { field(); }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; record(); if (rows.length === 201 && i < text.length - 1) { truncated = true; break; } }
    else { add(c); fieldStarted = true; }
  }
  if (quoted && !truncated) return { rows: [], truncated, omittedColumns, error: 'This CSV contains an unfinished quoted field. View the original text instead.' };
  // A clipped preview cannot prove that its final record is complete; do not invent it.
  if (!truncated && (cell || row.length || fieldStarted || afterQuote)) record();
  return { rows, truncated: truncated || clippedCell, omittedColumns, error: null };
}

export type MarkdownBlock = { kind: 'heading'; level: number; text: string } | { kind: 'text' | 'code' | 'item' | 'quote'; text: string } | { kind: 'table'; rows: string[][] };
function allCells(line: string): string[] { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|'); }
function cells(line: string): string[] { return allCells(line).slice(0, 20).map(c => c.trim()); }
export function parseMarkdownPreview(input: string): { blocks: MarkdownBlock[]; truncated: boolean } {
  const limited = input.slice(0, PREVIEW_CHAR_LIMIT), lines = limited.split(/\r?\n/), blocks: MarkdownBlock[] = [];
  let i = 0, tableClipped = false;
  while (i < lines.length && blocks.length < 1000) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const code: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ kind: 'code', text: code.join('\n') }); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      if (allCells(line).length > 20) tableClipped = true;
      const rows = [cells(line)]; i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        if (allCells(lines[i]).length > 20) tableClipped = true;
        if (rows.length < 201) rows.push(cells(lines[i]));
        else { tableClipped = true; break; }
        i++;
      }
      blocks.push({ kind: 'table', rows }); continue;
    }
    const item = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (item) blocks.push({ kind: 'item', text: item[1] });
    else if (/^>\s?/.test(line)) blocks.push({ kind: 'quote', text: line.replace(/^>\s?/, '') });
    else blocks.push({ kind: 'text', text: line });
    i++;
  }
  return { blocks, truncated: tableClipped || input.length > PREVIEW_CHAR_LIMIT || i < lines.length };
}

export type InlineToken = { kind: 'text' | 'strong' | 'code' | 'reference'; text: string; url?: string };
export function inlineTokens(text: string): InlineToken[] {
  const result: InlineToken[] = []; const pattern = /(\*\*[^*\n]{1,2048}\*\*|`[^`\n]{1,2048}`|!?\[[^\]\n]{0,512}\]\([^\)\n]{1,2048}\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index!; if (at > start) result.push({ kind: 'text', text: text.slice(start, at) });
    const value = match[0];
    if (value.startsWith('**')) result.push({ kind: 'strong', text: value.slice(2, -2) });
    else if (value.startsWith('`')) result.push({ kind: 'code', text: value.slice(1, -1) });
    else { const split = value.indexOf(']('); result.push({ kind: 'reference', text: value.slice(value.startsWith('!') ? 2 : 1, split), url: value.slice(split + 2, -1) }); }
    start = at + value.length;
  }
  if (start < text.length) result.push({ kind: 'text', text: text.slice(start) });
  return result;
}

export function compareResultText(previous: string, current: string) {
  const a = previous.slice(0, PREVIEW_CHAR_LIMIT).split(/\r?\n/), b = current.slice(0, PREVIEW_CHAR_LIMIT).split(/\r?\n/);
  let index = 0; while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return { identical: previous === current, firstDifferentLine: index < Math.max(a.length, b.length) ? index + 1 : null, previousLines: a.length, currentLines: b.length,
    bounded: previous.length > PREVIEW_CHAR_LIMIT || current.length > PREVIEW_CHAR_LIMIT };
}
