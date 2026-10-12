import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationDenied, NotificationInvalid, NotificationStale, NotificationStore }
  from '../src/modules/notification/store.ts';
import { notificationRoutes } from '../src/routes/notifications.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const principal = { issuer: 'https://account.rezics.test', subject: 'reader' };
const selections = [{ view: 'saved' }, { view: 'done' }, { reason: 'reviewer' },
  { view: 'saved', reason: 'manual' }] as const;

function inbox() {
  let generation = '7';
  let active = true;
  let absent = false;
  let sequenceHead = '20000';
  const statements: string[] = [];
  const rows = Array.from({ length: 246 }, (_, index) => ({ id: `notice-${index}`,
    sequence: String((index + 1) * 71), purpose: 'governance', topic: 'proposal-revised',
    state: 'erased', subject_owner: 'access', subject_ref: 'proposal', subject_revision: null,
    disclosure_basis: 'proposal', kind: null, actor_agent: null, realm: null, group_key: null,
    saved: index % 2 === 0, done: index % 2 === 1,
    reason: index % 2 === 0 ? 'manual' : 'reviewer', triage_revision: null,
    proposal: null, proposal_revision: null, created_at: new Date('2026-10-12T00:00:00Z'),
    individually_read: false,
  }));
  const query = async (sql: string, args: unknown[] = []) => {
    statements.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('SELECT id, active FROM access.principal')) return { rows: absent ? [] : [{ id: 'reader', active }] };
    if (sql.includes('FROM access.notification_stream')) return { rows: [{ generation, head_sequence: sequenceHead }] };
    if (sql.includes('FROM access.notification_item i')) {
      const descending = /ORDER BY i.sequence DESC/.test(sql);
      const selected = rows.filter(row => args[0] !== null
        && (args[2] === null || (descending ? BigInt(row.sequence) < BigInt(String(args[2]))
          : BigInt(row.sequence) > BigInt(String(args[2]))))
        && (args[4] === 'saved' ? row.saved : args[4] === 'done' ? row.done : !row.done)
        && (args[5] === null || row.reason === args[5]));
      selected.sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence)) * (descending ? -1 : 1));
      return { rows: selected.slice(0, Number(args[3])) };
    }
    return { rows: [] };
  };
  const client = { query, release() {} };
  const store = new NotificationStore({ connect: async () => client, query } as unknown as Pool);
  return { store, rows, statements, reset: () => { generation = '8'; }, deny: () => { active = false; },
    missing: () => { absent = true; }, shrink: () => { sequenceHead = '1'; } };
}

for (const selection of selections) {
  test(`descending ${JSON.stringify(selection)} begins at newest and reaches every sparse match once`, async () => {
    const { store, rows, statements } = inbox();
    const matching = rows.filter(row => ('view' in selection && selection.view === 'saved' ? row.saved
      : 'view' in selection && selection.view === 'done' ? row.done : !row.done)
      && (!('reason' in selection) || row.reason === selection.reason)).reverse();
    const seen: string[] = [];
    let before = 'latest';
    for (let pages = 0; pages < 4; pages++) {
      const page = await store.readStream(principal, null, 50, selection, before);
      expect(page.items.map(item => item.id)).toEqual(matching.slice(seen.length, seen.length + 50).map(row => row.id));
      seen.push(...page.items.map(item => item.id));
      if (page.next === null) break;
      expect(page.next).not.toMatch(/^\d+:\d+$/);
      before = page.next;
    }
    expect(seen).toHaveLength(123);
    expect(new Set(seen).size).toBe(123);
    expect(seen.at(-1)).toBe(matching.at(-1)!.id);
    expect(statements.filter(sql => sql.includes('FROM access.notification_item i'))).toHaveLength(3);
  });
}

test('descending cursors bind recipient and filters, reject malformed input and mixing directions', async () => {
  const { store } = inbox();
  const page = await store.readStream(principal, null, 2, { view: 'saved' }, 'latest');
  expect(page.next).not.toBeNull();
  await expect(store.readStream(principal, null, 2, { view: 'done' }, page.next!)).rejects.toBeInstanceOf(NotificationInvalid);
  await expect(store.readStream({ ...principal, subject: 'other' }, null, 2, { view: 'saved' }, page.next!))
    .rejects.toBeInstanceOf(NotificationInvalid);
  await expect(store.readStream(principal, null, 2, {}, 'bad-cursor')).rejects.toBeInstanceOf(NotificationInvalid);
  await expect(store.readStream(principal, { generation: '7', sequence: '0' }, 2, {}, 'latest'))
    .rejects.toBeInstanceOf(NotificationInvalid);
});

test('descending continuation resets from newest in a new generation, and stale or denied reads fail', async () => {
  const fixture = inbox();
  const first = await fixture.store.readStream(principal, null, 2, {}, 'latest');
  fixture.reset();
  const reset = await fixture.store.readStream(principal, null, 2, {}, first.next!);
  expect(reset.reset).toBe(true);
  expect(reset.generation).toBe('8');
  expect(reset.items.map(item => item.id)).toEqual(first.items.map(item => item.id));
  fixture.deny();
  await expect(fixture.store.readStream(principal, null, 2, {}, 'latest')).rejects.toBeInstanceOf(NotificationDenied);
  const stale = inbox();
  const cursor = (await stale.store.readStream(principal, null, 2, {}, 'latest')).next!;
  stale.shrink();
  await expect(stale.store.readStream(principal, null, 2, {}, cursor)).rejects.toBeInstanceOf(NotificationStale);
  const missing = inbox(); missing.missing();
  expect(await missing.store.readStream(principal, null, 50, {}, 'latest')).toMatchObject({ items: [], next: null });
});

test('forward sync preserves ascending sequence and generation cursors', async () => {
  const { store } = inbox();
  const first = await store.readStream(principal, null, 2);
  expect(first.items.map(item => item.sequence)).toEqual(['71', '213']);
  expect(first.next).toBe('7:213');
  const next = await store.readStream(principal, { generation: '7', sequence: '213' }, 2);
  expect(next.items.map(item => item.sequence)).toEqual(['355', '497']);
});

test('HTTP exposes newest-first pages and returns a continuation that pages older', async () => {
  const { store } = inbox();
  const app = notificationRoutes({ account: { verify: async () => principal }, notifications: { store } } as unknown as MainWorkDependencies);
  const request = (before: string) => app.handle(new Request(
    `http://localhost/v1/me/notifications?view=saved&limit=2&before=${encodeURIComponent(before)}`));
  const first = await request('latest');
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body.items.map((item: { sequence: string }) => item.sequence)).toEqual(['17395', '17253']);
  const next = await request(body.next);
  expect(next.status).toBe(200);
  expect((await next.json()).items.map((item: { sequence: string }) => item.sequence)).toEqual(['17111', '16969']);
  const invalid = await app.handle(new Request('http://localhost/v1/me/notifications?after=7:0&before=latest'));
  expect(invalid.status).toBe(400);
});
