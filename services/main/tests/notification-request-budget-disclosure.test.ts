import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { configureDisclosurePool, DisclosureStore, type DisclosureChannel, type DisclosureDecision,
  type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { namePolicyPrincipal } from '../src/modules/disclosure/viewer.ts';
import { NotificationStore, type NotificationKind } from '../src/modules/notification/store.ts';
import { notificationReadPool } from '../src/modules/notification/request-budget.ts';
import type { Viewer } from '../src/modules/suitability/policy.ts';

const recipient = '11111111-1111-4111-8111-111111111111';
const realm = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
const work = 'https://rezics.com/id/33333333-3333-4333-8333-333333333333';
const principal = { issuer: 'account', subject: 'recipient' };
const processNotices = [
  ['realm-invitation-v1', 'realm_invitation'],
  ['realm-role-change-v1', 'realm_role_change'],
  ['moderation-outcome-v1', 'moderation_outcome'],
  ['submission-decision-v1', 'submission_decision'],
] as const satisfies readonly (readonly [string, NotificationKind])[];

/** Owner composition only: SQL rows and target decisions are adapters. The
 * notification store and process-notice disclosure/sanitization run unchanged. */
function processNoticeFixture(basis: string, kind: NotificationKind, hidden: string | null,
  deniedAtFence = false, groupKey: string | null = realm) {
  let recipientChecks = 0, resolutions = 0;
  const audiences: { principal: ReturnType<typeof namePolicyPrincipal>; channel: DisclosureChannel }[] = [];
  const rows = ['2', '3'].map(sequence => ({
    id: `44444444-4444-4444-8444-${sequence.padStart(12, '0')}`, sequence,
    purpose: 'governance', topic: 'realm-role-change', state: 'active', subject_owner: 'access',
    subject_ref: `55555555-5555-4555-8555-${sequence.padStart(12, '0')}`, subject_revision: null,
    disclosure_basis: basis, kind, actor_agent: null, realm, group_key: groupKey,
    saved: true, done: false, triage_revision: '4', reason: null, proposal: null, proposal_revision: null,
    created_at: new Date('2026-10-19T00:00:00Z'), individually_read: false,
  }));
  const fields = { title: 'Hidden Work title', linkTarget: work, excerpt: 'Hidden Work excerpt',
    realm, realmName: 'Hidden Realm name', realmRouteSegment: 'hidden-realm', roleName: 'Editor', roleChange: 'given' };
  const query = async (sql: string, args: unknown[] = []) => {
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('SELECT id, active FROM access.principal')) return { rows:
      args[0] === principal.issuer && args[1] === principal.subject ? [{ id: recipient, active: true }] : [] };
    if (sql.includes('FROM access.notification_stream')) return { rows: args[0] === recipient
      ? [{ generation: '7', head_sequence: '3' }] : [] };
    if (sql.includes('FROM access.notification_item')) return { rows: args[0] === recipient ? rows : [] };
    if (sql.includes('notification_read_watermark')) return { rows: [{ read_through: '1' }] };
    if (sql.includes('person_block')) {
      recipientChecks++;
      return { rows: (args[0] as string[]).map((id, index) => ({ ordinal: String(index + 1),
        allowed: id === recipient && !(deniedAtFence && recipientChecks > 1) })) };
    }
    return { rows: [] };
  };
  const pool = notificationReadPool({ query, connect: async () => ({ query, release() {} }) } as unknown as Pool);
  class TargetDecisions extends DisclosureStore {
    override async read(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel) {
      audiences.push({ principal: namePolicyPrincipal(viewer), channel });
      return Object.assign(targets.map((target): DisclosureDecision =>
        target.resource === hidden ? 'hidden' : 'visible'), { cost: {} });
    }
  }
  configureDisclosurePool(pool, new TargetDecisions(pool));
  const store = new NotificationStore(pool);
  store.registerReadSubjectReader(basis, { async resolve(input) {
    expect(input.principalId).toBe(recipient);
    resolutions++;
    return { status: 'available', subject: { private: true, fields } };
  } });
  return { store, audiences, fields, resolutions: () => resolutions };
}

for (const [basis, kind] of processNotices) {
  test(`${basis}: inbox keeps the process notice and uses the final sanitized subject`, async () => {
    const fixture = processNoticeFixture(basis, kind, work);
    const page = await fixture.store.readStream(principal, null, 1);
    expect(page).toMatchObject({ generation: '7', head: '3', readThrough: '1', reset: false, next: '7:2' });
    expect(page.items[0]).toMatchObject({ state: 'active', read: false, saved: true, done: false,
      triageRevision: '4', subject: { owner: 'access' }, display: { kind, roleName: 'Editor', roleChange: 'given',
        realm: null, realmName: null, realmRouteSegment: null, groupKey: null,
        target: { title: null, linkTarget: null, excerpt: null } } });
    expect(page.groups).toEqual([]);
    const serialized = JSON.stringify(page);
    for (const hidden of ['Hidden Work title', 'Hidden Work excerpt', work, realm, 'Hidden Realm name', 'hidden-realm']) {
      expect(serialized).not.toContain(hidden);
    }
    expect(fixture.audiences).toEqual([{ principal, channel: 'inbox' }]);
    expect(await fixture.store.unreadCount(principal)).toEqual({ generation: '7', count: 2, overflow: false });
  });
}

test('a hidden Realm removes optional context from an otherwise available process notice', async () => {
  const fixture = processNoticeFixture('realm-role-change-v1', 'realm_role_change', realm);
  const page = await fixture.store.readStream(principal, null);
  expect(page.items).toHaveLength(2);
  expect(page.items.every(item => item.subject !== null && item.display?.realm === null
    && item.display.target.title === null && item.display.target.linkTarget === null)).toBe(true);
  expect(JSON.stringify(page)).not.toContain(realm);
});

test('a hidden optional Work is withheld from the process notice grouping identity', async () => {
  const fixture = processNoticeFixture('submission-decision-v1', 'submission_decision', work, false, work);
  const page = await fixture.store.readStream(principal, null);
  expect(page.items.every(item => item.subject !== null && item.display?.groupKey === null)).toBe(true);
  expect(page.groups).toEqual([]);
  expect(JSON.stringify(page)).not.toContain(work);
});

test('sanitized process notices can still group by their recipient-owned case identity', async () => {
  const caseId = '66666666-6666-4666-8666-666666666666';
  const fixture = processNoticeFixture('moderation-outcome-v1', 'moderation_outcome', work, false, caseId);
  const page = await fixture.store.readStream(principal, null);
  expect(page.groups).toEqual([{ kind: 'moderation_outcome', key: caseId, itemIds: page.items.map(item => item.id) }]);
  expect(JSON.stringify(page)).not.toContain(work);
});

test('visible process notice context, grouping, cursor and unread semantics are preserved', async () => {
  const fixture = processNoticeFixture('realm-role-change-v1', 'realm_role_change', null);
  const page = await fixture.store.readStream(principal, null, 1);
  expect(page).toMatchObject({ generation: '7', head: '3', readThrough: '1', next: '7:2' });
  expect(page.items[0]?.display).toMatchObject({ realm, realmName: fixture.fields.realmName, groupKey: realm,
    roleName: 'Editor', target: { title: fixture.fields.title, linkTarget: work, excerpt: fixture.fields.excerpt } });
  expect(page.groups).toEqual([{ kind: 'realm_role_change', key: realm, itemIds: [page.items[0]!.id] }]);
  expect(await fixture.store.unreadCount(principal)).toEqual({ generation: '7', count: 2, overflow: false });
});

test('final recipient denial still withholds an otherwise available process notice', async () => {
  const fixture = processNoticeFixture('realm-role-change-v1', 'realm_role_change', null, true);
  const page = await fixture.store.readStream(principal, null, 1);
  expect(page.items[0]).toMatchObject({ subject: null, display: null, reason: null, proposal: null });
  expect(page.groups).toEqual([]);
});

test('another principal receives no process notice or subject resolution', async () => {
  const fixture = processNoticeFixture('realm-role-change-v1', 'realm_role_change', null);
  const page = await fixture.store.readStream({ issuer: principal.issuer, subject: 'another-recipient' }, null);
  expect(page.items).toEqual([]);
  expect(page.groups).toEqual([]);
  expect(fixture.resolutions()).toBe(0);
});
