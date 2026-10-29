import { afterAll, beforeAll, expect, test } from 'bun:test';
import { subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  countFacets,
  FACET_TEMPLATE,
  installTemplates,
  SEARCH_TEMPLATE,
  searchSubjects,
  SUGGEST_TEMPLATE,
} from '../../src/search/query.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const author = 'schema:author';
const category = 'schema:category';
const unrelated = 'schema:other';
const documentId = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const fact = (property: string, value: string) => ({ property, value });
const sampled = Array.from({ length: 128 }, (_, n) => fact(author, n === 0 ? 'alice' : `person-${n}`));
const documents = [
  {
    id: documentId(1),
    group: 'exact',
    facts: [fact(author, 'alice'), fact(author, 'alice'), fact(category, 'wanted')],
  },
  {
    id: documentId(2),
    group: 'exact',
    facts: [fact(author, 'bob'), fact(category, 'wanted')],
    relation_facet_overflow: [unrelated],
  },
  { id: documentId(3), group: 'overflow', facts: [fact(author, 'alice')] },
  {
    id: documentId(4),
    group: 'overflow',
    facts: [...sampled, fact(author, 'alice')],
    relation_facet_overflow: [author],
  },
  { id: documentId(5), group: 'overflow', facts: [], relation_facet_overflow: [author] },
  {
    id: documentId(6),
    group: 'excluded',
    facts: [fact(author, 'poison')],
    relation_facet_overflow: [author, category],
  },
  {
    id: documentId(7),
    group: 'candidates',
    facts: [fact(author, 'alice'), fact(author, 'alice'), fact(category, 'wanted')],
  },
  {
    id: documentId(8),
    group: 'candidates',
    facts: [fact(author, 'alice'), fact(author, 'poison'), fact(category, 'different')],
    relation_facet_overflow: [category],
  },
  { id: documentId(9), group: 'candidates', facts: [], relation_facet_overflow: [category] },
  {
    id: documentId(10),
    group: 'candidates',
    facts: [fact(author, 'bob'), fact(category, 'wanted')],
    relation_facet_overflow: [unrelated],
  },
];
const group = (value: string) => ({ term: { group: value } });
// The compiler admits this positive-filter superset: an overflow marker may hide the requested value.
const candidateFilter = {
  bool: {
    minimum_should_match: 1,
    should: [
      {
        nested: {
          path: 'facts',
          query: {
            bool: { filter: [{ term: { 'facts.property': category } }, { term: { 'facts.value': 'wanted' } }] },
          },
        },
      },
      { terms: { relation_facet_overflow: [category] } },
    ],
  },
};

beforeAll(async () => {
  // This fixture declares the decided marker locally; it does not depend on the production mapping or source.
  await search.request('PUT', `/${index}`, {
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: {
      dynamic: 'strict',
      properties: {
        id: { type: 'keyword' },
        group: { type: 'keyword' },
        type: { type: 'keyword' },
        partition: { type: 'integer' },
        security_revision: { type: 'integer' },
        relation_facet_overflow: { type: 'keyword' },
        facts: { type: 'nested', properties: { property: { type: 'keyword' }, value: { type: 'keyword' } } },
      },
    },
    aliases: { [subjectAlias(prefix)]: {} },
  });
  const result = await search.bulk<{ errors: boolean }>(
    documents.flatMap((document) => [
      { index: { _index: index, _id: document.id } },
      { ...document, type: 'schema:Book', partition: 10, security_revision: 1 },
    ]),
    { query: { refresh: 'wait_for' } },
  );
  expect(result.errors).toBe(false);
  await installTemplates(search, prefix);
});

afterAll(async () => {
  await search.request('DELETE', `/${index}`);
  for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
    await search.request('DELETE', `/_scripts/${prefix}${template}`);
});

async function oneRequest<T>(template: string, run: (client: OpenSearch) => Promise<T>): Promise<T> {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const client: OpenSearch = {
    ...search,
    request<T>(...args: Parameters<OpenSearch['request']>) {
      const [method, path, body] = args;
      calls.push({ method, path, body });
      return search.request<T>(...args);
    },
  };
  const answer = await run(client);
  expect(calls).toEqual([
    {
      method: 'POST',
      path: `/${subjectAlias(prefix)}/_search/template`,
      body: expect.objectContaining({ id: `${prefix}${template}` }),
    },
  ]);
  return answer;
}

test('search reports whether matching candidates overflow a requested filter property', async () => {
  const plan = { filter: group('overflow'), sort: 'id' as const, size: 1, overflowProperties: [author] };
  const page = await oneRequest('subjects-search-v2', (client) => searchSubjects(client, prefix, plan));
  expect(page.hits.map(({ id }) => id)).toEqual([documentId(3)]);
  expect(page.total).toEqual({ value: 3, relation: 'exact' });
  expect(page.overflow).toBe(true); // The marker is beyond this page.
  const next = await oneRequest('subjects-search-v2', (client) =>
    searchSubjects(client, prefix, { ...plan, after: page.hits[0]!.sort }),
  );
  expect(next.hits.map(({ id }) => id)).toEqual([documentId(4)]);
  expect(next.overflow).toBe(true); // This hit has 128 sampled values and the marker.
  const exhausted = await oneRequest('subjects-search-v2', (client) =>
    searchSubjects(client, prefix, { ...plan, after: [documentId(5)] }),
  );
  expect(exhausted.hits).toEqual([]);
  expect(exhausted.overflow).toBe(true); // Metadata covers all candidates, even before search_after.

  for (const filter of [group('exact'), group('missing')]) {
    const exact = await oneRequest('subjects-search-v2', (client) =>
      searchSubjects(client, prefix, { ...plan, filter }),
    );
    expect(exact.overflow).toBe(false);
  }
  const differentProperty = await oneRequest('subjects-search-v2', (client) =>
    searchSubjects(client, prefix, { ...plan, overflowProperties: [category] }),
  );
  expect(differentProperty.overflow).toBe(false);
  const anyProperty = await oneRequest('subjects-search-v2', (client) =>
    searchSubjects(client, prefix, { ...plan, overflowProperties: [category, author] }),
  );
  expect(anyProperty.overflow).toBe(true);
  const plain = await oneRequest('subjects-search-v2', (client) =>
    searchSubjects(client, prefix, { filter: group('exact'), sort: 'id', size: 1 }),
  );
  expect(Object.keys(plain).sort()).toEqual(['hits', 'total']);
  expect(
    await oneRequest('subjects-search-v2', (client) =>
      searchSubjects(client, prefix, { filter: group('exact'), sort: 'id', size: 1, overflowProperties: [] }),
    ),
  ).toEqual(plain);
});

test('facet counts with truncation are honest lower bounds and exclude unresolved filter candidates', async () => {
  const facets = [
    { property: author, size: 20 },
    { property: 'type', size: 10 },
  ];
  const plan = { query: group('overflow'), facets, sample: 100 };
  const truncated = await oneRequest('subjects-facets-v1', (client) => countFacets(client, prefix, plan));
  expect(truncated.total).toEqual({ value: 3, relation: 'exact' });
  expect(truncated.facets[0]).toEqual({
    property: author,
    relation: 'lower_bound',
    values: [
      { value: 'alice', count: 2 },
      ...sampled
        .slice(1)
        .map(({ value }) => ({ value, count: 1 }))
        .sort((a, b) => a.value.localeCompare(b.value))
        .slice(0, 39),
    ],
  });
  expect(truncated.facets[1]).toEqual({
    property: 'type',
    relation: 'exact',
    values: [{ value: 'schema:Book', count: 3 }],
  });
  const missing = await oneRequest('subjects-facets-v1', (client) =>
    countFacets(client, prefix, { ...plan, query: { term: { id: documentId(5) } } }),
  );
  expect(missing.total).toEqual({ value: 1, relation: 'exact' });
  expect(missing.facets[0]).toEqual({ property: author, relation: 'lower_bound', values: [] });

  const unresolved = await oneRequest('subjects-facets-v1', (client) =>
    countFacets(client, prefix, {
      ...plan,
      query: group('candidates'),
      filter: candidateFilter,
      overflowProperties: [category],
    }),
  );
  expect(unresolved.total).toEqual({ value: 2, relation: 'lower_bound' });
  expect(unresolved.facets).toEqual([
    {
      property: author,
      relation: 'lower_bound',
      values: [
        { value: 'alice', count: 1 },
        { value: 'bob', count: 1 },
      ],
    },
    { property: 'type', relation: 'lower_bound', values: [{ value: 'schema:Book', count: 2 }] },
  ]);
  const onlyUnresolved = await oneRequest('subjects-facets-v1', (client) =>
    countFacets(client, prefix, {
      ...plan,
      query: { term: { id: documentId(8) } },
      filter: candidateFilter,
      overflowProperties: [category],
    }),
  );
  expect(onlyUnresolved.total).toEqual({ value: 0, relation: 'lower_bound' });
  expect(onlyUnresolved.facets.map(({ relation, values }) => ({ relation, values }))).toEqual([
    { relation: 'lower_bound', values: [] },
    { relation: 'lower_bound', values: [] },
  ]);

  const exactPlan = { ...plan, query: group('exact'), filter: candidateFilter };
  const exact = await oneRequest('subjects-facets-v1', (client) => countFacets(client, prefix, exactPlan));
  expect(exact).toEqual({
    total: { value: 2, relation: 'exact' },
    facets: [
      {
        property: author,
        relation: 'exact',
        values: [
          { value: 'alice', count: 1 },
          { value: 'bob', count: 1 },
        ],
      },
      { property: 'type', relation: 'exact', values: [{ value: 'schema:Book', count: 2 }] },
    ],
  });
  for (const overflowProperties of [[], [category]]) {
    expect(
      await oneRequest('subjects-facets-v1', (client) =>
        countFacets(client, prefix, { ...exactPlan, overflowProperties }),
      ),
    ).toEqual(exact);
  }
  const limited = await oneRequest('subjects-facets-v1', (client) =>
    countFacets(client, prefix, { ...exactPlan, sample: 1 }),
  );
  expect(limited.total).toEqual({ value: 2, relation: 'exact' });
  expect(limited.facets.every(({ relation }) => relation === 'lower_bound')).toBe(true);
  expect(limited.facets[1]!.values).toEqual([{ value: 'schema:Book', count: 1 }]);
});
