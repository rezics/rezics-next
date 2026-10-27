import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { startConsentServer, type ConsentServer } from './membership-fixture.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { AccessUnavailableError, createAccess } from '../../src/access/index.ts';
import * as initiatorCapture from '../../src/access/durable-initiator-capture.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { enqueueRealmJoin } from '../../src/community/join.ts';
import { problemResponse } from '../../src/http/problem.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { workerTestEnv } from '../support/worker-env.ts';

const issuer = 'https://realm-join.auth.test';
const audience = 'https://realm-join.api.test';
const password = 'realm join registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(98);
const sessionKey = new Uint8Array(32).fill(99);
const tokens = { current: 1, keys: new Map([[1, sessionKey]]) };

let admin: Pool;
let pool: Pool;
let authPool: Pool;
let consent: ConsentServer;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let access: ReturnType<typeof createAccess>;
let work: WorkClient;
let worker: Bun.Subprocess | undefined;
let governance: Person;
let owner: Person;
let scopes: string[] = [];
let classificationContext: { id: string };

type Person = { accountId: string; bearer: string };
type Realm = { realmId: string; spaceId: string };
type Call = { bearer?: string; body?: unknown; key?: string };
type Footprint = { members: number; terminals: number; follows: number; workflows: number };

function workerStream(stream: ReadableStream<Uint8Array> | number | undefined): ReadableStream<Uint8Array> {
  if (typeof stream === 'number' || stream === undefined) throw new Error('Kernel worker pipes are not readable');
  return stream;
}

/** Auth and the kernel worker each launch DBOS. The worker runs in its own process. */
async function startKernelWorker(env: Record<string, string>): Promise<Bun.Subprocess> {
  const childEnv = workerTestEnv({ ...process.env, ...env });
  const child = Bun.spawn(['bun', 'src/worker.ts'], {
    cwd: resolve(import.meta.dir, '../..'),
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  let out = '';
  let err = '';
  const pump = async (stream: ReadableStream<Uint8Array>, target: 'out' | 'err') => {
    const reader = stream.getReader();
    const local = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = local.decode(value, { stream: true });
      if (target === 'out') out += text;
      else err += text;
    }
  };
  void pump(workerStream(child.stdout), 'out');
  void pump(workerStream(child.stderr), 'err');
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (out.includes('Worker ready')) return child;
    if (child.exitCode !== null) throw new Error(`Kernel worker exited ${child.exitCode}:\n${out}\n${err}`);
    await Bun.sleep(20);
  }
  child.kill();
  throw new Error(`Kernel worker did not become ready:\n${out}\n${err}`);
}

async function stopKernelWorker(child: Bun.Subprocess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const result = await Promise.race([
    child.exited.then(() => 'exited' as const),
    Bun.sleep(10_000).then(() => 'timeout' as const),
  ]);
  if (result === 'timeout') child.kill(9);
  await child.exited;
}

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'realm-join-client', scope }),
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

async function person(name: string): Promise<Person> {
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@realm-join.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@realm-join.test`, scopes) };
}

async function call(method: string, path: string, options: Call = {}) {
  const headers = new Headers();
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
    value = { body: text };
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
  return result.value.space as { spaceId: string };
}

async function createRealm(spaceId: string, visibility: 'public' | 'protected', title: string): Promise<Realm> {
  const result = await call('POST', '/v1/realms', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { spaceId, title, summary: `${title} summary`, visibility, contextId: classificationContext.id },
  });
  expect(result.response.status).toBe(201);
  const realm = result.value.realm as { realmId: string };
  return { realmId: realm.realmId, spaceId };
}

// Counts the membership workflows only: the worker's own background refreshes enqueue workflows at any moment.
async function footprint(): Promise<Footprint> {
  const result = await admin.query<Footprint>(`SELECT
    (SELECT count(*)::int FROM community.realm_member) AS members,
    (SELECT count(*)::int FROM community.realm_member_terminal) AS terminals,
    (SELECT count(*)::int FROM library.follow) AS follows,
    (SELECT count(*)::int FROM dbos.workflow_status WHERE name LIKE 'community.%' OR name LIKE 'accounts.%') AS workflows`);
  const row = result.rows[0]!;
  return { members: row.members, terminals: row.terminals, follows: row.follows, workflows: row.workflows };
}

async function settle(workflowId: string) {
  expect(await work.retrieveWorkflow(workflowId).getResult()).toBeUndefined();
}

async function followRow(accountId: string, spaceId: string) {
  const result = await admin.query<{ target_type: string; state: string; reason: string }>(
    `SELECT target_type, state, reason FROM library.follow WHERE account_id = $1 AND target_id = $2`,
    [accountId, spaceId],
  );
  return result.rows;
}

async function openMemberships(realmId: string, accountId: string) {
  const result = await admin.query<{ role: string }>(
    `SELECT role FROM community.realm_member
     WHERE realm_id = $1 AND account_id = $2 AND upper_inf(valid)`,
    [realmId, accountId],
  );
  return result.rows;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  admin = new Pool({ connectionString: url });
  pool = createPool(url);
  authDatabaseName = `realm_join_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-join',
  };
  // Auth's current consent, served over HTTPS from this process: the worker restores initiators from it.
  const consentReader = createCurrentConsentReader({ database: authPool });
  consent = await startConsentServer(async (input) => (await consentReader.readCurrentConsent(input))?.scopes ?? null);
  const workerEnv = {
    DATABASE_URL: url,
    KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.from(sessionKey).toString('base64url')}`,
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
    STRIPE_SECRET_KEY: 'sk_test_realm_join_worker',
    STRIPE_MANAGED_PAYMENTS: 'false',
    CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
    CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
    CONTENT_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    CONTENT_R2_BUCKET: 'content-media',
    CONTENT_R2_ACCESS_KEY_ID: 'private-access-id',
    CONTENT_R2_SECRET_ACCESS_KEY: 'private-secret',
    CONTENT_SOURCE_HOSTS: 'images.example.org',
    ...consent.env,
    OPENSEARCH_URL: '',
  };
  worker = await startKernelWorker(workerEnv);
  work = await createWorkClient(url);
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    workClient: work,
    access: (config) =>
      (access = createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      })),
    writeRate: createWriteRateLimiter({ secret: 'realm-join-private-write-rate-secret-32' }),
  });
  scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
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
    secret: 'realm-join-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(97),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'realm-join-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'realm-join-client', firstParty: true, scopes });
  await host.start();
  governance = await person('realm_join_governance');
  owner = await person('realm_join_owner');
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
  await grant(owner.accountId, ['context:create', 'realm:create', 'space:create']);
  const context = await call('POST', '/v1/contexts', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { labels: { en: 'Realm join classification' } },
  });
  expect(context.response.status).toBe(201);
  classificationContext = context.value.context as { id: string };
}, 60_000);

afterAll(async () => {
  await stopKernelWorker(worker);
  await consent?.close();
  await work?.close();
  await host?.stop();
  if (!host) await authPool?.end();
  if (authDatabaseName) await dropTestDatabase(admin!, authDatabaseName);
  await pool?.end();
  await admin?.end();
});

async function captureFailure(failure: Error) {
  const space = await createSpace('Capture failure host');
  const realm = await createRealm(space.spaceId, 'public', 'Capture failure Realm');
  const deadline = Date.now() + 10_000;
  const actor = await access.authenticate(owner.bearer, { pool, deadline });
  const idempotencyKey = crypto.randomUUID();
  const before = await footprint();
  const capture = spyOn(initiatorCapture, 'captureDurableInitiator').mockRejectedValueOnce(failure);
  let error: unknown;
  try {
    error = await enqueueRealmJoin(
      { pool, access, tokens, client: work },
      { actor, ...realm, memberAccountId: actor.accountId, idempotencyKey, deadline },
    ).catch((error: unknown) => error);
    expect(capture).toHaveBeenCalledTimes(1);
  } finally {
    capture.mockRestore();
  }
  expect(await footprint()).toEqual(before);
  expect(
    (await admin.query('SELECT 1 FROM community.realm_membership_operation WHERE realm_id=$1', [realm.realmId])).rows,
  ).toEqual([]);
  expect(
    (
      await admin.query("SELECT 1 FROM core.receipt WHERE command_kind='community.realm.join' AND principal_id=$1", [
        actor.accountId,
      ])
    ).rows,
  ).toEqual([]);
  return error;
}

test.serial(
  'Access unavailability during Realm join capture reaches the caller unchanged as 503 without writes',
  async () => {
    for (const reason of ['deadline', 'overloaded', 'contention'] as const) {
      const unavailable = new AccessUnavailableError(reason);
      const error = await captureFailure(unavailable);
      expect(error).toBe(unavailable);
      expect(problemResponse(error, { method: 'POST', id: crypto.randomUUID() }).status).toBe(503);
    }
  },
);

test.serial('every other Realm join capture error still denies', async () => {
  for (const error of [new Error('Capture refused'), new initiatorCapture.DurableInitiatorCaptureUnavailableError()])
    expect(await captureFailure(error)).toBeInstanceOf(GrantDeniedError);
});

test.serial(
  'an active account joins a public Realm and follows its Space, and the owner adds a member to a protected Realm',
  async () => {
    const member = await person('realm_join_member');
    const added = await person('realm_join_added');
    const publicSpace = await createSpace('Public join host');
    const publicRealm = await createRealm(publicSpace.spaceId, 'public', 'Public join Realm');
    const joined = await call('POST', `/v1/realms/${publicRealm.realmId}/membership`, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
    });
    expect(joined.response.status).toBe(202);
    expect(joined.value.workflowId).toMatch(/^community\.join:[0-9a-f]{32}$/);
    const joinWorkflowId = joined.value.workflowId as string;
    await settle(joinWorkflowId);
    const joinSteps = (await work.listWorkflowSteps(joinWorkflowId))?.map((step) => step.name) ?? [];
    expect(joinSteps.indexOf('community.join.membership')).toBeGreaterThanOrEqual(0);
    expect(joinSteps.indexOf('community.join.follow')).toBeGreaterThan(joinSteps.indexOf('community.join.membership'));
    expect(await openMemberships(publicRealm.realmId, member.accountId)).toEqual([{ role: 'member' }]);
    expect(await followRow(member.accountId, publicRealm.spaceId)).toEqual([
      { target_type: 'space', state: 'following', reason: 'membership' },
    ]);
    const own = await call('GET', `/v1/realms/${publicRealm.realmId}/members/me`, { bearer: member.bearer });
    expect(own.response.status).toBe(200);
    expect(own.value.state).toBe('member');
    expect(typeof own.value.since).toBe('string');
    expect(Number.isFinite(Date.parse(own.value.since as string))).toBe(true);

    const protectedSpace = await createSpace('Protected add host');
    const protectedRealm = await createRealm(protectedSpace.spaceId, 'protected', 'Protected add Realm');
    const addedJoin = await call('POST', `/v1/realms/${protectedRealm.realmId}/members`, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      body: { accountId: added.accountId },
    });
    expect(addedJoin.response.status).toBe(202);
    expect(addedJoin.value.workflowId).toMatch(/^community\.join:[0-9a-f]{32}$/);
    await settle(addedJoin.value.workflowId as string);
    expect(await openMemberships(protectedRealm.realmId, added.accountId)).toEqual([{ role: 'member' }]);
    expect(await followRow(added.accountId, protectedRealm.spaceId)).toEqual([
      { target_type: 'space', state: 'following', reason: 'membership' },
    ]);
    const readable = await call('GET', `/v1/realms/${protectedRealm.realmId}`, { bearer: added.bearer });
    expect(readable.response.status).toBe(200);
    const addedOwn = await call('GET', `/v1/realms/${protectedRealm.realmId}/members/me`, { bearer: added.bearer });
    expect(addedOwn.response.status).toBe(200);
    expect(addedOwn.value.state).toBe('member');
    expect(typeof addedOwn.value.since).toBe('string');
  },
  60_000,
);

test.serial(
  'leave ends membership and its access before anything else and keeps the follow, a protected Realm cannot be self-joined, and replays create nothing new',
  async () => {
    const member = await person('realm_join_replayer');
    const stranger = await person('realm_join_stranger');
    const publicSpace = await createSpace('Replay host');
    const publicRealm = await createRealm(publicSpace.spaceId, 'public', 'Replay Realm');
    const key = crypto.randomUUID();
    const joined = await call('POST', `/v1/realms/${publicRealm.realmId}/membership`, { bearer: member.bearer, key });
    expect(joined.response.status).toBe(202);
    const workflowId = joined.value.workflowId as string;
    await settle(workflowId);
    const beforeReplay = await footprint();
    const replay = await call('POST', `/v1/realms/${publicRealm.realmId}/membership`, { bearer: member.bearer, key });
    expect(replay.response.status).toBe(202);
    expect(replay.value).toEqual({ workflowId });
    expect(await footprint()).toEqual(beforeReplay);
    expect(await openMemberships(publicRealm.realmId, member.accountId)).toEqual([{ role: 'member' }]);
    expect(await followRow(member.accountId, publicRealm.spaceId)).toEqual([
      { target_type: 'space', state: 'following', reason: 'membership' },
    ]);

    const protectedSpace = await createSpace('Leave host');
    const protectedRealm = await createRealm(protectedSpace.spaceId, 'protected', 'Leave Realm');
    const added = await call('POST', `/v1/realms/${protectedRealm.realmId}/members`, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      body: { accountId: member.accountId },
    });
    expect(added.response.status).toBe(202);
    await settle(added.value.workflowId as string);
    expect((await call('GET', `/v1/realms/${protectedRealm.realmId}`, { bearer: member.bearer })).response.status).toBe(
      200,
    );
    const left = await call('DELETE', `/v1/realms/${protectedRealm.realmId}/membership`, { bearer: member.bearer });
    expect(left.response.status).toBe(202);
    expect(left.value.workflowId).toMatch(/^community\.leave:[0-9a-f]{32}$/);
    const leaveWorkflowId = left.value.workflowId as string;
    await settle(leaveWorkflowId);
    const leaveSteps =
      (await work.listWorkflowSteps(`realm:leave:${protectedRealm.realmId}:${member.accountId}`))?.map(
        (step) => step.name,
      ) ?? [];
    const publishedAt = leaveSteps.indexOf('accounts.membership.publish');
    const releasedAt = leaveSteps.indexOf('accounts.membership.release');
    expect(publishedAt).toBeGreaterThanOrEqual(0);
    expect(releasedAt).toBeGreaterThan(publishedAt);
    expect(await openMemberships(protectedRealm.realmId, member.accountId)).toEqual([]);
    expect(await followRow(member.accountId, protectedRealm.spaceId)).toEqual([
      { target_type: 'space', state: 'following', reason: 'membership' },
    ]);
    expect(await followRow(member.accountId, publicRealm.spaceId)).toEqual([
      { target_type: 'space', state: 'following', reason: 'membership' },
    ]);
    const hidden = await call('GET', `/v1/realms/${protectedRealm.realmId}`, { bearer: member.bearer });
    expect(hidden.response.status).toBe(404);
    const departed = await call('GET', `/v1/realms/${protectedRealm.realmId}/members/me`, { bearer: member.bearer });
    expect(departed.response.status).toBe(404);
    const stillPublic = await call('GET', `/v1/realms/${publicRealm.realmId}/members/me`, { bearer: member.bearer });
    expect(stillPublic.response.status).toBe(200);
    expect(stillPublic.value.state).toBe('member');

    const deniedBefore = await footprint();
    const strangerJoin = await call('POST', `/v1/realms/${protectedRealm.realmId}/membership`, {
      bearer: stranger.bearer,
      key: crypto.randomUUID(),
    });
    expect(strangerJoin.response.status).toBe(404);
    expect(strangerJoin.value).toMatchObject({ effect_status: 'not_applied' });
    const ownerJoin = await call('POST', `/v1/realms/${protectedRealm.realmId}/membership`, {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
    });
    expect(ownerJoin.response.status).toBe(403);
    expect(ownerJoin.value).toMatchObject({ effect_status: 'not_applied' });
    expect(await footprint()).toEqual(deniedBefore);
    expect(await openMemberships(protectedRealm.realmId, stranger.accountId)).toEqual([]);
    expect(await openMemberships(protectedRealm.realmId, owner.accountId)).toEqual([]);
    expect(await followRow(stranger.accountId, protectedRealm.spaceId)).toEqual([]);
    expect(await followRow(owner.accountId, protectedRealm.spaceId)).toEqual([]);
  },
  60_000,
);

test.serial(
  'anonymous, a suspended account and a non-owner adding a member are denied with no effect',
  async () => {
    const outsider = await person('realm_join_outsider');
    const suspended = await person('realm_join_suspended');
    const candidate = await person('realm_join_candidate');
    const space = await createSpace('Denial host');
    const realm = await createRealm(space.spaceId, 'public', 'Denial Realm');
    const before = await footprint();
    const anonymous = await call('POST', `/v1/realms/${realm.realmId}/membership`, { key: crypto.randomUUID() });
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.value).toMatchObject({ effect_status: 'not_applied' });
    expect(await footprint()).toEqual(before);
    const suspension = await call('POST', `/v1/accounts/${suspended.accountId}:suspend`, {
      bearer: governance.bearer,
      key: crypto.randomUUID(),
      body: {},
    });
    expect(suspension.response.status).toBe(200);
    const suspendedBefore = await footprint();
    const suspendedJoin = await call('POST', `/v1/realms/${realm.realmId}/membership`, {
      bearer: suspended.bearer,
      key: crypto.randomUUID(),
    });
    expect(suspendedJoin.response.status).toBe(401);
    expect(suspendedJoin.value).toMatchObject({ effect_status: 'not_applied' });
    expect(await footprint()).toEqual(suspendedBefore);
    const addedBefore = await footprint();
    const added = await call('POST', `/v1/realms/${realm.realmId}/members`, {
      bearer: outsider.bearer,
      key: crypto.randomUUID(),
      body: { accountId: candidate.accountId },
    });
    expect(added.response.status).toBe(403);
    expect(added.value).toMatchObject({ effect_status: 'not_applied' });
    expect(await footprint()).toEqual(addedBefore);
    expect(await openMemberships(realm.realmId, candidate.accountId)).toEqual([]);
    expect(await openMemberships(realm.realmId, suspended.accountId)).toEqual([]);
    expect(await followRow(candidate.accountId, realm.spaceId)).toEqual([]);
    expect(await followRow(suspended.accountId, realm.spaceId)).toEqual([]);
  },
  60_000,
);
