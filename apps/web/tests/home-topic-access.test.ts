import { describe, expect, test } from 'bun:test';
import { gateFor, NO_PLATFORM_ACCESS, type PlatformAccess } from '../features/api/platform-access.ts';
import { followHomeTopic, pinHomeFilter, saveHomeFilter } from '../features/home/topic-actions.ts';
import { memorySavedFilters, readerFilters, topics } from '../features/saved-filter/fixtures.ts';

describe('Home public topic follows and optional Saved Filters', () => {
  const states: Record<string, PlatformAccess> = {
    anonymous: NO_PLATFORM_ACCESS,
    'signed in without grants': NO_PLATFORM_ACCESS,
    'group grant': { groups: ['saved-views'], operations: [], generation: '1' },
    'individual create grant': { groups: [], operations: ['postV1MeSaved-filters'], generation: '1' },
    'individual patch grant': { groups: [], operations: ['patchV1MeSaved-filtersById'], generation: '1' },
    'individual create and read grants': { groups: [], operations: ['postV1MeSaved-filters', 'getV1MeSaved-filters'], generation: '1' },
    'individual patch and read grants': { groups: [], operations: ['patchV1MeSaved-filtersById', 'getV1MeSaved-filters'], generation: '1' },
    revoked: { groups: [], operations: [], generation: '2' },
  };

  for (const [state, access] of Object.entries(states)) {
    test(`${state}: topic following never needs a Saved Filter read or patch`, async () => {
      const api = memorySavedFilters(readerFilters);
      // This topic already has an unpinned Saved Filter: following must not try to pin that filter.
      if (state === 'anonymous') api.followConcept = async () => ({ ok: false, failure: 'sign-in' });
      api.list = async () => { throw new Error('Optional Saved Filters must not be read'); };
      api.update = async () => { throw new Error('A public follow must not patch Saved Filters'); };
      const result = await followHomeTopic(api, topics.mystery.id);
      expect(result).toEqual(state === 'anonymous' ? { ok: false, failure: 'sign-in' }
        : { ok: true, data: { tab: topics.mystery.id.slice(-36) } });
      expect(api.calls).toEqual(state === 'anonymous' ? [] : [`follow:${topics.mystery.id.slice(-12)}:true`]);
      expect(gateFor(access)('postV1Follows')).toBe(true);
    });

    test(`${state}: saved writes require their own operation`, async () => {
      const api = memorySavedFilters(readerFilters);
      const gate = gateFor(access);
      const pinned = await pinHomeFilter(api, readerFilters.unpinned[0]!, gate);
      const saved = await saveHomeFilter(api, { name: 'Languages', filter: readerFilters.pinned[1]!.filter,
        pinned: true }, gate);
      expect(pinned.ok).toBe(gate('getV1MeSaved-filters') && gate('patchV1MeSaved-filtersById'));
      expect(saved.ok).toBe(gate('getV1MeSaved-filters') && gate('postV1MeSaved-filters'));
      expect(api.calls.some(call => call.startsWith('update:'))).toBe(gate('getV1MeSaved-filters') && gate('patchV1MeSaved-filtersById'));
      expect(api.calls.some(call => call.startsWith('create:'))).toBe(gate('getV1MeSaved-filters') && gate('postV1MeSaved-filters'));
    });
  }

  test('revocation after rendering is checked before a saved write', async () => {
    let access: PlatformAccess = states['group grant']!;
    const gate = (operation: Parameters<ReturnType<typeof gateFor>>[0]) => gateFor(access)(operation);
    expect(gate('patchV1MeSaved-filtersById')).toBe(true);
    access = states.revoked!;
    const api = memorySavedFilters(readerFilters);
    expect(await pinHomeFilter(api, readerFilters.unpinned[0]!, gate)).toEqual({ ok: false, failure: 'closed' });
    expect(await saveHomeFilter(api, { name: 'Languages', filter: readerFilters.pinned[1]!.filter, pinned: true }, gate))
      .toEqual({ ok: false, failure: 'closed' });
    expect(api.calls).toEqual([]);
    expect((await followHomeTopic(api, topics.mystery.id)).ok).toBe(true);
  });

  test('a full saved-tab inventory does not prevent a public topic follow', async () => {
    const full = { ...readerFilters, pinned: Array.from({ length: 8 }, (_, index) => ({
      ...readerFilters.pinned[1]!, id: `tab-${index}`, position: index })), unpinned: [] };
    const api = memorySavedFilters(full);
    expect(await followHomeTopic(api, topics.cozy.id)).toEqual({ ok: true, data: { tab: topics.cozy.id.slice(-36) } });
    expect(api.calls).toEqual([`follow:${topics.cozy.id.slice(-12)}:true`]);
  });
});
