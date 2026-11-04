import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { realmCatalogueReturnHref, realmCatalogueSubjectHref } from '../src/search/realm-catalogue-handoff';
import { ResultRow } from '../src/search/results';

const realm = '11111111-1111-4111-8111-111111111111';
const subject = '22222222-2222-4222-8222-222222222222';
const population = '33333333-3333-4333-8333-333333333333';
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

test('Realm catalogue return accepts Global Search and rejects cross-locale, private, and oversized URLs', () => {
  expect(realmCatalogueReturnHref('/en/search?q=Mira', 'en')).toBe('/en/search?q=Mira#search-results');
  expect(realmCatalogueReturnHref(scopedVisit.replace('/en/search', '/ja/search'), 'en')).toBeUndefined();
  expect(realmCatalogueReturnHref(`${scopedVisit}&reader=private`, 'en')).toBeUndefined();
  expect(realmCatalogueReturnHref(`${scopedVisit}&layout=${'x'.repeat(2048)}`, 'en')).toBeUndefined();
});
