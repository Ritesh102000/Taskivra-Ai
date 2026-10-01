import { event } from './domain.mjs';
import { requireCapability } from './policy.mjs';

export function exportTickets(store, context) {
  requireCapability(store, context, 'export_tickets');
  const tickets = store.tickets.filter(ticket => ticket.tenantId === context.tenantId);
  const rows = tickets.flatMap(ticket => {
    const notes = store.notes.filter(note => note.reference === ticket.reference);
    return (notes.length ? notes : [{ text: '', author: '' }]).map(note => ({
      workspace: store.tenants.find(tenant => tenant.id === ticket.tenantId).name,
      reference: ticket.reference, customer: ticket.customer, title: ticket.title,
      status: ticket.status, note: note.text, noteAuthor: note.author,
    }));
  });
  const fields = ['workspace', 'reference', 'customer', 'title', 'status', 'note', 'noteAuthor'];
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [fields.join(','), ...rows.map(row => fields.map(field => quote(row[field])).join(','))].join('\r\n');
  event(store, context, 'Ticket export generated', `${rows.length} rows`);
  return { name: `harbor-desk-${context.tenantId}.csv`, rows, csv, generatedAt: new Date().toISOString() };
}
