import { expect, test } from 'bun:test';
import { admitFilter, parseFilter, validateFilter, type FilterRelease } from '../src/index.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const spoiler = 'rezics:spoilerLevel';
const release: FilterRelease = {
  types: {
    'wd:Q95074': { facets: ['schema:gender'] },
    'schema:Movie': { facets: ['schema:character', 'schema:keywords', 'wdt:P725'] },
  },
  properties: {
    'schema:gender': { datatype: 'wikibase-item', qualifiers: [spoiler], relation: { group: 'classification' } },
    'schema:keywords': { datatype: 'wikibase-item', qualifiers: [spoiler], relation: { group: 'classification' } },
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
  const thresholded = parseFilter({ statement: { property: 'schema:character', in: [id] } });
  expect(() => admitFilter(thresholded, replacement, { spoilerThreshold: 0 })).toThrow();
});

test('journey thresholds admit only explicit levels through the selected value', () => {
  for (const [threshold, levels] of [
    [0, ['0']],
    [1, ['0', '1']],
    [2, ['0', '1', '2']],
  ] as const) {
    for (const property of ['schema:keywords', 'schema:gender', 'schema:character']) {
      const filter = parseFilter({ statement: { property, in: [id] } });
      expect(admitFilter(filter, release, { spoilerThreshold: threshold })).toEqual({
        statement: { property, in: [id], qualifiers: [{ property: spoiler, in: levels }] },
      });
    }
  }

  const selected = parseFilter({
    not: {
      statement: {
        property: 'schema:character',
        in: [id],
        qualifiers: [{ property: spoiler, in: ['0', '2'] }],
      },
    },
  });
  expect(admitFilter(selected, release, { spoilerThreshold: 1 })).toEqual({
    not: { statement: { property: 'schema:character', in: [id], qualifiers: [{ property: spoiler, in: ['0'] }] } },
  });
  const voice = parseFilter({ statement: { property: 'wdt:P725', in: [id] } });
  expect(admitFilter(voice, release, { spoilerThreshold: 0 })).toEqual(voice);
  expect(() =>
    admitFilter(
      parseFilter({
        statement: { property: 'schema:character', in: [id], qualifiers: [{ property: spoiler, in: ['2'] }] },
      }),
      release,
      { spoilerThreshold: 0 },
    ),
  ).toThrow();
});

test('inverse relations select released source facets independently of candidate type', () => {
  const input = {
    and: [{ type: { in: ['wd:Q95074'] } }, { statement: { property: 'schema:character', inverse: true, in: [id] } }],
  };
  const filter = parseFilter(input);
  expect(() => admitFilter(filter, release)).toThrow();
  expect(admitFilter(filter, release, { inverse: true, spoilerThreshold: 1 })).toEqual({
    and: [
      input.and[0],
      {
        statement: {
          property: 'schema:character',
          inverse: true,
          in: [id],
          qualifiers: [{ property: spoiler, in: ['0', '1'] }],
        },
      },
    ],
  });
  for (const invalid of [
    { inverse: false, in: [id] },
    { inverse: true, range: { gte: 1 } },
    { inverse: true, in: [id], concept: { scheme: id } },
  ])
    expect(() => parseFilter({ statement: { property: 'schema:character', ...invalid } })).toThrow();
  const retired = structuredClone(release);
  retired.types['schema:Movie']!.facets = [];
  expect(() => admitFilter(filter, retired, { inverse: true })).toThrow();
});
