import type { BrowserCommand } from './browser';
import { CommandValidationError } from './validation';

function fail(message = 'This browser command is not supported.'): never { throw new CommandValidationError(message); }
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) fail('Select a valid browser session or tab.'); return value; }
function number(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('The browser revision or coordinate is invalid.'); return value as number; }
function text(value: unknown, max: number): string { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('The browser input exceeds its supported limit.'); return value; }
export function browserURL(raw: unknown): string {
  const value = text(raw, 4096); let url: URL;
  try { url = new URL(value); } catch { return fail('Enter a complete http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Only HTTP and HTTPS pages without embedded credentials can be opened.');
  return url.href;
}
export function parseBrowserCommand(raw: unknown): BrowserCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail();
  const v = raw as Record<string, unknown>;
  let length = 0; try { length = Buffer.byteLength(JSON.stringify(v)); } catch { fail(); }
  if (length > 32768) fail('The browser command is too large.');
  const keys = (fields: string[]) => { const expected = ['type', 'agentId', ...fields]; if (expected.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !expected.includes(k))) fail('The browser command has missing or unsupported fields.'); };
  const agentId = id(v.agentId);
  if (v.type === 'browser.state') { keys([]); return { type: v.type, agentId }; }
  if (v.type === 'browser.open') { keys(['taskId']); return { type: v.type, agentId, taskId: id(v.taskId) }; }
  const bound = { agentId, sessionId: id(v.sessionId), generation: number(v.generation) };
  const boundKeys = ['sessionId', 'generation'];
  switch (v.type) {
    case 'browser.close': case 'browser.observe': case 'browser.takeControl': case 'browser.returnControl': keys(boundKeys); return { type: v.type, ...bound };
    case 'browser.requestLogin': keys([...boundKeys, 'taskId']); return { type: v.type, ...bound, taskId: id(v.taskId) };
    case 'browser.newTab': keys([...boundKeys, 'url']); return { type: v.type, ...bound, url: v.url==='about:blank'?'about:blank':browserURL(v.url) };
    case 'browser.selectTab': case 'browser.closeTab': keys([...boundKeys, 'tabId']); return { type: v.type, ...bound, tabId: id(v.tabId) };
    case 'browser.saveDownload': keys([...boundKeys, 'downloadId']); return { type: v.type, ...bound, downloadId: id(v.downloadId) };
  }
  const page = { ...bound, tabId: id(v.tabId), revision: number(v.revision) }, pageKeys = [...boundKeys, 'tabId', 'revision'];
  switch (v.type) {
    case 'browser.navigate': keys([...pageKeys, 'url']); return { type: v.type, ...page, url: browserURL(v.url) };
    case 'browser.pointer': keys([...pageKeys, 'x', 'y']); return { type: v.type, ...page, x: number(v.x, 0, 4096), y: number(v.y, 0, 4096) };
    case 'browser.scroll': keys([...pageKeys, 'x', 'y']); return { type: v.type, ...page, x: number(v.x, -2000, 2000), y: number(v.y, -2000, 2000) };
    case 'browser.text': keys([...pageKeys, 'text']); return { type: v.type, ...page, text: text(v.text, 8192) };
    case 'browser.key': {
      keys([...pageKeys, 'key']); const key = text(v.key, 80);
      if (!/^(?:(?:Control|Meta|Alt|Shift)\+){0,4}(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(key)) fail('That browser key is not supported.');
      return { type: v.type, ...page, key };
    }
    case 'browser.upload': {
      keys([...pageKeys, 'versionId', 'ref', 'destinationOrigin']); const origin = browserURL(v.destinationOrigin);
      if (new URL(origin).origin + '/' !== origin) fail('Upload grants must name the current site origin.');
      return { type: v.type, ...page, versionId: id(v.versionId), ref: id(v.ref), destinationOrigin: new URL(origin).origin };
    }
    default: return fail();
  }
}
