// The runtime transport is trusted; page content and model arguments are not.
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_PENDING = 32;

export class ProtocolError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function encodeFrame(value, limit = MAX_RESPONSE_BYTES) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > limit) throw new ProtocolError('frame_too_large');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

export class FrameDecoder {
  constructor(limit = MAX_REQUEST_BYTES) { this.limit = limit; this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > this.limit) throw new ProtocolError('invalid_frame_length');
      if (this.buffer.length < length + 4) break;
      try { values.push(JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'))); }
      catch { throw new ProtocolError('invalid_json'); }
      this.buffer = this.buffer.subarray(length + 4);
    }
    if (this.buffer.length > this.limit + 4) throw new ProtocolError('frame_too_large');
    return values;
  }
  end() { if (this.buffer.length) throw new ProtocolError('truncated_frame'); }
}

const methods = new Set(['tabs.list', 'tabs.open', 'tabs.close', 'page.navigate', 'page.observe', 'page.click', 'page.fill', 'page.key', 'page.scroll', 'control.take', 'control.release']);
export function validateRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new ProtocolError('invalid_request');
  if (typeof req.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(req.id)) throw new ProtocolError('invalid_id');
  if (!methods.has(req.method)) throw new ProtocolError('unknown_method');
  if (!['agent', 'human', 'owner'].includes(req.actor)) throw new ProtocolError('invalid_actor');
  if (!Number.isSafeInteger(req.generation) || req.generation < 1) throw new ProtocolError('invalid_generation');
  if (!req.params || typeof req.params !== 'object' || Array.isArray(req.params)) throw new ProtocolError('invalid_params');
  return req;
}

export function permittedURL(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) throw new ProtocolError('invalid_url');
  let url;
  try { url = new URL(raw); } catch { throw new ProtocolError('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ProtocolError('permission_denied');
  return url.href; // IP/destination enforcement belongs to the external proxy/network.
}

export function boundedString(value, max = 2048) {
  if (typeof value !== 'string' || value.length > max) throw new ProtocolError('invalid_string');
  return value;
}

export class SessionController {
  constructor() { this.controller = 'agent'; this.generation = 1; this.tail = Promise.resolve(); this.pending = 0; }
  state() { return { controller: this.controller, generation: this.generation }; }
  submit(request, action) {
    validateRequest(request);
    if (this.pending >= MAX_PENDING) return Promise.reject(new ProtocolError('queue_full'));
    const control = request.method.startsWith('control.');
    if (request.generation !== this.generation) return Promise.reject(new ProtocolError('stale_generation'));
    if (control) {
      if (request.actor !== 'owner') return Promise.reject(new ProtocolError('permission_denied'));
      const expected = request.method === 'control.take' ? 'agent' : 'human';
      if (this.controller !== expected) return Promise.reject(new ProtocolError('controller_busy'));
      // Fence future/queued actions immediately, but do not claim human ownership until
      // the currently executing bounded operation has settled.
      this.controller = 'transitioning';
      this.generation += 1;
    } else if (request.actor !== this.controller) return Promise.reject(new ProtocolError('permission_denied'));
    const admitted = this.generation;
    this.pending += 1;
    const work = this.tail.then(async () => {
      if (!control && (request.generation !== this.generation || request.actor !== this.controller)) throw new ProtocolError('stale_generation');
      if (control) this.controller = request.method === 'control.take' ? 'human' : 'agent';
      const result = await action();
      // An in-flight agent read finishing during takeover cannot return sensitive page data.
      if (!control && (admitted !== this.generation || request.actor !== this.controller)) throw new ProtocolError('outcome_unknown');
      return { ...this.state(), result };
    });
    this.tail = work.catch(() => {}).finally(() => { this.pending -= 1; });
    return work;
  }
}
