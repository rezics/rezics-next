import { expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { ProblemError } from '../../src/http/problem.ts';
import type { FacetDiscoveryProvider } from '../../src/search/facet-discovery-native.ts';
import { subjectAlias, subjectIndexName, SUBJECT_SORT_FORMAT } from '../../src/search/indices.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import { createSearchService } from '../../src/search/service.ts';
import { createFakeSource } from './support/fake-source.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function held<T>(value: T) {
  let gate = deferred<void>();
  let started = deferred<void>();
  return {
    began: () => started.promise,
    open: () => gate.resolve(),
    arm() {
      gate = deferred<void>();
      started = deferred<void>();
    },
    async lookup() {
      started.resolve();
      await gate.promise;
      return value;
    },
  };
}

const cost: PublicFilterCost = {
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};

const book = '018f0000-0000-7000-8000-00a000000001';
const types = Object.fromEntries(
  ['schema:Book', 'schema:Movie', ...Array.from({ length: 7 }, (_, i) => `kind:Kind${i}`)].map((value, i) => [
    value,
    { bases: [], facets: value === 'schema:Book' ? ['schema:author'] : [], labels: { en: `En${i}`, ja: `Ja${i}` } },
  ]),
);
const catalogue: FilterRelease = {
  types,
  properties: { 'schema:author': { datatype: 'wikibase-item' } },
};

function engine(prefix: string, hold: ReturnType<typeof held<unknown>>) {
  const index = subjectIndexName(prefix, 1);
  const alias = subjectAlias(prefix);
  const scripts = new Map<string, { script: unknown }>();
  const client = {
    async request(method: string, path: string, body?: unknown) {
      if (hold) await hold.lookup();
      if (path.startsWith('/_scripts/')) {
        const id = path.slice('/_scripts/'.length);
        if (method === 'PUT') {
          scripts.set(path, body as { script: unknown });
          return { status: 200, body: { acknowledged: true } };
        }
        return { status: 200, body: { _id: id, found: true, script: scripts.get(path)?.script } };
      }
      if (path.startsWith('/_resolve/index/')) {
        return {
          status: 200,
          body: {
            indices: [{ name: index, attributes: ['open'], aliases: [alias] }],
            aliases: [{ name: alias, indices: [index] }],
            data_streams: [],
          },
        };
      }
      if (path.endsWith('/_mapping')) {
        return {
          status: 200,
          body: {
            [index]: {
              mappings: { properties: { type: { type: 'keyword' } }, _meta: { name_sort_format: SUBJECT_SORT_FORMAT } },
            },
          },
        };
      }
      if (path.endsWith('/_search/template')) {
        const suggest = (body as { id?: string } | undefined)?.id?.endsWith('subjects-suggest-v1');
        return {
          status: 200,
          body: {
            timed_out: false,
            _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
            hits: {
              hits: suggest ? [{ _id: book, _index: index, _source: { partition: 10, security_revision: 1 } }] : [],
            },
          },
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async bulk() {
      throw new Error('unexpected bulk');
    },
  } as unknown as OpenSearch;
  return client;
}

function provider(release: FilterRelease): FacetDiscoveryProvider {
  const queried = {
    consumer: {
      physicalTarget: 'subjects',
      incarnation: '1',
      consumerGeneration: '1',
      projectionGeneration: '1',
      meaningDigest: 'a'.repeat(64),
      readDefinition: 'read',
    },
    snapshot: { kind: 'prepared' as const, observation: 'obs', build: 'build', generation: 1n },
  };
  return {
    source: 'source',
    meaning: { digest: 'a'.repeat(64), release, type: 'schema:Book' } as FacetDiscoveryProvider['meaning'],
    generation: 1,
    operations: {
      async captureFacet() {
        return { status: 'captured', queried, repair: { consumer: queried.consumer, job: 'job' }, cost };
      },
      async pageFacets({ reads }) {
        return {
          status: 'ready',
          facets: reads.map((read) => ({
            property: read.plan.property,
            values: [{ value: 'schema:Book', labels: { en: 'En0', ja: 'Ja0' } }],
            after: 'schema:Book',
            hasMore: false,
          })),
          asOf: '2026-01-01T00:00:00.000Z',
          cost,
        };
      },
      async repairStep() {
        throw new Error('unused');
      },
    },
  };
}

test('mutating caller-owned search, facet or suggestion data during admission cannot change the admitted invocation', async () => {
  const prefix = 'ownreq-';
  const release = held(catalogue);
  const clientHold = held(undefined);
  clientHold.open();
  const source = createFakeSource();
  source.put({
    id: book,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [
      { language: 'en', value: 'Kokoro' },
      { language: 'ja', value: 'こころ' },
    ],
    aliases: [],
    descriptions: [],
    statements: [],
  });
  const service = createSearchService({
    pool: {
      async query() {
        return { rows: [{ now: new Date('2026-01-01T00:00:00.000Z'), behind: 0, oldest: null }] };
      },
    } as unknown as Pool,
    client: engine(prefix, clientHold),
    prefix,
    source,
    cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) },
    release: release.lookup,
    facetProvider: async () => provider(catalogue),
  });

  const searchRequest = {
    languages: ['en'],
    filter: { type: { in: ['schema:Book'] } },
    properties: ['schema:author'],
  };
  const searching = service.search('anonymous', searchRequest);
  await release.began();
  searchRequest.languages.splice(0, 1, 'ja');
  searchRequest.properties.splice(0, 1, 'schema:unknown');
  searchRequest.filter.type.in.splice(0, 1, 'schema:Movie');
  (searchRequest as { cursor?: string }).cursor = 'mutated';
  release.open();
  const page = await searching;
  expect(page.kinds!.values[0]).toMatchObject({ value: 'schema:Book', label: { value: 'En0', language: 'en' } });
  expect(page.kinds!.next).toBeTruthy();

  const continued = await service.search('anonymous', {
    languages: ['en'],
    filter: { type: { in: ['schema:Book'] } },
    properties: ['schema:author'],
    kindCursor: page.kinds!.next!,
  });
  expect(continued.kinds!.values.map((row) => row.value)).toEqual(['kind:Kind6']);
  const rebound = service.search('anonymous', { ...searchRequest, kindCursor: page.kinds!.next! });
  await expect(rebound).rejects.toBeInstanceOf(ProblemError);
  const later = await service.search('anonymous', { languages: ['ja'] });
  expect(later.kinds!.values[0]!.label).toEqual({ value: 'Ja0', language: 'ja' });

  release.arm();
  const facetRequest = { languages: ['en'], facets: [{ property: 'type', size: 10 }] };
  const faceting = service.facets('anonymous', facetRequest);
  await release.began();
  facetRequest.languages.splice(0, 1, 'ja');
  facetRequest.facets[0]!.property = 'schema:unknown';
  release.open();
  expect((await faceting).facets[0]!.values[0]!.labels).toEqual({ en: 'En0' });
  await expect(service.facets('anonymous', facetRequest)).rejects.toBeInstanceOf(ProblemError);
  const laterFacets = await service.facets('anonymous', {
    languages: ['ja'],
    facets: [{ property: 'type', size: 10 }],
  });
  expect(laterFacets.facets[0]!.values[0]!.labels).toEqual({ ja: 'Ja0' });

  clientHold.arm();
  const languages = ['en'];
  const suggesting = service.suggest('ko', 1, languages);
  await clientHold.began();
  languages.splice(0, 1, 'ja');
  clientHold.open();
  expect((await suggesting).subjects[0]!.labels).toEqual({ en: 'Kokoro' });
  expect((await service.suggest('ko', 1, languages)).subjects[0]!.labels).toEqual({ ja: 'こころ' });
});
