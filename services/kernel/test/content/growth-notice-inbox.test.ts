import { afterAll, expect, test } from 'bun:test';
import { listNoticeInbox, countUnreadNotices, markNoticesSeen } from '../../src/content/notice-inbox.ts';
import { deleteExpiredNoticesPage } from '../../src/content/notices.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentNoticeEffects } from '../../src/content/relays.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(33)]]) };

test('inbox list and unread count examine constant index rows as a recipient inbox grows', async () => {
  const recipient = newId(0x6123),
    route = routeOf(recipient)!;
  const marker = newId(route);
  await db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
     VALUES ($1,$2,$3,'moderation_decision',$3,'2026-01-01')`,
    [route, recipient, marker],
  );
  await markNoticesSeen(db.pool, recipient, marker);
  expect(await deleteExpiredNoticesPage(db.pool, route, new Date('2026-01-02'))).toBe(1);
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
      expect(page.items.every((item) => item.unread)).toBe(true);
      expect(count).toEqual({ count: 100, capped: true });
      const list = trace.records.find((record) => record.statement.includes('FROM content.notice n'))!;
      const counter = trace.records.find((record) => record.statement.includes('LIMIT 101'))!;
      expect(list.parameters.at(-1)).toBe(80);
      expect(counter.statement).toContain('LIMIT 101');
      expect(counter.statement).toContain('(created_at,notice_id)>');
      expect(list.statement).not.toContain('JOIN content.notice seen');
      seen.push(list.parameters.at(-1) as number);
    } finally {
      await trace.close();
    }
  }
  expect(seen).toEqual([80, 80, 80]);
});

test('native inbox disclosure of a real post notice stays bounded as the recipient range grows', async () => {
  const native = await replyNoticeFixture();
  try {
    let thread: Awaited<ReturnType<typeof native.thread>> | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = await native.thread();
      if (routeOf(candidate.id) !== routeOf(native.boardId)) {
        thread = candidate;
        break;
      }
    }
    expect(thread).toBeDefined();
    const independentThread = thread!;
    expect(routeOf(independentThread.id)).not.toBe(routeOf(native.boardId));
    const post = await native.post(independentThread.id);
    const event = (await native.envelope(post.id)).events.find(Boolean)!;
    const effects = contentNoticeEffects(
      native.db.pool,
      createContentWorkAccess(() => new Date(), native.db.pool),
    );
    const replyEffect = effects.find((effect) => effect.name === 'content_reply_notice');
    expect(replyEffect).toBeDefined();
    await replyEffect!.run(event);
    expect(await native.notices(post.id)).toHaveLength(1);

    const recipient = native.accounts.recipient;
    const recipientRoute = routeOf(recipient)!;
    const report = await checkGrowth(native.db, {
      name: 'native inbox post disclosure amid recipient range growth',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      warmups: 1,
      grow: async (target, scale, previous) => {
        const ids = Array.from({ length: scale - previous }, () => newId(recipientRoute));
        await target.admin.query(
          `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
           SELECT $1,$2,id,'moderation_decision',id,'2026-10-27T00:00:00Z'::timestamptz + ordinality * interval '1 millisecond'
           FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
          [recipientRoute, recipient, ids],
        );
      },
      operation: async () => {
        const result = await native.call(recipient, 'GET', `/v1/accounts/${recipient}/notifications?limit=20`);
        expect(result.status).toBe(200);
        expect(result.value.items).toHaveLength(20);
        expect(
          result.value.items.some(
            (item: { kind: string; postId: string | null }) => item.kind === 'reply' && item.postId === post.id,
          ),
        ).toBe(true);
        return result.value.items.length;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    console.info(JSON.stringify(report));
  } finally {
    await native.close();
  }
}, 300_000);

test('native unread counts classify empty, exact-100, capped and retained-frontier states at three scales', async () => {
  const native = await replyNoticeFixture();
  try {
    const recipient = native.accounts.recipient;
    const route = routeOf(recipient)!;
    const path = `/v1/accounts/${recipient}/notifications`;
    const profiles = [
      { name: 'empty', pending: 0, expected: { count: 0, capped: false }, removeMarker: false },
      { name: 'exact-100', pending: 100, expected: { count: 100, capped: false }, removeMarker: false },
      { name: 'capped', pending: 101, expected: { count: 100, capped: true }, removeMarker: false },
      { name: 'retained-frontier', pending: 1, expected: { count: 1, capped: false }, removeMarker: true },
    ] as const;

    for (const profile of profiles) {
      await native.db.admin.query('DELETE FROM content.notice WHERE route=$1 AND recipient_id=$2', [route, recipient]);
      await native.db.admin.query('DELETE FROM content.notice_seen WHERE route=$1 AND account_id=$2', [
        route,
        recipient,
      ]);
      const marker = newId(route);
      await native.db.admin.query(
        `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
         VALUES($1,$2,$3,'reply',$3,'2026-10-02T00:00:00Z')`,
        [route, recipient, marker],
      );
      const marked = await native.call(recipient, 'POST', `${path}:markSeen`, { through: marker });
      expect(marked.status).toBe(204);
      if (profile.removeMarker)
        await native.db.admin.query('DELETE FROM content.notice WHERE route=$1 AND notice_id=$2', [route, marker]);
      if (profile.pending > 0) {
        const ids = Array.from({ length: profile.pending }, () => newId(route));
        await native.db.admin.query(
          `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
           SELECT $1,$2,id,'reply',id,'2026-10-03T00:00:00Z' FROM unnest($3::uuid[]) AS n(id)`,
          [route, recipient, ids],
        );
      }

      const report = await checkGrowth(native.db, {
        name: `Native unread count ${profile.name}`,
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        repetitions: 1,
        warmups: 1,
        grow: async (_db, scale, previous) => {
          const ids = Array.from({ length: scale - previous }, () => newId(route));
          await native.db.admin.query(
            `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
             SELECT $1,$2,id,'moderation_decision',id,'2026-10-01T00:00:00Z'::timestamptz +
                    ordinality * interval '1 millisecond'
             FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
            [route, recipient, ids],
          );
        },
        operation: async () => {
          const result = await native.call(recipient, 'GET', `${path}/count`);
          expect(result.status).toBe(200);
          expect(result.value).toEqual(profile.expected);
          return result.value.count;
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
      console.info(JSON.stringify(report));
    }
  } finally {
    await native.close();
  }
}, 300_000);
