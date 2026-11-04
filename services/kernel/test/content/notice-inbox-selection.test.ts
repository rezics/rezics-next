import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  DEFAULT_INBOX_SELECTION,
  inboxCandidateScanLimit,
  INBOX_CANDIDATE_FACTOR,
  INBOX_CANDIDATE_SCAN_CEILING,
} from '../../src/content/notice-inbox.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { reactionFixture } from './reactions.test.ts';
import { observeSql } from './support/sql-observer.ts';

let fixture: Awaited<ReturnType<typeof reactionFixture>>;
let kernel: ReturnType<typeof createKernel>;
beforeAll(async () => {
  fixture = await reactionFixture();
  kernel = createKernel({
    pool: fixture.db.pool,
    routeKey: new Uint8Array(32).fill(71),
    access: fixture.access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
  });
}, 120_000);
afterAll(async () => fixture?.close());

async function call(path: string) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      headers: { authorization: `Bearer ${fixture.bearer()}` },
    }),
  );
  return { response, value: response.status === 204 ? null : ((await response.json()) as any) };
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
  const seenThrough = ids[2]!;
  const mark = await kernel.handle(
    new Request(`http://kernel.test${base}:markSeen`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixture.bearer()}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ through: seenThrough }),
    }),
  );
  expect(mark.status).toBe(204);

  const all = await call(`${base}?limit=10&selection=all`);
  expect(all.response.status).toBe(200);
  expect(all.value.selection).toBe('all');
  expect(all.value.viewer).toEqual({ accountId: fixture.accountId });
  expect(all.value.items.map((item: { id: string }) => item.id)).toEqual([...ids].reverse());
  expect(all.value.actions.markSeen).toEqual({
    method: 'POST',
    path: `${base}:markSeen`,
    through: ids[4],
  });

  const unread = await call(`${base}?limit=10&selection=unread`);
  expect(unread.value.selection).toBe('unread');
  expect(unread.value.items.map((item: { id: string; unread: boolean }) => [item.id, item.unread])).toEqual([
    [ids[4], true],
    [ids[3], true],
  ]);
  expect(unread.value.next).toBeNull();
  expect(unread.value.actions.markSeen.through).toBe(ids[4]);

  const continuing = await call(`${base}?limit=1&selection=unread`);
  expect(continuing.value.items.map((item: { id: string }) => item.id)).toEqual([ids[4]]);
  expect(continuing.value.next).toEqual(expect.any(String));
  expect(continuing.value.actions.markSeen).toBeNull();
  const sameRange = await call(`${base}?limit=1&selection=unread&cursor=${encodeURIComponent(continuing.value.next)}`);
  expect(sameRange.response.status).toBe(200);
  expect(sameRange.value.items.map((item: { id: string }) => item.id)).toEqual([ids[3]]);
  expect(sameRange.value.selection).toBe('unread');

  const allFirst = await call(`${base}?limit=1&selection=all`);
  const crossed = await call(`${base}?limit=1&selection=unread&cursor=${encodeURIComponent(allFirst.value.next)}`);
  expect(crossed.response.status).toBe(400);
  expect(crossed.value.code).toBe('invalid_cursor');
  const invalid = await call(`${base}?limit=1&selection=all&cursor=not-a-cursor`);
  expect(invalid.response.status).toBe(400);
  expect(invalid.value.code).toBe('invalid_cursor');
});

test('list candidate LIMIT is min(4×page size, 200) at three page sizes for All and Unread', async () => {
  await seed(3);
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  const observed: number[] = [];
  for (const selection of ['all', 'unread'] as const) {
    for (const limit of [1, 20, 50]) {
      const trace = observeSql(fixture.db.pool);
      try {
        const page = await call(`${base}?limit=${limit}&selection=${selection}`);
        expect(page.response.status).toBe(200);
        const list = trace.records.find(
          (record) => record.statement.includes('FROM content.notice AS n') && record.statement.includes('DESC LIMIT'),
        )!;
        expect(list.parameters.at(-1)).toBe(inboxCandidateScanLimit(limit));
        expect(list.statement.split('s.seen_notice_id IS NULL').length - 1).toBe(selection === 'unread' ? 2 : 1);
        observed.push(list.parameters.at(-1) as number);
      } finally {
        await trace.close();
      }
    }
  }
  expect(observed).toEqual([4, 80, 200, 4, 80, 200]);
});
