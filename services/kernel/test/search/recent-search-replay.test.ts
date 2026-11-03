import { expect, test } from 'bun:test';
import { recentSearchDestination } from '../../src/search/recent-search-destination.ts';

const id = '019f0000-0000-7000-8000-734100000002';
test('query destinations use the installed resource leaf while scope-only history browses', () => {
  for (const kind of ['realm', 'collection'] as const) {
    const scope = { kind, id };
    for (const languages of [undefined, [], ['ja', 'en']]) {
      const href = recentSearchDestination({
        kind: 'query',
        text: '地図 + maps & /?',
        ...(languages ? { languages } : {}),
        scope,
      })!;
      const url = new URL(href, 'https://kernel.test');
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('q')).toBe('地図 + maps & /?');
      expect(url.searchParams.getAll('language')).toEqual(languages ?? []);
      expect(JSON.parse(url.searchParams.get('filter')!)).toEqual({ [kind]: { id } });
    }
    expect(recentSearchDestination({ kind: 'scope', scope })).toBe(
      `/${kind === 'realm' ? 'realms' : 'collections'}/${id}`,
    );
  }
  const scope = { kind: 'route' as const, route: 'library' as const };
  expect(recentSearchDestination({ kind: 'scope', scope })).toBe('/library');
  expect(recentSearchDestination({ kind: 'query', text: 'maps', scope })).toBeUndefined();
});
