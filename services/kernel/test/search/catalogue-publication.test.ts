import { afterAll, describe, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { releaseDigest } from '@rezics/definitions';
import { enterCataloguePublicationMembers } from '../../src/library/collection-publication-staging-state.ts';
import {
  lookupCataloguePublication,
  observeCataloguePublication,
  readCataloguePublicationPage,
  readSelectedCataloguePublicationPage,
} from '../../src/search/catalogue-publication.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import type { OpenSearch, SearchRequestOptions, SearchRequestWork } from '../../src/search/opensearch.ts';
import { createOpenSearch, SearchUnavailableError } from '../../src/search/opensearch.ts';
import { installTemplates, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import type { SearchPlan } from '../../src/search/query.ts';
import { zeroScopeWork } from '../../src/search/scope-work.ts';
import type { IndexedSubject } from '../../src/search/source.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { WorkAllowance } from '../../src/library/contract/work-dimensions.ts';
import { createFakeSource } from './support/fake-source.ts';

const first = '018f0000-0000-7000-8000-00a000000001';
const second = '018f0000-0000-7000-8000-00a000000002';
const third = '018f0000-0000-7000-8000-00a000000003';
const digest = releaseDigest(bundledRelease);

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
    filter?: { ids?: { values?: readonly string[] } };
  }>;
}>;

function catalogueClient(options: {
  generation?: number;
  uuid?: string;
  hits?: readonly string[];
  onWork?: (work: SearchRequestWork | undefined, path: string) => void;
  state?: { generation: number; uuid: string };
}): OpenSearch {
  const generationOf = () => options.state?.generation ?? options.generation ?? 1;
  const uuidOf = () => options.state?.uuid ?? options.uuid ?? 'physical-uuid-generation-1';
  const indexOf = () => `rezics-subjects-g${generationOf()}`;
  const ids = options.hits ?? [first, second, third];
  return {
    async request<T = unknown>(
      _method: 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT',
      path: string,
      _body?: unknown,
      requestOptions?: SearchRequestOptions,
    ) {
      options.onWork?.(requestOptions?.work, path);
      const index = indexOf();
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
        return { status: 200, body: { [index]: { settings: { index: { uuid: uuidOf() } } } } as T };
      }
      const params = (_body as SubjectSearchTemplateRequest | undefined)?.params;
      const after = params?.after?.[0];
      const wanted = params?.filter?.ids?.values;
      let selected = typeof after === 'string' ? ids.filter((id) => id > after) : [...ids];
      if (wanted) selected = selected.filter((id) => wanted.includes(id));
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

test('a lost catalogue response rereads the native observation and retries instead of failing the attempt', async () => {
  let searches = 0;
  const expected = (
    await observeCataloguePublication({
      client: catalogueClient({}),
      prefix: 'rezics-',
      releaseDigest: digest,
      deadline: Date.now() + 30_000,
      work: allowance(0),
    })
  ).observation;
  const client = catalogueClient({});
  const original = client.request.bind(client);
  client.request = async (method, path, body, options) => {
    if (path.includes('/_search/template')) {
      searches += 1;
      if (searches === 1) throw new SearchUnavailableError('OpenSearch request timed out');
    }
    return original(method, path, body, options);
  };
  const page = await readCataloguePublicationPage({
    client,
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 2,
    deadline: Date.now() + 30_000,
    work: allowance(),
    expected,
  });
  expect(searches).toBe(2);
  expect(page.subjects).toEqual([first, second]);
  expect(page.observation).toEqual(expected);
});

test('selected catalogue lookup renders stored A and ignores a later working identity', async () => {
  const selected = await readCataloguePublicationPage({
    client: catalogueClient({}),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 2,
    deadline: Date.now() + 30_000,
    work: allowance(),
  });
  const looked = await lookupCataloguePublication({
    client: catalogueClient({ hits: [first, second, third] }),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 3,
    deadline: Date.now() + 30_000,
    work: allowance(),
    expected: selected.observation,
    selected: selected.subjects,
  });
  expect(looked.present).toEqual([first, second]);
  expect(looked.missing).toEqual([]);
  expect(looked.observation).toEqual(selected.observation);
  const absent = await lookupCataloguePublication({
    client: catalogueClient({ hits: [first] }),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 2,
    deadline: Date.now() + 30_000,
    work: allowance(),
    expected: selected.observation,
    selected: [first, second],
  });
  expect(absent.present).toEqual([first]);
  expect(absent.missing).toEqual([second]);
  const reread = await readSelectedCataloguePublicationPage({
    client: catalogueClient({}),
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 2,
    deadline: Date.now() + 30_000,
    work: allowance(),
    expected: selected.observation,
  });
  expect(reread.subjects).toEqual(selected.subjects);
});

test('a lost selected lookup rereads the native observation and retries instead of failing the attempt', async () => {
  let searches = 0;
  const expected = (
    await observeCataloguePublication({
      client: catalogueClient({}),
      prefix: 'rezics-',
      releaseDigest: digest,
      deadline: Date.now() + 30_000,
      work: allowance(0),
    })
  ).observation;
  const client = catalogueClient({ hits: [first, second] });
  const original = client.request.bind(client);
  client.request = async (method, path, body, options) => {
    if (path.includes('/_search/template')) {
      searches += 1;
      if (searches === 1) throw new SearchUnavailableError('OpenSearch request timed out');
    }
    return original(method, path, body, options);
  };
  const looked = await lookupCataloguePublication({
    client,
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    releaseDigest: digest,
    after: null,
    limit: 2,
    deadline: Date.now() + 30_000,
    work: allowance(),
    expected,
    selected: [first, second],
  });
  expect(searches).toBe(2);
  expect(looked.present).toEqual([first, second]);
  expect(looked.missing).toEqual([]);
  expect(looked.observation).toEqual(expected);
});

test('a lost catalogue observation without a pinned selection stays unknown', async () => {
  const client = catalogueClient({});
  const original = client.request.bind(client);
  client.request = async (method, path, body, options) => {
    if (path.startsWith('/_resolve/index/')) throw new SearchUnavailableError('OpenSearch request timed out');
    return original(method, path, body, options);
  };
  await expect(
    observeCataloguePublication({
      client,
      prefix: 'rezics-',
      releaseDigest: digest,
      deadline: Date.now() + 30_000,
      work: allowance(0),
    }),
  ).rejects.toBeInstanceOf(SearchUnavailableError);
});

test('a lost catalogue response fails when the native generation changed before retry', async () => {
  const state = { generation: 1, uuid: 'uuid-a' };
  const expected = (
    await observeCataloguePublication({
      client: catalogueClient({ state }),
      prefix: 'rezics-',
      releaseDigest: digest,
      deadline: Date.now() + 30_000,
      work: allowance(0),
    })
  ).observation;
  const client = catalogueClient({ state, hits: [first] });
  const original = client.request.bind(client);
  client.request = async (method, path, body, options) => {
    if (path.includes('/_search/template')) {
      state.generation = 2;
      state.uuid = 'uuid-b';
      throw new SearchUnavailableError('OpenSearch request timed out');
    }
    return original(method, path, body, options);
  };
  await expect(
    readCataloguePublicationPage({
      client,
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

const searchUrl = process.env.OPENSEARCH_URL;
describe.skipIf(!searchUrl)('native public catalogue publication', () => {
  const client = createOpenSearch(searchUrl!);
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  afterAll(async () => {
    const { generations } = await subjectGenerations(client, prefix);
    for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
    for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
      await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  });

  const book = (n: number, label: string): IndexedSubject => ({
    id: `018f0000-0000-7000-8000-00b0${String(n).padStart(8, '0')}`,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: label }],
    aliases: [],
    descriptions: [],
    statements: [],
  });
  const [firstBook, secondBook, thirdBook] = [book(1, 'Selected A'), book(2, 'Selected A2'), book(3, 'Working B')];

  async function indexSubjects(generation: number, subjects: readonly IndexedSubject[]) {
    const fake = createFakeSource();
    for (const subject of subjects) fake.put(subject);
    const index = subjectIndexName(prefix, generation);
    const ids = subjects.map((subject) => subject.id);
    const snapshot = await fake.read(11, ids);
    await client.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
  }

  async function publish(generation: number, subjects: readonly IndexedSubject[]) {
    await createSubjectIndex(client, prefix, generation);
    await indexSubjects(generation, subjects);
    await client.request('POST', '/_aliases', {
      actions: [
        ...(generation > 1
          ? [{ remove: { index: subjectIndexName(prefix, generation - 1), alias: subjectAlias(prefix) } }]
          : []),
        { add: { index: subjectIndexName(prefix, generation), alias: subjectAlias(prefix) } },
      ],
    });
  }

  test('selected public A renders through the pinned native catalogue after working B is indexed', async () => {
    await installTemplates(client, prefix);
    await publish(1, [firstBook, secondBook]);
    const selected = await readCataloguePublicationPage({
      client,
      prefix,
      filter: { type: { in: ['schema:Book'] } },
      release: bundledRelease,
      releaseDigest: digest,
      after: null,
      limit: 2,
      deadline: Date.now() + 30_000,
      work: allowance(),
    });
    expect(selected.subjects).toEqual([firstBook.id, secondBook.id]);
    expect(selected.observation.generation).toBe(1);
    await indexSubjects(1, [thirdBook]);
    const looked = await lookupCataloguePublication({
      client,
      prefix,
      filter: { type: { in: ['schema:Book'] } },
      release: bundledRelease,
      releaseDigest: digest,
      after: null,
      limit: 3,
      deadline: Date.now() + 30_000,
      work: allowance(),
      expected: selected.observation,
      selected: selected.subjects,
    });
    expect(looked.present).toEqual(selected.subjects);
    expect(looked.missing).toEqual([]);
    expect(looked.observation).toEqual(selected.observation);
    await publish(2, [firstBook, secondBook, thirdBook]);
    await expect(
      readSelectedCataloguePublicationPage({
        client,
        prefix,
        filter: { type: { in: ['schema:Book'] } },
        release: bundledRelease,
        releaseDigest: digest,
        after: null,
        limit: 3,
        deadline: Date.now() + 30_000,
        work: allowance(),
        expected: selected.observation,
      }),
    ).rejects.toBeInstanceOf(SearchUnavailableError);
    const advanced = await readCataloguePublicationPage({
      client,
      prefix,
      filter: { type: { in: ['schema:Book'] } },
      release: bundledRelease,
      releaseDigest: digest,
      after: null,
      limit: 3,
      deadline: Date.now() + 30_000,
      work: allowance(),
    });
    expect(advanced.subjects).toEqual([firstBook.id, secondBook.id, thirdBook.id]);
    expect(advanced.observation.generation).toBe(2);
  });
});
