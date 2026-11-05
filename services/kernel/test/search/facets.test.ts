import { expect, test } from 'bun:test';
import { admitFilter, type FilterRelease } from '@rezics/filter';
import { ProblemError, type FieldErrorCode } from '../../src/http/problem.ts';
import { admitFacets, discloseFacetValues, validateFacets, type FacetRequest } from '../../src/search/facets.ts';
import { countFacets } from '../../src/search/query.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const facets = [{ property: 'schema:author', size: 20 }];
const release: FilterRelease = {
  types: { 'schema:Book': { facets: ['schema:author'] }, 'schema:Person': { facets: [] } },
  properties: { 'schema:author': { datatype: 'wikibase-item' } },
  filters: { people: { filter: { type: { in: ['schema:Person'] } } } },
};

test('facet validation closes both objects, reports missing fields and bounds sizes', () => {
  const cases: [unknown, string, FieldErrorCode][] = [
    [{}, '/facets', 'required'],
    [{ facets: null }, '/facets', 'invalid_type'],
    [{ facets, kinds: 'collection' }, '/kinds', 'invalid_type'],
    [{ facets, kinds: [] }, '/kinds', 'out_of_range'],
    [{ facets, kinds: [''] }, '/kinds', 'invalid_format'],
    [{ facets: [null] }, '/facets/0', 'invalid_type'],
    [{ facets: [{}] }, '/facets/0/property', 'required'],
    [{ facets, 'a/b~': true }, '/a~1b~0', 'unknown_field'],
    [{ facets: [{ property: 'schema:author', extra: true }] }, '/facets/0/extra', 'unknown_field'],
    ...[0, -1, 1.5, '2', null].map((size): [unknown, string, FieldErrorCode] => [
      { facets: [{ property: 'schema:author', size }] },
      '/facets/0/size',
      'out_of_range',
    ]),
  ];
  for (const [body, pointer, code] of cases) {
    try {
      validateFacets(body as FacetRequest);
      throw new Error('Expected invalid request');
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).errors).toEqual([{ pointer, code }]);
    }
  }
  expect(validateFacets({ facets: [{ property: 'schema:author' }] })).toEqual([
    { property: 'schema:author', size: 10 },
  ]);
  expect(validateFacets({ facets, kinds: ['collection', 'schema:Book'] })).toEqual(facets);
});

test('facet admission preserves type intersections and saved anchors without spending filter limits', () => {
  const maximum = { and: Array.from({ length: 32 }, () => ({ type: { in: ['schema:Book'] } })) };
  admitFilter(maximum, release);
  expect(() => admitFacets(facets, maximum, release)).not.toThrow();
  expect(() => admitFacets(facets, { saved: 'people' }, release)).toThrow(ProblemError);
  expect(() => admitFacets(facets, { and: [{ type: { in: ['schema:Book'] } }, { saved: 'people' }] }, release)).toThrow(
    ProblemError,
  );
});

test('facet value disclosure deduplicates values into one read per partition and fails closed', async () => {
  const reads: { partition: number; ids: readonly string[] }[] = [];
  const subject = (n: number, patch: Partial<IndexedSubject> = {}): IndexedSubject => ({
    id: id(n),
    type: 'schema:Person',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [],
    aliases: [],
    descriptions: [],
    statements: [],
    ...patch,
  });
  const source: SubjectSource = {
    async read(partition, ids) {
      reads.push({ partition, ids });
      return {
        partition,
        position: 0n,
        subjects: [subject(1), subject(2, { visibility: 'taken_down' }), subject(3, { redirect: id(1) })],
      };
    },
    async count() {
      throw new Error('No catalogue scan');
    },
  };
  expect([...(await discloseFacetValues(source, [id(1), id(2), id(1), id(3), id(4), 'bad-id'])).keys()]).toEqual([
    id(1),
  ]);
  expect(reads).toEqual([{ partition: 10, ids: [id(1), id(2), id(3), id(4)] }]);
  await expect(
    discloseFacetValues(
      {
        ...source,
        async read() {
          throw new Error('read failed');
        },
      },
      [id(1)],
    ),
  ).rejects.toThrow('read failed');
});

test('facet counts use one request and mark inexact totals', async () => {
  const requests: unknown[] = [];
  const client = {
    async request(...args: unknown[]) {
      requests.push(args);
      return {
        body: {
          timed_out: false,
          _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
          hits: { total: { value: 10000, relation: 'gte' } },
          aggregations: {
            facet_0: {
              facts: {
                property: {
                  values: {
                    buckets: [
                      { key: id(2), subjects: { doc_count: 1 } },
                      { key: id(1), subjects: { doc_count: 1 } },
                    ],
                  },
                },
              },
            },
          },
        },
      };
    },
  } as unknown as OpenSearch;
  const answer = await countFacets(client, 'test-', { facets, sample: 10000 });
  expect(answer.total.relation).toBe('lower_bound');
  expect(answer.facets[0]!.relation).toBe('lower_bound');
  expect(answer.facets[0]!.values.map(({ value }) => value)).toEqual([id(1), id(2)]);
  expect(requests).toHaveLength(1);
});

test('facet hydration preserves requested order across reverse records, chunks and concurrent homes', async () => {
  const values = Array.from({ length: 257 }, (_, index) => id(index + 10));
  values.splice(1, 0, '018f0000-0000-7000-8000-012300000001');
  const reads: string[][] = [];
  const source: SubjectSource = {
    async read(partition, selected) {
      reads.push([...selected]);
      expect(selected.length).toBeLessThanOrEqual(256);
      if (partition === 10) await Bun.sleep(5);
      return {
        partition,
        position: 0n,
        subjects: [...selected].reverse().map((id) => ({
          id,
          type: 'schema:Person',
          visibility: 'visible',
          redirect: null,
          securityRevision: 0,
          labels: [{ language: 'en', value: id }],
          aliases: [],
          descriptions: [],
          statements: [],
        })),
      };
    },
    async count() {
      throw new Error('No catalogue scan');
    },
  };
  expect([...(await discloseFacetValues(source, [...values, values[0]!, 'bad-id'])).keys()]).toEqual(values);
  expect(reads.map((ids) => ids.length).sort((a, b) => a - b)).toEqual([1, 1, 256]);
});
