import { createHash } from 'node:crypto';
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
import { readAccount } from '../../src/access/account-data.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals, type LifecycleRequest } from '../../src/access/lifecycle.ts';
import { createAccountsWorkModule, enqueueMembership } from '../../src/access/membership-work.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { recordResourceDenial } from '../../src/access/resource-denials.ts';
import { createRealmMembership } from '../../src/community/membership.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { runCommand, principalCommandIdentity } from '../../src/command/command.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const issuer = 'https://realm-participation.auth.test';
const audience = 'https://realm-participation.api.test';
const password = 'realm participation registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(97);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(98)]]) };
const growthScales: [number, number, number] = [2048, 8192, 32768];
const growthBounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

let db: GrowthDatabase;
let admin: Pool;
let pool: Pool;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let workClient: Awaited<ReturnType<typeof createWorkClient>>;
let workRuntime: Awaited<ReturnType<typeof composeWork>>;
let access: ReturnType<typeof createAccess>;
let membership: ReturnType<typeof createRealmMembership>;
let governance: Person;
let owner: Person;
let member: Person;
let unrelated: Person;
let contextAuthor: Person;
let classificationContext: { id: string; kind: string; labels: Record<string, string> };
let protectedRealm: Realm;
let publicRealm: Realm;

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
};
type Call = { bearer?: string; body?: unknown; key?: string; headers?: Record<string, string> };

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'realm-participation-client', scope }),
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

async function personWithToken(name: string, scope: string[]): Promise<Person> {
  const email = `${name}-${crypto.randomUUID()}@realm.test`;
  const result = await host.workflows.register({
    key: `${name}-${crypto.randomUUID()}`,
    handle: `${name}_${crypto.randomUUID().slice(0, 8)}`,
    email,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(email, scope) };
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
    // Keep empty success responses and missing-route failures readable.
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

async function createRealm(spaceId: string, visibility: 'public' | 'protected', title: string) {
  const result = await call('POST', '/v1/realms', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { spaceId, title, summary: `${title} summary`, visibility, contextId: classificationContext.id },
  });
  expect(result.response.status).toBe(201);
  return (result.value as { realm: Realm }).realm;
}

function withoutRequest(value: Record<string, unknown>) {
  const { request_id: _requestId, ...rest } = value;
  return rest;
}

async function lifecycleRequest(person: Person): Promise<LifecycleRequest> {
  const actor = await access.authenticate(person.bearer, { pool, deadline: Date.now() + 30_000 });
  const account = await readAccount(pool, routeOf(person.accountId)!, person.accountId);
  if (!account) throw new Error('Missing account for membership authorization');
  return { actor, account, deadline: Date.now() + 30_000 };
}

async function joinMember(realmId: string) {
  const handle = await enqueueMembership(workClient, `participation:${crypto.randomUUID()}`, {
    kind: 'membership',
    principal: { kind: 'realm', id: realmId },
    memberAccountId: member.accountId,
    role: 'member',
    authorization: `authenticated-fixture.${owner.accountId}`,
  });
  return handle.getResult();
}

async function writeRealmBan(resourceId: string, target: Person) {
  const actor = await access.authenticate(owner.bearer, { pool, deadline: Date.now() + 30_000 });
  const resource = { route: routeOf(resourceId)!, id: resourceId };
  const deadline = Date.now() + 30_000;
  const identity = principalCommandIdentity(actor);
  const authorization = await accessCommandAuthorization(
    access,
    actor,
    'realm:manage',
    resource,
    { pool, deadline },
    () => new Error('Realm ban command denied'),
  );
  const key = crypto.randomUUID();
  await runCommand(
    pool,
    {
      ...identity,
      partition: partitionOf(resource.route),
      deadline,
      receipt: { kind: 'test.realm_ban', key, digest: createHash('sha256').update(key).digest() },
      authorization,
    },
    async (tx, command) => {
      await recordResourceDenial(tx, {
        resource,
        subjectId: target.accountId,
        subjectRole: '',
        action: 'realm:participate',
        reason: 'realm_ban',
        at: command.time,
      });
      return {
        value: { realmId: resourceId, accountId: target.accountId },
        events: [{ type: 'com.rezics.community.realm.banned.v1', subject: resourceId, data: {} }],
      };
    },
  );
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  db = await openGrowthDatabase(url);
  pool = db.pool;
  admin = db.admin;
  pool.options.max = 1;
  authDatabaseName = `realm_participation_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-participation',
  };
  const limiter = createWriteRateLimiter({
    secret: 'realm-participation-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100000, seconds: 86400 } },
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
    }),
  });
  let roleReader: ReturnType<typeof createRealmMembership>['roleReader'] | undefined;
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    access: (config) => {
      access = createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
        realmRoleReader: (client, input) => {
          if (!roleReader) return Promise.resolve(null);
          return roleReader(client, input);
        },
      });
      membership = createRealmMembership({ pool, access });
      roleReader = membership.roleReader;
      return access;
    },
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
    secret: 'realm-participation-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(99),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'realm-participation-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'realm-participation-client', firstParty: true, scopes });
  await host.start();
  governance = await personWithToken('participation_governance', scopes);
  owner = await personWithToken('participation_owner', scopes);
  member = await personWithToken('participation_member', scopes);
  unrelated = await personWithToken('participation_unrelated', scopes);
  contextAuthor = await personWithToken('participation_context_author', scopes);
  await bootstrapGovernance(pool, governance.accountId);
  await grant(owner.accountId, ['realm:create', 'space:create']);
  await grant(contextAuthor.accountId, ['context:create']);
  const contextResult = await call('POST', '/v1/contexts', {
    bearer: contextAuthor.bearer,
    key: crypto.randomUUID(),
    body: { labels: { en: 'Participation classification' } },
  });
  expect(contextResult.response.status).toBe(201);
  classificationContext = (contextResult.value as { context: typeof classificationContext }).context;

  const protectedSpace = await createSpace(`Protected participation host ${crypto.randomUUID()}`);
  protectedRealm = await createRealm(
    protectedSpace.spaceId,
    'protected',
    `Protected participation Realm ${crypto.randomUUID()}`,
  );
  const publicSpace = await createSpace(`Public participation host ${crypto.randomUUID()}`);
  publicRealm = await createRealm(publicSpace.spaceId, 'public', `Public participation Realm ${crypto.randomUUID()}`);

  const accountAccess = access;
  if (!accountAccess) throw new Error('Kernel did not install production Access');
  const realmPort = {
    ...membership,
    async authorize(reference: string) {
      const accountId = /^authenticated-fixture\.(.+)$/.exec(reference)?.[1];
      if (accountId !== owner.accountId) throw new Error('No membership approval for this actor');
      return lifecycleRequest(owner);
    },
  };
  workClient = await createWorkClient(url);
  workRuntime = await composeWork([createAccountsWorkModule({ realm: realmPort, access: accountAccess })], {
    databaseUrl: url,
    pool,
    client: workClient,
    env: { KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url') },
  });
  await workRuntime.launch();
}, 120_000);

afterAll(async () => {
  await workRuntime?.shutdown();
  await workClient?.close();
  await host?.stop();
  if (authDatabaseName) await admin?.query(`DROP DATABASE IF EXISTS ${authDatabaseName} WITH (FORCE)`);
  await authPool?.end();
  await db?.close();
});

test.serial(
  'an active account may participate in a public Realm, and in a protected Realm only while it is a member',
  async () => {
    const missing = await call('GET', `/v1/realms/${newId(29)}/participation`);
    const anonymous = await call('GET', `/v1/realms/${protectedRealm.realmId}/participation`);
    const nonMember = await call('GET', `/v1/realms/${protectedRealm.realmId}/participation`, {
      bearer: unrelated.bearer,
    });
    for (const hidden of [anonymous, nonMember]) {
      expect(hidden.response.status).toBe(404);
      expect(hidden.value).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
    }
    expect(withoutRequest(anonymous.value)).toEqual(withoutRequest(missing.value));
    expect(withoutRequest(nonMember.value)).toEqual(withoutRequest(missing.value));

    const joined = await joinMember(protectedRealm.realmId);
    expect(joined).toMatchObject({ status: 'completed', accountId: member.accountId });
    const memberCheck = await call('GET', `/v1/realms/${protectedRealm.realmId}/participation`, {
      bearer: member.bearer,
    });
    expect(memberCheck.response.status).toBe(204);
    expect(
      await admin.query(
        `SELECT count(*)::integer AS grants FROM access.resource_role_grant
       WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$2
         AND subject_role='member' AND grant_role='community.realm.member'`,
        [routeOf(protectedRealm.realmId), protectedRealm.realmId],
      ),
    ).toMatchObject({ rows: [{ grants: 1 }] });

    const publicCheck = await call('GET', `/v1/realms/${publicRealm.realmId}/participation`, {
      bearer: unrelated.bearer,
    });
    expect(publicCheck.response.status).toBe(204);
  },
);

test.serial('a Realm ban denial overrides public participation', async () => {
  await writeRealmBan(publicRealm.realmId, unrelated);
  const denied = await call('GET', `/v1/realms/${publicRealm.realmId}/participation`, {
    bearer: unrelated.bearer,
  });
  expect(denied.response.status).toBe(403);
  expect(denied.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applicable' });
});

test.serial('Realm participation stays bounded as Realms, members and grants grow', async () => {
  const route = routeOf(protectedRealm.realmId)!;
  const memberActor = await access.authenticate(member.bearer, { pool, deadline: Date.now() + 30_000 });
  expect(memberActor.kind).toBe('account');
  const population: Population = {
    name: `realm-participation-${crypto.randomUUID()}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const spaceId = newId(route);
      const spaceRevisionId = newId(route);
      const realmId = newId(route);
      const realmRevisionId = newId(route);
      const accountId = member.accountId;
      const reservationId = newId(route);
      const transactionId = newId(route);
      const at = '2020-01-01T00:00:00.000Z';
      return {
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: at,
            creator: owner.accountId,
          },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            title: `Growth host ${ordinal}`,
            summary: '',
            created_at: at,
            author: owner.accountId,
          },
        ],
        'community.realm': [
          {
            route,
            realm_id: realmId,
            space_id: spaceId,
            state: 'active',
            visibility: 'protected',
            context_id: classificationContext.id,
            head_revision_id: realmRevisionId,
            created_at: at,
            creator: owner.accountId,
          },
        ],
        'community.realm_revision': [
          {
            route,
            realm_id: realmId,
            revision_id: realmRevisionId,
            predecessor: null,
            title: `Growth Realm ${ordinal}`,
            summary: '',
            visibility: 'protected',
            context_id: classificationContext.id,
            created_at: at,
            author: owner.accountId,
          },
        ],
        'community.realm_member': [
          {
            route,
            realm_id: realmId,
            account_id: accountId,
            role: 'member',
            valid: '[2020-01-01 00:00:00+00,infinity)',
            reservation_id: reservationId,
            transaction_id: transactionId,
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: realmId,
            subject_kind: 'identity',
            subject_id: realmId,
            subject_role: 'member',
            grant_role: 'community.realm.member',
            valid: '[2020-01-01 00:00:00+00,infinity)',
            transaction_id: transactionId,
          },
        ],
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'Realm participation',
    scales: growthScales,
    bounds: growthBounds,
    async grow(database, scale, previous) {
      await seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale });
    },
    async operation() {
      const result = await call('GET', `/v1/realms/${protectedRealm.realmId}/participation`, {
        bearer: member.bearer,
      });
      expect(result.response.status).toBe(204);
      return result.response.status;
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual(growthScales);
  for (const sample of report.samples) {
    for (const [name, cost] of Object.entries(sample.cost.relations ?? {})) {
      if (name.startsWith('community.') || name === 'access.resource_role_grant') {
        expect(cost.sequentialScans).toBe(0);
      }
    }
  }
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
});
