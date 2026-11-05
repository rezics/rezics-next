import { expect, test } from 'bun:test';
import { queryScopeOrderedKeys } from '../../src/search/public-filter-consumer.ts';
import type { PublicFilterQueriedObservation } from '../../src/search/public-filter-consumer-contract.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { compareScopeOrderedTuple, scopeOrderedNameKey } from '../../src/search/scope-ordered.ts';
import { subjectPartition } from '../../src/search/source.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const index = 'ordered-test-subjects-g1';
const queried: PublicFilterQueriedObservation = {
  consumer: {
    physicalTarget: index,
    incarnation: 'native-index-uuid',
    consumerGeneration: '1',
    projectionGeneration: '1',
    meaningDigest: null,
    readDefinition: null,
  },
  snapshot: { kind: 'pit', observation: 'native-observation', pit: 'native-pit' },
};
function reply(sort: unknown[] | null) {
  return {
    timed_out: false,
    terminated_early: false,
    pit_id: 'native-successor-pit',
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: {
      hits: sort
        ? [
            {
              _index: index,
              _id: id,
              _source: {
                partition: subjectPartition(id),
                security_revision: 7,
              },
              matched_queries: ['f0'],
              sort,
            },
          ]
        : [],
    },
    profile: {
      shards: [
        {
          id: 'native-shard',
          searches: [
            {
              query: [
                {
                  breakdown: { next_doc_count: 3, advance_count: 2 },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
// Protocol cases use a transport reply to test parsing and dispatch only. They supply no
// Source capture, custody, current permission or successful service admission.
async function query(body: unknown, order: 'name' | 'collections' = 'name') {
  let dispatched: unknown;
  let retained: string | null = null;
  const search = {
    async request(_method: string, _path: string, request: unknown) {
      dispatched = request;
      return { status: 200, body };
    },
  } as unknown as OpenSearch;
  const result = await queryScopeOrderedKeys(
    search,
    queried,
    { sort: order, generation: 1, size: 1 },
    [id],
    { deadline: Date.now() + 1000 },
    async (pit) => {
      retained = pit;
    },
  );
  return { result, dispatched, retained: retained as string | null };
}

test('bounded native name/count windows keep real hit fields, raw tuples, profile and count-free PIT template', async () => {
  for (const name of [null, '', '界'.repeat(512), '\u0000', '😀'.repeat(256)]) {
    for (const order of ['name', 'collections'] as const) {
      const sort = order === 'name' ? [name, id] : [2147483647, name, id];
      const { result, dispatched, retained } = await query(reply(sort), order);
      expect(result.hits).toEqual([
        { id, index, partition: subjectPartition(id), securityRevision: 7, matched: ['f0'], sort },
      ]);
      expect(result.engineIteratorSteps).toBe(5);
      expect(retained).toBe('native-successor-pit');
      expect(dispatched).toMatchObject({
        id: 'ordered-test-subjects-scope-hits-v1',
        params: {
          pit: { id: 'native-pit' },
          size: 1,
          has_after: false,
          filter: { bool: { filter: [{ ids: { values: [id] } }] } },
        },
      });
    }
  }
});

test('every native reply, including zero hits, needs completion and actual iterator evidence', async () => {
  expect((await query(reply(null))).result.hits).toEqual([]);
  const skipped = {
    ...reply(null),
    _shards: { total: 1, successful: 1, skipped: 1, failed: 0 },
    profile: { shards: [] },
  };
  expect((await query(skipped)).result.engineIteratorSteps).toBe(0);
  await expect(query({ ...skipped, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 } })).rejects.toThrow();
  for (const sort of [null, ['', id]]) {
    const complete = reply(sort);
    for (const broken of [
      { ...complete, timed_out: true },
      { ...complete, terminated_early: true },
      { ...complete, _shards: { total: 2, successful: 1, skipped: 0, failed: 1 } },
      { ...complete, pit_id: '' },
      { ...complete, profile: undefined },
    ])
      await expect(query(broken)).rejects.toThrow();
  }
  for (const sort of [
    [-1, '', id],
    [2147483648, '', id],
    [0.5, '', id],
    [0, 'x'.repeat(513), id],
  ])
    await expect(query(reply(sort), 'collections')).rejects.toThrow();
  const other = reply(['', id]);
  other.hits.hits[0]!._index = 'ordered-test-subjects-g2';
  await expect(query(other)).rejects.toThrow();
});

test('the owner ordered step can submit its full hundred-key allowance including lookahead', async () => {
  const keys = Array.from(
    { length: 100 },
    (_, index) => `018f0000-0000-7000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
  );
  let dispatched: unknown;
  const search = {
    async request(_method: string, _path: string, request: unknown) {
      dispatched = request;
      return { status: 200, body: reply(['', keys[0]]) };
    },
  } as unknown as OpenSearch;
  const result = await queryScopeOrderedKeys(
    search,
    queried,
    { sort: 'name', generation: 1, size: 100 },
    keys,
    { deadline: Date.now() + 1000 },
    async () => {},
  );
  expect(result.hits).toHaveLength(1);
  expect(dispatched).toMatchObject({
    params: {
      size: 100,
      filter: { bool: { filter: [{ ids: { values: keys } }] } },
    },
  });
});

test('retained key bytes match native term order, preserve full cursors and distinguish empty from missing', () => {
  expect(scopeOrderedNameKey('界'.repeat(512)).byteLength).toBe(1537);
  expect(scopeOrderedNameKey('')).toEqual(Buffer.from('s'));
  expect(scopeOrderedNameKey(null)).toEqual(Buffer.from('z'));
  expect(compareScopeOrderedTuple('name', ['', id], [null, id])).toBeLessThan(0);
  expect(compareScopeOrderedTuple('name', ['\ue000', id], ['😀', id])).toBeLessThan(0);
  expect(compareScopeOrderedTuple('collections', [2147483647, null, id], [0, '', id])).toBeLessThan(0);
});
