import { expect, test } from 'bun:test';
import type { FeedPage } from '../../src/content/feed-contract.ts';
import { createFeedActivityStore, feedRoute } from '../../src/content/feed-activity.ts';
import { createReactionRelayBase } from './reaction-relay-convergence-fixture.ts';

test('Space-selected Following retains native membership, kind conjunction, sparse positions and current disclosure', async () => {
  const world = await createReactionRelayBase();
  try {
    for (const group of ['personal_library', 'reading_progress', 'search'])
      await world.command('POST', `/v1/platform/exposure/${group}:open`, undefined, {
        bearer: world.governance.bearer, expectedStatus: 200,
      });
    const selected = world.mainTarget;
    const unrelated = await world.createRealmTarget('Unrelated Space', 'public');
    const store = createFeedActivityStore({ pool: world.system.database.pool, tokens: world.system.tokenKeys });
    const spaces: string[] = [];
    // Retain references to actual committed source events. Delivery uses the native
    // inbox writer; no replacement reader, summary or membership verdict is supplied.
    for (const target of [selected, unrelated]) {
      const realm = await world.call('GET', `/v1/realms/${target.realmId}`);
      expect(realm.response.status, realm.text).toBe(200);
      const spaceId = realm.value!.realm.spaceId as string;
      spaces.push(spaceId);
      await world.command('PUT', `/v1/follows/${spaceId}`, undefined, { bearer: world.other.bearer });
      const { rows: [event] } = await world.system.database.pool.query<{
        partition_no: number; epoch: number; position: string; event_seq: number; data: { activityAt: string };
      }>(`SELECT partition_no,epoch,position::text,event_seq,data FROM core.outbox
          WHERE type='com.rezics.content.thread.created.v1' AND data->>'threadId'=$1`, [target.threadId]);
      if (!event) throw new Error('Native thread creation event missing');
      const reasonTarget = { type: 'space' as const, id: spaceId };
      await store.applyFollowingActivity({
        accountId: world.other.accountId, reasonTarget,
        activity: {
          id: `${event.partition_no}.${event.epoch}.${event.position}.${event.event_seq}:space:${spaceId}`,
          source: { partition: event.partition_no, epoch: event.epoch, position: event.position, eventIndex: event.event_seq },
          occurredAt: event.data.activityAt, target: reasonTarget,
          object: { owner: 'content', kind: 'thread', route: feedRoute(target.threadId), id: target.threadId, threadId: target.threadId },
        },
      }, Date.now() + 30_000);
    }
    const query = new URLSearchParams({ stream: 'following', spaceId: spaces[0]!, kind: 'thread', limit: '1' });
    const page = async (parameters = query) => {
      const result = await world.call('GET', `/v1/feedItems?${parameters}`, { bearer: world.other.bearer });
      expect(result.response.status, result.text).toBe(200);
      expect(result.response.headers.get('cache-control')).toBe('private, no-store');
      return result.value as FeedPage;
    };
    const sparse = await page();
    expect(sparse.feedItems).toEqual([]);
    expect(sparse.next).toBeString();
    expect(sparse.sources).toEqual({ following: 'ready', discovery: 'not_requested', continue: 'not_requested' });
    query.set('cursor', sparse.next!);
    const next = await page();
    expect(next.feedItems.map((item) => item.key.id)).toEqual([selected.threadId]);
    expect(next.feedItems[0]).toMatchObject({ source: 'following', key: { kind: 'thread' } });
    const rebound = new URLSearchParams(query);
    rebound.set('spaceId', spaces[1]!);
    expect((await world.call('GET', `/v1/feedItems?${rebound}`, { bearer: world.other.bearer })).response.status).toBe(400);
    query.delete('cursor');
    query.set('limit', '20');
    query.set('kind', 'collection');
    expect((await page()).feedItems).toEqual([]);
    query.set('kind', 'thread');
    query.set('stream', 'home');
    const home = await page();
    expect(home.feedItems.map((item) => item.key.id)).toEqual([selected.threadId]);
    expect(home.sources).toEqual({ following: 'ready', discovery: 'unavailable', continue: 'unavailable' });
    await world.command('POST', `/v1/posts/${selected.postId}:takeDown`, { reason: 'Withdraw current opening' }, {
      bearer: world.governance.bearer, expectedStatus: 200,
    });
    expect((await page()).feedItems).toEqual([]);
  } finally {
    await world.system.close();
  }
}, 180_000);
