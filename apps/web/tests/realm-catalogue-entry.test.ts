import { expect, test } from 'bun:test';
import { parse, safeParse } from 'valibot';
import {
  realmCatalogueEntry,
  realmCatalogueQueryAdmitted,
  realmCatalogueQueryHref,
} from '../src/community/realm-catalogue-entry';
import { searchLoaderDeps, searchParams } from '../src/search/search-params';
import { parseSearchResourceScope } from '../src/search/advanced-scope';

const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const other = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
const admitted = (href: string) =>
  searchLoaderDeps(parse(searchParams, Object.fromEntries(new URL(href, 'https://site.test').searchParams)));

test('each locale hands canonical membership to ordinary Search without a rating population or inherited state', () => {
  for (const locale of locales) {
    const entry = realmCatalogueEntry(realm.toUpperCase(), locale)!;
    const url = new URL(entry.browseHref, 'https://site.test');
    expect(url.pathname).toBe(`/${locale}/search`);
    expect([...url.searchParams.keys()]).toEqual(['filter']);
    expect(admitted(entry.browseHref)).toMatchObject({
      query: '',
      resourceScope: { kind: 'realm', id: realm },
      sort: undefined,
    });
    expect(admitted(entry.browseHref).ratingPopulation).toBeUndefined();
    expect(entry.action).toBe(url.pathname);
    expect(parseSearchResourceScope(entry.filter).scope?.id).toBe(realm);
  }
});

test('1/128/512 UTF-8 bytes, spaces and URL syntax round trip through the installed parser', () => {
  const entry = realmCatalogueEntry(realm, 'ja')!;
  for (const query of ['x', 'x'.repeat(128), 'x'.repeat(512), '界'.repeat(170) + 'ab', '  雪 + & ? / # %  ']) {
    expect(realmCatalogueQueryAdmitted(query)).toBe(true);
    expect(admitted(realmCatalogueQueryHref(entry, query)!).query).toBe(query);
  }
  expect(admitted(realmCatalogueQueryHref(entry, '')!).query).toBe('');
  for (const query of ['x'.repeat(513), '界'.repeat(171), '😀'.repeat(129)]) {
    expect(safeParse(searchParams, { q: query }).success).toBe(false);
    expect(realmCatalogueQueryAdmitted(query)).toBe(false);
    expect(realmCatalogueQueryHref(entry, query)).toBeNull();
  }
});

test('missing and malformed identities have no fallback destination; malformed scopes remain refused by Search', () => {
  for (const value of [null, undefined, '', 'space-address', `${realm}/extra`, 'not-a-realm'])
    expect(realmCatalogueEntry(value, 'en')).toBeNull();
  for (const filter of [
    '{',
    JSON.stringify({ realm: { id: 'space-address' } }),
    JSON.stringify({ or: [{ realm: { id: realm } }] }),
  ]) {
    const deps = searchLoaderDeps(parse(searchParams, { filter }));
    expect(deps.invalidInput?.key).toBe('filter');
    expect(deps.resourceScope).toBeUndefined();
  }
});

test('Search admits rating population and membership independently without changing filter/condition bounds', () => {
  const entry = realmCatalogueEntry(realm, 'en')!;
  const search = { filter: entry.filter, sort: 'rating', ratingPopulation: other };
  const deps = searchLoaderDeps(parse(searchParams, search));
  expect(deps.resourceScope?.id).toBe(realm);
  expect(deps.ratingPopulation).toBe(other);
  expect(searchLoaderDeps(parse(searchParams, { sort: 'rating' })).resourceScope).toBeUndefined();
  expect(searchLoaderDeps(parse(searchParams, { ...search, ratingPopulation: 'bad' })).invalidInput?.key).toBe(
    'ratingPopulation',
  );
  expect(safeParse(searchParams, { filter: 'x'.repeat(16385) }).success).toBe(false);
  expect(safeParse(searchParams, { condition: 'x'.repeat(32769) }).success).toBe(false);
});
