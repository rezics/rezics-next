import { expect, test } from 'bun:test';
import { mainRelationships, RelationshipError } from '../features/relationships/api.ts';
import { actor, fixtureFollow, memoryRelationships, target } from '../features/relationships/fixtures.ts';
import { relationshipStoryFetch } from '../features/relationships/story-fetch.ts';

test('G-977: story relationship requests share Realm/Space state and retain CAS, receipt metadata and command keys', async () => {
  const space = target(10), realm = target(20);
  const memory = memoryRelationships([{ ...fixtureFollow(10), realm }]);
  const fallback = Object.assign(async () => { throw new Error('Unexpected network request'); }, fetch);
  const api = mainRelationships(actor, { fetch: relationshipStoryFetch(memory.api, fallback, { [realm]: space }) });
  const initial = await api.state(realm, 'realm');
  expect(initial).toEqual(await api.state(space, 'space'));
  const receipt = await api.batch([{ target: realm, expectedRevision: initial.revision, level: 'off', pinPosition: 2 }], 'metadata-key');
  expect(receipt.items[0]).toMatchObject({ target: space, following: true, level: 'off', pinPosition: 2, source: 'explicit' });
  expect(memory.calls[0]).toMatchObject({ operation: 'batch', key: 'metadata-key', body: [{
    target: space, expectedRevision: initial.revision, level: 'off', pinPosition: 2,
  }] });
  await expect(api.set({ target: realm, kind: 'realm', following: false, expectedRevision: initial.revision }, 'stale-key'))
    .rejects.toEqual(new RelationshipError(409));
  const fresh = await api.state(realm, 'realm');
  await api.set({ target: realm, kind: 'realm', following: false, expectedRevision: fresh.revision }, 'unfollow-key');
  expect(await api.state(space, 'space')).toMatchObject({ following: false });
  expect(memory.calls.at(-1)).toMatchObject({ operation: 'follow', key: 'unfollow-key' });
});

test('G-977: story relationship failures preserve HTTP status and unrelated requests reach the original fetch', async () => {
  const memory = memoryRelationships([], 'read');
  const forwarded: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fallback = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    forwarded.push({ input, init });
    return Response.json({ untouched: true });
  }, fetch);
  const fetcher = relationshipStoryFetch(memory.api, fallback);
  const api = mainRelationships(actor, { fetch: fetcher });
  await expect(api.state(target(10), 'realm')).rejects.toEqual(new RelationshipError(503));
  memory.recover();
  expect(await api.state(target(10), 'realm')).toMatchObject({ following: false, revision: null });
  const request = new Request('https://storybook.test/unrelated');
  const init = { headers: { 'x-test': 'forwarded' } };
  expect(await (await fetcher(request, init)).json()).toEqual({ untouched: true });
  expect(forwarded).toEqual([{ input: request, init }]);
});
