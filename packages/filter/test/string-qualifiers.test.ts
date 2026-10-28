import { expect, test } from 'bun:test';
import { admitFilter, parseFilter, validateFilter, type FilterRelease } from '../src/index.ts';

const uuid = '018f0000-0000-7000-8000-00b000000001';
const language = '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$';
const digest = `sha256:${'a'.repeat(64)}`;
const release: FilterRelease = {
  types: { 'ex:Sample': { facets: ['ex:reading'] } },
  properties: {
    'ex:reading': {
      datatype: 'wikibase-item',
      qualifiers: ['ex:text', 'ex:language', 'ex:digest', 'ex:method', 'ex:bounded', 'ex:mono', 'ex:quantity'],
    },
    'ex:text': { datatype: 'string' },
    'ex:language': { datatype: 'string', value: { pattern: language } },
    'ex:digest': { datatype: 'string', value: { pattern: '^sha256:[0-9a-f]{64}$' } },
    'ex:method': { datatype: 'wikibase-item' },
    'ex:bounded': { datatype: 'string', value: { minLength: 2, maxLength: 3 } },
    'ex:mono': { datatype: 'monolingualtext' },
    'ex:quantity': { datatype: 'quantity' },
  },
};
const leaf = (property: string, values: unknown[]) => ({
  statement: { property: 'ex:reading', in: [uuid], qualifiers: [{ property, in: values }] },
});

test('generic typed string qualifier equality admits every declared string under existing scalar constraints', () => {
  for (const text of ['a'.repeat(256), 'é'.repeat(128), '😀'.repeat(64), ' a = B ', 'e\u0301', 'é', '0', 'false']) {
    const filter = parseFilter(leaf('ex:text', [text]));
    expect(admitFilter(filter, release)).toEqual(filter);
  }
  for (const [property, values] of [
    ['ex:language', ['en', 'ja', 'zh-Hant', 'pt-BR', 'es-419']],
    ['ex:digest', [digest]],
    ['ex:method', [uuid]],
  ] as const) {
    expect(validateFilter(leaf(property, [...values]), release)).toEqual([]);
  }
  expect(
    validateFilter(
      leaf(
        'ex:text',
        Array.from({ length: 64 }, (_, i) => String(i)),
      ),
      release,
    ),
  ).toEqual([]);
});

test('native string constraints and exact patterns reject invalid operands without coercion', () => {
  for (const [property, values] of [
    ['ex:text', ['', 'a'.repeat(257), 'é'.repeat(129), '😀'.repeat(65), 'a\nb', '\u0085', 0, false]],
    ['ex:language', ['EN', 'zh-hant', ' en', 'en\n']],
    ['ex:digest', [digest.toUpperCase(), digest.slice(1), `${digest} `]],
    ['ex:bounded', ['a', 'abcd']],
    ['ex:method', ['label', uuid.toUpperCase()]],
  ] as const) {
    for (const value of values) expect(validateFilter(leaf(property, [value]), release).length).toBe(1);
  }
  for (const text of ['ab', 'abc', '😀a']) expect(validateFilter(leaf('ex:bounded', [text]), release)).toEqual([]);
  for (const property of ['ex:mono', 'ex:quantity', 'ex:missing']) {
    expect(validateFilter(leaf(property, ['x']), release)).toEqual([
      { problem: 'unsupported_query', pointer: '/statement/qualifiers/0/property', code: 'unsupported' },
    ]);
  }
  expect(validateFilter(leaf('ex:text', Array(65).fill('x')), release)[0]?.problem).toBe('unsupported_query');
});

test('string qualifiers retain same-statement grammar limits saved pointers and relation barrier', () => {
  const filter = {
    statement: {
      property: 'ex:reading',
      in: [uuid],
      qualifiers: [
        { property: 'ex:language', in: ['en'] },
        { property: 'ex:digest', in: [digest] },
        { property: 'ex:method', in: [uuid] },
        { property: 'ex:text', in: ['x'] },
      ],
    },
  };
  expect(validateFilter(filter, release)).toEqual([]);
  expect(
    validateFilter(
      {
        statement: {
          ...filter.statement,
          qualifiers: [...filter.statement.qualifiers, { property: 'ex:text', in: ['y'] }],
        },
      },
      release,
    )[0]?.problem,
  ).toBe('unsupported_query');
  expect(validateFilter({ and: Array(7).fill(filter) }, release)[0]?.problem).toBe('unsupported_query');
  const relation = {
    ...release,
    properties: {
      ...release.properties,
      'ex:reading': { ...release.properties['ex:reading']!, relation: { group: 'credit' } },
    },
  };
  expect(validateFilter(filter, relation)).toEqual([
    { problem: 'invalid_request', pointer: '/statement/qualifiers', code: 'unsupported' },
  ]);
  const saved = { ...release, filters: { 'samples/bad': { filter: leaf('ex:language', ['EN']) } } };
  expect(validateFilter({ saved: 'samples/bad' }, saved)).toEqual([
    { problem: 'invalid_request', pointer: '/saved', code: 'invalid_format' },
  ]);
  expect(
    validateFilter(
      { statement: { property: 'ex:text', in: ['x'] } },
      { ...release, types: { 'ex:Sample': { facets: ['ex:text'] } } },
    )[0]?.problem,
  ).toBe('unsupported_query');
});
