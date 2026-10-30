import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { AuthenticationError, type Access, type AccountActor, type Resource } from '../../src/request/access.ts';
import type { SearchService } from '../../src/search/http/routes.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

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
let failure: ProblemError | null = null;
const service: SearchService = {
  async search(principal, request) {
    calls.push(['search', principal, request]);
    if (failure) throw failure;
    return { subjects: [result], next: null, as_of: asOf };
  },
  async facets(principal, request) {
    calls.push(['facets', principal, request]);
    if (failure) throw failure;
    return {
      facets: [
        {
          property: 'schema:author',
          values: [{ value: result.id, labels: result.labels }],
        },
      ],
      as_of: asOf,
    };
  },
  async suggest(q, limit) {
    calls.push(['suggest', q, limit]);
    if (failure) throw failure;
    return { subjects: [result], as_of: asOf };
  },
};
const kernel = createKernel({ pool, access, tokens, routeKey, search: service });
const offline = createKernel({ pool, access, tokens, routeKey });

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
    subjects: [{ ...result, summary: null }],
    next: null,
    as_of: asOf,
  });
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
  for (const token of [undefined, 'reader']) {
    const response = await call(kernel, 'POST', '/v1/subjects:facets', { ...(token ? { token } : {}), body });
    expect(response.response.status).toBe(200);
    expect(response.body).not.toHaveProperty('total');
    expect(response.body.facets).toEqual([
      { property: 'schema:author', values: [{ value: result.id, labels: { en: 'Kokoro' } }] },
    ]);
    expect(response.body.facets[0]).not.toHaveProperty('relation');
    expect(response.body.facets[0].values[0]).not.toHaveProperty('count');
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
    pool,
    access,
    tokens,
    routeKey,
    clock: () => new Date(now),
    search: {
      ...service,
      async search(_principal, _request, instant) {
        forwarded.push(instant!);
        deadlines.push(deadlineFor(1));
        return { subjects: [], next: null, as_of: asOf };
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

test('real Access and native Source preserve clock boundaries, restart and bounded continuation work', async () => {
  const { createSemanticDriver } = await import('../semantic/outcome-driver.ts');
  const { closeOwnedSemanticAuth } = await import('../semantic/outcome-auth.ts');
  const { subjectSource } = await import('../../src/semantic/search-source.ts');
  const { createPublicRatingSource } = await import('../../src/rating/public-rating-source.ts');
  const { createSearchService } = await import('../../src/search/service.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { createSubjectIndex, subjectAlias, subjectIndexName } = await import('../../src/search/indices.ts');
  const { bulkLines, documentActions } = await import('../../src/search/document.ts');
  const { subjectPartition } = await import('../../src/search/source.ts');
  const { decodeSearchCursor } = await import('../../src/search/cursor.ts');
  const { decodeRatingCursor } = await import('../../src/search/rating-cursor.ts');
  const { LIST_CURSOR_BOUNDS } = await import('../../src/tokens/list-cursor.ts');
  const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `request-clock-${crypto.randomUUID().slice(0, 8)}-`;
  let now: number | undefined;
  let factorySamples = 0;
  const io = { engine: 0, queries: 0, source: 0, keys: 0, rating: 0 };
  let native!: ReturnType<typeof subjectSource>;
  let ratings!: ReturnType<typeof createPublicRatingSource>;
  let search!: ReturnType<typeof createSearchService>;
  let keys!: KeyRing;
  const driver = await createSemanticDriver(
    (config) => {
      native = subjectSource(config.pool, config.routeKey);
      ratings = createPublicRatingSource(config.pool);
      keys = config.tokens!;
      search = createSearchService({
        pool: config.pool,
        prefix,
        cursors: keys,
        clock: () => {
          factorySamples++;
          return new Date(now ?? Date.now());
        },
        client: {
          bulk: (...args) => engine.bulk(...args),
          async request<T>(...args: Parameters<typeof engine.request>) {
            io.engine++;
            if (args[1].endsWith('/_search/template')) io.queries++;
            return engine.request<T>(...args);
          },
        },
        source: {
          ...native,
          read(partition, ids) {
            io.source++;
            io.keys += ids.length;
            return native.read(partition, ids);
          },
        },
        ratings: {
          epoch() {
            io.rating++;
            return ratings.epoch();
          },
          read(partition, ids) {
            io.rating++;
            return ratings.read(partition, ids);
          },
        },
      });
      return createKernel({ ...config, clock: () => new Date(now ?? Date.now()), search });
    },
    { strictCleanup: true, linkProjection: 'external' },
  );
  const ids: string[] = [];
  let generation = 1;
  async function create(label: string) {
    const response = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: label },
        statements: {},
      },
      { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    ids.push((response.body.subject as { id: string }).id);
  }
  async function publish(target: number, previous?: number) {
    if (target !== previous) await createSubjectIndex(engine, prefix, target);
    const partitions = new Map<number, string[]>();
    for (const id of ids) {
      const partition = subjectPartition(id);
      partitions.set(partition, [...(partitions.get(partition) ?? []), id]);
    }
    for (const [partition, selected] of partitions) {
      const snapshot = await native.read(partition, selected);
      await engine.bulk(bulkLines(subjectIndexName(prefix, target), documentActions(snapshot, selected)), {
        query: { refresh: 'wait_for' },
      });
    }
    if (target !== previous)
      await engine.request('POST', '/_aliases', {
        actions: [
          ...(previous === undefined
            ? []
            : [{ remove: { index: subjectIndexName(prefix, previous), alias: subjectAlias(prefix) } }]),
          { add: { index: subjectIndexName(prefix, target), alias: subjectAlias(prefix) } },
        ],
      });
    generation = target;
  }
  const request = (body: unknown, persona: 'anonymous' | 'editor' | 'suspended' = 'anonymous') =>
    driver.request(persona, 'POST', '/v1/subjects:search', body);
  function problem(response: Awaited<ReturnType<typeof request>>, status: number, code: string) {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(response.body).toMatchObject({ code, effect_status: 'not_applicable' });
  }
  try {
    // Current default fixture exposes only personal_library/reading_progress controls; this public Search
    // surface needs neither. No additional gate, persona, scope or grant is provisioned here.
    for (let n = 0; n < 3; n++) await create(`Clockprobe ${n}`);
    await publish(1);
    const issued = Date.now() + 2 * 60 * 60_000;
    now = issued;
    for (const sort of ['id', 'rating'] as const) {
      const body = { text: 'Clockprobe', sort, limit: 1, languages: ['en'] };
      const scope = { operation: 'subjects.search', principal: 'anonymous', request: body };
      const first = await request(body);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.subjects as unknown[]).toHaveLength(1);
      expect(Date.parse(first.body.as_of as string)).toBeLessThan(issued);
      const cursor = first.body.next as string;
      expect(cursor).toBeString();
      const decoded =
        sort === 'rating'
          ? await decodeRatingCursor(keys, scope, await ratings.epoch(), cursor, issued)
          : await decodeSearchCursor(keys, scope, cursor, issued);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error('Native cursor failed its issue-time binding');
      expect(decoded.generation).toBe(1);
      expect(decoded.after.at(-1)).toBe((first.body.subjects as { id: string }[])[0]!.id);
      for (const elapsed of [899_999, 900_000, -59_999, -60_000]) {
        now = issued + elapsed;
        const next = await request({ ...body, cursor });
        expect(next.status, JSON.stringify(next.body)).toBe(200);
        expect((next.body.subjects as { id: string }[])[0]!.id).not.toBe(decoded.after.at(-1));
      }
      now = issued + 900_001;
      let before = { ...io };
      problem(await request({ ...body, cursor }), 409, 'search_restart_required');
      expect(io).toEqual(before);
      expect((await request(body)).status).toBe(200); // Explicit fresh restart at the advanced clock.
      now = issued - 60_001;
      before = { ...io };
      problem(await request({ ...body, cursor }), 400, 'invalid_request');
      expect(io).toEqual(before);
      now = issued;
      for (const changed of [
        { ...body, text: 'Other' },
        { ...body, languages: ['ja'] },
        { ...body, limit: 2 },
      ]) {
        before = { ...io };
        problem(await request({ ...changed, cursor }), 400, 'invalid_request');
        expect(io).toEqual(before);
      }
      before = { ...io };
      problem(await request({ ...body, cursor }, 'editor'), 400, 'invalid_request');
      expect(io).toEqual(before);
      for (const token of [
        'malformed',
        `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`,
        'x'.repeat(LIST_CURSOR_BOUNDS.search.maxTokenLength + 1),
      ]) {
        before = { ...io };
        problem(await request({ ...body, cursor: token }), 400, 'invalid_request');
        expect(io).toEqual(before);
      }
      before = { ...io };
      problem(await request({ ...body, cursor }, 'suspended'), 401, 'invalid_credentials');
      expect(io).toEqual(before);
    }
    const facets = await driver.request('anonymous', 'POST', '/v1/subjects:facets', {
      text: 'Clockprobe',
      facets: [{ property: 'type' }],
      languages: ['en'],
    });
    expect(facets.status, JSON.stringify(facets.body)).toBe(200);
    expect((facets.body.facets as { values: { value: string }[] }[])[0]!.values.map((value) => value.value)).toContain(
      'schema:Book',
    );
    expect(Date.parse(facets.body.as_of as string)).toBeLessThan(issued);
    expect(factorySamples).toBe(0); // Routes supply the resolved clock, bypassing the factory default.
    const directBody = { text: 'Clockprobe', sort: 'id' as const, limit: 1 };
    const direct = await search.search('anonymous', directBody);
    expect(factorySamples).toBe(1);
    await expect(
      search.search('anonymous', { ...directBody, cursor: direct.next! }, issued + 900_001),
    ).rejects.toMatchObject({ code: 'search_restart_required' });
    expect(factorySamples).toBe(1); // Explicit numeric callers retain their exact contract.

    const ratingBody = { ...directBody, sort: 'rating' as const };
    const old = await request(directBody);
    const oldRating = await request(ratingBody);
    await publish(2, 1);
    for (const [body, page] of [
      [directBody, old],
      [ratingBody, oldRating],
    ] as const) {
      const before = { ...io };
      problem(await request({ ...body, cursor: page.body.next }), 409, 'search_restart_required');
      expect(io.queries).toBe(before.queries);
      expect(io.source).toBe(before.source);
      expect((await request(body)).status).toBe(200);
    }
    const fresh = await request(directBody);
    expect(fresh.status).toBe(200);
    const current = await decodeSearchCursor(
      keys,
      { operation: 'subjects.search', principal: 'anonymous', request: directBody },
      fresh.body.next as string,
      now,
    );
    expect(current.ok && current.generation).toBe(2);

    // Three unrelated native populations must not increase request work. Count actual transport and Source keys,
    // not returned page length or elapsed time. This is a request bound, not whole-page physical cost proof.
    const receipts = [];
    let unrelated = 0;
    for (const scale of [1, 4, 12]) {
      now = undefined; // New native writes keep their ordinary command time.
      while (unrelated < scale) await create(`Unrelated ${unrelated++}`);
      await publish(generation, generation);
      now = issued;
      const start = { ...io };
      expect((await request(directBody)).status).toBe(200);
      expect((await request(ratingBody)).status).toBe(200);
      receipts.push(
        Object.fromEntries(Object.entries(io).map(([key, value]) => [key, value - start[key as keyof typeof io]])),
      );
      const refused = { ...io };
      now = issued + 900_001;
      problem(await request({ ...directBody, cursor: direct.next }), 409, 'search_restart_required');
      expect(io).toEqual(refused);
      now = issued;
      problem(await request({ ...directBody, cursor: 'malformed' }), 400, 'invalid_request');
      problem(await request({ ...ratingBody, cursor: 'malformed' }), 400, 'invalid_request');
      expect(io).toEqual(refused);
    }
    expect(receipts[1]).toEqual(receipts[0]);
    expect(receipts[2]).toEqual(receipts[0]);
  } finally {
    await driver.close();
    await closeOwnedSemanticAuth();
    for (const target of [1, 2])
      await engine.request('DELETE', `/${subjectIndexName(prefix, target)}`).catch(() => undefined);
    for (const name of ['subjects-hits-v1', 'subjects-search-v2', 'subjects-suggest-v1', 'subjects-facets-v1'])
      await engine.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
}, 120_000);
