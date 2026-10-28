import { afterAll, beforeAll, expect, test } from 'bun:test';
import { admitFilter, parseFilter, type FilterDocument, type FilterRelease } from '@rezics/filter';
import { compileFilter } from '../../src/search/filter.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const index = `test-filter-overflow-${crypto.randomUUID()}`;
const author = 'schema:author';
const genre = 'schema:genre';
const role = 'rezics:role';
const date = 'schema:datePublished';
const time = 'schema:totalTime';
const id = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const [target, other, lead, support, fantasy] = [id(1), id(2), id(3), id(4), id(5)];
type Fact = { property: string; value?: string; year?: number; amount?: number; unit?: string; qualifiers: string[] };
const item = (property: string, value: string, qualifier = support): Fact => ({
  property,
  value,
  qualifiers: [`${role}=${qualifier}`],
});
const published = (year: number, qualifier = support): Fact => ({
  property: date,
  year,
  qualifiers: [`${role}=${qualifier}`],
});
const duration = (amount: number, unit: string, qualifier = support): Fact => ({
  property: time,
  amount,
  unit,
  qualifiers: [`${role}=${qualifier}`],
});
const prefix = (property: string) => Array.from({ length: 128 }, (_, n) => item(property, id(1000 + n)));
const fixture = (name: string, type: string | undefined, full: Fact[]) => {
  const counts = new Map<string, number>();
  const overflow = new Set<string>();
  const facts = full.filter((fact) => {
    if (fact.property !== author && fact.property !== genre) return true;
    const count = (counts.get(fact.property) ?? 0) + 1;
    counts.set(fact.property, count);
    if (count <= 128) return true;
    overflow.add(fact.property);
    return false;
  });
  return {
    name,
    full,
    document: {
      type,
      facts,
      statements: facts.flatMap((fact) => (fact.value === undefined ? [] : [`${fact.property}=${fact.value}`])),
      relation_facet_overflow: [...overflow],
    },
  };
};
const fixtures = [
  fixture('omitted-match', 'schema:Book', [...prefix(author), item(author, target, lead), item(genre, fantasy)]),
  fixture('omitted-nonmatch', 'schema:Book', [...prefix(author), item(author, other)]),
  fixture('sampled-match', 'schema:Book', [item(author, target, lead), ...prefix(author), item(genre, fantasy)]),
  fixture('other-overflow', 'schema:Book', [item(author, other), ...prefix(genre), item(genre, fantasy)]),
  fixture('exact-match', 'schema:Book', [
    item(author, target, lead),
    item(genre, fantasy),
    published(1995, lead),
    duration(45, 'unit:MIN', lead),
  ]),
  fixture('exact-nonmatch', 'schema:Book', [item(author, other), published(1850), duration(45, 'unit:HUR')]),
  fixture('missing', 'schema:Book', []),
  fixture('split-qualifiers', 'schema:Book', [
    item(author, target),
    item(author, other, lead),
    published(1995),
    published(1850, lead),
    duration(45, 'unit:MIN'),
    duration(120, 'unit:MIN', lead),
  ]),
  fixture('other-type', 'schema:Recipe', [item(author, target, lead)]),
  fixture('overflow-other-type', 'schema:Recipe', [...prefix(author), item(author, target, lead)]),
  fixture('missing-type', undefined, []),
];
const release: FilterRelease = {
  types: {
    'schema:Book': { facets: [author, genre, date, time] },
    'schema:Recipe': { facets: [author, genre, date, time] },
  },
  properties: {
    [author]: { datatype: 'wikibase-item', qualifiers: [role] },
    [genre]: { datatype: 'wikibase-item' },
    [role]: { datatype: 'wikibase-item' },
    [date]: { datatype: 'time', qualifiers: [role] },
    [time]: { datatype: 'quantity', qualifiers: [role], units: ['unit:MIN', 'unit:HUR'] },
  },
};

beforeAll(async () => {
  await search.request('PUT', `/${index}`, {
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: {
      dynamic: 'strict',
      properties: {
        type: { type: 'keyword' },
        statements: { type: 'keyword' },
        relation_facet_overflow: { type: 'keyword' },
        facts: {
          type: 'nested',
          properties: {
            property: { type: 'keyword' },
            value: { type: 'keyword' },
            qualifiers: { type: 'keyword' },
            year: { type: 'integer' },
            amount: { type: 'double' },
            unit: { type: 'keyword' },
          },
        },
      },
    },
  });
  const result = await search.bulk<{ errors: boolean }>(
    fixtures.flatMap(({ name, document }) => [{ index: { _index: index, _id: name } }, document]),
    { query: { refresh: 'wait_for' } },
  );
  expect(result.errors).toBe(false);
});
afterAll(async () => {
  await search.request('DELETE', `/${index}`);
});

// Evaluate the original boolean expression against either the full facts or the indexed prefix.
function matches(filter: FilterDocument, type: string | undefined, facts: Fact[]): boolean {
  if ('and' in filter) return filter.and.every((child) => matches(child, type, facts));
  if ('or' in filter) return filter.or.some((child) => matches(child, type, facts));
  if ('not' in filter) return !matches(filter.not, type, facts);
  if ('type' in filter) return type !== undefined && filter.type.in.includes(type);
  if ('saved' in filter) throw new Error('Fixtures use admitted filters');
  if ('owner' in filter) throw new Error('Catalogue fixtures do not support owner predicates');
  const statement = filter.statement;
  return facts.some((fact) => {
    if (fact.property !== statement.property) return false;
    if ('in' in statement) {
      if (fact.value === undefined || !statement.in.includes(fact.value)) return false;
    } else {
      const range = statement.range;
      const value = range.unit === undefined ? fact.year : fact.amount;
      if (value === undefined || (range.unit !== undefined && range.unit !== fact.unit)) return false;
      if (range.gte !== undefined && value < range.gte) return false;
      if (range.lte !== undefined && value > range.lte) return false;
    }
    return (statement.qualifiers ?? []).every((qualifier) =>
      qualifier.in.some((value) => fact.qualifiers.includes(`${qualifier.property}=${value}`)),
    );
  });
}

type Hit = { _id: string; matched_queries?: string[] };
async function candidates(filter: FilterDocument, relationOverflow: boolean): Promise<Hit[]> {
  const options = { prefix: 'f', relationOverflow };
  const compiled = compileFilter(filter, options);
  const legacy = compileFilter(filter, { prefix: 'f' });
  expect(compiled.leaves).toEqual(legacy.leaves);
  if (!relationOverflow) expect(compiled).toEqual(legacy);
  const response = await search.request<{ hits: { hits: Hit[] } }>('POST', `/${index}/_search`, {
    query: compiled.query,
    size: fixtures.length,
    _source: false,
  });
  return response.body.hits.hits;
}

async function verify(input: FilterDocument): Promise<Hit[]> {
  const filter = admitFilter(parseFilter(input), release);
  const exact = await candidates(filter, false);
  expect(exact.map((hit) => hit._id).sort()).toEqual(
    fixtures
      .filter(({ document }) => matches(filter, document.type, document.facts))
      .map(({ name }) => name)
      .sort(),
  );
  const broad = await candidates(filter, true);
  const ids = broad.map((hit) => hit._id);
  const properties = compileFilter(filter, { prefix: 'f' }).leaves.flatMap((leaf) =>
    leaf.facet === 'statement' ? [leaf.property] : [],
  );
  for (const { name, full, document } of fixtures) {
    const actual = matches(filter, document.type, full);
    if (actual) expect(ids, `${name}: ${JSON.stringify(filter)}`).toContain(name);
    if (!document.relation_facet_overflow.some((property) => properties.includes(property)))
      expect(ids.includes(name), `${name}: ${JSON.stringify(filter)}`).toBe(actual);
  }
  return broad;
}

const a: FilterDocument = { statement: { property: author, in: [target] } };
const g: FilterDocument = { statement: { property: genre, in: [fantasy] } };
const book: FilterDocument = { type: { in: ['schema:Book'] } };
const not = (filter: FilterDocument): FilterDocument => ({ not: filter });
const and = (...filters: FilterDocument[]): FilterDocument => ({ and: filters });
const or = (...filters: FilterDocument[]): FilterDocument => ({ or: filters });

test('overflow candidate queries retain true positive and negated matches beyond the sampled prefix', async () => {
  const positive = await verify(a);
  const positiveIds = positive.map((hit) => hit._id);
  expect(positiveIds).toContain('omitted-match');
  expect(positiveIds).toContain('omitted-nonmatch');
  expect(positiveIds).not.toContain('other-overflow');
  expect(positiveIds).not.toContain('missing');
  expect(positive.find((hit) => hit._id === 'omitted-match')?.matched_queries).toContain('f0');
  expect(positive.find((hit) => hit._id === 'exact-match')?.matched_queries).toContain('f0');

  const negative = await verify(not(a));
  const negativeIds = negative.map((hit) => hit._id);
  // Both sampled and omitted matches stay candidates even though full rechecking rejects the negation.
  expect(negativeIds).toContain('omitted-match');
  expect(negativeIds).toContain('sampled-match');
  expect(negativeIds).toContain('omitted-nonmatch');
  expect(negativeIds).toContain('missing');
  expect(negativeIds).not.toContain('exact-match');
  expect(negative.find((hit) => hit._id === 'sampled-match')?.matched_queries).toContain('f0');
  expect(compileFilter(not(a), { prefix: 'f' }).leaves[0]?.negated).toBe(true);

  const legacyPositive = await candidates(a, false);
  expect(legacyPositive.map((hit) => hit._id)).not.toContain('omitted-match');
  const legacyNegative = await candidates(not(a), false);
  expect(legacyNegative.map((hit) => hit._id)).not.toContain('sampled-match');
  expect(legacyNegative.map((hit) => hit._id)).toContain('omitted-match');
});

test('overflow candidate queries preserve boolean grouping and same-statement qualifiers', async () => {
  const qualified: FilterDocument = {
    statement: { property: author, in: [target], qualifiers: [{ property: role, in: [lead] }] },
  };
  const year: FilterDocument = { statement: { property: date, range: { gte: 1990, lte: 2000 } } };
  const minutes: FilterDocument = {
    statement: { property: time, range: { gte: 30, lte: 60, unit: 'unit:MIN' } },
  };
  const qualifiedYear: FilterDocument = {
    statement: { property: date, range: { gte: 1990, lte: 2000 }, qualifiers: [{ property: role, in: [lead] }] },
  };
  const qualifiedMinutes: FilterDocument = {
    statement: {
      property: time,
      range: { gte: 30, lte: 60, unit: 'unit:MIN' },
      qualifiers: [{ property: role, in: [lead] }],
    },
  };
  const nested = not(and(or(a, not(g)), book));
  const options = { prefix: 'f', relationOverflow: true };
  expect(compileFilter(nested, options).leaves.map(({ name, negated }) => ({ name, negated }))).toEqual([
    { name: 'f0', negated: true },
    { name: 'f1', negated: false },
    { name: 'f2', negated: true },
  ]);
  const wide = and(...Array.from({ length: 32 }, () => a));
  const compiled = compileFilter(wide, options);
  expect(compiled.leaves).toHaveLength(32);
  expect(JSON.stringify(compiled.query).match(/"relation_facet_overflow"/g)).toHaveLength(32);
  for (const filter of [
    book,
    not(book),
    and(a, g),
    or(a, g),
    and(a, not(g)),
    or(not(a), g),
    and(not(a), not(g)),
    or(not(a), not(g)),
    // Admission forbids adjacent NOT nodes; a singleton AND admits double negation without changing limits.
    not(and(not(a))),
    not(and(a, g)),
    not(or(a, g)),
    nested,
    and(book, a),
    and(not(book), a),
    or(book, not(a)),
    and(book, not(or(a, g))),
    not(or(book, and(a, g))),
    qualified,
    not(qualified),
    and(book, not(qualified)),
    not(or(qualified, g)),
    year,
    not(year),
    minutes,
    not(minutes),
    qualifiedYear,
    not(qualifiedYear),
    qualifiedMinutes,
    not(qualifiedMinutes),
    and(a, year),
    { statement: { property: author, in: [target, other] } },
    wide,
  ])
    await verify(filter);

  const anchored = await verify(and(book, a));
  expect(anchored.map((hit) => hit._id)).not.toContain('overflow-other-type');
  expect(anchored.map((hit) => hit._id)).not.toContain('other-type');
  const omitted = anchored.find((hit) => hit._id === 'omitted-match');
  expect(omitted?.matched_queries?.sort()).toEqual(['f0', 'f1']);
  for (const filter of [qualified, qualifiedYear, qualifiedMinutes]) {
    const positive = await verify(filter);
    expect(positive.map((hit) => hit._id)).toContain('exact-match');
    expect(positive.map((hit) => hit._id)).not.toContain('split-qualifiers');
    const negative = await verify(not(filter));
    expect(negative.map((hit) => hit._id)).toContain('split-qualifiers');
    expect(negative.map((hit) => hit._id)).not.toContain('exact-match');
  }
  const omittedQualified = (await verify(qualified)).find((hit) => hit._id === 'omitted-match');
  expect(omittedQualified?.matched_queries).toContain('f0');
});
