import { expect, test } from 'bun:test';
import { withQueryAccounting } from '../../src/database/pool.ts';
import { markNoticesSeen } from '../../src/content/notice-inbox.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentNoticeEffects } from '../../src/content/relays.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

test('unread summary skips growing acknowledged and seen prefixes before its candidate limit', async () => {
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
      `UPDATE content.notice SET created_at='2026-10-01T00:10:00.000629Z'::timestamptz
       WHERE route=$1 AND recipient_id=$2 AND kind='reply' AND source_id=$3 RETURNING notice_id`,
      [route, recipient, post.id],
    );
    expect(reply.rows).toHaveLength(1);

    for (const [size, previous] of [
      [256, 0],
      [4096, 256],
    ] as const) {
      const added = (size - previous) / 2;
      const seen = Array.from({ length: added }, () => newId(route));
      const acknowledged = Array.from({ length: added }, () => newId(route));
      await native.db.admin.query(
        `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
         SELECT $1::integer,$2::uuid,id,'moderation_decision',id,
                '2026-10-01T00:00:00Z'::timestamptz + (ordinality + $5) * interval '1 millisecond'
         FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)
         UNION ALL
         SELECT $1::integer,$2::uuid,id,'moderation_decision',id,
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
        capped: false,
        basis: 'current-visible-unread',
      });
    }
    // No instant permits an empty count: the unread reply exists until the same
    // writer transaction fences the viewer and acknowledges it. The starting
    // snapshot still sees the reply, and the post-hydration viewer check refuses it.
    let crossed = false;
    let retained = 0;
    const revoked = await withQueryAccounting(
      {
        connection: (dispatch) => dispatch(),
        async query(sql, _operands, dispatch) {
          if (crossed || !sql.includes('WITH frontier AS MATERIALIZED')) return dispatch();
          crossed = true;
          await native.db.admin.query(
            `WITH fenced AS (
             UPDATE access.account SET authn_fenced=true WHERE (route,account_id)=($1,$2)
             RETURNING route,account_id
           )
           INSERT INTO content.notice_ack(route,account_id,notice_id) SELECT route,account_id,$3 FROM fenced`,
            [route, recipient, reply.rows[0]!.notice_id],
          );
          const result = await dispatch();
          retained = (result as { rows: unknown[] }).rows.length;
          return result;
        },
      },
      () => native.call(recipient, 'GET', `/v1/accounts/${recipient}/notifications/count`),
    );
    expect(crossed).toBe(true);
    expect(retained).toBe(1);
    expect(revoked.status).toBe(404);
    await native.db.admin.query('UPDATE access.account SET authn_fenced=false WHERE (route,account_id)=($1,$2)', [
      route,
      recipient,
    ]);

    await markNoticesSeen(native.db.pool, recipient, reply.rows[0]!.notice_id);
    const seen = await native.call(recipient, 'GET', `/v1/accounts/${recipient}/notifications/count`);
    expect(seen.status).toBe(200);
    expect(seen.value).toMatchObject({ count: 0, capped: false, basis: 'current-visible-unread' });
  } finally {
    await native.close();
  }
});
