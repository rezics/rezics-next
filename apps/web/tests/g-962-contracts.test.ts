import { describe, expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { spaceHref } from '../features/address/path.ts';
import { BrowseReadError, discoveryApi } from '../features/discover/api.ts';
import { browseQuery, emptyBrowse } from '../features/discover/browse-state.ts';
import { fixtureFollow, target } from '../features/relationships/fixtures.ts';
import { followedCommunity, withZoneAddress } from '../features/shell/communities-relationships.ts';
import type { Community } from '../features/shell/communities.ts';

const sourcePosition = { dataEpoch: 'merged-main', sequence: '42' };
const list = { items: [], nextCursor: null, complete: true, count: { value: 0, kind: 'exact' as const } };

describe('G-962 merged browse and relationship contracts', () => {
  test('all browse reads retain Main profiles, source position and projection lag', async () => {
    const resources = { ...list, profile: 'resource-list-v1' as const, sourcePosition, stale: true };
    const concepts = { ...list, profile: 'concept-search-v1' as const, sourcePosition, stale: true };
    const populations = { ...list, profile: 'rating-populations-v1' as const, target: target(10), sourcePosition, stale: true };
    const sections = { ...list, profile: 'discovery-sections-v1' as const, personalized: false, sourcePosition, stale: true };
    const answer = (data: unknown) => ({ get: async () => ({ data, error: null }) });
    const api = discoveryApi({ v1: {
      query: { post: async () => ({ data: { result: resources }, error: null }) },
      discovery: { concepts: answer(concepts), sections: answer(sections) },
      'rating-populations': answer(populations),
    } }, 'zh-Hant');
    expect(await api.resources(browseQuery(emptyBrowse))).toEqual(resources);
    expect(await api.concepts()).toEqual(concepts);
    expect(await api.populations(target(10))).toEqual(populations);
    expect(await api.sections()).toEqual(sections);
  });

  test('branch-era and missing profiles cannot become successful picker or section reads', async () => {
    for (const profile of [undefined, 'discovery-works-v1', 'follows-v1']) {
      const get = async () => ({ data: { ...list, profile }, error: null });
      const api = discoveryApi({ v1: {
        discovery: { concepts: { get }, sections: { get } },
        'rating-populations': { get },
      } }, 'en');
      await expect(api.concepts()).rejects.toBeInstanceOf(BrowseReadError);
      await expect(api.sections()).rejects.toBeInstanceOf(BrowseReadError);
      await expect(api.populations(target(10))).rejects.toBeInstanceOf(BrowseReadError);
    }
  });

  test('relationship fixture links retain complete Space and resource identities', () => {
    const space = fixtureFollow(10);
    const resource = fixtureFollow(11, 'work');
    // ast-grep-ignore: web-links-use-address -- Independent expected paths verify durable identities.
    expect(space.href).toBe(`/r/${uuidToSid(space.id.slice(-36))}`);
    // ast-grep-ignore: web-links-use-address -- Independent expected paths verify durable identities.
    expect(resource.href).toBe(`/e/${uuidToSid(resource.id.slice(-36))}`);
  });

  test('official Zone addresses match a Space follow through its Realm capability', () => {
    const follow = fixtureFollow(10);
    const community = followedCommunity(follow)!;
    const official: Community = { id: target(20), kind: 'zone', realm: follow.realm!, name: 'Fiction',
      language: 'en', icon: null, href: spaceHref('fiction', 'community'), activity: 'unknown' };
    const [named] = withZoneAddress([community], [official]);
    expect(named).toEqual({ ...community, href: official.href });
    expect(named!.id).toBe(follow.id);
    expect(named!.realm).toBe(follow.realm!);
    const unrelated = followedCommunity(fixtureFollow(11))!;
    expect(withZoneAddress([unrelated], [official])).toEqual([unrelated]);
  });
});
