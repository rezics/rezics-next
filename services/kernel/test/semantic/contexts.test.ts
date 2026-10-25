import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { AuthenticationError, type Access, type AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const account = (accountId: string): AccountActor => ({
  kind: 'account',
  accountId,
  clientId: 'web',
  scopes: ['context:create', 'context:read'],
  requestedBy: null,
  authnEpoch: 1,
});
const actors: Record<string, AccountActor> = {
  editor: account('019a1b2c-3d4e-7f00-8a00-ed170e000001'),
  outsider: account('019a1b2c-3d4e-7f00-8a00-0075de000003'),
};
const checks: { action: string; route: number; id: string }[] = [];
const access: Access = {
  async authenticate(token) {
    const actor = actors[token];
    if (!actor) throw new AuthenticationError(401, 'Bearer error="invalid_token"');
    return actor;
  },
  async authorize(_client, actor, action, resource) {
    if (action === 'context:read') return true;
    checks.push({ action, route: resource.route, id: resource.id });
    return (
      action === 'context:create' &&
      actor.kind === 'account' &&
      actor.accountId === actors.editor!.accountId &&
      resource.id === GLOBAL_CONTEXT
    );
  },
};
const kernel = createKernel({ pool, access, tokens, routeKey: new Uint8Array(32).fill(4) });

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
const create = (body: unknown, token: string | null = 'editor', idempotency = key()) =>
  call('POST', '/v1/contexts', { ...(token ? { token } : {}), key: idempotency, body });
async function communities(): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM semantic.context WHERE kind = 'community'");
  return rows[0].n;
}

test('an editor creates a community Context that anyone reads and its key replays', async () => {
  const token = key();
  const body = { labels: { en: 'Literature readers', ja: '文学の読者' } };
  const first = await create(body, 'editor', token);
  expect(first.response.status).toBe(201);
  const context = first.body.context;
  expect(first.body).toEqual({ context: { id: expect.any(String), kind: 'community', labels: body.labels } });
  expect(first.response.headers.get('location')).toBe(`/v1/contexts/${context.id}`);
  expect(first.response.headers.get('rezics-session-token')).toBeTruthy();
  expect(checks.at(-1)).toEqual({ action: 'context:create', route: 0, id: GLOBAL_CONTEXT });
  const replay = await create(body, 'editor', token);
  expect(replay.response.status).toBe(201);
  expect(replay.body).toEqual(first.body);
  const conflict = await create({ labels: { en: 'Different readers' } }, 'editor', token);
  expect([conflict.response.status, conflict.body.code]).toEqual([422, 'idempotency_conflict']);
  expect(await communities()).toBe(1);
  const read = await call('GET', `/v1/contexts/${context.id}`);
  expect(read.response.status).toBe(200);
  expect(read.body).toEqual({ context });
  const { rows } = await admin.query('SELECT route, kind, labels FROM semantic.context WHERE context_id = $1', [
    context.id,
  ]);
  expect(rows).toEqual([{ route: routeOf(context.id), kind: 'community', labels: body.labels }]);
  const global = await call('GET', `/v1/contexts/${GLOBAL_CONTEXT}`, { token: 'outsider' });
  expect(global.response.status).toBe(200);
  expect(global.body).toEqual({ context: { id: GLOBAL_CONTEXT, kind: 'global', labels: { en: 'Global' } } });
});

test('creating a Context needs context:create on the Global Context and invalid input writes nothing', async () => {
  const before = await communities();
  const body = { labels: { en: 'Denied readers' } };
  for (const [token, status, code] of [
    [null, 401, 'authentication_required'],
    ['outsider', 403, 'forbidden'],
  ] as const) {
    const answer = await create(body, token);
    expect([answer.response.status, answer.body.code]).toEqual([status, code]);
    expect(answer.response.headers.get('location')).toBeNull();
  }
  for (const [invalid, pointer, code] of [
    [{}, '/labels', 'required'],
    [{ ...body, kind: 'global' }, '/kind', 'unknown_field'],
  ] as const) {
    const answer = await create(invalid);
    expect(answer.response.status).toBe(400);
    expect(answer.body.errors).toContainEqual({ pointer, code });
  }
  expect(await communities()).toBe(before);
});

test('unknown and malformed Context ids are the same 404', async () => {
  const unknown = await call('GET', `/v1/contexts/${newId(1234)}`);
  const malformed = await call('GET', '/v1/contexts/not-an-id');
  for (const answer of [unknown, malformed]) {
    expect([answer.response.status, answer.body.code]).toEqual([404, 'not_found']);
  }
  const { request_id: _unknown, ...a } = unknown.body;
  const { request_id: _malformed, ...b } = malformed.body;
  expect(a).toEqual(b);
});

test('the kernel contract documents Context creation and reads', () => {
  const paths = openApiDocument(kernel).paths;
  const creation = paths['/v1/contexts']!.post!;
  expect(creation.operationId).toBe('context.create');
  expect(Object.keys(creation.responses!).sort()).toEqual(['201', '400', '401', '403', '422', '503']);
  const read = paths['/v1/contexts/{id}']!.get!;
  expect(read.operationId).toBe('context.get');
  expect(Object.keys(read.responses!).sort()).toEqual(['200', '401', '404', '503']);
});
