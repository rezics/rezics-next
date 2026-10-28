import { afterAll, expect, test } from 'bun:test';
import { listNoticeInbox, countUnreadNotices } from '../../src/content/notice-inbox.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(33)]]) };

test('inbox list and unread count examine constant index rows as a recipient inbox grows', async () => {
  const recipient = newId(0x6123),
    route = routeOf(recipient)!;
  const seen: number[] = [];
  for (const scale of [256, 1024, 4096]) {
    const ids = Array.from({ length: scale }, () => newId(route));
    await db.admin.query(
      `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
       SELECT $1,$2,id,'moderation_decision',id,now() - ($4-ordinality) * interval '1 second'
       FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
      [route, recipient, ids, scale],
    );
    const trace = observeSql(db.pool);
    try {
      const page = await listNoticeInbox({ pool: db.pool, tokens }, recipient, { limit: 20 });
      const count = await countUnreadNotices(db.pool, recipient);
      expect(page.items).toHaveLength(20);
      expect(count).toEqual({ count: 100, capped: true });
      const list = trace.records.find((record) => record.statement.includes('FROM content.notice n'))!;
      const counter = trace.records.find((record) => record.statement.includes('LIMIT 101'))!;
      expect(list.parameters.at(-1)).toBe(80);
      expect(counter.statement).toContain('LIMIT 101');
      seen.push(list.parameters.at(-1) as number);
    } finally {
      await trace.close();
    }
  }
  expect(seen).toEqual([80, 80, 80]);
});
