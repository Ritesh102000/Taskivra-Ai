import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocxReport, createXlsxReport, renderReportHtml, type ExportSource } from '../../packages/report-export';
import { crc32 } from '../../packages/report-export/zip';
import { classifyFile } from '../../packages/artifacts/safe-io';
import { ReportExportController } from '../../apps/desktop/main/report-export-controller';
import type { ResultService } from '../../packages/results';
import type { ArtifactService } from '../../packages/artifacts';

export function source(text = '# Findings\nTwo observations with **bold text**.\n\n| Item | Value |\n| --- | --- |\n| Alpha | 12 |\n| Beta | 15 |\n\n## Limitations\nOnly the supplied data was reviewed.', format = 'markdown'): ExportSource {
  return { taskId: 'task-fixture', review: 'unreviewed', text, version: { id: 'version-fixture', artifactId: 'artifact-fixture', version: 1, displayName: format === 'csv' ? 'Comparison.csv' : 'Comparison.md', ownerAgentId: 'agent-fixture', producerTaskId: 'task-fixture', visibility: 'private', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), mime: format === 'csv' ? 'text/csv' : 'text/markdown', format, createdAt: Date.UTC(2026, 8, 30), status: 'ready', sourceVersionId: null } };
}
function unzipStored(bytes: Buffer): Record<string, string> {
  const result: Record<string, string> = {}; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28), name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    assert.equal(bytes.readUInt16LE(offset + 8), 0); const data = bytes.subarray(offset + 30 + nameLength + extra, offset + 30 + nameLength + extra + length); assert.equal(crc32(data), bytes.readUInt32LE(offset + 14)); result[name] = data.toString(); offset += 30 + nameLength + extra + length;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50); assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50); assert.equal(bytes.readUInt16LE(bytes.length - 12), Object.keys(result).length); return result;
}
test('PDF source is inert escaped content with complete source provenance', () => {
  const fixture = source('# Results\n<script>fetch("https://secret.example")</script>\n[Open](javascript:alert(1))\n![Photo](https://secret.example/p.png)\n<iframe src="file:///etc/passwd">');
  const html = renderReportHtml(fixture);
  assert.ok(!/<(?:script|iframe|img|a)\b/i.test(html)); assert.match(html, /&lt;script&gt;/); assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'none'/);
  assert.ok(html.includes(fixture.version.sha256)); assert.ok(html.includes(fixture.version.id)); assert.match(html, /Not yet reviewed/);
});
test('plain-text exports preserve Markdown punctuation as literal text', () => {
  const fixture = source('Keep **these asterisks** and [literal](https://example.invalid).', 'text');
  assert.match(renderReportHtml(fixture), /Keep \*\*these asterisks\*\* and \[literal\]\(https:\/\/example.invalid\)/);
  assert.match(unzipStored(createDocxReport(fixture))['word/document.xml'], /Keep \*\*these asterisks\*\* and \[literal\]\(https:\/\/example.invalid\)/);
});
test('export refuses tampered source, unsupported format and all partial formatting instead of silently clipping', () => {
  assert.throws(() => createDocxReport({ ...source(), text: 'changed' }), /exact saved version/);
  assert.throws(() => renderReportHtml(source('a'.repeat(65537))), /too large/);
  assert.throws(() => createDocxReport(source('name,value\na,2', 'csv')), /Markdown and plain-text/);
  const hugeTable = '| a | b |\n| --- | --- |\n' + '| a | b |\n'.repeat(201); assert.throws(() => renderReportHtml(source(hugeTable)), /formatting limits/);
  assert.throws(() => createDocxReport(source('control\u0001character')), /cannot be preserved/);
});
test('Word export is a complete valid generated ZIP with styles and no external relationships', () => {
  const fixture = source(), files = unzipStored(createDocxReport(fixture));
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'].sort());
  assert.match(files['word/document.xml'], /<w:tbl>/); assert.ok(files['word/document.xml'].includes(fixture.version.sha256)); assert.match(files['word/styles.xml'], /Heading1/);
  for (const value of Object.values(files)) assert.doesNotMatch(value, /TargetMode="External"|<w:altChunk|<w:object|<w:instrText/);
});
test('spreadsheet keeps formula-like and identifier cells literal, includes every CSV row and provenance', async () => {
  const fixture = source('name,value\n=HYPERLINK(""bad""),00123\n+SUM(A1),@evil\n', 'csv');
  fixture.text = 'name,value\n"=HYPERLINK(""bad"")",00123\n+SUM(A1),@evil\n'; fixture.version.bytes = Buffer.byteLength(fixture.text); fixture.version.sha256 = createHash('sha256').update(fixture.text).digest('hex');
  const bytes = createXlsxReport(fixture), files = unzipStored(bytes);
  assert.match(files['xl/worksheets/sheet1.xml'], /00123/); assert.match(files['xl/worksheets/sheet1.xml'], /=HYPERLINK/); assert.doesNotMatch(files['xl/worksheets/sheet1.xml'], /<f[ >]/); assert.equal((files['xl/worksheets/sheet1.xml'].match(/t="inlineStr"/g) || []).length, 6);
  assert.match(files['xl/worksheets/sheet1.xml'], /state="frozen"/); assert.ok(files['xl/worksheets/sheet2.xml'].includes(fixture.version.sha256));
  const root = await mkdtemp(join(tmpdir(), 'aw-xlsx-')); try { const path = join(root, 'report.xlsx'); await writeFile(path, bytes); assert.equal((await classifyFile(path)).format, 'xlsx'); } finally { await rm(root, { recursive: true, force: true }); }
});
test('spreadsheet rejects malformed, unbounded and wrong-type inputs', () => {
  assert.throws(() => createXlsxReport(source()), /CSV result/); assert.throws(() => createXlsxReport(source('a,b\nc\n', 'csv')), /inconsistent/);
  assert.throws(() => createXlsxReport(source('a\n' + '1\n'.repeat(10001), 'csv')), /10,000/);
});
test('a UTF-8 BOM stripped by the verified reader is restored only for exact source-hash comparison', () => {
  const fixture = source('name,value\nAlpha,00123\n', 'csv');
  const bytes = Buffer.from('\uFEFF' + fixture.text); fixture.version.bytes = bytes.length; fixture.version.sha256 = createHash('sha256').update(bytes).digest('hex');
  const files = unzipStored(createXlsxReport(fixture)); assert.match(files['xl/worksheets/sheet1.xml'], />name</); assert.ok(files['xl/worksheets/sheet2.xml'].includes(fixture.version.sha256));
  fixture.version.sha256 = createHash('sha256').update('xyz' + fixture.text).digest('hex'); assert.throws(() => createXlsxReport(fixture), /exact saved version/);
});
test('owner controller rechecks source after native dialog, exports safely and cannot overwrite existing files or follow links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-export-')), fixture = source(); let inspections = 0, releases = 0;
  const results = { inspect: async (taskId: string, versionId: string) => { assert.equal(taskId, fixture.taskId); assert.equal(versionId, fixture.version.id); inspections++; return { result: { version: fixture.version, agentId: fixture.version.ownerAgentId, review: { state: fixture.review } } }; } } as unknown as ResultService;
  const artifacts = { readForValidation: async () => ({ version: fixture.version, text: fixture.text }), reserveExternal: async () => { const directory = join(root, randomUUID()); await mkdir(directory); return Object.assign(async () => { releases++; await rm(directory, { recursive: true, force: true }); }, { directory }); } } as unknown as ArtifactService;
  let destination: string | null = join(root, 'report.docx');
  const controller = new ReportExportController({ results, artifacts, saveDialog: async () => destination, renderPdf: async () => { throw new Error('PDF renderer is not used by a Word export.'); } });
  const command = { type: 'results.exportReport', taskId: fixture.taskId, versionId: fixture.version.id, format: 'docx' };
  try {
    const done = await controller.handle(command); assert.equal(done.cancelled, false); assert.equal(done.sourceSha256, fixture.version.sha256); assert.equal(inspections, 2); assert.equal(releases, 1); assert.equal(done.sha256, createHash('sha256').update(await readFile(destination!)).digest('hex'));
    const original = await readFile(destination!); await assert.rejects(controller.handle(command)); assert.deepEqual(await readFile(destination!), original);
    const link = join(root, 'link.docx'); await symlink(destination!, link); destination = link; await assert.rejects(controller.handle(command));
    destination = null; const cancelled = await controller.handle(command); assert.equal(cancelled.cancelled, true);
    await assert.rejects(controller.handle({ ...command, destination: '/tmp/injected-path' }));
    await controller.drain();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('C93 ordered markers remain visible in HTML and DOCX',()=>{const fixture=source('3. Third\n4) Fourth');assert.match(renderReportHtml(fixture),/>3\.<\/span> Third/);assert.match(unzipStored(createDocxReport(fixture))['word/document.xml'],/3\. Third/);assert.match(unzipStored(createDocxReport(fixture))['word/document.xml'],/4\) Fourth/);});
test('C94 carriage returns in quoted CSV cells survive independent XML parsing',async()=>{const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const root=await mkdtemp(join(tmpdir(),'aw-cr-export-'));try{const path=join(root,'cr.xlsx');await writeFile(path,createXlsxReport(source('name,value\nA,"alpha\rbeta"\n','csv')));const result=await promisify(execFile)('python3',['-c',"import sys,zipfile,xml.etree.ElementTree as E;z=zipfile.ZipFile(sys.argv[1]);r=E.fromstring(z.read('xl/worksheets/sheet1.xml'));n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};assert r.find(\".//s:c[@r='B2']/s:is/s:t\",n).text=='alpha\\rbeta';print('literal CR preserved')",path]);assert.match(result.stdout,/literal CR preserved/);}finally{await rm(root,{recursive:true,force:true});}});
