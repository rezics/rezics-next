import { describe, expect, test } from 'bun:test';
import { commandFailure } from '../features/saved-filter/api.ts';
import { englishJapanese, readerFilters, topics } from '../features/saved-filter/fixtures.ts';
import { currentFiltersDocument, currentFiltersName, droppedOn, filterTitle, moved, splitFilters }
  from '../features/saved-filter/tabs.ts';

const [fantasy, , xianxia] = readerFilters.pinned;

describe('G-431 pinned Home tabs', () => {
  test('pinned filters are tabs in their positions; the rest wait unpinned', () => {
    const shuffled = [readerFilters.unpinned[0]!, xianxia!, englishJapanese, fantasy!];
    const split = splitFilters({ revision: 'r', items: shuffled });
    expect(split.pinned.map(item => item.id)).toEqual(readerFilters.pinned.map(item => item.id));
    expect(split.unpinned.map(item => item.id)).toEqual([readerFilters.unpinned[0]!.id]);
  });

  test('a tab reads as the reader\'s name, else its followed Concept\'s own label in its language', () => {
    expect(filterTitle(fantasy!)).toEqual({ value: 'Fantasy', language: 'en' });
    expect(filterTitle({ ...xianxia!, name: 'Cultivation' })).toEqual({ value: 'Cultivation' });
    expect(filterTitle(xianxia!)).toEqual({ value: topics.xianxia.name.value, language: 'zh-Hans' });
    expect(filterTitle({ name: null, concept: { id: topics.cozy.id, name: null } })).toBeNull();
  });

  test('moving a tab by keyboard or dropping it keeps every other tab in order', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(moved(order, 'b', 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moved(order, 'a', -1)).toEqual(order);
    expect(moved(order, 'd', 5)).toEqual(order);
    expect(droppedOn(order, 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
    expect(droppedOn(order, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moved(order, 'x', 1)).toEqual(order);
  });

  test('Home\'s current Filters save as any of their languages and any of their communities', () => {
    const realm = 'https://rezics.com/id/01a0e430-e167-7384-9cb3-e3eba0e0cd3f';
    expect(currentFiltersDocument({ languages: [], realms: [] })).toBeNull();
    expect(currentFiltersDocument({ languages: ['ja', 'ko'], realms: [realm] })).toEqual({ all: [
      { facet: 'language', any: ['ja', 'ko'] }, { facet: 'realm', any: [realm] }] });
    expect(currentFiltersName(['Japanese', 'Stardew Mods'])).toBe('Japanese · Stardew Mods');
    expect(currentFiltersName(['x'.repeat(100)])).toHaveLength(80);
  });

  test('Main\'s refusals read as what the reader can do about them', () => {
    expect(commandFailure(409, 'home_tabs_full')).toBe('full');
    expect(commandFailure(409, 'saved_filter_followed')).toBe('followed');
    expect(commandFailure(409, 'home_conflict')).toBe('stale');
    expect(commandFailure(422, 'unsupported_query_shape')).toBe('unsupported');
    expect(commandFailure(401, null)).toBe('sign-in');
    expect(commandFailure(503, null)).toBe('unavailable');
  });
});
