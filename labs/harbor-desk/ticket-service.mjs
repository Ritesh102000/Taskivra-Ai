import { event, member, opaqueToken, safeTicket, ticketInWorkspace, scopedNotes } from './domain.mjs';
import { HttpError, requireCapability } from './policy.mjs';

export function listTickets(store, context, { status = 'all', query = '' } = {}) {
  requireCapability(store, context, 'view_tickets');
  if (!['all', 'open', 'pending', 'closed'].includes(status)) throw new HttpError(400, 'Unknown ticket status.');
  const normalized = query.trim().toLocaleLowerCase().slice(0, 80);
  const key = JSON.stringify({ role: member(store, context).role, status, query: normalized });
  const existing = store.ticketCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.rows.map(safeTicket);
  const rows = store.tickets.filter(ticket => ticket.tenantId === context.tenantId)
    .filter(ticket => status === 'all' || ticket.status === status)
    .filter(ticket => !normalized || `${ticket.reference} ${ticket.title} ${ticket.customer}`.toLocaleLowerCase().includes(normalized))
    .map(safeTicket);
  store.ticketCache.set(key, { rows, expiresAt: Date.now() + 30 * 60_000 });
  event(store, context, 'Ticket list opened', `${rows.length} records; ${status}`);
  return rows.map(safeTicket);
}
export function createTicket(store, context, body) {
  requireCapability(store, context, 'create_share');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const customer = typeof body.customer === 'string' ? body.customer.trim() : '';
  const reference = typeof body.reference === 'string' ? body.reference.trim().toUpperCase() : '';
  if (title.length < 4 || title.length > 120 || customer.length < 2 || customer.length > 60 || !/^[A-Z][A-Z0-9-]{2,24}$/.test(reference)) throw new HttpError(400, 'Enter a title, customer and external reference.');
  if (store.tickets.some(ticket => ticket.tenantId === context.tenantId && ticket.reference === reference)) throw new HttpError(409, 'That external reference already exists in your workspace.');
  const ticket = { id: `t-${opaqueToken().replaceAll('_', '-').slice(0, 12)}`, tenantId: context.tenantId, reference, title, customer, email: 'customer@example.test', status: 'open', priority: 'normal', assignee: store.people.find(person => person.id === context.personId).name, updated: new Date().toISOString().slice(0, 16).replace('T', ' '), description: typeof body.description === 'string' ? body.description.slice(0, 600) : '' };
  store.tickets.push(ticket);
  store.notes.push({ tenantId: context.tenantId, reference, author: ticket.assignee, text: 'Private trial note: ticket created in this workspace.', visibility: 'internal' });
  event(store, context, 'Ticket created', reference);
  return { ...safeTicket(ticket), notes: scopedNotes(store, ticket) };
}
export function getTicket(store, context, ticketId) {
  requireCapability(store, context, 'view_tickets');
  const ticket = ticketInWorkspace(store, context, ticketId);
  if (!ticket) throw new HttpError(404, 'This ticket is not available in your workspace.');
  event(store, context, 'Ticket opened', ticket.reference);
  return { ...safeTicket(ticket), notes: scopedNotes(store, ticket) };
}
export function overview(store, context) {
  requireCapability(store, context, 'view_tickets');
  const tickets = store.tickets.filter(ticket => ticket.tenantId === context.tenantId);
  return {
    open: tickets.filter(ticket => ticket.status === 'open').length,
    pending: tickets.filter(ticket => ticket.status === 'pending').length,
    resolved: tickets.filter(ticket => ticket.status === 'closed').length,
    responseMinutes: context.tenantId === 'harbor' ? 18 : 24,
  };
}
