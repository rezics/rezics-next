import { testReceiptKeys } from '../support/receipt-keys.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { createRealAccess } from './real-access.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { activeRelease } from '../../src/semantic/definition-release-read.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from '../../src/semantic/contract/subject-values.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const accounts = {
  steward: '019a1b2c-3d4e-7f00-8a00-57e3a2d00001',
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000002',
};
const realAccess = await createRealAccess(admin, accounts, [
  'gate:definition_publication',
  'definitions:publish',
  'definitions:activate',
  'definitions:read',
]);
beforeAll(async () => {
  for (const persona of ['steward', 'editor'] as const)
    await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, persona, 'gate:definition_publication');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'steward', 'definitions:publish');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'steward', 'definitions:activate');
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
const kernel = createKernel({
  receiptKeys: testReceiptKeys(),
  pool,
  access: realAccess.access,
  tokens,
  routeKey: new Uint8Array(32).fill(6),
  writeRate: realAccess.writeRate,
});

async function call(method: string, path: string, options: { token?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) {
    const credential = Object.hasOwn(accounts, options.token)
      ? realAccess.bearer(options.token as keyof typeof accounts)
      : options.token;
    headers.authorization = `Bearer ${credential}`;
  }
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
const key = () => `"${randomUUID()}"`;
const release = (version: string): Release => ({
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://rezics.com/catalogue/test', version },
  generator: { name: 'test', version: '1' },
  prefixes: { schema: 'http://schema.org/' },
  types: {
    'schema:Person': {
      iri: 'http://schema.org/Person',
      labels: { en: 'person' },
      mappings: [],
      bases: [],
      properties: ['schema:url'],
      facets: [],
    },
  },
  properties: {
    'schema:url': {
      iri: 'http://schema.org/url',
      labels: { en: 'URL' },
      mappings: [],
      datatype: 'url',
      multivalued: false,
      qualifiers: [],
      value: valueSchema('url'),
    },
  },
});
const publish = (body: unknown, token = 'steward', idempotency = key()) =>
  call('POST', '/v1/definitions/releases', { token, key: idempotency, body });
const activate = (digest: string, expected: number | null, token = 'steward', idempotency = key()) =>
  call('POST', `/v1/definitions/releases/${digest}:activate`, {
    token,
    key: idempotency,
    body: { expected_head: expected },
  });
async function count(table: string): Promise<number> {
  const { rows } = await admin.query(`SELECT count(*)::int AS n FROM semantic.${table}`);
  return rows[0].n;
}

test('the Global Context is seeded and nothing is active at first', async () => {
  expect(GLOBAL_CONTEXT).toBe('00000000-0000-8000-8000-000000000000');
  const { rows } = await admin.query('SELECT route, kind, labels FROM semantic.context WHERE context_id = $1', [
    GLOBAL_CONTEXT,
  ]);
  expect(rows).toEqual([{ route: 0, kind: 'global', labels: { en: 'Global' } }]);
  expect((await call('GET', '/v1/definitions/active')).response.status).toBe(404);
  expect((await call('GET', '/v1/definitions')).response.status).toBe(404);
  expect(await activeRelease(pool)).toBeNull();
});

test('a steward publishes a release once and anyone reads it by digest, immutably', async () => {
  const body = { release: release('1.0.0') };
  const digest = releaseDigest(body.release);
  const idempotency = key();
  const first = await publish(body, 'steward', idempotency);
  expect(first.response.status).toBe(201);
  expect(first.body).toEqual({ digest });
  expect(first.response.headers.get(SESSION_HEADER)).toBeTruthy();
  expect(await publish(body, 'steward', idempotency)).toMatchObject({ body: { digest } });
  const again = await publish(body);
  expect(again.response.status).toBe(200);
  expect(again.body).toEqual({ digest });
  const { rows } = await admin.query('SELECT route FROM semantic.definition_release WHERE digest = $1', [digest]);
  expect(rows).toEqual([{ route: 0 }]);
  const read = await call('GET', `/v1/definitions/releases/${digest}`);
  expect(read.response.status).toBe(200);
  expect(read.body).toEqual({ digest, release: body.release });
  expect(read.response.headers.get('etag')).toBe(`"${digest}"`);
  expect(read.response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect((await call('GET', `/v1/definitions/releases/sha256:${'0'.repeat(64)}`)).response.status).toBe(404);
  expect((await call('GET', '/v1/definitions/releases/not-a-digest')).response.status).toBe(404);
});

test('an invalid release is refused with pointers under /release and stores nothing', async () => {
  const before = await count('definition_release');
  const broken = release('1.0.1') as any;
  broken.properties['schema:url'].datatype = 'geo-shape';
  const refused = await publish({ release: broken });
  expect(refused.response.status).toBe(400);
  expect(refused.body.errors).toContainEqual({
    pointer: '/release/properties/schema:url/datatype',
    code: 'invalid_format',
  });
  const unsafe = release('1.0.2') as any;
  unsafe.properties['schema:url'] = {
    ...unsafe.properties['schema:url'],
    datatype: 'string',
    value: valueSchema('string', { pattern: '^(a+)+$' }),
  };
  expect((await publish({ release: unsafe })).body.errors).toEqual([
    { pointer: '/release/properties/schema:url/value/pattern', code: 'invalid_format' },
  ]);
  expect((await publish({ release: 'release' })).response.status).toBe(400);
  expect(await count('definition_release')).toBe(before);
});

test('publishing and activating need their grant on the Global Context', async () => {
  const body = { release: release('2.0.0') };
  const digest = releaseDigest(body.release);
  realAccess.checks.length = 0;
  expect((await publish(body, 'editor')).response.status).toBe(403);
  expect(realAccess.checks).toEqual([
    {
      persona: 'editor',
      action: 'definitions:publish',
      resource: { route: 0, id: GLOBAL_CONTEXT },
    },
  ]);
  const anonymous = await call('POST', '/v1/definitions/releases', { key: key(), body });
  expect(anonymous.response.status).toBe(403);
  expect(anonymous.body.code).toBe('platform_closed');
  expect((await call('GET', `/v1/definitions/releases/${digest}`)).response.status).toBe(404);
  expect((await publish(body)).response.status).toBe(201);
  expect((await activate(digest, null, 'editor')).response.status).toBe(403);
  expect(await activeRelease(pool)).toBeNull();
});

test('activation is a compare-and-swap on the active head', async () => {
  const first = release('3.0.0');
  const second = release('3.1.0');
  for (const body of [first, second]) await publish({ release: body });
  const [one, two] = [releaseDigest(first), releaseDigest(second)];
  const activated = await activate(one, null);
  expect(activated.response.status).toBe(200);
  expect(activated.body).toEqual({ digest: one, head: 1 });
  const stale = await activate(two, null);
  expect(stale.response.status).toBe(409);
  expect(stale.body.code).toBe('stale_editorial_head');
  expect((await activate(two, 1)).body).toEqual({ digest: two, head: 2 });
  expect((await call('GET', '/v1/definitions/active')).body).toEqual({ digest: two, head: 2 });
  expect((await call('GET', '/v1/definitions')).body).toEqual({ digest: two, head: 2 });
  expect((await activate(`sha256:${'1'.repeat(64)}`, 2)).response.status).toBe(404);
  expect((await activate(`sha256:${'1'.repeat(64)}`, 2, 'editor')).response.status).toBe(403);
  const reused = key();
  expect((await activate(one, 2, 'steward', reused)).body).toEqual({ digest: one, head: 3 });
  const conflict = await activate(two, 2, 'steward', reused);
  expect(conflict.response.status).toBe(422);
  expect(conflict.body.code).toBe('idempotency_conflict');
  expect((await activate(two, 3)).body).toEqual({ digest: two, head: 4 });
  expect(await activeRelease(pool)).toEqual({ digest: two, head: 4, release: second });
  const { rows } = await admin.query('SELECT head, digest FROM semantic.definition_activation ORDER BY head');
  expect(rows).toEqual([
    { head: 1, digest: one },
    { head: 2, digest: two },
    { head: 3, digest: one },
    { head: 4, digest: two },
  ]);
});

test('bootstrap activates a release only when none is active', async () => {
  const active = (await activeRelease(pool))!;
  expect(await bootstrapRelease(pool, release('9.0.0'))).toBe(active.digest);
  expect((await activeRelease(pool))!.head).toBe(active.head);
});

test('the kernel contract documents the definition operations', () => {
  const paths = openApiDocument(kernel).paths;
  expect(paths['/v1/definitions/releases']!.post).toMatchObject({
    operationId: 'definitions.publish',
    'x-action': 'definitions:publish',
    security: [{ bearerAuth: [] }],
  });
  expect(paths['/v1/definitions/releases/{digest}']!.get).toMatchObject({
    operationId: 'definitions.read_release',
    'x-action': 'definitions:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(paths['/v1/definitions']!.get).toMatchObject({
    operationId: 'definitions.read',
    'x-action': 'definitions:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(paths['/v1/definitions/active']!.get).toMatchObject({ operationId: 'definitions.read_active' });
  const activation = paths['/v1/definitions/releases/{digest}:activate']!.post!;
  expect(activation).toMatchObject({ operationId: 'definitions.activate', 'x-action': 'definitions:activate' });
  expect(Object.keys(activation.responses!).sort()).toEqual(['200', '400', '401', '403', '404', '409', '422', '503']);
});
