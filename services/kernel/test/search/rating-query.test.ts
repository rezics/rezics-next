import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import {
  FACET_TEMPLATE,
  installTemplates,
  SEARCH_TEMPLATE,
  searchSubjects,
  SUGGEST_TEMPLATE,
  type SearchPlan,
} from '../../src/search/query.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefix = `test-rating-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
// The public literal is forthcoming; keep this staged specification out of product interfaces.
const rating = 'rating' as SearchPlan['sort'];
const id = (n: number) =>
  `018f0000-0000-7000-8000-${((10 + n) * 16).toString(16).padStart(4, '0')}${String(n).padStart(8, '0')}`;

function subject(n: number, name: string, type = 'schema:Book'): IndexedSubject {
  return {
    id: id(n),
    type,
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: name }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
}

// One population, with controlled published scores. Mean/count are adversarial diagnostics:
// high values on unscored rows must never become a substitute score.
const fixtures = [
  { subject: subject(1, 'Rating Zulu'), score: 0, mean: 10, count: 10_000 },
  { subject: subject(2, 'Rating Beta'), score: 8.25, mean: 1, count: 1 },
  { subject: subject(3, 'Rating Alpha'), score: 8.25, mean: 2, count: 2 },
  { subject: subject(4, 'Rating Alpha'), score: undefined, mean: 10, count: 1_000_000 },
  { subject: subject(5, 'Rating Zulu'), score: undefined, mean: 10, count: 1_000_000 },
  { subject: subject(6, 'rating alpha'), score: 8.25, mean: 9, count: 900 },
  { subject: subject(7, 'Rating Beta'), score: null, mean: 10, count: 1_000_000 },
  { subject: subject(8, 'Rating Zulu'), score: 9.75, mean: 0, count: 1 },
  { subject: subject(9, 'Rating Alpha'), score: null, mean: 10, count: 1_000_000 },
  { subject: subject(10, 'Unrelated'), score: 100, mean: 100, count: 1_000_000 },
  { subject: subject(11, 'Rating Alpha', 'schema:Recipe'), score: 100, mean: 100, count: 1_000_000 },
];
const expected = [id(8), id(3), id(6), id(2), id(1), id(4), id(9), id(7), id(5)];
const plan = {
  query: { match: { search_text: { query: 'rating', operator: 'and', _name: 't0' } } },
  filter: { terms: { type: ['schema:Book'], _name: 'f0' } },
  sort: rating,
};

async function removeOwnedResources(): Promise<void> {
  const paths = [
    index,
    ...[SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE].map((name) => `_scripts/${prefix}${name}`),
  ];
  const results = await Promise.allSettled(
    paths.map(async (path) => {
      try {
        await search.request('DELETE', `/${path}`);
      } catch (error) {
        if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
      }
    }),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

beforeAll(async () => {
  try {
    const node = await search.request<{ version: { number: string; distribution: string } }>('GET', '/');
    expect(node.body.version.distribution).toBe('opensearch');
    expect(node.body.version.number).toMatch(/^3\./);
    await createSubjectIndex(search, prefix, 1);
    // Extend only this disposable index: production mapping/source support is a separate obligation.
    await search.request('PUT', `/${index}/_mapping`, {
      properties: {
        rating_score: { type: 'double', doc_values: true },
        rating_mean: { type: 'double', doc_values: true },
        rating_count: { type: 'long', doc_values: true },
      },
    });
    for (const fixture of fixtures) {
      const entry = fixture.subject;
      const actions = documentActions({ partition: subjectPartition(entry.id), position: 1n, subjects: [entry] }, [
        entry.id,
      ]);
      for (const action of actions) {
        if (action.op !== 'index') throw new Error('Expected a visible subject document');
        Object.assign(action.document, {
          ...(fixture.score === undefined ? {} : { rating_score: fixture.score }),
          rating_mean: fixture.mean,
          rating_count: fixture.count,
        });
      }
      const result = await search.bulk<{ errors: boolean }>(bulkLines(index, actions), {
        query: { refresh: 'wait_for' },
      });
      expect(result.errors).toBe(false);
    }
    await search.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
    await installTemplates(search, prefix);
  } catch (error) {
    await removeOwnedResources();
    throw error;
  }
}, 120_000);

afterAll(removeOwnedResources);

// These are engine ranking and internal search_after tests, not proof of native-vote or
// public-figure privacy, population admission, current disclosure, prior updates, or signed HTTP cursors.
test('rating orders published scores descending, zero before null/missing, then normalized name and id', async () => {
  const result = await searchSubjects(search, prefix, { ...plan, size: 200 });
  expect(result.total).toEqual({ value: 9, relation: 'exact' });
  expect(result.hits.map((hit) => hit.id)).toEqual(expected);
  expect(result.hits.map((hit) => hit.sort)).toEqual([
    [9.75, 'rating zulu', id(8)],
    [8.25, 'rating alpha', id(3)],
    [8.25, 'rating alpha', id(6)],
    [8.25, 'rating beta', id(2)],
    [0, 'rating zulu', id(1)],
    [null, 'rating alpha', id(4)],
    [null, 'rating alpha', id(9)],
    [null, 'rating beta', id(7)],
    [null, 'rating zulu', id(5)],
  ]);
  for (const hit of result.hits) {
    expect(hit.index).toBe(index);
    expect(hit.partition).toBe(subjectPartition(hit.id));
    expect(hit.securityRevision).toBe(1);
    expect(hit.matched).toContain('t0');
    expect(hit.matched).toContain('f0');
  }
  expect(new Set(result.hits.map((hit) => hit.partition)).size).toBeGreaterThan(1);
});

test('rating search_after page1/page2/page3 consume each id once across numeric and null boundaries', async () => {
  const page1 = await searchSubjects(search, prefix, { ...plan, size: 3 });
  const after1 = page1.hits.at(-1)!.sort;
  const page2 = await searchSubjects(search, prefix, { ...plan, size: 3, after: after1 });
  const after2 = page2.hits.at(-1)!.sort;
  const page3 = await searchSubjects(search, prefix, { ...plan, size: 3, after: after2 });
  const after3 = page3.hits.at(-1)!.sort;
  const exhausted = await searchSubjects(search, prefix, { ...plan, size: 3, after: after3 });

  expect(page1.hits.map((hit) => hit.id)).toEqual([id(8), id(3), id(6)]);
  expect(page2.hits.map((hit) => hit.id)).toEqual([id(2), id(1), id(4)]);
  expect(page3.hits.map((hit) => hit.id)).toEqual([id(9), id(7), id(5)]);
  expect(after1).toEqual([8.25, 'rating alpha', id(6)]);
  expect(after2).toEqual([null, 'rating alpha', id(4)]);
  expect(after3).toEqual([null, 'rating zulu', id(5)]);
  const seen = [...page1.hits, ...page2.hits, ...page3.hits].map((hit) => hit.id);
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(expected.length);
  expect(exhausted.hits).toEqual([]);
  for (const page of [page1, page2, page3, exhausted]) {
    expect(page.total).toEqual({ value: 9, relation: 'exact' });
  }
});

test('rating query size accepts 1 and 200 and rejects values outside integer limits', async () => {
  const first = await searchSubjects(search, prefix, { ...plan, size: 1 });
  expect(first.hits.map((hit) => hit.id)).toEqual([id(8)]);
  expect(first.total).toEqual({ value: 9, relation: 'exact' });
  const maximum = await searchSubjects(search, prefix, { ...plan, size: 200 });
  expect(maximum.hits.map((hit) => hit.id)).toEqual(expected);
  for (const size of [0, -1, 201, 1.5, NaN, Infinity]) {
    expect(() => searchSubjects(search, prefix, { ...plan, size })).toThrow(RangeError);
  }
});
