import { expect, test } from 'bun:test';
import { markNoticesSeen } from '../../src/content/notice-inbox.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentNoticeEffects } from '../../src/content/relays.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

test('unread summary keeps one visible result as acknowledged and seen prefixes grow', async () => {
  const native = await replyNoticeFixture();
  try {
    const recipient = native.accounts.recipient;
    const route = routeOf(recipient)!;
    const thread = await native.thread();
    const post = await native.post(thread.id);
    const envelope = await native.envelope(post.id);
    const effect = contentNoticeEffects(
      native.db.pool,
      createContentWorkAccess(() => new Date(), native.db.pool),
    ).find((candidate) => candidate.name === 'content_reply_notice');
    expect(effect).toBeDefined();
    await effect!.run(envelope.events.find(Boolean)!);

    for (const [size, previous] of [[256, 0], [4096, 256]] as const) {
      const addedPerKind = (size - previous) / 2;
      const seenIds = Array.from({ length: addedPerKind }, () => newId(route));
      await native.db.admin.query(
        `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
         SELECT $1,$2,id,'moderation_decision',id,
                '2026-10-01T00:00:00Z'::timestamptz + (ordinality + $4) * interval '1 millisecond'
         FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
        [route, recipient, seenIds, previous / 2],
      );
      await markNoticesSeen(native.db.pool, recipient, seenIds.at(-1)!);

      const acknowledgedIds = Array.from({ length: addedPerKind }, () => newId(route));
      await native.db.admin.query(
        `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
         SELECT $1,$2,id,'moderation_decision',id,
                '2026-10-02T00:00:00Z'::timestamptz + (ordinality + $4) * interval '1 millisecond'
         FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
        [route, recipient, acknowledgedIds, previous / 2],
      );
      await native.db.admin.query(
        `INSERT INTO content.notice_ack(route,account_id,notice_id,acknowledged_at)
         SELECT $1,$2,id,now() FROM unnest($3::uuid[]) AS n(id)`,
        [route, recipient, acknowledgedIds],
      );

      const trace = observeSql(native.db.pool);
      try {
        const summary = await native.call(recipient, 'GET', `/v1/accounts/${recipient}/notifications/count`);
        expect(summary.status).toBe(200);
        expect(summary.value).toMatchObject({
          count: 1,
          capped: true,
          basis: 'current-visible-lower-bound',
        });
        expect(trace.records.some((record) => record.statement.includes('WITH raw_candidates AS MATERIALIZED'))).toBe(
          true,
        );
      } finally {
        await trace.close();
      }
    }
  } finally {
    await native.close();
  }
});
