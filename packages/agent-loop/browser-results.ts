import type { LivePolicy } from '../contracts/live';
import { liveFail } from '../contracts/live-validation';

const MAX_OBSERVATION_BYTES = 20 * 1024;
const MAX_TAB_LIST_BYTES = 8 * 1024;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(v);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const loginURL = (url: URL) => /^(accounts|login|signin)\./i.test(url.hostname) || /(?:^|\/)(?:login|signin|sign-in|oauth|authorize|auth)(?:\/|$)/i.test(url.pathname);
function permitted(raw: unknown, policy: LivePolicy, localOrigin?:string): URL | null {
 try { const u = new URL(String(raw)); return (u.protocol === 'https:'||localOrigin==='http://127.0.0.1:4318'&&u.origin===localOrigin) && !u.username && !u.password && policy.allowedOrigins.includes(u.origin) ? u : null; } catch { return null; }
}
function prefixThatFits(text: string, fits: (value: string) => boolean): string {
 const points = Array.from(text); let low = 0, high = points.length;
 while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(points.slice(0, middle).join(''))) low = middle; else high = middle - 1; }
 return points.slice(0, low).join('');
}

/** Never return human login content or credentials, even when a runtime lacks a login flag. */
export function cleanBrowserObservation(raw: unknown, policy: LivePolicy, localOrigin?:string): Record<string, unknown> {
 const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}, url = permitted(r.url, policy, localOrigin);
 let origin: string | undefined; try { const candidate = new URL(String(r.url)); if (candidate.origin !== 'null' && ['https:', 'http:'].includes(candidate.protocol)) origin = candidate.origin; } catch {}
 if (!url || loginURL(url) || r.humanLoginRequired === true || r.nativeHumanControl === true) return {
  loginOrRedirect: true, ...(origin ? { url: origin } : {}),
  ...(r.humanLoginRequired === true || url && loginURL(url) ? { humanLoginRequired: true } : {}),
  ...(r.nativeHumanControl === true ? { nativeHumanControl: true } : {}),
  message: 'This is a login, owner-control view, or page outside the approved reading sites. It is not source evidence. Request browser handoff if needed, then verify a fresh approved page.',
 };
 if (!id(r.tab) || !Number.isSafeInteger(r.revision) || Number(r.revision) < 1 || url.href.length > 4096 || typeof r.title !== 'string' || r.title.length > 200 || !Array.isArray(r.targets) || r.targets.length > 150) liveFail('invalid_observation', 'The browser returned an invalid bounded observation.');
 const targets = r.targets as unknown[];
 if (targets.some(t => !t || typeof t !== 'object' || !id((t as Record<string, unknown>).ref) || typeof (t as Record<string, unknown>).kind !== 'string' || !['input', 'file', 'select', 'button', 'link'].includes(String((t as Record<string, unknown>).kind)) || typeof (t as Record<string, unknown>).label !== 'string' || String((t as Record<string, unknown>).label).length > 160)) liveFail('invalid_observation', 'The browser returned invalid page targets.');
 const received = typeof r.text === 'string' ? r.text : '', textLimitChars = 16000;
 let text = received.slice(0, textLimitChars); if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
 const safeTargets = targets.map(t => { const v = t as Record<string, unknown>; return { ref: v.ref as string, kind: v.kind as string, label: v.label as string }; });
 while (bytes(safeTargets) > 6500) safeTargets.pop();
 const limits=r.limits&&typeof r.limits==='object'?r.limits as Record<string,unknown>:{};
 const targetLimit=Number.isSafeInteger(limits.targetLimit)&&Number(limits.targetLimit)>0&&Number(limits.targetLimit)<=10000?Number(limits.targetLimit):null;
 const traversalLimit=Number.isSafeInteger(limits.traversalLimit)&&Number(limits.traversalLimit)>0&&Number(limits.traversalLimit)<=100000?Number(limits.traversalLimit):null;
 const result: Record<string, unknown> = { tabId: r.tab, url: url.href, title: r.title, text, revision: r.revision, targets: safeTargets,
  textTruncated: received.length > text.length || r.textTruncated === true || r.truncated === true ? true : null,
  textLimitReached: received.length >= textLimitChars, returnedTextChars: text.length, textLimitChars, targetsTruncated: safeTargets.length < targets.length || limits.targetLimitReached===true || limits.traversalLimitReached===true, targetLimit, traversalLimit, targetLimitReached:typeof limits.targetLimitReached==='boolean'?limits.targetLimitReached:null, traversalLimitReached:typeof limits.traversalLimitReached==='boolean'?limits.traversalLimitReached:null, returnedTargetCount: safeTargets.length,
  fullPageVerified: false, coverage: 'Bounded main-document text and targets; frames and unloaded content may be absent. Upstream total length is unknown. Refreshing repeats a current snapshot, not pagination through omitted text.' };
 if (bytes(result) > MAX_OBSERVATION_BYTES) {
  result.textTruncated = true;
  result.text = prefixThatFits(text, value => bytes({ ...result, text: value, returnedTextChars: value.length }) <= MAX_OBSERVATION_BYTES);
  result.returnedTextChars = String(result.text).length;
 }
 return result;
}

/** Lists session-local handles only; a tab inventory is never factual page evidence. */
export function cleanBrowserTabs(raw: unknown, policy: LivePolicy) {
 if (!Array.isArray(raw) || raw.length > 6) liveFail('invalid_observation', 'The browser returned an invalid tab list.');
 const tabs = (raw as unknown[]).map(value => {
  if (!value || typeof value !== 'object') return liveFail('invalid_observation', 'The browser returned an invalid tab.');
  const tab = value as Record<string, unknown>;
  if (!id(tab.id) || typeof tab.url !== 'string' || tab.url.length > 4096 || typeof tab.title !== 'string' || tab.title.length > 200 || !Number.isSafeInteger(tab.revision) || Number(tab.revision) < 1) return liveFail('invalid_observation', 'The browser returned an invalid tab.');
  const url = permitted(tab.url, policy), readable = !!url && !loginURL(url);
  return { tabId: tab.id, revision: tab.revision, readable, ...(readable ? { title: tab.title, url: url!.href } : { title: 'Login, blank page, or outside approved sites', url: null }) };
 });
 // Inventory keeps every opaque ID, but drops long URLs/titles rather than losing handles in an excerpt wrapper.
 let compacted = false;
 for (let i = tabs.length - 1; bytes(tabs) > MAX_TAB_LIST_BYTES && i >= 0; i--) { tabs[i] = { ...tabs[i], title: 'Open this tab for a fresh approved observation', url: null }; compacted = true; }
 return { tabs, compacted, sourceEvidence: false, note: 'Only tabs in this task’s private browser session. Listing or closing a tab is not an observation of its content.' };
}
