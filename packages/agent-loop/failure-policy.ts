import { createHash } from 'node:crypto';

export const REPEATED_FAILURE_LIMIT = 3;

function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
 return value;
}

/** Store only an identity, never failed tool arguments (which can contain private text). */
export function failureFingerprint(tool: string, args: Record<string, unknown>, code: string, ownerUpdateIds: string[]): string {
 return createHash('sha256').update(JSON.stringify(canonical({ tool, args, code, ownerUpdateIds }))).digest('hex');
}
