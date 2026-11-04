import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  DEFAULT_INBOX_SELECTION,
  inboxCandidateScanLimit,
  INBOX_CANDIDATE_FACTOR,
  INBOX_CANDIDATE_SCAN_CEILING,
  InvalidInboxCursorError,
  listNoticeInbox,
  markNoticesSeen,
  type InboxDependencies,
} from '../../src/content/notice-inbox.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { reactionFixture } from './reactions.test.ts';
import { observeSql } from './support/sql-observer.ts';

let fixture: Awaited<ReturnType<typeof reactionFixture>>;
let inbox: InboxDependencies;
const originalReceiptKeys = process.env.KERNEL_RECEIPT_KEYS;
beforeAll(async () => {
  process.env.KERNEL_RECEIPT_KEYS = [...testReceiptKeys().keys]
    .map(([version, key]) => `${version}:${Buffer.from(key).toString('base64url')}`)
    .join(',');
  fixture = await reactionFixture();
  inbox = {
    pool: fixture.db.pool,
    routeKey: new Uint8Array(32).fill(71),
    access: fixture.access,
    actor: await fixture.verified(),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
  };
}, 120_000);
afterAll(async () => {
  await fixture?.close();
  if (originalReceiptKeys === undefined) delete process.env.KERNEL_RECEIPT_KEYS;
  else process.env.KERNEL_RECEIPT_KEYS = originalReceiptKeys;
});

function list(input: { limit: number; cursor?: string; selection?: 'all' | 'unread' }) {
  return listNoticeInbox(inbox, fixture.accountId, input);
}

async function seed(count: number) {
  await fixture.db.admin.query('TRUNCATE TABLE content.notice_ack, content.notice, content.notice_seen');
  const recipient = fixture.accountId;
  const r = routeOf(recipient)!;
  const ids = Array.from({ length: count }, (_, i) => newId(r));
  await fixture.db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
     SELECT $1,$2,x,'moderation_decision',x,'2026-10-27T00:00:00Z'::timestamptz + i * interval '1 second'
     FROM unnest($3::uuid[]) WITH ORDINALITY AS v(x,i)`,
    [r, recipient, ids],
  );
  return ids;
}

test('candidate scan limits are static page-size bounds', () => {
  expect(DEFAULT_INBOX_SELECTION).toBe('all');
  expect(INBOX_CANDIDATE_FACTOR).toBe(4);
  expect(INBOX_CANDIDATE_SCAN_CEILING).toBe(200);
  expect(inboxCandidateScanLimit(1)).toBe(4);
  expect(inboxCandidateScanLimit(20)).toBe(80);
  expect(inboxCandidateScanLimit(50)).toBe(200);
});

test('All and Unread bind selection into the cursor, admit displayed through, and seek unread without walking read pages', async () => {
  const ids = await seed(5);
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  await markNoticesSeen(fixture.db.pool, fixture.accountId, ids[2]!);

  const all = await list({ limit: 10, selection: 'all' });
  expect(all.selection).toBe('all');
  expect(all.viewer).toEqual({ accountId: fixture.accountId });
  expect(all.items.map((item) => item.id)).toEqual([...ids].reverse());
  expect(all.actions.markSeen).toEqual({
    method: 'POST',
    path: `${base}:markSeen`,
    through: ids[4],
  });

  const unread = await list({ limit: 10, selection: 'unread' });
  expect(unread.selection).toBe('unread');
  expect(unread.items.map((item) => [item.id, item.unread])).toEqual([
    [ids[4], true],
    [ids[3], true],
  ]);
  expect(unread.next).toBeNull();
  expect(unread.actions.markSeen?.through).toBe(ids[4]);

  const continuing = await list({ limit: 1, selection: 'unread' });
  expect(continuing.items.map((item) => item.id)).toEqual([ids[4]]);
  expect(continuing.next).toEqual(expect.any(String));
  expect(continuing.actions.markSeen).toBeNull();
  const sameRange = await list({ limit: 1, selection: 'unread', cursor: continuing.next! });
  expect(sameRange.items.map((item) => item.id)).toEqual([ids[3]]);
  expect(sameRange.selection).toBe('unread');

  const allFirst = await list({ limit: 1, selection: 'all' });
  await expect(list({ limit: 1, selection: 'unread', cursor: allFirst.next! })).rejects.toBeInstanceOf(
    InvalidInboxCursorError,
  );
  await expect(list({ limit: 1, selection: 'all', cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
    InvalidInboxCursorError,
  );
});

test('list candidate LIMIT is min(4×page size, 200) at three page sizes for All and Unread', async () => {
  await seed(3);
  const observed: number[] = [];
  for (const selection of ['all', 'unread'] as const) {
    for (const limit of [1, 20, 50]) {
      const trace = observeSql(fixture.db.pool);
      try {
        const page = await list({ limit, selection });
        expect(page.selection).toBe(selection);
        const listed = trace.records.find(
          (record) => record.statement.includes('FROM content.notice AS n') && record.statement.includes('DESC LIMIT'),
        )!;
        expect(listed.parameters.at(-1)).toBe(inboxCandidateScanLimit(limit));
        expect(listed.statement.split('s.seen_notice_id IS NULL').length - 1).toBe(selection === 'unread' ? 2 : 1);
        observed.push(listed.parameters.at(-1) as number);
      } finally {
        await trace.close();
      }
    }
  }
  expect(observed).toEqual([4, 80, 200, 4, 80, 200]);
});
