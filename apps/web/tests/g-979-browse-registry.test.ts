import { beforeEach, describe, expect, test } from 'bun:test';
import { browseCategories } from '../features/catalogue/registry.ts';
import { servedTypes, seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { clearTypes, seedTypes, type TypeEntry } from '../features/catalogue/types.ts';
import { forgetServedTypes, readTypes } from '../features/catalogue/types-read.ts';
import { BrowseReadError } from '../features/discover/api.ts';
import {
  browseHref,
  browseQuery,
  browseTabs,
  emptyBrowse,
  parseBrowseState,
} from '../features/discover/browse-state.ts';

describe('G-979: Discover maps the served browse registry', () => {
  beforeEach(() => {
    clearTypes();
    forgetServedTypes();
  });

  test('structural categories alone supply the tab order, every locale and Type Facet values', () => {
    seedServedTypes();
    expect(browseTabs()).toEqual([
      'all',
      'works',
      'communities',
      'sites',
      'people',
      'lists',
      'topics',
    ]);
    const categories = browseCategories();
    for (const category of categories) {
      const state = parseBrowseState({ tab: category.id })!;
      expect(state.tab).toBe(category.id);
      expect(browseQuery(state).filter).toEqual({ all: [{ facet: 'type', any: category.types }] });
      for (const [locale, label] of Object.entries(category.labels)) {
        expect(label).not.toBe('');
        expect(label).toBe(
          servedTypes.types.find((entry) => entry.browse?.id === category.id)!.browse!.labels[
            locale as keyof typeof category.labels
          ],
        );
      }
    }
    expect(categories.find((category) => category.id === 'works')!.types).toEqual([
      'https://schema.org/CreativeWork',
    ]);
    expect(browseQuery(emptyBrowse).filter).toBeUndefined();
  });

  test('new category identities, labels and multiple member types survive every URL and query adapter', () => {
    const structural = servedTypes.types.find((entry) => entry.browse?.id === 'works')!;
    const programs = {
      ...structural.browse!,
      id: 'programs',
      order: 9,
      labels: { ...structural.browse!.labels, en: 'Programs', ja: 'プログラム' },
    };
    const earlier = { ...programs, id: 'resources', order: 2 };
    const types: TypeEntry[] = [
      { ...structural, type: 'https://example.test/Tool', browse: programs },
      { ...structural, type: 'https://example.test/Other', browse: earlier },
      { ...structural, type: 'https://example.test/Program', browse: programs },
    ];
    seedTypes({ ...servedTypes, digest: 'b'.repeat(64), types });
    expect(browseTabs()).toEqual(['all', 'resources', 'programs']);
    expect(parseBrowseState({ tab: 'works' })).toBeNull();
    const state = { ...emptyBrowse, tab: 'programs', q: '編集', cursor: 'next' };
    expect(
      parseBrowseState(Object.fromEntries(new URL(browseHref(state), 'http://test').searchParams)),
    ).toEqual(state);
    expect(browseQuery(state).filter).toEqual({
      all: [{ facet: 'type', any: ['https://example.test/Tool', 'https://example.test/Program'] }],
    });
    expect(browseCategories()[1]!.labels.ja).toBe('プログラム');
    expect(types[0]!.browse).toEqual(programs);
  });

  test('missing registry metadata refuses a selected category rather than widening the query', () => {
    expect(browseTabs()).toEqual(['all']);
    expect(() => browseQuery({ ...emptyBrowse, tab: 'works' })).toThrow(BrowseReadError);
    expect(browseQuery(emptyBrowse)).not.toHaveProperty('filter');
    seedServedTypes();
    expect(() => browseQuery({ ...emptyBrowse, tab: 'unserved' })).toThrow(BrowseReadError);
    const legacy = servedTypes.types.map(({ browse: _browse, ...entry }) => entry);
    seedTypes({ ...servedTypes, digest: 'c'.repeat(64), types: legacy });
    expect(browseCategories()).toEqual([]);
    expect(() => browseQuery({ ...emptyBrowse, tab: 'works' })).toThrow(BrowseReadError);
  });

  test('one public registry read supplies concurrent callers; 304 and a failed refresh retain category semantics', async () => {
    const statuses = [200, 304, 503, 200],
      requests: RequestInit[] = [];
    const changed = {
      ...servedTypes,
      digest: 'd'.repeat(64),
      types: servedTypes.types.map((entry) =>
        entry.browse?.id === 'works'
          ? {
              ...entry,
              browse: { ...entry.browse, labels: { ...entry.browse.labels, en: 'Creative works' } },
            }
          : entry,
      ),
    };
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      requests.push(init);
      const status = statuses.shift()!;
      const registry = requests.length === 4 ? changed : servedTypes;
      return new Response(status === 304 ? null : JSON.stringify(registry), {
        status,
        headers: { etag: `"${registry.digest}"`, 'cache-control': 'public, max-age=300' },
      });
    }) as typeof fetch;
    const [first, second] = await Promise.all([
      readTypes(fetcher, () => 0),
      readTypes(fetcher, () => 0),
    ]);
    expect(first).toBe(second);
    expect(requests).toHaveLength(1);
    const query = browseQuery({ ...emptyBrowse, tab: 'works' });
    await readTypes(fetcher, () => 301_000);
    expect(new Headers(requests[1]!.headers).get('if-none-match')).toBe(`"${servedTypes.digest}"`);
    await readTypes(fetcher, () => 602_000);
    expect(browseQuery({ ...emptyBrowse, tab: 'works' })).toEqual(query);
    await readTypes(fetcher, () => 613_000);
    expect(browseCategories()[0]!.labels.en).toBe('Creative works');
    expect(browseQuery({ ...emptyBrowse, tab: 'works' })).toEqual(query);
  });
});
