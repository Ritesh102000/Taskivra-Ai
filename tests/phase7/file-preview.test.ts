import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classifyFile, safeTextPreview, SOURCE_TEXT_EXTENSIONS } from '../../packages/artifacts/safe-io';
import { parseCsvPreview, parseMarkdownPreview, inlineTokens, compareResultText } from '../../packages/results/preview';
import { SafeResultPreview } from '../../apps/desktop/renderer/SafeResultPreview';
import type { ArtifactPreview } from '../../packages/contracts';

test('source extensions become inert validated UTF-8 text, preserving csv/json classification boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-source-preview-'));
  try {
    for (const extension of SOURCE_TEXT_EXTENSIONS) {
      const path = join(root, 'source' + extension); await writeFile(path, 'const value = "<script>alert(1)</script>";\n// café 日本語\n');
      const type = await classifyFile(path); assert.equal(type.format, 'text'); assert.equal(type.mime, 'text/plain'); assert.equal(type.previewKind, 'text');
      assert.match((await safeTextPreview(path)).text, /café 日本語/);
    }
    const invalid = join(root, 'bad.ts'); await writeFile(invalid, Buffer.from([0xff, 0xfe, 0])); await assert.rejects(classifyFile(invalid));
    await writeFile(invalid, 'hello\0binary'); await assert.rejects(classifyFile(invalid), /null bytes/);
    await writeFile(invalid, '%PDF-1.7 fake'); await assert.rejects(classifyFile(invalid));
    const json = join(root, 'bad.json'); await writeFile(json, '{ not json }'); await assert.rejects(classifyFile(json), /valid JSON/);
    const binary = join(root, 'opaque.unknown'); await writeFile(binary, 'looks like text'); assert.equal((await classifyFile(binary)).format, 'binary');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CSV preview preserves strings, formulas, quoting, blanks, unicode and embedded line breaks', () => {
  const csv = parseCsvPreview('\uFEFFid,value,notes\r\n001,N/A,"two, parts"\r\n002,NULL,"a ""quote"""\r\n003,=SUM(A1:A2),"line one\nline two"\r\n004,,日本語\r\n');
  assert.equal(csv.error, null); assert.equal(csv.truncated, false);
  assert.deepEqual(csv.rows[1], ['001', 'N/A', 'two, parts']);
  assert.deepEqual(csv.rows[2], ['002', 'NULL', 'a "quote"']);
  assert.deepEqual(csv.rows[3], ['003', '=SUM(A1:A2)', 'line one\nline two']);
  assert.deepEqual(csv.rows[4], ['004', '', '日本語']);
});

test('CSV malformed and partial records are never silently invented; work is bounded', () => {
  assert.ok(parseCsvPreview('a,b\n"unterminated').error);
  assert.ok(parseCsvPreview('a,b\n"quoted"oops,2').error);
  const partial = parseCsvPreview('a,b\n1,2\n3,"cut', true);
  assert.equal(partial.error, null); assert.equal(partial.truncated, true); assert.deepEqual(partial.rows, [['a', 'b'], ['1', '2']]);
  const large = parseCsvPreview('a,b\n' + '1,2\n'.repeat(10000)); assert.equal(large.rows.length, 201); assert.equal(large.truncated, true);
  const wide = parseCsvPreview(Array.from({ length: 25 }, (_, n) => String(n)).join(',') + '\n'); assert.equal(wide.rows[0].length, 20); assert.equal(wide.omittedColumns, true);
  const cell = parseCsvPreview('a\n' + 'x'.repeat(5000)); assert.equal(cell.rows[1][0].length, 4096); assert.equal(cell.truncated, true);
});

function preview(text: string, format = 'markdown'): ArtifactPreview {
  return { text, truncated: false, note: 'Inert preview', version: { id: 'v1', artifactId: 'a1', version: 1, displayName: 'report.md', ownerAgentId: 'agent', producerTaskId: 'task', visibility: 'private', bytes: text.length, sha256: '0'.repeat(64), mime: 'text/markdown', format, createdAt: 1, status: 'ready', sourceVersionId: null } };
}
test('Markdown preview renders useful structure while scripts, URLs and images stay inert text', () => {
  const content = '# Report\n**Important** and `code`\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n![hidden](https://tracking.example/pixel)\n[local](file:///private/secret)\n| Name | Value |\n| --- | --- |\n| A | 2 |\n```html\n<iframe src="https://evil.example"></iframe>\n```';
  const html = renderToStaticMarkup(createElement(SafeResultPreview, { preview: preview(content) }));
  assert.match(html, /<strong>Important<\/strong>/); assert.match(html, /<table>/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img|<iframe|<a\s|<[a-z][^>]*\s(?:href|src|onerror)=/i);
  assert.equal(parseMarkdownPreview(content).blocks.filter(b => b.kind === 'table').length, 1);
  assert.ok(inlineTokens('[label](https://example.com)').some(t => t.kind === 'reference' && t.url === 'https://example.com'));
});

test('CSV formula-like values and HTML cells are rendered as text, without execution', () => {
  const html = renderToStaticMarkup(createElement(SafeResultPreview, { preview: preview('name,value\n<script>,"=HYPERLINK(""https://evil.example"")"\n', 'csv') }));
  assert.doesNotMatch(html, /<script|href=|<iframe/i); assert.match(html, /&lt;script&gt;/); assert.match(html, /<table>/);
});

test('Markdown table truncation is explicit with or without outer pipes', () => {
  for (const outer of ['', '|']) {
    const row = outer + Array.from({ length: 21 }, (_, i) => String(i)).join('|') + outer;
    const separator = outer + Array(21).fill('---').join('|') + outer;
    const parsed = parseMarkdownPreview(row + '\n' + separator);
    assert.equal(parsed.truncated, true); assert.equal(parsed.blocks[0].kind, 'table');
    assert.equal(parsed.blocks[0].kind === 'table' && parsed.blocks[0].rows[0].length, 20);
  }
});

test('comparison describes only available text and does not turn similarity into verification', () => {
  assert.deepEqual(compareResultText('same', 'same'), { identical: true, firstDifferentLine: null, previousLines: 1, currentLines: 1, bounded: false });
  assert.equal(compareResultText('a\nb', 'a\nc').firstDifferentLine, 2);
  assert.equal(compareResultText('a'.repeat(70000), 'a'.repeat(69999) + 'b').bounded, true);
});
