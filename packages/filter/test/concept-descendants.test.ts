import { expect, test } from 'bun:test';
import { admitFilter, parseFilter, type FilterRelease } from '../src/index.ts';

const scheme = '018f0000-0000-7000-8000-00a000000010';
const root = '018f0000-0000-7000-8000-00a000000011';
const release: FilterRelease = {
  types: { 'schema:Book': { facets: ['schema:genre'] } },
  properties: {
    'schema:genre': {
      datatype: 'wikibase-item',
      relation: { group: 'classification' },
      qualifiers: ['rezics:spoilerLevel'],
    },
    'rezics:spoilerLevel': { datatype: 'quantity', units: ['1'] },
  },
};

test('concept statements preserve exact and descendant selection through Boolean qualifiers', () => {
  const exact = {
    statement: {
      property: 'schema:genre',
      in: [root],
      concept: { scheme },
      qualifiers: [{ property: 'rezics:spoilerLevel', in: ['0'] }],
    },
  };
  const descendants = {
    statement: {
      property: 'schema:genre',
      in: [root],
      concept: { scheme, includeChildren: true },
      qualifiers: [{ property: 'rezics:spoilerLevel', in: ['0'] }],
    },
  };
  const input = { and: [exact, { not: descendants }] };
  expect(admitFilter(parseFilter(input), release)).toEqual(input);
});

test('concept statements require one item value and a UUID scheme', () => {
  for (const statement of [
    { property: 'schema:genre', in: [root], concept: {} },
    { property: 'schema:genre', in: [root], concept: { scheme: 'provider:invented' } },
    { property: 'schema:genre', in: [root, root], concept: { scheme } },
    { property: 'schema:genre', in: [root], concept: { scheme, includeChildren: 'yes' } },
  ])
    expect(() => parseFilter({ statement })).toThrow();
  expect(() =>
    admitFilter(parseFilter({ statement: { property: 'schema:genre', in: [root], concept: { scheme } } }), {
      ...release,
      types: { 'schema:Book': { facets: ['schema:name'] } },
    }),
  ).toThrow();
});

test('ordinary exact statement values keep their existing grammar', () => {
  expect(admitFilter(parseFilter({ statement: { property: 'schema:genre', in: [root] } }), release)).toEqual({
    statement: { property: 'schema:genre', in: [root] },
  });
});
