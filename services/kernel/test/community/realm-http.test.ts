import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
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
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const issuer = 'https://realm-http.auth.test';
const audience = 'https://realm-http.api.test';
const password = 'realm http registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(93);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(94)]]) };

let admin: Pool;
let pool: Pool;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let governance: Person;
let owner: Person;
let unrelated: Person;
let contextAuthor: Person;
let classificationContext: { id: string; kind: string; labels: Record<string, string> };
let protectedRealm: Realm;

type Person = { accountId: string; bearer: string };
type Realm = {
  realmId: string;
  spaceId: string;
  state: string;
  visibility: string;
  contextId: string;
  headRevisionId: string;
  createdAt: string;
  creator: string;
  predecessor: string | null;
  title: string;
  summary: string;
  revisionCreatedAt: string;
  author: string;
};
type Call = { bearer?: string; body?: unknown; key?: string; headers?: Record<string, string> };

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'realm-http-client', scope }),
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

async function person(name: string, scope: string[]): Promise<Person> {
  const result = await host.workflows.register({ key: name, handle: name, email: `${name}@realm.test`, password });
  return { accountId: result.accountId, bearer: await issue(`${name}@realm.test`, scope) };
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
  let value: Record<string, unknown> = {};
  try {
    value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Keep missing-route failures readable while this contract is introduced.
  }
  return { response, value };
}

async function grant(accountId: string, actions: string[]) {
  const body = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: accountId },
    actions,
    valid: '(,)',
  };
  const result = await call('POST', '/v1/grants', {
    bearer: governance.bearer,
    key: crypto.randomUUID(),
    body,
  });
  expect(result.response.status).toBe(201);
  expect(result.value).toEqual({ grant: body });
}

async function createSpace(title: string) {
  const result = await call('POST', '/v1/spaces', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { title, summary: `${title} summary` },
  });
  expect(result.response.status).toBe(201);
  return result.value.space as { spaceId: string; headRevisionId: string };
}

async function createRealm(
  spaceId: string,
  visibility: 'public' | 'protected',
  contextId = classificationContext.id,
  title = `${visibility} Realm`,
) {
  return call('POST', '/v1/realms', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { spaceId, title, summary: `${title} summary`, visibility, contextId },
  });
}

async function snapshot() {
  const result = await admin.query(`SELECT
    (SELECT count(*)::integer FROM community.space) AS spaces,
    (SELECT count(*)::integer FROM community.realm) AS realms,
    (SELECT count(*)::integer FROM community.realm_revision) AS revisions,
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

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  admin = new Pool({ connectionString: url });
  pool = createPool(url, { connectionTimeoutMillis: 10_000 });
  pool.options.max = 1;
  authDatabaseName = `realm_http_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-http',
  };
  const limiter = createWriteRateLimiter({
    secret: 'realm-http-private-write-rate-secret-32bytes',
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
    secret: 'realm-http-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(95),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'realm-http-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'realm-http-client', firstParty: true, scopes });
  await host.start();
  governance = await person('realm_governance', scopes);
  owner = await person('realm_owner', scopes);
  unrelated = await person('realm_unrelated', scopes);
  contextAuthor = await person('realm_context_author', scopes);
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
}, 60_000);

afterAll(async () => {
  await host?.stop();
  authPool?.on('error', (error) => {
    if ('code' in error && error.code === '57P01') return;
    throw error;
  });
  if (authDatabaseName) await dropTestDatabase(admin!, authDatabaseName);
  await pool?.end();
  await admin?.end();
});

test.serial(
  'a Space owner granted realm:create creates a protected Realm with a classification Context and reads its head',
  async () => {
    await grant(owner.accountId, ['realm:create', 'space:create']);
    await grant(contextAuthor.accountId, ['context:create']);

    const context = await call('POST', '/v1/contexts', {
      bearer: contextAuthor.bearer,
      key: crypto.randomUUID(),
      body: { labels: { en: 'Editorial classification' } },
    });
    expect(context.response.status).toBe(201);
    classificationContext = (context.value as { context: typeof classificationContext }).context;
    expect(typeof classificationContext.id).toBe('string');
    expect(classificationContext.kind).toBe('community');
    expect(classificationContext.labels).toEqual({ en: 'Editorial classification' });

    const space = await createSpace('Realm host');
    const created = await createRealm(space.spaceId, 'protected', classificationContext.id, 'Owner Realm');
    expect(created.response.status).toBe(201);
    protectedRealm = created.value.realm as Realm;
    expect(typeof protectedRealm.realmId).toBe('string');
    expect(protectedRealm.spaceId).toBe(space.spaceId);
    expect(protectedRealm.state).toBe('active');
    expect(protectedRealm.visibility).toBe('protected');
    expect(protectedRealm.contextId).toBe(classificationContext.id);
    expect(protectedRealm.title).toBe('Owner Realm');
    expect(protectedRealm.summary).toBe('Owner Realm summary');
    expect(protectedRealm.creator).toBe(owner.accountId);
    expect(protectedRealm.author).toBe(owner.accountId);
    expect(protectedRealm.predecessor).toBeNull();
    expect(typeof protectedRealm.headRevisionId).toBe('string');
    expect(created.response.headers.get('location')).toBe(`/v1/realms/${protectedRealm.realmId}`);
    expect(created.response.headers.get('etag')).toBe(JSON.stringify(protectedRealm.headRevisionId));

    const read = await call('GET', `/v1/realms/${protectedRealm.realmId}`, { bearer: owner.bearer });
    expect(read.response.status).toBe(200);
    expect(read.value).toEqual({ realm: protectedRealm });
    expect(read.response.headers.get('etag')).toBe(JSON.stringify(protectedRealm.headRevisionId));
  },
);

test.serial(
  'anonymous reads a public Realm, while a protected Realm is the same 404 as a missing one for anonymous and for a non-member',
  async () => {
    const publicSpace = await createSpace('Public Realm host');
    const created = await createRealm(publicSpace.spaceId, 'public', classificationContext.id, 'Public Realm');
    expect(created.response.status).toBe(201);
    const realm = created.value.realm as Realm;

    const anonymous = await call('GET', `/v1/realms/${realm.realmId}`);
    expect(anonymous.response.status).toBe(200);
    expect(anonymous.value).toEqual({ realm });
    expect(anonymous.response.headers.get('etag')).toBe(JSON.stringify(realm.headRevisionId));

    const missing = await call('GET', `/v1/realms/${newId(27)}`);
    const hiddenAnonymous = await call('GET', `/v1/realms/${protectedRealm.realmId}`);
    const hiddenMemberless = await call('GET', `/v1/realms/${protectedRealm.realmId}`, { bearer: unrelated.bearer });
    for (const hidden of [missing, hiddenAnonymous, hiddenMemberless]) {
      expect(hidden.response.status).toBe(404);
      expect(hidden.value).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
      expect(hidden.value).not.toHaveProperty('realm');
    }
    expect(withoutRequest(hiddenAnonymous.value)).toEqual(withoutRequest(missing.value));
    expect(withoutRequest(hiddenMemberless.value)).toEqual(withoutRequest(missing.value));
  },
);

test.serial(
  'second Realm creation, non-owner updates, an unknown Context and stale-head updates are denied without writes',
  async () => {
    // account:suspend is not mounted on this kernel, so this file leaves that case out.
    let before = await snapshot();
    const second = await createRealm(protectedRealm.spaceId, 'public', classificationContext.id, 'Second Realm');
    expect(second.response.status).toBe(403);
    expect(second.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    expect(second.value).not.toHaveProperty('realm');
    expect(await snapshot()).toEqual(before);

    before = await snapshot();
    const unauthorized = await call('PATCH', `/v1/realms/${protectedRealm.realmId}`, {
      bearer: unrelated.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': JSON.stringify(protectedRealm.headRevisionId) },
      body: { title: 'Unrelated edit' },
    });
    expect(unauthorized.response.status).toBe(403);
    expect(unauthorized.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    expect(unauthorized.value).not.toHaveProperty('realm');
    expect(JSON.stringify(unauthorized.value)).not.toContain('Unrelated edit');
    expect(await snapshot()).toEqual(before);

    const unreadableSpace = await createSpace('Unreadable Context host');
    before = await snapshot();
    const unreadable = await createRealm(unreadableSpace.spaceId, 'public', newId(28), 'Unreadable Context Realm');
    expect(unreadable.response.status).toBe(403);
    expect(unreadable.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    expect(unreadable.value).not.toHaveProperty('realm');
    expect(await snapshot()).toEqual(before);

    const current = await call('PATCH', `/v1/realms/${protectedRealm.realmId}`, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': JSON.stringify(protectedRealm.headRevisionId) },
      body: { summary: 'Owner moved the head' },
    });
    expect(current.response.status).toBe(200);
    const moved = (current.value as { realm: Realm }).realm;
    expect(moved.headRevisionId).not.toBe(protectedRealm.headRevisionId);
    expect(moved.predecessor).toBe(protectedRealm.headRevisionId);

    before = await snapshot();
    const stale = await call('PATCH', `/v1/realms/${protectedRealm.realmId}`, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': JSON.stringify(protectedRealm.headRevisionId) },
      body: { title: 'Stale leaked title' },
    });
    expect(stale.response.status).toBe(412);
    expect(stale.value).toMatchObject({ code: 'precondition_failed', effect_status: 'not_applied' });
    expect(stale.value).not.toHaveProperty('realm');
    expect(JSON.stringify(stale.value)).not.toContain('Stale leaked title');
    expect(JSON.stringify(stale.value)).not.toContain(moved.headRevisionId);
    expect(await snapshot()).toEqual(before);
  },
);
