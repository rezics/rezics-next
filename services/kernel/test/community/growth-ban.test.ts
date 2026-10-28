import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { routeOf, newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { startConsentServer, type ConsentServer } from './membership-fixture.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { withConnection } from '../../src/database/pool.ts';
import currentBan from '../../src/community/ban-current.sql';

const issuer = 'https://realm-ban.auth.test';
const audience = 'https://realm-ban.api.test';
const password = 'realm join registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(98);
const sessionKey = new Uint8Array(32).fill(99);
const tokens = { current: 1, keys: new Map([[1, sessionKey]]) };

let db: GrowthDatabase;
let admin: Pool;
let pool: Pool;
let authPool: Pool;
let consent: ConsentServer;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let work: WorkClient;
let worker: Bun.Subprocess | undefined;
let governance: Person;
let owner: Person;
let scopes: string[] = [];
let classificationContext: { id: string };

type Person = { accountId: string; bearer: string };
type Realm = { realmId: string; spaceId: string; headRevisionId: string };
type Call = { bearer?: string | undefined; body?: unknown; key?: string; headers?: Record<string, string> };

function workerStream(stream: ReadableStream<Uint8Array> | number | undefined): ReadableStream<Uint8Array> {
  if (typeof stream === 'number' || stream === undefined) throw new Error('Kernel worker pipes are not readable');
  return stream;
}

/** Auth and the kernel worker each launch DBOS. The worker runs in its own process. */
async function startKernelWorker(env: Record<string, string | undefined>): Promise<Bun.Subprocess> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') childEnv[key] = value;
  }
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
      body: JSON.stringify({ email, password, client_id: 'realm-ban-client', scope }),
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
    email: `${name}@realm-ban.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@realm-ban.test`, scopes) };
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
  return { ...realm, spaceId } as Realm;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  db = await openGrowthDatabase(url);
  admin = db.admin;
  pool = db.pool;
  authDatabaseName = `realm_ban_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-ban',
  };
  // Auth's current consent, served over HTTPS from this process: the worker restores initiators from it.
  const consentReader = createCurrentConsentReader({ database: authPool });
  consent = await startConsentServer(async (input) => (await consentReader.readCurrentConsent(input))?.scopes ?? null);
  const workerEnv = workerTestEnv({
    DATABASE_URL: url,
    STRIPE_SECRET_KEY: 'sk_test_realm_ban_worker',
    STRIPE_MANAGED_PAYMENTS: 'false',
    CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
    CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
    ...consent.env,
    OPENSEARCH_URL: '',
  });
  worker = await startKernelWorker(workerEnv);
  work = await createWorkClient(url);
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    workClient: work,
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
    writeRate: createWriteRateLimiter({ secret: 'realm-ban-private-write-rate-secret-32' }),
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
    secret: 'realm-ban-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(97),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'realm-ban-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'realm-ban-client', firstParty: true, scopes });
  await host.start();
  governance = await person('realm_ban_governance');
  owner = await person('realm_ban_owner');
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
  await grant(owner.accountId, ['context:create', 'realm:create', 'space:create', 'subject:create']);
  const context = await call('POST', '/v1/contexts', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { labels: { en: 'Realm ban classification' } },
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
  await db?.close();
});

async function moderator(realm: Realm, name: string) {
  const actor = await person(name);
  const result = await call('POST', '/v1/roleGrants', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: {
      resource: { route: routeOf(realm.realmId)!, id: realm.realmId },
      subject: { kind: 'account', id: actor.accountId },
      role: 'community.realm.moderator',
      valid: '(,)',
    },
  });
  expect(result.response.status).toBe(201);
  return actor;
}
async function fixture(title: string) {
  const space = await createSpace(title);
  const realm = await createRealm(space.spaceId, 'public', title);
  return { realm, path: `/v1/realms/${realm.realmId}/bans` };
}
async function ban(path: string, actor: Person, account: Person, key = crypto.randomUUID()) {
  return call('PUT', `${path}/${account.accountId}`, { bearer: actor.bearer, key, body: { reason: 'Repeated abuse' } });
}
test.serial(
  'ban, unban and the ban list stay within their bound as Realms, bans and members grow',
  async () => {
    const { realm, path } = await fixture('Growth ban');
    const moderators = await Promise.all([
      moderator(realm, 'ban_growth_moderator_a'),
      moderator(realm, 'ban_growth_moderator_b'),
      moderator(realm, 'ban_growth_moderator_c'),
    ]);
    const target = await person('ban_growth_target');
    const listed = await person('ban_growth_listed');
    expect((await ban(path, moderators[0]!, listed)).response.status).toBe(200);
    const route = routeOf(realm.realmId)!;
    const hotPartition = partitionOf(route);
    const positionBase = Number(
      (await admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [hotPartition])).rows[0].position,
    );
    const population: Population = {
      name: 'realm-ban-neighbours',
      hotPartition,
      hotShare: 1,
      rows({ ordinal }) {
        const realmId = newId(route),
          accountId = newId(route),
          transactionId = newId(route);
        const spaceId = newId(route),
          revisionId = newId(route);
        const createdAt = '2020-01-01 00:00:00+00';
        const at = '2020-01-01T00:00:00.000Z';
        const position = positionBase + ordinal * 100 + 1;
        const value = { realmId, accountId, reason: 'Neighbour', actor: accountId, at, transactionId };
        return {
          // Grow the native account, ACL and command records along with each
          // neighbouring membership and ban; the probe's keys stay fixed.
          'access.account': [
            {
              route,
              account_id: accountId,
              kind: 'actor',
              state: 'active',
              transaction_id: transactionId,
              membership_inverse_complete: true,
              created_at: createdAt,
            },
          ],
          'access.membership_inverse': [
            {
              route,
              account_id: accountId,
              kind: 'realm',
              group_id: realmId,
              reservation_id: accountId,
              transaction_id: transactionId,
              source_transaction_id: transactionId,
            },
          ],
          'access.resource_grant': [
            {
              route,
              resource_id: realmId,
              subject_id: accountId,
              action: 'realm:ban',
              valid: '(,)',
              transaction_id: transactionId,
            },
          ],
          'access.resource_role_grant': [
            {
              route,
              resource_id: realmId,
              subject_id: accountId,
              grant_role: 'community.realm.owner',
              valid: '(,)',
              transaction_id: transactionId,
            },
          ],
          'core.receipt': [
            {
              partition_no: hotPartition,
              principal_kind: 'account',
              principal_id: accountId,
              command_kind: 'community.realm.ban',
              idempotency_key: accountId,
              request_digest: Buffer.alloc(32),
              epoch: 1,
              position,
              transaction_id: transactionId,
              response: value,
            },
          ],
          'core.outbox': [
            {
              partition_no: hotPartition,
              position,
              event_seq: 0,
              event_count: 1,
              epoch: 1,
              id: crypto.randomUUID(),
              type: 'com.rezics.community.realm.ban.v1',
              subject: realmId,
              data: value,
            },
          ],
          'editorial.write_basis': [
            {
              partition_no: hotPartition,
              transaction_id: transactionId,
              epoch: 1,
              position,
              principal_kind: 'account',
              principal_id: accountId,
              client_id: 'realm-ban-client',
              requested_by: null,
              recorded_at: createdAt,
            },
          ],
          'community.space': [
            {
              route,
              space_id: spaceId,
              state: 'active',
              head_revision_id: revisionId,
              created_at: createdAt,
              creator: owner.accountId,
            },
          ],
          'community.space_revision': [
            {
              route,
              space_id: spaceId,
              revision_id: revisionId,
              predecessor: null,
              title: 'Neighbour',
              summary: '',
              created_at: createdAt,
              author: owner.accountId,
            },
          ],
          'community.realm': [
            {
              route,
              realm_id: realmId,
              space_id: spaceId,
              state: 'active',
              visibility: 'public',
              context_id: classificationContext.id,
              head_revision_id: revisionId,
              created_at: createdAt,
              creator: owner.accountId,
            },
          ],
          'community.realm_revision': [
            {
              route,
              realm_id: realmId,
              revision_id: revisionId,
              predecessor: null,
              title: 'Neighbour',
              summary: '',
              visibility: 'public',
              context_id: classificationContext.id,
              created_at: createdAt,
              author: owner.accountId,
            },
          ],
          'community.realm_ban': [
            {
              route,
              realm_id: realmId,
              account_id: accountId,
              valid: '[2020-01-01,)',
              reason: 'Neighbour',
              actor: accountId,
              transaction_id: transactionId,
            },
          ],
          'community.realm_member': [
            {
              route,
              realm_id: realmId,
              account_id: accountId,
              role: 'member',
              valid: '[2020-01-01,)',
              reservation_id: accountId,
              transaction_id: transactionId,
            },
          ],
          'access.resource_denial': ['realm:join', 'realm:participate'].map((action) => ({
            route,
            resource_id: realmId,
            subject_id: accountId,
            subject_role: '',
            action,
            reason: 'realm_ban',
            valid: '[2020-01-01,)',
            transaction_id: transactionId,
          })),
        };
      },
      async finish(admin) {
        await admin.query(
          'UPDATE core.partition SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1) WHERE partition_no=$1',
          [hotPartition],
        );
      },
    };
    const report = await checkGrowth(db, {
      name: 'Realm ban, unban and list',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_db, scale, previous) => {
        await seed(db, population, { from: previous, to: scale });
      },
      operation: async (_db, _scale, repetition) => {
        const mod = moderators[repetition % moderators.length]!;
        expect((await ban(path, mod, target)).response.status).toBe(200);
        expect(
          (await call('DELETE', `${path}/${target.accountId}`, { bearer: mod.bearer, key: crypto.randomUUID() }))
            .response.status,
        ).toBe(204);
        const page = await call('GET', `${path}?limit=1`, { bearer: mod.bearer });
        expect(page.response.status).toBe(200);
        expect(page.value).toMatchObject({ items: [{ accountId: listed.accountId }], next: null });
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
    for (const sample of report.samples) {
      expect(Object.keys(sample.cost.relations ?? {}).length).toBeGreaterThan(0);
      for (const cost of Object.values(sample.cost.relations ?? {})) expect(cost.sequentialScans).toBe(0);
    }
    const second = await person('ban_growth_second');
    expect((await ban(path, moderators[0]!, second)).response.status).toBe(200);
    const first = await call('GET', `${path}?limit=1`, { bearer: moderators[0]!.bearer });
    expect(first.response.status).toBe(200);
    expect(typeof first.value.next).toBe('string');
    const next = await call('GET', `${path}?limit=1&cursor=${encodeURIComponent(first.value.next as string)}`, {
      bearer: moderators[0]!.bearer,
    });
    expect(next.response.status).toBe(200);
    expect(next.value.next).toBeNull();
    expect(
      new Set(
        [...(first.value.items as { accountId: string }[]), ...(next.value.items as { accountId: string }[])].map(
          (row) => row.accountId,
        ),
      ),
    ).toEqual(new Set([listed.accountId, second.accountId]));
  },
  600_000,
);

test.serial(
  'protected read and admission ban probes stay bounded as bans in one Realm grow',
  async () => {
    const route = 0x7160;
    const realmId = newId(route);
    const accountId = newId(route);
    const absentId = newId(route);
    const at = '2026-01-01T00:00:00.000Z';
    await admin.query(
      `INSERT INTO community.realm_ban (route,realm_id,account_id,valid,reason,actor,transaction_id)
     VALUES ($1,$2,$3,'[2020-01-01,)','Probe',$3,$4)`,
      [route, realmId, accountId, newId(route)],
    );
    const report = await checkGrowth(db, {
      name: 'Protected Realm read and admission ban point read',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_db, scale, previous) {
        await seed(
          db,
          {
            name: 'same-realm-bans',
            hotPartition: partitionOf(route),
            hotShare: 1,
            rows: () => ({
              'community.realm_ban': [
                {
                  route,
                  realm_id: realmId,
                  account_id: newId(route),
                  valid: '[2020-01-01,)',
                  reason: 'Neighbour',
                  actor: accountId,
                  transaction_id: newId(route),
                },
              ],
            }),
          },
          { from: previous, to: scale },
        );
      },
      async operation() {
        await withConnection(db.pool, async (client) => {
          expect(await currentBan.run(client, { route, realm_id: realmId, account_id: accountId, at })).toEqual({
            banned: true,
          });
          expect(await currentBan.run(client, { route, realm_id: realmId, account_id: absentId, at })).toBeNull();
        });
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(2);
      expect(cost.rows).toBe(1);
      for (const relation of Object.values(cost.relations ?? {})) expect(relation.sequentialScans).toBe(0);
    }
  },
  600_000,
);
