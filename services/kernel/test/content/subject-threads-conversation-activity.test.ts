import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { threadTarget } from '../../src/content/commands.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createRankingWorld,
  plus,
  requireStatus,
  startRankingWorker,
  type RankedThread,
  type RankingRuntime,
} from './board-ranking-native-convergence-fixture.ts';

test.serial('Subject cards keep public reply activity current through edits, removal and restoration', async () => {
  const world = await createRankingWorld();
  let runtime: RankingRuntime | undefined;
  try {
    await world.time(world.start);
    const boardId = await world.board();
    const board = await world.pool.query<{ realm_id: string; subject_id: string }>(
      'SELECT realm_id,subject_id FROM content.board WHERE route=$1 AND board_id=$2',
      [routeOf(boardId), boardId],
    );
    const { realm_id: realmId, subject_id: subjectId } = board.rows[0]!;
    const idempotencyKey = randomUUID();
    const target = threadTarget(world.base.system.routeKey, world.base.author.accountId, idempotencyKey);
    const partition = partitionOf(target.route);
    runtime = await startRankingWorker(world, [partition]);
    const created = await world.capture(partition, () =>
      world.command(
        'POST',
        '/v1/threads',
        {
          title: `Conversation activity ${idempotencyKey}`,
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
    const thread: RankedThread = {
      id: created.value.thread.id,
      postId: created.value.thread.firstPost.id,
      boardId,
      createdAt: created.value.thread.createdAt,
      activityAt: created.value.thread.createdAt,
      score: 0,
      reactions: {},
    };
    const read = async () => {
      const result = await world.call(
        'GET',
        `/v1/subjects/${subjectId}/threads?${new URLSearchParams({ place: realmId, kind: 'discussion' })}`,
        { bearer: world.base.author.bearer },
      );
      requireStatus(result, 200);
      if (!result.value) throw new Error('Subject threads response omitted its body');
      const card = result.value.threads.find((entry: { id: string }) => entry.id === thread.id)?.card;
      expect(card).toBeDefined();
      return card.comments;
    };

    expect(await read()).toMatchObject({
      state: 'current',
      cohort: 'public',
      count: { kind: 'exact', value: 0 },
      lastActivityAt: thread.createdAt,
    });
    const first = await world.reply(thread, world.base.author, plus(world.start, 1));
    await runtime.consume(first.envelopes);
    const second = await world.reply(thread, world.base.author, plus(world.start, 2));
    await runtime.consume(second.envelopes);
    expect(await read()).toMatchObject({
      state: 'current',
      count: { kind: 'exact', value: 2 },
      lastActivityAt: second.value.post.createdAt,
    });

    await world.time(plus(world.start, 3));
    const edit = await world.capture(partition, () =>
      world.command(
        'POST',
        `/v1/posts/${first.value.post.id}/revisions`,
        { body: fromPlainText('Earlier reply edited'), licence: 'CC0-1.0', subjectIds: [subjectId] },
        world.base.author,
      ),
    );
    await runtime.consume(edit.envelopes);
    expect(await read()).toMatchObject({
      count: { kind: 'exact', value: 2 },
      lastActivityAt: second.value.post.createdAt,
    });

    const removed = await world.capture(partition, () =>
      world.call('DELETE', `/v1/posts/${second.value.post.id}`, {
        bearer: world.base.author.bearer,
        key: randomUUID(),
      }),
    );
    requireStatus(removed.value, 204);
    await runtime.consume(removed.envelopes);
    expect(await read()).toMatchObject({
      count: { kind: 'exact', value: 1 },
      lastActivityAt: first.value.post.createdAt,
    });

    const restored = await world.capture(partition, () =>
      world.call('POST', `/v1/posts/${second.value.post.id}:restore`, {
        bearer: world.base.author.bearer,
        key: randomUUID(),
      }),
    );
    requireStatus(restored.value, 204);
    await runtime.consume(restored.envelopes);
    expect(await read()).toMatchObject({
      count: { kind: 'exact', value: 2 },
      lastActivityAt: second.value.post.createdAt,
    });
  } finally {
    await runtime?.stop();
    await world.base.system.close();
  }
});
