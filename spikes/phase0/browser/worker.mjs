import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { FrameDecoder, encodeFrame, SessionController, ProtocolError, permittedURL, boundedString } from './protocol.mjs';

const viewport = { width: 1120, height: 760 };
const controller = new SessionController();
const pages = new Map();
const revisions = new Map();
const MAX_TABS = 6;
let context;
let shuttingDown = false;
let writes = Promise.resolve();

function send(value) {
  const frame = encodeFrame(value);
  writes = writes.then(() => new Promise((resolve, reject) => process.stdout.write(frame, error => error ? reject(error) : resolve())));
  return writes;
}
function getPage(id) { const page = pages.get(id); if (!page || page.isClosed()) throw new ProtocolError('unknown_tab'); return page; }
function register(page) {
  for (const [id, known] of pages) if (known === page) return id;
  if (pages.size >= MAX_TABS) { void page.close(); return null; }
  const id = randomUUID(); pages.set(id, page); revisions.set(id, 1);
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) revisions.set(id, (revisions.get(id) || 0) + 1); });
  page.on('close', () => { pages.delete(id); revisions.delete(id); });
  page.on('dialog', dialog => void dialog.dismiss());
  page.on('download', download => void download.cancel()); // transfers are a Phase 3 contract.
  return id;
}
async function tabs() {
  return Promise.all([...pages].map(async ([id, page]) => ({ id, url: page.url().slice(0, 4096), title: (await page.title()).slice(0, 200), revision: revisions.get(id) })));
}
async function observe(id, includeScreenshot = true) {
  const page = getPage(id);
  const deadline = Date.now() + 8000;
  // A click/key may trigger navigation between its acknowledgement and the
  // first read. Retry observations only; never replay the external action.
  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt += 1) {
    await delay(attempt ? 75 : 25);
    const before = revisions.get(id);
    const url = page.url();
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, Math.min(2000, deadline - Date.now())) });
      const result = { tab: id, url: url.slice(0, 4096), title: (await page.title()).slice(0, 200), text: (await page.locator('body').innerText({ timeout: Math.max(1, Math.min(1500, deadline - Date.now())) })).slice(0, 16000), viewport };
      if (includeScreenshot) result.screenshot = { mime: 'image/jpeg', base64: (await page.screenshot({ type: 'jpeg', quality: 55, timeout: Math.max(1, Math.min(3000, deadline - Date.now())) })).toString('base64') };
      if (page.url() !== url || revisions.get(id) !== before) continue;
      result.revision = before + 1; revisions.set(id, result.revision);
      return result;
    } catch {
      if (page.isClosed()) throw new ProtocolError('unknown_tab');
    }
  }
  throw new ProtocolError('observation_unavailable');
}
function currentPage(params, staleCheck = false) {
  const page = getPage(params.tab);
  if (staleCheck && params.revision !== revisions.get(params.tab)) throw new ProtocolError('stale_observation');
  return page;
}
function coordinate(value, max) { if (!Number.isFinite(value) || value < 0 || value > max) throw new ProtocolError('invalid_coordinate'); return value; }
async function execute(req) {
  const p = req.params;
  switch (req.method) {
    case 'tabs.list': return tabs();
    case 'tabs.open': {
      if (pages.size >= MAX_TABS) throw new ProtocolError('tab_limit');
      const url = permittedURL(p.url); const page = await context.newPage(); const id = register(page);
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }); } catch (error) { if (page.isClosed()) throw error; }
      return observe(id);
    }
    case 'tabs.close': await currentPage(p).close(); return tabs();
    case 'page.navigate': await currentPage(p).goto(permittedURL(p.url), { waitUntil: 'domcontentloaded', timeout: 12000 }); return observe(p.tab);
    case 'page.observe': return observe(p.tab, p.screenshot !== false);
    case 'page.click': {
      const page = currentPage(p, true);
      if (p.selector !== undefined) await page.locator(boundedString(p.selector, 512)).click({ timeout: 6000 });
      else await page.mouse.click(coordinate(p.x, viewport.width), coordinate(p.y, viewport.height));
      return observe(p.tab);
    }
    case 'page.fill': await currentPage(p, true).locator(boundedString(p.selector, 512)).fill(boundedString(p.value, 8192), { timeout: 6000 }); return observe(p.tab);
    case 'page.key': {
      const page = currentPage(p, true);
      if (p.text !== undefined) await page.keyboard.insertText(boundedString(p.text, 8192));
      else await page.keyboard.press(boundedString(p.key, 80));
      return observe(p.tab);
    }
    case 'page.scroll': {
      if (![p.x, p.y].every(n => Number.isFinite(n) && Math.abs(n) <= 2000)) throw new ProtocolError('invalid_scroll');
      await currentPage(p, true).mouse.wheel(p.x, p.y); return observe(p.tab);
    }
    case 'control.take': return { tabs: await tabs(), observation: p.tab ? await observe(p.tab) : null };
    case 'control.release': return { tabs: await tabs(), observation: p.tab ? await observe(p.tab) : null, requiresFreshObservation: true };
    default: throw new ProtocolError('unknown_method');
  }
}

async function sandboxEvidence() {
  // Headless Shell has no chrome://sandbox WebUI. Verify the actual renderer
  // process boundary instead: nested user + PID namespaces, an additional
  // seccomp filter over the worker's container filter, and zero effective caps.
  const probe = await context.newPage();
  await probe.setContent('<!doctype html><title>Sandbox probe</title><p>Sandbox probe</p>');
  const self = await readFile('/proc/self/status', 'utf8');
  const selfUser = await readlink('/proc/self/ns/user');
  const selfPid = await readlink('/proc/self/ns/pid');
  const selfFilters = Number(self.match(/Seccomp_filters:\s+(\d+)/)?.[1]);
  if (process.getuid() === 0 || !/NoNewPrivs:\s+1/.test(self) || !selfFilters) throw new Error('sandbox_attestation_failed');
  const unsafe = [];
  const renderers = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const cmd = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
    const args = cmd.split(/[\0 ]+/);
    const isChromium = args[0]?.startsWith('/opt/browsers/chromium');
    if (isChromium && args.some(arg => ['--no-sandbox', '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox'].includes(arg))) unsafe.push(entry);
    if (isChromium && args.includes('--type=renderer')) {
      const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
      const userns = await readlink(`/proc/${entry}/ns/user`).catch(() => selfUser);
      const pidns = await readlink(`/proc/${entry}/ns/pid`).catch(() => selfPid);
      const filters = Number(status.match(/Seccomp_filters:\s+(\d+)/)?.[1]);
      const namespace = userns !== selfUser && pidns !== selfPid;
      const seccomp = /Seccomp:\s+2/.test(status) && filters > selfFilters;
      const noPrivileges = /NoNewPrivs:\s+1/.test(status) && /CapEff:\s+0+\n/.test(status);
      renderers.push({ namespace, seccomp, noPrivileges, filters });
    }
  }
  if (unsafe.length || !renderers.length || !renderers.every(r => r.namespace && r.seccomp && r.noPrivileges)) throw new Error('sandbox_attestation_failed');
  await probe.close();
  return { uid: process.getuid(), chromium: context.browser()?.version(), proof: 'proc-renderer-namespaces-and-additional-seccomp-filter', namespaceSandbox: true, seccompBpfSandbox: true, noNewPrivileges: true, unsafeFlags: false, workerSeccompFilters: selfFilters, renderers };
}

async function shutdown(code = 0) {
  if (shuttingDown) return; shuttingDown = true;
  await context?.close().catch(() => {}); await writes.catch(() => {}); process.exit(code);
}

try {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('non_root_linux_required');
  const proxy = new URL(process.env.BROWSER_PROXY_SERVER || '');
  if (proxy.protocol !== 'http:' || proxy.username || proxy.password) throw new Error('invalid_proxy_configuration');
  context = await chromium.launchPersistentContext('/profile', {
    headless: true, chromiumSandbox: true, viewport, acceptDownloads: false,
    ignoreDefaultArgs: ['--disable-dev-shm-usage'],
    proxy: { server: proxy.href },
    args: ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'],
    timeout: 30000,
  });
  context.setDefaultTimeout(6000);
  context.setDefaultNavigationTimeout(12000);
  const sandbox = await sandboxEvidence();
  // The public API permits web URLs only; the local synthetic sandbox probe is closed.
  await context.route('**/*', route => {
    try { permittedURL(route.request().url()); return route.continue(); }
    catch { return route.abort('blockedbyclient'); }
  });
  for (const page of context.pages()) register(page);
  context.on('page', register);
  await send({ type: 'ready', protocol: 1, ...controller.state(), sandbox, limits: { tabs: MAX_TABS, viewport } });
  const decoder = new FrameDecoder();
  process.stdin.on('data', chunk => {
    try {
      for (const req of decoder.push(chunk)) {
        try {
          controller.submit(req, () => execute(req)).then(
            result => send({ id: req.id, ok: true, ...result }),
            error => send({ id: req.id, ok: false, ...controller.state(), error: error instanceof ProtocolError ? error.code : 'browser_action_failed' }),
          ).catch(() => shutdown(1));
        } catch { void send({ type: 'fatal', error: 'invalid_request' }).finally(() => shutdown(1)); }
      }
    } catch { void send({ type: 'fatal', error: 'invalid_frame' }).finally(() => shutdown(1)); }
  });
  process.stdin.on('end', () => { try { decoder.end(); void shutdown(); } catch { void shutdown(1); } });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
} catch {
  // Never serialize Playwright error text: it may include entered values or page URLs.
  await send({ type: 'fatal', error: 'browser_startup_or_sandbox_failed' });
  await shutdown(1);
}
