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

const issuer = 'https://realm-votes-http.auth.test';
const audience = 'https://realm-votes-http.api.test';
const password = 'realm votes http registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(96);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(97)]]) };

let admin: Pool;
let pool: Pool;
let authPool: Pool;
const authConnectionsClosed: Promise<void>[] = [];
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let governance: Person;
let contextAuthor: Person;
let reader: Person;
let manager: Person;
let refuser: Person;
let outsider: Person;
let classificationContext: { id: string };

type Person = { accountId: string; bearer: string };
type Realm = {
  realmId: string;
  spaceId: string;
  state: string;
  visibility: string;
  contextId: string;
  boardSchemeId: string | null;
  headRevisionId: string;
  createdAt: string;
  creator: string;
  predecessor: string | null;
  title: string;
  summary: string;
  revisionCreatedAt: string;
  author: string;
  votes: Record<string, number>;
};
type Call = { bearer?: string; body?: unknown; key?: string; headers?: Record<string, string> };

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'realm-votes-http-client', scope }),
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
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@realm-votes-http.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@realm-votes-http.test`, scope) };
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
    value = { raw: text };
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

async function createSpace(holder: Person, title: string) {
  const result = await call('POST', '/v1/spaces', {
    bearer: holder.bearer,
    key: crypto.randomUUID(),
    body: { title, summary: `${title} summary` },
  });
  expect(result.response.status).toBe(201);
  return result.value.space as { spaceId: string };
}

function realmInput(spaceId: string, title: string, votes?: Record<string, number>) {
  return {
    spaceId,
    title,
    summary: `${title} summary`,
    visibility: 'public' as const,
    contextId: classificationContext.id,
    ...(votes === undefined ? {} : { votes }),
  };
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

async function storedVotes(realmId: string, revisionId: string) {
  const realm = await admin.query<{ votes: unknown }>(`SELECT votes FROM community.realm WHERE realm_id = $1`, [
    realmId,
  ]);
  const revision = await admin.query<{ votes: unknown }>(
    `SELECT votes FROM community.realm_revision WHERE revision_id = $1`,
    [revisionId],
  );
  return { realm: realm.rows[0]?.votes, revision: revision.rows[0]?.votes };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  admin = new Pool({ connectionString: url });
  pool = createPool(url);
  pool.options.max = 1;
  authDatabaseName = `realm_votes_http_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  authPool.on('connect', (client) => {
    authConnectionsClosed.push(new Promise<void>((resolve) => client.connection.stream.once('close', () => resolve())));
  });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-votes-http',
  };
  const limiter = createWriteRateLimiter({
    secret: 'realm-votes-http-private-write-rate-secret-32b',
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
    secret: 'realm-votes-http-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(98),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'realm-votes-http-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'realm-votes-http-client', firstParty: true, scopes });
  await host.start();
  governance = await person('votes_http_governance', scopes);
  contextAuthor = await person('votes_http_context', scopes);
  reader = await person('votes_http_reader', scopes);
  manager = await person('votes_http_manager', scopes);
  refuser = await person('votes_http_refuser', scopes);
  outsider = await person('votes_http_outsider', scopes);
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
  await grant(contextAuthor.accountId, ['context:create']);
  const context = await call('POST', '/v1/contexts', {
    bearer: contextAuthor.bearer,
    key: crypto.randomUUID(),
    body: { labels: { en: 'Realm vote classification' } },
  });
  expect(context.response.status).toBe(201);
  classificationContext = (context.value as { context: { id: string } }).context;
}, 120_000);

afterAll(async () => {
  await host?.stop();
  if (!host) await authPool?.end();
  // pg.Pool.end resolves before idle sockets finish closing, and the Auth host releases its notification
  // client without awaiting it. Wait for every Auth socket to close so the forced drop cannot reach one.
  await Promise.all(authConnectionsClosed);
  if (authDatabaseName) await admin?.query(`DROP DATABASE IF EXISTS ${authDatabaseName} WITH (FORCE)`);
  await pool?.end();
  await admin?.end();
});

test.serial('a Realm read returns its votes', async () => {
  await grant(reader.accountId, ['realm:create', 'space:create']);
  const space = await createSpace(reader, 'Vote read host');
  const created = await call('POST', '/v1/realms', {
    bearer: reader.bearer,
    key: crypto.randomUUID(),
    body: realmInput(space.spaceId, 'Readable Realm'),
  });
  expect(created.response.status).toBe(201);
  const realm = created.value.realm as Realm;
  expect(realm.votes).toEqual({ upvote: 1, downvote: -1 });
  expect(created.response.headers.get('etag')).toBe(JSON.stringify(realm.headRevisionId));
  expect(await storedVotes(realm.realmId, realm.headRevisionId)).toEqual({
    realm: { upvote: 1, downvote: -1 },
    revision: { upvote: 1, downvote: -1 },
  });

  const owner = await call('GET', `/v1/realms/${realm.realmId}`, { bearer: reader.bearer });
  expect(owner.response.status).toBe(200);
  expect(owner.value).toEqual({ realm });
  expect(owner.response.headers.get('etag')).toBe(JSON.stringify(realm.headRevisionId));

  const anonymous = await call('GET', `/v1/realms/${realm.realmId}`);
  expect(anonymous.response.status).toBe(200);
  expect(anonymous.value).toEqual({
    realm: {
      realmId: realm.realmId,
      spaceId: realm.spaceId,
      state: realm.state,
      visibility: realm.visibility,
      contextId: realm.contextId,
      boardSchemeId: realm.boardSchemeId,
      headRevisionId: realm.headRevisionId,
      createdAt: realm.createdAt,
      creator: realm.creator,
      predecessor: realm.predecessor,
      title: realm.title,
      summary: realm.summary,
      revisionCreatedAt: realm.revisionCreatedAt,
      author: realm.author,
      votes: { upvote: 1, downvote: -1 },
    },
  });
});

test.serial(
  'a Realm manager sets votes at creation and changes them through the Realm update with If-Match, as a new revision',
  async () => {
    await grant(manager.accountId, ['realm:create', 'space:create']);
    const space = await createSpace(manager, 'Vote manage host');
    const created = await call('POST', '/v1/realms', {
      bearer: manager.bearer,
      key: crypto.randomUUID(),
      body: realmInput(space.spaceId, 'Managed Realm', { like: 1, sad: -1 }),
    });
    expect(created.response.status).toBe(201);
    const realm = created.value.realm as Realm;
    expect(realm.votes).toEqual({ like: 1, sad: -1 });
    expect(realm.predecessor).toBeNull();
    expect(await storedVotes(realm.realmId, realm.headRevisionId)).toEqual({
      realm: { like: 1, sad: -1 },
      revision: { like: 1, sad: -1 },
    });
    const createdEvent = await admin.query<{ data: unknown }>(
      `SELECT data FROM core.outbox WHERE subject = $1 AND type = 'com.rezics.community.realm.created.v1'`,
      [realm.realmId],
    );
    expect(createdEvent.rows.map((row) => row.data)).toEqual([
      { realmId: realm.realmId, revisionId: realm.headRevisionId },
    ]);

    const changed = await call('PATCH', `/v1/realms/${realm.realmId}`, {
      bearer: manager.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
      body: { votes: { upvote: -1, downvote: 1, insightful: 1 } },
    });
    expect(changed.response.status).toBe(200);
    const next = changed.value.realm as Realm;
    expect(next.headRevisionId).not.toBe(realm.headRevisionId);
    expect(next.predecessor).toBe(realm.headRevisionId);
    expect(next.title).toBe(realm.title);
    expect(next.summary).toBe(realm.summary);
    expect(next.votes).toEqual({ upvote: -1, downvote: 1, insightful: 1 });
    expect(changed.response.headers.get('etag')).toBe(JSON.stringify(next.headRevisionId));
    expect(await storedVotes(realm.realmId, realm.headRevisionId)).toEqual({
      realm: { upvote: -1, downvote: 1, insightful: 1 },
      revision: { like: 1, sad: -1 },
    });
    expect(await storedVotes(realm.realmId, next.headRevisionId)).toEqual({
      realm: { upvote: -1, downvote: 1, insightful: 1 },
      revision: { upvote: -1, downvote: 1, insightful: 1 },
    });

    const kept = await call('PATCH', `/v1/realms/${realm.realmId}`, {
      bearer: manager.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': JSON.stringify(next.headRevisionId) },
      body: { summary: 'Votes stay on the new head' },
    });
    expect(kept.response.status).toBe(200);
    const carried = kept.value.realm as Realm;
    expect(carried.headRevisionId).not.toBe(next.headRevisionId);
    expect(carried.predecessor).toBe(next.headRevisionId);
    expect(carried.summary).toBe('Votes stay on the new head');
    expect(carried.votes).toEqual({ upvote: -1, downvote: 1, insightful: 1 });
    expect(await storedVotes(realm.realmId, carried.headRevisionId)).toEqual({
      realm: { upvote: -1, downvote: 1, insightful: 1 },
      revision: { upvote: -1, downvote: 1, insightful: 1 },
    });

    const read = await call('GET', `/v1/realms/${realm.realmId}`, { bearer: manager.bearer });
    expect(read.response.status).toBe(200);
    expect(read.value).toEqual({ realm: carried });

    const updated = await admin.query<{ data: unknown }>(
      `SELECT data FROM core.outbox
       WHERE subject = $1 AND type = 'com.rezics.community.realm.updated.v1'
       ORDER BY position, event_seq`,
      [realm.realmId],
    );
    expect(updated.rows.map((row) => row.data)).toEqual([
      { realmId: realm.realmId, revisionId: next.headRevisionId },
      { realmId: realm.realmId, revisionId: carried.headRevisionId },
    ]);
  },
);

test.serial('invalid vote maps are refused and a non-manager cannot change them', async () => {
  await grant(refuser.accountId, ['realm:create', 'space:create']);
  const space = await createSpace(refuser, 'Vote refusal host');
  const invalid = [
    [],
    null,
    'upvote',
    1,
    true,
    { nope: 1 },
    { upvote: 0 },
    { upvote: 2 },
    { upvote: -2 },
    { upvote: 1.5 },
    { upvote: '1' },
    { upvote: true },
    { upvote: { weight: 1 } },
    { Upvote: 1 },
    { upvote: 1, extra: -1 },
  ];
  for (const votes of invalid) {
    const before = await snapshot();
    const refused = await call('POST', '/v1/realms', {
      bearer: refuser.bearer,
      key: crypto.randomUUID(),
      body: { ...realmInput(space.spaceId, 'Refused Realm'), votes },
    });
    expect(refused.response.status).toBe(400);
    expect(refused.value).toMatchObject({ code: 'invalid_request', status: 400, effect_status: 'not_applied' });
    expect(refused.value).not.toHaveProperty('realm');
    expect(await snapshot()).toEqual(before);
  }

  const created = await call('POST', '/v1/realms', {
    bearer: refuser.bearer,
    key: crypto.randomUUID(),
    body: realmInput(space.spaceId, 'Refusable Realm', { like: 1 }),
  });
  expect(created.response.status).toBe(201);
  const realm = created.value.realm as Realm;
  expect(realm.votes).toEqual({ like: 1 });

  for (const votes of invalid) {
    const before = await snapshot();
    const refused = await call('PATCH', `/v1/realms/${realm.realmId}`, {
      bearer: refuser.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
      body: { votes },
    });
    expect(refused.response.status).toBe(400);
    expect(refused.value).toMatchObject({ code: 'invalid_request', status: 400, effect_status: 'not_applied' });
    expect(refused.value).not.toHaveProperty('realm');
    expect(await snapshot()).toEqual(before);
  }

  const before = await snapshot();
  const denied = await call('PATCH', `/v1/realms/${realm.realmId}`, {
    bearer: outsider.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
    body: { votes: { insightful: -1 } },
  });
  expect(denied.response.status).toBe(403);
  expect(denied.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(denied.value).not.toHaveProperty('realm');
  expect(await snapshot()).toEqual(before);

  const read = await call('GET', `/v1/realms/${realm.realmId}`, { bearer: refuser.bearer });
  expect(read.response.status).toBe(200);
  expect((read.value.realm as Realm).headRevisionId).toBe(realm.headRevisionId);
  expect((read.value.realm as Realm).votes).toEqual({ like: 1 });
});
