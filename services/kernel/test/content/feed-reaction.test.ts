import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { FeedPage } from '../../src/content/feed-contract.ts';
import { createFeedActivityStore, feedRoute, type ActivityRef } from '../../src/content/feed-activity.ts';
import { projectFeedReactions } from '../../src/content/feed-reactions.ts';
import { observeSql } from './support/sql-observer.ts';
import { createReactionRelayBase } from './reaction-relay-convergence-fixture.ts';

test('Following feed projects native counts and only the current viewer slot for disclosed thread targets', async () => {
  const world = await createReactionRelayBase();
  let effects: Awaited<ReturnType<typeof world.startEffects>> | undefined;
  try {
    for (const group of ['personal_library', 'reading_progress', 'search'])
      await world.command('POST', `/v1/platform/exposure/${group}:open`, undefined, {
        bearer: world.governance.bearer,
        expectedStatus: 200,
      });
    const realm = await world.call('GET', `/v1/realms/${world.mainTarget.realmId}`);
    expect(realm.response.status, realm.text).toBe(200);
    const spaceId = realm.value!.realm.spaceId as string;
    const store = createFeedActivityStore({ pool: world.system.database.pool, tokens: world.system.tokenKeys });
    const reply = await world.command<{ post: { id: string } }>(
      'POST',
      `/v1/threads/${world.mainTarget.threadId}/posts`,
      { body: fromPlainText('A feed reply'), licence: 'CC0-1.0', subjectIds: [] },
    );
    const events: ActivityRef[] = [];
    for (const [type, key, id, kind] of [
      ['com.rezics.content.thread.created.v1', 'threadId', world.mainTarget.threadId, 'thread'],
      ['com.rezics.content.post.created.v1', 'itemId', reply.post.id, 'post'],
    ] as const) {
      const {
        rows: [source],
      } = await world.system.database.pool.query<{
        partition_no: number;
        epoch: number;
        position: string;
        event_seq: number;
        data: { activityAt: string };
      }>(`SELECT partition_no,epoch,position::text,event_seq,data FROM core.outbox WHERE type=$1 AND data->>$2=$3`, [
        type,
        key,
        id,
      ]);
      if (!source) throw new Error(`Native ${kind} creation event missing`);
      events.push({
        id: `${source.partition_no}.${source.epoch}.${source.position}.${source.event_seq}:space:${spaceId}`,
        source: {
          partition: source.partition_no,
          epoch: source.epoch,
          position: source.position,
          eventIndex: source.event_seq,
        },
        occurredAt: source.data.activityAt,
        target: { type: 'space' as const, id: spaceId },
        object: {
          owner: 'content' as const,
          kind,
          route: feedRoute(id),
          id,
          threadId: world.mainTarget.threadId,
        },
      });
    }
    for (const person of [world.other, world.author]) {
      await world.command('PUT', `/v1/follows/${spaceId}`, undefined, { bearer: person.bearer });
      for (const activity of events)
        await store.applyFollowingActivity(
          { accountId: person.accountId, reasonTarget: activity.target, activity },
          Date.now() + 30_000,
        );
    }

    const page = async (
      bearer: string,
      options: { kind?: string; limit?: number; cursor?: string } = {},
    ): Promise<FeedPage> => {
      const query = new URLSearchParams({ stream: 'following', limit: String(options.limit ?? 20) });
      if (options.kind) query.set('kind', options.kind);
      if (options.cursor) query.set('cursor', options.cursor);
      const result = await world.call('GET', `/v1/feedItems?${query}`, { bearer });
      expect(result.response.status, result.text).toBe(200);
      expect(result.response.headers.get('cache-control')).toBe('private, no-store');
      return result.value as FeedPage;
    };

    const empty = await page(world.other.bearer);
    expect(empty.feedItems).toHaveLength(2);
    const threadCard = empty.feedItems.find((item) => item.key.kind === 'thread')!;
    const postCard = empty.feedItems.find((item) => item.key.kind === 'post')!;
    expect(threadCard.summary).toMatchObject({
      reactionTarget: { targetKind: 'thread', targetId: world.mainTarget.threadId },
      reactions: {},
      viewerReaction: null,
    });
    expect(postCard.summary).toMatchObject({
      reactionTarget: { targetKind: 'post', targetId: reply.post.id },
      reactions: {},
      viewerReaction: null,
    });
    expect(empty.reactionsAsOf).toBeNull();

    effects = await world.startEffects();
    for (const [path, kind] of [
      [`/v1/threads/${world.mainTarget.threadId}/reaction`, 'love'],
      [`/v1/posts/${reply.post.id}/reaction`, 'like'],
    ] as const) {
      const capture = await effects.captureBeforeWrite(world.other.accountId);
      await world.command('PUT', path, { kind }, { bearer: world.other.bearer, expectedStatus: 200 });
      const written = await capture.read();
      await effects.waitForEffect(written.envelope, written.eventSeq);
    }

    const selected = await page(world.other.bearer);
    expect(selected.feedItems.find((item) => item.key.kind === 'thread')?.summary).toMatchObject({
      reactionTarget: { targetKind: 'thread', targetId: world.mainTarget.threadId },
      reactions: { love: 1 },
      viewerReaction: 'love',
    });
    expect(selected.feedItems.find((item) => item.key.kind === 'post')?.summary).toMatchObject({
      reactionTarget: { targetKind: 'post', targetId: reply.post.id },
      reactions: { like: 1 },
      viewerReaction: 'like',
    });
    expect(selected.reactionsAsOf).toMatchObject({ epoch: expect.any(Number), position: expect.any(String) });

    const switched = await page(world.author.bearer);
    expect(switched.feedItems.find((item) => item.key.kind === 'thread')?.summary).toMatchObject({
      reactions: { love: 1 },
      viewerReaction: null,
    });
    expect(switched.feedItems.find((item) => item.key.kind === 'post')?.summary).toMatchObject({
      reactions: { like: 1 },
      viewerReaction: null,
    });
    const sparse = await page(world.other.bearer, { kind: 'thread', limit: 1 });
    expect(sparse.feedItems).toEqual([]);
    expect(sparse.next).toBeString();
    expect((await page(world.other.bearer, { kind: 'thread', limit: 1, cursor: sparse.next! })).feedItems).toHaveLength(
      1,
    );
    const selectedPost = await page(world.other.bearer, { kind: 'post', limit: 1 });
    expect(selectedPost.feedItems).toHaveLength(1);
    expect(selectedPost.next).toBeString();
    const stale = await world.call(
      'GET',
      `/v1/feedItems?stream=following&kind=post&limit=1&cursor=${encodeURIComponent(selectedPost.next!)}`,
      { bearer: world.author.bearer },
    );
    expect(stale.response.status).toBe(400);

    const card = switched.feedItems.find((item) => item.key.kind === 'post')!;
    const duplicate = { ...card, id: `${card.id}:duplicate` };
    const rebound = { ...card, destination: { ...card.destination, id: world.mainTarget.threadId } } as typeof card;
    await expect(
      projectFeedReactions(
        { pool: world.system.database.pool, access: world.system.access, tokens: world.system.tokenKeys },
        { kind: 'anonymous' },
        [rebound],
        Date.now() + 30_000,
      ),
    ).rejects.toThrow('Ambiguous feed reaction target');
    const trace = observeSql(world.system.database.pool);
    try {
      const anonymous = await projectFeedReactions(
        {
          pool: world.system.database.pool,
          access: world.system.access,
          tokens: world.system.tokenKeys,
        },
        { kind: 'anonymous' },
        [card, duplicate],
        Date.now() + 30_000,
      );
      expect(anonymous.items).toHaveLength(2);
      expect(Object.hasOwn(anonymous.items[0]!.summary, 'viewerReaction')).toBe(false);
      expect(anonymous.items[0]!.summary).toMatchObject({ reactions: { love: 1 } });
      expect(trace.records.filter((row) => row.statement.includes('content.reaction_total'))).toHaveLength(1);
      expect(trace.records.filter((row) => row.statement.includes('content.reaction AS'))).toHaveLength(0);
    } finally {
      await trace.close();
    }

    await world.command(
      'POST',
      `/v1/posts/${world.mainTarget.postId}:takeDown`,
      { reason: 'Current feed disclosure' },
      { bearer: world.governance.bearer, expectedStatus: 200 },
    );
    const hidden = await page(world.other.bearer);
    expect(hidden.feedItems).toEqual([]);
    expect(Object.hasOwn(hidden, 'reactionsAsOf')).toBe(false);
  } finally {
    await effects?.stop();
    await world.system.close();
  }
}, 240_000);
