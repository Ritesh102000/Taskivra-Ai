import { execFile } from 'node:child_process';
import { open, realpath, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import type { BrowserHealth } from '../contracts/browser-setup';

const run = promisify(execFile);
export interface ProfileEvidence { registered: boolean; connected: boolean; damaged: boolean; installed: boolean | null; running: boolean | null }
export function describeProfileHealth(evidence: ProfileEvidence): { health: BrowserHealth; setupRequired: boolean; message: string | null } {
  if (evidence.damaged) return { health: 'profile_repair', setupRequired: true, message: 'This dedicated profile has an unsafe or damaged bridge registration. Repair that profile’s setup before connecting.' };
  if (evidence.connected) return { health: 'connected', setupRequired: false, message: null };
  if (!evidence.registered) return { health: 'setup_required', setupRequired: true, message: 'Prepare this agent’s dedicated Chrome profile once to connect its browser.' };
  if (evidence.installed === false) return { health: 'extension_missing', setupRequired: true, message: 'This profile does not have the Agent Workspaces extension yet. Open Chrome setup to install it once.' };
  if (evidence.running === false) return { health: 'profile_closed', setupRequired: false, message: 'This agent’s Chrome profile is closed. Open its window to reconnect; saved logins stay in its private profile.' };
  return { health: 'extension_disconnected', setupRequired: false, message: evidence.installed === true ? 'The extension is installed but has not connected. Open this profile’s Extensions page, enable or reload Agent Workspaces, then check again.' : 'This profile is prepared, but its extension connection is not available. Open its Chrome window first; if it stays disconnected, check Extensions.' };
}

/** Read only the expected extension entry. Never expose profile preferences or cookies. */
export async function profileExtensionInstalled(profile: string, extensionId: string): Promise<boolean | null> {
  const root = resolve(profile), directory = join(root, 'Default');
  try { if (await realpath(root) !== root || await realpath(directory) !== directory) return null; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null; }
  let readable = false, uncertain = false;
  for (const name of ['Secure Preferences', 'Preferences']) {
    let file;
    try {
      file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.uid !== process.getuid?.()) { uncertain = true; continue; }
      const data = JSON.parse(await file.readFile('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) { uncertain = true; continue; }
      readable = true;
      const entry = data.extensions?.settings?.[extensionId];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') uncertain = true; }
    finally { await file?.close(); }
  }
  return readable && !uncertain ? false : null;
}

/** A process hint for UI only; connection authentication remains the security boundary. */
export async function profileIsRunning(profile: string): Promise<boolean | null> {
  const root = resolve(profile);
  try {
    if (await realpath(root) !== root) return null;
    const lock = await readlink(join(root, 'SingletonLock'));
    const match = /^(.*)-(\d+)$/.exec(lock);
    if (!match || match[1] !== hostname()) return null;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 1000, maxBuffer: 16384 });
    const marker = `--user-data-dir=${root}`;
    const at = stdout.indexOf(marker), remainder = at < 0 ? '' : stdout.slice(at + marker.length).trim();
    return at >= 0 && (remainder === '' || remainder.startsWith('--')) && /Google Chrome/.test(stdout.slice(0, at));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as {code?:unknown}).code === 1) return false;
    return null;
  }
}
