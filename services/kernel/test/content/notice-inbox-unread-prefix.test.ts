import { expect, test } from 'bun:test';
import { markNoticesSeen } from '../../src/content/notice-inbox.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentNoticeEffects } from '../../src/content/relays.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

test('unread summary bounds growing same-recipient acknowledged and seen prefixes', async () => {
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
    const reply = await native.db.admin.query<{ notice_id: string }>(
      `UPDATE content.notice SET created_at='2026-10-01T00:10:00Z'::timestamptz
       WHERE route=$1 AND recipient_id=$2 AND kind='reply' AND source_id=$3 RETURNING notice_id`,
      [route, recipient, post.id],
    );
    expect(reply.rows).toHaveLength(1);

    for (const [size, previous] of [[256, 0], [4096, 256]] as const) {
      const added = (size - previous) / 2;
      const seen = Array.from({ length: added }, () => newId(route));
      const acknowledged = Array.from({ length: added }, () => newId(route));
      await native.db.admin.query(
        `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
         SELECT $1,$2,id,'moderation_decision',id,
                '2026-10-01T00:00:00Z'::timestamptz + (ordinality + $5) * interval '1 millisecond'
         FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)
         UNION ALL
         SELECT $1,$2,id,'moderation_decision',id,
                '2026-10-02T00:00:00Z'::timestamptz + (ordinality + $5) * interval '1 millisecond'
         FROM unnest($4::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
        [route, recipient, seen, acknowledged, previous / 2],
      );
      await markNoticesSeen(native.db.pool, recipient, seen.at(-1)!);
      await native.db.admin.query(
        `INSERT INTO content.notice_ack(route,account_id,notice_id,acknowledged_at)
         SELECT $1,$2,id,now() FROM unnest($3::uuid[]) AS n(id)`,
        [route, recipient, acknowledged],
      );

      const summary = await native.call(recipient, 'GET', `/v1/accounts/${recipient}/notifications/count`);
      expect(summary.status).toBe(200);
      expect(summary.value).toMatchObject({
        count: 1,
        capped: size === 4096,
        basis: size === 4096 ? 'current-visible-lower-bound' : 'current-visible-unread',
      });
    }
  } finally {
    await native.close();
  }
});
