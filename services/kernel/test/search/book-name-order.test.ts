import { expect, test } from 'bun:test';
import { BOOK_CATALOGUE_TYPES } from '@rezics/definitions/contract';
import {
  createSubjectIndex,
  hasSubjectNameOrder,
  readSubjectIndexUuid,
  subjectIndexName,
} from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { queryPublicFilterConsumerPit } from '../../src/search/public-filter-consumer.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { captureComposedPage, observeEngineRequest } from './support/composed-page-cost.ts';

test('Book grain selections collect the first mapped names and resume ties on the same PIT', async () => {
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const measured: OpenSearch = {
    ...search,
    request: <T>(...args: Parameters<OpenSearch['request']>) => observeEngineRequest<T>(search, ...args),
  };
  const prefix = `book-order-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
  await createSubjectIndex(search, prefix, 1);
  try {
    expect(await hasSubjectNameOrder(search, prefix, 1)).toBe(true);
    const incarnation = await readSubjectIndexUuid(search, prefix, 1);
    const consumer = {
      physicalTarget: index,
      incarnation,
      consumerGeneration: '1',
      projectionGeneration: '1',
      meaningDigest: null,
      readDefinition: null,
    };
    let previous = 0;
    const bytes: number[] = [];
    for (const population of [24, 96, 384]) {
      const docs = Array.from({ length: population - previous }, (_, i) => previous + i);
      const bulk = await search.bulk<{ errors: boolean }>(
        docs.flatMap((n) => [
          { index: { _index: index, _id: id(n) } },
          {
            id: id(n),
            type: BOOK_CATALOGUE_TYPES[n % 3],
            name_sort: n < 12 ? 'Ａ' : n === 12 ? null : 'Ｚ' + n,
            partition: subjectPartition(id(n)),
            security_revision: 1,
            facts: [{ property: 'schema:code', value: 'A' }],
          },
        ]),
        { query: { refresh: true } },
      );
      expect(bulk.errors).toBe(false);
      previous = population;
      const {
        body: { pit_id: pit },
      } = await search.request<{ pit_id: string }>('POST', `/${index}/_search/point_in_time?keep_alive=1m`);
      try {
        const observation = { consumer, snapshot: { kind: 'pit' as const, observation: 'order', pit } };
        const read = (types: (typeof BOOK_CATALOGUE_TYPES)[number][], after?: (string | null)[]) =>
          queryPublicFilterConsumerPit(
            measured,
            observation,
            {
              generation: 1,
              sort: 'name',
              size: 3,
              bookTypeList: true,
              filterDocument: { type: { in: types } },
              ...(after && { after }),
            },
            { deadline: Date.now() + 10_000 },
            undefined,
            true,
          );
        const { sample } = await captureComposedPage(async () => {
          for (let mask = 1; mask < 8; mask++) {
            const types = BOOK_CATALOGUE_TYPES.filter((_, i) => (mask & (1 << i)) !== 0);
            const page = await read(types);
            expect(page.result.hits.map((hit) => hit.sort)).toEqual(
              Array.from({ length: 12 }, (_, i) => i)
                .filter((i) => types.includes(BOOK_CATALOGUE_TYPES[i % 3]!))
                .slice(0, 3)
                .map((i) => ['a', id(i)]),
            );
            expect(page.engineIteratorSteps).toBeGreaterThan(0);
          }
        });
        expect(sample.iteratorSteps).toBeLessThan(500);
        expect(sample.profileSearches).toBe(7);
        expect(sample.profileResponseBytes).toBeGreaterThan(sample.responseBytes);
        bytes.push(sample.responseBytes);
        const resumed = await read([...BOOK_CATALOGUE_TYPES], ['a', id(2)]);
        expect(resumed.result.hits.map((hit) => hit.sort)).toEqual([3, 4, 5].map((i) => ['a', id(i)]));
        const missing = await read([...BOOK_CATALOGUE_TYPES], ['\u{10ffff}', id(0)]);
        expect(missing.result.hits.map((hit) => hit.sort)).toEqual([[null, id(12)]]);
      } finally {
        await search.request('DELETE', '/_search/point_in_time', { pit_id: [pit] });
      }
    }
    expect(new Set(bytes).size).toBe(1);
  } finally {
    await search.request('DELETE', `/${index}`);
  }
});
