import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { threadTarget } from '../../src/content/commands.ts';
import {
  createRankingWorld,
  requireStatus,
  startRankingWorker,
  type RankingRuntime,
} from './board-ranking-native-convergence-fixture.ts';
import type { ConversationActivitySelection } from '../../src/content/conversation-activity.ts';
import {
  feedActivityLanesForThreads,
  feedActivityReferences,
  projectFeedConversationActivity,
} from '../../src/content/feed-conversation-activity.ts';
import type { FeedItem } from '../../src/content/feed-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

test('Feed binds duplicate Home references once and projects exact, lower-bound and withheld meanings', () => {
  const threadId = '01a1a000-0000-7000-8000-000000000081';
  const review: FeedItem = {
    id: 'review',
    source: 'discovery',
    key: { owner: 'content', kind: 'review', route: 1, id: threadId },
    occurredAt: null,
    summary: { id: threadId, kind: 'review', title: null },
    destination: { kind: 'thread', id: threadId, title: null },
  };
  const thread: FeedItem = {
    id: 'following',
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: 1, id: threadId },
    occurredAt: null,
    summary: { id: threadId, kind: 'discussion', title: null, createdAt: '2026-11-04T00:00:00.000Z' },
    destination: { kind: 'thread', id: threadId, title: null },
  };
  const references = feedActivityReferences([review, thread]);
  expect(references.threadIds).toEqual([threadId]);
  expect(feedActivityLanesForThreads(references, new Set([threadId]))).toEqual(new Set(['discovery', 'following']));

  const populated = {
    threadId,
    status: 'current',
    cohort: 'public',
    replyCount: { kind: 'lower-bound', value: 10_000 },
    lastContributionAt: '2026-11-04T00:00:00.000Z',
    witness: {},
  } as unknown as ConversationActivitySelection;
  projectFeedConversationActivity([review, thread], [populated]);
  expect(review.summary).toHaveProperty('conversationActivity', {
    state: 'current',
    cohort: 'public',
    count: { kind: 'lower-bound', value: 10_000 },
    lastActivityAt: '2026-11-04T00:00:00.000Z',
  });
  expect(thread.summary).toHaveProperty('conversationActivity', review.summary.conversationActivity);

  projectFeedConversationActivity([review, thread], [
    { threadId, status: 'withheld', reason: 'coverage' } as ConversationActivitySelection,
  ]);
  expect(review.summary).toHaveProperty('conversationActivity', { state: 'withheld' });
  expect(thread.summary).toHaveProperty('conversationActivity', { state: 'withheld' });
});

test.serial('Home Feed shows command-created public conversation activity through real Access and delivery', async () => {
  const world = await createRankingWorld();
  let runtime: RankingRuntime | undefined;
  try {
    await world.time(world.start);
    const boardId = await world.board();
    const board = await world.pool.query<{ subject_id: string }>(
      'SELECT subject_id FROM content.board WHERE route=$1 AND board_id=$2',
      [routeOf(boardId), boardId],
    );
    const subjectId = board.rows[0]!.subject_id;
    const follow = await world.call('PUT', `/v1/follows/${subjectId}`, {
      bearer: world.base.other.bearer,
      key: randomUUID(),
    });
    requireStatus(follow, 200);

    const idempotencyKey = randomUUID();
    const target = threadTarget(world.base.system.routeKey, world.base.author.accountId, idempotencyKey);
    const partition = partitionOf(target.route);
    runtime = await startRankingWorker(world, [partition]);
    const created = await world.capture(partition, () =>
      world.command(
        'POST',
        '/v1/threads',
        {
          title: `Home activity ${idempotencyKey}`,
          body: fromPlainText('Opening contribution'),
          licence: 'CC0-1.0',
          subjectIds: [subjectId],
          boardId,
        },
        world.base.author,
        201,
        idempotencyKey,
      ),
    );
    await runtime.consume(created.envelopes);

    const page = await world.call('GET', '/v1/feedItems?stream=home&limit=20', { bearer: world.base.other.bearer });
    requireStatus(page, 200);
    if (!page.value) throw new Error('Home feed response omitted its body');
    const card = page.value.feedItems.find(
      (item: { source: string; key: { owner: string } }) => item.source === 'following' && item.key.owner === 'content',
    );
    expect(card?.summary.conversationActivity).toMatchObject({
      state: 'current',
      cohort: 'public',
      count: { kind: 'exact', value: 0 },
      lastActivityAt: created.value.thread.createdAt,
    });
  } finally {
    await runtime?.stop();
    await world.base.system.close();
  }
});
