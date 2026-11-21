import { expect, test } from 'bun:test';
import { createFeedActivityStore, type ActivityRef } from '../../src/content/feed-activity.ts';
import { expireFeedPage } from '../../src/content/feed-work.ts';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth-capture.ts';

test('feed retention elects due homes, resumes original continuations and only publishes actual expirations', async () => {
  const db = await openGrowthDatabase();
  const first = 673,
    second = 3661;
  const outbox = async () =>
    (
      await db.admin.query<{ partition_no: number }>(
        "SELECT partition_no FROM core.outbox WHERE type='com.rezics.content.feed.expired.v1' AND partition_no=ANY($1::integer[]) ORDER BY partition_no,position,event_seq",
        [[first, second]],
      )
    ).rows.map((row) => row.partition_no);
  const seeds: [string, string][] = [];
  const store = createFeedActivityStore({
    pool: db.pool,
    clock: () => new Date(),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(74)]]) },
  });
  const seed = async (home: number, family: 'activity' | 'inbox', count: number, at: string, present = false) => {
    const route = home * 16,
      id = newId(route),
      target = family === 'activity' ? id : newId(route);
    seeds.push([family, id]);
    const references: ActivityRef[] = Array.from({ length: count }, (_, index) => ({
      id: `${home}.1.${index + 1}.0:subject:${target}`,
      source: { partition: home, epoch: 1, position: String(index + 1), eventIndex: 0 },
      occurredAt: new Date(at).toISOString(),
      target: { type: 'subject', id: target },
      object: { owner: 'content', kind: 'thread', id: target, threadId: target, route },
    }));
    if (present) {
      for (const ref of references) await store.recordTargetActivity(ref, Date.now() + 5000);
    } else if (family === 'activity') {
      await db.admin.query(
        `INSERT INTO content.feed_activity(route,target_type,target_id,activity_id,occurred_at,activity)
        SELECT $1,'subject',$2,r->>'id',(r->>'occurredAt')::timestamptz,r FROM jsonb_array_elements($3::jsonb) r`,
        [route, id, JSON.stringify(references)],
      );
    } else {
      await db.admin.query(
        `INSERT INTO content.feed_inbox(route,account_id,activity_id,occurred_at,activity)
        SELECT $1,$2,r->>'id',(r->>'occurredAt')::timestamptz,r FROM jsonb_array_elements($3::jsonb) r`,
        [route, id, JSON.stringify(references)],
      );
    }
    return { id, references };
  };
  const rows = async (family: 'activity' | 'inbox', home: number) => {
    const keys = seeds.filter(([kind]) => family === kind).map(([, id]) => id);
    const result =
      family === 'activity'
        ? await db.admin.query(
            'SELECT count(*)::int AS n FROM content.feed_activity WHERE partition_no=$1 AND target_id=ANY($2::uuid[])',
            [home, keys],
          )
        : await db.admin.query(
            'SELECT count(*)::int AS n FROM content.feed_inbox WHERE partition_no=$1 AND account_id=ANY($2::uuid[])',
            [home, keys],
          );
    return result.rows[0].n;
  };
  try {
    const before = await outbox();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const target = await seed(first, 'activity', 1, recent, true);
    const recipient = await seed(second, 'inbox', 1, recent);
    expect(await expireFeedPage(db.pool, -1)).toBeNull();
    expect(await expireFeedPage(db.pool, first)).toBeNull();

    await seed(first, 'inbox', 129, '2000-01-01');
    await seed(first, 'activity', 130, '2001-01-01');
    await seed(second, 'activity', 1, '2002-01-01');
    expect(await expireFeedPage(db.pool, -1)).toEqual({ after: -1, current: first });
    expect(await rows('inbox', first)).toBe(1);
    expect(await rows('activity', first)).toBe(3);
    expect(await expireFeedPage(db.pool, -1, first)).toEqual({ after: -1 });
    expect(await rows('activity', first)).toBe(1);
    expect(await rows('inbox', first)).toBe(0);
    // A previously recorded ordered continuation retains its exact next home.
    expect(await expireFeedPage(db.pool, second - 2)).toEqual({ after: second - 1 });
    expect(await expireFeedPage(db.pool, second - 1)).toEqual({ after: second });
    expect(await rows('activity', second)).toBe(0);
    expect(await rows('inbox', second)).toBe(1);
    expect(await expireFeedPage(db.pool, second)).toBeNull();
    expect(await expireFeedPage(db.pool, -1)).toBeNull();
    // A later sweep discovers an already visited home even following an empty page.
    await seed(first, 'inbox', 1, '2003-01-01');
    const concurrent = await Promise.all([expireFeedPage(db.pool, -1), expireFeedPage(db.pool, -1)]);
    expect(concurrent).toContainEqual({ after: -1 });
    expect(await expireFeedPage(db.pool, -1)).toBeNull();
    expect(
      (await store.pageTargetActivity({ type: 'subject', id: target.id }, { limit: 10 }, Date.now() + 5000)).activities,
    ).toEqual(target.references);
    expect((await store.pageFollowingActivity(recipient.id, { limit: 10 }, Date.now() + 5000)).activities).toEqual(
      recipient.references,
    );
    expect(await outbox()).toEqual([...before, first, first, first, second].sort((a, b) => a - b));
  } finally {
    for (const [family, id] of seeds) {
      if (family === 'activity') await db.admin.query('DELETE FROM content.feed_activity WHERE target_id=$1', [id]);
      else await db.admin.query('DELETE FROM content.feed_inbox WHERE account_id=$1', [id]);
    }
    await db.close();
  }
});
