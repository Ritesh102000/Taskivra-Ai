import http from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore, createTrial, opaqueToken, member, event } from './domain.mjs';
import { HttpError, capabilities, setOwnExportConsent } from './policy.mjs';
import { listTickets, getTicket, overview, createTicket } from './ticket-service.mjs';
import { exportTickets } from './export-service.mjs';
import { createShare, openShare, publicSnapshot } from './share-service.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createLabServer({ tracePath = null } = {}) {
  const store = createStore();
  listTickets(store, { personId: 'eli', tenantId: 'harbor' }, { status: 'pending', query: '' });
  const sessionView = context => {
    const persona = store.people.find(person => person.id === context.personId);
    const workspace = store.tenants.find(tenant => tenant.id === context.tenantId);
    return { persona: { id: persona.id, name: persona.name, email: persona.email, initials: persona.initials }, workspace,
      capabilities: capabilities(store, context), role: member(store, context).role,
      exportEnabled: member(store, context).exportGrant, synthetic: true };
  };
  const server = http.createServer(async (req, res) => {
    let context = null;
    let parsed;
    const respond = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    res.on('finish', () => {
      if (tracePath) appendFile(tracePath, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, path: parsed?.pathname ?? '(rejected)', tenantId: context?.tenantId ?? null, personId: context?.personId ?? null, status: res.statusCode })}\n`, { mode: 0o600 }).catch(() => {});
    });
    try {
      const host = req.headers.host ?? '';
      const hostname = host.split(':')[0];
      if (!['127.0.0.1', 'localhost'].includes(hostname)) throw new HttpError(403, 'This training lab is available only on this computer.');
      parsed = new URL(req.url, `http://${host}`);
      if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'Unsupported operation.');
      if (req.method === 'POST') {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Use the local training lab page.');
        if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new HttpError(403, 'Use the local training lab page.');
      }
      const token = /(?:^|;\s*)harbor_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
      context = token ? store.sessions.get(token) ?? null : null;
      if (req.method === 'GET' && (parsed.pathname === '/' || /^\/shared\/[A-Za-z0-9_-]{32}$/.test(parsed.pathname))) return respond(200, await readFile(path.join(root, 'public/index.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && parsed.pathname === '/app.js') return respond(200, await readFile(path.join(root, 'public/app.js')), 'application/javascript; charset=utf-8');
      if (req.method === 'GET' && parsed.pathname === '/favicon.ico') return respond(204, '', 'image/x-icon');
      if (req.method === 'GET' && parsed.pathname === '/__lab/health') return respond(200, { labId: 'harbor-desk', instanceNonce: process.env.AW_LAB_INSTANCE_NONCE ?? null });
      if (req.method === 'GET' && parsed.pathname === '/api/public/snapshots') return respond(200, { snapshots: [...store.shares.values()].filter(share => share.publicSummary).map(share => publicSnapshot(store, share.token)) });
      if (req.method === 'GET' && /^\/api\/public\/snapshots\/[A-Za-z0-9_-]{32}$/.test(parsed.pathname)) return respond(200, publicSnapshot(store, parsed.pathname.split('/').at(-1)));
      if (req.method === 'GET' && parsed.pathname === '/api/session') return respond(200, context ? sessionView(context) : { authenticated: false, synthetic: true });
      if (req.method === 'POST' && parsed.pathname === '/api/demo-access') {
        const proposed = createTrial(store, await readJson(req));
        if (!proposed) throw new HttpError(400, 'Use a display name, workspace name and fictional email ending in example.test.');
        context = proposed;
        const created = opaqueToken(); store.sessions.set(created, context);
        res.setHeader('Set-Cookie', `harbor_session=${created}; HttpOnly; SameSite=Strict; Path=/`);
        event(store, context, 'Trial workspace created', 'Ordinary workspace member');
        return respond(201, sessionView(context));
      }
      if (!context) throw new HttpError(401, 'Create a private trial workspace to continue.');
      if (req.method === 'GET' && parsed.pathname === '/api/overview') return respond(200, overview(store, context));
      if (req.method === 'GET' && parsed.pathname === '/api/tickets') return respond(200, { tickets: listTickets(store, context, { status: parsed.searchParams.get('status') ?? 'all', query: parsed.searchParams.get('q') ?? '' }) });
      if (req.method === 'POST' && parsed.pathname === '/api/tickets') return respond(201, createTicket(store, context, await readJson(req)));
      if (req.method === 'GET' && /^\/api\/tickets\/[A-Za-z0-9-]+$/.test(parsed.pathname)) return respond(200, getTicket(store, context, parsed.pathname.split('/').at(-1)));
      if (req.method === 'POST' && parsed.pathname === '/api/settings/export-consent') return respond(200, setOwnExportConsent(store, context, (await readJson(req)).enabled));
      if (req.method === 'GET' && parsed.pathname === '/api/exports/tickets') return respond(200, exportTickets(store, context));
      if (req.method === 'POST' && parsed.pathname === '/api/shares') return respond(201, createShare(store, context, (await readJson(req)).ticketId));
      if (req.method === 'GET' && /^\/api\/shares\/[A-Za-z0-9_-]{32}$/.test(parsed.pathname)) return respond(200, openShare(store, context, parsed.pathname.split('/').at(-1)));
      if (req.method === 'GET' && parsed.pathname === '/api/activity') return respond(200, { events: store.activity.filter(row => row.tenantId === context.tenantId).slice(0, 40).map(row => ({ ...row, person: store.people.find(person => person.id === row.personId)?.name ?? row.personId })) });
      throw new HttpError(404, 'This page is not available.');
    } catch (error) {
      respond(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'The demo could not complete this request.' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 12_000;
  return { server, store };
}
async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Use a JSON request.');
  let bytes = 0; const parts = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new HttpError(413, 'This demo request is too large.');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new HttpError(400, 'This demo request is incomplete.'); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port from 1024 to 65535.');
  const traceIndex = process.argv.indexOf('--trace');
  const lab = createLabServer({ tracePath: traceIndex >= 0 ? process.argv[traceIndex + 1] : null });
  lab.server.listen(port, '127.0.0.1', () => console.log(`Harbor Desk local training lab: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => lab.server.close(() => process.exit(0)));
}
