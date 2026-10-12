import { expect, test } from 'bun:test';
import { catalogueBrowseQuery } from './catalogue-browse.tsx';

test('the catalogue year and existing Conditions go together to Zone browse', () => {
  expect(
    catalogueBrowseQuery({
      year: '1995',
      cursor: 'api-page-two',
      q: 'story',
      status: 'completed',
      type: 'schema:Book',
      sort: 'updated',
    }),
  ).toEqual({
    publicationYear: '1995',
    cursor: 'api-page-two',
    q: 'story',
    status: ['completed'],
    type: ['https://schema.org/Book'],
    sort: 'updated',
  });
});

test('the all-years directory uses the same read; a selected year wins over the directory flag', () => {
  expect(catalogueBrowseQuery({ years: '1' })).toEqual({ publicationYear: '1-9999' });
  expect(catalogueBrowseQuery({ year: '2001', years: '1' })).toEqual({ publicationYear: '2001' });
  expect(catalogueBrowseQuery({ year: '10000' })).toEqual({});
  expect(catalogueBrowseQuery({})).toEqual({});
});
