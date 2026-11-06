import { afterAll, expect, test } from 'bun:test';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import { CommandUnavailableError } from '../src/command/command.ts';
import { createPool } from '../src/database/pool.ts';
import { createApp } from '../src/http/app.ts';
import { defineRateLimit } from '../src/http/rate-limit.ts';
import { PROBLEM_TYPE_BASE, ProblemError, problemSchema } from '../src/http/problem.ts';
import { AuthenticationError } from '../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const unreachable = createPool('postgres://rezics:rezics@127.0.0.1:1/rezics?sslmode=disable');
afterAll(async () => {
  await pool.end();
  await unreachable.end();
});

const failures: Record<string, () => Error> = {
  'problem-error': () =>
    new ProblemError('forbidden', {
      detail: 'Only the owner may do this',
      errors: Array.from({ length: 20 }, (_, n) => ({ pointer: `/items/${n}`, code: 'unsupported' as const })),
      headers: { 'x-probe': 'kept' },
    }),
  'no-credentials': () => new AuthenticationError(401, 'Bearer'),
  'bad-token': () => new AuthenticationError(401, 'Bearer error="invalid_token"'),
  'bad-header': () => new AuthenticationError(400, 'Bearer error="invalid_request"'),
  overloaded: () => new CommandUnavailableError('overloaded', 7),
  fenced: () => new CommandUnavailableError('fenced', 7),
  moved: () => new CommandUnavailableError('moved', 7, 'node-b'),
  contention: () => new CommandUnavailableError('contention', 7),
  deadline: () => new CommandUnavailableError('deadline', 7),
  'abort-timeout': () => new DOMException('The operation timed out.', 'TimeoutError'),
  unexpected: () => new Error('connection to 10.0.0.7 refused; SELECT secret FROM core.partition'),
};
const app = createApp({ pool, writeRate: { spend: async () => ({ allowed: true }) } })
  .post(
    '/probe',
    {
      body: t.Object(
        { name: t.String({ minLength: 1, maxLength: 4 }), count: t.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
      detail: { 'x-exposure': 'public', 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) },
    },
    ({ body }) => body,
  )
  .get(
    '/probe/:failure',
    { params: t.Object({ failure: t.String() }), detail: { 'x-exposure': 'public' } },
    ({ params }) => {
      throw failures[params.failure]!();
    },
  );

const MEMBERS = ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id'];
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function call(method: string, path: string, body?: string) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
    }),
  );
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}

test('an unknown route is a problem document with exactly the fixed members', async () => {
  const first = await call('GET', '/nothing-here');
  const second = await call('GET', '/nothing-here');
  expect(first.response.status).toBe(404);
  expect(first.response.headers.get('content-type')).toBe('application/problem+json');
  expect(Object.keys(first.body).sort()).toEqual([...MEMBERS].sort());
  expect(first.body).toMatchObject({
    type: `${PROBLEM_TYPE_BASE}not_found`,
    status: 404,
    code: 'not_found',
    retryable: false,
    effect_status: 'not_applicable',
  });
  expect(PROBLEM_TYPE_BASE).toBe('https://rezics.com/problems/');
  expect(first.body.title).toEqual(expect.any(String));
  expect(first.body.request_id).toMatch(UUID_V7);
  expect(second.body.request_id).not.toBe(first.body.request_id);
  expect(Value.Check(problemSchema('not_found'), first.body)).toBe(true);
  expect(Value.Check(problemSchema('forbidden'), first.body)).toBe(false);
});

test('a malformed or invalid body is invalid_request with field errors and never echoes the input', async () => {
  const malformed = await call('POST', '/probe', '{"name": ');
  expect(malformed.response.status).toBe(400);
  expect(malformed.body).toMatchObject({ code: 'invalid_request', status: 400, effect_status: 'not_applied' });
  expect(malformed.body.errors).toBeUndefined();
  const invalid = await call('POST', '/probe', JSON.stringify({ name: 'secretname', count: -1, token: 'hunter2' }));
  expect(invalid.response.status).toBe(400);
  expect(invalid.response.headers.get('content-type')).toBe('application/problem+json');
  expect(invalid.body).toMatchObject({ code: 'invalid_request', type: `${PROBLEM_TYPE_BASE}invalid_request` });
  expect(invalid.body.errors).toEqual(
    expect.arrayContaining([
      { pointer: '/name', code: 'out_of_range' },
      { pointer: '/count', code: 'out_of_range' },
      { pointer: '/token', code: 'unknown_field' },
    ]),
  );
  expect(invalid.text).not.toContain('secretname');
  expect(invalid.text).not.toContain('hunter2');
  const missing = await call('POST', '/probe', JSON.stringify({ count: 'many' }));
  expect(missing.body.errors).toEqual(
    expect.arrayContaining([
      { pointer: '/name', code: 'required' },
      { pointer: '/count', code: 'invalid_type' },
    ]),
  );
  for (const result of [invalid, missing]) {
    expect(Object.keys(result.body).sort()).toEqual([...MEMBERS, 'errors'].sort());
    expect(Value.Check(problemSchema('invalid_request'), result.body)).toBe(true);
  }
  const accepted = await call('POST', '/probe', JSON.stringify({ name: 'ok', count: 1 }));
  expect(accepted.response.status).toBe(200);
  expect(accepted.body).toEqual({ name: 'ok', count: 1 });
});

test('kernel errors map to their problems, statuses and headers', async () => {
  const expected: Record<string, [number, string, boolean, Record<string, string>]> = {
    'no-credentials': [401, 'authentication_required', false, { 'www-authenticate': 'Bearer' }],
    'bad-token': [401, 'invalid_credentials', false, { 'www-authenticate': 'Bearer error="invalid_token"' }],
    'bad-header': [400, 'invalid_request', false, { 'www-authenticate': 'Bearer error="invalid_request"' }],
    overloaded: [503, 'overloaded', true, { 'retry-after': '1' }],
    fenced: [503, 'partition_unavailable', true, { 'retry-after': '1' }],
    moved: [503, 'partition_unavailable', true, { 'retry-after': '1' }],
    contention: [503, 'transaction_retry_exhausted', true, { 'retry-after': '1' }],
    deadline: [503, 'deadline_exceeded', true, {}],
    'abort-timeout': [503, 'deadline_exceeded', true, {}],
  };
  for (const [failure, [status, code, retryable, headers]] of Object.entries(expected)) {
    const { response, body } = await call('GET', `/probe/${failure}`);
    expect([failure, response.status, body.code, body.retryable]).toEqual([failure, status, code, retryable]);
    expect(body.type).toBe(PROBLEM_TYPE_BASE + code);
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value);
    expect(Object.keys(body).sort()).toEqual([...MEMBERS].sort());
  }
  const raised = await call('GET', '/probe/problem-error');
  expect(raised.response.status).toBe(403);
  expect(raised.response.headers.get('x-probe')).toBe('kept');
  expect(raised.body).toMatchObject({ code: 'forbidden', detail: 'Only the owner may do this' });
  expect(raised.body.errors).toHaveLength(16);
  expect(Value.Check(problemSchema('forbidden'), raised.body)).toBe(true);
  const unexpected = await call('GET', '/probe/unexpected');
  expect(unexpected.response.status).toBe(500);
  expect(unexpected.body).toMatchObject({ code: 'internal_error', retryable: false });
  expect(Object.keys(unexpected.body).sort()).toEqual([...MEMBERS].sort());
  expect(unexpected.text).not.toMatch(/10\.0\.0\.7|SELECT|secret/);
});

test('problem alternatives of one response share a status', () => {
  expect(() => problemSchema('overloaded', 'partition_unavailable')).not.toThrow();
  expect(() => problemSchema('not_found', 'forbidden')).toThrow(TypeError);
});

test('health reports whether the database answers', async () => {
  const healthy = await call('GET', '/health');
  expect(healthy.response.status).toBe(200);
  expect(healthy.body).toEqual({ status: 'ok' });
  const down = await createApp({ pool: unreachable }).handle(new Request('http://kernel.test/health'));
  expect(down.status).toBe(503);
  expect(await down.json()).toMatchObject({ code: 'dependency_unavailable', retryable: true });
});
