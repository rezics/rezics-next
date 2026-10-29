import { afterAll, expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { strictContentSchema } from '../src/content/schemas.ts';
import { createPool } from '../src/database/pool.ts';
import { createKernel } from '../src/http/kernel.ts';
import { customMethod } from '../src/http/custom-method.ts';
import { ProblemError, problemSchema } from '../src/http/problem.ts';
import type { SearchService } from '../src/search/http/routes.ts';
import { Value } from 'typebox/value';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

let authentications = 0;
const searches: unknown[] = [];
const suggestions: unknown[] = [];
const search: SearchService = {
  async search(_principal, request) {
    searches.push(request);
    return { subjects: [], next: null, as_of: '2026-10-26T00:00:00Z' };
  },
  async facets() {
    throw new Error('Unexpected facets call');
  },
  async suggest(q, limit) {
    suggestions.push({ q, limit });
    return { subjects: [], as_of: '2026-10-26T00:00:00Z' };
  },
};
const schema = t.Object({ integer: t.Integer(), number: t.Number(), boolean: t.Boolean(), string: t.String() });
const valid = { integer: 2, number: 2.5, boolean: true, string: 'two' };
const detail = {
  operationId: 'probe.echo',
  'x-action': 'probe:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(1),
  access: {
    async authenticate() {
      authentications++;
      throw new Error('Unexpected authentication');
    },
    async authorize() {
      return true;
    },
  },
  search,
})
  .post('/strict', { body: schema, detail }, ({ body }) => body)
  .post('/strict-standard', { body: strictContentSchema(schema), detail }, ({ body }) => body)
  .guard({ body: schema }, (app) => app.post('/strict-guard', { detail }, ({ body }) => body))
  .post(
    '/strict-size',
    {
      body: schema,
      detail,
      parse: () => ({}),
      transform: () => {
        throw new ProblemError('content_too_large');
      },
    },
    () => {
      throw new Error('Unexpected handler call');
    },
  )
  .post('/strict/:id', { body: schema, detail }, ({ body }) => body)
  .post(customMethod('/strict', 'echo'), { body: schema, detail }, ({ body }) => body)
  .post(customMethod('/strict/:id', 'echo'), { body: schema, detail }, ({ body }) => body)
  .use(new Elysia().post('/strict-plugin', { body: schema, detail }, ({ body }) => body))
  .group('/strict-group', (app) => app.post('/', { body: schema, detail }, ({ body }) => body))
  .get(
    '/strict-params/:id',
    { params: t.Object({ id: t.Integer() }), query: t.Object({ number: t.Number() }), detail },
    ({ params, query }) => ({ id: params.id, number: query.number }),
  );

const routes = [
  '/strict',
  '/strict/7',
  '/strict:echo',
  '/strict/7:echo',
  '/strict-plugin',
  '/strict-group/',
  '/strict-standard',
  '/strict-guard',
];
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

test('every mounted route kind refuses coercible JSON fields with their JSON pointers', async () => {
  for (const path of routes) {
    for (const [field, value] of [
      ['integer', '2'],
      ['number', '2.5'],
      ['boolean', 'true'],
      ['string', 2],
    ] as const) {
      const response = await post(path, { ...valid, [field]: value });
      const problem = await response.json();
      expect({ path, field, status: response.status }).toEqual({ path, field, status: 400 });
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(problem).toMatchObject({
        code: 'invalid_request',
        status: 400,
        effect_status: 'not_applicable',
        errors: [{ pointer: `/${field}`, code: 'invalid_type' }],
      });
      expect(Value.Check(problemSchema('invalid_request'), problem)).toBe(true);
    }
    const accepted = await post(path, valid);
    expect({ path, status: accepted.status }).toEqual({ path, status: 200 });
    expect(await accepted.json()).toEqual(valid);
  }
});

test('mounted subject search refuses a numeric string limit before calling the service', async () => {
  searches.length = 0;
  const refused = await post('/v1/subjects:search', { limit: '2' });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({
    code: 'invalid_request',
    errors: [{ pointer: '/limit', code: 'invalid_type' }],
  });
  expect(searches).toEqual([]);
  const accepted = await post('/v1/subjects:search', { limit: 2 });
  expect(accepted.status).toBe(200);
  expect(searches).toEqual([{ limit: 2 }]);
});

test('numeric query and path parameters still reach handlers as numbers', async () => {
  const response = await kernel.handle(new Request('http://kernel.test/strict-params/2?number=2.5'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: 2, number: 2.5 });
  suggestions.length = 0;
  const suggested = await kernel.handle(new Request('http://kernel.test/v1/subjects:suggest?q=two&limit=2'));
  expect(suggested.status).toBe(200);
  expect(suggestions).toEqual([{ q: 'two', limit: 2 }]);
});

test('strict validation precedes authentication and preserves parsing transform errors', async () => {
  authentications = 0;
  const invalid = await post('/v1/subjects:search', { limit: '2' }, { authorization: 'Bearer refused' });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ errors: [{ pointer: '/limit', code: 'invalid_type' }] });
  expect(authentications).toBe(0);
  const oversized = await post('/strict-size', valid);
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ code: 'content_too_large' });
});
