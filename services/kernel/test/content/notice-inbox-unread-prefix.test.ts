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
    const reply = await native.db.admin.query<{ notice_id: string }>(
      `SELECT notice_id FROM content.notice
       WHERE route=$1 AND recipient_id=$2 AND kind='reply' AND source_id=$3`,
      [route, recipient, post.id],
    );
    expect(reply.rows).toHaveLength(1);
    await native.db.admin.query(
      'UPDATE content.notice SET created_at=$3 WHERE route=$1 AND notice_id=$2',
      [route, reply.rows[0]!.notice_id, new Date('2026-10-01T00:10:00Z')],
    );

    const candidateStatements: string[] = [];
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
          capped: size === 4096,
          basis: size === 4096 ? 'current-visible-lower-bound' : 'current-visible-unread',
        });
        candidateStatements.push(
          trace.records.find((record) => record.statement.includes('FROM content.notice AS n'))?.statement ?? '',
        );
      } finally {
        await trace.close();
      }
    }
    expect(candidateStatements.every((statement) => statement.includes('WITH raw_candidates AS MATERIALIZED'))).toBe(
      true,
    );

    const trace = observeSql(native.db.pool);
    try {
      const path = `/v1/accounts/${recipient}/notifications?limit=1`;
      const first = await native.call(recipient, 'GET', path);
      expect(first.status).toBe(200);
      expect(first.value.next).toEqual(expect.any(String));
      const resumed = await native.call(
        recipient,
        'GET',
        `${path}&cursor=${encodeURIComponent(first.value.next)}`,
      );
      expect(resumed.status).toBe(200);
      const pages = trace.records.filter(
        (record) => record.statement.includes('FROM content.notice AS n') && record.statement.includes('DESC LIMIT'),
      );
      expect(pages).toHaveLength(2);
      expect(pages[0]!.statement).not.toContain('NOT $3::boolean');
      expect(pages[1]!.statement).toContain('(n.created_at,n.notice_id) < ($3::timestamptz,$4::uuid)');
    } finally {
      await trace.close();
    }
  } finally {
    await native.close();
  }
});
