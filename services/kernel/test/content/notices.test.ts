import { afterAll, expect, test } from 'bun:test';
import { openGrowthDatabase } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  deleteAccountNoticePage,
  deleteAccountNoticeSeen,
  deleteExpiredNoticesPage,
  writeNotices,
} from '../../src/content/notices.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

function notice(recipientId: string, route = routeOf(recipientId)!, createdAt = new Date()) {
  return {
    recipientId,
    noticeId: newId(route),
    kind: 'reply' as const,
    actorId: null,
    threadId: null,
    postId: null,
    decisionId: null,
    reportId: null,
    sourceId: newId(route),
    createdAt,
  };
}

async function seedNoticeRows(recipientId: string, count: number, createdAt: Date): Promise<string[]> {
  const route = routeOf(recipientId)!;
  const ids = Array.from({ length: count }, () => newId(route));
  await db.admin.query(
    `INSERT INTO content.notice (route, recipient_id, notice_id, kind, source_id, created_at)
     SELECT $1, $2, requested.id, 'reply', requested.id, $4::timestamptz
     FROM unnest($3::uuid[]) AS requested(id)`,
    [route, recipientId, ids, createdAt],
  );
  return ids;
}

test("writeNotices stores each notice once on the recipient's route, and a replay writes nothing", async () => {
  const firstRoute = 0x1234;
  const secondRoute = 0x1244;
  const first = newId(firstRoute);
  const second = newId(firstRoute);
  const third = newId(secondRoute);
  const input = [notice(first), notice(second), notice(third)];
  const trace = observeSql(db.pool);
  try {
    expect(await writeNotices(db.pool, input)).toBe(3);
    expect(await writeNotices(db.pool, input)).toBe(0);
    expect(trace.records.filter((record) => /INSERT INTO content\.notice/i.test(record.statement))).toHaveLength(4);
  } finally {
    await trace.close();
  }

  const rows = await db.admin.query(
    `SELECT route, recipient_id, notice_id, kind, source_id
     FROM content.notice WHERE recipient_id = ANY($1::uuid[]) ORDER BY recipient_id, notice_id`,
    [[first, second, third]],
  );
  expect(rows.rows).toHaveLength(3);
  const routesByRecipient = new Map(rows.rows.map((row) => [row.recipient_id, Number(row.route)]));
  expect(routesByRecipient).toEqual(
    new Map([
      [first, firstRoute],
      [second, firstRoute],
      [third, secondRoute],
    ]),
  );
  expect(new Set(rows.rows.map((row) => row.notice_id)).size).toBe(3);
});

test('notices older than 180 days are deleted in bounded pages and newer ones stay', async () => {
  const route = 0x2345;
  const recipientId = newId(route);
  const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  await seedNoticeRows(recipientId, 1001, new Date(cutoff.getTime() - 1));
  const freshIds = await seedNoticeRows(recipientId, 2, new Date(cutoff.getTime() + 1));

  const pageSizes: number[] = [];
  for (;;) {
    const deleted = await deleteExpiredNoticesPage(db.pool, route, cutoff);
    pageSizes.push(deleted);
    if (deleted < 1000) break;
  }

  expect(pageSizes).toEqual([1000, 1]);
  const remaining = await db.admin.query(
    'SELECT notice_id FROM content.notice WHERE route = $1 AND recipient_id = $2 ORDER BY notice_id',
    [route, recipientId],
  );
  expect(remaining.rows.map((row) => row.notice_id).sort()).toEqual(freshIds.sort());
});

test("account erasure deletes the account's notices and seen marker in bounded pages", async () => {
  const route = 0x3456;
  const accountId = newId(route);
  const otherAccountId = newId(route);
  await seedNoticeRows(accountId, 2001, new Date());
  const otherNotice = notice(otherAccountId);
  expect(await writeNotices(db.pool, [otherNotice])).toBe(1);
  const seenNoticeId = newId(route);
  const otherSeenNoticeId = newId(route);
  await db.admin.query(
    `INSERT INTO content.notice_seen (route, account_id, seen_notice_id, seen_at)
     VALUES ($1, $2, $3, now()), ($1, $4, $5, now())`,
    [route, accountId, seenNoticeId, otherAccountId, otherSeenNoticeId],
  );

  const pageSizes: number[] = [];
  for (;;) {
    const deleted = await deleteAccountNoticePage(db.pool, accountId);
    pageSizes.push(deleted);
    if (deleted < 1000) break;
  }
  await deleteAccountNoticeSeen(db.pool, accountId);

  expect(pageSizes).toEqual([1000, 1000, 1]);
  const remainingNotices = await db.admin.query(
    'SELECT recipient_id FROM content.notice WHERE route = $1 AND recipient_id = ANY($2::uuid[])',
    [route, [accountId, otherAccountId]],
  );
  expect(remainingNotices.rows).toEqual([{ recipient_id: otherAccountId }]);
  const remainingSeen = await db.admin.query(
    'SELECT account_id, seen_notice_id FROM content.notice_seen WHERE route = $1 AND account_id = ANY($2::uuid[])',
    [route, [accountId, otherAccountId]],
  );
  expect(remainingSeen.rows).toEqual([{ account_id: otherAccountId, seen_notice_id: otherSeenNoticeId }]);
});
