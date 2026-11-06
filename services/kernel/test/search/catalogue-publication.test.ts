import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { releaseDigest } from '@rezics/definitions';
import { enterCataloguePublicationMembers } from '../../src/library/collection-publication-staging-state.ts';
import { observeCataloguePublication, readCataloguePublicationPage } from '../../src/search/catalogue-publication.ts';
import type { OpenSearch, SearchRequestOptions, SearchRequestWork } from '../../src/search/opensearch.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';
import type { SearchPlan } from '../../src/search/query.ts';
import { zeroScopeWork } from '../../src/search/scope-work.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { WorkAllowance } from '../../src/library/contract/work-dimensions.ts';

const first = '018f0000-0000-7000-8000-00a000000001';
const second = '018f0000-0000-7000-8000-00a000000002';
const third = '018f0000-0000-7000-8000-00a000000003';
const digest = releaseDigest(bundledRelease);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function allowance(keys = 32): WorkAllowance {
  return {
    reservationId: 'catalogue-publication',
    remaining: {
      ...zeroScopeWork(),
      candidateKeys: keys,
      nativePoints: 8,
      statements: 8,
      bytes: 1024 * 1024,
    },
  };
}

function hit(id: string, index: string) {
  return {
    _id: id,
    _index: index,
    _source: { partition: partitionOf(routeOf(id)!), security_revision: 1 },
    sort: [id],
  };
}

/** Trusted `searchSubjectHits` template body. Catalogue publication is the only caller of this mock. */
type SubjectSearchTemplateRequest = Readonly<{
  id: string;
  params: Readonly<{
    after?: SearchPlan['after'];
  }>;
}>;

function catalogueClient(options: {
  generation?: number;
  uuid?: string;
  hits?: readonly string[];
  onWork?: (work: SearchRequestWork | undefined, path: string) => void;
}): OpenSearch {
  const generation = options.generation ?? 1;
  const uuid = options.uuid ?? 'physical-uuid-generation-1';
  const index = `rezics-subjects-g${generation}`;
  const ids = options.hits ?? [first, second, third];
  return {
    async request<T = unknown>(
      _method: 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT',
      path: string,
      _body?: unknown,
      requestOptions?: SearchRequestOptions,
    ) {
      options.onWork?.(requestOptions?.work, path);
      if (path.startsWith('/_resolve/index/')) {
        return {
          status: 200,
          body: {
            indices: [{ name: index, attributes: ['open'], aliases: ['rezics-subjects'] }],
            aliases: [{ name: 'rezics-subjects', indices: [index] }],
            data_streams: [],
          } as T,
        };
      }
      if (path.endsWith('/_settings')) {
        return { status: 200, body: { [index]: { settings: { index: { uuid } } } } as T };
      }
      const after = (_body as SubjectSearchTemplateRequest | undefined)?.params.after?.[0];
      const selected = typeof after === 'string' ? ids.filter((id) => id > after) : ids;
      return {
        status: 200,
        body: {
          timed_out: false,
          _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
          hits: { hits: selected.map((id) => hit(id, index)) },
        } as T,
      };
    },
    async bulk() {
      throw new Error('Catalogue publication does not write the public index');
    },
  };
}

test('catalogue publication frontier admits matching subjects and exhausts an empty final page', () => {
  const started = enterCataloguePublicationMembers(
    { after: null, pending: null, exhausted: false },
    [first, second],
    false,
  );
  expect(started.pending).toMatchObject({
    subject: first,
    coveredThrough: second,
    lastInPage: false,
    sourceExhausted: false,
  });
  const last = enterCataloguePublicationMembers({ after: second, pending: null, exhausted: false }, [third], true);
  expect(last.pending).toMatchObject({ subject: third, lastInPage: true, sourceExhausted: true });
  expect(enterCataloguePublicationMembers({ after: third, pending: null, exhausted: false }, [], true)).toEqual({
    after: third,
    pending: null,
    exhausted: true,
  });
  expect(() =>
    enterCataloguePublicationMembers({ after: null, pending: null, exhausted: false }, [second, first], true),
  ).toThrow();
});

test('catalogue publication pages canonical unique ids, observation and work from the public producer', async () => {
  const works: SearchRequestWork[] = [];
  const deadline = Date.now() + 30_000;
  const page = await readCataloguePublicationPage({
    client: catalogueClient({
      onWork(work) {
        if (work) works.push(work);
      },
    }),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 2,
    deadline,
    work: allowance(),
  });
  expect(page.subjects).toEqual([first, second]);
  expect(page.exhausted).toBe(false);
  expect(page.engineRequests).toBe(3);
  expect(page.observation).toEqual({
    releaseDigest: digest,
    generation: 1,
    uuid: 'physical-uuid-generation-1',
    index: 'rezics-subjects-g1',
  });
  expect(page.work.reservationId).toBe('catalogue-publication');
  expect(page.work.used.candidateKeys).toBe(3);
  expect(page.work.used.statements).toBe(3);
  expect(page.work.used.nativePoints).toBe(2);
  expect(works).toHaveLength(3);
  expect(works.every((work) => work.deadline === deadline && work.bytes > 0)).toBe(true);
});

test('catalogue publication observation settles generation currentness and empty completion', async () => {
  const observed = await observeCataloguePublication({
    client: catalogueClient({}),
    prefix: 'rezics-',
    releaseDigest: digest,
    deadline: Date.now() + 30_000,
    work: allowance(0),
  });
  expect(observed.engineRequests).toBe(2);
  expect(observed.observation.generation).toBe(1);
  const empty = await readCataloguePublicationPage({
    client: catalogueClient({ hits: [] }),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: first,
    limit: 2,
    deadline: Date.now() + 30_000,
    work: allowance(),
    expected: observed.observation,
  });
  expect(empty).toMatchObject({ subjects: [], exhausted: true, observation: observed.observation, engineRequests: 3 });
});

test('selected catalogue A rereads the same observation after a later working page', async () => {
  const deadline = Date.now() + 30_000;
  const selected = await readCataloguePublicationPage({
    client: catalogueClient({}),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 2,
    deadline,
    work: allowance(),
  });
  expect(selected.subjects).toEqual([first, second]);
  const working = await readCataloguePublicationPage({
    client: catalogueClient({}),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: second,
    limit: 1,
    deadline,
    work: allowance(),
    expected: selected.observation,
  });
  expect(working.subjects).toEqual([third]);
  expect(working.observation).toEqual(selected.observation);
  const reread = await readCataloguePublicationPage({
    client: catalogueClient({}),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 2,
    deadline,
    work: allowance(),
    expected: selected.observation,
  });
  expect(reread.subjects).toEqual(selected.subjects);
  expect(reread.observation).toEqual(selected.observation);
  expect(reread.work.used.candidateKeys).toBe(3);
});

test('catalogue publication restarts when the public generation changes', async () => {
  const expected = (
    await observeCataloguePublication({
      client: catalogueClient({ generation: 1, uuid: 'uuid-a' }),
      prefix: 'rezics-',
      releaseDigest: digest,
      deadline: Date.now() + 30_000,
      work: allowance(0),
    })
  ).observation;
  await expect(
    readCataloguePublicationPage({
      client: catalogueClient({ generation: 2, uuid: 'uuid-b', hits: [first] }),
      prefix: 'rezics-',
      filter: { type: { in: ['schema:Book'] } },
      release: bundledRelease,
      releaseDigest: digest,
      after: null,
      limit: 1,
      deadline: Date.now() + 30_000,
      work: allowance(),
      expected,
    }),
  ).rejects.toBeInstanceOf(SearchUnavailableError);
});
