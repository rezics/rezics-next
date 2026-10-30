// Only this defensive authentication test writes suspended state directly: native suspension invalidates the bearer.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { decodeJwt } from 'jose';
import { Pool, type QueryConfig } from 'pg';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { problemResponse, ProblemError } from '../../src/http/problem.ts';
import { cookies, nativeFixture, password } from './native-account-bindings-fixture.ts';
import { createPersonas } from '../support/personas.ts';
import { testKernel } from '../support/test-kernel.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let app: ReturnType<typeof testKernel>;
let people: Awaited<ReturnType<typeof createPersonas>>;
let subject: string;
let zone: string;

async function request(bearer: string | null, method: string, path: string, body?: unknown, key = crypto.randomUUID()) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'POST' ? { 'idempotency-key': JSON.stringify(key) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function command(bearer: string, path: string, body: unknown) {
  const response = await request(bearer, 'POST', path, body);
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}

const subjectInput = { type: 'schema:Book', labels: { en: 'Suspension authentication control' } };
const routes = () => [
  { method: 'GET', path: `/v1/subjects/${subject}`, effect: 'not_applicable' },
  { method: 'GET', path: '/v1/libraryEntries', effect: 'not_applicable' },
  { method: 'GET', path: `/v1/zones/${zone}`, effect: 'not_applicable' },
  { method: 'POST', path: '/v1/subjects', body: subjectInput, effect: 'not_applied' },
];

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  app = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'suspended-bearer-native-write-rate-secret-32-bytes' }),
  });
  people = await createPersonas(app, { version: 1, pool, auth });
  await pool.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [people.staff.accountId],
  );
  await bootstrapRelease(pool, bundledRelease);
  await command(people.staff.bearer, '/v1/grants', {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: people.alice.accountId },
    actions: ['subject:create'],
    valid: '(,)',
  });
  subject = (await command(people.alice.bearer, '/v1/subjects', subjectInput)).subject.id;
  zone = newId(routeOf(people.alice.accountId)!);
}, 360_000);

afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await pool.end();
  }
});

async function problem(response: Response, status: number, code: string, effect: string, challenge: string | null) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  expect(response.headers.get('www-authenticate')).toBe(challenge);
  const body = await response.json();
  expect(body).toEqual({
    type: `https://rezics.com/problems/${code}`,
    title:
      code === 'account_suspended'
        ? 'Account Suspended'
        : code === 'invalid_credentials'
          ? 'Invalid Credentials'
          : 'Authentication Required',
    status,
    code,
    retryable: false,
    effect_status: effect,
    request_id: expect.any(String),
  });
  return body;
}

async function expectActiveRoute(bearer: string, route: ReturnType<typeof routes>[number]) {
  const response = await request(bearer, route.method, route.path, route.body);
  if (route.path === `/v1/zones/${zone}`) {
    expect(response.status).toBe(404);
    return;
  }
  expect(response.ok, `${route.method} ${route.path}: ${await response.clone().text()}`).toBe(true);
}

test('a verified unfenced suspended bearer at its floor shares one defensive problem on every route', async () => {
  for (const route of routes()) await expectActiveRoute(people.alice.bearer, route);
  await pool.query("UPDATE access.account SET state='suspended' WHERE account_id=$1", [people.alice.accountId]);
  try {
    for (const route of routes()) {
      await problem(
        await request(people.alice.bearer, route.method, route.path, route.body),
        403,
        'account_suspended',
        route.effect,
        null,
      );
    }
  } finally {
    await pool.query("UPDATE access.account SET state='active' WHERE account_id=$1", [people.alice.accountId]);
  }
});

test('native suspension refuses the bearer held beforehand on the same four routes', async () => {
  for (const route of routes()) {
    await problem(
      await request(people.suspended.bearer, route.method, route.path, route.body),
      401,
      'invalid_credentials',
      route.effect,
      'Bearer error="invalid_token"',
    );
  }
});

test('missing and malformed bearers retain their authentication problems on every route', async () => {
  for (const route of routes()) {
    await problem(
      await request('malformed', route.method, route.path, route.body),
      401,
      'invalid_credentials',
      route.effect,
      'Bearer error="invalid_token"',
    );
  }
  await problem(
    await request(null, 'GET', '/v1/libraryEntries'),
    401,
    'authentication_required',
    'not_applicable',
    'Bearer',
  );
  await problem(
    await request(null, 'POST', '/v1/subjects', subjectInput),
    401,
    'authentication_required',
    'not_applied',
    'Bearer',
  );
});

test('suspension between authentication and command preparation refuses the command before effects and receipts', async () => {
  const key = crypto.randomUUID();
  const query = pool.query.bind(pool);
  let reads = 0;
  let armed = true;
  pool.query = (async (input: QueryConfig | string, values?: unknown[]) => {
    const text = typeof input === 'string' ? input : input.text;
    const parameters = typeof input === 'string' ? values : input.values;
    if (
      armed &&
      text.includes('minimum_authn_epoch::text AS "minimumAuthnEpoch"') &&
      parameters?.[1] === people.alice.accountId &&
      ++reads === 2
    ) {
      armed = false;
      await command(people.staff.bearer, `/v1/accounts/${people.alice.accountId}:suspend`, {});
    }
    return typeof input === 'string' ? query(input, values) : query(input);
  }) as Pool['query'];
  const before = (await query('SELECT count(*)::int AS n FROM semantic.subject')).rows;
  try {
    await problem(
      await request(people.alice.bearer, 'POST', '/v1/subjects', subjectInput, key),
      401,
      'invalid_credentials',
      'not_applied',
      'Bearer error="invalid_token"',
    );
  } finally {
    pool.query = query as Pool['query'];
  }
  expect(reads).toBe(2);
  expect((await pool.query('SELECT count(*)::int AS n FROM semantic.subject')).rows).toEqual(before);
  expect((await pool.query('SELECT 1 FROM core.receipt WHERE idempotency_key=$1', [key])).rows).toEqual([]);
});

test('reinstatement admits a new sign-in bearer and keeps the old bearer refused', async () => {
  await command(people.staff.bearer, `/v1/accounts/${people.alice.accountId}:reinstate`, {});
  const claims = decodeJwt(people.alice.bearer);
  const signedIn = await auth.request('/signin', {
    account_id: people.alice.accountId,
    password,
    client_id: claims.client_id,
    scope: (claims.scope as string).split(' '),
  });
  expect(signedIn.status).toBe(200);
  const issued = await auth.request('/token', {}, cookies(signedIn));
  expect(issued.status).toBe(200);
  const bearer = ((await issued.json()) as { access_token: string }).access_token;
  for (const route of routes()) await expectActiveRoute(bearer, route);
  await problem(
    await request(people.alice.bearer, 'GET', `/v1/subjects/${subject}`),
    401,
    'invalid_credentials',
    'not_applicable',
    'Bearer error="invalid_token"',
  );
});

test('the shared mapper treats read methods and read actions as not applicable', async () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    await problem(
      problemResponse(new ProblemError('account_suspended'), { method, id: 'read' }),
      403,
      'account_suspended',
      'not_applicable',
      null,
    );
  }
  await problem(
    problemResponse(new ProblemError('account_suspended'), { method: 'POST', action: 'zone:read', id: 'action' }),
    403,
    'account_suspended',
    'not_applicable',
    null,
  );
});

test('a command action with a read prefix still has a not applied defensive problem', async () => {
  await problem(
    problemResponse(new ProblemError('account_suspended'), {
      method: 'POST',
      action: 'zone:read_report',
      id: 'command',
    }),
    403,
    'account_suspended',
    'not_applied',
    null,
  );
});
