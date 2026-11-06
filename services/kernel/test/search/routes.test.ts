import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import type { PublicFigureView } from '../../src/rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { AuthenticationError, type Access, type AccountActor, type Resource } from '../../src/request/access.ts';
import type { SearchService } from '../../src/search/service-scope.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { readExposure } from '../../src/access/gates/catalogue.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import {
  compileKinds,
  FACET_TEMPLATE,
  HIT_TEMPLATE,
  installTemplates,
  kindDigest,
  SEARCH_TEMPLATE,
  SUGGEST_TEMPLATE,
} from '../../src/search/query.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';
import { closeOwnedSemanticAuth } from '../semantic/outcome-auth.ts';

const missingFigure: PublicFigureView = {
  questionId: STANDARD_QUESTION_ID,
  populationId: GLOBAL_CONTEXT,
  scale: { min: 0, max: 20, displayStep: 1 },
  count: 0,
  state: 'insufficient_data',
  mean: null,
  score: null,
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const opening = Bun.randomUUIDv7();
let stubPoolOpen = true;
async function closeStubPool() {
  if (!stubPoolOpen) return;
  stubPoolOpen = false;
  try {
    await pool.query('DELETE FROM access.exposure_opening WHERE transaction_id = $1', [opening]);
  } finally {
    await pool.end();
  }
}
beforeAll(async () => {
  // These dispatch cases use stub actors, not native write identities. Set only their
  // exposure fixture; release-exposure.test.ts proves real governor admission separately.
  for (const group of ['search', 'search_advanced']) {
    if (!(await readExposure(pool, group, new Date(), Date.now() + 10_000)).open) {
      await pool.query(
        `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
         VALUES ($1, tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $2)`,
        [group, opening],
      );
    }
  }
});
afterAll(closeStubPool);

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const routeKey = new Uint8Array(32).fill(13);
const reader: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001',
  clientId: 'reader',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};

/** `reader` and anonymous may read; `denied` may not; any other token is rejected. */
const checks: [string, string, Resource][] = [];
const access: Access = {
  async authenticate(token) {
    if (token === 'reader') return reader;
    if (token === 'denied') return { ...reader, clientId: 'denied' };
    throw new AuthenticationError(401, 'Bearer error="invalid_token"');
  },
  async authorize(_client, actor, action, resource) {
    checks.push([actor.kind === 'account' ? actor.clientId : 'anonymous', action, resource]);
    return !(actor.kind === 'account' && actor.clientId === 'denied');
  },
};

const result = { id: '018f0000-0000-7000-8000-00a000000001', type: 'schema:Book', labels: { en: 'Kokoro' } };
const asOf = '2026-10-25T00:00:00.000Z';
const calls: unknown[][] = [];
process.env.KERNEL_RECEIPT_KEYS = [...testReceiptKeys().keys]
  .map(([version, key]) => `${version}:${Buffer.from(key).toString('base64url')}`)
  .join(',');
let failure: ProblemError | null = null;
const service: SearchService = {
  async savedCatalogueMembers() {
    throw new Error('Unexpected saved catalogue members call');
  },
  async search(principal, request, _now, _active, context) {
    calls.push(['search', principal, request]);
    if (failure) throw failure;
    const page = {
      subjects: [{ ...result, figure: missingFigure, matchEvidence: { state: 'absent' as const } }],
      next: null,
      as_of: asOf,
    };
    await context?.complete(page);
    return page;
  },
  async facets(principal, request) {
    calls.push(['facets', principal, request]);
    if (failure) throw failure;
    return {
      facets: [
        {
          property: 'schema:author',
          next: null,
          values: [{ value: result.id, labels: result.labels }],
        },
      ],
      as_of: asOf,
    };
  },
  async suggest(q, limit, _languages, read) {
    calls.push(['suggest', q, limit]);
    if (failure) throw failure;
    const page = { subjects: [result], as_of: asOf };
    await read?.complete(page);
    return page;
  },
  async releaseGroups(principal, request) {
    calls.push(['releaseGroups', principal, request]);
    if (failure) throw failure;
    const card = { ...result, figure: missingFigure };
    if (request.work) return { status: 'ready', children: [card], next: null, as_of: asOf };
    const release = { ...card, id: '018f0000-0000-7000-8000-00a000000002' };
    return {
      status: 'ready',
      groups: [{ kind: 'work', id: result.id, work: card, releases: [release], next: 'opaque-child' }],
      next: 'opaque-group',
      as_of: asOf,
    };
  },
};
const kernel = createKernel({
  pool,
  access,
  tokens,
  receiptKeys: testReceiptKeys(),
  routeKey,
  search: service,
});
const offline = createKernel({ pool, access, tokens, receiptKeys: testReceiptKeys(), routeKey });

async function call(
  app: typeof kernel,
  method: 'GET' | 'POST',
  path: string,
  options: { token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

const both = [
  ['POST', '/v1/subjects:search', { text: 'a' }],
  ['GET', '/v1/subjects:suggest?q=a', undefined],
] as const;

test('search and suggest pass the caller, the body and the query to the service, authorizing once on the Global Context', async () => {
  calls.length = 0;
  checks.length = 0;
  const body = { text: 'kokoro', filter: { type: { in: ['schema:Book'] } }, sort: 'name', limit: 5 };
  const anonymous = await call(kernel, 'POST', '/v1/subjects:search', { body });
  expect(anonymous.response.status).toBe(200);
  expect(anonymous.body).toEqual({
    subjects: [
      {
        ...result,
        summary: null,
        figure: missingFigure,
        kind: result.type,
        matchEvidence: { state: 'absent' },
        base: {
          id: result.id,
          kind: result.type,
          kindLabel: { value: result.type, language: 'und' },
          title: { value: 'Kokoro', language: 'en' },
          image: null,
          url: { id: result.id, label: { value: 'Kokoro', language: 'en' } },
        },
      },
    ],
    next: null,
    as_of: asOf,
  });
  for (const field of ['total', 'indexed_estimate', 'count', 'relation'])
    expect(anonymous.body).not.toHaveProperty(field);
  expect(
    (await call(kernel, 'POST', '/v1/subjects:search', { token: 'reader', body: { cursor: 'abc' } })).response.status,
  ).toBe(200);
  const suggested = await call(kernel, 'GET', '/v1/subjects:suggest?q=Koko&limit=3');
  expect(suggested.response.status).toBe(200);
  expect(suggested.body).toEqual({ subjects: [{ ...result, summary: null }], as_of: asOf });
  expect((await call(kernel, 'GET', '/v1/subjects:suggest?q=%E5%BF%83', { token: 'reader' })).response.status).toBe(
    200,
  );
  expect(calls).toEqual([
    ['search', 'anonymous', body],
    ['search', `account:${reader.accountId}`, { cursor: 'abc' }],
    ['suggest', 'Koko', 3],
    ['suggest', '心', undefined],
  ]);
  const global = { route: 0, id: GLOBAL_CONTEXT };
  expect(checks).toEqual([
    ['anonymous', 'subject:read', global],
    ['reader', 'subject:read', global],
    ['anonymous', 'subject:read', global],
    ['reader', 'subject:read', global],
  ]);
});

test('a caller denied subject:read is forbidden and a rejected credential is unauthenticated, without reaching the service', async () => {
  calls.length = 0;
  for (const [method, path, body] of both) {
    const denied = await call(kernel, method, path, { token: 'denied', body });
    expect(denied.response.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applicable' });
    const rejected = await call(kernel, method, path, { token: 'stolen', body });
    expect(rejected.response.status).toBe(401);
    expect(rejected.body).toMatchObject({ code: 'invalid_credentials', effect_status: 'not_applicable' });
  }
  expect(calls).toEqual([]);
});

test('malformed bodies and query parameters are 400 with field errors', async () => {
  calls.length = 0;
  const bodies: [unknown, { pointer: string; code: string }[]][] = [
    [{ colour: 'red' }, [{ pointer: '/colour', code: 'unknown_field' }]],
    [{ text: 5 }, [{ pointer: '/text', code: 'invalid_type' }]],
    [{ limit: 'x' }, [{ pointer: '/limit', code: 'invalid_type' }]],
    [{ limit: 101 }, [{ pointer: '/limit', code: 'out_of_range' }]],
    [{ limit: 0 }, [{ pointer: '/limit', code: 'out_of_range' }]],
    [{ cursor: 7 }, [{ pointer: '/cursor', code: 'invalid_type' }]],
  ];
  for (const [body, errors] of bodies) {
    const response = await call(kernel, 'POST', '/v1/subjects:search', { body });
    expect({ body, status: response.response.status }).toEqual({ body, status: 400 });
    expect(response.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applicable', errors });
  }
  const sorted = await call(kernel, 'POST', '/v1/subjects:search', { body: { sort: 'random' } });
  expect(sorted.response.status).toBe(400);
  expect(sorted.body.errors.map((error: { pointer: string }) => error.pointer)).toEqual(['/sort']);
  const queries: [string, string, string | null][] = [
    ['', '/q', 'required'],
    ['?q=a&limit=x', '/limit', null],
    ['?q=a&limit=11', '/limit', 'out_of_range'],
    ['?q=a&limit=0', '/limit', 'out_of_range'],
    ['?q=a&colour=red', '/colour', 'unknown_field'],
  ];
  for (const [query, pointer, code] of queries) {
    const response = await call(kernel, 'GET', `/v1/subjects:suggest${query}`);
    expect({ query, status: response.response.status }).toEqual({ query, status: 400 });
    expect(response.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applicable' });
    expect(response.body.errors.map((error: { pointer: string }) => error.pointer)).toEqual([pointer]);
    if (code) expect(response.body.errors[0].code).toBe(code);
  }
  expect(calls).toEqual([]);
});

test('service problems keep their status, code, errors and headers, and every problem on these reads is not_applicable', async () => {
  const cases: [ProblemError, number][] = [
    [new ProblemError('unsupported_query', { errors: [{ pointer: '/text', code: 'unsupported' }] }), 422],
    [new ProblemError('invalid_request', { errors: [{ pointer: '/cursor', code: 'invalid_format' }] }), 400],
    [new ProblemError('search_restart_required'), 409],
    [new ProblemError('index_not_ready', { headers: { 'retry-after': '3' } }), 503],
  ];
  try {
    for (const [error, status] of cases) {
      failure = error;
      for (const [method, path, body] of both) {
        const { response, body: problem } = await call(kernel, method, path, { body });
        expect({ path, code: error.code, status: response.status }).toEqual({ path, code: error.code, status });
        expect(problem).toMatchObject({
          code: error.code,
          effect_status: 'not_applicable',
          ...(error.errors ? { errors: error.errors } : {}),
        });
        if (error.headers) expect(response.headers.get('retry-after')).toBe('3');
      }
    }
  } finally {
    failure = null;
  }
  const command = await call(kernel, 'POST', '/v1/subjects', { body: { labels: { en: 'Kokoro' } } });
  expect(command.body.effect_status).toBe('not_applied');
});

test('search preserves semantic readiness failures and their retry header', async () => {
  failure = new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
  try {
    const { response, body } = await call(kernel, 'POST', '/v1/subjects:search', {
      body: { filter: { type: { in: ['schema:Book'] } } },
    });
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ code: 'semantic_not_ready', retryable: true, effect_status: 'not_applicable' });
    expect(response.headers.get('retry-after')).toBe('1');
  } finally {
    failure = null;
  }
});

test('grouped release and child POST requests retain viewer binding and return contextual cards', async () => {
  calls.length = 0;
  checks.length = 0;
  const request = {
    representation: 'release-groups-v1',
    filter: { type: { in: ['schema:Book'] } },
    sort: 'name',
    languages: ['fr', 'en'],
    spoilerThreshold: 0,
    descriptions: true,
    limit: 20,
  };
  const groups = await call(kernel, 'POST', '/v1/subjects:search', { token: 'reader', body: request });
  expect(groups.response.status).toBe(200);
  expect(groups.response.headers.get('cache-control')).toBe('private, no-store');
  expect(groups.body.groups[0]).toMatchObject({
    kind: 'work',
    id: result.id,
    work: { id: result.id, summary: null, figure: missingFigure, base: { id: result.id } },
    releases: [{ id: '018f0000-0000-7000-8000-00a000000002', summary: null, figure: missingFigure }],
    next: 'opaque-child',
  });
  expect(groups.body.next).toBe('opaque-group');

  const childRequest = { ...request, work: result.id, childCursor: 'child-token' };
  const children = await call(kernel, 'POST', '/v1/subjects:search', { token: 'reader', body: childRequest });
  expect(children.response.status).toBe(200);
  expect(children.body).toMatchObject({
    status: 'ready',
    children: [{ id: result.id, figure: missingFigure }],
    next: null,
  });
  expect(calls).toEqual([
    ['releaseGroups', `account:${reader.accountId}`, request],
    ['releaseGroups', `account:${reader.accountId}`, childRequest],
  ]);

  calls.length = 0;
  expect((await call(kernel, 'POST', '/v1/subjects:search', { token: 'denied', body: request })).response.status).toBe(
    403,
  );
  expect(calls).toEqual([]);
});

test('without a search service both routes are index_not_ready and retryable', async () => {
  for (const [method, path, body] of both) {
    const { response, body: problem } = await call(offline, method, path, { body });
    expect(response.status).toBe(503);
    expect(problem).toMatchObject({ code: 'index_not_ready', retryable: true, effect_status: 'not_applicable' });
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
  }
});

test('both routes are public custom methods of subject:read in the contract', () => {
  const { paths } = openApiDocument(kernel) as unknown as { paths: Record<string, Record<string, unknown>> };
  const read = { 'x-action': 'subject:read', security: [{ bearerAuth: [] }, {}] };
  expect(paths['/v1/subjects:search']?.post).toMatchObject({ operationId: 'subject.search', ...read });
  expect(paths['/v1/subjects:suggest']?.get).toMatchObject({ operationId: 'subject.suggest', ...read });
});

test('facets forward principals and reject denied credentials and unknown fields before the service', async () => {
  calls.length = 0;
  checks.length = 0;
  const body = { facets: [{ property: 'schema:author', size: 1 }] };
  const serviceResult = result;
  for (const token of [undefined, 'reader']) {
    const result = await call(kernel, 'POST', '/v1/subjects:facets', { ...(token ? { token } : {}), body });
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({
      facets: [
        { property: 'schema:author', next: null, values: [{ value: serviceResult.id, labels: serviceResult.labels }] },
      ],
      as_of: asOf,
    });
    for (const value of [result.body, result.body.facets[0], result.body.facets[0].values[0]])
      for (const field of ['count', 'relation', 'total', 'indexed_estimate']) expect(value).not.toHaveProperty(field);
  }
  expect(calls).toEqual([
    ['facets', 'anonymous', body],
    ['facets', `account:${reader.accountId}`, body],
  ]);
  expect(checks).toEqual([
    ['anonymous', 'subject:read', { route: 0, id: GLOBAL_CONTEXT }],
    ['reader', 'subject:read', { route: 0, id: GLOBAL_CONTEXT }],
  ]);
  calls.length = 0;
  expect((await call(kernel, 'POST', '/v1/subjects:facets', { token: 'denied', body })).response.status).toBe(403);
  expect((await call(kernel, 'POST', '/v1/subjects:facets', { token: 'stolen', body })).response.status).toBe(401);
  for (const [invalid, pointer, code] of [
    [{ ...body, extra: true }, '/extra', 'unknown_field'],
    [{ facets: [{ property: 'schema:author', extra: true }] }, '/facets/0/extra', 'unknown_field'],
    [{}, '/facets', 'required'],
    [{ facets: [] }, '/facets', 'out_of_range'],
    [{ facets: [{ property: 'schema:author', size: 21 }] }, '/facets/0/size', 'out_of_range'],
  ] as const) {
    const result = await call(kernel, 'POST', '/v1/subjects:facets', { body: invalid });
    expect(result.response.status).toBe(400);
    expect(result.body.errors).toEqual([{ pointer, code }]);
  }
  expect(calls).toEqual([]);
  expect((await call(offline, 'POST', '/v1/subjects:facets', { body })).response.status).toBe(503);
});

test('HTTP forwards one resolved kernel instant to hits, ratings and facets while deadlines use wall time', async () => {
  const { deadlineFor } = await import('../../src/request/deadline.ts');
  const forwarded: number[] = [];
  const deadlines: number[] = [];
  let now = Date.now() - 2 * 60 * 60_000;
  const app = createKernel({
    receiptKeys: testReceiptKeys(),
    pool,
    access,
    tokens,
    routeKey,
    clock: () => new Date(now),
    search: {
      ...service,
      async search(_principal, _request, instant, _active, context) {
        forwarded.push(instant!);
        deadlines.push(deadlineFor(1));
        const page = { subjects: [], next: null, as_of: asOf };
        await context?.complete(page);
        return page;
      },
      async facets(_principal, _request, instant) {
        forwarded.push(instant!);
        deadlines.push(deadlineFor(1));
        return { facets: [], as_of: asOf };
      },
    },
  });
  const before = Date.now();
  for (const [path, body] of [
    ['/v1/subjects:search', { sort: 'id' }],
    ['/v1/subjects:search', { sort: 'rating', cursor: 'opaque' }],
    ['/v1/subjects:facets', { facets: [{ property: 'type' }] }],
  ] as const) {
    expect((await call(app, 'POST', path, { body })).response.status).toBe(200);
    expect(forwarded.at(-1)).toBe(now);
    now += 1000;
  }
  for (const deadline of deadlines) {
    expect(deadline).toBeGreaterThan(before);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 30_000);
  }
  const count = forwarded.length;
  expect((await call(app, 'POST', '/v1/subjects:search', { token: 'denied', body: {} })).response.status).toBe(403);
  expect(forwarded).toHaveLength(count);
});

describe('bounded native kind metadata and checked-hit witnesses', () => {
  // Release the stub HTTP pool before cloning the check database; leftover sessions block TEMPLATE.
  const database = process.env.DATABASE_URL;
  const url = process.env.OPENSEARCH_URL;
  if (!database || !url) throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
  let driver: SemanticOutcomeDriver;
  let service: ReturnType<typeof createSearchService>;
  const native = createOpenSearch(url);
  const prefix = `kinds-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
  const release = {
    properties: {},
    types: Object.fromEntries<{ bases: string[]; labels: Record<string, string> }>(
      Array.from({ length: 25 }, (_, n) => [
        n === 0 ? 'schema:Book' : `kind:Kind${n}`,
        { bases: [], labels: n === 2 ? {} : { en: `Kind ${n}`, fr: `Genre ${n}` } },
      ]),
    ),
  };
  let version = release;
  const fake = createFakeSource();
  let queries = 0;
  let reads = 0;
  let countReads = 0;
  const engine: OpenSearch = {
    bulk: native.bulk,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      if (args[1].endsWith('/_search/template')) queries++;
      return native.request<T>(...args);
    },
  };
  const source = {
    ...fake,
    async read(...args: Parameters<typeof fake.read>) {
      reads++;
      return fake.read(...args);
    },
    async count(): Promise<never> {
      countReads++;
      throw new Error('dirty count must not block hits');
    },
  };
  const subjects: IndexedSubject[] = [];
  let indexCreated = false;
  let templatesCreated = false;
  beforeAll(async () => {
    await closeStubPool();
    driver = await createSemanticDriver();
    // Canonical admission consumes native identity mappings, even when this test owns
    // a deliberately small index/source projection for metadata witness counts.
    for (let n = 0; n < 5; n++) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: `Book ${n}` },
        },
        { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
      );
      expect(created.status).toBe(201);
      subjects.push({
        id: (created.body.subject as { id: string }).id,
        type: 'schema:Book',
        visibility: 'visible',
        redirect: null,
        securityRevision: 1,
        labels: [{ language: 'en', value: `Book ${n}` }],
        aliases: [],
        descriptions: [],
        statements: [],
      });
    }
    subjects.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const [n, subject] of subjects.entries()) {
      const typed: IndexedSubject = { ...subject, type: n < 3 ? 'schema:Book' : 'kind:Kind1' };
      subjects[n] = typed;
      fake.put(typed);
    }
    await installTemplates(native, prefix);
    templatesCreated = true;
    service = createSearchService({
      pool: driver.fixtures.pool,
      client: engine,
      prefix,
      source,
      cursors: ring,
      release: async () => version,
    });
    await createSubjectIndex(native, prefix, 1);
    indexCreated = true;
    const partitions = new Map<number, string[]>();
    for (const subject of subjects) {
      const partition = subjectPartition(subject.id);
      partitions.set(partition, [...(partitions.get(partition) ?? []), subject.id]);
    }
    for (const [partition, ids] of partitions) {
      const snapshot = await fake.read(partition, ids);
      await native.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
    }
    await native.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  }, 600_000);
  afterAll(async () => {
    try {
      if (indexCreated) await native.request('DELETE', `/${index}`);
      if (templatesCreated)
        for (const name of [HIT_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
          await native.request('DELETE', `/_scripts/${prefix}${name}`);
    } finally {
      try {
        await driver?.close();
      } finally {
        await closeOwnedSemanticAuth();
      }
    }
  }, 600_000);
  const request = { sort: 'id' as const, languages: ['en'], limit: 4 };
  test('initial counts reuse at most two unique current hits, once, without count reads or extra engine execution', async () => {
    const before = queries;
    const beforeReads = reads;
    const initial = await service.search('anonymous', request);
    expect(initial.subjects).toHaveLength(4);
    expect(initial.kinds!.values[0]!.count).toEqual({ value: 2, exact: false });
    expect(initial.kinds!.values.filter((v) => v.count).reduce((n, v) => n + v.count!.value, 0)).toBe(2);
    expect(queries - before).toBe(1);
    expect(reads - beforeReads).toBe(
      new Set(initial.subjects.map((subject) => subjectPartition(subject.id))).size,
    );
    expect(countReads).toBe(0);
    expect(new TextEncoder().encode(JSON.stringify(initial)).length).toBeLessThan(16_384);
    const next = await service.search('anonymous', { ...request, cursor: initial.next! });
    expect(next.kinds!.values.every((v) => v.count === undefined)).toBe(true);
  });
  test('a stricter top-level type query witnesses the disjunctive dimension, retaining nested NOT', async () => {
    const result = await service.search('anonymous', {
      ...request,
      filter: { and: [{ type: { in: ['schema:Book'] } }, { not: { type: { in: ['kind:Kind1'] } } }] },
    });
    expect(result.subjects).toHaveLength(3);
    expect(result.kinds!.values[0]!.count).toEqual({ value: 2, exact: false });
    expect(result.kinds!.values[1]!.count).toBeUndefined();
  });
  test('opaque metadata continuation returns normal hits, no count recomputation, and rejects tamper/query/viewer changes and release restart', async () => {
    const initial = await service.search('anonymous', request);
    const before = queries;
    const more = await service.search('anonymous', { ...request, kindCursor: initial.kinds!.next! });
    expect(more.subjects).toEqual(initial.subjects);
    expect(more.kinds!.values).toHaveLength(8);
    expect(more.kinds!.values.every((v) => v.count === undefined)).toBe(true);
    expect(more.kinds!.values.every((v) => !initial.kinds!.values.some((first) => first.value === v.value))).toBe(true);
    expect(queries - before).toBe(1);
    for (const [principal, body] of [
      ['anonymous', { ...request, kindCursor: 'schema:Book' }],
      ['anonymous', { ...request, kindCursor: initial.kinds!.next!.slice(0, -5) + 'aaaaa' }],
      ['anonymous', { ...request, limit: 3, kindCursor: initial.kinds!.next! }],
      ['anonymous', { ...request, languages: ['fr'], kindCursor: initial.kinds!.next! }],
      ['account:018f0000-0000-7000-8000-00a000000099', { ...request, kindCursor: initial.kinds!.next! }],
    ] as const)
      await expect(service.search(principal, { ...body, languages: [...body.languages] })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    version = { ...release, types: { ...release.types, last: { bases: [], labels: { en: 'Last' } } } };
    try {
      await expect(service.search('anonymous', { ...request, kindCursor: initial.kinds!.next! })).rejects.toMatchObject(
        {
          code: 'search_restart_required',
        },
      );
    } finally {
      version = release;
    }
  });
  test('compiled metadata owns rows, uses actual language fallback, direct lookups and eight-row pages without reenumerating the release', () => {
    let enumerations = 0;
    const raw = structuredClone(release);
    raw.types['kind:Kind24']!.labels.en = 'Owned snapshot';
    const digest = kindDigest(raw);
    const types = new Proxy(raw.types, {
      ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    });
    const snapshot = compileKinds({ ...raw, types }, digest);
    expect(enumerations).toBe(1);
    raw.types['schema:Book']!.labels.en = 'Mutated';
    expect(snapshot.label('schema:Book', ['fr-CA'])).toEqual({ value: 'Genre 0', language: 'fr' });
    expect(snapshot.label('kind:Kind2', ['fr'])).toEqual({ value: 'kind:Kind2', language: 'und' });
    expect(snapshot.label('unknown', ['fr'])).toEqual({ value: 'unknown', language: 'und' });
    const first = snapshot.page(undefined, ['en']);
    expect(first.values).toHaveLength(8);
    expect(first.values[0]!.label.value).toBe('Kind 0');
    first.values[0]!.label.value = 'Caller mutation';
    expect(snapshot.page(undefined, ['en']).values[0]!.label.value).toBe('Kind 0');
    expect(snapshot.page(first.after!, ['en']).values[0]!.value).toBe('kind:Kind8');
    expect(compileKinds({ ...raw, types }, digest)).toBe(snapshot);
    expect(enumerations).toBe(1);
  });
});
