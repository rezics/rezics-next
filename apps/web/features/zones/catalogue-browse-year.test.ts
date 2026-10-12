import { expect, test } from 'bun:test';
import type { RealmView } from '../realm/realm-page.tsx';
import { applyCatalogueYear, catalogueBrowseQuery } from './catalogue-browse.tsx';
import { browseModel } from './browse-view.ts';
import { parseBrowseState } from './browse-state.ts';
import { messages } from './messages.ts';

const view = {
  kind: 'view',
  zone: { links: { browse: '/browse' } },
  context: { locale: 'en', ref: 'anime' },
  zoneMessages: messages,
  pkg: null,
} as unknown as Extract<RealmView, { kind: 'view' }>;

test('a year view preserves the API second page, response counts and year-filtered Facets', async () => {
  // These members would be beyond the former ten 20-item member pages.
  const works = [201, 202].map((index) => ({ id: `https://rezics.com/id/${index}` }));
  const read = (query: ReturnType<typeof catalogueBrowseQuery>) => {
    expect(query.publicationYear).toBe('1995');
    return {
      items: query.cursor ? [works[1]!] : [works[0]!],
      facets: {
        type: [],
        concept: [],
        length: [],
        status: [
          { value: 'completed', count: 7 },
          { value: 'ongoing', count: 3 },
        ],
      },
      matches: {
        value: query.cursor ? 42 : 21,
        kind: query.cursor ? ('exact' as const) : ('lower-bound' as const),
      },
      window: { scanned: 64, complete: Boolean(query.cursor) },
      tags: 'current' as const,
      nextCursor: query.cursor ? null : 'api-page-two',
      sort: 'newest' as const,
    };
  };
  let search: Record<string, string> = { year: '1995', status: 'completed', view: 'grid' };
  const seen: string[] = [];
  for (let step = 0; step < 2; step++) {
    const response = read(catalogueBrowseQuery(search));
    const model = browseModel({
      base: '/browse',
      zoneName: 'Anime',
      state: parseBrowseState(search),
      admitted: new Map(),
      locale: 'en',
      messages,
      page: { ...response, items: response.items as never },
    });
    const counts = structuredClone(model.groups);
    const result = await applyCatalogueYear({ view, search, model });
    expect(result.failure).toBeNull();
    expect(model.groups.map((group) => group.values.map((value) => value.count))).toEqual(
      counts.map((group) => group.values.map((value) => value.count)),
    );
    expect(model.results).toBe(step === 0 ? '21+ results' : '42 results');
    expect(result.publicationYears.get(model.items[0]!.id)).toEqual([1995]);
    seen.push(...model.items.map((work) => work.id));
    expect(
      model.groups
        .flatMap((group) => group.values)
        .every((value) => value.href.includes('year=1995')),
    ).toBe(true);
    if (step === 0) {
      const url = new URL(model.next!, 'https://rezics.local');
      expect(url.searchParams.get('cursor')).toBe('api-page-two');
      expect(url.searchParams.has('yearCursor')).toBe(false);
      search = Object.fromEntries(url.searchParams);
    } else {
      expect(model.next).toBeNull();
      expect(model.first).toContain('year=1995');
    }
  }
  expect(seen).toEqual(works.map((work) => work.id));
});
