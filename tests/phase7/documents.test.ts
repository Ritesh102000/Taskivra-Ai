import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Coordinator } from '../../packages/coordinator';
import { DockerCodeRuntimeFactory } from '../../packages/code-runtime';
import { DocumentService, validateExtraction } from '../../packages/documents';
import { DOCUMENT_EXTRACTOR } from '../../packages/documents/source';

test('document tool accepts bounded typed ranges and rejects executable/path arguments', () => {
  assert.equal(validateExtraction({ versionId: 'version' }).pageCount, 5);
  assert.equal(validateExtraction({ versionId: 'version', sheet: 'Data', startRow: 1, rowCount: 2 }).rowCount, 2);
  for (const input of [{ versionId: '../control' }, { versionId: 'a', python: 'print(1)' }, { versionId: 'a', inputPath: '/etc/passwd' }, { versionId: 'a', rowCount: 51 }, { versionId: 'a', pageCount: 11 }, { versionId: 'a', startRow: 0 }, { versionId: 'a', sheet: '' }]) assert.throws(() => validateExtraction(input));
});

const FIXTURES = String.raw`
from pathlib import Path
import datetime, zipfile
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from openpyxl import Workbook
Path('outputs').mkdir(exist_ok=True)
writer=PdfWriter()
page=writer.add_blank_page(width=300,height=200)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
stream=DecodedStreamObject()
stream.set_data(b'BT /F1 12 Tf 30 150 Td (Revenue 123.50 verified) Tj ET')
page[NameObject('/Contents')]=writer._add_object(stream)
writer.add_blank_page(width=300,height=200)
writer.write('outputs/report.pdf')
writer.encrypt('fixture-password')
writer.write('outputs/encrypted.pdf')
book=Workbook()
sheet=book.active
sheet.title='Data'
sheet.append(['Label','Revenue','Approved','Date','Formula'])
sheet.append(['Original value',123.5,True,datetime.date(2026,9,30),'=B2*2'])
sheet['B2'].number_format='0.00'
sheet['D2'].number_format='yyyy-mm-dd'
sheet.append(['Next row',9007199254740992,False,None,None])
book.create_sheet('Other')['A1']='Another worksheet'
book.save('outputs/data.xlsx')
import socket, shutil
try:
    socket.create_connection(('1.1.1.1',443),timeout=0.2)
    raise AssertionError('extraction fixture unexpectedly had network access')
except OSError:
    pass
shutil.copyfile('outputs/data.xlsx','/tmp/macro.xlsx')
with zipfile.ZipFile('/tmp/macro.xlsx','a') as archive:
    archive.writestr('xl/vbaProject.bin',b'not executed')
try:
    xlsx_extract('/tmp/macro.xlsx',{'startRow':1,'rowCount':2,'startColumn':1,'columnCount':5})
    raise AssertionError('macro workbook was not rejected')
except ValueError as error:
    assert str(error)=='active_xlsx_content_unsupported'
print('Created synthetic document fixtures')
`;
async function finished(c: Coordinator, taskId: string) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const state = await c.code.handle({ type: 'code.state', taskId });
    if (state.executions.length && !state.activeExecutionId) return state.executions[0];
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fixture execution did not finish.');
}
test('real isolated PDF/XLSX extraction preserves typed values, saves verified private outputs and refuses encryption', { skip: process.env.AW_DOCUMENT_DOCKER_TEST !== '1', timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-documents-'));
  const image = process.env.AW_DOCUMENT_TEST_IMAGE || 'agent-workspaces-code:documents-1';
  const runtime = new DockerCodeRuntimeFactory({ dataRoot: root, image });
  const c = new Coordinator({ dataRoot: root, codeRuntime: runtime });
  const documents = new DocumentService({ code: c.code, artifacts: c.artifacts, authorize: claim => c.authorizeRun(claim) });
  try {
    await c.code.ready; c.handle({ type: 'settings.update', settings: { driverEnabled: false } });
    const agent = c.handle({ type: 'agents.create', name: 'Document fixture agent', instructions: '' }).agents[0];
    const task = c.handle({ type: 'tasks.create', agentId: agent.id, objective: 'Read exact document fixtures', completionCriteria: 'Preserve values and cite coverage', scenario: 'complete' }).tasks[0];
    await c.code.handle({ type: 'code.execute', taskId: task.id, runtime: 'python', source: `${DOCUMENT_EXTRACTOR}\n${FIXTURES}`, timeoutSeconds: 30, inputVersionIds: [] });
    const created = await finished(c, task.id);
    assert.equal(created.lifecycle, 'succeeded', created.stderr || created.error || '');
    const byName = (name: string) => c.snapshot().artifacts.find(artifact => created.outputVersionIds.includes(artifact.id) && artifact.displayName === name)!;
    const pdf = byName('report.pdf'), xlsx = byName('data.xlsx'), encrypted = byName('encrypted.pdf');
    assert.ok(pdf && xlsx && encrypted);
    for (const version of [pdf, xlsx, encrypted]) await c.artifacts.useInTask({ principal: { kind: 'owner' }, taskId: task.id, versionId: version.id });
    c.handle({ type: 'tasks.resume', taskId: task.id }); const claim = c.claimNext()!; assert.ok(claim);
    const pdfResult = await documents.extractForAgent(claim, { versionId: pdf.id, pageStart: 1, pageCount: 1 });
    assert.equal(pdfResult.sourceSha256, pdf.sha256);
    assert.match(JSON.stringify(pdfResult.data.pages), /Revenue 123.50 verified/);
    assert.equal((pdfResult.data.coverage as any).completeDocument, false);
    assert.equal((pdfResult.data.coverage as any).nextPage, 2);
    assert.equal(c.artifacts.getForAgent(agent.id, pdfResult.outputVersionId).visibility, 'private');
    const blank = await documents.extractForAgent(claim, { versionId: pdf.id, pageStart: 2, pageCount: 1 });
    assert.match(JSON.stringify(blank.data.warnings), /OCR/);
    const sheetResult = await documents.extractForAgent(claim, { versionId: xlsx.id, sheet: 'Data', startRow: 2, rowCount: 1, startColumn: 1, columnCount: 5 });
    const cells = (sheetResult.data.rows as any[])[0].cells;
    assert.equal(cells[0].value, 'Original value'); assert.equal(cells[0].type, 'string');
    assert.equal(cells[1].value, 123.5); assert.equal(cells[1].type, 'number'); assert.equal(cells[1].numberFormat, '0.00');
    assert.equal(cells[2].value, true); assert.equal(cells[2].type, 'boolean');
    assert.match(cells[3].value, /^2026-09-30/); assert.equal(cells[3].type, 'datetime');
    assert.equal(cells[4].formula, '=B2*2'); assert.equal(cells[4].evaluated, false); assert.equal(cells[4].cached.type, 'blank');
    assert.equal((sheetResult.data.coverage as any).nextRow, 3);
    const large = await documents.extractForAgent(claim, { versionId: xlsx.id, sheet: 'Data', startRow: 3, rowCount: 1, startColumn: 2, columnCount: 1 });
    assert.deepEqual((large.data.rows as any[])[0].cells[0].value, '9007199254740992');
    assert.equal((large.data.rows as any[])[0].cells[0].encoding, 'decimal_string');
    const revision = c.artifacts.latestCodeRevision(task.id);
    await assert.rejects(documents.extractForAgent(claim, { versionId: encrypted.id }), /did not finish/);
    assert.equal(c.artifacts.latestCodeRevision(task.id), revision);
    const imageInfo = JSON.parse((await promisify(execFile)('/Applications/Docker.app/Contents/Resources/bin/docker', ['image', 'inspect', image], { maxBuffer: 1024 * 1024 })).stdout)[0];
    const evidence = { recordedAt: new Date().toISOString(), imageDigest: imageInfo.Id, officialBase: imageInfo.Config.Labels['io.agent-workspaces.code.official-base'] || null, resolvedBase: imageInfo.Config.Labels['io.agent-workspaces.code.resolved-base'] || null, source: 'synthetic fixtures generated and read inside isolated code containers', modelCalls: 0, libraries: JSON.parse(imageInfo.Config.Labels['io.agent-workspaces.code.packages']), checks: ['PDF text and page coverage', 'Blank page flags possible OCR need', 'XLSX original typed cells and number format', 'Integer outside JavaScript safe range preserved as explicit decimal string', 'Unevaluated formula and explicit missing cache', 'Private verified extraction artifacts', 'Encrypted PDF rejected with prior workspace retained', 'Macro archive rejected by container helper', 'Outbound connection blocked during execution'], pdfSourceSha256: pdf.sha256, xlsxSourceSha256: xlsx.sha256 };
    if (process.env.AW_DOCUMENT_EVIDENCE === '1') { await mkdir('docs/phase7/evidence', { recursive: true }); await writeFile(image === 'agent-workspaces-code:documents-portable-test' ? 'docs/phase7/evidence/document-extraction-portable.json' : 'docs/phase7/evidence/document-extraction.json', JSON.stringify(evidence, null, 2) + '\n'); }
  } finally { await c.shutdown(); await rm(root, { recursive: true, force: true }); }
});
