import { afterAll, expect, test } from 'bun:test';
import { openGrowthDatabase } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { readDueContentRetention } from '../../src/content/retention-routes.ts';
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

test('the notice sweep elects each due owner through the exact time and route frontier', async () => {
  const cutoff = '1900-02-01T00:00:00Z';
  const old = '1900-01-01T00:00:00.123456Z';
  const [first, second, later, finalization, thread, board] = [0x7141, 0x7142, 0x7143, 0x7150, 0x7160, 0x7170] as const;
  const scan = (frontier = {}) => readDueContentRetention(db.pool, 'notice', cutoff, frontier);
  expect((await scan()).work).toEqual([]);
  async function insert(route: number, date: string, count: number) {
    const ids = Array.from({ length: count }, () => newId(route));
    await db.admin.query(
      `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
       SELECT $1,id,id,'reply',id,$3::timestamptz FROM unnest($2::uuid[]) AS id`,
      [route, ids, date],
    );
  }
  await insert(first, old, 11);
  await insert(second, old, 1);
  await insert(later, cutoff, 1);
  await db.admin.query(
    "INSERT INTO content.notice_finalization VALUES ($1,$2,'thread_watch',$2,true,$3::timestamptz)",
    [finalization, newId(finalization), old],
  );
  await db.admin.query(
    'INSERT INTO content.thread_watch_notice_work(route,post_id,thread_id,published_at) VALUES ($1,$2,$2,$3)',
    [thread, newId(thread), old],
  );
  await db.admin.query(
    `INSERT INTO content.board_watch_notice_work
       (route,post_id,board_id,thread_id,source_epoch,source_position,source_id,published_at)
       VALUES ($1,$2,$2,$2,1,1,$2,$3)`,
    [board, newId(board), old],
  );
  const found = await scan();
  const routes = (work: typeof found.work) => work.flatMap((group) => group.routes).sort((a, b) => a - b);
  expect(found.complete).toBe(false);
  expect(routes(found.work)).toEqual([first, finalization, thread, board]);
  expect(found.frontier.notice?.through).toContain('.123456');
  const next = await scan(structuredClone(found.frontier));
  expect(routes(next.work)).toEqual([second]);
  expect(next.complete).toBe(true);
  for (const route of [...routes(found.work), second])
    expect(await deleteExpiredNoticesPage(db.pool, route, new Date(cutoff))).toBeGreaterThan(0);
  expect((await scan()).work).toEqual([]);
  await insert(first, old, 1);
  expect(routes((await scan()).work)).toEqual([first]);
  const future = await readDueContentRetention(db.pool, 'notice', '1900-02-01T00:00:00.000001Z', {});
  expect(routes(future.work)).toEqual([first, later]);
  for (const route of [first, later]) await deleteExpiredNoticesPage(db.pool, route, new Date('1901-01-01'));
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
    `INSERT INTO content.notice_seen (route, account_id, seen_notice_id, seen_created_at, seen_at)
     VALUES ($1, $2, $3, now(), now()), ($1, $4, $5, now(), now())`,
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
