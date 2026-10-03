import { beforeEach, describe, expect, test } from 'bun:test';
import { GET, HEAD } from '../app/[locale]/search/route.ts';
import { discoverSearchUrl } from '../features/search/redirect.ts';
import { browseHref, browseQuery, parseBrowseState } from '../features/discover/browse-state.ts';
import { workTypes } from '../features/discover/state.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { clearTypes } from '../features/catalogue/types.ts';
import { browseCategories } from '../features/catalogue/registry.ts';
import { uiLocales } from '../i18n/define.ts';

const realm = '00000000-0000-4000-8000-000000000001';
const concept = '00000000-0000-4000-8000-000000000002';
const excluded = '00000000-0000-4000-8000-000000000003';
const stateAt = (url: URL) => {
  const params: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    params[key] = values.length === 1 ? values[0]! : values;
  }
  return parseBrowseState(params);
};

describe('G-1001 one search entry', () => {
  beforeEach(seedServedTypes);
  test('every locale answers one HTTP 301 to Discover All, preserving the phrase', async () => {
    for (const locale of uiLocales) {
      const source = new URL(`https://rezics.test/${locale}/search?q=%E9%9B%A8+%26+night`);
      const response = await GET(new Request(source), { params: Promise.resolve({ locale }) });
      expect(response.status).toBe(301);
      expect(response.headers.get('location')).toBe(`https://rezics.test/${locale}/discover${source.search}`);
      expect(stateAt(new URL(response.headers.get('location')!))).toMatchObject({ q: '雨 & night', tab: 'all' });
    }
  });
  test('empty and one-character CJK searches enter the same browse', async () => {
    for (const query of ['', '?q=雨']) {
      const response = await HEAD(new Request(`https://rezics.test/ja/search${query}`, { method: 'HEAD' }), {
        params: Promise.resolve({ locale: 'ja' }),
      });
      expect(response.status).toBe(301);
      expect(response.headers.get('location')).toBe(new URL(`https://rezics.test/ja/discover${query}`).href);
    }
  });
  test('Work type, content language, Realm and topic Conditions survive redirect, round trip and Query', () => {
    const source = new URL(`https://rezics.test/de/search?q=library&scope=realm&realm=${realm}`
      + `&include=book,document&exclude=recipe&lang=sv&term=${concept}&ce=${excluded}&cm=any`);
    const destination = discoverSearchUrl(source, 'de');
    const state = stateAt(destination)!;
    expect(state).toMatchObject({ tab: 'works', q: 'library', scope: { kind: 'realm', realm },
      includeTypes: ['book', 'document'], excludeTypes: ['recipe'], language: 'sv',
      conditions: { include: [concept], exclude: [excluded], match: 'any' } });
    expect(stateAt(new URL(browseHref(state), source))).toEqual(state);
    expect(browseQuery(state).filter).toEqual({ all: [
      { facet: 'type', any: browseCategories().find(category => category.id === 'works')!.types },
      { facet: 'type', any: workTypes().filter(type => ['book', 'document'].includes(type.key)).map(type => type.iri) },
      { facet: 'type', none: [workTypes().find(type => type.key === 'recipe')!.iri] },
      { facet: 'language', any: ['sv'] },
      { facet: 'concept', any: [`https://rezics.com/id/${concept}`] },
      { facet: 'concept', none: [`https://rezics.com/id/${excluded}`] },
    ] });
    expect(source.pathname).toBe('/de/search');
  });
  test('a former single Work type becomes the Works tab and the same type Condition', () => {
    const destination = discoverSearchUrl(new URL('https://rezics.test/en/search?q=book&type=book'), 'en');
    expect(destination.searchParams.get('tab')).toBe('works');
    expect(destination.searchParams.get('include')).toBe('book');
    expect(destination.searchParams.has('type')).toBe(false);
    expect(stateAt(destination)?.includeTypes).toEqual(['book']);
  });
  test('repeated, unknown, conflicting and unsupported selectors never widen the selection', () => {
    for (const query of ['q=one&q=two', 'include=book&include=recipe&type=book', 'type=unknown',
      'include=unknown', 'exclude=book&include=book', 'lang=not_a_language', 'term=bad',
      `term=${concept}&term=${excluded}`, `term=${concept}&ci=${excluded}&ci=${realm}`, 'scope=mine']) {
      expect(stateAt(discoverSearchUrl(new URL(`https://rezics.test/en/search?${query}`), 'en'))).toBeNull();
    }
  });
  test('a missing type registry refuses a narrowed Query', () => {
    const state = stateAt(discoverSearchUrl(new URL('https://rezics.test/en/search?include=book'), 'en'))!;
    clearTypes();
    expect(() => browseQuery(state)).toThrow();
  });
  test('unsupported interface locales do not redirect into a broken route', async () => {
    const response = await GET(new Request('https://rezics.test/no/search'), { params: Promise.resolve({ locale: 'no' }) });
    expect(response.status).toBe(404);
  });
});
