import { expect, test } from 'bun:test';
import {
  admitFilter,
  FILTER_LIMITS,
  FilterError,
  type FilterRelease,
  parseFilter,
  positiveFilter,
  validateFilter,
} from '../src/index.ts';

const author = '018f0000-0000-7000-8000-00a000000009';
const lead = '018f0000-0000-7000-8000-00a00000000a';
const fantasy = '018f0000-0000-7000-8000-00a00000000b';
const book = { type: { in: ['schema:Book'] } };
const byAuthor = { statement: { property: 'schema:author', in: [author] } };
const quick = { statement: { property: 'schema:totalTime', range: { lte: 30, unit: 'unit:MIN' } } };

const release: FilterRelease = {
  types: {
    'schema:CreativeWork': { bases: [], facets: ['schema:genre'] },
    'schema:Book': { bases: ['schema:CreativeWork'], facets: ['schema:author', 'schema:datePublished'] },
    'schema:Recipe': { bases: ['schema:CreativeWork'], facets: ['schema:totalTime'] },
    'schema:VideoGame': { bases: ['schema:CreativeWork'], facets: ['schema:character'] },
    'schema:Person': { bases: [] },
  },
  properties: {
    'schema:author': { datatype: 'wikibase-item', qualifiers: ['rezics:role'] },
    'schema:genre': { datatype: 'wikibase-item', qualifiers: [] },
    'schema:datePublished': { datatype: 'time', qualifiers: [] },
    'schema:totalTime': { datatype: 'quantity', qualifiers: [], units: ['unit:MIN', 'unit:HUR'] },
    'schema:character': { datatype: 'wikibase-item', qualifiers: ['rezics:role', 'schema:isbn'] },
    'rezics:role': { datatype: 'wikibase-item', qualifiers: [] },
    'schema:isbn': { datatype: 'external-id', qualifiers: [] },
    'schema:name': { datatype: 'string', qualifiers: [] },
  },
  filters: {
    'books/fantasy': { filter: { and: [book, { statement: { property: 'schema:genre', in: [fantasy] } }] } },
    'books/by-author': { filter: byAuthor },
    'recipes/quick': { filter: quick },
    'deep/nested': { filter: { and: [{ or: [{ and: [{ not: book }, book] }, book] }] } },
    'negated/book': { filter: { not: book } },
    'loop/saved': { filter: { saved: 'books/fantasy' } },
    'broken/filter': { filter: { colour: 'red' } },
  },
};

function refuses(run: () => unknown, problem: 'invalid_request' | 'unsupported_query', errors: object[]) {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(FilterError);
  expect(error).toMatchObject({ problem, errors });
}
const rejects = (input: unknown, problem: 'invalid_request' | 'unsupported_query', errors: object[]) =>
  refuses(() => parseFilter(input), problem, errors);
const admit = (input: unknown, options?: { saved?: boolean }) => admitFilter(parseFilter(input), release, options);
const refusesAdmission = (input: unknown, problem: 'invalid_request' | 'unsupported_query', errors: object[]) =>
  refuses(() => admit(input), problem, errors);

test('the kernel filter grammar parses unchanged', () => {
  const input = {
    and: [book, { or: [byAuthor, { not: { type: { in: ['schema:Person'] } } }] }],
  };
  expect(parseFilter(input)).toEqual(input);
  expect(parseFilter(input)).not.toBe(input);
  rejects({ colour: { in: ['red'] } }, 'invalid_request', [{ pointer: '/colour', code: 'unknown_field' }]);
  rejects({ type: {} }, 'invalid_request', [{ pointer: '/type/in', code: 'required' }]);
  rejects({ statement: { property: 'author', in: [author] } }, 'invalid_request', [
    { pointer: '/statement/property', code: 'invalid_format' },
  ]);
  rejects({ type: { in: ['schema:Book'] }, not: book }, 'invalid_request', [{ pointer: '', code: 'unsupported' }]);
  rejects({ __proto__: book } as unknown, 'invalid_request', [{ pointer: '', code: 'unsupported' }]);
  rejects({ and: [] }, 'invalid_request', [{ pointer: '/and', code: 'out_of_range' }]);
  const pairs = Array.from({ length: 16 }, () => ({ or: [book, book] }));
  expect(() => parseFilter({ and: pairs })).not.toThrow();
  rejects({ and: [...pairs, book] }, 'unsupported_query', [{ pointer: '', code: 'out_of_range' }]);
  rejects({ or: Array.from({ length: 17 }, () => book) }, 'unsupported_query', [
    { pointer: '/or', code: 'out_of_range' },
  ]);
  rejects({ and: [{ or: [{ and: [{ or: [{ not: book }, book] }] }, book] }] }, 'unsupported_query', [
    { pointer: '/and/0/or/0/and/0/or/0', code: 'out_of_range' },
  ]);
  rejects({ not: { not: book } }, 'unsupported_query', [{ pointer: '/not', code: 'unsupported' }]);
  expect(positiveFilter(parseFilter({ and: [{ not: book }, quick] }))).toBe(true);
  expect(positiveFilter(parseFilter({ or: [{ not: book }, book] }))).toBe(false);
});

test('statement conditions take item values, a numeric range and qualifiers bound to the same statement', () => {
  expect(FILTER_LIMITS).toEqual({ leaves: 32, depth: 4, or: 16, in: 64, qualifiers: 4 });
  const input = {
    and: [
      book,
      { statement: { property: 'schema:author', in: [author], qualifiers: [{ property: 'rezics:role', in: [lead] }] } },
      { statement: { property: 'schema:datePublished', range: { gte: 1990, lte: 1999 } } },
      quick,
      { saved: 'books/fantasy' },
    ],
  };
  expect(parseFilter(input)).toEqual(input);
  const qualified = {
    statement: {
      property: 'schema:author',
      in: [author],
      qualifiers: Array.from({ length: 4 }, () => ({ property: 'rezics:role', in: [lead] })),
    },
  };
  const thirty = Array.from({ length: 6 }, () => qualified);
  expect(() => parseFilter({ and: [...thirty, book, book] })).not.toThrow();
  rejects({ and: [...thirty, book, book, book] }, 'unsupported_query', [{ pointer: '', code: 'out_of_range' }]);
});

test('structural errors in the new conditions are field errors at their pointer', () => {
  const statement = (fields: object) => ({ statement: { property: 'schema:author', ...fields } });
  rejects(statement({}), 'invalid_request', [{ pointer: '/statement/in', code: 'required' }]);
  rejects(statement({ in: [author], range: { gte: 1 } }), 'invalid_request', [
    { pointer: '/statement/range', code: 'unsupported' },
  ]);
  rejects(statement({ range: {} }), 'invalid_request', [{ pointer: '/statement/range/gte', code: 'required' }]);
  rejects(statement({ range: { gte: '1990' } }), 'invalid_request', [
    { pointer: '/statement/range/gte', code: 'invalid_type' },
  ]);
  rejects(statement({ range: { gte: 1, step: 2 } }), 'invalid_request', [
    { pointer: '/statement/range/step', code: 'unknown_field' },
  ]);
  rejects(statement({ range: { gte: 2000, lte: 1990 } }), 'invalid_request', [
    { pointer: '/statement/range', code: 'out_of_range' },
  ]);
  rejects(statement({ range: { lte: 1, unit: 'a\u0000b' } }), 'invalid_request', [
    { pointer: '/statement/range/unit', code: 'invalid_format' },
  ]);
  rejects(statement({ in: [author], qualifiers: [] }), 'invalid_request', [
    { pointer: '/statement/qualifiers', code: 'out_of_range' },
  ]);
  const role = { property: 'rezics:role', in: [lead] };
  rejects(statement({ in: [author], qualifiers: [role, role, role, role, role] }), 'unsupported_query', [
    { pointer: '/statement/qualifiers', code: 'out_of_range' },
  ]);
  rejects(statement({ in: [author], qualifiers: [{ property: 'rezics:role' }] }), 'invalid_request', [
    { pointer: '/statement/qualifiers/0/in', code: 'required' },
  ]);
  rejects(statement({ in: [author], qualifiers: [{ ...role, eq: 1 }] }), 'invalid_request', [
    { pointer: '/statement/qualifiers/0/eq', code: 'unknown_field' },
  ]);
  rejects({ saved: 'Books/Fantasy' }, 'invalid_request', [{ pointer: '/saved', code: 'invalid_format' }]);
  rejects({ saved: 'books' }, 'invalid_request', [{ pointer: '/saved', code: 'invalid_format' }]);
  rejects({ saved: 1 }, 'invalid_request', [{ pointer: '/saved', code: 'invalid_type' }]);
});

test('admission accepts only facets of the types a query can return', () => {
  const input = { and: [book, byAuthor, { statement: { property: 'schema:genre', in: [fantasy] } }] };
  const before = structuredClone(input);
  const admitted = admit(input);
  expect(admitted).toEqual(input);
  expect(input).toEqual(before);
  expect(admit(quick)).toEqual(quick);
  expect(admit({ or: [book, quick] })).toEqual({ or: [book, quick] });
  refusesAdmission({ and: [book, quick] }, 'unsupported_query', [
    { pointer: '/and/1/statement/property', code: 'unsupported' },
  ]);
  refusesAdmission(
    { and: [{ type: { in: ['schema:Book', 'schema:Recipe'] } }, { type: { in: ['schema:Recipe'] } }, byAuthor] },
    'unsupported_query',
    [{ pointer: '/and/2/statement/property', code: 'unsupported' }],
  );
  expect(admit({ and: [{ type: { in: ['schema:Book', 'schema:Recipe'] } }, byAuthor, quick] })).toBeTruthy();
  refusesAdmission({ type: { in: ['schema:Book', 'schema:Movie'] } }, 'unsupported_query', [
    { pointer: '/type/in/1', code: 'unsupported' },
  ]);
  refusesAdmission({ statement: { property: 'schema:name', in: [author] } }, 'unsupported_query', [
    { pointer: '/statement/property', code: 'unsupported' },
  ]);
  refusesAdmission({ and: [{ type: { in: ['schema:Person'] } }, byAuthor] }, 'unsupported_query', [
    { pointer: '/and/1/statement/property', code: 'unsupported' },
  ]);
  const bare: FilterRelease = { types: { 'schema:Book': {} }, properties: release.properties };
  expect(admitFilter(parseFilter(book), bare)).toEqual(book);
  refuses(() => admitFilter(parseFilter(byAuthor), bare), 'unsupported_query', [
    { pointer: '/statement/property', code: 'unsupported' },
  ]);
});

test("the property's datatype decides which condition it takes", () => {
  refusesAdmission({ statement: { property: 'schema:author', range: { gte: 1 } } }, 'unsupported_query', [
    { pointer: '/statement/range', code: 'unsupported' },
  ]);
  refusesAdmission({ statement: { property: 'schema:datePublished', in: [author] } }, 'unsupported_query', [
    { pointer: '/statement/in', code: 'unsupported' },
  ]);
  refusesAdmission({ statement: { property: 'schema:author', in: [author, 'not-a-uuid'] } }, 'invalid_request', [
    { pointer: '/statement/in/1', code: 'invalid_format' },
  ]);
  refusesAdmission({ statement: { property: 'schema:author', in: [author.toUpperCase()] } }, 'invalid_request', [
    { pointer: '/statement/in/0', code: 'invalid_format' },
  ]);
  expect(admit({ statement: { property: 'schema:datePublished', range: { gte: -500 } } })).toBeTruthy();
  refusesAdmission({ statement: { property: 'schema:datePublished', range: { gte: 1990.5 } } }, 'invalid_request', [
    { pointer: '/statement/range/gte', code: 'invalid_format' },
  ]);
  refusesAdmission(
    { statement: { property: 'schema:datePublished', range: { gte: 1990, unit: 'unit:MIN' } } },
    'unsupported_query',
    [{ pointer: '/statement/range/unit', code: 'unsupported' }],
  );
  refusesAdmission({ statement: { property: 'schema:totalTime', range: { lte: 30 } } }, 'invalid_request', [
    { pointer: '/statement/range/unit', code: 'required' },
  ]);
  refusesAdmission(
    { statement: { property: 'schema:totalTime', range: { lte: 30, unit: 'unit:SEC' } } },
    'unsupported_query',
    [{ pointer: '/statement/range/unit', code: 'unsupported' }],
  );
  expect(
    admit({ statement: { property: 'schema:totalTime', range: { gte: 0.5, lte: 2.5, unit: 'unit:HUR' } } }),
  ).toBeTruthy();
  const qualified = (property: string, value = lead) => ({
    and: [
      { type: { in: ['schema:VideoGame'] } },
      { statement: { property: 'schema:character', in: [author], qualifiers: [{ property, in: [value] }] } },
    ],
  });
  expect(admit(qualified('rezics:role'))).toEqual(qualified('rezics:role'));
  refusesAdmission(qualified('schema:genre'), 'unsupported_query', [
    { pointer: '/and/1/statement/qualifiers/0/property', code: 'unsupported' },
  ]);
  refusesAdmission(qualified('schema:isbn'), 'unsupported_query', [
    { pointer: '/and/1/statement/qualifiers/0/property', code: 'unsupported' },
  ]);
  refusesAdmission(qualified('rezics:role', 'lead'), 'invalid_request', [
    { pointer: '/and/1/statement/qualifiers/0/in/0', code: 'invalid_format' },
  ]);
});

test('saved filters expand before admission and count toward the limits', () => {
  expect(admit({ and: [{ saved: 'books/fantasy' }, byAuthor] })).toEqual({
    and: [{ and: [book, { statement: { property: 'schema:genre', in: [fantasy] } }] }, byAuthor],
  });
  expect(admit({ saved: 'recipes/quick' })).toEqual(quick);
  refusesAdmission({ and: [{ type: { in: ['schema:Recipe'] } }, { saved: 'books/by-author' }] }, 'unsupported_query', [
    { pointer: '/and/1/saved', code: 'unsupported' },
  ]);
  for (const id of ['books/unknown', 'loop/saved', 'broken/filter'])
    refusesAdmission({ or: [book, { saved: id }] }, 'unsupported_query', [
      { pointer: '/or/1/saved', code: 'unsupported' },
    ]);
  refuses(() => admit({ saved: 'books/fantasy' }, { saved: false }), 'unsupported_query', [
    { pointer: '/saved', code: 'unsupported' },
  ]);
  expect(admit({ saved: 'deep/nested' })).toEqual(parseFilter(release.filters!['deep/nested']!.filter));
  refusesAdmission({ and: [{ saved: 'deep/nested' }] }, 'unsupported_query', [
    { pointer: '/and/0/saved', code: 'out_of_range' },
  ]);
  refusesAdmission({ not: { saved: 'negated/book' } }, 'unsupported_query', [
    { pointer: '/not/saved', code: 'unsupported' },
  ]);
  const books = Array.from({ length: 31 }, () => book);
  expect(() => parseFilter({ and: [...books, { saved: 'books/fantasy' }] })).not.toThrow();
  refusesAdmission({ and: [...books, { saved: 'books/fantasy' }] }, 'unsupported_query', [
    { pointer: '', code: 'out_of_range' },
  ]);
});

test('validateFilter reports the first violation without throwing', () => {
  expect(validateFilter({ and: [book, byAuthor] }, release)).toEqual([]);
  expect(validateFilter({ colour: 1 }, release)).toEqual([
    { problem: 'invalid_request', pointer: '/colour', code: 'unknown_field' },
  ]);
  expect(validateFilter({ and: [book, quick] }, release)).toEqual([
    { problem: 'unsupported_query', pointer: '/and/1/statement/property', code: 'unsupported' },
  ]);
  expect(validateFilter({ saved: 'books/fantasy' }, release, { saved: false })).toEqual([
    { problem: 'unsupported_query', pointer: '/saved', code: 'unsupported' },
  ]);
  const shipped = Object.entries(release.filters!).map(([id, { filter }]) => [
    id,
    validateFilter(filter, release, { saved: false }).length,
  ]);
  expect(shipped).toEqual([
    ['books/fantasy', 0],
    ['books/by-author', 0],
    ['recipes/quick', 0],
    ['deep/nested', 0],
    ['negated/book', 0],
    ['loop/saved', 1],
    ['broken/filter', 1],
  ]);
  for (const input of [null, [], 'x', 1, { and: 'x' }, { statement: null }])
    expect(validateFilter(input, release)).toHaveLength(1);
});

test('a string facet with a value pattern admits codes and refuses other strings', () => {
  const language = '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$';
  const coded: FilterRelease = {
    types: {
      'schema:Book': { facets: ['schema:inLanguage', 'schema:name', 'schema:identifier'] },
    },
    properties: {
      'schema:inLanguage': { datatype: 'string', qualifiers: ['rezics:role'], value: { pattern: language } },
      'schema:name': { datatype: 'string' },
      'schema:identifier': { datatype: 'string', value: { pattern: '^[a-z]+$' } },
      'rezics:role': { datatype: 'wikibase-item' },
    },
  };
  const admitCoded = (input: unknown) => admitFilter(parseFilter(input), coded);
  const refusesCoded = (input: unknown, problem: 'invalid_request' | 'unsupported_query', errors: object[]) =>
    refuses(() => admitCoded(input), problem, errors);
  const languages = { statement: { property: 'schema:inLanguage', in: ['ja', 'zh-Hant'] } };
  expect(admitCoded(languages)).toEqual(languages);
  const exact = ['en', ...Array.from({ length: 14 }, () => 'abcdefgh')].join('-');
  expect(exact.length).toBe(128);
  expect(admitCoded({ statement: { property: 'schema:inLanguage', in: [exact] } })).toEqual({
    statement: { property: 'schema:inLanguage', in: [exact] },
  });
  expect(admitCoded({ statement: { property: 'schema:identifier', in: ['a'.repeat(128)] } })).toEqual({
    statement: { property: 'schema:identifier', in: ['a'.repeat(128)] },
  });
  refusesCoded({ statement: { property: 'schema:inLanguage', in: ['ja', 'JA'] } }, 'invalid_request', [
    { pointer: '/statement/in/1', code: 'invalid_format' },
  ]);
  const long = ['ab', ...Array.from({ length: 15 }, () => 'abcdefgh')].join('-');
  expect(long.length).toBeGreaterThan(128);
  refusesCoded({ statement: { property: 'schema:inLanguage', in: [long] } }, 'invalid_request', [
    { pointer: '/statement/in/0', code: 'invalid_format' },
  ]);
  refusesCoded({ statement: { property: 'schema:identifier', in: ['a'.repeat(129)] } }, 'invalid_request', [
    { pointer: '/statement/in/0', code: 'invalid_format' },
  ]);
  refusesCoded({ statement: { property: 'schema:name', in: ['ja'] } }, 'unsupported_query', [
    { pointer: '/statement/in', code: 'unsupported' },
  ]);
  refusesCoded({ statement: { property: 'schema:inLanguage', range: { gte: 1 } } }, 'unsupported_query', [
    { pointer: '/statement/range', code: 'unsupported' },
  ]);
  const qualified = {
    statement: {
      property: 'schema:inLanguage',
      in: ['ja'],
      qualifiers: [{ property: 'rezics:role', in: [lead] }],
    },
  };
  expect(admitCoded(qualified)).toEqual(qualified);
  refusesCoded(
    {
      statement: {
        property: 'schema:inLanguage',
        in: ['ja'],
        qualifiers: [{ property: 'schema:inLanguage', in: ['en'] }],
      },
    },
    'unsupported_query',
    [{ pointer: '/statement/qualifiers/0/property', code: 'unsupported' }],
  );
  const inherited = Object.create({ pattern: '.*' }) as { pattern?: string };
  refuses(
    () =>
      admitFilter(parseFilter({ statement: { property: 'schema:name', in: ['ja'] } }), {
        types: coded.types,
        properties: { 'schema:name': { datatype: 'string', value: inherited } },
      }),
    'unsupported_query',
    [{ pointer: '/statement/in', code: 'unsupported' }],
  );
  refuses(
    () =>
      admitFilter(parseFilter({ statement: { property: 'schema:inLanguage', in: ['ja'] } }), {
        types: { 'schema:Book': { facets: [] } },
        properties: coded.properties,
      }),
    'unsupported_query',
    [{ pointer: '/statement/property', code: 'unsupported' }],
  );
});
