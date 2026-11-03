import { expect, test } from 'bun:test';
import { admitFilter, parseFilter, validateFilter, type FilterRelease } from '../src/index.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const spoiler = 'rezics:spoilerLevel';
const release: FilterRelease = {
  types: { 'wd:Q95074': { facets: ['schema:gender'] }, 'schema:Movie': { facets: ['schema:character', 'wdt:P725'] } },
  properties: {
    'schema:gender': { datatype: 'wikibase-item', qualifiers: [spoiler], relation: { group: 'classification' } },
    'schema:character': { datatype: 'wikibase-item', qualifiers: [spoiler], relation: { group: 'appearance' } },
    'wdt:P725': { datatype: 'wikibase-item', qualifiers: ['wdt:P453'], relation: { group: 'credit' } },
    'wdt:P453': { datatype: 'wikibase-item' },
    [spoiler]: { datatype: 'quantity', units: ['1'] },
  },
};
const leaf = (property: string, values: string[]) => ({
  statement: { property, in: [id], qualifiers: [{ property: spoiler, in: values }] },
});

test('released appearance and gender admit exact spoiler levels without extending voice credits', () => {
  for (const property of ['schema:gender', 'schema:character']) {
    const filter = parseFilter(leaf(property, ['0', '1', '2']));
    expect(admitFilter(filter, release)).toEqual(filter);
    for (const invalid of ['3', '-1', '0.5', '+1', '01', '1e0', '1.0000000000000000001'])
      expect(validateFilter(leaf(property, [invalid]), release)[0]?.code).toBe('invalid_format');
  }
  expect(validateFilter(leaf('wdt:P725', ['0']), release)).toEqual([
    { problem: 'unsupported_query', pointer: '/statement/qualifiers/0/property', code: 'unsupported' },
  ]);
  const replacement = structuredClone(release);
  replacement.properties['schema:character']!.qualifiers = [];
  expect(validateFilter(leaf('schema:character', ['0']), replacement)[0]?.problem).toBe('unsupported_query');
});
