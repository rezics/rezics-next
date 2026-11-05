import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { releaseDigest, type Release } from '@rezics/definitions';
import { createAccess, type AccessConfig } from '../../src/access/index.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { contextTarget } from '../../src/semantic/context.ts';
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
const routeKey = new Uint8Array(32).fill(4);
const actions = [
  'access:grant',
  'context:create',
  'context:read',
  'context:accept',
  'context:adopt',
  'subject:create',
  'subject:read',
  'statement:propose',
  'definitions:publish',
  'definitions:activate',
  'definitions:read',
];
const accountId = Bun.randomUUIDv7();
let bearerToken: string;
let jwk: Record<string, unknown>;
const auth = {
  issuer: 'https://auth.example.test',
  audience: 'https://api.rezics.test',
  jwksUrl: 'https://auth.example.test/jwks',
  fetch: async () => Response.json({ keys: [jwk] }),
};
const kernel = createKernel({
  pool,
  access: (config: AccessConfig) => createAccess({ ...config, auth }),
  tokens,
  routeKey,
  writeRate: {
    async spend() {
      return { allowed: true as const };
    },
  },
});

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  jwk = { ...(await exportJWK(signing.publicKey)), kid: 'context-settings', alg: 'ES256' };
  bearerToken = await new SignJWT({
    client_id: 'web',
    scope: actions.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'context-settings', typ: 'at+jwt' })
    .setIssuer(auth.issuer)
    .setAudience(auth.audience)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);

  await admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(accountId), accountId],
  );
  for (const action of [
    'context:create',
    'subject:create',
    'statement:propose',
    'definitions:publish',
    'definitions:activate',
    'definitions:read',
    'gate:definition_publication',
  ])
    await admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES (0,$1,$2,$3,'(,)',$2)`,
      [GLOBAL_CONTEXT, accountId, action],
    );
});

async function call(
  method: string,
  path: string,
  options: { authenticated?: boolean; key?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.authenticated) headers.authorization = `Bearer ${bearerToken}`;
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
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});

async function activateSettings(settingsId: string, mode: 'inherit' | 'suppress') {
  const active = await call('GET', '/v1/definitions/active', { authenticated: true });
  expect(active.response.status).toBe(200);
  const loaded = await call('GET', `/v1/definitions/releases/${active.body.digest}`, { authenticated: true });
  expect(loaded.response.status).toBe(200);
  const release = structuredClone(loaded.body.release) as Release;
  release.contexts = {
    [settingsId]: {
      labels: { en: 'Readers' },
      defaults: { 'schema:url': mode },
    },
  };
  const digest = releaseDigest(release);
  const published = await call('POST', '/v1/definitions/releases', {
    authenticated: true,
    key: key(),
    body: { release },
  });
  expect([200, 201]).toContain(published.response.status);
  expect(published.body.digest).toBe(digest);
  const activated = await call('POST', `/v1/definitions/releases/${digest}:activate`, {
    authenticated: true,
    key: key(),
    body: { expected_head: active.body.head },
  });
  expect(activated.response.status).toBe(200);
  return digest;
}

async function createContext(settings?: string, idempotency = key()) {
  const answer = await call('POST', '/v1/contexts', {
    authenticated: true,
    key: idempotency,
    body: { labels: { en: 'Readers' }, ...(settings === undefined ? {} : { settings }) },
  });
  return { ...answer, idempotency };
}

async function createSubject(name: string) {
  const answer = await call('POST', '/v1/subjects', {
    authenticated: true,
    key: key(),
    body: {
      type: 'schema:Book',
      labels: { en: name },
      statements: { 'schema:url': [statement('schema:url', `https://example.org/${randomUUID()}`)] },
    },
  });
  expect(answer.response.status).toBe(201);
  return answer.body.subject;
}

async function view(subjectId: string, contextId?: string, authenticated = false) {
  const answer = await call(
    'GET',
    `/v1/subjects/${subjectId}${contextId ? `?context=${encodeURIComponent(contextId)}` : ''}`,
    { authenticated },
  );
  expect(answer.response.status).toBe(200);
  return answer.body.subject;
}

async function listed(subjectId: string, property: string, contextId?: string) {
  const query = new URLSearchParams({ property, ...(contextId ? { context: contextId } : {}) });
  const answer = await call('GET', `/v1/subjects/${subjectId}/candidates?${query}`);
  expect(answer.response.status).toBe(200);
  return answer.body;
}

async function contexts(): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM semantic.context WHERE kind = 'community'");
  return rows[0].n;
}

test('a Context created from settings suppresses its default properties until it adopts them', async () => {
  const release = await activateSettings('anime', 'suppress');
  const subject = await createSubject('Context defaults');
  const created = await createContext('anime');
  expect(created.response.status).toBe(201);
  const contextId = created.body.context.id as string;
  const expectedContext = {
    id: contextId,
    kind: 'community',
    labels: { en: 'Readers' },
    settings: { id: 'anime', release },
    defaults: { 'schema:url': 'suppress' },
  };
  expect(created.body).toEqual({ context: expectedContext });

  const read = await call('GET', `/v1/contexts/${contextId}`);
  expect(read.response.status).toBe(200);
  expect(read.body).toEqual({ context: expectedContext });
  const globalContext = await call('GET', `/v1/contexts/${GLOBAL_CONTEXT}`);
  expect(globalContext.response.status).toBe(200);
  expect(globalContext.body.context).toEqual({
    id: GLOBAL_CONTEXT,
    kind: 'global',
    labels: { en: 'Global' },
    settings: null,
    defaults: {},
  });
  const withoutSettings = await createContext();
  expect(withoutSettings.response.status).toBe(201);
  expect(withoutSettings.body.context.settings).toBeNull();
  expect(withoutSettings.body.context.defaults).toEqual({});
  const global = await view(subject.id);
  expect(global.statements['schema:url']).toHaveLength(1);
  const suppressed = await view(subject.id, contextId);
  expect(suppressed.statements['schema:url']).toBeUndefined();
  expect(suppressed.resolution).toEqual({ 'schema:url': 'suppressed' });
  const editorSuppressed = await view(subject.id, contextId, true);
  expect({ statements: editorSuppressed.statements, resolution: editorSuppressed.resolution }).toEqual({
    statements: suppressed.statements,
    resolution: suppressed.resolution,
  });
  expect((await listed(subject.id, 'schema:url')).candidates[0].rank).toBe('normal');
  expect((await listed(subject.id, 'schema:url', contextId)).candidates[0].rank).toBeNull();

  const inherited = await call('POST', `/v1/subjects/${subject.id}:adopt`, {
    authenticated: true,
    key: key(),
    body: { context: contextId, property: 'schema:url', mode: 'inherit', selection: [], expected_head: null },
  });
  expect(inherited.response.status).toBe(200);
  expect((await view(subject.id, contextId)).statements['schema:url']).toEqual(global.statements['schema:url']);
  expect((await view(subject.id, contextId)).resolution).toEqual({});
  expect((await listed(subject.id, 'schema:url', contextId)).candidates[0].rank).toBe('normal');

  const proposed = await call('POST', `/v1/subjects/${subject.id}/candidates`, {
    authenticated: true,
    key: key(),
    body: {
      statement: {
        ...statement('schema:url', 'https://example.org/adopted'),
        references: [{ parts: [statement('schema:url', 'https://example.org/source')] }],
      },
    },
  });
  expect(proposed.response.status).toBe(201);
  const accepted = await call('POST', `/v1/subjects/${subject.id}/candidates/${proposed.body.candidate}:accept`, {
    authenticated: true,
    key: key(),
    body: { context: contextId, expected_head: null },
  });
  expect(accepted.response.status).toBe(200);
  const replaced = await call('POST', `/v1/subjects/${subject.id}:adopt`, {
    authenticated: true,
    key: key(),
    body: {
      context: contextId,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate: proposed.body.candidate, rank: 'normal' }],
      expected_head: 1,
    },
  });
  expect(replaced.response.status).toBe(200);
  const adopted = await view(subject.id, contextId);
  expect(adopted.statements['schema:url'].map((fact: any) => fact.value.content)).toEqual([
    'https://example.org/adopted',
  ]);
  const editorAdopted = await view(subject.id, contextId, true);
  expect({ statements: editorAdopted.statements, resolution: editorAdopted.resolution }).toEqual({
    statements: adopted.statements,
    resolution: adopted.resolution,
  });
});

test('a Context keeps its settings snapshot when a later release changes them', async () => {
  const oldRelease = await activateSettings('anime', 'suppress');
  const subject = await createSubject('Pinned Context defaults');
  const existing = await createContext('anime');
  expect(existing.response.status).toBe(201);
  const contextId = existing.body.context.id as string;
  const before = await view(subject.id, contextId);
  expect(before.resolution).toEqual({ 'schema:url': 'suppressed' });

  const newRelease = await activateSettings('anime', 'inherit');
  expect(newRelease).not.toBe(oldRelease);
  const existingRead = await call('GET', `/v1/contexts/${contextId}`);
  expect(existingRead.response.status).toBe(200);
  expect(existingRead.body.context).toEqual(existing.body.context);
  expect(existingRead.body.context.settings).toEqual({ id: 'anime', release: oldRelease });
  expect(existingRead.body.context.defaults).toEqual({ 'schema:url': 'suppress' });
  expect(await view(subject.id, contextId)).toEqual(before);

  const after = await createContext('anime');
  expect(after.response.status).toBe(201);
  expect(after.body.context.settings).toEqual({ id: 'anime', release: newRelease });
  expect(after.body.context.defaults).toEqual({ 'schema:url': 'inherit' });
  expect((await view(subject.id, after.body.context.id)).statements['schema:url']).toHaveLength(1);
});

test('an unknown settings id is refused and nothing is written', async () => {
  await activateSettings('anime', 'suppress');
  const before = await contexts();
  const idempotency = key();
  const first = await createContext('missing', idempotency);
  expect(first.response.status).toBe(400);
  expect(first.body).toMatchObject({
    code: 'invalid_request',
    effect_status: 'not_applied',
    errors: [{ pointer: '/settings', code: 'unsupported' }],
  });
  expect(await contexts()).toBe(before);
  const contextId = contextTarget(routeKey, accountId, idempotency.slice(1, -1)).id;
  const missing = await call('GET', `/v1/contexts/${contextId}`);
  expect(missing.response.status).toBe(404);
  const replay = await createContext('missing', idempotency);
  expect(replay.response.status).toBe(first.response.status);
  expect(replay.body).toMatchObject({
    code: first.body.code,
    effect_status: first.body.effect_status,
    errors: first.body.errors,
  });
  expect(await contexts()).toBe(before);
});
