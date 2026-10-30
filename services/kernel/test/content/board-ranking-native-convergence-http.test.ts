import { expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { snapshotReactionOperation, targetProjectionRows } from './reaction-relay-convergence-fixture.ts';
import {
  createRankingWorld,
  expectedOrder,
  expectedRank,
  listing,
  plus,
  requireStatus,
  sorts,
  startRankingWorker,
  type RankedThread,
  type RankingRuntime,
  type RankingWorld,
} from './board-ranking-native-convergence-fixture.ts';

async function problem(world: RankingWorld, path: string, status: number, code: string, bearer?: string) {
  const result = await world.call('GET', path, bearer === undefined ? {} : { bearer });
  expect(result.response.status, result.text).toBe(status);
  expect(result.response.headers.get('content-type')).toContain('application/problem+json');
  expect(result.value).toMatchObject({ code, effect_status: 'not_applicable', retryable: false });
  expect(Object.keys(result.value!).sort()).toEqual(
    ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id'].sort(),
  );
  expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
  return result;
}

async function materialized(world: RankingWorld, boardId: string) {
  return (
    await world.pool.query<{
      thread_id: string;
      score: number;
      active_rank: number;
      hot_rank: number;
      created_at: Date;
      last_activity_at: Date;
      rank_refreshed_at: Date;
    }>(
      `SELECT thread_id,score,active_rank,hot_rank,created_at,last_activity_at,rank_refreshed_at
       FROM content.board_thread WHERE route=$1 AND board_id=$2 ORDER BY thread_id`,
      [routeOf(boardId), boardId],
    )
  ).rows;
}

async function assertRanks(world: RankingWorld, boardId: string, threads: readonly RankedThread[], at: string) {
  const rows = await materialized(world, boardId);
  expect(rows).toHaveLength(threads.length);
  for (const thread of threads) {
    const row = rows.find(({ thread_id }) => thread_id === thread.id)!;
    expect(row, `Missing native board projection for ${thread.id}`).toBeDefined();
    expect(row.score).toBe(thread.score);
    expect(row.created_at.toISOString()).toBe(new Date(thread.createdAt).toISOString());
    expect(row.last_activity_at.toISOString()).toBe(new Date(thread.activityAt).toISOString());
    expect(row.active_rank).toBeCloseTo(expectedRank(thread.score, thread.activityAt, at), 12);
    expect(row.hot_rank).toBeCloseTo(expectedRank(thread.score, thread.createdAt, at), 12);
    expect(row.rank_refreshed_at.toISOString()).toBe(at);
  }
}

test.serial(
  'Boards: real reaction-driven hot and active ranking with stable keyset pages through actual native APIs and producer outcomes',
  async () => {
    const world = await createRankingWorld();
    let runtime: RankingRuntime | undefined;
    try {
      const boardId = await world.board();
      const otherBoardId = await world.board();
      const privateBoardId = await world.board('protected');
      const boardPartition = partitionOf(routeOf(boardId)!);
      runtime = await startRankingWorker(world, [boardPartition]);
      const at = world.start;
      const threads: RankedThread[] = [];
      for (let index = 0; index < 8; index++) {
        const created = await world.thread(boardId, at);
        threads.push(created.thread);
        expect(new Date(created.thread.createdAt).toISOString()).toBe(at);
        expect(
          created.envelopes
            .flatMap(({ events }) => events)
            .some(
              (event) => event.type === 'com.rezics.content.thread.created.v1' && event.subject === created.thread.id,
            ),
        ).toBe(true);
        await runtime.consume(created.envelopes);
      }
      expect(new Set(threads.map(({ createdAt }) => createdAt)).size).toBe(1);
      const initialAt = plus(at, 11);
      await runtime.refresh(initialAt);
      await world.time(initialAt);
      await assertRanks(world, boardId, threads, initialAt);
      const readers = [undefined, world.base.author.bearer, world.base.other.bearer];
      for (const sort of sorts)
        for (const bearer of readers) {
          const walk = await world.walk(boardId, sort, bearer);
          expect(walk.ids).toEqual(expectedOrder(threads, sort, initialAt));
          expect(new Set(walk.ids).size).toBe(8);
          expect(walk.pages.at(-1)!.next).toBeNull();
        }
      const initialHot = expectedOrder(threads, 'hot', initialAt);
      const initialActive = expectedOrder(threads, 'active', initialAt);
      // Pick a non-leading tied item independently of returned pages so the changed vote must change rank order.
      const voted = threads.find(({ id }) => id === initialHot.at(-1))!;
      const replied = threads.find(({ id }) => id === initialHot.at(-2))!;
      const downvoted = threads.find(({ id }) => id === initialHot.at(-3))!;
      const loved = threads.find(({ id }) => id === initialHot.at(-4))!;
      const change = await world.react(voted, world.base.other, 'upvote');
      const reactionEvent = change.envelopes
        .flatMap(({ events }) => events)
        .find((event) => event.type === 'com.rezics.content.reaction.changed.v1')!;
      expect(reactionEvent).toBeDefined();
      await runtime.consume(change.envelopes);
      await runtime.consume((await world.react(voted, world.base.author, 'upvote')).envelopes);
      await runtime.consume((await world.react(downvoted, world.base.other, 'downvote')).envelopes);
      await runtime.consume((await world.react(loved, world.base.author, 'love')).envelopes);
      const replyAt = plus(at, 240);
      const reply = await world.reply(replied, world.base.other, replyAt);
      expect(new Date(replied.activityAt).toISOString()).toBe(replyAt);
      await runtime.consume(reply.envelopes);

      // Both a receipt replay and a new-key same-slot no-op preserve the physical source position and projection.
      const before = await snapshotReactionOperation(world.pool, world.base.other.accountId, voted.id, change.key);
      expect(before.slot).toHaveLength(1);
      expect(before.receipt).toHaveLength(1);
      for (const key of [change.key, crypto.randomUUID()]) {
        const replay = await world.call('PUT', `/v1/threads/${voted.id}/reaction`, {
          bearer: world.base.other.bearer,
          key,
          body: { kind: 'upvote' },
        });
        requireStatus(replay, 200);
        expect(replay.value).toEqual({ kind: 'upvote' });
        expect(await snapshotReactionOperation(world.pool, world.base.other.accountId, voted.id, change.key)).toEqual(
          before,
        );
      }
      const projection = await targetProjectionRows(world.pool, voted.id);
      await runtime.replay(reactionEvent);
      expect(await targetProjectionRows(world.pool, voted.id)).toEqual(projection);
      const readVote = await world.call('GET', `/v1/threads/${voted.id}`, { bearer: world.base.other.bearer });
      requireStatus(readVote, 200);
      expect(readVote.value!.thread.reactions).toEqual({ upvote: 2 });
      expect(readVote.value!.thread.viewerReaction).toBe('upvote');
      expect(readVote.value!.reactionsAsOf).not.toBeNull();
      const anonymousVote = await world.call('GET', `/v1/threads/${voted.id}`);
      expect(anonymousVote.value!.thread).not.toHaveProperty('viewerReaction');

      // The independently retrieved aggregate consumers finished before this registered refresh workflow starts.
      const rankedAt = plus(at, 251);
      await runtime.refresh(rankedAt);
      await world.time(rankedAt);
      await assertRanks(world, boardId, threads, rankedAt);
      expect(expectedOrder(threads, 'hot', rankedAt)).not.toEqual(initialHot);
      expect(expectedOrder(threads, 'active', rankedAt)).not.toEqual(initialActive);
      expect(expectedOrder(threads, 'hot', rankedAt)[0]).toBe(voted.id);
      expect(expectedOrder(threads, 'active', rankedAt)[0]).toBe(replied.id);
      for (const sort of sorts)
        for (const bearer of readers) {
          const walk = await world.walk(boardId, sort, bearer);
          expect(walk.ids).toEqual(expectedOrder(threads, sort, rankedAt));
          expect(new Set(walk.ids).size).toBe(8);
          expect(walk.pages.at(-1)!.next).toBeNull();
          for (const page of walk.pages) {
            if (sort === 'newest') expect(page.rankRefreshedAt).toBeNull();
            else expect(new Date(page.rankRefreshedAt!).toISOString()).toBe(rankedAt);
            for (const item of page.threads) {
              expect(item.boardId).toBe(boardId);
              expect(item.visibility).toBe('published');
              expect(item.firstPost.body).toBeDefined();
            }
          }
        }

      // Start all three persona/sort walks before insertion. Materialized ranks remain fixed during this walk.
      const starts = [];
      for (const sort of sorts)
        for (const bearer of readers) {
          const first = await world.page(boardId, sort, bearer);
          expect(first.threads.map(({ id }) => id)).toEqual(expectedOrder(threads, sort, rankedAt).slice(0, 3));
          expect(first.next).toEqual(expect.any(String));
          starts.push({ sort, bearer, first });
        }
      // This item lies after every first-page floor, so every continuation must conceal its current takedown.
      const later = threads.find(({ id }) =>
        starts.every(({ first }) => !first.threads.some((item) => item.id === id)),
      )!;
      expect(later).toBeDefined();
      const inserted = await world.thread(boardId, plus(at, 252));
      await runtime.consume(inserted.envelopes);
      await world.grant(later.id, world.base.governance, ['moderation:takedown']);
      await world.command(
        'POST',
        `/v1/threads/${later.id}:takeDown`,
        { reason: 'Native ranking concealment' },
        world.base.governance,
        200,
      );
      for (const { sort, bearer, first } of starts) {
        const remaining = await world.walk(boardId, sort, bearer, first.next!);
        const all = [...first.threads.map(({ id }) => id), ...remaining.ids];
        expect(all).toEqual(
          expectedOrder(
            threads.filter(({ id }) => id !== later.id),
            sort,
            rankedAt,
          ),
        );
        expect(new Set(all).size).toBe(all.length);
        expect(all).not.toContain(inserted.thread.id);
        expect(all).not.toContain(later.id);
        expect(remaining.pages.at(-1)!.next).toBeNull();
      }
      const freshNewest = await world.walk(boardId, 'newest');
      expect(freshNewest.ids).toEqual(
        expectedOrder([...threads.filter(({ id }) => id !== later.id), inserted.thread], 'newest', rankedAt),
      );
      await problem(world, `/v1/threads/${later.id}`, 404, 'not_found');

      // Signed tokens refuse altered signatures, sorts, normalized queries, boards and verified viewers.
      for (const sort of sorts) {
        const anonymous = await world.page(boardId, sort);
        const a = await world.page(boardId, sort, world.base.author.bearer);
        const b = await world.page(boardId, sort, world.base.other.bearer);
        expect(anonymous.next).toEqual(expect.any(String));
        expect(a.next).toEqual(expect.any(String));
        expect(b.next).toEqual(expect.any(String));
        const token = anonymous.next!;
        for (const path of [
          listing(otherBoardId, sort, token),
          listing(boardId, sort === 'hot' ? 'active' : 'hot', token),
          listing(boardId, sort, token, 3, 'different'),
          listing(boardId, sort, `${token.slice(0, -4)}xxxx`),
        ])
          await problem(world, path, 400, 'invalid_request');
        await problem(world, listing(boardId, sort, token), 400, 'invalid_request', world.base.author.bearer);
        await problem(world, listing(boardId, sort, a.next!), 400, 'invalid_request', world.base.other.bearer);
        await problem(world, listing(boardId, sort, b.next!), 400, 'invalid_request');
        await world.time(plus(at, 268));
        await problem(world, listing(boardId, sort, token), 400, 'invalid_request');
        await world.time(plus(at, 252));
      }

      // A protected board in a public Realm needs only real board/thread/post grants, without Realm transitions.
      const protectedThreads: RankedThread[] = [];
      for (let index = 0; index < 8; index++) {
        const created = await world.thread(privateBoardId, plus(at, 252), undefined, 'protected');
        protectedThreads.push(created.thread);
        await runtime.consume(created.envelopes);
        for (const person of [world.base.author, world.base.other]) {
          await world.grant(created.thread.id, person, ['thread:read']);
          await world.grant(created.thread.postId, person, ['post:read']);
        }
      }
      for (const person of [world.base.author, world.base.other])
        await world.grant(privateBoardId, person, ['board:read']);
      const protectedAt = plus(at, 263);
      await runtime.refresh(protectedAt);
      await world.time(protectedAt);
      for (const sort of sorts) {
        await problem(world, listing(privateBoardId, sort), 404, 'not_found');
        const firstA = await world.page(privateBoardId, sort, world.base.author.bearer);
        const firstB = await world.page(privateBoardId, sort, world.base.other.bearer);
        const expected = expectedOrder(protectedThreads, sort, protectedAt);
        expect(firstA.threads.map(({ id }) => id)).toEqual(expected.slice(0, 3));
        expect(firstB.threads.map(({ id }) => id)).toEqual(expected.slice(0, 3));
        const revokedThread = protectedThreads.find(({ id }) => id === expected.at(-1))!;
        // Give the concealed target a real nonzero aggregate. Love has the documented zero vote weight here.
        const privateVote = await world.react(revokedThread, world.base.other, 'love');
        await runtime.consume(privateVote.envelopes);
        const privateRead = await world.call('GET', `/v1/threads/${revokedThread.id}`, {
          bearer: world.base.other.bearer,
        });
        requireStatus(privateRead, 200);
        expect(privateRead.value!.thread.reactions).toEqual(revokedThread.reactions);
        expect(privateRead.value!.thread.viewerReaction).toBe('love');
        expect(privateRead.value!.reactionsAsOf).not.toBeNull();
        const privateBefore = await snapshotReactionOperation(
          world.pool,
          world.base.other.accountId,
          revokedThread.id,
          privateVote.key,
        );
        await world.revoke(revokedThread.id, world.base.other, ['thread:read']);
        const deniedReplay = await world.call('PUT', `/v1/threads/${revokedThread.id}/reaction`, {
          bearer: world.base.other.bearer,
          key: privateVote.key,
          body: { kind: 'love' },
        });
        expect(deniedReplay.response.status, deniedReplay.text).toBe(404);
        expect(deniedReplay.value).toMatchObject({ code: 'not_found', effect_status: 'not_applied' });
        expect(deniedReplay.text).not.toContain('love');
        expect(
          await snapshotReactionOperation(world.pool, world.base.other.accountId, revokedThread.id, privateVote.key),
        ).toEqual(privateBefore);
        const remainder = await world.walk(privateBoardId, sort, world.base.other.bearer, firstB.next!);
        expect([...firstB.threads.map(({ id }) => id), ...remainder.ids]).toEqual(
          expected.filter((id) => id !== revokedThread.id),
        );
        const hidden = await problem(
          world,
          `/v1/threads/${revokedThread.id}`,
          404,
          'not_found',
          world.base.other.bearer,
        );
        expect(hidden.text).not.toContain(revokedThread.postId);
        await world.revoke(privateBoardId, world.base.other, ['board:read']);
        const denied = await problem(
          world,
          listing(privateBoardId, sort, firstB.next!),
          404,
          'not_found',
          world.base.other.bearer,
        );
        for (const thread of protectedThreads) expect(denied.text).not.toContain(thread.id);
        const ownerRest = await world.walk(privateBoardId, sort, world.base.author.bearer, firstA.next!);
        expect([...firstA.threads.map(({ id }) => id), ...ownerRest.ids]).toEqual(expected);
        await world.grant(privateBoardId, world.base.other, ['board:read']);
        await world.grant(revokedThread.id, world.base.other, ['thread:read']);
      }
      // This credential predates the fixture's real native suspension; Accounts' current authentication floor wins.
      await problem(
        world,
        listing(boardId, 'hot'),
        401,
        'invalid_credentials',
        world.base.system.actors.suspended.bearer,
      );
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
