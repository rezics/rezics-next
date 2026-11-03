import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { activeProfile } from '../../src/presentation/profiles.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from '../semantic/real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
const receiptKeys = testReceiptKeys();
const curatorId = '019a1b2c-3d4e-7f00-8a00-c0a7e0000001';
const editorId = '019a1b2c-3d4e-7f00-8a00-ed170e000002';
const presentationScopes = ['presentation:publish', 'presentation:activate', 'presentation:read'] as const;
const realAccess = await createRealAccess(admin, { curator: curatorId, editor: editorId }, presentationScopes);
const curatorToken = realAccess.bearer('curator');
const editorToken = realAccess.bearer('editor');
beforeAll(async () => {
  for (const action of ['presentation:publish', 'presentation:activate']) {
    await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'curator', action);
  }
});
const kernel = createKernel({
  pool,
  requestDeadlineMs: 30_000,
  access: realAccess.access,
  tokens,
  receiptKeys,
  routeKey: new Uint8Array(32).fill(6),
  writeRate: {
    async spend() {
      return { allowed: true };
    },
  },
});

async function call(method: string, path: string, options: { token?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
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
const profile = (text: string): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [{ type: 'Heading', props: { id: 'title', text, level: 2 } }] },
  bases: [],
  types: [
    {
      type: 'schema:Book',
      document: { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'h' } }] },
    },
  ],
  routes: [],
});
const publish = (body: unknown, token = curatorToken, idempotency = key()) =>
  call('POST', '/v1/presentation/profiles', { token, key: idempotency, body });
const activate = (digest: string, expected: number | null, token = curatorToken, idempotency = key()) =>
  call('POST', `/v1/presentation/profiles/${digest}:activate`, {
    token,
    key: idempotency,
    body: { expected_head: expected },
  });
async function count(table: string): Promise<number> {
  const { rows } = await admin.query(`SELECT count(*)::int AS n FROM presentation.${table}`);
  return rows[0].n;
}

test('a curator publishes a profile once and anyone reads it by digest, immutably', async () => {
  expect((await call('GET', '/v1/presentation/active')).response.status).toBe(404);
  const body = { profile: profile('One') };
  const digest = profileDigest(body.profile);
  const idempotency = key();
  const first = await publish(body, curatorToken, idempotency);
  expect(first.response.status).toBe(201);
  expect(first.body).toEqual({ digest });
  expect(first.response.headers.get(SESSION_HEADER)).toBeTruthy();
  expect(await publish(body, curatorToken, idempotency)).toMatchObject({ body: { digest } });
  const again = await publish(body);
  expect(again.response.status).toBe(200);
  expect(again.body).toEqual({ digest });
  const read = await call('GET', `/v1/presentation/profiles/${digest}`);
  expect(read.response.status).toBe(200);
  expect(read.body).toEqual({ digest, profile: body.profile });
  expect(read.response.headers.get('etag')).toBe(`"${digest}"`);
  expect(read.response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect((await call('GET', `/v1/presentation/profiles/sha256:${'0'.repeat(64)}`)).response.status).toBe(404);
  expect((await call('GET', '/v1/presentation/profiles/not-a-digest')).response.status).toBe(404);
});

test('an invalid profile is refused with pointers under /profile and stores nothing', async () => {
  const before = await count('profile');
  const broken = profile('<script>alert(1)</script>');
  broken.types[0]!.document!.content[0]!.type = 'Script';
  broken.types[0]!.document!.content.push({ type: 'Statements', props: { id: 's', properties: ['schema:author'] } });
  broken.types[0]!.document!.content.push({
    type: 'SubjectList',
    props: { id: 'l', title: 'Works', property: 'schema:author', limit: 99 },
  });
  const refused = await publish({ profile: broken });
  expect(refused.response.status).toBe(400);
  expect(refused.body.code).toBe('invalid_request');
  expect(refused.body.errors).toEqual([
    { pointer: '/profile/generic/content/0/props/text', code: 'invalid_format' },
    { pointer: '/profile/types/0/document/content/0/type', code: 'unsupported' },
    { pointer: '/profile/types/0/document/content/2/props/limit', code: 'out_of_range' },
  ]);
  expect((await publish({ profile: 'profile' })).response.status).toBe(400);
  expect((await publish({})).response.status).toBe(400);
  expect(await count('profile')).toBe(before);
});

test('profile numeric ranges are out_of_range and malformed limits are invalid_format without storing refusals', async () => {
  const withLimit = (limit: unknown): PresentationProfile => ({
    ...profile('Limits'),
    generic: {
      root: { props: {} },
      content: [{ type: 'SubjectList', props: { id: 'works', title: 'Works', property: 'schema:author', limit } }],
    },
  });
  for (const [limit, code] of [
    [25, 'out_of_range'],
    [0, 'out_of_range'],
    ['25', 'invalid_format'],
    ['1', 'invalid_format'],
    [1.5, 'invalid_format'],
    [25.5, 'invalid_format'],
  ] as const) {
    const before = await count('profile');
    const refused = await publish({ profile: withLimit(limit) });
    expect(refused.response.status).toBe(400);
    expect(refused.body.code).toBe('invalid_request');
    expect(refused.body.errors).toEqual([{ pointer: '/profile/generic/content/0/props/limit', code }]);
    expect(await count('profile')).toBe(before);
  }
  for (const limit of [1, 24]) {
    const valid = withLimit(limit);
    const accepted = await publish({ profile: valid });
    expect(accepted.response.status).toBe(201);
    expect(accepted.body).toEqual({ digest: profileDigest(valid) });
    const stored = await call('GET', `/v1/presentation/profiles/${accepted.body.digest}`);
    expect(stored.response.status).toBe(200);
    expect(stored.body).toEqual({ digest: accepted.body.digest, profile: valid });
  }
});

test('publishing and activating need their grant on the Global Context', async () => {
  const body = { profile: profile('Two') };
  const digest = profileDigest(body.profile);
  realAccess.checks.length = 0;
  expect((await publish(body, editorToken)).response.status).toBe(403);
  expect(realAccess.checks).toEqual([
    { persona: 'editor', action: 'presentation:publish', resource: { route: 0, id: GLOBAL_CONTEXT } },
  ]);
  expect((await call('POST', '/v1/presentation/profiles', { key: key(), body })).response.status).toBe(401);
  expect((await call('GET', `/v1/presentation/profiles/${digest}`)).response.status).toBe(404);
  expect((await publish(body)).response.status).toBe(201);
  expect((await activate(digest, null, editorToken)).response.status).toBe(403);
  expect(await activeProfile(pool)).toBeNull();
});

test('activation is a compare-and-swap on the active head', async () => {
  const [one, two] = [profileDigest(profile('One')), profileDigest(profile('Two'))];
  const activated = await activate(one, null);
  expect(activated.response.status).toBe(200);
  expect(activated.body).toEqual({ digest: one, head: 1 });
  const stale = await activate(two, null);
  expect(stale.response.status).toBe(409);
  expect(stale.body.code).toBe('stale_editorial_head');
  expect((await activate(two, 1)).body).toEqual({ digest: two, head: 2 });
  expect((await call('GET', '/v1/presentation/active')).body).toEqual({ digest: two, head: 2 });
  expect((await activate(`sha256:${'1'.repeat(64)}`, 2)).response.status).toBe(404);
  const reused = key();
  expect((await activate(one, 2, curatorToken, reused)).body).toEqual({ digest: one, head: 3 });
  const conflict = await activate(two, 2, curatorToken, reused);
  expect(conflict.response.status).toBe(422);
  expect(conflict.body.code).toBe('idempotency_conflict');
  expect((await activeProfile(pool))!.digest).toBe(one);
});

test('the kernel contract documents the presentation operations', () => {
  const paths = openApiDocument(kernel).paths;
  expect(paths['/v1/presentation/profiles']!.post).toMatchObject({
    operationId: 'presentation.publish',
    'x-action': 'presentation:publish',
    security: [{ bearerAuth: [] }],
  });
  expect(paths['/v1/presentation/profiles/{digest}']!.get).toMatchObject({
    operationId: 'presentation.read_profile',
    'x-action': 'presentation:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(paths['/v1/presentation/active']!.get).toMatchObject({
    operationId: 'presentation.read_active',
    'x-action': 'presentation:read',
  });
  const activation = paths['/v1/presentation/profiles/{digest}:activate']!.post!;
  expect(activation).toMatchObject({ operationId: 'presentation.activate', 'x-action': 'presentation:activate' });
  expect(Object.keys(activation.responses!).sort()).toEqual(['200', '400', '401', '403', '404', '409', '422', '503']);
});
