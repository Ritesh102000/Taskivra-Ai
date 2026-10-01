// Phase 0 owner-only viewport. No browser frames, inputs, request bodies or URLs
// are written to disk. Token lives in the URL fragment + process/browser memory.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BrowserClient, defaultImage } from './client.mjs';

const network = process.env.BROWSER_NETWORK;
if (!network) throw new Error('Set BROWSER_NETWORK to the isolated per-agent fixture network');
const client = await BrowserClient.launch({ name: `aw-phase0-viewer-${process.pid}`, network, image: process.env.BROWSER_IMAGE || defaultImage, proxy: process.env.BROWSER_PROXY_SERVER || 'http://egress:3128' });
await client.ready;
const token = randomBytes(32).toString('hex');
const html = await readFile(new URL('./viewer.html', import.meta.url));
const js = await readFile(new URL('./viewer-ui.js', import.meta.url));
let origin;
let selectedTab;
let busy = false;
const methods = new Set(['tabs.list', 'tabs.open', 'tabs.close', 'page.navigate', 'page.observe', 'page.click', 'page.key', 'page.scroll', 'control.take', 'control.release']);
const server = http.createServer(async (req, res) => {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  const respond = (status, value, type = 'application/json') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
  if (req.headers.host !== new URL(origin).host) return respond(403, { error: 'Host rejected' });
  if (req.method === 'GET' && req.url === '/') return respond(200, html, 'text/html; charset=utf-8');
  if (req.method === 'GET' && req.url === '/viewer-ui.js') return respond(200, js, 'text/javascript; charset=utf-8');
  if (req.method !== 'POST' || req.url !== '/rpc' || req.headers.origin !== origin || req.headers['x-viewer-token'] !== token) return respond(403, { error: 'Owner token and matching origin required' });
  if (busy) return respond(409, { error: 'Finishing current browser action' });
  busy = true;
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('Input limit'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!methods.has(body.method)) throw new Error('Unsupported owner command');
    const isControl = body.method.startsWith('control.');
    if (!isControl && client.controller !== 'human') throw new Error('Take control before interacting');
    const response = await client.request(body.method, body.params || {}, { actor: isControl ? 'owner' : 'human' });
    selectedTab = body.params?.tab || response.result?.tab || selectedTab;
    respond(200, response);
  } catch (error) { respond(400, { error: ['stale_observation', 'stale_generation', 'unknown_tab'].includes(error.code) ? error.code : 'Action failed; refresh the selected tab or reconnect.' }); }
  finally { busy = false; }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(Number(process.env.BROWSER_VIEWER_PORT || 0), '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`Phase 0 owner viewer: ${origin}/#${token}\nNo login has been verified. The test profile is discarded when stopped.\n`);
});
async function stop() { server.close(); await client.stop(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
