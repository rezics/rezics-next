import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
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
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

type Person = { accountId: string; bearer: string };
type Subject = {
  id: string;
  type: string;
  revision: number;
  context: string;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  statements: Record<string, { id: string; rank: string; value: unknown }[]>;
  resolution?: Record<string, string>;
};
const issuer = 'https://realm-context.auth.test';
const audience = 'https://realm-context.api.test';
const password = 'realm context native registration password';
const routeKey = new Uint8Array(32).fill(81);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) };
let admin: Pool;
let pool: Pool;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let owner: Person;
let moderator: Person;
let member: Person;
let unrelated: Person;
let contextId: string;
let realmId: string;

async function call(method: string, path: string, actor?: Person, body?: unknown) {
  const headers = new Headers();
  if (actor) headers.set('authorization', `Bearer ${actor.bearer}`);
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set(IDEMPOTENCY_HEADER, JSON.stringify(crypto.randomUUID()));
  }
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function person(name: string, scopes: string[]): Promise<Person> {
  const email = `${name}@realm-context.test`;
  const registered = await host.workflows.register({ key: name, handle: name, email, password });
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'realm-context-client', scope: scopes }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issued = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(issued.status).toBe(200);
  return { accountId: registered.accountId, bearer: ((await issued.json()) as { access_token: string }).access_token };
}

async function grant(
  actor: Person,
  recipient: Person,
  id: string,
  authority: { actions: string[] } | { role: string },
) {
  const body = {
    resource: { route: routeOf(id)!, id },
    subject: { kind: 'account', id: recipient.accountId },
    ...authority,
    valid: '(,)',
  };
  const result = await call('POST', 'role' in authority ? '/v1/roleGrants' : '/v1/grants', actor, body);
  expect(result).toEqual({ status: 201, body: { grant: body } });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  admin = new Pool({ connectionString: url });
  pool = createPool(url, { connectionTimeoutMillis: 10_000 });
  pool.options.max = 1;
  authDatabaseName = `realm_context_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
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
    writeRate: createWriteRateLimiter({
      secret: 'realm-context-private-write-rate-secret-32bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
  });
  const actions = actionCatalogue(kernel);
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
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-context',
  };
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'realm-context-persistent-auth-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(83),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'realm-context-executor',
  });
  service = host.service;
  const scopes = [...actions.keys()].filter((scope) => scope !== 'media:complete');
  await service.internal.registerClient({ clientId: 'realm-context-client', firstParty: true, scopes });
  await host.start();
  const governance = await person('context_governance', scopes);
  owner = await person('context_owner', scopes);
  moderator = await person('context_moderator', scopes);
  member = await person('context_member', scopes);
  unrelated = await person('context_unrelated', scopes);
  // Deployment bootstrap only; all content and delegated authority use mounted routes.
  await bootstrapGovernance(pool, governance.accountId);
  const published = await call('POST', '/v1/definitions/releases', governance, { release: bundledRelease });
  expect(published.status).toBe(201);
  expect(
    (
      await call('POST', `/v1/definitions/releases/${published.body.digest}:activate`, governance, {
        expected_head: null,
      })
    ).status,
  ).toBe(200);
  await grant(governance, owner, PLATFORM_RESOURCE.id, {
    actions: ['access:grant', 'context:create', 'realm:create', 'space:create', 'subject:create'],
  });
  const context = await call('POST', '/v1/contexts', owner, { labels: { en: 'Realm editorial Context' } });
  expect(context.status).toBe(201);
  expect(context.body.context.kind).toBe('community');
  contextId = context.body.context.id;
  const space = await call('POST', '/v1/spaces', owner, { title: 'Context host', summary: '' });
  expect(space.status).toBe(201);
  const realm = await call('POST', '/v1/realms', owner, {
    spaceId: space.body.space.spaceId,
    title: 'Context Realm',
    summary: '',
    visibility: 'protected',
    contextId,
  });
  expect(realm.status).toBe(201);
  realmId = realm.body.realm.realmId;
  await grant(owner, moderator, realmId, { role: 'community.realm.moderator' });
  await grant(owner, moderator, contextId, { role: 'semantic.context.moderator' });
  await grant(owner, member, realmId, { actions: ['realm:read'] });
  const read = await call('GET', `/v1/realms/${realmId}`, moderator);
  expect(read.status).toBe(200);
  expect(read.body.realm.contextId).toBe(contextId);
}, 60_000);

afterAll(async () => {
  if (host) await host.stop();
  else await authPool?.end();
  if (authDatabaseName) await admin?.query(`DROP DATABASE IF EXISTS ${authDatabaseName} WITH (FORCE)`);
  await pool?.end();
  await admin?.end();
});

const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function subject(body: unknown): Promise<Subject> {
  const result = await call('POST', '/v1/subjects', owner, body);
  expect(result.status).toBe(201);
  return result.body.subject;
}
async function fixture() {
  const author = await subject({ type: 'schema:Person', labels: { en: 'Realm author' } });
  const book = await subject({
    type: 'schema:Book',
    labels: { en: 'Realm book' },
    descriptions: { en: 'A shared global identity' },
    aliases: { en: ['Shared book'] },
    statements: {
      'schema:author': [statement('schema:author', author.id)],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    },
  });
  // Subject creation creates and adopts these candidates in Global through Semantic.
  return { book, candidate: book.statements['schema:author']![0]!.id };
}
async function view(id: string, context = GLOBAL_CONTEXT): Promise<Subject> {
  const result = await call('GET', `/v1/subjects/${id}?context=${context}`, moderator);
  expect(result.status).toBe(200);
  expect(result.body.subject.context).toBe(context);
  return result.body.subject;
}
async function candidates(id: string, context: string, property: string) {
  const result = await call('GET', `/v1/subjects/${id}/candidates?property=${property}&context=${context}`, moderator);
  expect(result.status).toBe(200);
  return result.body.candidates as { id: string; decision: string; head: number | null; rank: string | null }[];
}
const decide = (
  id: string,
  candidate: string,
  verb: 'accept' | 'reject',
  expected: number | null,
  actor = moderator,
  context = contextId,
) => call('POST', `/v1/subjects/${id}/candidates/${candidate}:${verb}`, actor, { context, expected_head: expected });
function stable(subject: Subject) {
  const { revision: _revision, ...identityAndValues } = subject;
  return identityAndValues;
}

test('a Realm moderator accepts and rejects locally while other values fall back to Global', async () => {
  const { book, candidate } = await fixture();
  const global = await view(book.id);
  expect((await view(book.id, contextId)).statements).toEqual(global.statements);
  const rejected = await decide(book.id, candidate, 'reject', null);
  expect(rejected.status).toBe(200);
  expect(rejected.body.acceptance).toEqual({ context: contextId, candidate, decision: 'reject', head: 1 });
  const local = await view(book.id, contextId);
  expect(local.statements['schema:author'] ?? []).toEqual([]);
  expect(local.resolution).toEqual({ 'schema:author': 'unresolved' });
  expect(local.statements['schema:inLanguage']).toEqual(global.statements['schema:inLanguage']);
  expect(await candidates(book.id, contextId, 'schema:author')).toContainEqual(
    expect.objectContaining({ id: candidate, decision: 'rejected', head: 1, rank: null }),
  );
  const accepted = await decide(book.id, candidate, 'accept', 1);
  expect(accepted.status).toBe(200);
  expect(accepted.body.acceptance).toEqual({ context: contextId, candidate, decision: 'accept', head: 2 });
  const restored = await view(book.id, contextId);
  expect(restored.statements).toEqual(global.statements);
  expect(restored.resolution).toEqual({});
  expect(await candidates(book.id, contextId, 'schema:author')).toContainEqual(
    expect.objectContaining({ id: candidate, decision: 'accepted', head: 2, rank: 'normal' }),
  );
});

test('Realm Context decisions preserve global identity, values and candidate decisions', async () => {
  const { book, candidate } = await fixture();
  const global = await view(book.id);
  const globalCandidates = await candidates(book.id, GLOBAL_CONTEXT, 'schema:author');
  expect(globalCandidates).toContainEqual(
    expect.objectContaining({ id: candidate, decision: 'accepted', head: 1, rank: 'normal' }),
  );
  for (const [verb, head] of [
    ['reject', null],
    ['accept', 1],
    ['reject', 2],
  ] as const) {
    expect((await decide(book.id, candidate, verb, head)).status).toBe(200);
    const after = await view(book.id);
    expect(stable(after)).toEqual(stable(global));
    expect(after.revision).toBeGreaterThan(global.revision);
    const local = await view(book.id, contextId);
    for (const field of ['id', 'type', 'labels', 'descriptions', 'aliases'] as const)
      expect(local[field]).toEqual(global[field]);
    expect(await candidates(book.id, GLOBAL_CONTEXT, 'schema:author')).toEqual(globalCandidates);
  }
});

test('a non-moderator member and an unrelated account cannot accept or reject in the Realm Context', async () => {
  const { book, candidate } = await fixture();
  expect((await call('GET', `/v1/realms/${realmId}`, member)).status).toBe(200);
  expect((await call('GET', `/v1/realms/${realmId}`, unrelated)).status).toBe(404);
  const before = await view(book.id, contextId);
  const decisions = await candidates(book.id, contextId, 'schema:author');
  for (const actor of [member, unrelated]) {
    for (const verb of ['accept', 'reject'] as const) {
      const denied = await decide(book.id, candidate, verb, null, actor);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
      expect(await view(book.id, contextId)).toEqual(before);
      expect(await candidates(book.id, contextId, 'schema:author')).toEqual(decisions);
    }
  }
  for (const verb of ['accept', 'reject'] as const) {
    expect((await decide(book.id, candidate, verb, null, moderator, GLOBAL_CONTEXT)).status).toBe(403);
  }
});
