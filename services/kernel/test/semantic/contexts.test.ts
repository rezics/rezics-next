import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createAccess, type AccessConfig } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { withConnection } from '../../src/database/pool.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
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
const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  outsider: '019a1b2c-3d4e-7f00-8a00-0075de000003',
};
const scopes = ['access:grant', 'context:create', 'context:read', 'context:accept', 'context:adopt'];
let access: ReturnType<typeof createAccess>;
let bearerTokens: Record<keyof typeof accounts, string>;
let jwk: Record<string, unknown>;
const auth = {
  issuer: 'https://auth.example.test',
  audience: 'https://api.rezics.test',
  jwksUrl: 'https://auth.example.test/jwks',
  fetch: async () => Response.json({ keys: [jwk] }),
};
const kernel = createKernel({
  pool,
  access: (config: AccessConfig) => (access ??= createAccess({ ...config, auth })),
  tokens,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: createWriteRateLimiter({ secret: 'semantic-contexts-test-rate-secret-at-least-32-bytes' }),
});

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  jwk = { ...(await exportJWK(signing.publicKey)), kid: 'contexts', alg: 'ES256' };
  access = createAccess({ actions: actionCatalogue(kernel), auth });
  bearerTokens = {
    editor: await signedToken(accounts.editor, signing.privateKey),
    outsider: await signedToken(accounts.outsider, signing.privateKey),
  };
  for (const id of Object.values(accounts))
    await admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  const unrelated = newId(0);
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES (0,$1,$2,'context:create','(,)',$2)`,
    [GLOBAL_CONTEXT, accounts.editor],
  );
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES (0,$1,$2,'context:create','(,)',$2)`,
    [unrelated, accounts.outsider],
  );
});

async function signedToken(accountId: string, key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']) {
  return new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'contexts', typ: 'at+jwt' })
    .setIssuer(auth.issuer)
    .setAudience(auth.audience)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

async function call(
  method: string,
  path: string,
  options: { token?: string | null; key?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) {
    const token = Object.hasOwn(bearerTokens, options.token)
      ? bearerTokens[options.token as keyof typeof bearerTokens]
      : options.token;
    headers.authorization = `Bearer ${token}`;
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
const create = (body: unknown, token: string | null = 'editor', idempotency = key()) =>
  call('POST', '/v1/contexts', { ...(token ? { token } : {}), key: idempotency, body });
async function communities(): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM semantic.context WHERE kind = 'community'");
  return rows[0].n;
}

async function permission(account: keyof typeof accounts, action: string, resource: { route: number; id: string }) {
  const deadline = Date.now() + 5000;
  const actor = await access.authenticate(bearerTokens[account], { pool, deadline });
  const evidence = await access.prepare?.(actor, action, resource, { pool, deadline });
  if (evidence === undefined) return false;
  return withConnection(pool, (client) => access.authorize(client, actor, action, resource, evidence));
}

test('an editor creates a community Context that anyone reads and its key replays', async () => {
  const token = key();
  const body = { labels: { en: 'Literature readers', ja: '文学の読者' } };
  const first = await create(body, 'editor', token);
  expect(first.response.status).toBe(201);
  const context = first.body.context;
  expect(first.body).toEqual({
    context: { id: expect.any(String), kind: 'community', labels: body.labels, settings: null, defaults: {} },
  });
  expect(first.response.headers.get('location')).toBe(`/v1/contexts/${context.id}`);
  expect(first.response.headers.get('rezics-session-token')).toBeTruthy();
  const unrelatedGrant = await create({ labels: { en: 'Unrelated grant' } }, 'outsider');
  expect([unrelatedGrant.response.status, unrelatedGrant.body.code]).toEqual([403, 'forbidden']);
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
  expect(global.body).toEqual({
    context: { id: GLOBAL_CONTEXT, kind: 'global', labels: { en: 'Global' }, settings: null, defaults: {} },
  });
});

test('Context creators receive the owner actions, while the moderator role grants acceptance only', async () => {
  const created = await create({ labels: { en: 'Context owners' } });
  expect(created.response.status).toBe(201);
  const resource = { route: routeOf(created.body.context.id)!, id: created.body.context.id };
  expect(await permission('editor', 'context:accept', resource)).toBe(true);
  expect(await permission('editor', 'context:adopt', resource)).toBe(true);
  expect(await permission('outsider', 'context:accept', resource)).toBe(false);
  expect(await permission('outsider', 'context:adopt', resource)).toBe(false);

  const roles = resourceRoleCatalogue(access)!;
  expect(roles.types.get('semantic.context')).toEqual({ owner: 'semantic.context.owner', standing: [] });
  expect(roles.roles.get('semantic.context.owner')).toEqual(
    ['context:accept', 'context:adopt', 'access:grant', 'context:delete', 'context:restore'].sort(),
  );
  expect(roles.roles.get('semantic.context.moderator')).toEqual(['context:accept']);

  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'access:grant','(,)',$3)`,
    [resource.route, resource.id, accounts.editor],
  );
  const actor = await access.authenticate(bearerTokens.editor, { pool, deadline: Date.now() + 5000 });
  const grants = createGrantCommands({ pool, access, managementAction: 'access:grant' });
  await grants.createRole(
    { pool, actor, deadline: Date.now() + 5000 },
    {
      resource,
      subject: { kind: 'account', id: accounts.outsider },
      role: 'semantic.context.moderator',
      valid: '(,)',
      key: randomUUID(),
    },
  );
  expect(await permission('outsider', 'context:accept', resource)).toBe(true);
  expect(await permission('outsider', 'context:adopt', resource)).toBe(false);
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
