import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { createRealAccess } from './real-access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const projection = linkProjection(pool);
const relays = startRelays(pool, [projection], { intervalMs: 50 });
afterAll(async () => {
  await relays.stop();
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const routeKey = new Uint8Array(32).fill(13);
const accounts = {
  writer: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001',
  reader: '019a1b2c-3d4e-7f00-8a00-4eade0000002',
  moderator: '019a1b2c-3d4e-7f00-8a00-0d0000000012',
};
const realAccess = await createRealAccess(admin, accounts, ['subject:create', 'subject:read', 'moderation:hide']);
const kernel = createKernel({ pool, access: realAccess.access, tokens, routeKey, writeRate: realAccess.writeRate });

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'writer', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
});

async function call(
  method: string,
  path: string,
  options: { token?: string; key?: string; body?: unknown; session?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) {
    const credential = Object.hasOwn(accounts, options.token)
      ? realAccess.bearer(options.token as keyof typeof accounts)
      : options.token;
    headers.authorization = `Bearer ${credential}`;
  }
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.session) headers[SESSION_HEADER] = options.session;
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

async function catchUpLinks(id: string): Promise<void> {
  const route = routeOf(id)!;
  for (let step = 0; step < 200; step++) {
    const result = await projection.run(partitionOf(route));
    if (result.status === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    if (result.envelopes === 0) return;
  }
  throw new Error('Semantic link projection did not catch up');
}

const create = (body: Record<string, unknown>, key = `"${randomUUID()}"`, token = 'writer') =>
  call('POST', '/v1/subjects', { token, key, body: { type: 'schema:Book', ...body } });
const author = (id: string) => ({ property: { id: 'schema:author' }, value: { type: 'value', content: id } });

test('a create is 201 with its location and session token, and its key replays it', async () => {
  const key = `"${randomUUID()}"`;
  const book = { type: 'schema:Book', labels: { en: 'Botchan', ja: '坊っちゃん' } };
  const first = await create(book, key);
  expect(first.response.status).toBe(201);
  const id = first.body.subject.id as string;
  expect(first.body).toEqual({
    subject: expect.objectContaining({
      id,
      type: 'schema:Book',
      revision: 1,
      context: GLOBAL_CONTEXT,
      labels: book.labels,
      descriptions: {},
      aliases: {},
      statements: {},
    }),
  });
  expect(first.response.headers.get('location')).toBe(`/v1/subjects/${id}`);
  expect(first.response.headers.get('etag')).toBe('"1"');
  const session = first.response.headers.get(SESSION_HEADER)!;
  expect(decodeSession(tokens, `account:${accounts.writer}`, session)).toHaveLength(1);

  const again = await create({ labels: { ja: '坊っちゃん', en: 'Botchan' } }, key);
  expect(again.response.status).toBe(201);
  expect(again.body.subject.id).toBe(id);
  expect(again.response.headers.get('location')).toBe(`/v1/subjects/${id}`);

  const reused = await create({ labels: { en: 'Kokoro' } }, key);
  expect(reused.response.status).toBe(422);
  expect(reused.body).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
});

test('a create needs an account, a structured idempotency key, a valid item and the create grant', async () => {
  const book = { type: 'schema:Book', labels: { en: 'Kokoro' } };
  const anonymous = await call('POST', '/v1/subjects', { key: `"${randomUUID()}"`, body: book });
  expect(anonymous.response.status).toBe(401);
  expect(anonymous.body.code).toBe('authentication_required');
  expect(anonymous.response.headers.get('www-authenticate')).toBe('Bearer');

  for (const key of [undefined, 'unquoted', '""']) {
    const refused = await call('POST', '/v1/subjects', { token: 'writer', body: book, ...(key ? { key } : {}) });
    expect(refused.response.status).toBe(400);
    expect(refused.body.code).toBe('invalid_request');
  }

  const invalid = await create({ labels: { en: ' padded' } });
  expect(invalid.response.status).toBe(400);
  expect(invalid.body).toMatchObject({
    code: 'invalid_request',
    errors: [{ pointer: '/labels/en', code: 'invalid_format' }],
  });

  const key = `"${randomUUID()}"`;
  const forbidden = await create(book, key, 'reader');
  expect(forbidden.response.status).toBe(403);
  expect(forbidden.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(realAccess.checks.at(-1)).toEqual({
    persona: 'reader',
    action: 'subject:create',
    resource: { route: 0, id: GLOBAL_CONTEXT },
  });
});

test('a read returns the subject, its session token and the labels of its properties and readable subjects', async () => {
  const soseki = (await create({ type: 'schema:Person', labels: { en: 'Natsume Sōseki' } })).body.subject.id as string;
  const secret = (await create({ type: 'schema:Person', labels: { en: 'Unreadable' } })).body.subject.id as string;
  const source = { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/kokoro' } };
  const created = await create({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: { 'schema:author': [{ ...author(soseki), references: [{ parts: [source] }] }, author(secret)] },
  });
  const id = created.body.subject.id as string;
  const hidden = await call('POST', `/v1/subjects/${secret}:hide`, {
    token: 'moderator',
    key: `"${randomUUID()}"`,
    body: { reason: 'Hidden for the read test.' },
  });
  expect(hidden.response.status).toBe(200);

  await catchUpLinks(id);
  const read = await call('GET', `/v1/subjects/${id}`, { session: created.response.headers.get(SESSION_HEADER)! });
  expect(read.response.status).toBe(200);
  expect(read.response.headers.get('etag')).toBe('"1"');
  expect(read.body.subject).toEqual({
    ...created.body.subject,
    statements: { 'schema:author': [created.body.subject.statements['schema:author'][0]] },
  });
  expect(read.body.account).toBeNull();
  expect(read.body.related).toEqual({
    'schema:author': { labels: bundledRelease.properties['schema:author']!.labels },
    'schema:url': { labels: bundledRelease.properties['schema:url']!.labels },
    [soseki]: {
      labels: { en: 'Natsume Sōseki' },
      type: 'schema:Person',
      types: ['schema:Person', ...bundledRelease.types['schema:Person']!.bases],
      cover: null,
    },
  });
  expect(decodeSession(tokens, 'anonymous', read.response.headers.get(SESSION_HEADER)!)).toHaveLength(1);
  expect(
    realAccess.readChecks.filter(({ action }) => action === 'subject:read').map(({ resource }) => resource.id),
  ).toEqual(expect.arrayContaining([id, soseki]));
  expect(
    realAccess.readChecks.filter(({ action }) => action === 'subject:read').map(({ resource }) => resource.id),
  ).not.toContain(secret);
});

test('a malformed, missing or unreadable subject is the same 404', async () => {
  const id = (await create({ type: 'schema:Person', labels: { en: 'Sanshirō' } })).body.subject.id as string;
  const hidden = await call('POST', `/v1/subjects/${id}:hide`, {
    token: 'moderator',
    key: `"${randomUUID()}"`,
    body: { reason: 'Hidden for the 404 test.' },
  });
  expect(hidden.response.status).toBe(200);
  const answers = await Promise.all(
    ['not-an-id', newId(0x0042), id].map((subject) => call('GET', `/v1/subjects/${subject}`, { token: 'reader' })),
  );
  for (const { response, body } of answers) {
    expect(response.status).toBe(404);
    expect(response.headers.get(SESSION_HEADER)).toBeNull();
    const { request_id: _, ...problem } = body;
    expect(problem).toEqual({
      type: 'https://rezics.com/problems/not_found',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      retryable: false,
      effect_status: 'not_applicable',
    });
  }
});

test('the kernel contract documents both subject operations with their actions and problems', () => {
  const paths = openApiDocument(kernel).paths;
  const created = paths['/v1/subjects']!.post!;
  expect(created).toMatchObject({
    operationId: 'subject.create',
    'x-action': 'subject:create',
    security: [{ bearerAuth: [] }],
  });
  expect(Object.keys(created.responses!).sort()).toEqual(['201', '400', '401', '403', '422', '503']);
  expect(created.parameters).toEqual(
    expect.arrayContaining([expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true })]),
  );
  const read = paths['/v1/subjects/{id}']!.get!;
  expect(read).toMatchObject({
    operationId: 'subject.get',
    'x-action': 'subject:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(Object.keys(read.responses!).sort()).toEqual(['200', '308', '401', '404', '503']);
});
