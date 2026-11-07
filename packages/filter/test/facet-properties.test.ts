import { expect, test } from 'bun:test';
import { admitFilter, facetProperties, type FilterRelease } from '../src/index.ts';

const item = { datatype: 'wikibase-item', qualifiers: [] };
const release: FilterRelease = {
  types: {
    'schema:CreativeWork': { facets: ['schema:genre', 'schema:author', 'schema:inLanguage'] },
    'schema:Book': { bases: ['schema:CreativeWork'], facets: ['schema:author', 'wdt:P179'] },
    'schema:Movie': { bases: ['schema:CreativeWork'], facets: ['schema:director'] },
    'schema:Person': {},
  },
  properties: {
    'schema:genre': { ...item, relation: { group: 'classification' } },
    'schema:author': { ...item, relation: { group: 'credit' } },
    'wdt:P179': { ...item, relation: { group: 'membership' } },
    'schema:director': { ...item, relation: { group: 'credit' } },
    'schema:inLanguage': {
      datatype: 'string',
      qualifiers: [],
      value: { pattern: '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$' },
    },
  },
};

test("facet properties are the types' own facets, then their bases', without repeats", () => {
  expect(facetProperties(release, ['schema:Book'])).toEqual([
    'schema:author',
    'wdt:P179',
    'schema:genre',
    'schema:inLanguage',
  ]);
  expect(facetProperties(release, ['schema:Book', 'schema:Movie'])).toEqual([
    'schema:author',
    'wdt:P179',
    'schema:genre',
    'schema:inLanguage',
    'schema:director',
  ]);
  expect(facetProperties(release, ['schema:Person'])).toEqual([]);
  expect(facetProperties(release, ['schema:Unknown'])).toEqual([]);
  expect(facetProperties(release, [])).toEqual([]);
});

test('every facet property is admitted as a statement condition on its types', () => {
  for (const types of [['schema:Book'], ['schema:Movie'], ['schema:Book', 'schema:Movie']]) {
    for (const property of facetProperties(release, types)) {
      const filter = {
        and: [
          { type: { in: types } },
          {
            statement: {
              property,
              in: [release.properties[property]?.datatype === 'string' ? 'en' : '00000000-0000-8000-8000-000000000000'],
            },
          },
        ],
      };
      expect(() => admitFilter(filter, release)).not.toThrow();
    }
  }
});
