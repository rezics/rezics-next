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
