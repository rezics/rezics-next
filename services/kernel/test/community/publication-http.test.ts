import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const issuer = 'https://publication-http.auth.test';
const audience = 'https://publication-http.api.test';
const password = 'publication http registration password with enough entropy';
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
let moderator: Person;
let classificationContext: { id: string; kind: string; labels: Record<string, string> };

type Person = { accountId: string; bearer: string };
type Realm = { realmId: string; headRevisionId: string };
type Head = {
  realmId: string;
  subjectId: string;
  publicationId: string;
  verdict: string;
  subjectRevisionId: null;
  publishedAt: string;
};
type Call = { bearer?: string; body?: unknown; key?: string; headers?: Record<string, string> };

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'publication-http-client', scope }),
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
    email: `${name}@publication.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@publication.test`, scope) };
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
    (SELECT count(*)::integer FROM community.publication) AS records,
    (SELECT jsonb_agg(p ORDER BY route, publication_id) FROM community.publication p) AS publications,
    (SELECT jsonb_agg(h ORDER BY realm_id, subject_id) FROM community.publication_head h) AS heads,
    (SELECT jsonb_agg(r ORDER BY route, realm_id) FROM community.realm r) AS realms,
    (SELECT count(*)::integer FROM community.realm_revision) AS revisions,
    (SELECT count(*)::integer FROM access.resource_initialization) AS initialized,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM access.resource_grant) AS grants,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events,
    (SELECT coalesce(sum(position), 0)::text FROM core.partition) AS position`);
  return result.rows[0];
}

async function accessSnapshot() {
  const result = await admin.query(`SELECT
    (SELECT jsonb_agg(g ORDER BY route, resource_id, subject_id, grant_role) FROM access.resource_role_grant g) AS roles,
    (SELECT jsonb_agg(g ORDER BY route, resource_id, subject_id, action) FROM access.resource_grant g) AS grants,
    (SELECT jsonb_agg(g ORDER BY route, resource_id) FROM access.resource_initialization g) AS initialized`);
  return result.rows[0];
}

async function subject() {
  const result = await call('POST', '/v1/subjects', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { type: 'schema:Book', labels: { en: 'Published book' } },
  });
  expect(result.response.status).toBe(201);
  return (result.value.subject as { id: string }).id;
}

async function fixture(visibility: 'public' | 'protected' = 'public') {
  const space = await createSpace('Publication host');
  const created = await createRealm(space.spaceId, visibility);
  expect(created.response.status).toBe(201);
  const realm = created.value.realm as Realm;
  return { realm, subjectId: await subject(), path: `/v1/realms/${realm.realmId}/publications` };
}

async function grantModerator(realm: Realm, accountId = moderator.accountId) {
  const body = {
    resource: { route: routeOf(realm.realmId)!, id: realm.realmId },
    subject: { kind: 'account', id: accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  };
  const result = await call('POST', '/v1/roleGrants', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body,
  });
  expect(result.response.status).toBe(201);
  expect(result.value).toEqual({ grant: body });
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
  authDatabaseName = `publication_http_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'publication-http',
  };
  const limiter = createWriteRateLimiter({
    secret: 'publication-http-private-write-rate-secret-32bytes',
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
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
  const provisioning = createProvisioningEvidenceVerifier({ database: authPool });
  const internal = createLifecycleInternals({
    pool,
    routeKey,
    provisioningEvidence: (evidence) => provisioning.resolve(evidence),
    recoveryEvidence: async () => null,
  });
  const registrationPorts = {
    ...internal,
    async createPending(input: Parameters<typeof internal.createPending>[0]) {
      const outcome = await internal.createPending(input);
      const pair = { accountId: input.accountId, reservationId: input.reservationId };
      if (!(await proofs.pendingReference(pair))) {
        const reference = await registration.createProvisioningReference({ input, outcome });
        if (!reference) throw new Error('Missing native registration reference');
        await proofs.recordPending({ ...pair, reference });
      }
      return outcome;
    },
    async provisioningReference(input: { accountId: string; reservationId: string }) {
      const reference = await proofs.pendingReference(input);
      if (!reference) throw new Error('Missing persisted registration reference');
      return reference;
    },
    provisioningEvidence: (input: { accountId: string; reservationId: string }) => proofs.provisioningEvidence(input),
  };
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'publication-http-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(95),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'publication-http-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'publication-http-client', firstParty: true, scopes });
  await host.start();
  governance = await person('publication_governance', scopes);
  owner = await person('publication_owner', scopes);
  unrelated = await person('publication_unrelated', scopes);
  moderator = await person('publication_moderator', scopes);
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
  await grant(owner.accountId, ['context:create', 'realm:create', 'space:create', 'subject:create']);
  const context = await call('POST', '/v1/contexts', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { labels: { en: 'Publication classification' } },
  });
  expect(context.response.status).toBe(201);
  classificationContext = context.value.context as typeof classificationContext;
}, 60_000);

afterAll(async () => {
  await host?.stop();
  authPool?.on('error', (error) => {
    if ('code' in error && error.code === '57P01') return;
    throw error;
  });
  if (authDatabaseName) await admin?.query(`DROP DATABASE IF EXISTS ${authDatabaseName} WITH (FORCE)`);
  await pool?.end();
  await admin?.end();
});

test.serial('a Realm moderator publishes a subject, and anonymous lists and reads it in a public Realm', async () => {
  const f = await fixture();
  await grantModerator(f.realm);
  const ids = [f.subjectId, await subject(), await subject()];
  const before = await accessSnapshot();
  const heads: Head[] = [];
  for (const subjectId of ids) {
    const key = crypto.randomUUID();
    const created = await call('POST', f.path, { bearer: moderator.bearer, key, body: { subjectId } });
    expect(created.response.status).toBe(201);
    const head = created.value.publication as Head;
    expect(head).toEqual({
      realmId: f.realm.realmId,
      subjectId,
      publicationId: expect.any(String),
      verdict: 'adopt',
      subjectRevisionId: null,
      publishedAt: expect.any(String),
    });
    expect(created.response.headers.get('etag')).toBe(JSON.stringify(head.publicationId));
    expect(created.response.headers.get('location')).toBe(`${f.path}/${subjectId}`);
    const replay = await call('POST', f.path, { bearer: moderator.bearer, key, body: { subjectId } });
    expect(replay.response.status).toBe(201);
    expect(replay.value).toEqual(created.value);
    heads.push(head);
    const read = await call('GET', `${f.path}/${subjectId}`);
    expect(read.response.status).toBe(200);
    expect(read.value).toEqual({ publication: head });
    expect(read.response.headers.get('etag')).toBe(JSON.stringify(head.publicationId));
  }
  expect(await accessSnapshot()).toEqual(before);
  const first = await call('GET', `${f.path}?limit=2`);
  expect(first.response.status).toBe(200);
  expect(first.value.items).toHaveLength(2);
  expect(first.value.next).toBeString();
  const second = await call('GET', `${f.path}?limit=2&cursor=${encodeURIComponent(first.value.next as string)}`);
  expect(second.response.status).toBe(200);
  expect(second.value.items).toHaveLength(1);
  expect(second.value.next).toBeNull();
  const items = [...(first.value.items as Head[]), ...(second.value.items as Head[])];
  expect(new Set(items.map((head) => head.subjectId))).toEqual(new Set(ids));
  expect(new Set(items.map((head) => head.publicationId))).toEqual(new Set(heads.map((head) => head.publicationId)));
  expect(items.map((head) => head.publishedAt)).toEqual(
    items
      .map((head) => head.publishedAt)
      .sort()
      .reverse(),
  );
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=invalid']) {
    const invalid = await call('GET', `${f.path}?${query}`);
    expect(invalid.response.status).toBe(400);
  }
  await call('POST', `${f.path}/${ids[1]}:withdraw`, {
    bearer: moderator.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(heads[1]!.publicationId) },
  });
  const disclosed = await call('GET', `${f.path}?limit=10`);
  expect(disclosed.response.status).toBe(200);
  expect(new Set((disclosed.value.items as Head[]).map((head) => head.subjectId))).toEqual(new Set([ids[0]!, ids[2]!]));
  const hidden = await call('GET', `${f.path}/${ids[1]}`);
  const missing = await call('GET', `${f.path}/${newId(27)}`);
  expect(hidden.response.status).toBe(404);
  expect(withoutRequest(hidden.value)).toEqual(withoutRequest(missing.value));
});

test.serial(
  'withdraw and reject remove the publication from the next list and read, and nothing is granted on the subject or the Global Context',
  async () => {
    const f = await fixture();
    await grantModerator(f.realm);
    const other = await subject();
    const accessBefore = await accessSnapshot();
    const missing = await call('GET', `${f.path}/${newId(28)}`);
    expect(missing.response.status).toBe(404);
    for (const [subjectId, verb, actor] of [
      [f.subjectId, 'withdraw', owner],
      [other, 'reject', moderator],
    ] as const) {
      const created = await call('POST', f.path, {
        bearer: actor.bearer,
        key: crypto.randomUUID(),
        body: { subjectId },
      });
      expect(created.response.status).toBe(201);
      const head = created.value.publication as Head;
      const key = crypto.randomUUID();
      const options = { bearer: actor.bearer, key, headers: { 'if-match': JSON.stringify(head.publicationId) } };
      const decision = await call('POST', `${f.path}/${subjectId}:${verb}`, options);
      expect(decision.response.status).toBe(200);
      expect(decision.value.publication).toMatchObject({
        realmId: f.realm.realmId,
        subjectId,
        verdict: verb,
        predecessor: head.publicationId,
        subjectRevisionId: null,
      });
      const moved = decision.value.publication as Head;
      expect(moved.publicationId).not.toBe(head.publicationId);
      expect(decision.response.headers.get('etag')).toBe(JSON.stringify(moved.publicationId));
      const replay = await call('POST', `${f.path}/${subjectId}:${verb}`, options);
      expect(replay.response.status).toBe(200);
      expect(replay.value).toEqual(decision.value);
      const list = await call('GET', f.path);
      expect(list.response.status).toBe(200);
      expect(list.value).toEqual({ items: [], next: null });
      const read = await call('GET', `${f.path}/${subjectId}`);
      expect(read.response.status).toBe(404);
      expect(withoutRequest(read.value)).toEqual(withoutRequest(missing.value));
      expect(await accessSnapshot()).toEqual(accessBefore);
    }
  },
);

test.serial(
  'a non-moderator and a stale head are denied with no effect, and protected publications are the same 404 to a non-member',
  async () => {
    const f = await fixture();
    let before = await snapshot();
    for (const bearer of [undefined, unrelated.bearer]) {
      const denied = await call('POST', f.path, {
        ...(bearer === undefined ? {} : { bearer }),
        key: crypto.randomUUID(),
        body: { subjectId: f.subjectId },
      });
      expect(denied.response.status).toBe(bearer === undefined ? 401 : 403);
      expect(denied.value).toMatchObject({ effect_status: 'not_applied' });
      expect(await snapshot()).toEqual(before);
    }
    const created = await call('POST', f.path, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      body: { subjectId: f.subjectId },
    });
    expect(created.response.status).toBe(201);
    const head = created.value.publication as Head;
    before = await snapshot();
    for (const verb of ['withdraw', 'reject']) {
      const denied = await call('POST', `${f.path}/${f.subjectId}:${verb}`, {
        bearer: unrelated.bearer,
        key: crypto.randomUUID(),
        headers: { 'if-match': JSON.stringify(head.publicationId) },
      });
      expect(denied.response.status).toBe(403);
      expect(denied.value).toMatchObject({ effect_status: 'not_applied' });
      expect(denied.value).not.toHaveProperty('publication');
      expect(await snapshot()).toEqual(before);
    }
    const read = await call('GET', `${f.path}/${f.subjectId}`);
    expect(read.response.status).toBe(200);
    expect(read.value).toEqual({ publication: head });
    const withdrawn = await call('POST', `${f.path}/${f.subjectId}:withdraw`, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': JSON.stringify(head.publicationId) },
    });
    expect(withdrawn.response.status).toBe(200);
    expect((withdrawn.value.publication as Head).publicationId).not.toBe(head.publicationId);
    before = await snapshot();
    for (const verb of ['withdraw', 'reject']) {
      const stale = await call('POST', `${f.path}/${f.subjectId}:${verb}`, {
        bearer: owner.bearer,
        key: crypto.randomUUID(),
        headers: { 'if-match': JSON.stringify(head.publicationId) },
      });
      expect(stale.response.status).toBe(412);
      expect(stale.value).toMatchObject({ code: 'precondition_failed', effect_status: 'not_applied' });
      expect(stale.value).not.toHaveProperty('publication');
      expect(JSON.stringify(stale.value)).not.toContain((withdrawn.value.publication as Head).publicationId);
      expect(await snapshot()).toEqual(before);
    }
    const protectedFixture = await fixture('protected');
    const adopted = await call('POST', protectedFixture.path, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      body: { subjectId: protectedFixture.subjectId },
    });
    expect(adopted.response.status).toBe(201);
    await grantModerator(protectedFixture.realm);
    for (const bearer of [owner.bearer, moderator.bearer]) {
      const member = await call('GET', `${protectedFixture.path}/${protectedFixture.subjectId}`, { bearer });
      expect(member.response.status).toBe(200);
      expect(member.value).toEqual(adopted.value);
    }
    for (const bearer of [undefined, unrelated.bearer]) {
      const options = bearer === undefined ? {} : { bearer };
      const missing = await call('GET', `/v1/realms/${newId(29)}/publications/${protectedFixture.subjectId}`, options);
      expect(missing.response.status).toBe(404);
      for (const path of [protectedFixture.path, `${protectedFixture.path}/${protectedFixture.subjectId}`]) {
        const hidden = await call('GET', path, options);
        expect(hidden.response.status).toBe(404);
        expect(withoutRequest(hidden.value)).toEqual(withoutRequest(missing.value));
      }
    }
  },
);

test.serial('a suspended account cannot publish, withdraw or reject and writes nothing', async () => {
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const suspended = await person('publication_suspended', scopes);
  const f = await fixture();
  await grantModerator(f.realm, suspended.accountId);
  const created = await call('POST', f.path, {
    bearer: suspended.bearer,
    key: crypto.randomUUID(),
    body: { subjectId: f.subjectId },
  });
  expect(created.response.status).toBe(201);
  const head = created.value.publication as Head;
  const result = await call('POST', `/v1/accounts/${suspended.accountId}:suspend`, {
    bearer: governance.bearer,
    key: crypto.randomUUID(),
    body: {},
  });
  expect(result.response.status).toBe(200);
  const before = await snapshot();
  for (const path of [f.path, `${f.path}/${f.subjectId}:withdraw`, `${f.path}/${f.subjectId}:reject`]) {
    const denied = await call('POST', path, {
      bearer: suspended.bearer,
      key: crypto.randomUUID(),
      headers: { 'if-match': JSON.stringify(head.publicationId) },
      ...(path === f.path ? { body: { subjectId: f.subjectId } } : {}),
    });
    expect(denied.response.status).toBe(401);
    expect(denied.value).toMatchObject({ effect_status: 'not_applied' });
    expect(denied.value).not.toHaveProperty('publication');
    expect(await snapshot()).toEqual(before);
  }
});
