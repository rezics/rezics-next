import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { realmCatalogueReturnHref, realmCatalogueSubjectHref } from '../src/search/realm-catalogue-handoff';
import { ResultRow } from '../src/search/results';
import { realmCatalogueSearchLoaderDeps } from '../src/search/search-params';
import { realmSearchRequest } from '../src/search/search-request';
import { parseLegacySearchPage } from '../src/search/discovery';

const realm = '11111111-1111-4111-8111-111111111111';
const subject = '22222222-2222-4222-8222-222222222222';
const population = '33333333-3333-4333-8333-333333333333';
const otherRealm = '44444444-4444-4444-8444-444444444444';
const scopedVisit = `/en/search?q=Mira&filter=${encodeURIComponent(JSON.stringify({ realm: { id: realm } }))}&sort=rating&ratingPopulation=${population}&cursor=next%2Fpage%2Bopaque&f.genre=mystery&layout=compact`;

test('Realm catalogue subject links retain the same scoped Search intent and return to its result region', () => {
  const returnHref = `${scopedVisit}#search-results`;
  const href = realmCatalogueSubjectHref({ id: subject, label: 'Mira' }, 'en', scopedVisit);
  const via = new URL(href, 'https://rezics.invalid').searchParams.get('via');

  expect(via).toBe(returnHref);
  expect(subjectVisitReturn(via, 'en')).toBe(returnHref);
  const html = renderToStaticMarkup(
    createElement(ResultRow, {
      hit: { id: subject, type: 'schema:Book', labels: { en: 'Mira' } },
      locale: 'en',
      hitTypes: {},
      yearProperties: [],
      subjectHrefFor: (value) => realmCatalogueSubjectHref(value, 'en', scopedVisit),
    }),
  );
  expect(html).toContain(`href="${href}"`);
});

test('Realm page work links retain separate shelf and Search cursors and reject a different Realm scope', () => {
  const visit = `/en/realms/${realm}?node=boards&cursor=shelf%2Fnext%2Bopaque&q=Mira&filter=${encodeURIComponent(
    JSON.stringify({ realm: { id: realm } }),
  )}&searchCursor=search%2Fnext%2Bopaque&f.schema%3Agenre=mystery`;
  const expected = `${visit}#search-results`;
  const differentRealm = visit.replace(
    encodeURIComponent(JSON.stringify({ realm: { id: realm } })),
    encodeURIComponent(JSON.stringify({ realm: { id: otherRealm } })),
  );

  expect(realmCatalogueReturnHref(visit, 'en')).toBe(expected);
  expect(realmCatalogueReturnHref(differentRealm, 'en')).toBeUndefined();
  expect(realmCatalogueReturnHref(`/en/realms/${realm}?q=Mira`, 'en')).toBeUndefined();
});

test('Realm route preserves Search query state beside its independent shelf cursor', () => {
  const parsed = realmCatalogueSearchLoaderDeps({
    node: 'boards',
    cursor: 'shelf/next+opaque',
    searchCursor: 'search/next+opaque',
    q: 'Mira',
    filter: JSON.stringify({ realm: { id: realm } }),
    'f.schema:genre': 'mystery',
  });

  expect(parsed).toMatchObject({
    query: 'Mira',
    resourceScope: { kind: 'realm', id: realm },
    facets: { 'schema:genre': ['mystery'] },
    cursor: 'search/next+opaque',
  });
});

test('Realm Search requests retain the Realm and released predicates while translating selected kinds', () => {
  const request = realmSearchRequest(
    {
      query: 'Mira',
      type: undefined,
      facets: { 'schema:genre': ['mystery'] },
      cursor: 'opaque/search-cursor',
      sort: undefined,
      kinds: ['schema:Book', 'schema:VisualNovel'],
      languages: ['en'],
      filter: JSON.stringify({ realm: { id: realm } }),
      resourceScope: { kind: 'realm', id: realm },
      ratingPopulation: undefined,
    },
    ['en'],
  );

  expect(request).toMatchObject({
    limit: 20,
    text: 'Mira',
    cursor: 'opaque/search-cursor',
    languages: ['en'],
    filter: {
      and: [
        { realm: { id: realm } },
        { statement: { property: 'schema:genre', in: ['mystery'] } },
        { type: { in: ['schema:Book', 'schema:VisualNovel'] } },
      ],
    },
  });
  expect(request.filter).not.toHaveProperty('kind');
  expect(request).not.toHaveProperty('representation');
  expect(request).not.toHaveProperty('kindPage');
  expect(request).not.toHaveProperty('kindCountLeaf');
});

test('native Realm Search kind metadata is retained for the shared kind selector', () => {
  const parsed = parseLegacySearchPage({
    subjects: [],
    next: null,
    as_of: 'realm-search-cut',
    kinds: {
      values: [
        {
          id: 'schema:Book',
          labels: { en: 'Book' },
          icon: 'book',
          count: { kind: 'schema:Book', value: 3, exact: true },
        },
      ],
      next: null,
    },
  });

  expect(parsed?.kinds?.values).toEqual([
    {
      id: 'schema:Book',
      labels: { en: 'Book' },
      icon: 'book',
      count: { kind: 'schema:Book', value: 3, exact: true },
    },
  ]);
});

test('Realm catalogue return rejects global, cross-locale, private, and oversized URLs', () => {
  expect(realmCatalogueReturnHref('/en/search?q=Mira', 'en')).toBeUndefined();
  expect(realmCatalogueReturnHref(scopedVisit.replace('/en/search', '/ja/search'), 'en')).toBeUndefined();
  expect(realmCatalogueReturnHref(`${scopedVisit}&reader=private`, 'en')).toBeUndefined();
  expect(realmCatalogueReturnHref(`${scopedVisit}&layout=${'x'.repeat(2048)}`, 'en')).toBeUndefined();
});

test('canonical Space returns retain the Realm predicate and independent shelf/works cursors', () => {
  const visit = `/en/spaces/anime?filter=${encodeURIComponent(JSON.stringify({ realm: { id: realm } }))}&node=boards&cursor=shelf&searchCursor=works&kinds=schema%3AVisualNovel`;
  expect(realmCatalogueReturnHref(visit, 'en')).toBe(`${visit}#search-results`);
  expect(realmCatalogueReturnHref('/en/spaces/anime?searchCursor=works', 'en')).toBeUndefined();
  expect(realmCatalogueReturnHref(visit.replace('/en/', '/ja/'), 'en')).toBeUndefined();
});
