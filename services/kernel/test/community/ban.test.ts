import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { fromPlainText } from '@rezics/document';
import { routeOf, newId } from '../../src/route/route.ts';
import { createRealmMembership } from '../../src/community/membership.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
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
let access: ReturnType<typeof createAccess>;
let work: WorkClient;
let worker: Bun.Subprocess | undefined;
let governance: Person;
let owner: Person;
let scopes: string[] = [];
let classificationContext: { id: string };

type Person = { accountId: string; bearer: string };
type Realm = { realmId: string; spaceId: string; headRevisionId: string };
type Call = { bearer?: string | undefined; body?: unknown; key?: string; headers?: Record<string, string> };
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

async function footprint(): Promise<Footprint> {
  const result = await admin.query<Footprint>(`SELECT
    (SELECT count(*)::int FROM community.realm_member) AS members,
    (SELECT count(*)::int FROM community.realm_member_terminal) AS terminals,
    (SELECT count(*)::int FROM library.follow) AS follows,
    (SELECT count(*)::int FROM dbos.workflow_status) AS workflows`);
  const row = result.rows[0]!;
  return { members: row.members, terminals: row.terminals, follows: row.follows, workflows: row.workflows };
}

async function settle(workflowId: string) {
  const result = await work.retrieveWorkflow<{ status: string } | undefined>(workflowId).getResult();
  if (workflowId.startsWith('realm:ban:')) expect(result?.status).toBe('completed');
  else expect(result).toBeUndefined();
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
  const workerEnv = {
    DATABASE_URL: url,
    KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.from(sessionKey).toString('base64url')}`,
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
    STRIPE_SECRET_KEY: 'sk_test_realm_ban_worker',
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
async function denials(realm: Realm, target: Person) {
  return (
    await admin.query(
      `SELECT action, reason, lower(valid)::text AS at FROM access.resource_denial
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND upper_inf(valid) ORDER BY action`,
      [routeOf(realm.realmId), realm.realmId, target.accountId],
    )
  ).rows;
}

test.serial(
  'a Realm moderator bans an account: from T it cannot join or participate, an existing membership ends through the leave workflow, and public reads stay open',
  async () => {
    const { realm, path } = await fixture('Member ban');
    const mod = await moderator(realm, 'ban_member_moderator');
    const member = await person('ban_existing_member');
    const joined = await call('POST', `/v1/realms/${realm.realmId}/membership`, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
    });
    expect(joined.response.status).toBe(202);
    await settle(joined.value.workflowId as string);
    expect(await openMemberships(realm.realmId, member.accountId)).toEqual([{ role: 'member' }]);
    expect(
      (await call('GET', `/v1/realms/${realm.realmId}/participation`, { bearer: member.bearer })).response.status,
    ).toBe(204);
    // Public content remains readable after the Realm participation denial.
    const scheme = await call('POST', '/v1/subjects', {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      body: { type: 'skos:ConceptScheme', labels: { en: 'Ban scheme' } },
    });
    expect(scheme.response.status).toBe(201);
    const schemeId = (scheme.value.subject as { id: string }).id;
    const concept = await call('POST', '/v1/subjects', {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      body: {
        type: 'skos:Concept',
        labels: { en: 'Ban concept' },
        statements: {
          'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
        },
      },
    });
    expect(concept.response.status).toBe(201);
    expect(
      (
        await call('PUT', `/v1/realms/${realm.realmId}/boardScheme`, {
          bearer: owner.bearer,
          key: crypto.randomUUID(),
          headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
          body: { schemeId },
        })
      ).response.status,
    ).toBe(200);
    const board = await call('POST', `/v1/realms/${realm.realmId}/boards`, {
      bearer: mod.bearer,
      key: crypto.randomUUID(),
      body: { conceptId: (concept.value.subject as { id: string }).id, title: 'Ban board', visibility: 'published' },
    });
    expect(board.response.status).toBe(201);
    const threadBody = {
      boardId: (board.value.board as { id: string }).id,
      title: 'Member thread',
      body: fromPlainText('A member contribution'),
      licence: 'MIT',
      subjectIds: [],
      visibility: 'published',
    };
    const thread = await call('POST', '/v1/threads', {
      bearer: member.bearer,
      key: crypto.randomUUID(),
      body: threadBody,
    });
    expect(thread.response.status).toBe(201);
    const key = crypto.randomUUID();
    const banned = await ban(path, mod, member, key);
    expect(banned.response.status).toBe(200);
    const result = structuredClone(banned.value.ban) as {
      realmId: string;
      accountId: string;
      reason: string;
      at: string;
      workflowId: string;
    };
    // Bun replaces matched properties with asymmetric matchers. Keep the receipt
    // untouched and retain the workflow key before matching its display copy.
    const workflowId = result.workflowId;
    expect(result).toMatchObject({
      realmId: realm.realmId,
      accountId: member.accountId,
      reason: 'Repeated abuse',
      workflowId: expect.stringMatching(/^realm:ban:/),
    });
    expect(await denials(realm, member)).toEqual([
      { action: 'realm:join', reason: 'realm_ban', at: result.at },
      { action: 'realm:participate', reason: 'realm_ban', at: result.at },
    ]);
    expect(
      (
        await admin.query(
          'SELECT lower(valid)::text AS at FROM community.realm_ban WHERE realm_id=$1 AND account_id=$2',
          [realm.realmId, member.accountId],
        )
      ).rows,
    ).toEqual([{ at: result.at }]);
    expect(
      (
        await call('POST', `/v1/realms/${realm.realmId}/membership`, {
          bearer: member.bearer,
          key: crypto.randomUUID(),
        })
      ).response.status,
    ).toBe(403);
    expect(
      (await call('GET', `/v1/realms/${realm.realmId}/participation`, { bearer: member.bearer })).response.status,
    ).toBe(403);
    expect(
      (await call('GET', `/v1/realms/${realm.realmId}/participation`, { bearer: member.bearer })).response.status,
    ).toBe(403);
    await settle(workflowId);
    const steps = (await work.listWorkflowSteps(workflowId))?.map((step) => step.name) ?? [];
    expect(steps.indexOf('accounts.membership.publish')).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf('accounts.membership.release')).toBeGreaterThan(steps.indexOf('accounts.membership.publish'));
    expect(await openMemberships(realm.realmId, member.accountId)).toEqual([]);
    expect(
      (await call('GET', `/v1/realms/${realm.realmId}/participation`, { bearer: member.bearer })).response.status,
    ).toBe(403);
    expect(await followRow(member.accountId, realm.spaceId)).toEqual([
      { target_type: 'space', state: 'following', reason: 'membership' },
    ]);
    const beforeReplay = await footprint();
    expect((await ban(path, mod, member, key)).value).toEqual(banned.value);
    expect(await footprint()).toEqual(beforeReplay);
    for (const bearer of [undefined, member.bearer]) {
      expect((await call('GET', `/v1/realms/${realm.realmId}`, { bearer })).response.status).toBe(200);
      expect(
        (await call('GET', `/v1/threads/${(thread.value.thread as { id: string }).id}`, { bearer })).response.status,
      ).toBe(200);
    }
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM access.resource_denial WHERE subject_id=$1 AND resource_id<>$2 AND reason='realm_ban'",
          [member.accountId, realm.realmId],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  },
  120_000,
);

test.serial(
  'unban ends both denials without restoring membership, and a non-moderator, the banned account and anonymous cannot ban or unban',
  async () => {
    const { realm, path } = await fixture('Unban');
    const mod = await moderator(realm, 'ban_unban_moderator');
    const member = await person('ban_unban_member');
    const outsider = await person('ban_unban_outsider');
    const joined = await call('POST', `/v1/realms/${realm.realmId}/membership`, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
    });
    expect(joined.response.status).toBe(202);
    await settle(joined.value.workflowId as string);
    const banned = await ban(path, mod, member);
    expect(banned.response.status).toBe(200);
    await settle((banned.value.ban as { workflowId: string }).workflowId);
    const before = await footprint();
    for (const bearer of [undefined, member.bearer, outsider.bearer]) {
      for (const method of ['PUT', 'DELETE']) {
        const denied = await call(method, `${path}/${member.accountId}`, {
          bearer,
          key: crypto.randomUUID(),
          ...(method === 'PUT' ? { body: { reason: 'Unauthorized' } } : {}),
        });
        expect(denied.response.status).toBe(bearer ? 403 : 401);
      }
      expect((await call('GET', path, { bearer })).response.status).toBe(bearer ? 403 : 401);
    }
    expect(await footprint()).toEqual(before);
    expect((await call('GET', path, { bearer: mod.bearer })).value).toMatchObject({
      items: [{ accountId: member.accountId, reason: 'Repeated abuse' }],
      next: null,
    });
    expect(
      (await call('DELETE', `${path}/${member.accountId}`, { bearer: mod.bearer, key: crypto.randomUUID() })).response
        .status,
    ).toBe(204);
    expect(await denials(realm, member)).toEqual([]);
    expect(await openMemberships(realm.realmId, member.accountId)).toEqual([]);
    expect((await call('GET', path, { bearer: mod.bearer })).value).toEqual({ items: [], next: null });
    expect(
      (await call('GET', `/v1/realms/${realm.realmId}/participation`, { bearer: member.bearer })).response.status,
    ).toBe(204);
    const rejoined = await call('POST', `/v1/realms/${realm.realmId}/membership`, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
    });
    expect(rejoined.response.status).toBe(202);
  },
  120_000,
);

test.serial(
  'a ban of a non-member writes the denials and starts no workflow; a moderator without realm:ban cannot remove a member',
  async () => {
    const { realm, path } = await fixture('Nonmember ban');
    const mod = await moderator(realm, 'ban_nonmember_moderator');
    const target = await person('ban_nonmember_target');
    const before = await footprint();
    const banned = await ban(path, mod, target);
    expect(banned.response.status).toBe(200);
    expect(banned.value.ban).toMatchObject({ workflowId: null });
    expect((await denials(realm, target)).map((row) => row.action)).toEqual(['realm:join', 'realm:participate']);
    expect((await footprint()).workflows).toBe(before.workflows);
    const restricted = {
      ...mod,
      bearer: await issue(
        'ban_nonmember_moderator@realm-ban.test',
        scopes.filter((scope) => scope !== 'realm:ban'),
      ),
    };
    const member = await person('ban_restricted_member');
    const joined = await call('POST', `/v1/realms/${realm.realmId}/membership`, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
    });
    expect(joined.response.status).toBe(202);
    await settle(joined.value.workflowId as string);
    expect((await ban(path, restricted, member)).response.status).toBe(403);
    const membership = createRealmMembership({ pool, access, referenceKeys: tokens });
    await expect(
      membership.authorize(restricted.bearer, {
        kind: 'membership',
        principal: { kind: 'realm', id: realm.realmId },
        memberAccountId: member.accountId,
        role: null,
        authorization: restricted.bearer,
      }),
    ).rejects.toThrow();
    expect(await openMemberships(realm.realmId, member.accountId)).toEqual([{ role: 'member' }]);
    expect(
      (
        await call('PUT', `${path}/${newId(0x1230)}`, {
          bearer: mod.bearer,
          key: crypto.randomUUID(),
          body: { reason: 'x'.repeat(1025) },
        })
      ).response.status,
    ).toBe(400);
  },
  120_000,
);
