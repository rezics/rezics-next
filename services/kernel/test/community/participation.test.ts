import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, type AuthService } from '@rezics/auth';
import type { MembershipWorkInput } from '@rezics/auth/membership-workflows';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import type { LifecycleRequest } from '../../src/access/lifecycle.ts';
import { createAccountsWorkModule, enqueueMembership } from '../../src/access/membership-work.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { recordResourceDenial, ResourceAccessWriteDeniedError } from '../../src/access/resource-denials.ts';
import { createRealmMembership } from '../../src/community/membership.ts';
import { createRealmParticipationCheck } from '../../src/community/participation.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import {
  authoritativeTimeValue,
  commandTime,
  currentCommand,
  mintReadTime,
  principalCommandIdentity,
  runCommand,
} from '../../src/command/command.ts';
import { accessCommandAuthorization, type AccessClient } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const issuer = 'https://realm-participation.auth.test';
const audience = 'https://realm-participation.api.test';
const password = 'realm participation registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(97);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(98)]]) };
const growthScales: [number, number, number] = [256, 1024, 4096];
const growthBounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

let db: GrowthDatabase;
let admin: Pool;
let pool: Pool;
let authPool: Pool;
let authDatabaseName = '';
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let workClient: Awaited<ReturnType<typeof createWorkClient>>;
let workRuntime: Awaited<ReturnType<typeof composeWork>>;
let access: ReturnType<typeof createAccess>;
let membershipAccess: ReturnType<typeof createPermissionAccess>;
let membership: ReturnType<typeof createRealmMembership>;
let roleReader: ReturnType<typeof createRealmMembership>['roleReader'] | undefined;
let scopes: string[];
let governance: Person;
const peopleById = new Map<string, Person>();
const provisioningApprovals = new Set<string>();

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
  const accountId = newId(0x3180);
  const email = `${name}-${crypto.randomUUID()}@realm.test`;
  await admin.query(
    "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','pending',$2)",
    [routeOf(accountId), accountId],
  );
  provisioningApprovals.add(accountId);
  await service.internal.provisionPassword({ authorization: accountId, email, password });
  await admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(accountId),
    accountId,
  ]);
  const person = { accountId, bearer: await issue(email, scope) };
  peopleById.set(accountId, person);
  return person;
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

async function createSpace(actor: Person, title: string) {
  const result = await call('POST', '/v1/spaces', {
    bearer: actor.bearer,
    key: crypto.randomUUID(),
    body: { title, summary: `${title} summary` },
  });
  expect(result.response.status).toBe(201);
  return result.value.space as { spaceId: string; headRevisionId: string };
}

async function createRealm(actor: Person, spaceId: string, visibility: 'public' | 'protected', title: string) {
  const result = await call('POST', '/v1/realms', {
    bearer: actor.bearer,
    key: crypto.randomUUID(),
    body: { spaceId, title, summary: `${title} summary`, visibility, contextId: GLOBAL_CONTEXT },
  });
  expect(result.response.status).toBe(201);
  return (result.value as { realm: Realm }).realm;
}

async function protectRealm(actor: Person, realm: Realm) {
  const result = await call('PATCH', `/v1/realms/${realm.realmId}`, {
    bearer: actor.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
    body: { visibility: 'protected' },
  });
  expect(result.response.status).toBe(200);
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

async function authorizeMembership(reference: string, input: MembershipWorkInput) {
  const accountId = /^authenticated-fixture\.(.+)$/.exec(reference)?.[1];
  const person = accountId ? peopleById.get(accountId) : undefined;
  if (!person || input.kind !== 'membership' || input.principal.kind !== 'realm')
    throw new Error('No membership approval for this actor');
  return lifecycleRequest(person);
}

async function joinMember(realmId: string, member: Person, authorizer: Person) {
  const handle = await enqueueMembership(workClient, `participation:${crypto.randomUUID()}`, {
    kind: 'membership',
    principal: { kind: 'realm', id: realmId },
    memberAccountId: member.accountId,
    role: 'member',
    authorization: `authenticated-fixture.${authorizer.accountId}`,
  });
  return handle.getResult();
}

async function writeRealmBan(resourceId: string, target: Person, authorizer: Person) {
  const actor = await access.authenticate(authorizer.bearer, { pool, deadline: Date.now() + 30_000 });
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
  pool.options.max = 10;
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
      return access;
    },
    writeRate: limiter,
  });
  scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  membershipAccess = createPermissionAccess({
    actions: new Map(scopes.map((action) => [action, { anonymous: false }])),
    accountEvidence: (_actor, context) => context.account,
    realmRoleReader: (client, input) => {
      if (!roleReader) return Promise.resolve(null);
      return roleReader(client, input);
    },
  });
  membership = createRealmMembership({ pool, access: membershipAccess });
  roleReader = membership.roleReader;
  service = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'realm-participation-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: {
      async readAccount(accountId) {
        const account = await readAccount(admin, routeOf(accountId)!, accountId);
        return (
          account && {
            accountId: account.accountId,
            kind: account.kind,
            state: account.state,
            authnEpoch: Number(account.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!provisioningApprovals.delete(reference)) throw new Error('Unknown fixture provisioning reference');
        return { accountId: reference };
      },
    },
  });
  await service.internal.registerClient({ clientId: 'realm-participation-client', firstParty: true, scopes });
  governance = await personWithToken('participation_governance', scopes);
  await bootstrapGovernance(pool, governance.accountId);
  workClient = await createWorkClient(url);
  workRuntime = await composeWork(
    [
      createAccountsWorkModule({
        realm: { ...membership, authorize: authorizeMembership },
        access: membershipAccess,
        authorize: authorizeMembership,
      }),
    ],
    {
      databaseUrl: url,
      pool,
      client: workClient,
      env: { KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url') },
    },
  );
  await workRuntime.launch();
}, 120_000);

afterAll(async () => {
  await workRuntime?.shutdown();
  await workClient?.close();
  await authPool?.end();
  if (authDatabaseName) await dropTestDatabase(admin!, authDatabaseName);
  await db?.close();
});

test.serial(
  'an active account may participate in a public Realm, and in a protected Realm only while it is a member',
  async () => {
    const owner = await personWithToken(`participation_owner_${crypto.randomUUID()}`, scopes);
    const member = await personWithToken(`participation_member_${crypto.randomUUID()}`, scopes);
    const unrelated = await personWithToken(`participation_unrelated_${crypto.randomUUID()}`, scopes);
    await grant(owner.accountId, ['realm:create', 'space:create']);
    const protectedSpace = await createSpace(owner, `Protected participation host ${crypto.randomUUID()}`);
    const protectedRealm = await protectRealm(
      owner,
      await createRealm(
        owner,
        protectedSpace.spaceId,
        'public',
        `Protected participation Realm ${crypto.randomUUID()}`,
      ),
    );
    const publicSpace = await createSpace(owner, `Public participation host ${crypto.randomUUID()}`);
    const publicRealm = await createRealm(
      owner,
      publicSpace.spaceId,
      'public',
      `Public participation Realm ${crypto.randomUUID()}`,
    );
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

    const joined = await joinMember(protectedRealm.realmId, member, owner);
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
  const owner = await personWithToken(`participation_ban_owner_${crypto.randomUUID()}`, scopes);
  const participant = await personWithToken(`participation_ban_account_${crypto.randomUUID()}`, scopes);
  await grant(owner.accountId, ['realm:create', 'space:create']);
  const space = await createSpace(owner, `Public ban participation host ${crypto.randomUUID()}`);
  const publicRealm = await createRealm(
    owner,
    space.spaceId,
    'public',
    `Public ban participation Realm ${crypto.randomUUID()}`,
  );
  const allowed = await call('GET', `/v1/realms/${publicRealm.realmId}/participation`, {
    bearer: participant.bearer,
  });
  expect(allowed.response.status).toBe(204);
  await writeRealmBan(publicRealm.realmId, participant, owner);
  const denied = await call('GET', `/v1/realms/${publicRealm.realmId}/participation`, {
    bearer: participant.bearer,
  });
  expect(denied.response.status).toBe(403);
  expect(denied.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applicable' });
});

const clockStatement = 'SELECT clock_timestamp()::text AS at';

function clientReplacingClockRead(at: string): AccessClient {
  const source = pool as unknown as AccessClient;
  return {
    query: ((...args: unknown[]) => {
      const first = args[0];
      const text =
        typeof first === 'string'
          ? first
          : typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
            ? first.text
            : '';
      if (text.replace(/\s+/g, ' ').trim().replace(/;$/, '') === clockStatement)
        return Promise.resolve({ rows: [{ at }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] });
      return (source.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
    }) as AccessClient['query'],
  };
}

function accessObservingTime(observed: { action: string; at: string | null; client: AccessClient }[]) {
  return {
    ...access,
    async authorize(
      client: Parameters<typeof access.authorize>[0],
      checkedActor: Parameters<typeof access.authorize>[1],
      action: Parameters<typeof access.authorize>[2],
      resource: Parameters<typeof access.authorize>[3],
      evidence: Parameters<typeof access.authorize>[4],
      time: Parameters<typeof access.authorize>[5],
    ) {
      observed.push({ action, at: time ? authoritativeTimeValue(time) : null, client });
      return access.authorize(client, checkedActor, action, resource, evidence, time);
    },
  };
}

test.serial(
  "a Realm participation check outside a command evaluates realm:participate and realm:read at one authoritative time from the kernel clock, with no interception of another module's SQL",
  async () => {
    const owner = await personWithToken(`participation_time_owner_${crypto.randomUUID()}`, scopes);
    const member = await personWithToken(`participation_time_member_${crypto.randomUUID()}`, scopes);
    await grant(owner.accountId, ['realm:create', 'space:create']);
    const space = await createSpace(owner, `Timed participation host ${crypto.randomUUID()}`);
    const realm = await protectRealm(
      owner,
      await createRealm(owner, space.spaceId, 'public', `Timed participation Realm ${crypto.randomUUID()}`),
    );
    const joined = await joinMember(realm.realmId, member, owner);
    expect(joined).toMatchObject({ status: 'completed', accountId: member.accountId });
    const actor = await access.authenticate(member.bearer, { pool, deadline: Date.now() + 30_000 });
    const fixed = new Date('2035-04-03T02:01:00.000Z');
    const client = clientReplacingClockRead('1999-01-01 00:00:00+00');
    const observed: { action: string; at: string | null; client: AccessClient }[] = [];
    const allowed = await createRealmParticipationCheck({
      pool,
      access: accessObservingTime(observed),
      clock: () => fixed,
    })(client, { realmId: realm.realmId, actor });

    expect(allowed).toBe(true);
    expect(observed.map((entry) => entry.action)).toEqual(['realm:participate', 'realm:read']);
    expect(observed.every((entry) => entry.client === client)).toBe(true);
    expect(new Set(observed.map((entry) => entry.at)).size).toBe(1);
    expect(Date.parse(observed[0]?.at ?? '')).toBe(fixed.getTime());
    expect(Date.parse(observed[0]?.at ?? '')).not.toBe(Date.parse('1999-01-01T00:00:00.000Z'));
  },
);

test.serial("inside a command both checks use the command's time", async () => {
  const owner = await personWithToken(`participation_command_owner_${crypto.randomUUID()}`, scopes);
  const member = await personWithToken(`participation_command_member_${crypto.randomUUID()}`, scopes);
  await grant(owner.accountId, ['realm:create', 'space:create']);
  const space = await createSpace(owner, `Command participation host ${crypto.randomUUID()}`);
  const realm = await protectRealm(
    owner,
    await createRealm(owner, space.spaceId, 'public', `Command participation Realm ${crypto.randomUUID()}`),
  );
  const joined = await joinMember(realm.realmId, member, owner);
  expect(joined).toMatchObject({ status: 'completed', accountId: member.accountId });
  const actor = await access.authenticate(member.bearer, { pool, deadline: Date.now() + 30_000 });
  if (actor.kind !== 'account') throw new Error('Member authentication did not yield an account');
  const fixed = new Date('2035-06-07T08:09:10.000Z');
  const observed: { action: string; at: string | null; client: AccessClient }[] = [];
  const resource = { route: routeOf(realm.realmId)!, id: realm.realmId };
  const readClient = pool as unknown as AccessClient;
  let sawCommandTime = false;
  await runCommand(
    pool,
    {
      partition: partitionOf(resource.route),
      deadline: Date.now() + 30_000,
      clock: () => fixed,
      authorization: {
        action: 'realm:participate',
        resource,
        denied: () => new Error('Realm participation command denied'),
        async prepare(attempt) {
          const allowed = await createRealmParticipationCheck({
            pool,
            access: accessObservingTime(observed),
            clock: () => {
              throw new Error('read clock consulted inside a command');
            },
          })(readClient, { realmId: realm.realmId, actor }, attempt.time);
          expect(commandTime(readClient)).toBeUndefined();
          expect(allowed).toBe(true);
          expect(observed.map((entry) => entry.action)).toEqual(['realm:participate', 'realm:read']);
          const at = authoritativeTimeValue(attempt.time);
          expect(observed.every((entry) => entry.client === readClient && entry.at === at)).toBe(true);
          expect(Date.parse(at)).toBe(fixed.getTime());
          sawCommandTime = true;
          return null;
        },
        async authorize(tx, attempt) {
          expect(commandTime(tx)).toBe(attempt.time);
          return 'execute';
        },
      },
    },
    async (tx, command) => {
      expect(commandTime(tx)).toBe(command.time);
      expect(currentCommand(tx).time).toBe(command.time);
      const readTime = await mintReadTime(tx, () => new Date('1999-01-01T00:00:00.000Z'));
      expect(commandTime(tx)).toBe(command.time);
      expect(currentCommand(tx).time).toBe(command.time);
      expect(readTime).not.toBe(command.time);
      return {
        value: null,
        events: [{ type: 'com.rezics.fixture.created.v1', subject: realm.realmId, data: {} }],
      };
    },
  );
  expect(sawCommandTime).toBe(true);
});

test.serial('a mutation refuses a read time', async () => {
  const owner = await personWithToken(`participation_read_time_owner_${crypto.randomUUID()}`, scopes);
  await grant(owner.accountId, ['realm:create', 'space:create']);
  const space = await createSpace(owner, `Read time participation host ${crypto.randomUUID()}`);
  const realm = await createRealm(
    owner,
    space.spaceId,
    'public',
    `Read time participation Realm ${crypto.randomUUID()}`,
  );
  const actor = await access.authenticate(owner.bearer, { pool, deadline: Date.now() + 30_000 });
  if (actor.kind !== 'account') throw new Error('Owner authentication did not yield an account');
  const resource = { route: routeOf(realm.realmId)!, id: realm.realmId };
  const fixed = new Date('2035-04-03T02:01:00.000Z');
  const readClient = pool as unknown as AccessClient;
  const readTime = await mintReadTime(readClient, () => fixed);
  expect(Date.parse(authoritativeTimeValue(readTime))).toBe(fixed.getTime());
  expect(commandTime(readClient)).toBeUndefined();
  expect(() => currentCommand(readClient)).toThrow('No authorized live command transaction');
  const denial = {
    resource,
    subjectId: owner.accountId,
    subjectRole: '' as const,
    action: 'realm:participate',
    reason: 'realm_ban' as const,
  };
  await expect(recordResourceDenial(readClient, { ...denial, at: readTime })).rejects.toBeInstanceOf(
    ResourceAccessWriteDeniedError,
  );

  const deadline = Date.now() + 30_000;
  const authorization = await accessCommandAuthorization(
    access,
    actor,
    'realm:manage',
    resource,
    { pool, deadline },
    () => new Error('Realm ban command denied'),
  );
  await runCommand(
    pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(resource.route),
      deadline,
      authorization,
    },
    async (tx, command) => {
      const nested = await mintReadTime(tx, () => fixed);
      expect(commandTime(tx)).toBe(command.time);
      expect(currentCommand(tx).time).toBe(command.time);
      expect(commandTime(tx)).not.toBe(nested);
      expect(currentCommand(tx).time).not.toBe(nested);
      expect(commandTime(tx)).not.toBe(readTime);
      expect(currentCommand(tx).time).not.toBe(readTime);
      await expect(recordResourceDenial(tx, { ...denial, at: nested })).rejects.toBeInstanceOf(
        ResourceAccessWriteDeniedError,
      );
      await expect(recordResourceDenial(tx, { ...denial, at: readTime })).rejects.toBeInstanceOf(
        ResourceAccessWriteDeniedError,
      );
      return {
        value: null,
        events: [{ type: 'com.rezics.fixture.created.v1', subject: realm.realmId, data: {} }],
      };
    },
  );
});

test.serial('Realm participation stays bounded as Realms, members and grants grow', async () => {
  const owner = await personWithToken(`participation_growth_owner_${crypto.randomUUID()}`, scopes);
  const member = await personWithToken(`participation_growth_member_${crypto.randomUUID()}`, scopes);
  await grant(owner.accountId, ['realm:create', 'space:create']);
  const space = await createSpace(owner, `Growth participation host ${crypto.randomUUID()}`);
  const protectedRealm = await protectRealm(
    owner,
    await createRealm(owner, space.spaceId, 'public', `Growth participation Realm ${crypto.randomUUID()}`),
  );
  const joined = await joinMember(protectedRealm.realmId, member, owner);
  expect(joined).toMatchObject({ status: 'completed', accountId: member.accountId });
  // The read does not use the work runtime. Its queue polling shares this pool and would add statements to the
  // measured window at random.
  await workRuntime.shutdown();
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
            context_id: GLOBAL_CONTEXT,
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
            context_id: GLOBAL_CONTEXT,
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
