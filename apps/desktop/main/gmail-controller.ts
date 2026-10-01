import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { GmailOwnerCommand, GmailState } from '../../../packages/contracts/index';

export class GmailControllerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GmailControllerError'; }
}
const fail = (message: string): never => { throw new GmailControllerError('invalid_gmail_command', message); };
export function parseGmailOwnerCommand(raw: unknown): GmailOwnerCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail('Choose a supported Gmail connection action.');
  const value = raw as Record<string, unknown>;
  const keys = value.type === 'gmail.connect' ? ['type', 'taskId'] : ['type'];
  if (Object.keys(value).some(key => !keys.includes(key))) return fail('Gmail connection actions cannot supply accounts, URLs, secrets, or file paths.');
  if (value.type === 'gmail.state' || value.type === 'gmail.disconnect' || value.type === 'gmail.verify') return { type: value.type };
  if (value.type === 'gmail.connect' && typeof value.taskId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value.taskId)) return { type: value.type, taskId: value.taskId };
  return fail('Choose a saved Gmail task before connecting.');
}
interface GmailConnectionService {
  status(): Promise<GmailState>;
  importClient(json: string): Promise<GmailState>;
  connect(account: string): Promise<GmailState>;
  disconnect(): Promise<GmailState>;
  verifyConnection?(account:string):Promise<unknown>;
}
const FILE_LIMIT = 16 * 1024;
export class GmailController {
  private picking = false;
  constructor(private service: GmailConnectionService, private taskAccount: (taskId: string) => Promise<string | null>, private pickClient: () => Promise<string | null>) {}
  async handle(raw: unknown): Promise<GmailState> {
    const command = parseGmailOwnerCommand(raw);
    if (command.type === 'gmail.state') return this.service.status();
    if (command.type === 'gmail.disconnect') return this.service.disconnect();
    if (command.type === 'gmail.verify') {const state=await this.service.status();if(!state.connectedAccount||!this.service.verifyConnection)return fail('Connect Gmail before verifying the account.');await this.service.verifyConnection(state.connectedAccount);return this.service.status();}
    const account = await this.taskAccount(command.taskId);
    if (!account || !/^[A-Za-z0-9._%+-]+@gmail\.com$/.test(account)) return fail('This task does not have a saved read-only Gmail account.');
    return this.service.connect(account);
  }
  async importClient(raw: unknown): Promise<{ state: GmailState; cancelled: boolean }> {
    if (raw !== undefined) return fail('Choose the OAuth client file using the native picker.');
    if (this.picking) return fail('Finish the current OAuth client selection first.');
    this.picking = true;
    try {
      const path = await this.pickClient();
      if (!path) return { state: await this.service.status(), cancelled: true };
      let json: string;
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || before.size < 2n || before.size > BigInt(FILE_LIMIT)) throw new Error('invalid');
          const bytes = Buffer.alloc(FILE_LIMIT + 1); let length = 0;
          while (length < bytes.length) { const chunk = await file.read(bytes, length, bytes.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
          const after = await file.stat({ bigint: true });
          if (length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('changed');
          json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        } finally { await file.close(); }
      } catch { throw new GmailControllerError('invalid_client_file', 'Choose an unchanged, regular UTF-8 Google Desktop OAuth client JSON file smaller than 16 KiB.'); }
      return { state: await this.service.importClient(json), cancelled: false };
    } finally { this.picking = false; }
  }
}
