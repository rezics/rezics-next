import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { renderedDeliveryPayload } from '../src/modules/notification/dispatcher.ts';
import { sanctionFromFields } from '../src/modules/notification/display.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import { notificationProducerSubjectReader } from '../src/modules/notification-producers/subjects.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const moderator = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const moderatorPrincipal = '22222222-2222-4222-8222-222222222222';
const moderatorName = 'Morgan Hale';
const moderatorHandle = 'morgan_hale';
const moderatorAvatar = 'https://cdn.example/morgan.png';
const realm = 'https://rezics.com/id/33333333-3333-4333-8333-333333333333';
const member = 'https://rezics.com/id/44444444-4444-4444-8444-444444444444';
const reviewer = 'https://rezics.com/id/66666666-6666-4666-8666-666666666666';
const identity = [moderator, moderatorPrincipal, moderatorName, moderatorHandle, moderatorAvatar];
const until = '2026-11-01T00:00:00.000Z';
const reason = 'Repeated rule violations';

function absent(value: unknown) {
  const text = JSON.stringify(value);
  for (const token of identity) expect(text.includes(token)).toBe(false);
}

async function produce(kind: 'realm_membership_change' | 'realm_role_change' | 'submission_decision',
  receipt: Record<string, unknown>): Promise<NotificationEvent> {
  const emitted: NotificationEvent[] = [];
  const client = { query: async (sql: string) => {
    if (sql.includes('editorial-notification-v1')) return { rows: [] };
    if (sql.includes('FROM access.recovery_fence') && !sql.includes('FROM access.notification_producer_event'))
      return { rows: [{ open: true }] };
    if (sql.includes('FROM access.notification_producer_cursor'))
      return { rows: [{ epoch: '0', xid: '0', id: '0', position: '0' }] };
    if (sql.includes('FROM access.notification_producer_event')) return { rows: [{
      epoch: '0', xid: '7', id: '1', kind, event_id: '55555555-5555-4555-8555-555555555555' }] };
    if (sql.includes('FROM access.realm_admin_receipt')) return { rows: [receipt] };
    if (sql.includes('FROM access.realm_submission_revision')) return { rows: [{
      id: 'submission', realm, work: realm, submitting_agent: member, reviewer, state: 'accepted',
      actor: moderatorPrincipal }] };
    return { rows: [] };
  }, release() {} };
  const access = { connect: async () => client, query: async (sql: string) => {
    if (sql.includes('access.sequence_editorial_events')) return { rows: [{ sequence_editorial_events: 0 }] };
    throw new Error(`unexpected Access query: ${sql}`);
  } } as unknown as Pool;
  const producer = new NotificationProducer(access, null, {} as Pool, {} as never,
    { enqueue: async (event: NotificationEvent) => { emitted.push(event); return []; } } as never, null);
  expect(await producer.runAccessOnce()).toBe(1);
  return emitted[0]!;
}

function reader(receipt: Record<string, unknown>) {
  const access = { query: async (sql: string) => {
    if (sql.includes('FROM access.realm_admin_receipt')) return { rows: [receipt] };
    if (sql.includes('AS member,impact.ordinal')) return { rows: [{ member }] };
    throw new Error(`unexpected subject query: ${sql}`);
  } } as unknown as Pool;
  const env = { fuseki: { query: async () => ({ results: { bindings: [] } }) } } as unknown as WorkActivationEnvironment;
  return notificationProducerSubjectReader(access, {} as Pool, env);
}

test('a ban notification stores no moderator and renders the reason, the end and the Realm link', async () => {
  const receipt = { realm, principal_id: moderatorPrincipal, acting_subject: moderator,
    member_action: 'ban', reason, result: { member, banned: true, bannedUntil: until } };
  const event = await produce('realm_membership_change', receipt);
  const stored = { display: event.display, subject: event.subject, topic: event.topic };
  absent(stored);
  expect(event.display).toEqual({ kind: 'realm_role_change', actorAgent: null, realm, groupKey: realm });
  expect(event.topic).toBe('realm-membership-change');

  const resolved = await reader(receipt).resolve({ owner: 'access', ref: '55555555-5555-4555-8555-555555555555',
    revision: null, principalId: '77777777-7777-4777-8777-777777777777',
    disclosureBasis: 'realm-role-change-v1', realm });
  expect(resolved.status).toBe('available');
  if (resolved.status !== 'available') return;
  const fields = resolved.subject.fields;
  const inbox = sanctionFromFields(fields);
  const mail = renderedDeliveryPayload(fields, 'email', { private: true, lockScreenDisclosure: false });
  const push = renderedDeliveryPayload(fields, 'push', { private: true, lockScreenDisclosure: true });
  const lockScreen = renderedDeliveryPayload(fields, 'push', { private: true, lockScreenDisclosure: false });
  for (const form of [fields, inbox, mail, push, lockScreen]) absent(form);
  expect(fields.reason).toBe(reason);
  expect(fields.action).toBe('ban');
  expect(fields.bannedUntil).toBe(until);
  expect(fields.permanent).toBe('false');
  expect(fields.realm).toBe(realm);
  expect(fields.href).toBe(`/r/${realm.slice(-36)}`);
  expect(inbox).toMatchObject({ membershipAction: 'ban', membershipReason: reason, membershipUntil: until,
    membershipPermanent: false });
  expect(mail.reason).toBe(reason);
  expect(mail.bannedUntil).toBe(until);
  expect(push.reason).toBe(reason);
  expect(push.bannedUntil).toBe(until);
  expect(lockScreen).toEqual({ notice: 'new-activity' });
});

test('a permanent ban says it does not end, and an unban says the ban has ended', async () => {
  const permanent = { realm, principal_id: moderatorPrincipal, acting_subject: moderator,
    member_action: 'ban', reason: 'Harassment after a warning', result: { member, banned: true, bannedUntil: null } };
  const lifted = { realm, principal_id: moderatorPrincipal, acting_subject: moderator,
    member_action: 'unban', reason: 'The report was withdrawn', result: { member, banned: false, bannedUntil: null } };
  for (const receipt of [permanent, lifted]) {
    const event = await produce('realm_membership_change', receipt);
    absent({ display: event.display, subject: event.subject });
    expect(event.display?.actorAgent).toBeNull();
    const resolved = await reader(receipt).resolve({ owner: 'access',
      ref: '55555555-5555-4555-8555-555555555555', revision: null,
      principalId: '77777777-7777-4777-8777-777777777777', disclosureBasis: 'realm-role-change-v1', realm });
    expect(resolved.status).toBe('available');
    if (resolved.status !== 'available') continue;
    absent(resolved.subject.fields);
    expect(resolved.subject.fields.reason).toBe(receipt.reason);
    expect(resolved.subject.fields.href.startsWith('/r/')).toBe(true);
    if (receipt.member_action === 'ban') {
      expect(resolved.subject.fields.permanent).toBe('true');
      expect(resolved.subject.fields.bannedUntil).toBeUndefined();
    } else {
      expect(resolved.subject.fields.action).toBe('unban');
      expect(resolved.subject.fields.permanent).toBe('false');
    }
  }
});

test('a legacy ban receipt and a role change still follow their own actor rules', async () => {
  const legacy = { realm, principal_id: moderatorPrincipal, acting_subject: moderator,
    member_action: null, reason, result: { member, banned: true, bannedUntil: null } };
  const legacyEvent = await produce('realm_membership_change', legacy);
  expect(legacyEvent.display?.actorAgent).toBeNull();
  absent(legacyEvent.display);

  const role = await produce('realm_role_change', { realm, principal_id: moderatorPrincipal,
    acting_subject: moderator, member_action: null, reason: 'Role update',
    result: { impact: { changes: [{ member }] } } });
  expect(role.display?.actorAgent).toBe(moderator);
  expect(role.topic).toBe('realm-role-change');

  const submission = await produce('submission_decision', {});
  expect(submission.display).toMatchObject({ kind: 'submission_decision', actorAgent: reviewer });
});
