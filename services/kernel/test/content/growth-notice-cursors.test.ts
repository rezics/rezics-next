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

test('native seen-marker advancing, retained-frontier and foreign points stay bounded under separate recipient pressure', async () => {
  const f = await replyNoticeFixture();
  try {
    const recipient = f.accounts.recipient;
    const other = f.accounts.principal;
    const recipientRoute = routeOf(recipient)!;
    const path = `/v1/accounts/${recipient}/notifications:markSeen`;
    const profiles = ['advancing', 'retained-frontier', 'foreign'] as const;
    for (const pressure of ['recipient', 'other-recipient'] as const) {
      for (const profile of profiles) {
        await f.db.admin.query(
          'DELETE FROM content.notice WHERE source_id=notice_id AND recipient_id=ANY($1::uuid[])',
          [[recipient, other]],
        );
        await f.db.admin.query('DELETE FROM content.notice_seen WHERE account_id=ANY($1::uuid[])', [[recipient, other]]);
        const older = newId(recipientRoute);
        const newer = newId(recipientRoute);
        const foreign = newId(routeOf(other)!);
        await f.db.admin.query(
          `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
           VALUES($1,$2,$3,'reply',$3,'2026-10-02T00:00:00Z'),
                 ($1,$2,$4,'reply',$4,'2026-10-03T00:00:00Z'),
                 ($5,$6,$7,'reply',$7,'2026-10-03T00:00:00Z')`,
          [recipientRoute, recipient, older, newer, routeOf(other), other, foreign],
        );
        const pressureRecipient = pressure === 'recipient' ? recipient : other;
        const pressureRoute = routeOf(pressureRecipient)!;
        const report = await checkGrowth(f.db, {
          name: `Native seen marker ${profile}, ${pressure} history`,
          scales: [256, 1024, 4096],
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          repetitions: 1,
          warmups: 1,
          grow: async (_db, scale, previous) => {
            const ids = Array.from({ length: scale - previous }, () => newId(pressureRoute));
            await f.db.admin.query(
              `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
               SELECT $1,$2,id,'moderation_decision',id,'2026-10-01T00:00:00Z'::timestamptz +
                      ordinality * interval '1 millisecond'
               FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
              [pressureRoute, pressureRecipient, ids],
            );
          },
          warmup: async () => {
            const result = await f.call(recipient, 'GET', `/v1/accounts/${recipient}/notifications/count`);
            expect(result.status).toBe(200);
          },
          prepare: async () => {
            await f.db.admin.query('DELETE FROM content.notice_seen WHERE route=$1 AND account_id=$2', [
              recipientRoute,
              recipient,
            ]);
            const through = profile === 'retained-frontier' ? newer : older;
            const result = await f.call(recipient, 'POST', path, { through });
            expect(result.status).toBe(204);
          },
          operation: async () => {
            const through = profile === 'advancing' ? newer : profile === 'retained-frontier' ? older : foreign;
            const result = await f.call(recipient, 'POST', path, { through });
            expect(result.status).toBe(profile === 'foreign' ? 404 : 204);
            return result.status;
          },
        });
        expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
        console.info(JSON.stringify(report));
      }
    }
  } finally {
    await f.close();
  }
}, 300_000);

test('a current full-chain denial keeps advancing through sparse native inbox pages under content and Access history', async () => {
  const f = await replyNoticeFixture();
  try {
    const recipient = f.accounts.recipient;
    const thread = await f.thread();
    const root = await f.post(thread.id, recipient);
    let target = root;
    // The selected post plus these 32 parents reaches the admitted ancestry bound.
    for (let depth = 0; depth < 32; depth++) target = await f.post(thread.id, f.accounts.actor, target.id);
    const route = routeOf(thread.id)!;
    const accountRoute = routeOf(recipient)!;
    const noticeIds = Array.from({ length: 10 }, () => newId(accountRoute));
    await f.db.admin.query(
      `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,thread_id,post_id,created_at)
       SELECT $1,$2,id,'reply',id,$3,$4,'2026-10-03T00:00:00Z'::timestamptz +
              ordinality * interval '1 millisecond'
       FROM unnest($5::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
      [accountRoute, recipient, thread.id, target.id, noticeIds],
    );
    await f.db.admin.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
       VALUES($1,$2,$3,'post:read','resource','(,)',$3)`,
      [routeOf(root.id), root.id, recipient],
    );
    const sourcePost = (
      await f.db.admin.query<{ author_account_id: string }>(
        'SELECT author_account_id FROM content.post WHERE route=$1 AND thread_id=$2 AND post_id=$3',
        [route, thread.id, root.id],
      )
    ).rows[0]!;
    const sourceRevision = (
      await f.db.admin.query<{ body: Uint8Array; body_sha256: Uint8Array; board_id: string }>(
        'SELECT body,body_sha256,board_id FROM content.revision WHERE route=$1 AND thread_id=$2 AND post_id=$3',
        [route, thread.id, root.id],
      )
    ).rows[0]!;
    const contentPressure: string[] = [];
    const accessPressure: string[] = [];
    const growContent = async (scale: number, previous: number) => {
      const count = scale - previous;
      const postIds = Array.from({ length: count }, () => newId(route));
      const revisionIds = postIds.map(() => newId(route));
      contentPressure.push(...postIds);
      await f.db.admin.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,
                                 security_revision,recorded_transaction_id)
         SELECT $1,$2,posts.post_id,$4,posts.revision_id,'published',1,posts.post_id
         FROM unnest($3::uuid[],$5::uuid[]) AS posts(post_id,revision_id)`,
        [route, thread.id, postIds, sourcePost.author_account_id, revisionIds],
      );
      await f.db.admin.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,
                                      subject_ids,board_id,availability,recorded_transaction_id)
         SELECT $1,$2,posts.post_id,posts.revision_id,$4,$5,'','MIT','{}',$6,'available',posts.post_id
         FROM unnest($3::uuid[],$7::uuid[]) AS posts(post_id,revision_id)`,
        [route, thread.id, postIds, sourceRevision.body, sourceRevision.body_sha256, sourceRevision.board_id, revisionIds],
      );
    };
    const exercise = async (history: 'content' | 'access') => {
      const report = await checkGrowth(f.db, {
        name: `Native denied sparse inbox through full ancestry with ${history} history`,
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        repetitions: 1,
        warmups: 1,
        grow: async (_db, scale, previous) => {
          if (history === 'content') await growContent(scale, previous);
          else {
            const ids = Array.from({ length: scale - previous }, () => newId(route));
            accessPressure.push(...ids);
            await f.db.admin.query(
              `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
               SELECT $1,id,$2,'post:read','(,)',$2 FROM unnest($3::uuid[]) AS resources(id)
               ON CONFLICT DO NOTHING`,
              [route, recipient, ids],
            );
          }
        },
        operation: async () => {
          let cursor: string | null = null;
          const visited = new Set<string>();
          let pages = 0;
          do {
            const query = cursor === null ? '?limit=1' : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
            const result = await f.call(recipient, 'GET', `/v1/accounts/${recipient}/notifications${query}`);
            expect(result.status).toBe(200);
            expect(result.value.items).toEqual([]);
            pages++;
            cursor = result.value.next as string | null;
            if (cursor !== null) {
              expect(visited.has(cursor)).toBe(false);
              visited.add(cursor);
            }
          } while (cursor !== null);
          expect(pages).toBeGreaterThan(1);
          return pages;
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
      console.info(JSON.stringify(report));
    };
    await exercise('content');
    await exercise('access');
    await f.db.admin.query('DELETE FROM content.notice WHERE recipient_id=$1 AND post_id=$2', [recipient, target.id]);
    await f.db.admin.query('DELETE FROM access.resource_denial WHERE resource_id=$1 AND subject_id=$2', [
      root.id,
      recipient,
    ]);
    if (contentPressure.length > 0) {
      await f.db.admin.query('DELETE FROM content.revision WHERE route=$1 AND post_id=ANY($2::uuid[])', [
        route,
        contentPressure,
      ]);
      await f.db.admin.query('DELETE FROM content.post WHERE route=$1 AND post_id=ANY($2::uuid[])', [
        route,
        contentPressure,
      ]);
    }
    if (accessPressure.length > 0)
      await f.db.admin.query('DELETE FROM access.resource_grant WHERE resource_id=ANY($1::uuid[])', [accessPressure]);
  } finally {
    await f.close();
  }
}, 300_000);
