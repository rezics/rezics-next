import { expect, test } from 'bun:test';
import {
  admitFilter,
  FilterError,
  parseFilter,
  relationFacetProperty,
  type FilterProblem,
  type FilterRelease,
} from '../src/index.ts';

const author = '018f0000-0000-7000-8000-00b000000001';
const lead = '018f0000-0000-7000-8000-00b000000002';
const book = { type: { in: ['schema:Book'] } };
const plain = { statement: { property: 'schema:author', in: [author] } };
const qualified = {
  statement: { ...plain.statement, qualifiers: [{ property: 'rezics:role', in: [lead] }] },
};
const groups = ['order', 'derivation', 'world', 'membership', 'association', 'credit', 'appearance'];
const releaseFor = (group?: string): FilterRelease => ({
  types: {
    'schema:Book': { facets: ['schema:author'] },
    'schema:Recipe': { facets: [] },
  },
  properties: {
    'schema:author': {
      datatype: 'wikibase-item',
      qualifiers: ['rezics:role'],
      ...(group === undefined ? {} : { relation: { group } }),
    },
    'rezics:role': { datatype: 'wikibase-item' },
  },
  filters: { 'books/qualified': { filter: { and: [book, qualified] } } },
});

function refuses(input: unknown, release: FilterRelease, pointer: string, problem: FilterProblem = 'invalid_request') {
  const filter = parseFilter(input);
  const error = (() => {
    try {
      admitFilter(filter, release);
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(FilterError);
  expect((error as FilterError).problem).toBe(problem);
  expect((error as FilterError).errors).toEqual([{ pointer, code: 'unsupported' }]);
}

test('released relation qualifiers and unqualified membership share ordinary admission', () => {
  for (const group of groups) {
    const release = releaseFor(group);
    expect(relationFacetProperty(release, 'schema:author')).toBe(true);
    expect(parseFilter(qualified)).toEqual(qualified);
    const filter = parseFilter({ and: [book, plain] });
    expect(admitFilter(filter, release)).toEqual(filter);
    expect(admitFilter(parseFilter(qualified), release)).toEqual(qualified);
    expect(admitFilter(parseFilter({ and: [book, qualified] }), release)).toEqual({ and: [book, qualified] });
  }
});

test('classification, missing metadata and other groups retain descriptive qualifier admission and errors', () => {
  for (const group of [undefined, 'classification', 'unknown', 'Credit', 'credit ']) {
    const release = releaseFor(group);
    expect(relationFacetProperty(release, 'schema:author')).toBe(false);
    expect(relationFacetProperty(release, 'schema:missing')).toBe(false);
    const filter = parseFilter({ and: [book, qualified] });
    expect(admitFilter(filter, release)).toEqual(filter);
    refuses(
      { statement: { ...plain.statement, qualifiers: [{ property: 'schema:unknown', in: [lead] }] } },
      release,
      '/statement/qualifiers/0/property',
      'unsupported_query',
    );
    expect(() =>
      admitFilter(
        parseFilter({ statement: { ...plain.statement, qualifiers: [{ property: 'rezics:role', in: ['bad'] }] } }),
        release,
      ),
    ).toThrow('invalid_request: invalid_format at /statement/qualifiers/0/in/0');
  }
});

test('qualified relations retain nested/saved meaning and declaration/type anchors', () => {
  const release = releaseFor('credit');
  for (const input of [{ and: [book, { not: qualified }] }, { or: [plain, { and: [qualified] }] }])
    expect(admitFilter(parseFilter(input), release)).toEqual(input);
  expect(admitFilter(parseFilter({ saved: 'books/qualified' }), release)).toEqual({ and: [book, qualified] });
  release.properties['schema:author']!.qualifiers = [];
  refuses(
    { and: [book, { not: qualified }] },
    release,
    '/and/1/not/statement/qualifiers/0/property',
    'unsupported_query',
  );
  refuses({ saved: 'books/qualified' }, release, '/saved', 'unsupported_query');
  refuses(
    { and: [{ type: { in: ['schema:Recipe'] } }, qualified] },
    release,
    '/and/1/statement/property',
    'unsupported_query',
  );
  delete release.properties['schema:author'];
  refuses(qualified, release, '/statement/property', 'unsupported_query');
});

test('relation metadata reads only own data descriptors without running getters or prototypes', () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error('metadata accessor executed');
  };
  const accessor = (key: string) => Object.defineProperty({}, key, { get: trap });
  const inherited = (key: string, value: unknown) => Object.create({ [key]: value }) as object;
  const inheritedAccessor = (key: string) => Object.create(accessor(key)) as object;
  const relation = { group: 'credit' };
  const definition = { datatype: 'wikibase-item', qualifiers: ['rezics:role'], relation };
  const properties = { 'schema:author': definition };
  const hostile = [
    accessor('properties'),
    inherited('properties', properties),
    inheritedAccessor('properties'),
    ...[accessor('schema:author'), inherited('schema:author', definition), inheritedAccessor('schema:author')].map(
      (properties) => ({ properties }),
    ),
    ...[accessor('relation'), inherited('relation', relation), inheritedAccessor('relation')].map((metadata) => ({
      properties: { 'schema:author': Object.assign(metadata, { datatype: 'wikibase-item' }) },
    })),
    ...[
      accessor('group'),
      inherited('group', 'credit'),
      inheritedAccessor('group'),
      null,
      [],
      'credit',
      { group: 1 },
    ].map((relation) => ({ properties: { 'schema:author': { relation } } })),
  ];
  for (const release of hostile) {
    expect(relationFacetProperty(release as FilterRelease, 'schema:author')).toBe(false);
  }
  for (const metadata of [accessor('relation'), inherited('relation', relation), inheritedAccessor('relation')]) {
    const release = releaseFor();
    release.properties['schema:author'] = Object.assign(metadata, {
      datatype: 'wikibase-item',
      qualifiers: ['rezics:role'],
    });
    expect(admitFilter(parseFilter(qualified), release)).toEqual(qualified);
  }
  expect(calls).toBe(0);
});
