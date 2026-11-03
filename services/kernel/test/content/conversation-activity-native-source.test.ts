import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import {
  createConversationActivityEffect,
  readConversationActivitySources,
} from '../../src/content/conversation-activity.ts';
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
      const created = await world.thread(boardId, world.start);
      const thread = created.thread;
      const partition = partitionOf(routeOf(thread.id)!);
      runtime = await startRankingWorker(world, [partition]);
      await runtime.consume(created.envelopes);
      const source = async () =>
        (await readConversationActivitySources(world.pool, [thread.id], Date.now() + 30_000))[0]!;
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

      await world.time(plus(world.start, 3));
      const edited = await world.capture(partition, () =>
        world.command('POST', `/v1/posts/${first.value.post.id}/revisions`, {
          body: fromPlainText('Old wording corrected'),
          licence: 'CC0-1.0',
          subjectIds: [],
        }),
      );
      await runtime.consume(edited.envelopes);
      expect((await source()).contributions).toEqual(full);

      const erased = await world.capture(partition, async () => {
        const result = await world.call('DELETE', `/v1/posts/${second.value.post.id}`, {
          bearer: world.base.author.bearer,
          key: crypto.randomUUID(),
        });
        requireStatus(result, 204);
      });
      await runtime.consume(erased.envelopes);
      expect((await source()).contributions.map(({ postId }) => postId)).toEqual([first.value.post.id, thread.postId]);
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
      const before = (await source()).anchor.position;
      for (const event of [...latestEvents].reverse()) await effect.run(event);
      expect((await source()).anchor.position).toBe(before);
      const batch = await readConversationActivitySources(world.pool, [thread.id, thread.id], Date.now() + 30_000);
      expect(batch).toHaveLength(1);
      expect(batch[0]!.coverage).toBe('unproven');
      expect(batch[0]!.contributions).toEqual(full);
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
