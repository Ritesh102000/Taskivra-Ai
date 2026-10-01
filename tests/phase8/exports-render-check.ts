/** Manual fixture-only Electron proof. Bundle with esbuild (electron external),
 * then launch the bundle with Electron and AW_EXPORT_PROOF_ROOT pointing at a
 * fresh .test-data directory. It never opens the product or production data. */
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createDocxReport, createXlsxReport, renderReportHtml, type ExportSource } from '../../packages/report-export';
import { renderIsolatedReportPdf } from '../../apps/desktop/main/report-export-controller';

const root = resolve(process.env.AW_EXPORT_PROOF_ROOT || '.test-data/phase8-export-proof');
app.setPath('userData', join(root, 'electron-profile'));
app.setPath('sessionData', join(root, 'electron-session'));
app.on('window-all-closed', () => undefined);
const observedPreferences: unknown[] = [];
app.on('browser-window-created', (_event, window) => {
  // Electron exposes this diagnostic method at runtime but omits it from the
  // public WebContents type. It is used only by this fixture, never product code.
  const preferences = (window.webContents as unknown as { getLastWebPreferences(): { javascript?: boolean; nodeIntegration?: boolean; sandbox?: boolean; contextIsolation?: boolean; webSecurity?: boolean } }).getLastWebPreferences();
  observedPreferences.push({ javascript: preferences.javascript, nodeIntegration: preferences.nodeIntegration, sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, webSecurity: preferences.webSecurity });
  assert.equal(preferences.javascript, false); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
});
const makeSource = (text: string, csv = false): ExportSource => ({ taskId: 'export-fixture-task', review: 'unreviewed', text, version: { id: csv ? 'export-fixture-csv-v1' : 'export-fixture-report-v1', artifactId: 'export-fixture-artifact', version: 1, displayName: csv ? 'Regional comparison.csv' : 'Quarterly operations brief.md', ownerAgentId: 'export-fixture-agent', producerTaskId: 'export-fixture-task', visibility: 'private', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), mime: csv ? 'text/csv' : 'text/markdown', format: csv ? 'csv' : 'markdown', createdAt: Date.UTC(2026, 8, 30), status: 'ready', sourceVersionId: null } });
async function main() {
  await mkdir(root, { recursive: true, mode: 0o700 }); await app.whenReady();
  const source = makeSource('# Findings\nThe fixture contains **two regions** and a complete comparison. Revenue increased in both regions; this example is synthetic data for export validation.\n\n| Region | Previous | Current | Change |\n| --- | --- | --- | --- |\n| North | 12,000 | 15,000 | +25% |\n| South | 8,000 | 8,800 | +10% |\n\n## Recommended next steps\n- Review the regional inputs with the operations owner.\n- Confirm units and reporting periods before taking action.\n\n## Sources and coverage\nTwo synthetic rows were examined. [Fixture reference](https://example.invalid/source) is shown as text only.\n\n## Limitations\nNo real company information was used. This formatted report does not establish factual or mathematical correctness.\n\n> Keep evidence and interpretation separate.');
  const csv = makeSource('Region,Previous,Current,Identifier,Literal formula\nNorth,12000,15000,00123,=SUM(B2:C2)\nSouth,8000,8800,00045,+SUM(B3:C3)\n', true);
  const html = renderReportHtml(source), pdf = await renderIsolatedReportPdf(html), docx = createDocxReport(source), xlsx = createXlsxReport(csv);
  await writeFile(join(root, 'report.html'), html, { mode: 0o600 });
  await writeFile(join(root, 'report.pdf'), pdf, { mode: 0o600 }); await writeFile(join(root, 'report.docx'), docx, { mode: 0o600 }); await writeFile(join(root, 'report.xlsx'), xlsx, { mode: 0o600 });
  let networkRequests = 0;
  const server = createServer((_request, response) => { networkRequests++; response.end('NETWORK WAS CONTACTED'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture HTTP server has no port.');
    const probe = `<html><head><link rel="stylesheet" href="http://127.0.0.1:${address.port}/style"></head><body>JAVASCRIPT_DISABLED_SENTINEL<script>document.body.textContent='JAVASCRIPT_EXECUTED_SENTINEL';fetch('http://127.0.0.1:${address.port}/script')</script><img src="http://127.0.0.1:${address.port}/image"><iframe src="http://127.0.0.1:${address.port}/frame"></iframe></body></html>`;
    const securityPdf = await renderIsolatedReportPdf(probe); await writeFile(join(root, 'security-probe.pdf'), securityPdf, { mode: 0o600 });
    assert.equal(networkRequests, 0); assert.equal(observedPreferences.length, 2);
    const metadata = { fixtureOnly: true, createdAt: new Date().toISOString(), sourceVersion: source.version.id, sourceSha256: source.version.sha256, sourceText: source.text, csvSourceSha256: csv.version.sha256, csvSourceText: csv.text, networkRequests, rendererPreferences: observedPreferences, files: Object.fromEntries([['report.pdf', pdf], ['report.docx', docx], ['report.xlsx', xlsx], ['security-probe.pdf', securityPdf]].map(([name, bytes]) => [name as string, { bytes: (bytes as Buffer).length, sha256: createHash('sha256').update(bytes as Buffer).digest('hex') }])) };
    await writeFile(join(root, 'electron-proof.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ fixtureOnly: true, root, networkRequests, pdfBytes: pdf.length, docxBytes: docx.length, xlsxBytes: xlsx.length }) + '\n');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
