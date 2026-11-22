import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import {
  createConversationActivityBatch,
  createConversationActivityEffect,
  repairConversationActivityPage,
  readConversationActivitySources,
  toConversationActivityReplyCount,
} from '../../src/content/conversation-activity.ts';
import { pendingConversationActivityHomes } from '../../src/content/conversation-activity-repair.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createRankingWorld,
  plus,
  requireStatus,
  startRankingWorker,
  type RankingRuntime,
} from './board-ranking-native-convergence-fixture.ts';

test.serial(
  'native contribution episodes retain publication time through edits, removal, restoration and replay',
  async () => {
    const world = await createRankingWorld();
    let runtime: RankingRuntime | undefined;
    try {
      const boardId = await world.board();
      const boardHome = partitionOf(routeOf(boardId)!);
      const actorHomes = [world.base.author, world.base.other].map(({ accountId }) => partitionOf(routeOf(accountId)!));
      let threadHome = (boardHome + 1) % 4096;
      while (actorHomes.includes(threadHome)) threadHome = (threadHome + 1) % 4096;
      const created = await world.thread(boardId, world.start, threadHome);
      const thread = created.thread;
      const partition = partitionOf(routeOf(thread.id)!);
      let emptyHome = (partition + 1) % 4096;
      while (actorHomes.includes(emptyHome) || emptyHome === boardHome) emptyHome = (emptyHome + 1) % 4096;
      const due = () => pendingConversationActivityHomes(world.pool, [emptyHome, partition], Date.now() + 30_000);
      expect(await due()).toContain(emptyHome);
      await repairConversationActivityPage(world.pool, emptyHome, Date.now() + 30_000);
      expect(await due()).not.toContain(emptyHome);
      const frontierVersion = async () =>
        (
          await world.pool.query(
            'SELECT xmin::text,xmax::text,ctid::text FROM content.conversation_activity_repair_frontier WHERE partition_no=$1',
            [emptyHome],
          )
        ).rows;
      const initial = await frontierVersion();
      expect(initial).toHaveLength(1);
      const idle = await Promise.all(
        Array.from({ length: 8 }, () => repairConversationActivityPage(world.pool, emptyHome, Date.now() + 30_000)),
      );
      expect(idle).toEqual(
        Array(8).fill({
          partition: emptyHome,
          kind: 'idle',
          scannedThreads: 0,
          repairedPosts: 0,
          completedThreads: 0,
          sourceComplete: true,
          more: false,
        }),
      );
      expect(await frontierVersion()).toEqual(initial);
      runtime = await startRankingWorker(world, [partition]);
      await runtime.consume(created.envelopes);
      const source = async () =>
        (await readConversationActivitySources(world.pool, [thread.id], Date.now() + 30_000))[0]!;
      const activity = createConversationActivityBatch(world.pool);
      const current = async () => {
        for (let page = 0; page < 10; page++) {
          await repairConversationActivityPage(world.pool, partition, Date.now() + 30_000);
          const result = (await activity.select([thread.id], Date.now() + 30_000))[0]!;
          if (result.status === 'current') return result;
        }
        throw new Error('Conversation activity repair did not converge');
      };
      const opening = await current();
      expect(opening).toMatchObject({
        status: 'current',
        cohort: 'public',
        replyCount: { kind: 'exact', value: 0 },
        lastContributionAt: plus(world.start, 0),
      });
      expect((await source()).contributions.map(({ postId }) => postId)).toEqual([thread.postId]);

      const first = await world.reply(thread, world.base.author, plus(world.start, 1));
      await runtime.consume(first.envelopes);
      const second = await world.reply(thread, world.base.author, plus(world.start, 2));
      // Lifecycle delivery may precede the publication event. It must not invent a timestamp.
      const effect = createConversationActivityEffect(world.pool);
      const latestEvents = second.envelopes
        .flatMap(({ events }) => events)
        .filter(({ type }) => effect.types.includes(type));
      for (const event of [...latestEvents].reverse()) await effect.run(event);
      await runtime.consume(second.envelopes);
      const full = (await source()).contributions;
      expect(full.map(({ postId }) => postId)).toEqual([second.value.post.id, first.value.post.id, thread.postId]);
      expect(full[0]!.contributedAt).toBe(plus(world.start, 2));
      expect(full[2]!.opening).toBe(true);
      expect(full.slice(0, 2).every(({ opening }) => !opening)).toBe(true);
      expect((await activity.select([thread.id], Date.now() + 30_000))[0]).toMatchObject({
        status: 'current',
        replyCount: { kind: 'exact', value: 2 },
        lastContributionAt: plus(world.start, 2),
      });
      const populated = await current();
      expect(populated).toMatchObject({
        status: 'current',
        replyCount: { kind: 'exact', value: 2 },
        lastContributionAt: plus(world.start, 2),
      });

      await world.time(plus(world.start, 3));
      const edited = await world.capture(partition, () =>
        world.command(
          'POST',
          `/v1/posts/${first.value.post.id}/revisions`,
          {
            body: fromPlainText('Old wording corrected'),
            licence: 'CC0-1.0',
            subjectIds: [],
          },
          world.base.author,
          200,
        ),
      );
      await runtime.consume(edited.envelopes);
      expect((await source()).contributions).toEqual(full);
      expect((await activity.select([thread.id], Date.now() + 30_000))[0]!.status).toBe('current');
      expect((await current()).lastContributionAt).toBe(plus(world.start, 2));

      const erased = await world.capture(partition, async () => {
        const result = await world.call('DELETE', `/v1/posts/${second.value.post.id}`, {
          bearer: world.base.author.bearer,
          key: crypto.randomUUID(),
        });
        requireStatus(result, 204);
      });
      await runtime.consume(erased.envelopes);
      expect((await source()).contributions.map(({ postId }) => postId)).toEqual([first.value.post.id, thread.postId]);
      expect((await activity.confirm([populated], Date.now() + 30_000))[0]!.status).toBe('withheld');
      expect((await activity.select([thread.id], Date.now() + 30_000))[0]).toMatchObject({
        status: 'current',
        replyCount: { kind: 'exact', value: 1 },
        lastContributionAt: plus(world.start, 1),
      });
      expect(await current()).toMatchObject({
        status: 'current',
        replyCount: { kind: 'exact', value: 1 },
        lastContributionAt: plus(world.start, 1),
      });
      // Delayed publication cannot re-admit a now erased episode.
      for (const event of latestEvents) await effect.run(event);
      expect((await source()).contributions.map(({ postId }) => postId)).toEqual([first.value.post.id, thread.postId]);

      const restored = await world.capture(partition, async () => {
        const result = await world.call('POST', `/v1/posts/${second.value.post.id}:restore`, {
          bearer: world.base.author.bearer,
          key: crypto.randomUUID(),
        });
        requireStatus(result, 204);
      });
      await runtime.consume(restored.envelopes);
      expect((await source()).contributions).toEqual(full);
      expect(await current()).toMatchObject({
        status: 'current',
        replyCount: { kind: 'exact', value: 2 },
        lastContributionAt: plus(world.start, 2),
      });
      const before = (await source()).anchor.position;
      for (const event of [...latestEvents].reverse()) await effect.run(event);
      expect((await source()).anchor.position).toBe(before);
      const batch = await readConversationActivitySources(world.pool, [thread.id, thread.id], Date.now() + 30_000);
      expect(batch).toHaveLength(1);
      expect(batch[0]!.coverage).toBe('unproven');
      expect(batch[0]!.contributions).toEqual(full);

      // Start a fresh worker with the completed home and the new command waiting in its real log.
      await runtime.stop();
      runtime = undefined;
      const late = await world.thread(boardId, plus(world.start, 4), emptyHome);
      runtime = await startRankingWorker(world, [partition, emptyHome]);
      await runtime.consume(late.envelopes);
      for (let page = 0; page < 3; page++) {
        await repairConversationActivityPage(world.pool, emptyHome, Date.now() + 30_000);
        if ((await activity.select([late.thread.id], Date.now() + 30_000))[0]?.status === 'current') break;
      }
      expect((await activity.select([late.thread.id], Date.now() + 30_000))[0]).toMatchObject({
        status: 'current',
        replyCount: { kind: 'exact', value: 0 },
      });

      await world.grant(boardId, world.base.governance, ['moderation:takedown']);
      const moderated = await world.capture(boardHome, () =>
        world.command(
          'POST',
          `/v1/boards/${boardId}:takeDown`,
          { reason: 'Withdraw the discussion board' },
          world.base.governance,
          200,
        ),
      );
      await runtime.consume(moderated.envelopes);
      expect((await activity.confirm([populated], Date.now() + 30_000))[0]!.status).toBe('withheld');
      expect(await repairConversationActivityPage(world.pool, boardHome, Date.now() + 30_000)).toMatchObject({
        kind: 'board',
        scannedThreads: 2,
      });
      expect(await due()).toContain(emptyHome);
      expect(await repairConversationActivityPage(world.pool, emptyHome, Date.now() + 30_000)).toMatchObject({
        kind: 'thread',
        completedThreads: 1,
      });
      expect((await activity.select([thread.id], Date.now() + 30_000))[0]).toMatchObject({
        status: 'withheld',
        reason: 'unsupported-cohort',
      });
    } finally {
      try {
        await runtime?.stop();
      } finally {
        await world.base.system.close();
      }
    }
  },
  600_000,
);

test('conversation reply count distinguishes exact zero from the disclosed lower bound', () => {
  expect(toConversationActivityReplyCount(0n)).toEqual({ kind: 'exact', value: 0 });
  expect(toConversationActivityReplyCount(10_001n)).toEqual({ kind: 'lower-bound', value: 10_000 });
});
