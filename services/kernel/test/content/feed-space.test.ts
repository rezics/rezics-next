import { afterAll, expect, test } from 'bun:test';
import type { Account } from '../../../../specs/community-driver.ts';
import type { FeedPage } from '../../src/content/feed-contract.ts';
import { closeCommunityDrivers, createCommunityDriver } from '../community/community-driver.ts';

afterAll(closeCommunityDrivers);

test('Space-selected Following uses current native adoption, preserves sparse positions and exact cursor selections, and retires withdrawn publications', async () => {
  const driver = await createCommunityDriver();
  try {
    const fixture = await driver.provision();
    async function command(method: 'POST' | 'PUT', path: string, body?: unknown, ifMatch?: string) {
      const response = await driver.request({
        actor: fixture.owner, method, path, body, ifMatch,
        key: JSON.stringify(crypto.randomUUID()),
      });
      const value = await response.json() as Record<string, any>;
      expect(response.status, JSON.stringify(value)).toBeLessThan(300);
      return value;
    }
    const { space } = await command('POST', '/v1/spaces', { title: 'Selected native feed Space' });
    const { realm } = await command('POST', '/v1/realms', {
      spaceId: space.spaceId, title: 'Selected native feed Realm',
      visibility: 'public', contextId: fixture.contextId,
    });
    const follow = await driver.request({
      actor: fixture.member, method: 'PUT', path: `/v1/follows/${space.spaceId}`,
      key: JSON.stringify(crypto.randomUUID()),
    });
    expect(follow.status, await follow.clone().text()).toBe(200);
    const { publication } = await command('POST', `/v1/realms/${realm.realmId}/publications`, {
      subjectId: fixture.subject.id,
    });
    await driver.settle();
    const selection = { stream: 'following', limit: '1', spaceId: space.spaceId, kind: 'schema:Book' };
    async function read(query: Record<string, string> = selection, actor: Account | null = fixture.member) {
      return driver.request({ actor, method: 'GET', path: `/v1/feedItems?${new URLSearchParams(query)}` });
    }
    const response = await read();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const first = await response.json() as FeedPage;
    expect(first.sources).toEqual({ discovery: 'not_requested', continue: 'not_requested', following: 'ready' });
    expect(first.feedItems.map(({ source, key }) => [source, key.kind, key.id]))
      .toEqual([['following', 'schema:Book', fixture.subject.id]]);
    expect(first.next).toEqual(expect.any(String));
    // A kind rejection consumes the actual native position and remains continuable.
    const sparse = await (await read({ ...selection, kind: 'thread' })).json() as FeedPage;
    expect(sparse.feedItems).toEqual([]);
    expect(sparse.next).toEqual(expect.any(String));
    const end = await (await read({ ...selection, kind: 'thread', cursor: sparse.next! })).json() as FeedPage;
    expect(end.feedItems).toEqual([]);
    expect(end.next).toBeNull();
    for (const changed of [{ kind: 'thread' }, { spaceId: fixture.unknown.realm }]) {
      const rebound = await read({ ...selection, cursor: first.next!, ...changed });
      expect(rebound.status).toBe(400);
      expect(await rebound.json()).toMatchObject({ code: 'invalid_cursor' });
    }
    expect((await read(selection, null)).status).toBe(401);
    await command('POST', `/v1/realms/${realm.realmId}/publications/${fixture.subject.id}:withdraw`,
      undefined, JSON.stringify(publication.publicationId));
    // No projection or retention cleanup wait may preserve the old positive.
    const revoked = await (await read()).json() as FeedPage;
    expect(revoked.feedItems).toEqual([]);
    expect(revoked.sources.following).toBe('ready');
    const next = await (await read({ ...selection, cursor: first.next! })).json() as FeedPage;
    expect(next.feedItems).toEqual([]);
  } finally {
    await driver.close();
  }
}, 180_000);
