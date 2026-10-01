// Only the trusted coordinator owns this transport. Nothing here exposes Playwright, CDP, eval or a shell.
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
export const MAX_PENDING = 32;
export const CHUNK_BYTES = 128 * 1024;
export const FILE_BYTES = 100 * 1024 * 1024;
export const PROFILE_BYTES = 256 * 1024 * 1024;
export const PROFILE_FILES = 4096;
export class ProtocolError extends Error { constructor(code) { super(code); this.code = code; } }
export function fail(code) { throw new ProtocolError(code); }
export function encodeFrame(value, limit = MAX_RESPONSE_BYTES) {
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > limit) fail('frame_too_large');
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]);
}
export class FrameDecoder {
  constructor(limit = MAX_REQUEST_BYTES) { this.limit = limit; this.buffer = Buffer.alloc(0); }
  push(chunk) {
    // Consume without retaining an unbounded batch supplied by a pipe writer.
    const values = []; let offset = 0;
    while (offset < chunk.length) {
      const want = this.buffer.length < 4 ? 4 - this.buffer.length : 4 + this.buffer.readUInt32BE(0) - this.buffer.length;
      const count = Math.min(want, chunk.length - offset);
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + count)]); offset += count;
      if (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0); if (!length || length > this.limit) fail('invalid_frame_length');
        if (this.buffer.length === length + 4) {
          if (values.length >= MAX_PENDING) fail('queue_full');
          try { values.push(JSON.parse(this.buffer.subarray(4).toString('utf8'))); } catch { fail('invalid_json'); }
          this.buffer = Buffer.alloc(0);
        }
      }
    }
    return values;
  }
  end() { if (this.buffer.length) fail('truncated_frame'); }
}
const schemas = {
  'session.launch': [], 'session.status': [], 'session.close': ['discardPending'],
  'tabs.list': [], 'tabs.open': ['url'], 'tabs.close': ['tab'],
  'page.navigate': ['tab','url'], 'page.observe': ['tab','screenshot'], 'page.peek':['tab'], 'page.gmailUnread':['tab','account'],
  'page.click': ['tab','revision','ref','x','y'], 'page.fill': ['tab','revision','ref','value'], 'page.select': ['tab','revision','ref','value'],
  'page.key': ['tab','revision','text','key'], 'page.scroll': ['tab','revision','x','y'],
  'control.take': ['tab'], 'control.release': ['tab'],
  'upload.begin': ['name','bytes','sha256','versionId','tab','revision','ref','origin'],
  'upload.chunk': ['id','offset','base64'], 'upload.finish': ['id'], 'upload.abort': ['id'],
  'download.list': [], 'download.read': ['id','offset','length'], 'download.ack': ['id'], 'download.cancel': ['id'],
  'profile.restore.begin': ['files'], 'profile.restore.file': ['path','bytes','sha256'],
  'profile.restore.chunk': ['path','offset','base64'], 'profile.restore.finish': [],
  'profile.read': ['path','offset','length'],
};
const brokerMethods = new Set(['session.launch','session.status','session.close','tabs.list','page.observe','page.peek', ...Object.keys(schemas).filter(s => /^(upload|download|profile)\./.test(s))]);
export function boundedString(value, max = 2048) { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('invalid_string'); return value; }
export function opaque(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(value)) fail('invalid_id'); return value; }
export function integer(value, min, max, code = 'invalid_number') { if (!Number.isSafeInteger(value) || value < min || value > max) fail(code); return value; }
export function permittedURL(raw) {
  boundedString(raw,4096); let url; try { url = new URL(raw); } catch { fail('invalid_url'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) fail('permission_denied'); return url.href;
}
export function permittedTabURL(raw) { return raw==='about:blank'?raw:permittedURL(raw); }
export function validateRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req) || Object.keys(req).some(k => !['id','method','actor','generation','params'].includes(k))) fail('invalid_request');
  opaque(req.id); if (!Object.hasOwn(schemas,req.method)) fail('unknown_method');
  if (!['agent','human','owner','broker'].includes(req.actor)) fail('invalid_actor');
  integer(req.generation,1,Number.MAX_SAFE_INTEGER,'invalid_generation');
  if (!req.params || typeof req.params !== 'object' || Array.isArray(req.params) || Object.keys(req.params).some(k => !schemas[req.method].includes(k))) fail('invalid_params');
  if (/^(profile|upload|download|session)\./.test(req.method) && req.actor !== 'broker') fail('permission_denied');
  if (req.method==='page.peek' && req.actor!=='broker') fail('permission_denied');
  if (req.actor === 'broker' && !brokerMethods.has(req.method)) fail('permission_denied');
  return req;
}
export class SessionController {
  constructor(initialGeneration = 1) { integer(initialGeneration,1,Number.MAX_SAFE_INTEGER-2); this.controller='agent'; this.generation=initialGeneration; this.tail=Promise.resolve(); this.pending=0; this.freshRequired=true; }
  state() { return {controller:this.controller,generation:this.generation,requiresFreshObservation:this.freshRequired}; }
  submit(request,action) {
    validateRequest(request);
    if (this.pending >= MAX_PENDING) return Promise.reject(new ProtocolError('queue_full'));
    if (request.generation !== this.generation) return Promise.reject(new ProtocolError('stale_generation'));
    const control=request.method.startsWith('control.'), broker=request.actor==='broker';
    if (control) {
      if (request.actor !== 'owner') return Promise.reject(new ProtocolError('permission_denied'));
      if (this.controller !== (request.method==='control.take'?'agent':'human')) return Promise.reject(new ProtocolError('controller_busy'));
      if (this.generation >= Number.MAX_SAFE_INTEGER-1) return Promise.reject(new ProtocolError('generation_limit'));
      this.controller='transitioning'; this.generation++; this.freshRequired=true;
    } else if (!broker && request.actor !== this.controller) return Promise.reject(new ProtocolError('permission_denied'));
    const admitted=this.generation; this.pending++;
    const work=this.tail.then(async()=>{
      if (!control && (request.generation!==this.generation || (!broker && request.actor!==this.controller))) fail('stale_generation');
      if (control) this.controller=request.method==='control.take'?'human':'agent';
      if (request.actor==='agent' && this.freshRequired && !['page.observe','tabs.list'].includes(request.method)) fail('fresh_observation_required');
      const result=await action();
      if (!control && (admitted!==this.generation || (!broker && request.actor!==this.controller))) fail('outcome_unknown');
      if (request.actor==='agent' && request.method==='page.observe') this.freshRequired=false;
      return {...this.state(),result};
    });
    this.tail=work.catch(()=>{}).finally(()=>{this.pending--;}); return work;
  }
}
