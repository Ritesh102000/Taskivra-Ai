import { event, opaqueToken, safeTicket, ticketInWorkspace, scopedNotes } from './domain.mjs';
import { HttpError, requireCapability } from './policy.mjs';

export function createShare(store, context, ticketId) {
  requireCapability(store, context, 'create_share');
  const ticket = ticketInWorkspace(store, context, ticketId);
  if (!ticket) throw new HttpError(404, 'This ticket is not available in your workspace.');
  const token = opaqueToken();
  const share = { token, tenantId: context.tenantId, ticketId, policy: 'workspace-members', expiresAt: Date.now() + 60 * 60_000, createdBy: context.personId };
  store.shares.set(token, share);
  event(store, context, 'Workspace link created', ticket.reference);
  return { token, path: `/shared/${token}`, policy: share.policy, expiresAt: new Date(share.expiresAt).toISOString(), ticket: ticket.reference };
}
export function openShare(store, context, token) {
  const share = store.shares.get(token);
  if (!share || share.expiresAt <= Date.now()) throw new HttpError(404, 'This workspace link has expired or does not exist.');
  requireCapability(store, context, 'read_share');
  const ticket = store.tickets.find(row => row.id === share.ticketId);
  if (!ticket) throw new HttpError(404, 'Ticket no longer available.');
  event(store, context, 'Workspace link opened', ticket.reference);
  return { ...safeTicket(ticket), notes: scopedNotes(store, ticket), share: { policy: share.policy, workspace: store.tenants.find(tenant => tenant.id === share.tenantId).name, expiresAt: new Date(share.expiresAt).toISOString() } };
}
export function publicSnapshot(store, token) {
  const share = store.shares.get(token);
  if (!share?.publicSummary || share.expiresAt <= Date.now()) throw new HttpError(404, 'Public snapshot not found.');
  const ticket = store.tickets.find(row => row.id === share.ticketId);
  return { token, reference: ticket.reference, title: ticket.title, status: ticket.status, workspace: store.tenants.find(tenant => tenant.id === ticket.tenantId).name, policy: 'Summary is public. Full ticket details are available to members of the originating workspace.' };
}
