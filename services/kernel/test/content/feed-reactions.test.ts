import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { Actor } from '../../src/request/access.ts';
import type { FeedItem } from '../../src/content/feed-contract.ts';
import { prepareFeedReactionAdvice } from '../../src/content/feed-reaction-advice.ts';
import { feedRoute } from '../../src/content/feed-activity.ts';
import { newId } from '../../src/route/route.ts';

test('reaction advice preserves duplicate Home occurrences and drops a post rebound to another parent', async () => {
  const pool = new Pool();
  try {
    const threadId = newId(0);
    const postId = newId(0);
    const parentId = newId(0);
    const otherParentId = newId(0);
    const target = { targetKind: 'post', targetId: postId } as const;
    const row: FeedItem = {
      id: `following:${postId}`,
      source: 'following',
      occurredAt: null,
      key: { owner: 'content', kind: 'post', route: feedRoute(threadId), id: postId },
      summary: {
        id: postId,
        threadId,
        title: null,
        createdAt: '2026-11-04T00:00:00.000Z',
        parentContext: { kind: 'reply', parent: { state: 'removed', id: parentId } },
        reactionAdvice: { target, state: 'current', allowed: [] },
      },
      destination: { kind: 'post', id: postId, postId, threadId, title: null },
    };
    const duplicate: FeedItem = { ...row, id: `${row.id}:duplicate` };
    const contexts = new Map([
      [row.id, JSON.stringify({ threadId, parentId, place: 'global' })],
      [duplicate.id, JSON.stringify({ threadId, parentId, place: 'global' })],
    ]);
    const actor: Actor = { kind: 'anonymous' };
    const prepared = prepareFeedReactionAdvice([row, duplicate], contexts, { pool }, actor, Date.now() + 10_000);
    const admitted = await prepared.finish(prepared.items);
    expect(admitted.map((item) => item.id)).toEqual([row.id, duplicate.id]);
    for (const item of admitted)
      expect(item.summary).toMatchObject({
        parentContext: { kind: 'reply', parent: { id: parentId } },
        reactionAdvice: { target, state: 'unavailable' },
      });

    const reboundPreparation = prepareFeedReactionAdvice([duplicate], contexts, { pool }, actor, Date.now() + 10_000);
    const preparedRow = reboundPreparation.items[0];
    if (!preparedRow) throw new Error('Prepared post card missing');
    const rebound = {
      ...preparedRow,
      summary: {
        ...preparedRow.summary,
        parentContext: { kind: 'reply', parent: { state: 'removed', id: otherParentId } },
      },
    } satisfies FeedItem;
    const stale = await reboundPreparation.finish([rebound]);
    expect(stale[0]?.summary).not.toHaveProperty('reactionAdvice');
  } finally {
    await pool.end();
  }
});
