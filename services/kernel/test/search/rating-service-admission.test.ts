import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createSearchService, type SearchRequest } from '../../src/search/service.ts';
import type { PublicRatingEpoch, PublicRatingFigure, PublicRatingSource } from '../../src/search/rating-source.ts';
import type { IndexedSubject } from '../../src/search/source.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } from '../../src/search/query.ts';
import type { Pool } from 'pg';
import { createFakeSource } from './support/fake-source.ts';

const pool = createPool(process.env.DATABASE_URL!);
const native = createOpenSearch(process.env.OPENSEARCH_URL!);
const prefixes: string[] = [];
export const context = (priorEpoch: number | null): PublicRatingEpoch => ({
  questionId: STANDARD_QUESTION_ID,
  populationId: GLOBAL_CONTEXT.id,
  priorEpoch,
});
export const book = (n: number): IndexedSubject => ({
  id: `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`,
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${String(n).padStart(4, '0')}` }],
  aliases: [],
  descriptions: [],
  statements: [],
});
export const figure = (subjectId: string, score: number | null, priorEpoch: number | null = 1): PublicRatingFigure => ({
  ...context(priorEpoch),
  subjectId,
  count: 5,
  mean: 5,
  score,
  revision: '1',
  asOf: new Date().toISOString(),
});

// Actual native searches and controller code, with explicit rating mapping and controlled current Source ports.
// This isolates service wiring; it does not prove production mapping, votes or default semantic composition.
export async function deployment(
  entries: { subject: IndexedSubject; score?: number; epoch?: number }[] = [],
  withRatings = true,
) {
  const prefix = `rating-service-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  const fake = createFakeSource();
  const figures = new Map<string, PublicRatingFigure>();
  let epoch: PublicRatingEpoch = context(1);
  let epochCalls = 0;
  let aliasCalls = 0;
  let searches = 0;
  let freshnessCalls = 0;
  const sizes: number[] = [];
  let onEpoch: (() => Promise<void>) | undefined;
  let onSearch: ((number: number) => Promise<void>) | undefined;
  let onRead: (() => Promise<void>) | undefined;
  let epochFailure = false;
  let sourceFailure = false;
  const ratings: PublicRatingSource = {
    async epoch() {
      epochCalls++;
      await onEpoch?.();
      if (epochFailure) throw new Error('native epoch unavailable');
      return { ...epoch };
    },
    async read(partition, ids) {
      await onRead?.();
      if (sourceFailure) throw new Error('native figures unavailable');
      return {
        partition,
        position: 1n,
        figures: new Map(ids.flatMap((id) => (figures.has(id) ? [[id, figures.get(id)!]] : []))),
      };
    },
  };
  const client: OpenSearch = {
    request: (async (...args: Parameters<OpenSearch['request']>) => {
      if (args[1].startsWith('/_resolve/index/')) aliasCalls++;
      if (args[1].endsWith('/_search/template')) {
        searches++;
        await onSearch?.(searches);
        sizes.push((args[2] as { params: { size: number } }).params.size);
      }
      return native.request(...args);
    }) as OpenSearch['request'],
    bulk: native.bulk.bind(native),
  };
  async function publish(generation: number) {
    await createSubjectIndex(native, prefix, generation);
    const index = subjectIndexName(prefix, generation);
    await native.request('PUT', `/${index}/_mapping`, {
      properties: { rating_score: { type: 'double' }, rating_prior_epoch: { type: 'long' } },
    });
    for (const { subject, score, epoch: indexedEpoch = 1 } of entries) {
      fake.put(subject);
      await native.request(
        'PUT',
        `/${index}/_doc/${subject.id}`,
        {
          id: subject.id,
          partition: 10,
          security_revision: 1,
          type: subject.type,
          name_sort: subject.labels[0]!.value.toLowerCase(),
          search_text: ['book'],
          ...(score === undefined ? {} : { rating_score: score, rating_prior_epoch: indexedEpoch }),
        },
        { query: { refresh: 'true' } },
      );
      if (score !== undefined) figures.set(subject.id, figure(subject.id, score, indexedEpoch));
    }
    await native.request('POST', '/_aliases', {
      actions: [
        ...(generation === 1 ? [] : [{ remove: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }]),
        { add: { index, alias: subjectAlias(prefix) } },
      ],
    });
  }
  await publish(1);
  const observedPool = Object.create(pool) as Pool;
  observedPool.query = ((...args: Parameters<Pool['query']>) => {
    freshnessCalls++;
    return pool.query(...args);
  }) as Pool['query'];
  const service = createSearchService({
    pool: observedPool,
    client,
    prefix,
    source: fake,
    ...(withRatings ? { ratings } : {}),
    cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) },
    release: async () => ({ types: { 'schema:Book': { facets: [] } }, properties: {} }),
  });
  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(13),
    search: service,
    access: {
      async authenticate() {
        throw new Error('no credentials');
      },
      async authorize() {
        return true;
      },
    },
  });
  return {
    service,
    figures,
    fake,
    publish,
    async unscore(id: string) {
      await native.request(
        'POST',
        `/${subjectIndexName(prefix, 1)}/_update/${id}`,
        {
          script: { source: "ctx._source.remove('rating_score');ctx._source.remove('rating_prior_epoch')" },
        },
        { query: { refresh: 'true' } },
      );
      figures.delete(id);
    },
    counts: () => ({ epochCalls, aliasCalls, searches, sizes, freshnessCalls }),
    setEpoch: (value: PublicRatingEpoch) => {
      epoch = value;
    },
    failEpoch: () => {
      epochFailure = true;
    },
    failSource: () => {
      sourceFailure = true;
    },
    onEpoch: (fn: () => Promise<void>) => {
      onEpoch = fn;
    },
    onSearch: (fn: (number: number) => Promise<void>) => {
      onSearch = fn;
    },
    onRead: (fn: () => Promise<void>) => {
      onRead = fn;
    },
    http: (body: unknown) =>
      kernel.handle(
        new Request('http://kernel.test/v1/subjects:search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    search: (request: SearchRequest = { sort: 'rating' }) => service.search('anonymous', request),
  };
}
afterAll(async () => {
  for (const prefix of prefixes) {
    await native.request('DELETE', `/${prefix}subjects-g*`);
    for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
      await native.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
  await pool.end();
});

test('strict controller and service admission precedes rating metadata IO', async () => {
  const d = await deployment();
  for (const key of ['question', 'population', 'epoch', 'phase', 'questionId', 'priorEpoch', 'ratingPhase'])
    expect((await d.http({ sort: 'rating', [key]: 'override' })).status).toBe(400);
  for (const request of [{ sort: 'other' }, { sort: 'rating', limit: 101 }, { sort: 'rating', languages: ['bad!'] }])
    expect((await d.http(request)).status).toBe(400);
  expect((await d.http({ sort: 'rating', text: '"' })).status).toBe(422);
  expect(d.counts().epochCalls).toBe(0);
  await d.search({ sort: 'name' });
  expect(d.counts().epochCalls).toBe(0);
});

test('rating empty pages bracket current context and generation; transport omits aggregates', async () => {
  const d = await deployment();
  const result = await d.search();
  expect(result.subjects).toEqual([]);
  expect(result.next).toBeNull();
  expect(result).not.toHaveProperty('total');
  expect(result).not.toHaveProperty('count');
  expect(d.counts().epochCalls).toBe(2);
  expect(d.counts().aliasCalls).toBe(2);
  expect(d.counts().freshnessCalls).toBe(1);
  expect((await d.http({ sort: 'rating' })).status).toBe(200);
});

test('missing rating dependency fails closed and ordinary searches remain independent', async () => {
  const d = await deployment([], false);
  await expect(d.search()).rejects.toMatchObject({ code: 'index_not_ready', headers: { 'retry-after': '1' } });
  expect((await d.search({ sort: 'name' })).subjects).toEqual([]);
  expect(d.counts().epochCalls).toBe(0);
});
