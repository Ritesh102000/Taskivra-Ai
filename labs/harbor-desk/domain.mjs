import { randomBytes } from 'node:crypto';

export function createStore() {
  const tenants = [
    { id: 'harbor', name: 'Harbor Health', initials: 'HH', accent: '#177e74', category: 'Patient services' },
    { id: 'summit', name: 'Summit Retail', initials: 'SR', accent: '#7a58b2', category: 'Customer operations' },
  ];
  const people = [
    { id: 'mara', name: 'Mara Bennett', initials: 'MB', description: 'Workspace administrator' },
    { id: 'eli', name: 'Eli Foster', initials: 'EF', description: 'Operations specialist' },
    { id: 'nova', name: 'Nova Reed', initials: 'NR', description: 'Support viewer' },
  ];
  const memberships = [
    { tenantId: 'harbor', personId: 'mara', role: 'admin', roleRevision: 1, grantRevision: 1, exportGrant: true },
    { tenantId: 'summit', personId: 'mara', role: 'admin', roleRevision: 1, grantRevision: 1, exportGrant: true },
    { tenantId: 'harbor', personId: 'eli', role: 'specialist', roleRevision: 1, grantRevision: 1, exportGrant: true },
    { tenantId: 'summit', personId: 'eli', role: 'specialist', roleRevision: 1, grantRevision: 1, exportGrant: false },
    { tenantId: 'summit', personId: 'nova', role: 'viewer', roleRevision: 1, grantRevision: 1, exportGrant: false },
  ];
  const tickets = [
    { id: 'h-1042', tenantId: 'harbor', reference: 'HD-1042', title: 'Coverage review for follow-up appointment', customer: 'Ava Harbor', email: 'ava.harbor@example.test', status: 'open', priority: 'high', assignee: 'Eli Foster', updated: '2026-09-30 09:42', description: 'Confirm the synthetic follow-up appointment and review the plan coverage before contacting the demo patient.' },
    { id: 'h-1056', tenantId: 'harbor', reference: 'HD-1056', title: 'Document request for care coordinator', customer: 'Jonah Blue', email: 'jonah.blue@example.test', status: 'pending', priority: 'normal', assignee: 'Mara Bennett', updated: '2026-09-30 09:17', description: 'The care coordinator needs a copy of the fabricated intake summary. The draft is awaiting an internal review.' },
    { id: 'h-1080', tenantId: 'harbor', reference: 'HD-1080', title: 'Address correction on patient profile', customer: 'Mina Shore', email: 'mina.shore@example.test', status: 'open', priority: 'normal', assignee: 'Eli Foster', updated: '2026-09-30 08:55', description: 'Update the placeholder mailing address after validating the submitted demo form.' },
    { id: 'h-1088', tenantId: 'harbor', reference: 'HD-1088', title: 'Appointment reminder preference updated', customer: 'Theo Cove', email: 'theo.cove@example.test', status: 'closed', priority: 'normal', assignee: 'Mara Bennett', updated: '2026-09-29 16:20', description: 'The synthetic patient now receives reminders by email. No further action is needed.' },
    { id: 's-1042', tenantId: 'summit', reference: 'HD-1042', title: 'Refund review for duplicate order', customer: 'Cora Summit', email: 'cora.summit@example.test', status: 'open', priority: 'high', assignee: 'Eli Foster', updated: '2026-09-30 10:02', description: 'Review the duplicate synthetic order and confirm whether the second payment should be refunded.' },
    { id: 's-1056', tenantId: 'summit', reference: 'HD-1056', title: 'VIP delivery instruction adjustment', customer: 'Leo Ridge', email: 'leo.ridge@example.test', status: 'pending', priority: 'normal', assignee: 'Mara Bennett', updated: '2026-09-30 09:31', description: 'A fabricated premium customer asked to revise delivery instructions before dispatch.' },
    { id: 's-1091', tenantId: 'summit', reference: 'HD-1091', title: 'Replacement confirmation for damaged item', customer: 'Nia Peak', email: 'nia.peak@example.test', status: 'open', priority: 'normal', assignee: 'Eli Foster', updated: '2026-09-30 08:28', description: 'Confirm that the replacement item is reserved in the demo warehouse and send the draft update for review.' },
    { id: 's-1098', tenantId: 'summit', reference: 'HD-1098', title: 'Tracking clarification resolved', customer: 'Owen Vale', email: 'owen.vale@example.test', status: 'closed', priority: 'normal', assignee: 'Mara Bennett', updated: '2026-09-29 17:04', description: 'The simulated carrier updated the delivery estimate. The customer inquiry is closed.' },
  ];
  const notes = [
    { tenantId: 'harbor', reference: 'HD-1042', author: 'Eli Foster', text: 'Harbor Health internal: synthetic care plan HH-DEMO-381 requires coordinator approval.', visibility: 'internal' },
    { tenantId: 'harbor', reference: 'HD-1056', author: 'Mara Bennett', text: 'Harbor Health internal: fabricated intake packet HH-INTAKE-204 is ready for review.', visibility: 'internal' },
    { tenantId: 'harbor', reference: 'HD-1080', author: 'Eli Foster', text: 'Harbor Health: placeholder address verified against the demo intake form.', visibility: 'internal' },
    { tenantId: 'summit', reference: 'HD-1042', author: 'Mara Bennett', text: 'Summit Retail confidential: fictional refund approval SR-REFUND-992, amount $842.00.', visibility: 'internal' },
    { tenantId: 'summit', reference: 'HD-1056', author: 'Eli Foster', text: 'Summit Retail confidential: demo VIP delivery code SR-VIP-731.', visibility: 'internal' },
    { tenantId: 'summit', reference: 'HD-1091', author: 'Eli Foster', text: 'Summit Retail: replacement reserved in the synthetic warehouse.', visibility: 'internal' },
  ];
  const snapshot = { token: opaqueToken(), tenantId: 'harbor', ticketId: 'h-1042', policy: 'workspace-members', publicSummary: true, expiresAt: Date.now() + 24 * 60 * 60_000, createdBy: 'mara' };
  return { tenants, people, memberships, tickets, notes, sessions: new Map(), permissions: new Map(), ticketCache: new Map(), shares: new Map([[snapshot.token, snapshot]]), activity: [], nextEvent: 1 };
}

export const opaqueToken = () => randomBytes(24).toString('base64url');
export function member(store, context) {
  return store.memberships.find(m => m.tenantId === context.tenantId && m.personId === context.personId);
}
export function event(store, context, action, details = '') {
  store.activity.unshift({ id: store.nextEvent++, tenantId: context.tenantId, personId: context.personId, action, details, at: new Date().toISOString() });
  store.activity.splice(120);
}
export function safeTicket(ticket) {
  return { ...ticket };
}
export function ticketInWorkspace(store, context, ticketId) {
  return store.tickets.find(ticket => ticket.id === ticketId && ticket.tenantId === context.tenantId);
}
export function scopedNotes(store, ticket) {
  return store.notes.filter(note => note.tenantId === ticket.tenantId && note.reference === ticket.reference);
}
export function createTrial(store, { name, email, workspaceName }) {
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 60 || typeof workspaceName !== 'string' || workspaceName.trim().length < 2 || workspaceName.length > 60 || typeof email !== 'string' || !/^[a-z0-9.+_-]+@(?:[a-z0-9-]+\.)*example\.test$/i.test(email) || email.length > 100) return null;
  const personId = `u-${randomBytes(6).toString('hex')}`;
  const tenantId = `w-${randomBytes(6).toString('hex')}`;
  store.people.push({ id: personId, name: name.trim(), email, initials: name.trim().split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase(), description: 'Trial workspace member' });
  store.tenants.push({ id: tenantId, name: workspaceName.trim(), initials: workspaceName.trim().split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase(), accent: '#177e74', category: 'Customer operations' });
  store.memberships.push({ tenantId, personId, role: 'specialist', roleRevision: 1, grantRevision: 1, exportGrant: true });
  for (const [offset, status, title] of [[1, 'open', 'Welcome to your trial inbox'], [2, 'pending', 'Review your draft onboarding reply'], [3, 'closed', 'Workspace setup completed']]) {
    const ticket = { id: `${tenantId}-${offset}`, tenantId, reference: `HD-${2000 + offset}`, title, customer: ['Alex Trial', 'Sam Example', 'Taylor Demo'][offset - 1], email: ['alex', 'sam', 'taylor'][offset - 1] + '@example.test', status, priority: 'normal', assignee: name.trim(), updated: '2026-09-30 10:15', description: 'A fabricated starter record for your private trial workspace. Use it to explore ordinary customer operations.' };
    store.tickets.push(ticket);
    store.notes.push({ tenantId, reference: ticket.reference, author: name.trim(), text: 'Private trial note: this starter record belongs to your workspace.', visibility: 'internal' });
  }
  return { personId, tenantId };
}
