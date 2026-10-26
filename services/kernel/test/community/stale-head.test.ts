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
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const issuer = 'https://stale-head.auth.test';
const audience = 'https://stale-head.api.test';
const password = 'stale head registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(113);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(114)]]) };

let admin: Pool;
let pool: Pool;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let governance: Person;
let spaceOwner: Person;
let realmOwner: Person;
let publicationOwner: Person;
let publisher: Person;
let hiddenOwner: Person;
let hiddenReader: Person;
let classificationContext: { id: string; kind: string; labels: Record<string, string> };

type Person = { accountId: string; bearer: string };
type Space = { spaceId: string; headRevisionId: string; title: string; summary: string };
type Realm = { realmId: string; headRevisionId: string; title: string };
type Publication = { realmId: string; subjectId: string; publicationId: string };
type Call = { bearer?: string; body?: unknown; key?: string; headers?: Record<string, string> };

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'stale-head-client', scope }),
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
  const result = await host.workflows.register({ key: name, handle: name, email: `${name}@stale.test`, password });
  return { accountId: result.accountId, bearer: await issue(`${name}@stale.test`, scope) };
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

async function grant(accountId: string, actions: string[]) {
  const body = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: accountId },
    actions: [...actions].sort(),
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

async function createSpace(actor: Person, title: string): Promise<Space> {
  const result = await call('POST', '/v1/spaces', {
    bearer: actor.bearer,
    key: crypto.randomUUID(),
    body: { title, summary: `${title} summary` },
  });
  expect(result.response.status).toBe(201);
  return result.value.space as Space;
}

async function createRealm(actor: Person, spaceId: string, visibility: 'public' | 'protected', title: string) {
  const result = await call('POST', '/v1/realms', {
    bearer: actor.bearer,
    key: crypto.randomUUID(),
    body: {
      spaceId,
      title,
      summary: `${title} summary`,
      visibility,
      contextId: classificationContext.id,
    },
  });
  expect(result.response.status).toBe(201);
  return result.value.realm as Realm;
}

async function subject(actor: Person) {
  const result = await call('POST', '/v1/subjects', {
    bearer: actor.bearer,
    key: crypto.randomUUID(),
    body: { type: 'schema:Book', labels: { en: 'Stale head subject' } },
  });
  expect(result.response.status).toBe(201);
  return (result.value.subject as { id: string }).id;
}

async function grantModerator(realm: Realm, actor: Person) {
  const body = {
    resource: { route: routeOf(realm.realmId)!, id: realm.realmId },
    subject: { kind: 'account', id: actor.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  };
  const result = await call('POST', '/v1/roleGrants', {
    bearer: publicationOwner.bearer,
    key: crypto.randomUUID(),
    body,
  });
  expect(result.response.status).toBe(201);
  expect(result.value).toEqual({ grant: body });
}

async function snapshot() {
  const result = await admin.query(`SELECT
    (SELECT count(*)::integer FROM community.space) AS spaces,
    (SELECT count(*)::integer FROM community.space_revision) AS space_revisions,
    (SELECT count(*)::integer FROM community.realm) AS realms,
    (SELECT count(*)::integer FROM community.realm_revision) AS realm_revisions,
    (SELECT count(*)::integer FROM community.publication) AS publications,
    (SELECT count(*)::integer FROM community.publication_head) AS publication_heads,
    (SELECT count(*)::integer FROM access.resource_initialization) AS initialized,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM access.resource_grant) AS grants,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events,
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
  pool = createPool(url);
  pool.options.max = 1;
  authDatabaseName = `stale_head_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'stale-head',
  };
  const limiter = createWriteRateLimiter({
    secret: 'stale-head-private-write-rate-secret-32bytes',
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
    secret: 'stale-head-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(115),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'stale-head-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'stale-head-client', firstParty: true, scopes });
  await host.start();
  governance = await person('stale_governance', scopes);
  spaceOwner = await person('stale_space_owner', scopes);
  realmOwner = await person('stale_realm_owner', scopes);
  publicationOwner = await person('stale_publication_owner', scopes);
  publisher = await person('stale_publisher', scopes);
  hiddenOwner = await person('stale_hidden_owner', scopes);
  hiddenReader = await person('stale_hidden_reader', scopes);
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
  await grant(spaceOwner.accountId, ['space:create']);
  await grant(realmOwner.accountId, ['space:create', 'realm:create']);
  await grant(publicationOwner.accountId, ['context:create', 'realm:create', 'space:create', 'subject:create']);
  await grant(hiddenOwner.accountId, ['realm:create', 'space:create']);
  const context = await call('POST', '/v1/contexts', {
    bearer: publicationOwner.bearer,
    key: crypto.randomUUID(),
    body: { labels: { en: 'Stale head classification' } },
  });
  expect(context.response.status).toBe(201);
  classificationContext = context.value.context as typeof classificationContext;
}, 60_000);

afterAll(async () => {
  await host?.stop();
  if (authDatabaseName) await dropTestDatabase(admin!, authDatabaseName);
  await pool?.end();
  await admin?.end();
});

test.serial('authorized Space, Realm and publication commands reject only a stale head with 412', async () => {
  const space = await createSpace(spaceOwner, 'Stale Space');
  const movedSpace = await call('PATCH', `/v1/spaces/${space.spaceId}`, {
    bearer: spaceOwner.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(space.headRevisionId) },
    body: { title: 'Current Space title' },
  });
  expect(movedSpace.response.status).toBe(200);
  const currentSpace = movedSpace.value.space as Space;
  const beforeStaleSpace = await snapshot();
  const staleSpace = await call('PATCH', `/v1/spaces/${space.spaceId}`, {
    bearer: spaceOwner.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(space.headRevisionId) },
    body: { title: 'Stale Space title' },
  });
  expect(staleSpace.response.status).toBe(412);
  expect(staleSpace.value).toMatchObject({ code: 'precondition_failed', status: 412, effect_status: 'not_applied' });
  expect(staleSpace.value).not.toHaveProperty('space');
  expect(JSON.stringify(staleSpace.value)).not.toContain('Stale Space title');
  expect(JSON.stringify(staleSpace.value)).not.toContain(currentSpace.headRevisionId);
  expect(await snapshot()).toEqual(beforeStaleSpace);

  const realmSpace = await createSpace(realmOwner, 'Stale Realm host');
  const realm = await createRealm(realmOwner, realmSpace.spaceId, 'public', 'Stale Realm');
  const movedRealm = await call('PATCH', `/v1/realms/${realm.realmId}`, {
    bearer: realmOwner.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
    body: { title: 'Current Realm title' },
  });
  expect(movedRealm.response.status).toBe(200);
  const currentRealm = movedRealm.value.realm as Realm;
  const beforeStaleRealm = await snapshot();
  const staleRealm = await call('PATCH', `/v1/realms/${realm.realmId}`, {
    bearer: realmOwner.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
    body: { title: 'Stale Realm title' },
  });
  expect(staleRealm.response.status).toBe(412);
  expect(staleRealm.value).toMatchObject({ code: 'precondition_failed', status: 412, effect_status: 'not_applied' });
  expect(staleRealm.value).not.toHaveProperty('realm');
  expect(JSON.stringify(staleRealm.value)).not.toContain('Stale Realm title');
  expect(JSON.stringify(staleRealm.value)).not.toContain(currentRealm.headRevisionId);
  expect(await snapshot()).toEqual(beforeStaleRealm);

  const publicationSpace = await createSpace(publicationOwner, 'Stale Publication host');
  const publicationRealm = await createRealm(
    publicationOwner,
    publicationSpace.spaceId,
    'public',
    'Stale Publication Realm',
  );
  await grantModerator(publicationRealm, publisher);
  const subjectId = await subject(publicationOwner);
  const path = `/v1/realms/${publicationRealm.realmId}/publications`;
  const adopted = await call('POST', path, {
    bearer: publisher.bearer,
    key: crypto.randomUUID(),
    body: { subjectId },
  });
  expect(adopted.response.status).toBe(201);
  const firstHead = adopted.value.publication as Publication;
  const withdrawn = await call('POST', `${path}/${subjectId}:withdraw`, {
    bearer: publisher.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(firstHead.publicationId) },
  });
  expect(withdrawn.response.status).toBe(200);
  const currentPublication = withdrawn.value.publication as Publication;
  const beforeStalePublication = await snapshot();
  const stalePublication = await call('POST', `${path}/${subjectId}:reject`, {
    bearer: publisher.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(firstHead.publicationId) },
  });
  expect(stalePublication.response.status).toBe(412);
  expect(stalePublication.value).toMatchObject({
    code: 'precondition_failed',
    status: 412,
    effect_status: 'not_applied',
  });
  expect(stalePublication.value).not.toHaveProperty('publication');
  expect(JSON.stringify(stalePublication.value)).not.toContain(currentPublication.publicationId);
  expect(await snapshot()).toEqual(beforeStalePublication);

  const hiddenSpace = await createSpace(hiddenOwner, 'Hidden Realm host');
  const hiddenRealm = await createRealm(hiddenOwner, hiddenSpace.spaceId, 'protected', 'Hidden Realm');
  const hidden = await call('GET', `/v1/realms/${hiddenRealm.realmId}`, { bearer: hiddenReader.bearer });
  const unknown = await call('GET', `/v1/realms/${newId(31)}`, { bearer: hiddenReader.bearer });
  expect(hidden.response.status).toBe(404);
  expect(unknown.response.status).toBe(404);
  expect(withoutRequest(hidden.value)).toEqual(withoutRequest(unknown.value));
});
