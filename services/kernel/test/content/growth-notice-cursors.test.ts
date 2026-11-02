import { expect, test } from 'bun:test';
import { createReplyNoticeEffect } from '../../src/content/reply-notices.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth } from '../support/growth.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

test('native empty, private, deep and sparse inbox pages and owned seen retries stay bounded', async () => {
  const f = await replyNoticeFixture();
  try {
    const recipient = f.accounts.recipient;
    const route = routeOf(recipient)!;
    const thread = await f.thread();
    const effect = createReplyNoticeEffect(f.db.pool, f.accounts.access);
    for (let i = 0; i < 8; i++) {
      const post = await f.post(thread.id);
      await effect.run((await f.envelope(post.id)).events.find(Boolean)!);
      expect(await f.notices(post.id)).toHaveLength(1);
    }
    const path = `/v1/accounts/${recipient}/notifications`;
    const first = await f.call(recipient, 'GET', `${path}?limit=1`);
    expect(first.status).toBe(200);
    expect(first.value.items).toHaveLength(1);
    expect(typeof first.value.next).toBe('string');
    const cursor = first.value.next as string;
    const through = first.value.items[0].id as string;
    const deepPath = `${path}?limit=1&cursor=${encodeURIComponent(cursor)}`;
    const selected = await f.call(recipient, 'GET', deepPath);
    expect(selected.status).toBe(200);
    expect(selected.value.items).toHaveLength(1);
    const expected = selected.value.items[0].id as string;
    const background = newId(route);
    const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
    const jobs = ['empty', 'private', 'deep', 'sparse', 'seen'] as const;
    for (const pressure of ['recipient', 'other-recipient'] as const) {
      for (const job of jobs) {
        if (job === 'sparse') {
          await f.db.admin.query(
            `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
           VALUES($1,$2,$3,'board:read','resource','(,)',$3)`,
            [routeOf(f.boardId), f.boardId, recipient],
          );
        }
        const report = await checkGrowth(f.db, {
          name: `Native notice inbox ${job}, ${pressure} history`,
          scales: [256, 1024, 4096],
          bounds,
          repetitions: 1,
          warmups: 1,
          grow: async (_db, scale, previous) => {
            const ids = Array.from({ length: scale - previous }, () => newId(route));
            // Pressure only: production effects above create every asserted notice.
            // Newer recipient history makes the saved cursor progressively deeper;
            // other-recipient history is grown in a separate profile.
            for (const account of [pressure === 'recipient' ? recipient : background])
              await f.db.admin.query(
                `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
               SELECT $1,$2,id,'moderation_decision',id,$4::timestamptz
               FROM unnest($3::uuid[]) AS n(id)`,
                [route, account, ids, new Date(Date.now() + 60_000).toISOString()],
              );
          },
          operation: async () => {
            if (job === 'seen') {
              // The native request includes authentication, admission, partition
              // custody and the atomic forward-only marker, even on a retry.
              const result = await f.call(recipient, 'POST', `${path}:markSeen`, { through });
              expect(result.status).toBe(204);
              return through;
            }
            const actor = job === 'empty' || job === 'private' ? f.accounts.principal : recipient;
            const url = job === 'empty' ? `/v1/accounts/${actor}/notifications` : job === 'private' ? path : deepPath;
            const result = await f.call(actor, 'GET', url);
            expect(result.status).toBe(job === 'private' ? 404 : 200);
            if (job === 'empty' || job === 'sparse') {
              expect(result.value.items).toEqual([]);
              if (job === 'sparse') {
                expect(typeof result.value.next).toBe('string');
                expect(result.value.next).not.toBe(cursor);
              } else expect(result.value.next).toBeNull();
            }
            if (job === 'deep') expect(result.value.items.map((item: { id: string }) => item.id)).toEqual([expected]);
            return result.status;
          },
        });
        expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
        for (const sample of report.samples) {
          expect(sample.cost.statements).toBeGreaterThan(0);
          expect(sample.cost.rows).toBeGreaterThan(0);
        }
        console.info(JSON.stringify(report));
        await f.db.admin.query(
          'DELETE FROM content.notice WHERE route=$1 AND recipient_id=ANY($2::uuid[]) AND source_id=notice_id',
          [route, [recipient, background]],
        );
        if (job === 'sparse')
          await f.db.admin.query('DELETE FROM access.resource_denial WHERE resource_id=$1 AND subject_id=$2', [
            f.boardId,
            recipient,
          ]);
      }
    }
  } finally {
    await f.close();
  }
}, 300_000);
