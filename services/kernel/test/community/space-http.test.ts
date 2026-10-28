import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER, SESSION_HEADER } from '../../src/http/request.ts';
import { newId } from '../../src/route/route.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const issuer = 'https://space-http.auth.test';
const audience = 'https://space-http.api.test';
const password = 'space http registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(83);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(84)]]) };
const grantKey = 'space-http-global-create-grant';

let admin: Pool;
let pool: Pool;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let governance: { accountId: string; bearer: string };
let creator: { accountId: string; bearer: string };
let unrelated: { accountId: string; bearer: string };

type Call = {
  bearer?: string;
  body?: unknown;
  key?: string;
  headers?: Record<string, string>;
};

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'space-http-client', scope }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function person(name: string, scope: string[]) {
  const result = await host.workflows.register({ key: name, handle: name, email: `${name}@space.test`, password });
  return { accountId: result.accountId, bearer: await issue(`${name}@space.test`, scope) };
}

async function call(method: string, path: string, options: Call = {}) {
  const headers = new Headers(options.headers);
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return { response, value: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function snapshot() {
  const result = await admin.query(`SELECT
    (SELECT count(*)::integer FROM community.space) AS spaces,
    (SELECT count(*)::integer FROM community.space_revision) AS revisions,
    (SELECT count(*)::integer FROM access.resource_initialization) AS initialized,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM access.resource_grant) AS grants,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events,
    (SELECT count(*)::integer FROM editorial.write_basis) AS bases,
    (SELECT coalesce(sum(position), 0)::text FROM core.partition) AS position`);
  return result.rows[0];
}

function withoutRequest(value: Record<string, unknown>) {
  const { request_id: _requestId, ...rest } = value;
  return rest;
}

const createGrant = () => ({
  resource: PLATFORM_RESOURCE,
  subject: { kind: 'account' as const, id: creator.accountId },
  actions: ['space:create'],
  valid: '(,)',
});

async function grantCreate() {
  const granted = await call('POST', '/v1/grants', {
    bearer: governance.bearer,
    key: grantKey,
    body: createGrant(),
  });
  expect(granted.response.status).toBe(201);
  expect(granted.value).toEqual({ grant: createGrant() });
  return granted;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  admin = new Pool({ connectionString: url });
  pool = createPool(url);
  pool.options.max = 1;
  authDatabaseName = `space_http_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'space-http',
  };
  const limiter = createWriteRateLimiter({
    secret: 'space-http-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100000, seconds: 86400 } },
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
    }),
  });
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }),
    writeRate: limiter,
  });
  // Auth refuses to register the mounted media completion scope on this client.
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
  const { ports: registrationPorts } = createRegistrationPorts({
    pool,
    authPool,
    routeKey,
    referenceKeys: tokens,
  });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'space-http-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(85),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'space-http-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'space-http-client', firstParty: true, scopes });
  await host.start();
  governance = await person('space_governance', scopes);
  creator = await person('space_creator', scopes);
  unrelated = await person('space_unrelated', scopes);
  await bootstrapGovernance(pool, governance.accountId);
}, 60_000);

afterAll(async () => {
  await host?.stop();
  if (authDatabaseName) await dropTestDatabase(admin!, authDatabaseName);
  await pool?.end();
  await admin?.end();
});

test.serial('anonymous reads a Space and cannot create or update one', async () => {
  await grantCreate();
  const title = 'Visible community';
  const summary = 'A public summary';
  const created = await call('POST', '/v1/spaces', {
    bearer: creator.bearer,
    key: crypto.randomUUID(),
    body: { title, summary },
  });
  expect(created.response.status).toBe(201);
  const space = created.value.space as Record<string, unknown>;
  expect(space).toMatchObject({
    state: 'active',
    title,
    summary,
    creator: creator.accountId,
    author: creator.accountId,
    predecessor: null,
    realmId: null,
  });
  const head = space.headRevisionId;
  expect(created.response.headers.get('etag')).toBe(JSON.stringify(head));
  expect(created.response.headers.get('location')).toBe(`/v1/spaces/${space.spaceId}`);
  expect(
    decodeSession(tokens, `account:${creator.accountId}`, created.response.headers.get(SESSION_HEADER)!),
  ).toHaveLength(1);

  const before = await snapshot();
  const read = await call('GET', `/v1/spaces/${space.spaceId}`);
  expect(read.response.status).toBe(200);
  expect(read.value).toEqual({ space });
  expect(read.response.headers.get('etag')).toBe(JSON.stringify(head));
  expect(read.response.headers.get(SESSION_HEADER)).toBeNull();
  expect(await snapshot()).toEqual(before);

  const deniedCreate = await call('POST', '/v1/spaces', {
    key: crypto.randomUUID(),
    body: { title: 'Anonymous title', summary: 'Anonymous summary' },
  });
  expect(deniedCreate.response.status).toBe(401);
  expect(deniedCreate.value).toMatchObject({ code: 'authentication_required', effect_status: 'not_applied' });
  expect(deniedCreate.value).not.toHaveProperty('space');
  expect(JSON.stringify(deniedCreate.value)).not.toContain('Anonymous title');
  expect(await snapshot()).toEqual(before);

  const deniedUpdate = await call('PATCH', `/v1/spaces/${space.spaceId}`, {
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(head) },
    body: { title: 'Anonymous edit' },
  });
  expect(deniedUpdate.response.status).toBe(401);
  expect(deniedUpdate.value).toMatchObject({ code: 'authentication_required', effect_status: 'not_applied' });
  expect(deniedUpdate.value).not.toHaveProperty('space');
  expect(JSON.stringify(deniedUpdate.value)).not.toContain('Anonymous edit');
  expect(await snapshot()).toEqual(before);

  const missing = await call('GET', '/v1/spaces/not-a-space');
  const unknownId = newId(4);
  const unknown = await call('GET', `/v1/spaces/${unknownId}`);
  expect(missing.response.status).toBe(404);
  expect(unknown.response.status).toBe(404);
  expect(missing.value).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
  expect(missing.value).not.toHaveProperty('space');
  expect(unknown.value).not.toHaveProperty('space');
  expect(withoutRequest(missing.value)).toEqual(withoutRequest(unknown.value));
  expect(JSON.stringify(missing.value)).not.toContain(String(space.spaceId));
  expect(await snapshot()).toEqual(before);
});

test.serial(
  'an account granted space:create on the Global Context by platform governance creates a Space, reads it with its head and updates it with the current head',
  async () => {
    const granted = await grantCreate();
    expect(granted.value).toEqual({
      grant: {
        resource: { route: 0, id: '00000000-0000-8000-8000-000000000000' },
        subject: { kind: 'account', id: creator.accountId },
        actions: ['space:create'],
        valid: '(,)',
      },
    });
    const title = 'Governed community';
    const summary = 'Created from the Global Context grant';
    const created = await call('POST', '/v1/spaces', {
      bearer: creator.bearer,
      key: crypto.randomUUID(),
      body: { title, summary },
    });
    expect(created.response.status).toBe(201);
    const space = created.value.space as {
      spaceId: string;
      headRevisionId: string;
      title: string;
      summary: string;
      state: string;
      creator: string;
      predecessor: string | null;
    };
    expect(space).toMatchObject({ state: 'active', title, summary, creator: creator.accountId, predecessor: null });
    const etag = created.response.headers.get('etag');
    expect(etag).toBe(JSON.stringify(space.headRevisionId));
    expect(created.response.headers.get('location')).toBe(`/v1/spaces/${space.spaceId}`);

    const read = await call('GET', `/v1/spaces/${space.spaceId}`, { bearer: creator.bearer });
    expect(read.response.status).toBe(200);
    expect(read.value).toEqual(created.value);
    expect(read.response.headers.get('etag')).toBe(etag);

    const updatedTitle = 'Governed community renamed';
    const updated = await call('PATCH', `/v1/spaces/${space.spaceId}`, {
      bearer: creator.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': etag! },
      body: { title: updatedTitle },
    });
    expect(updated.response.status).toBe(200);
    const next = updated.value.space as typeof space;
    expect(next).toMatchObject({
      spaceId: space.spaceId,
      title: updatedTitle,
      realmId: null,
      summary,
      predecessor: space.headRevisionId,
      creator: creator.accountId,
      author: creator.accountId,
      state: 'active',
    });
    expect(next.headRevisionId).not.toBe(space.headRevisionId);
    expect(updated.response.headers.get('etag')).toBe(JSON.stringify(next.headRevisionId));
    expect(
      decodeSession(tokens, `account:${creator.accountId}`, updated.response.headers.get(SESSION_HEADER)!),
    ).toHaveLength(1);

    const confirmed = await call('GET', `/v1/spaces/${space.spaceId}`);
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.value).toEqual(updated.value);
    expect(confirmed.response.headers.get('etag')).toBe(JSON.stringify(next.headRevisionId));
  },
);

test.serial(
  'Space creation without a grant, non-owner updates and stale-head updates fail without writes or metadata in errors',
  async () => {
    // account:suspend is not mounted on this kernel, so this file does not suspend an account.
    await grantCreate();
    const title = 'Closed community';
    const summary = 'Only the owner may write';
    const created = await call('POST', '/v1/spaces', {
      bearer: creator.bearer,
      key: crypto.randomUUID(),
      body: { title, summary },
    });
    expect(created.response.status).toBe(201);
    const space = created.value.space as { spaceId: string; headRevisionId: string; title: string; summary: string };
    const etag = created.response.headers.get('etag')!;

    const beforeDenied = await snapshot();
    const ungranted = await call('POST', '/v1/spaces', {
      bearer: unrelated.bearer,
      key: crypto.randomUUID(),
      body: { title: 'Unrelated title', summary: 'Unrelated summary' },
    });
    expect(ungranted.response.status).toBe(403);
    expect(ungranted.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    expect(ungranted.value).not.toHaveProperty('space');
    expect(JSON.stringify(ungranted.value)).not.toContain('Unrelated title');
    expect(await snapshot()).toEqual(beforeDenied);

    const readable = await call('GET', `/v1/spaces/${space.spaceId}`, { bearer: unrelated.bearer });
    expect(readable.response.status).toBe(200);
    expect(readable.value).toEqual(created.value);
    expect(await snapshot()).toEqual(beforeDenied);

    const managed = await call('PATCH', `/v1/spaces/${space.spaceId}`, {
      bearer: unrelated.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': etag },
      body: { title: 'Unrelated edit' },
    });
    expect(managed.response.status).toBe(403);
    expect(managed.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    expect(managed.value).not.toHaveProperty('space');
    expect(JSON.stringify(managed.value)).not.toContain('Unrelated edit');
    expect(JSON.stringify(managed.value)).not.toContain(space.headRevisionId);
    expect(await snapshot()).toEqual(beforeDenied);

    const moved = await call('PATCH', `/v1/spaces/${space.spaceId}`, {
      bearer: creator.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': etag },
      body: { summary: 'Owner moved the head' },
    });
    expect(moved.response.status).toBe(200);
    const current = moved.value.space as { headRevisionId: string; title: string };
    expect(current.headRevisionId).not.toBe(space.headRevisionId);
    expect(current.title).toBe(title);

    const beforeStale = await snapshot();
    const stale = await call('PATCH', `/v1/spaces/${space.spaceId}`, {
      bearer: creator.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': etag },
      body: { title: 'Stale leaked title', summary: 'Stale leaked summary' },
    });
    expect(stale.response.status).toBe(412);
    expect(stale.value).toMatchObject({ code: 'precondition_failed', effect_status: 'not_applied' });
    expect(stale.value).not.toHaveProperty('space');
    const staleText = JSON.stringify(stale.value);
    expect(staleText).not.toContain('Stale leaked title');
    expect(staleText).not.toContain('Stale leaked summary');
    expect(staleText).not.toContain(current.headRevisionId);
    expect(staleText).not.toContain('head has changed');
    expect(await snapshot()).toEqual(beforeStale);
  },
);
