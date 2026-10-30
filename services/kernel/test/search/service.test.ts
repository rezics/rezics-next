import { afterAll, expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import type { PublicFigureView } from '../../src/rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { ProblemError, problemResponse } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createFakeSource } from './support/fake-source.ts';

const missingFigure: PublicFigureView = {
  questionId: STANDARD_QUESTION_ID,
  populationId: GLOBAL_CONTEXT.id,
  scale: { min: 0, max: 20, displayStep: 1 },
  count: 0,
  state: 'insufficient_data',
  mean: null,
  score: null,
};

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const client = createOpenSearch(searchUrl);
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
const account = 'account:019a1b2c-3d4e-7f00-8a00-5ab1ec700001';
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const prefixes: string[] = [];

afterAll(async () => {
  for (const prefix of prefixes) {
    const { generations } = await subjectGenerations(client, prefix);
    for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
    for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE]) {
      await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
    }
  }
  await pool.end();
});

function freshPrefix(): string {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  return prefix;
}

const route = (partition: number) => (partition * 16).toString(16).padStart(4, '0');
const subject = (n: number, label: string, partition = 10, patch: Partial<IndexedSubject> = {}): IndexedSubject => ({
  id: `018f0000-0000-7000-8000-${route(partition)}${String(n).padStart(8, '0')}`,
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: label }],
  aliases: [],
  descriptions: [],
  statements: [],
  ...patch,
});
const kokoro = subject(1, 'Kokoro');
const kanata = subject(2, 'Kokoro no Kanata');
const connect = subject(3, 'Kokoro Connect', 18);
const miso = subject(4, 'Miso soup', 10, { type: 'schema:Recipe' });
type Fake = ReturnType<typeof createFakeSource>;

/** Indexes the source's current state of `subjects` as generation `generation` and points the alias at it. */
async function publish(prefix: string, fake: Fake, subjects: readonly IndexedSubject[], generation: number) {
  await createSubjectIndex(client, prefix, generation);
  const index = subjectIndexName(prefix, generation);
  const partitions = new Map<number, string[]>();
  for (const entry of subjects) {
    const partition = subjectPartition(entry.id);
    partitions.set(partition, [...(partitions.get(partition) ?? []), entry.id]);
  }
  for (const [partition, ids] of partitions) {
    const snapshot = await fake.read(partition, ids);
    await client.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
  }
  const { active } = await subjectGenerations(client, prefix);
  const alias = subjectAlias(prefix);
  const actions: object[] = [{ add: { index, alias } }];
  if (active !== null && active !== generation) {
    actions.unshift({ remove: { index: subjectIndexName(prefix, active), alias } });
  }
  await client.request('POST', '/_aliases', { actions });
}

async function deployment(
  subjects: readonly IndexedSubject[],
  options: {
    source?: (fake: Fake) => SubjectSource;
    client?: OpenSearch;
    release?: () => Promise<FilterRelease | null>;
    cursors?: KeyRing;
  } = {},
) {
  const prefix = freshPrefix();
  const fake = createFakeSource();
  for (const entry of subjects) fake.put(entry);
  await publish(prefix, fake, subjects, 1);
  const source = options.source ? options.source(fake) : fake;
  const service = createSearchService({
    pool,
    client: options.client ?? client,
    prefix,
    source,
    cursors: options.cursors ?? cursors,
    release:
      options.release ??
      (async () => ({
        types: { 'schema:Book': { facets: [] }, 'schema:Recipe': { facets: [] } },
        properties: {},
      })),
  });
  return { prefix, fake, service };
}

async function problem(
  promise: Promise<unknown>,
  code: string,
  errors?: { pointer: string; code: string }[],
): Promise<ProblemError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProblemError);
  expect((error as ProblemError).code as string).toBe(code);
  if (errors) expect((error as ProblemError).errors as unknown).toEqual(errors);
  return error as ProblemError;
}

const tamper = (token: string) => `${token.slice(0, 10)}${token[10] === 'A' ? 'B' : 'A'}${token.slice(11)}`;
const ids = (page: { subjects: { id: string }[] }) => page.subjects.map((result) => result.id);

test('results come from the current subject state with as_of and no total', async () => {
  const { fake, service } = await deployment([kokoro, kanata, connect, miso]);
  fake.put({
    ...kanata,
    labels: [
      { language: 'en', value: 'Kokoro no Kanata' },
      { language: 'ja', value: 'ココロのカナタ' },
    ],
  });
  const before = Date.now();
  const response = await service.search('anonymous', { text: 'kokoro' });
  expect(response.subjects[0]!.id).toBe(kokoro.id);
  expect(ids(response).sort()).toEqual([kokoro.id, kanata.id, connect.id].sort());
  expect(response.subjects.find((result) => result.id === kanata.id)).toEqual({
    id: kanata.id,
    type: 'schema:Book',
    labels: { en: 'Kokoro no Kanata', ja: 'ココロのカナタ' },
    figure: missingFigure,
  });
  expect(response).not.toHaveProperty('total');
  expect(response.next).toBeNull();
  expect(response.as_of).toMatch(RFC3339);
  expect(Date.parse(response.as_of)).toBeGreaterThan(before - 60_000);
  expect(Date.parse(response.as_of)).toBeLessThanOrEqual(Date.now() + 1000);
  expect((await service.search(account, { text: 'kokoro' })).subjects).toEqual(response.subjects);
});

test('hits the final check refuses are dropped and the page fills from the next candidates', async () => {
  const books = [1, 2, 3, 4, 5, 6].map((n) => subject(n, `Natsume ${n}`));
  const { fake, service } = await deployment(books);
  fake.put({ ...books[0]!, visibility: 'taken_down', securityRevision: 2 });
  fake.put({ ...books[1]!, visibility: 'hidden', securityRevision: 2 });
  fake.put({ ...books[2]!, securityRevision: 2 });
  const request = { text: 'natsume', sort: 'name' as const, limit: 2 };
  const page = await service.search('anonymous', request);
  expect(ids(page)).toEqual([books[3]!.id, books[4]!.id]);
  expect(page.next).not.toBeNull();
  const next = await service.search('anonymous', { ...request, cursor: page.next! });
  expect(ids(next)).toEqual([books[5]!.id]);
  expect(next.next).toBeNull();
});

test('pages continue through signed tokens bound to the request and the principal', async () => {
  const books = [1, 2, 3, 4, 5].map((n) => subject(n, `Soseki ${n}`));
  const { service } = await deployment(books);
  const request = { text: 'soseki', sort: 'name' as const, limit: 2 };
  const first = await service.search('anonymous', request);
  const second = await service.search('anonymous', { ...request, cursor: first.next! });
  const third = await service.search('anonymous', { ...request, cursor: second.next! });
  expect([first, second, third].flatMap(ids)).toEqual(books.map((book) => book.id));
  expect(third.next).toBeNull();
  expect(first).not.toHaveProperty('total');
  const token = first.next!;
  const invalid = [{ pointer: '/cursor', code: 'invalid_format' }];
  await problem(
    service.search('anonymous', { ...request, text: 'natsume', cursor: token }),
    'invalid_request',
    invalid,
  );
  await problem(service.search('anonymous', { ...request, limit: 3, cursor: token }), 'invalid_request', invalid);
  await problem(service.search(account, { ...request, cursor: token }), 'invalid_request', invalid);
  await problem(service.search('anonymous', { ...request, cursor: tamper(token) }), 'invalid_request', invalid);
});

test('an expired token or one from another generation needs a restart', async () => {
  const books = [1, 2, 3].map((n) => subject(n, `Ogai ${n}`));
  const { prefix, fake, service } = await deployment(books);
  const request = { text: 'ogai', sort: 'name' as const, limit: 1 };
  const issued = Date.now();
  const first = await service.search('anonymous', request, issued);
  const token = first.next!;
  await problem(
    service.search('anonymous', { ...request, cursor: token }, issued + 15 * 60_000 + 1),
    'search_restart_required',
  );
  expect(ids(await service.search('anonymous', { ...request, cursor: token }, issued + 1000))).toEqual([books[1]!.id]);
  await publish(prefix, fake, books, 2);
  await problem(service.search('anonymous', { ...request, cursor: token }), 'search_restart_required');
  expect(ids(await service.search('anonymous', request))).toEqual([books[0]!.id]);
});

test('text, filter, sort and paging errors are typed problems with pointers', async () => {
  const { service } = await deployment([kokoro]);
  const book = { type: { in: ['schema:Book'] } };
  const cases: [Parameters<typeof service.search>[1], string, { pointer: string; code: string }[]][] = [
    [{ text: '"unclosed' }, 'unsupported_query', [{ pointer: '/text', code: 'unsupported' }]],
    [{ text: 'a'.repeat(513) }, 'unsupported_query', [{ pointer: '/text', code: 'out_of_range' }]],
    [{ text: '-kokoro' }, 'unsupported_query', [{ pointer: '/text', code: 'unsupported' }]],
    [{ filter: { not: book } }, 'unsupported_query', [{ pointer: '/filter', code: 'unsupported' }]],
    [
      { filter: { colour: { in: ['red'] } } },
      'invalid_request',
      [{ pointer: '/filter/colour', code: 'unknown_field' }],
    ],
    [
      { filter: { or: Array.from({ length: 17 }, () => book) } },
      'unsupported_query',
      [{ pointer: '/filter/or', code: 'out_of_range' }],
    ],
    [{ sort: 'relevance' }, 'unsupported_query', [{ pointer: '/sort', code: 'unsupported' }]],
    [{ limit: 101 }, 'invalid_request', [{ pointer: '/limit', code: 'out_of_range' }]],
    [{ limit: 0 }, 'invalid_request', [{ pointer: '/limit', code: 'out_of_range' }]],
    [{ cursor: 'not-a-token' }, 'invalid_request', [{ pointer: '/cursor', code: 'invalid_format' }]],
  ];
  for (const [request, code, errors] of cases) await problem(service.search('anonymous', request), code, errors);
  expect((await service.search('anonymous', { text: '-kokoro', filter: book })).subjects).toEqual([]);
  expect(ids(await service.search('anonymous', { text: 'kokoro -connect', filter: book }))).toEqual([kokoro.id]);
  expect(ids(await service.search('anonymous', {}))).toEqual([kokoro.id]);
});

test('saved filters use expanded positivity and keep the parsed filter in the cursor binding', async () => {
  const book = { type: { in: ['schema:Book'] } };
  const release: FilterRelease = {
    types: { 'schema:Book': { facets: [] }, 'schema:Recipe': { facets: [] } },
    properties: {},
    filters: {
      'subjects/current': { filter: book },
      'subjects/other': { filter: { not: book } },
    },
  };
  let reads = 0;
  const { service } = await deployment([kokoro, kanata, miso], {
    release: async () => {
      reads++;
      return release;
    },
  });
  await service.search('anonymous', { text: 'kokoro' });
  await service.search('anonymous', {});
  expect(reads).toBe(0);
  await problem(service.search('anonymous', { filter: { saved: 'subjects/other' } }), 'unsupported_query', [
    { pointer: '/filter', code: 'unsupported' },
  ]);
  expect(reads).toBe(1);
  const request = { filter: { saved: 'subjects/current' }, limit: 1 };
  const first = await service.search('anonymous', request);
  expect(ids(first)).toEqual([kokoro.id]);
  expect(first.next).not.toBeNull();
  release.filters!['subjects/current'] = { filter: { type: { in: ['schema:Recipe'] } } };
  const next = await service.search('anonymous', { ...request, cursor: first.next! });
  expect(ids(next)).toEqual([miso.id]);
  expect(reads).toBe(3);
});

test('typeahead suggests only subjects that pass the final check', async () => {
  const { fake, service } = await deployment([kokoro, kanata, connect, miso]);
  fake.put({ ...kanata, visibility: 'taken_down', securityRevision: 2 });
  const response = await service.suggest('Koko');
  expect(ids(response).sort()).toEqual([kokoro.id, connect.id].sort());
  expect(response.as_of).toMatch(RFC3339);
  expect((await service.suggest('Koko', 1)).subjects).toHaveLength(1);
  expect((await service.suggest('miso')).subjects).toEqual([
    { id: miso.id, type: 'schema:Recipe', labels: { en: 'Miso soup' } },
  ]);
  const range = (pointer: string) => [{ pointer, code: 'out_of_range' }];
  await problem(service.suggest(''), 'invalid_request', range('/q'));
  await problem(service.suggest('字'.repeat(65)), 'invalid_request', range('/q'));
  await problem(service.suggest('Koko', 11), 'invalid_request', range('/limit'));
  await problem(service.suggest('Koko', 0), 'invalid_request', range('/limit'));
});

test("typeahead labels follow the reader's language chain", async () => {
  const labelledKanata = {
    ...kanata,
    labels: [
      { language: 'en', value: 'Kokoro no Kanata' },
      { language: 'zh-Hant', value: '心之彼方' },
    ],
  };
  const { service } = await deployment([kokoro, labelledKanata, connect, miso]);
  const languages = ['zh-Hans', 'zh', 'zh-Hant'];
  const direct = await service.suggest('Koko', 8, languages);
  expect(direct.subjects.find(({ id }) => id === kanata.id)!.labels).toEqual({ 'zh-Hant': '心之彼方' });

  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(13),
    search: service,
    access: {
      async authenticate() {
        throw new Error('no credentials in this test');
      },
      async authorize() {
        return true;
      },
    },
  });
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects:suggest?q=Koko&languages=zh-Hans&languages=zh&languages=zh-Hant'),
  );
  expect(response.status).toBe(200);
  const answer = (await response.json()) as { subjects: { id: string; labels: Record<string, string> }[] };
  expect(answer.subjects.find(({ id }) => id === kanata.id)!.labels).toEqual({ 'zh-Hant': '心之彼方' });

  const invalid = await kernel.handle(new Request('http://kernel.test/v1/subjects:suggest?q=Koko&languages=bad%21'));
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    code: 'invalid_request',
    errors: [{ pointer: '/languages/0', code: 'invalid_format' }],
  });
});

test('an unreachable node, a missing alias or a missing template is index_not_ready', async () => {
  const unreachable = createSearchService({
    pool,
    client: createOpenSearch('http://127.0.0.1:9', { timeoutMs: 2000 }),
    prefix: freshPrefix(),
    source: createFakeSource(),
    cursors,
  });
  const down = await problem(unreachable.search('anonymous', { text: 'kokoro' }), 'index_not_ready');
  expect(down.headers?.['retry-after']).toMatch(/^\d+$/);
  await problem(unreachable.suggest('Koko'), 'index_not_ready');
  const missing = createSearchService({ pool, client, prefix: freshPrefix(), source: createFakeSource(), cursors });
  await problem(missing.search('anonymous', { text: 'kokoro' }), 'index_not_ready');
  const { prefix, service } = await deployment([kokoro]);
  expect(ids(await service.search('anonymous', { text: 'kokoro' }))).toEqual([kokoro.id]);
  await client.request('DELETE', `/_scripts/${prefix}${SEARCH_TEMPLATE}`);
  await problem(service.search('anonymous', { text: 'kokoro' }), 'index_not_ready');
  expect(ids(await service.search('anonymous', { text: 'kokoro' }))).toEqual([kokoro.id]);
});

test('each request makes at most three index requests and reads only the partitions of examined hits', async () => {
  const subjects = Array.from({ length: 240 }, (_, index) =>
    subject(index + 1, `Growth ${index + 1}`, 1 + (index % 4)),
  );
  let searches = 0;
  const reads: string[][] = [];
  const counting: OpenSearch = {
    request: ((...args: Parameters<OpenSearch['request']>) => {
      if (args[1].endsWith('/_search/template')) searches += 1;
      return client.request(...args);
    }) as OpenSearch['request'],
    bulk: ((...args: Parameters<OpenSearch['bulk']>) => client.bulk(...args)) as OpenSearch['bulk'],
  };
  const { fake, service } = await deployment(subjects, {
    client: counting,
    source: (inner) => ({
      read: (partition, list) => {
        reads.push([...list]);
        return inner.read(partition, list);
      },
      count: (partition) => inner.count(partition),
    }),
  });
  subjects.forEach((entry, index) => {
    if (index % 3 === 0) fake.put({ ...entry, visibility: 'taken_down', securityRevision: 2 });
  });
  for (const pageSize of [1, 10, 100]) {
    searches = 0;
    reads.length = 0;
    const page = await service.search('anonymous', { text: 'growth', sort: 'name', limit: pageSize });
    expect({ pageSize, subjects: page.subjects.length }).toEqual({ pageSize, subjects: pageSize });
    expect(searches).toBeLessThanOrEqual(3);
    expect(reads.length).toBeLessThanOrEqual(3 * 4);
    for (const read of reads) expect(read.length).toBeLessThanOrEqual(2 * pageSize + 1);
  }
});

test('every listing sort restarts after an alias switch while keeping all queries pinned, including empty results and valid cursors', async () => {
  for (const sort of ['name', 'collections', 'id', 'relevance'] as const) {
    const books = [subject(1, 'Pinned Alpha'), subject(2, 'Pinned Zeta')];
    let prefix: string;
    let switched = false;
    let resolutions = 0;
    const mappings: string[] = [];
    const targets: string[] = [];
    const racing: OpenSearch = {
      bulk: (...args) => client.bulk(...args),
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await client.request<T>(...args);
        if (args[1].startsWith('/_resolve/index/')) resolutions++;
        if (args[1].endsWith('/_mapping')) mappings.push(args[1]);
        if (args[1].endsWith('/_mapping') && !switched) {
          switched = true;
          await client.request('POST', '/_aliases', {
            actions: [
              { remove: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } },
              { add: { index: subjectIndexName(prefix, 2), alias: subjectAlias(prefix) } },
            ],
          });
        }
        if (args[1].endsWith('/_search/template')) targets.push(args[1]);
        return response;
      },
    };
    const env = await deployment(books, { client: racing });
    prefix = env.prefix;
    await publish(prefix, env.fake, books, 2);
    for (const scenario of [
      { text: 'pinned', continuation: false },
      { text: 'nohit', continuation: false },
      { text: 'pinned', continuation: true },
    ]) {
      await client.request('POST', '/_aliases', {
        actions: [
          { remove: { index: subjectIndexName(prefix, 2), alias: subjectAlias(prefix) } },
          { add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } },
        ],
      });
      const request = { text: scenario.text, sort, limit: 1 };
      // Obtain an authentic cursor while its original generation is still active.
      switched = true;
      const cursor = scenario.continuation ? (await env.service.search('anonymous', request)).next! : undefined;
      if (scenario.continuation) expect(cursor).toBeString();
      switched = false;
      resolutions = 0;
      mappings.length = 0;
      targets.length = 0;
      const error = await problem(
        env.service.search('anonymous', { ...request, ...(cursor ? { cursor } : {}) }),
        'search_restart_required',
      );
      expect(switched).toBe(true);
      expect(resolutions).toBe(2);
      expect(mappings).toEqual([`/${subjectIndexName(prefix, 1)}/_mapping`]);
      expect(targets).toEqual([`/${subjectIndexName(prefix, 1)}/_search/template`]);
      const response = problemResponse(error, { method: 'POST', id: 'alias-switch-test' });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ code: 'search_restart_required' });
      for (const key of ['subjects', 'next', 'total', 'as_of']) expect(body).not.toHaveProperty(key);
    }
  }
});

test('listing readiness requires the actual supported format for all sorts before any query', async () => {
  const targets: string[] = [];
  const observing: OpenSearch = {
    bulk: (...args) => client.bulk(...args),
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      if (args[1].endsWith('/_search/template')) targets.push(args[1]);
      return client.request<T>(...args);
    },
  };
  const { prefix, service } = await deployment([kokoro], { client: observing });
  expect(ids(await service.search('anonymous', { text: 'kokoro' }))).toEqual([kokoro.id]);
  for (const meta of [{}, { name_sort_format: 0 }, { name_sort_format: 2 }]) {
    await client.request('PUT', `/${subjectIndexName(prefix, 1)}/_mapping`, { _meta: meta });
    targets.length = 0;
    for (const sort of ['name', 'collections', 'id', 'relevance'] as const) {
      await problem(service.search('anonymous', { text: 'nohit', sort }), 'index_not_ready');
    }
    expect(targets).toEqual([]);
  }
});

type ReceiptPage = {
  hits: {
    hits: {
      _id: string;
      _index: string;
      _source: { partition: number; security_revision: number };
      sort: (string | number | null)[];
    }[];
    total: unknown;
  };
};
function receiptObserver() {
  let corrupt: ((page: ReceiptPage) => void) | undefined;
  const calls: { path: string; request: unknown; raw: ReceiptPage; delivered: ReceiptPage }[] = [];
  const observed: OpenSearch = {
    bulk: (...args) => client.bulk(...args),
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const response = await client.request<T>(...args);
      if (!args[1].endsWith('/_search/template')) return response;
      const raw = structuredClone(response.body) as ReceiptPage;
      const delivered = structuredClone(raw);
      corrupt?.(delivered);
      calls.push({ path: args[1], request: structuredClone(args[2]), raw, delivered });
      return { ...response, body: delivered as T };
    },
  };
  return {
    client: observed,
    calls,
    change: (next?: typeof corrupt) => {
      corrupt = next;
    },
  };
}

test('real service refuses cloned native ordinary identity/order/frontier faults before current Source or cursor signing', async () => {
  const books = Array.from({ length: 8 }, (_, n) => subject(n + 1, `Receipt ${n + 1}`));
  const observed = receiptObserver();
  let reads = 0;
  let signs = 0;
  const { prefix, service } = await deployment(books, {
    client: observed.client,
    cursors: {
      keys: cursors.keys,
      get current() {
        signs++;
        return cursors.current;
      },
    },
    source: (fake) => ({
      read: (...args) => {
        reads++;
        return fake.read(...args);
      },
      count: (...args) => {
        reads++;
        return fake.count(...args);
      },
    }),
  });
  for (const sort of ['id', 'name', 'collections', 'relevance'] as const) {
    const request = { text: 'receipt', sort, limit: 1 };
    observed.change();
    observed.calls.length = 0;
    const first = await service.search('anonymous', request);
    expect(first.subjects).toHaveLength(1);
    expect(first.next).toBeString();
    const before = structuredClone(observed.calls[0]!.raw.hits.hits[0]!);
    observed.calls.length = 0;
    const second = await service.search('anonymous', { ...request, cursor: first.next! });
    expect(second.subjects).toHaveLength(1);
    expect(second.next).toBeString();
    const frontier = structuredClone(observed.calls[0]!.raw.hits.hits[0]!);
    expect(frontier._id).toBe(second.subjects[0]!.id);
    const faults: { name: string; cursor?: string; change: (page: ReceiptPage) => void }[] = [
      {
        name: 'duplicate',
        change: (page) => {
          page.hits.hits[1] = structuredClone(page.hits.hits[0]!);
        },
      },
      {
        name: 'reordered',
        change: (page) => {
          page.hits.hits.reverse();
        },
      },
      {
        name: 'equal frontier',
        cursor: second.next!,
        change: (page) => {
          page.hits.hits[0] = structuredClone(frontier);
        },
      },
      {
        name: 'before frontier',
        cursor: second.next!,
        change: (page) => {
          page.hits.hits[0] = structuredClone(before);
        },
      },
      ...['\n', '\r\n', '\u2028', '\u2029'].map((suffix) => ({
        name: `final ${JSON.stringify(suffix)}`,
        change: (page: ReceiptPage) => {
          page.hits.hits[0]!._index += suffix;
        },
      })),
      ...['2', '0', '01', '9007199254740992'].map((generation) => ({
        name: `generation ${generation}`,
        change: (page: ReceiptPage) => {
          page.hits.hits[0]!._index = `${prefix}subjects-g${generation}`;
        },
      })),
    ];
    for (const fault of faults) {
      observed.calls.length = 0;
      reads = 0;
      signs = 0;
      observed.change(fault.change);
      const error = await problem(
        service.search('anonymous', { ...request, ...(fault.cursor ? { cursor: fault.cursor } : {}) }),
        'index_not_ready',
      );
      expect(reads, fault.name).toBe(0);
      expect(signs, fault.name).toBe(0);
      expect(observed.calls, fault.name).toHaveLength(1);
      const call = observed.calls[0]!;
      expect(call.path).toBe(`/${subjectIndexName(prefix, 1)}/_search/template`);
      expect(call.raw.hits.hits).toHaveLength(3);
      expect(call.delivered).not.toEqual(call.raw);
      expect(call.request).toMatchObject({
        params: { size: 3, has_after: !!fault.cursor, ...(fault.cursor ? { after: frontier.sort } : {}) },
      });
      const response = problemResponse(error, { method: 'POST', id: 'ordinary-receipt' });
      expect(response.status).toBe(503);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ code: 'index_not_ready' });
      for (const field of ['subjects', 'next', 'total', 'as_of']) expect(body).not.toHaveProperty(field);
      console.info(
        'native service refused ordinary receipt',
        JSON.stringify({ sort, fault: fault.name, call, sourceCalls: reads, signingCalls: signs }),
      );
    }
    observed.change();
    observed.calls.length = 0;
    reads = 0;
    signs = 0;
    const empty = await service.search('anonymous', { ...request, text: 'unmatchedreceipttoken' });
    expect(empty.subjects).toEqual([]);
    expect(empty.next).toBeNull();
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]!.raw.hits.hits).toEqual([]);
    expect(signs).toBe(0);
  }
}, 120_000);

test('native service keeps ordinary ties, Unicode/null keysets and sparse refills progressing', async () => {
  const books = [
    subject(1, 'Tie'),
    subject(2, 'Ｔｉｅ'),
    subject(3, '\uE000'),
    subject(4, '\u{10000}'),
    subject(5, ''),
    subject(6, ''),
  ];
  const observed = receiptObserver();
  const reads: string[][] = [];
  const { prefix, fake, service } = await deployment(books, {
    client: observed.client,
    source: (fake) => ({
      read: (partition, ids) => {
        reads.push([...ids]);
        return fake.read(partition, ids);
      },
      count: (...args) => fake.count(...args),
    }),
  });
  for (const n of [5, 6])
    await client.request(
      'POST',
      `/${subjectIndexName(prefix, 1)}/_update/${books[n - 1]!.id}`,
      { doc: { name_sort: null } },
      { query: { refresh: true } },
    );
  for (const sort of ['id', 'name', 'collections', 'relevance'] as const) {
    const request = { filter: { type: { in: ['schema:Book'] } }, sort, limit: 1 };
    let cursor: string | undefined;
    const seen: string[] = [];
    observed.calls.length = 0;
    for (let page = 0; page < 7; page++) {
      const response = await service.search('anonymous', { ...request, ...(cursor ? { cursor } : {}) });
      seen.push(...ids(response));
      if (response.next === null) break;
      cursor = response.next;
    }
    expect(seen).toEqual(books.map(({ id }) => id));
    expect(new Set(seen).size).toBe(6);
    expect(observed.calls.length).toBeLessThanOrEqual(7);
    console.info('native service ordinary keysets', JSON.stringify({ sort, calls: observed.calls, reads }));
  }
  // Remove the first native page's candidates only in current Source. The engine still returns them.
  for (const book of books.slice(0, 3)) fake.put({ ...book, visibility: 'taken_down', securityRevision: 2 });
  for (const sort of ['id', 'name', 'collections', 'relevance'] as const) {
    observed.calls.length = 0;
    reads.length = 0;
    const page = await service.search('anonymous', { filter: { type: { in: ['schema:Book'] } }, sort, limit: 1 });
    expect(ids(page)).toEqual([books[3]!.id]);
    expect(page.next).toBeString();
    expect(observed.calls).toHaveLength(2);
    expect(observed.calls[1]!.request).toMatchObject({
      params: { after: observed.calls[0]!.raw.hits.hits.at(-1)!.sort, size: 3 },
    });
    expect(reads).toHaveLength(2);
    expect(reads.map((ids) => ids.length)).toEqual([3, 3]);
    console.info('native service ordinary refill', JSON.stringify({ sort, calls: observed.calls, reads }));
  }
}, 120_000);

test('fixed native ordinary receipt admission keeps call bytes and Source rows fixed at 64/512/4096 unrelated roots and history', async () => {
  const measurements: {
    roots: number;
    history: number;
    calls: number;
    bytes: number;
    rows: number;
    sourceCalls: number;
    sourceRows: number;
  }[] = [];
  for (const scale of [64, 512, 4096]) {
    const fixed = Array.from({ length: 8 }, (_, n) => subject(n + 1, `Custody ${n + 1}`));
    const unrelated = Array.from({ length: scale }, (_, n) => subject(n + 100, `Other ${n + 100}`));
    const observed = receiptObserver();
    const reads: string[][] = [];
    const { prefix, service } = await deployment([...fixed, ...unrelated], {
      client: observed.client,
      source: (fake) => ({
        read: (partition, ids) => {
          reads.push([...ids]);
          return fake.read(partition, ids);
        },
        count: (...args) => fake.count(...args),
      }),
    });
    // Native overwritten versions grow with the unrelated population; the selected eight roots stay fixed.
    const history = documentActions(
      { partition: 10, position: BigInt(scale + 10), subjects: unrelated },
      unrelated.map(({ id }) => id),
    );
    const bulk = await client.bulk<{ errors: boolean }>(bulkLines(subjectIndexName(prefix, 1), history), {
      query: { refresh: 'wait_for' },
    });
    expect(bulk.errors).toBe(false);
    observed.calls.length = 0;
    const page = await service.search('anonymous', { text: 'custody', sort: 'id', limit: 2 });
    expect(ids(page)).toEqual(fixed.slice(0, 2).map(({ id }) => id));
    expect(page.next).toBeString();
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]!.delivered).toEqual(observed.calls[0]!.raw);
    expect(observed.calls[0]!.request).toMatchObject({ params: { size: 5, sort: [{ id: 'asc' }] } });
    const hits = observed.calls[0]!.raw.hits.hits;
    // Prefixes have a fixed length. These are actual returned hit bytes, excluding variable timing metadata.
    measurements.push({
      roots: scale,
      history: history.length,
      calls: observed.calls.length,
      bytes: Buffer.byteLength(JSON.stringify(hits)),
      rows: hits.length,
      sourceCalls: reads.length,
      sourceRows: reads.reduce((sum, ids) => sum + ids.length, 0),
    });
    console.info(
      'native ordinary receipt growth',
      JSON.stringify({ measurement: measurements.at(-1), calls: observed.calls, reads }),
    );
  }
  expect(
    measurements.map(({ calls, bytes, rows, sourceCalls, sourceRows }) => ({
      calls,
      bytes,
      rows,
      sourceCalls,
      sourceRows,
    })),
  ).toEqual(Array(3).fill({ calls: 1, bytes: measurements[0]!.bytes, rows: 5, sourceCalls: 1, sourceRows: 5 }));
}, 120_000);
