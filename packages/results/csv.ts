/** Complete, bounded CSV parser used by validation and export. Never evaluates formulas. */
export class CsvCoverageError extends Error { constructor(message: string) { super(message); this.name = 'CsvCoverageError'; } }
export function parseCompleteCsv(input: string): string[][] {
  if (Buffer.byteLength(input) > 1024 * 1024) throw new CsvCoverageError('CSV checks and formatted exports support complete files up to 1 MiB.');
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, afterQuote = false, started = false;
  const add = (value: string) => { cell += value; if (cell.length > 32767) throw new CsvCoverageError('A CSV cell exceeds the spreadsheet limit of 32,767 characters.'); };
  const field = () => { if (row.length >= 100) throw new CsvCoverageError('CSV checks and formatted exports support at most 100 columns.'); row.push(cell); cell = ''; started = false; afterQuote = false; };
  const record = () => { field(); if (rows.length >= 10001) throw new CsvCoverageError('CSV checks and formatted exports support at most 10,000 data rows.'); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { add('"'); i++; } else { quoted = false; afterQuote = true; } } else add(c); continue; }
    if (afterQuote && c !== ',' && c !== '\n' && c !== '\r') throw new Error('CSV contains characters after a closing quote.');
    if (c === '"') { if (started || cell) throw new Error('CSV contains a quote inside an unquoted field.'); quoted = true; started = true; }
    else if (c === ',') field();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; record(); }
    else { add(c); started = true; }
  }
  if (quoted) throw new Error('CSV contains an unfinished quoted field.');
  if (cell || row.length || started || afterQuote) record();
  if (rows.length && rows.some(row => row.length !== rows[0].length)) throw new Error('CSV rows have inconsistent column counts.');
  return rows;
}
