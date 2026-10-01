import { readFile, readdir, readlink } from 'node:fs/promises';
export async function sandboxEvidence(context) {
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
