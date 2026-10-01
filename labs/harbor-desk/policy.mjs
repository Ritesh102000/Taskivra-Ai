import { event, member } from './domain.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function capabilities(store, context) {
  const membership = member(store, context);
  if (!membership) throw new HttpError(403, 'This persona does not belong to the selected workspace.');
  const key = `${context.tenantId}:${context.personId}:${membership.roleRevision}`;
  if (!store.permissions.has(key)) {
    store.permissions.set(key, {
      view_tickets: true,
      read_share: true,
      create_share: membership.role !== 'viewer',
      manage_members: membership.role === 'admin',
      export_tickets: membership.exportGrant,
    });
  }
  return { ...store.permissions.get(key) };
}
export function requireCapability(store, context, capability) {
  if (!capabilities(store, context)[capability]) throw new HttpError(403, 'Your current workspace role does not allow this action.');
}
export function setOwnExportConsent(store, context, enabled) {
  const target = member(store, context);
  if (!target) throw new HttpError(403, 'Workspace membership required.');
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'Choose an export permission.');
  target.exportGrant = enabled;
  target.grantRevision += 1;
  event(store, context, 'Personal export access updated', enabled ? 'allowed' : 'paused');
  return { exportEnabled: target.exportGrant, grantRevision: target.grantRevision };
}
