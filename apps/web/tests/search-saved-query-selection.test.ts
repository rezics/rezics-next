import { expect, test } from 'bun:test';
import { parseFilter } from '@rezics/filter';
import { searchSavedQuerySelection } from '../src/search/saved-query-selection';

test('property Search saves its exact catalogue predicate without adding a private presence filter', () => {
  const selection = searchSavedQuerySelection({
    query: '',
    type: 'schema:Book',
    facets: { 'schema:keywords': ['space opera'] },
    ranges: {},
    cursor: undefined,
    sort: undefined,
  });
  expect(selection).toEqual({
    state: 'admitted',
    filter: parseFilter({
      and: [{ type: { in: ['schema:Book'] } }, { statement: { property: 'schema:keywords', in: ['space opera'] } }],
    }),
    sort: 'id',
    source: { kind: 'catalogue' },
  });
});

test('text ranking cannot be saved as a property-only dynamic rule', () => {
  expect(
    searchSavedQuerySelection({
      query: 'space opera',
      type: undefined,
      facets: { 'schema:keywords': ['space opera'] },
      cursor: undefined,
      sort: undefined,
    }).state,
  ).toBe('invalid');
});
